import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callerFromAuth } from '../../auth/session.js';
import { fetchMessage } from '../../discord/messages.js';
import type { ToolDeps } from '../server.js';
import { fetchErrorResult, formatMessageFull, jsonResult, makeChannelGate } from './shared.js';

// get_message — одно сообщение по id, полная карточка из Discord API. Для «разверни хит search».
// Тот же гейтинг по каналу, что и у get_messages: отказ, если вызвавший канал не видит.
export function registerGetMessage(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_message',
    {
      description:
        'One message in full detail, fetched live — e.g. to expand a search hit. Follow a ' +
        'reply/forward chain by re-fetching reference.messageId/channelId up to the root.',
      inputSchema: {
        channelId: z.string().describe('Channel id the message is in.'),
        messageId: z.string().describe('Message id.'),
      },
    },
    async (args, extra) => {
      const caller = callerFromAuth(extra.authInfo);
      let msg;
      try {
        msg = await fetchMessage(deps.discord, caller.userId, args.channelId, args.messageId);
      } catch (e) {
        return fetchErrorResult(e, `Failed to fetch message ${args.messageId} in channel ${args.channelId}`);
      }
      const gate = makeChannelGate(deps, caller.userId);
      return jsonResult(await formatMessageFull(msg, gate));
    },
  );
}
