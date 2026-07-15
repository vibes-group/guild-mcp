import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callerFromAuth } from '../../auth/session.js';
import { fetchMessages } from '../../discord/messages.js';
import type { ToolDeps } from '../server.js';
import {
  errorResult,
  fetchErrorResult,
  formatCompactList,
  jsonResult,
  makeChannelGate,
  toSnowflake,
} from './shared.js';

// get_messages — история канала (newest first), полное содержимое, живое чтение из Discord API.
// Отказ, если вызвавший канал не видит.
export function registerGetMessages(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_messages',
    {
      description:
        'Recent history of a channel or thread, newest first, fetched live. Returns compact cards; ' +
        'page with before/after, or center on a message with around.',
      inputSchema: {
        channelId: z.string().describe('Channel id (a thread has its own id).'),
        limit: z.number().int().positive().max(100).optional().describe('Max messages (default 50).'),
        before: z.string().optional().describe('ISO 8601 or message id; before it.'),
        after: z.string().optional().describe('ISO 8601 or message id; after it.'),
        around: z
          .string()
          .optional()
          .describe('ISO 8601 or message id; around it (context for a hit). Exclusive with before/after.'),
      },
    },
    async (args, extra) => {
      const caller = callerFromAuth(extra.authInfo);
      if (args.around !== undefined && (args.before !== undefined || args.after !== undefined)) {
        return errorResult('around is exclusive with before/after — pass only one.');
      }
      let messages;
      try {
        messages = await fetchMessages(deps.discord, caller.userId, args.channelId, {
          limit: args.limit ?? 50,
          before: toSnowflake(args.before),
          after: toSnowflake(args.after),
          around: toSnowflake(args.around),
        });
      } catch (e) {
        return fetchErrorResult(e, 'Failed to fetch messages');
      }
      const gate = makeChannelGate(deps, caller.userId);
      return jsonResult(await formatCompactList(messages, gate));
    },
  );
}
