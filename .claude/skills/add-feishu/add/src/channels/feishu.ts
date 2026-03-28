import * as Lark from '@larksuiteoapi/node-sdk';

import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { processImage } from '../image.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Parse Feishu message content JSON to plain text.
 * Feishu delivers message bodies as JSON strings whose structure varies by msg_type.
 */
export function parseFeishuMessageContent(rawContent: string, msgType: string): string {
  try {
    const parsed = JSON.parse(rawContent);
    if (msgType === 'text') {
      return parsed.text || '';
    }
    if (msgType === 'post') {
      // Rich text — extract text from all paragraph elements
      const lang =
        parsed.zh_cn ||
        parsed.en_us ||
        (Object.values(parsed)[0] as Record<string, unknown>);
      if (lang && typeof lang === 'object' && 'content' in lang) {
        const paragraphs = lang.content as Array<
          Array<{ tag: string; text?: string; href?: string }>
        >;
        return paragraphs
          .flatMap((para) =>
            para
              .filter((el) => el.tag === 'text' || el.tag === 'a')
              .map((el) => el.text || el.href || ''),
          )
          .join(' ')
          .trim();
      }
    }
    if (msgType === 'image') return '[Image]';
    if (msgType === 'audio') return '[Audio]';
    if (msgType === 'video') return '[Video]';
    if (msgType === 'file') {
      return `[File: ${parsed.file_name || 'unknown'}]`;
    }
    if (msgType === 'sticker') return '[Sticker]';
    return `[${msgType}]`;
  } catch {
    return rawContent || `[${msgType}]`;
  }
}

/**
 * Strip the bot's @mention tag from content.
 * Feishu uses <at user_id="open_id">Name</at> syntax.
 */
