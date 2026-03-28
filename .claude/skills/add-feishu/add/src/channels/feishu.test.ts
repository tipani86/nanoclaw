import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  GROUPS_DIR: '/tmp/test-groups',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

const mockProcessImage = vi.fn();
vi.mock('../image.js', () => ({
  processImage: (...args: unknown[]) => mockProcessImage(...args),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Build a mock Lark SDK
const mockSendMessage = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'om_mock' } });
const mockGetBotInfo = vi.fn().mockResolvedValue({
  data: { bot: { open_id: 'ou_botid', app_name: 'TestBot' } },
});
const mockMessageResourceGet = vi.fn();

let capturedEventHandler: ((event: unknown) => Promise<void>) | null = null;

const mockWSClient = {
  start: vi.fn(),
};

vi.mock('@larksuiteoapi/node-sdk', () => ({
  // Must use `function` (not arrow) so `new Client()` works as a constructor
  Client: vi.fn(function (this: any) {
    this.bot = { getBotInfo: mockGetBotInfo };
    this.im = { message: { create: mockSendMessage }, messageResource: { get: mockMessageResourceGet } };
  }),
  WSClient: vi.fn(function (this: any) {
    this.start = mockWSClient.start;
  }),
  EventDispatcher: vi.fn(function (this: any) {
    this.register = function (
      this: any,
      handlers: Record<string, (event: unknown) => Promise<void>>,
    ) {
      capturedEventHandler = handlers['im.message.receive_v1'] ?? null;
      return this;
    };
  }),
  Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
  LoggerLevel: { warn: 'warn', info: 'info' },
}));

import {
  FeishuChannel,
  FeishuChannelOpts,
  parseFeishuMessageContent,
  stripBotMentionTag,
} from './feishu.js';

// --- Helpers ---

function createTestOpts(overrides?: Partial<FeishuChannelOpts>): FeishuChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'feishu:oc_registered': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

async function makeConnectedChannel(opts?: Partial<FeishuChannelOpts>) {
  const channel = new FeishuChannel(
    'cli_test_app_id',
    'test_secret',
    'https://open.feishu.cn',
    createTestOpts(opts),
  );
  await channel.connect();
  return channel;
}

async function fireEvent(event: unknown) {
  if (!capturedEventHandler) throw new Error('No event handler registered');
  await capturedEventHandler(event);
  // Flush microtasks
  await new Promise((r) => setTimeout(r, 0));
}

function makeMessageEvent(overrides: {
  chatId?: string;
  chatType?: string;
  msgType?: string;
  content?: string;
  messageId?: string;
  senderOpenId?: string;
  senderUserId?: string;
  senderType?: string;
  createTime?: string;
  mentions?: Array<{ id?: { open_id?: string } }>;
}) {
  return {
    sender: {
      sender_id: {
        open_id: overrides.senderOpenId ?? 'ou_user123',
        user_id: overrides.senderUserId ?? 'user123',
      },
      sender_type: overrides.senderType ?? 'user',
    },
    message: {
      message_id: overrides.messageId ?? 'om_test_msg',
      chat_id: overrides.chatId ?? 'oc_registered',
      chat_type: overrides.chatType ?? 'group',
      message_type: overrides.msgType ?? 'text',
      content: overrides.content ?? JSON.stringify({ text: 'Hello Andy' }),
      create_time: overrides.createTime ?? String(Date.now()),
      mentions: overrides.mentions ?? [],
    },
  };
}

// --- Unit tests ---

