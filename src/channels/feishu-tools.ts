/**
 * Feishu API tools — host-side handler for IPC requests from container agents.
 * Dispatches API calls to the Lark SDK client and returns results.
 */
import type * as Lark from '@larksuiteoapi/node-sdk';

import { logger } from '../logger.js';

export interface FeishuApiRequest {
  id: string;
  type: 'feishu_api';
  method: string;
  params: Record<string, unknown>;
}

export interface FeishuApiResponse {
  id: string;
  status: 'success' | 'error';
  data?: unknown;
  error?: string;
}

/**
 * Handle a Feishu API request from a container agent.
 * Returns the response to write back via IPC.
 */
export async function handleFeishuApiRequest(
  client: Lark.Client,
  request: FeishuApiRequest,
): Promise<FeishuApiResponse> {
  const { id, method, params } = request;

  try {
    const result = await dispatchMethod(client, method, params);
    return { id, status: 'success', data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ method, params, err }, 'Feishu API request failed');
    return { id, status: 'error', error: message };
  }
}

async function dispatchMethod(
  client: Lark.Client,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    // --- Documents ---
    case 'read_doc':
      return readDocument(client, params.document_id as string);
    case 'create_doc': {
      const res = await (client.docx as any).document.create({
        data: {
          title: params.title as string,
          folder_token: (params.folder_token as string) || undefined,
        },
      });
      return {
        document_id: res?.data?.document?.document_id,
        title: res?.data?.document?.title,
        url: res?.data?.document?.url,
      };
    }

    // --- Bitable ---
    case 'list_bitable_tables': {
      const res = await (client.bitable as any).app.table.list({
        params: {
          page_size: (params.page_size as number) || 100,
          page_token: (params.page_token as string) || undefined,
        },
        path: { app_token: params.app_token as string },
      });
      return {
        tables: res?.data?.items || [],
        has_more: res?.data?.has_more || false,
        page_token: res?.data?.page_token,
      };
    }
    case 'list_bitable_records': {
      const res = await (client.bitable as any).app.table.record.list({
        params: {
          page_size: (params.page_size as number) || 100,
          page_token: (params.page_token as string) || undefined,
          filter: (params.filter as string) || undefined,
          sort: (params.sort as string) || undefined,
          automatic_fields: true,
        },
        path: {
          app_token: params.app_token as string,
          table_id: params.table_id as string,
        },
      });
      return {
        records: res?.data?.items || [],
        total: res?.data?.total,
        has_more: res?.data?.has_more || false,
        page_token: res?.data?.page_token,
      };
    }
    case 'get_bitable_record': {
      const res = await (client.bitable as any).app.table.record.get({
        params: { automatic_fields: true },
        path: {
          app_token: params.app_token as string,
          table_id: params.table_id as string,
          record_id: params.record_id as string,
        },
      });
      return res?.data?.record || null;
    }
    case 'create_bitable_record': {
      const res = await (client.bitable as any).app.table.record.create({
        data: { fields: params.fields as Record<string, unknown> },
        path: {
          app_token: params.app_token as string,
          table_id: params.table_id as string,
        },
      });
      return res?.data?.record || null;
    }
    case 'update_bitable_record': {
      const res = await (client.bitable as any).app.table.record.update({
        data: { fields: params.fields as Record<string, unknown> },
        path: {
          app_token: params.app_token as string,
          table_id: params.table_id as string,
          record_id: params.record_id as string,
        },
      });
      return res?.data?.record || null;
    }
    case 'delete_bitable_record': {
      await (client.bitable as any).app.table.record.delete({
        path: {
          app_token: params.app_token as string,
          table_id: params.table_id as string,
          record_id: params.record_id as string,
        },
      });
      return { deleted: true };
    }

    // --- Drive ---
    case 'list_drive_files': {
      const res = await (client.drive as any).file.list({
        params: {
          folder_token: (params.folder_token as string) || undefined,
          page_size: (params.page_size as number) || 50,
          page_token: (params.page_token as string) || undefined,
          order_by: (params.order_by as string) || 'EditedTime',
          direction: (params.direction as string) || 'DESC',
        },
      });
      return {
        files: res?.data?.files || [],
        has_more: res?.data?.has_more || false,
        next_page_token: res?.data?.next_page_token,
      };
    }

    // --- Chat ---
    case 'list_chats': {
      const res = await (client.im as any).chat.list({
        params: {
          page_size: (params.page_size as number) || 50,
          page_token: (params.page_token as string) || undefined,
          sort_type: 'ByActiveTimeDesc',
        },
      });
      return {
        chats: res?.data?.items || [],
        has_more: res?.data?.has_more || false,
        page_token: res?.data?.page_token,
      };
    }
    case 'get_chat_info': {
      const res = await (client.im as any).chat.get({
        path: { chat_id: params.chat_id as string },
      });
      return res?.data || null;
    }
    case 'get_chat_members': {
      const res = await (client.im as any).chatMembers.get({
        params: {
          page_size: (params.page_size as number) || 50,
          page_token: (params.page_token as string) || undefined,
        },
        path: { chat_id: params.chat_id as string },
      });
      return {
        members: res?.data?.items || [],
        member_total: res?.data?.member_total,
        has_more: res?.data?.has_more || false,
        page_token: res?.data?.page_token,
      };
    }

    // --- Reactions ---
    case 'add_reaction': {
      const res = await (client.im as any).messageReaction.create({
        data: {
          reaction_type: { emoji_type: params.emoji_type as string },
        },
        path: { message_id: params.message_id as string },
      });
      return {
        reaction_id: res?.data?.reaction_id,
        emoji_type: res?.data?.reaction_type?.emoji_type,
      };
    }
    case 'list_reactions': {
      const res = await (client.im as any).messageReaction.list({
        params: {
          page_size: (params.page_size as number) || 50,
          page_token: (params.page_token as string) || undefined,
          reaction_type: (params.reaction_type as string) || undefined,
        },
        path: { message_id: params.message_id as string },
      });
      return {
        reactions: res?.data?.items || [],
        has_more: res?.data?.has_more || false,
        page_token: res?.data?.page_token,
      };
    }
    case 'delete_reaction': {
      await (client.im as any).messageReaction.delete({
        path: {
          message_id: params.message_id as string,
          reaction_id: params.reaction_id as string,
        },
      });
      return { deleted: true };
    }

    default:
      throw new Error(`Unknown Feishu API method: ${method}`);
  }
}

async function readDocument(
  client: Lark.Client,
  documentId: string,
): Promise<unknown> {
  const res = await (client.docx as any).document.rawContent({
    path: { document_id: documentId },
  });
  return {
    content: res?.data?.content || '',
  };
}
