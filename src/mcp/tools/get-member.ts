import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callerFromAuth } from '../../auth/session.js';
import { callerGuilds } from '../../discord/permissions.js';
import type { ToolDeps } from '../server.js';
import { errorResult, jsonResult } from './shared.js';

// get_member — резолв Discord user id → профиль + членство, ТОЛЬКО в гильдиях, которые вызвавший
// делит с целью (не течём состав серверов, где вызвавшего нет). Прослойка к GET /guilds/{id}/members/{id}.
export function registerGetMember(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_member',
    {
      description:
        'Resolve a Discord user id to their profile and per-server membership (nickname, roles, ' +
        'joinedAt), only for servers you share with them. Use it to identify a message author or mention.',
      inputSchema: {
        userId: z.string().describe('Discord user id.'),
        guildId: z.string().optional().describe('Restrict to one server id.'),
      },
    },
    async (args, extra) => {
      const caller = callerFromAuth(extra.authInfo);
      const guilds = await callerGuilds(deps.discord, caller.userId, args.guildId);

      let profile: Record<string, unknown> | null = null;
      const memberships: Record<string, unknown>[] = [];
      for (const guild of guilds) {
        let target;
        try {
          target = await guild.members.fetch(args.userId);
        } catch {
          continue; // цель не состоит в этой гильдии
        }
        profile ??= {
          id: target.user.id,
          username: target.user.username,
          globalName: target.user.globalName ?? null,
          bot: target.user.bot,
        };
        memberships.push({
          guildId: guild.id,
          guildName: guild.name,
          nickname: target.nickname ?? null,
          displayName: target.displayName,
          // @everyone (id == guildId) — не роль в продуктовом смысле, отбрасываем.
          roles: target.roles.cache
            .filter((r) => r.id !== guild.id)
            .map((r) => ({ id: r.id, name: r.name })),
          joinedAt: target.joinedTimestamp ? new Date(target.joinedTimestamp).toISOString() : null,
        });
      }

      if (!profile) {
        return errorResult(`User ${args.userId} is not a member of any server you share.`);
      }
      return jsonResult({ ...profile, memberships });
    },
  );
}