export function stripBotMentionTag(content: string, botOpenId: string): string {
  const escaped = botOpenId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content
    .replace(new RegExp(`<at user_id="${escaped}">[^<]*<\\/at>`, 'g'), '')
    .trim();
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: Lark.Client | null = null;
  private wsClient: Lark.WSClient | null = null;
  private connected = false;
  private botOpenId: string | undefined;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;
  private domain: Lark.Domain | string;

  constructor(
    appId: string,
    appSecret: string,
    domain: Lark.Domain | string,
    opts: FeishuChannelOpts,
  ) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.domain = domain;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain,
    });

    // Fetch bot identity so we can ignore echoed bot messages and handle @mentions
    try {
      const botRes = await (this.client as any).request({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
        params: {},
        data: {},
      });
      this.botOpenId = botRes.bot?.open_id;
      const botName: string = botRes.bot?.app_name || 'Unknown';
      logger.info(
        { botOpenId: this.botOpenId, botName },
        'Feishu bot identity fetched',
      );
      console.log(
        `\n  Feishu bot: ${botName} (open_id: ${this.botOpenId || 'unknown'})`,
      );
      console.log(
        `  Add the bot to a chat, then send /feishuid to get the chat's registration ID\n`,
      );
    } catch (err) {
      logger.warn({ err }, 'Feishu: could not fetch bot identity');
    }

    // Build event dispatcher and register incoming message handler
    const eventDispatcher = new Lark.EventDispatcher({
      encryptKey: '',
    }).register({
      'im.message.receive_v1': async (event: any) => {
        try {
          await this.handleMessage(event);
        } catch (err) {
          logger.error({ err }, 'Feishu: error handling message event');
        }
      },
    });

    // Start WebSocket Long Connection Mode (no public endpoint needed)
    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain,
      loggerLevel: Lark.LoggerLevel.warn,
    });

    this.wsClient.start({ eventDispatcher });
    this.connected = true;
    logger.info('Feishu WebSocket connection started');
  }

  private async handleMessage(event: any): Promise<void> {
    const message = event.message;
    if (!message) return;

    // Ignore messages sent by the bot itself
    const senderOpenId: string | undefined = event.sender?.sender_id?.open_id;
    if (this.botOpenId && senderOpenId === this.botOpenId) return;
    if (event.sender?.sender_type === 'app') return;

    const chatId: string = message.chat_id;
    const msgType: string = message.message_type || 'text';
    const messageId: string = message.message_id;
    const createTime: string | undefined = message.create_time;
    const chatType: string = message.chat_type || 'p2p'; // 'p2p' | 'group'

    const timestamp = createTime
      ? new Date(Number(createTime)).toISOString()
      : new Date().toISOString();

    const chatJid = `feishu:${chatId}`;
    const isGroup = chatType === 'group';

    // Parse structured message content to plain text
    let content = parseFeishuMessageContent(message.content || '{}', msgType);

    // Handle @bot mentions: strip the mention tag and prepend trigger word
    const mentions: Array<{ id?: { open_id?: string } }> = message.mentions || [];
    const botMentioned =
      this.botOpenId !== undefined &&
      mentions.some((m) => m.id?.open_id === this.botOpenId);

    if (botMentioned && this.botOpenId) {
      content = stripBotMentionTag(content, this.botOpenId);
      // Translate @mention into the standard trigger format so the router picks it up
      if (!TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Notify orchestrator of chat existence (enables group discovery)
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);

    // Only deliver full messages for registered chats
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid, chatType }, 'Feishu: message from unregistered chat');
      return;
    }

    // Image attachment handling — download and resize via sharp
    if (msgType === 'image' && this.client) {
      try {
        const parsed = JSON.parse(message.content || '{}');
        const imageKey: string | undefined = parsed.image_key;
        if (imageKey) {
          const res = await (this.client.im as any).messageResource.get({
            params: { type: 'image' },
            path: { message_id: messageId, file_key: imageKey },
          });
          const stream = res.getReadableStream();
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const buffer = Buffer.concat(chunks);
          const groupDir = path.join(GROUPS_DIR, group.folder);
          const result = await processImage(buffer, groupDir, content !== '[Image]' ? content : '');
          if (result) {
            content = result.content;
          }
        }
      } catch (err) {
        logger.warn({ err, chatJid, messageId }, 'Feishu: image download/processing failed');
        // Fall through with original [Image] content
      }
    }

    if (!content) return;

    const sender: string =
      event.sender?.sender_id?.user_id || senderOpenId || '';

    this.opts.onMessage(chatJid, {
      id: messageId,
      chat_jid: chatJid,
      sender,
      sender_name: sender,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });

    logger.info({ chatJid, msgType, sender }, 'Feishu message delivered');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Feishu: client not initialized');
      return;
    }

    try {
      const chatId = jid.replace(/^feishu:/, '');

      // Chunk at 4000 chars for readability (Feishu supports ~30k but chunking is cleaner)
      const MAX_LENGTH = 4000;
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        chunks.push(text.slice(i, i + MAX_LENGTH));
      }

      for (const chunk of chunks) {
        await (this.client.im as any).message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: chunk }),
          },
        });
      }

      logger.info({ jid, length: text.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Feishu: failed to send message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  /** Expose the Lark client for Feishu API tools (used by IPC handler). */
  getClient(): Lark.Client | null {
    return this.client;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.wsClient = null;
    this.client = null;
    logger.info('Feishu channel disconnected');
  }
}

registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_DOMAIN',
  ]);
  const appId = process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID || '';
  const appSecret =
    process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET || '';
  const domainStr =
    process.env.FEISHU_DOMAIN || envVars.FEISHU_DOMAIN || 'feishu';

  if (!appId || !appSecret) {
    logger.debug(
      'Feishu: FEISHU_APP_ID / FEISHU_APP_SECRET not set — channel disabled',
    );
    return null;
  }

  // Resolve domain string to Lark SDK constant or custom URL
  let domain: Lark.Domain | string;
  if (domainStr === 'lark') {
    domain = Lark.Domain.Lark;
  } else if (domainStr === 'feishu' || !domainStr) {
    domain = Lark.Domain.Feishu;
  } else {
    domain = domainStr; // Custom domain for private/on-prem deployment
  }

  return new FeishuChannel(appId, appSecret, domain, opts);
});
