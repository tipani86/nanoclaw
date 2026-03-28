---
name: add-feishu
description: Add Feishu/Lark as a channel using WebSocket Long Connection. Can run alongside WhatsApp or replace it entirely.
---

# Add Feishu Channel

This skill adds Feishu/Lark (飞书) support to NanoClaw via the Feishu Bot platform and the official `@larksuiteoapi/node-sdk`, using WebSocket Long Connection (no public endpoint required).

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `feishu` is in `applied_skills`, skip to Phase 3 (Setup). Code changes are already in place.

### Check for credentials

Ask the user if they have a Feishu App ID and App Secret, or if they need to create a bot.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-feishu
```

This deterministically:
- Adds `src/channels/feishu.ts` (FeishuChannel class with self-registration)
- Adds `src/channels/feishu.test.ts` (unit tests)
- Inserts `import './feishu.js'` into `src/channels/index.ts`
- Installs `@larksuiteoapi/node-sdk` npm dependency
- Updates `.env.example` with `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_DOMAIN`
- Records the application in `.nanoclaw/state.yaml`

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup — Create a Feishu Bot

Tell the user:

> To connect Feishu, you need to create a custom bot in the Feishu Developer Console:
>
> 1. Go to [open.feishu.cn/app](https://open.feishu.cn/app) (or [open.larksuite.com/app](https://open.larksuite.com/app) for Lark international)
> 2. Click **Create App** → **Custom App**
> 3. Give it a name and description (e.g. "Andy Assistant")
> 4. Under **Credentials & Basic Info**, copy the **App ID** and **App Secret**
>
> **Enable required permissions** (under **Permissions & Scopes**):
>
> *Core messaging:*
> - `im:message` — Read and send messages
> - `im:message.group_at_msg:readonly` — Receive @mention messages in groups
> - `im:message.p2p_msg:readonly` — Receive direct messages
> - `im:message:send_as_bot` — Send messages as bot
> - `im:resource` — Download message resources (images, files, audio, video)
>
> *Advanced features (Docs, Bitable, Drive, Chat, Reactions — add as needed):*
> - `docx:document:readonly` — Read documents (read-only)
> - `docx:document` — Read and create documents (read-write)
> - `bitable:app:readonly` — Read Bitable/Base data (read-only)
> - `bitable:app` — Create, update, delete Bitable records (read-write)
> - `drive:drive:readonly` — List and read Drive files (read-only)
> - `im:chat:readonly` — Read chat info (read-only)
> - `im:chat` — Chat management (read-write)
> - `im:chat.members` — Read and manage chat members
> - `im:message.reactions:read` — Read message reactions
>
> **Subscribe to events** (under **Event Subscriptions** → **Add Event**):
> - `im.message.receive_v1` — Receive messages
>
> **Enable Long Connection** (under **Event Subscriptions**):
> - Switch connection mode to **WebSocket** (Long Connection)
>
> **Publish the app** (under **App Release**):
> - For a company bot: submit for review OR enable in developer mode
> - For a personal bot in a free workspace: enable "Test & Development" mode

Wait for the user to complete the Feishu Console setup and provide App ID and App Secret.

## Phase 4: Configure Environment

Add to `.env`:

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# Optional: 'feishu' (default, feishu.cn) or 'lark' (larksuite.com international)
FEISHU_DOMAIN=feishu
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 5: Build and Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 6: Registration

### Get Chat ID

Tell the user:

> 1. Add your bot to a Feishu group (or open a direct message with the bot)
> 2. Send any message — the bot will log the chat ID in `logs/nanoclaw.log`
> 3. Or check the Feishu console's event log for the `chat_id` value
>
> The chat ID format is:
> - Groups: `oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` (starts with `oc_`)
> - Direct messages: `ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` (starts with `ou_`) or a `p2p_` ID
>
> The registration ID to use in NanoClaw is: `feishu:<chat_id>`
> For example: `feishu:oc_abc123def456`

### Register the chat

For the main chat (responds to all messages without trigger):

```typescript
registerGroup("feishu:<chat-id>", {
  name: "<chat-name>",
  folder: "feishu_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For additional chats (trigger-only):

```typescript
registerGroup("feishu:<chat-id>", {
  name: "<chat-name>",
  folder: "feishu_<group-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 7: Verify

Tell the user:

> Send a message to the registered Feishu chat:
> - For main chat: any message works
> - For non-main: @mention the bot (`@BotName hello`) or use the trigger word
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not receiving messages

1. Verify `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. Check that **Long Connection / WebSocket** is enabled in the Feishu Console (not webhook)
3. Confirm `im.message.receive_v1` event is subscribed in the console
4. Verify the app has `im:message` and `im:message.p2p_msg` permissions and they are **published**
5. Check `logs/nanoclaw.log` for connection or permission errors

### Bot not responding to @mentions in groups

Ensure `im:message.group_at_msg` permission is enabled and the app is published/approved.

### Finding the chat ID

The Feishu chat ID appears in the NanoClaw log when any message arrives:
```
tail -f logs/nanoclaw.log | grep "feishu:"
```

Or add the bot to a chat and send a message — the chat JID will appear in:
```
Feishu: message from unregistered chat  chatJid=feishu:oc_xxxxx
```

### Lark international (larksuite.com)

Set `FEISHU_DOMAIN=lark` in `.env` to use the Lark international domain instead of feishu.cn.

## After Setup

Your Feishu channel is now active. NanoClaw will auto-connect on startup whenever `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are present in the environment.