describe('parseFeishuMessageContent', () => {
  it('parses text message', () => {
    const result = parseFeishuMessageContent(JSON.stringify({ text: 'Hello world' }), 'text');
    expect(result).toBe('Hello world');
  });

  it('returns empty string for text with no text field', () => {
    const result = parseFeishuMessageContent(JSON.stringify({}), 'text');
    expect(result).toBe('');
  });

  it('parses post (rich text) message — zh_cn', () => {
    const content = JSON.stringify({
      zh_cn: {
        title: 'Title',
        content: [
          [
            { tag: 'text', text: 'Hello ' },
            { tag: 'a', href: 'https://example.com', text: 'link' },
          ],
          [{ tag: 'text', text: 'world' }],
        ],
      },
    });
    const result = parseFeishuMessageContent(content, 'post');
    expect(result).toContain('Hello');
    expect(result).toContain('world');
  });

  it('returns [Image] for image type', () => {
    expect(parseFeishuMessageContent('{}', 'image')).toBe('[Image]');
  });

  it('returns [Audio] for audio type', () => {
    expect(parseFeishuMessageContent('{}', 'audio')).toBe('[Audio]');
  });

  it('returns [Video] for video type', () => {
    expect(parseFeishuMessageContent('{}', 'video')).toBe('[Video]');
  });

  it('returns file name for file type', () => {
    const result = parseFeishuMessageContent(
      JSON.stringify({ file_name: 'report.pdf' }),
      'file',
    );
    expect(result).toBe('[File: report.pdf]');
  });

  it('returns [Sticker] for sticker type', () => {
    expect(parseFeishuMessageContent('{}', 'sticker')).toBe('[Sticker]');
  });

  it('returns [unknown] for unknown type', () => {
    expect(parseFeishuMessageContent('{}', 'unknown')).toBe('[unknown]');
  });

  it('handles invalid JSON gracefully', () => {
    const result = parseFeishuMessageContent('not-json', 'text');
    expect(result).toBe('not-json');
  });
});

describe('stripBotMentionTag', () => {
  it('strips bot mention tag', () => {
    const content = '<at user_id="ou_bot123">BotName</at> hello';
    expect(stripBotMentionTag(content, 'ou_bot123')).toBe('hello');
  });

  it('leaves other mention tags intact', () => {
    const content = '<at user_id="ou_other">OtherUser</at> hello';
    expect(stripBotMentionTag(content, 'ou_bot123')).toBe(content.trim());
  });

  it('handles content with no mention tags', () => {
    expect(stripBotMentionTag('plain text', 'ou_bot123')).toBe('plain text');
  });

  it('strips multiple bot mentions', () => {
    const content = '<at user_id="ou_bot">Bot</at> hey <at user_id="ou_bot">Bot</at>!';
    expect(stripBotMentionTag(content, 'ou_bot')).toBe('hey !');
  });
});

