import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callerFromAuth } from '../../auth/session.js';
import { search, SearchError } from '../../discord/search.js';
import type { ToolDeps } from '../server.js';
import { errorResult, jsonResult, toSnowflake } from './shared.js';

// search_messages — прослойка к Discord Search API, ограниченная каналами, видимыми
// вызвавшему. Параметры повторяют нативный endpoint; ранжирование выполняет Discord.
export function registerSearchMessages(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'search_messages',
    {
      description:
        'Search messages in channels you may see, via Discord\'s index. Every filter is optional — ' +
        'filter-only search (no text) works. Returns light hits + totalResults; expand one with ' +
        'get_message(channelId, messageId). Freshly posted or edited messages may lag the index briefly — ' +
        'for the very latest use get_messages. Page with limit (≤25) + offset.',
      inputSchema: {
        content: z
          .string()
          .optional()
          .describe('Search terms over message text and file names. Use "quotes" for exact phrases.'),
        channelId: z.string().optional().describe('Restrict to one channel id.'),
        authorId: z.string().optional().describe('Only messages from this user id.'),
        mentions: z.string().optional().describe('Only messages mentioning this user id.'),
        has: z
          .array(z.enum(['link', 'embed', 'file', 'image', 'video', 'sound', 'sticker']))
          .optional()
          .describe('Only messages containing all of these (e.g. ["file"] = has an attachment).'),
        pinned: z.boolean().optional().describe('Only pinned (true) / only unpinned (false).'),
        minId: z.string().optional().describe('Messages newer than this — message id (snowflake) or ISO 8601.'),
        maxId: z.string().optional().describe('Messages older than this — message id (snowflake) or ISO 8601.'),
        sortBy: z.enum(['relevance', 'timestamp']).optional().describe('Ranking (default relevance).'),
        sortOrder: z.enum(['asc', 'desc']).optional().describe('Order (default desc).'),
        offset: z.number().int().min(0).max(9975).optional().describe('Pagination offset (default 0).'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results per page (default 25).'),
      },
    },
    async (args, extra) => {
      const caller = callerFromAuth(extra.authInfo);
      try {
        const result = await search(deps.discord, caller.userId, {
          content: args.content,
          channelId: args.channelId,
          authorId: args.authorId,
          mentions: args.mentions,
          has: args.has,
          pinned: args.pinned,
          minId: toSnowflake(args.minId),
          maxId: toSnowflake(args.maxId),
          sortBy: args.sortBy,
          sortOrder: args.sortOrder,
          offset: args.offset,
          limit: args.limit ?? 25,
        });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof SearchError) return errorResult(e.message);
        throw e;
      }
    },
  );
}
