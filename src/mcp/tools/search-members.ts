import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callerFromAuth } from '../../auth/session.js';
import { callerGuilds } from '../../discord/permissions.js';
import type { ToolDeps } from '../server.js';
import { jsonResult } from './shared.js';

// search_members — поиск участников по имени/нику (префикс) через GET /guilds/{id}/members/search,
// по гильдиям, которые вызвавший делит с ботом. Даёт id для search_messages(authorId)/get_member.
export function registerSearchMembers(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'search_members',
    {
      description:
        'Find members by name or nickname prefix across your servers. Returns light profiles with ' +
        'ids — pass an id to search_messages(authorId), or get_member for full detail.',
      inputSchema: {
        query: z.string().describe('Name or nickname prefix to match.'),
        guildId: z.string().optional().describe('Restrict to one server id.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results per server (default 25).'),
      },
    },
    async (args, extra) => {
      const caller = callerFromAuth(extra.authInfo);
      const guilds = await callerGuilds(deps.discord, caller.userId, args.guildId);

      const results: Record<string, unknown>[] = [];
      for (const guild of guilds) {
        let found;
        try {
          found = await guild.members.search({ query: args.query, limit: args.limit ?? 25 });
        } catch {
          continue; // гильдия недоступна для поиска — пропускаем, не роняем весь обход
        }
        for (const m of found.values()) {
          results.push({
            id: m.user.id,
            username: m.user.username,
            globalName: m.user.globalName ?? null,
            nickname: m.nickname ?? null,
            bot: m.user.bot,
            guildId: guild.id,
            guildName: guild.name,
          });
        }
      }
      return jsonResult(results);
    },
  );
}