describe('FeishuChannel', () => {
  beforeEach(() => {
    capturedEventHandler = null;
    vi.clearAllMocks();
    mockGetBotInfo.mockResolvedValue({
      data: { bot: { open_id: 'ou_botid', app_name: 'TestBot' } },
    });
    mockSendMessage.mockResolvedValue({ code: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection ---

  describe('connect()', () => {
    it('fetches bot identity on connect', async () => {
      await makeConnectedChannel();
      expect(mockGetBotInfo).toHaveBeenCalled();
    });

    it('connects even if bot identity fetch fails', async () => {
      mockGetBotInfo.mockRejectedValueOnce(new Error('API error'));
      const channel = await makeConnectedChannel();
      expect(channel.isConnected()).toBe(true);
    });

    it('starts WebSocket connection', async () => {
      await makeConnectedChannel();
      expect(mockWSClient.start).toHaveBeenCalled();
    });

    it('isConnected() returns true after connect', async () => {
      const channel = await makeConnectedChannel();
      expect(channel.isConnected()).toBe(true);
    });
  });

  describe('disconnect()', () => {
    it('isConnected() returns false after disconnect', async () => {
      const channel = await makeConnectedChannel();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- ownsJid ---

  describe('ownsJid()', () => {
    it('owns feishu: JIDs', () => {
      const channel = new FeishuChannel('id', 'secret', 'domain', createTestOpts());
      expect(channel.ownsJid('feishu:oc_123')).toBe(true);
    });

    it('does not own tg: JIDs', () => {
      const channel = new FeishuChannel('id', 'secret', 'domain', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new FeishuChannel('id', 'secret', 'domain', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered chat', async () => {
      const opts = createTestOpts();
      await makeConnectedChannel(opts);

      await fireEvent(makeMessageEvent({ chatId: 'oc_registered' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_registered',
        expect.objectContaining({
          id: 'om_test_msg',
          content: 'Hello Andy',
          chat_jid: 'feishu:oc_registered',
        }),
      );
    });

    it('emits metadata for unregistered chat but does not deliver message', async () => {
      const opts = createTestOpts();
      await makeConnectedChannel(opts);

      await fireEvent(makeMessageEvent({ chatId: 'oc_unknown' }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:oc_unknown',
        expect.any(String),
        undefined,
        'feishu',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores messages from the bot itself (by open_id)', async () => {
      const opts = createTestOpts();
      await makeConnectedChannel(opts);

      await fireEvent(
        makeMessageEvent({
          chatId: 'oc_registered',
          senderOpenId: 'ou_botid', // same as bot open_id
        }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores messages from app sender_type', async () => {
      const opts = createTestOpts();
      await makeConnectedChannel(opts);

      await fireEvent(
        makeMessageEvent({
          chatId: 'oc_registered',
          senderType: 'app',
        }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores events with no message', async () => {
      const opts = createTestOpts();
      await makeConnectedChannel(opts);

      await fireEvent({ sender: { sender_type: 'user' }, message: null });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('marks group chats as isGroup=true', async () => {
      const opts = createTestOpts();
      await makeConnectedChannel(opts);

      await fireEvent(makeMessageEvent({ chatId: 'oc_registered', chatType: 'group' }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:oc_registered',
        expect.any(String),
        undefined,
        'feishu',
        true,
      );
    });

    it('marks p2p chats as isGroup=false', async () => {
      const opts = createTestOpts({
        registeredGroups: () => ({
          'feishu:ou_dm': {
            name: 'DM',
            folder: 'feishu-dm',
            trigger: '@Andy',
            added_at: '2024-01-01',
          },
        }),
      });
      await makeConnectedChannel(opts);

      await fireEvent(makeMessageEvent({ chatId: 'ou_dm', chatType: 'p2p' }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:ou_dm',
        expect.any(String),
        undefined,
        'feishu',
        false,
      );
    });
  });

  // --- @mention handling ---

  describe('@mention handling', () => {
    it('prepends trigger when bot is @mentioned', async () => {
      const opts = createTestOpts();
      await makeConnectedChannel(opts);

      await fireEvent(
        makeMessageEvent({
          chatId: 'oc_registered',
          content: JSON.stringify({ text: '<at user_id="ou_botid">Bot</at> do something' }),
          mentions: [{ id: { open_id: 'ou_botid' } }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_registered',
        expect.objectContaining({
          content: expect.stringMatching(/^@Andy /),
        }),
      );
    });

    it('strips bot mention tag from content', async () => {
      const opts = createTestOpts();
      await makeConnectedChannel(opts);

      await fireEvent(
        makeMessageEvent({
          chatId: 'oc_registered',
          content: JSON.stringify({ text: '<at user_id="ou_botid">Bot</at> hello' }),
          mentions: [{ id: { open_id: 'ou_botid' } }],
        }),
      );

      const call = vi.mocked(opts.onMessage).mock.calls[0];
      expect(call[1].content).not.toContain('<at user_id="ou_botid">');
    });

    it('does not double-prefix if content already starts with trigger', async () => {
      const opts = createTestOpts();
      await makeConnectedChannel(opts);

      await fireEvent(
        makeMessageEvent({
          chatId: 'oc_registered',
          content: JSON.stringify({
            text: '<at user_id="ou_botid">Bot</at> @Andy help',
          }),
          mentions: [{ id: { open_id: 'ou_botid' } }],
        }),
      );

      const call = vi.mocked(opts.onMessage).mock.calls[0];
      expect(call[1].content.match(/@Andy/gi)?.length).toBe(1);
    });
  });

  // --- sendMessage ---

  describe('sendMessage()', () => {
    it('sends text message via Feishu API', async () => {
      await makeConnectedChannel();

      const channel = new FeishuChannel(
        'cli_test_app_id',
        'test_secret',
        'https://open.feishu.cn',
        createTestOpts(),
      );
      await channel.connect();
      await channel.sendMessage('feishu:oc_registered', 'Hello there');

      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { receive_id_type: 'chat_id' },
          data: expect.objectContaining({
            receive_id: 'oc_registered',
            msg_type: 'text',
            content: JSON.stringify({ text: 'Hello there' }),
          }),
        }),
      );
    });

    it('strips feishu: prefix from JID before sending', async () => {
      const channel = new FeishuChannel(
        'id',
        'secret',
        'domain',
        createTestOpts(),
      );
      await channel.connect();
      await channel.sendMessage('feishu:oc_abc123', 'Hi');

      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ receive_id: 'oc_abc123' }),
        }),
      );
    });

    it('splits long messages into chunks', async () => {
      const channel = new FeishuChannel(
        'id',
        'secret',
        'domain',
        createTestOpts(),
      );
      await channel.connect();

      const longText = 'A'.repeat(8500); // > 4000 chars → 3 chunks
      await channel.sendMessage('feishu:oc_registered', longText);

      expect(mockSendMessage).toHaveBeenCalledTimes(3);
    });

    it('handles send failure gracefully without throwing', async () => {
      mockSendMessage.mockRejectedValueOnce(new Error('Network error'));

      const channel = new FeishuChannel(
        'id',
        'secret',
        'domain',
        createTestOpts(),
      );
      await channel.connect();

      await expect(
        channel.sendMessage('feishu:oc_registered', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('logs warning when client is not initialized', async () => {
      const { logger } = await import('../logger.js');
      const channel = new FeishuChannel('id', 'secret', 'domain', createTestOpts());
      // Do not call connect() — client is null

      await channel.sendMessage('feishu:oc_registered', 'Test');
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // --- channel properties ---

  describe('channel properties', () => {
    it('has name "feishu"', () => {
      const channel = new FeishuChannel('id', 'secret', 'domain', createTestOpts());
      expect(channel.name).toBe('feishu');
    });
  });

  // --- image handling ---

  describe('image handling', () => {
    beforeEach(() => {
      mockProcessImage.mockReset();
      mockMessageResourceGet.mockReset();
    });

    it('downloads and processes image messages', async () => {
      const opts = createTestOpts();
      await makeConnectedChannel(opts);

      const fakeBuffer = Buffer.from('fake-image-data');
      const { Readable } = await import('stream');
      const stream = Readable.from([fakeBuffer]);
      mockMessageResourceGet.mockResolvedValue({ getReadableStream: () => stream });
      mockProcessImage.mockResolvedValue({
        content: '[Image: attachments/img-123.jpg]',
        relativePath: 'attachments/img-123.jpg',
      });

      await fireEvent({
        sender: { sender_id: { open_id: 'ou_user1' }, sender_type: 'user' },
        message: {
          chat_id: 'oc_registered',
          message_id: 'om_img1',
          chat_type: 'group',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_key_abc' }),
          create_time: '1700000000000',
        },
      });

      expect(mockMessageResourceGet).toHaveBeenCalledWith({
        params: { type: 'image' },
        path: { message_id: 'om_img1', file_key: 'img_key_abc' },
      });
      expect(mockProcessImage).toHaveBeenCalled();

      const call = vi.mocked(opts.onMessage).mock.calls[0];
      expect(call[1].content).toBe('[Image: attachments/img-123.jpg]');
    });

    it('falls back to [Image] when download fails', async () => {
      const opts = createTestOpts();
      await makeConnectedChannel(opts);

      mockMessageResourceGet.mockRejectedValue(new Error('Network error'));

      await fireEvent({
        sender: { sender_id: { open_id: 'ou_user1' }, sender_type: 'user' },
        message: {
          chat_id: 'oc_registered',
          message_id: 'om_img2',
          chat_type: 'group',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_key_fail' }),
          create_time: '1700000000000',
        },
      });

      const call = vi.mocked(opts.onMessage).mock.calls[0];
      expect(call[1].content).toBe('[Image]');
    });

    it('falls back to [Image] when processImage returns null', async () => {
      const opts = createTestOpts();
      await makeConnectedChannel(opts);

      const { Readable } = await import('stream');
      const stream = Readable.from([Buffer.from('data')]);
      mockMessageResourceGet.mockResolvedValue({ getReadableStream: () => stream });
      mockProcessImage.mockResolvedValue(null);

      await fireEvent({
        sender: { sender_id: { open_id: 'ou_user1' }, sender_type: 'user' },
        message: {
          chat_id: 'oc_registered',
          message_id: 'om_img3',
          chat_type: 'group',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_key_null' }),
          create_time: '1700000000000',
        },
      });

      const call = vi.mocked(opts.onMessage).mock.calls[0];
      expect(call[1].content).toBe('[Image]');
    });
  });
});
