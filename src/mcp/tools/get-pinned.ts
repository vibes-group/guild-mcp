import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callerFromAuth } from '../../auth/session.js';
import { fetchPinned } from '../../discord/messages.js';
import type { ToolDeps } from '../server.js';
import { fetchErrorResult, formatCompactList, jsonResult, makeChannelGate } from './shared.js';

// get_pinned — закреплённые сообщения канала (прослойка к GET /channels/{id}/pins).
// Тот же гейтинг по видимости канала, что и у get_messages.
export function registerGetPinned(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_pinned',
    {
      description: 'Pinned messages of a channel, as compact cards.',
      inputSchema: {
        channelId: z.string().describe('Channel id.'),
      },
    },
    async (args, extra) => {
      const caller = callerFromAuth(extra.authInfo);
      let pinned;
      try {
        pinned = await fetchPinned(deps.discord, caller.userId, args.channelId);
      } catch (e) {
        return fetchErrorResult(e, 'Failed to fetch pinned messages');
      }
      const gate = makeChannelGate(deps, caller.userId);
      return jsonResult(await formatCompactList(pinned, gate));
    },
  );
}
