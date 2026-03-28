import * as Lark from '@larksuiteoapi/node-sdk';

import fs from 'fs';
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
export function parseFeishuMessageContent(
  rawContent: string,
  msgType: string,
): string {
  try {
    const parsed = JSON.parse(rawContent);
    if (msgType === 'text') {
      return parsed.text || '';
    }
    if (msgType === 'post') {
      logger.debug(
        {
          rawContent: rawContent.slice(0, 500),
          parsedKeys: Object.keys(parsed),
        },
        'Feishu: post raw content',
      );
      // Rich text — extract text from all paragraph elements.
      // Feishu wraps post content in a locale key (zh_cn, en_us, ja_jp, etc.)
      // or sometimes delivers it flat with a top-level "content" array.
      let title = '';
      let paragraphs:
        | Array<Array<{ tag: string; text?: string; href?: string }>>
        | undefined;

      // Try locale-keyed structure: { "zh_cn": { "title": "...", "content": [[...]] } }
      const langObj = parsed.zh_cn || parsed.en_us || parsed.ja_jp;
      if (langObj && typeof langObj === 'object' && 'content' in langObj) {
        title = langObj.title || '';
        paragraphs = langObj.content;
      } else if (Array.isArray(parsed.content)) {
        // Flat structure: { "title": "...", "content": [[...]] }
        title = parsed.title || '';
        paragraphs = parsed.content;
      } else {
        // Last resort: try first object value that has a content array
        for (const val of Object.values(parsed)) {
          if (
            val &&
            typeof val === 'object' &&
            'content' in (val as any) &&
            Array.isArray((val as any).content)
          ) {
            title = (val as any).title || '';
            paragraphs = (val as any).content;
            break;
          }
        }
      }

      if (paragraphs && Array.isArray(paragraphs)) {
        const textParts = paragraphs
          .flatMap((para) => {
            if (!Array.isArray(para)) return [];
            return para
              .map((el) => {
                if (el.tag === 'text') return el.text || '';
                if (el.tag === 'a') return el.text || el.href || '';
                if (el.tag === 'at')
                  return `@${(el as any).user_name || (el as any).user_id || ''}`;
                if (el.tag === 'img')
                  return `[Image: ${(el as any).image_key || 'unknown'}]`;
                if (el.tag === 'file') {
                  const fk = (el as any).file_key || '';
                  const fn = (el as any).file_name || 'unknown';
                  return `[File: ${fk}:${fn}]`;
                }
                return '';
              })
              .filter(Boolean);
          })
          .join(' ')
          .trim();
        const result = title ? `${title}\n${textParts}` : textParts;
        if (result) return result;
      }

      // If we still couldn't extract anything, log the structure for debugging
      logger.debug(
        { rawContent, msgType },
        'Feishu: could not parse post content',
      );
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

    logger.debug(
      {
        msgType: message.message_type,
        chatId: message.chat_id,
        messageId: message.message_id,
      },
      'Feishu: incoming event',
    );

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
    const mentions: Array<{ id?: { open_id?: string } }> =
      message.mentions || [];
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
      logger.debug(
        { chatJid, chatType },
        'Feishu: message from unregistered chat',
      );
      return;
    }

    // Image attachment handling — download and resize via sharp.
    // Handles both standalone image messages and images embedded in post messages.
    if (this.client) {
      const groupDir = path.join(GROUPS_DIR, group.folder);

      if (msgType === 'image') {
        // Standalone image message — single image_key in content
        try {
          const parsed = JSON.parse(message.content || '{}');
          const imageKey: string | undefined = parsed.image_key;
          if (imageKey) {
            const result = await this.downloadAndProcessImage(
              messageId,
              imageKey,
              groupDir,
              content !== '[Image]' ? content : '',
            );
            if (result) content = result.content;
          }
        } catch (err) {
          logger.warn(
            { err, chatJid, messageId },
            'Feishu: image download/processing failed',
          );
        }
      } else if (msgType === 'file') {
        // File message — check if it's a PDF and download it
        try {
          const parsed = JSON.parse(message.content || '{}');
          const fileKey: string | undefined = parsed.file_key;
          const fileName: string = parsed.file_name || `doc-${Date.now()}.pdf`;
          if (fileKey && fileName.toLowerCase().endsWith('.pdf')) {
            const result = await this.downloadAndSavePdf(
              messageId,
              fileKey,
              groupDir,
              fileName,
            );
            if (result) content = result;
          }
        } catch (err) {
          logger.warn(
            { err, chatJid, messageId },
            'Feishu: PDF download failed',
          );
        }
      } else if (msgType === 'post') {
        const replacements: Array<{ placeholder: string; result: string }> = [];

        // Post messages may contain inline images — replace [Image: key] placeholders
        const imageKeyPattern = /\[Image: (img_[^\]]+)\]/g;
        let imgMatch: RegExpExecArray | null;
        while ((imgMatch = imageKeyPattern.exec(content)) !== null) {
          try {
            const result = await this.downloadAndProcessImage(
              messageId,
              imgMatch[1],
              groupDir,
              '',
            );
            if (result) {
              replacements.push({
                placeholder: imgMatch[0],
                result: result.content,
              });
            }
          } catch (err) {
            logger.warn(
              { err, chatJid, imageKey: imgMatch[1] },
              'Feishu: post image download failed',
            );
          }
        }

        // Post messages may contain inline files — download PDFs
        const filePattern = /\[File: ([^:]+):([^\]]+)\]/g;
        let fileMatch: RegExpExecArray | null;
        while ((fileMatch = filePattern.exec(content)) !== null) {
          const [placeholder, fileKey, fileName] = fileMatch;
          if (!fileName.toLowerCase().endsWith('.pdf')) continue;
          try {
            const result = await this.downloadAndSavePdf(
              messageId,
              fileKey,
              groupDir,
              fileName,
            );
            if (result) {
              replacements.push({ placeholder, result });
            }
          } catch (err) {
            logger.warn(
              { err, chatJid, fileKey },
              'Feishu: post PDF download failed',
            );
          }
        }

        for (const r of replacements) {
          content = content.replace(r.placeholder, r.result);
        }
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

  /** Download a Feishu image by key, resize with sharp, save to group dir. */
  private async downloadAndProcessImage(
    messageId: string,
    imageKey: string,
    groupDir: string,
    caption: string,
  ): Promise<{ content: string; relativePath: string } | null> {
    const res = await (this.client!.im as any).messageResource.get({
      params: { type: 'image' },
      path: { message_id: messageId, file_key: imageKey },
    });
    const stream = res.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return processImage(Buffer.concat(chunks), groupDir, caption);
  }

  /** Download a Feishu file by key, save PDF to group attachments dir. */
  private async downloadAndSavePdf(
    messageId: string,
    fileKey: string,
    groupDir: string,
    fileName: string,
  ): Promise<string | null> {
    const res = await (this.client!.im as any).messageResource.get({
      params: { type: 'file' },
      path: { message_id: messageId, file_key: fileKey },
    });
    const stream = res.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    if (!buffer || buffer.length === 0) return null;

    const attachDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });
    const safeFileName = path.basename(fileName);
    const filePath = path.join(attachDir, safeFileName);
    fs.writeFileSync(filePath, buffer);
    const sizeKB = Math.round(buffer.length / 1024);
    logger.info(
      { messageId, fileName: safeFileName, sizeKB },
      'Feishu: downloaded PDF attachment',
    );
    return `[PDF: attachments/${safeFileName} (${sizeKB}KB)]\nUse: pdf-reader extract attachments/${safeFileName}`;
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
