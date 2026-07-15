import { type AnyThreadChannel, PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callerFromAuth } from '../../auth/session.js';
import { canUserView, canUserViewChannel } from '../../discord/permissions.js';
import type { ToolDeps } from '../server.js';
import { errorResult, jsonResult } from './shared.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function threadMeta(t: AnyThreadChannel): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    parentId: t.parentId, // канал, из которого ответвился тред
    ownerId: t.ownerId,
    archived: t.archived,
    // archivedAt — курсор пагинации архивных: передай самый старый из выдачи как before.
    // Только для реально архивных (у активных Discord тоже держит archiveTimestamp — не путаем).
    archivedAt: t.archived && t.archiveTimestamp ? new Date(t.archiveTimestamp).toISOString() : null,
    locked: t.locked,
    messageCount: t.messageCount,
    memberCount: t.memberCount,
    createdAt: t.createdTimestamp ? new Date(t.createdTimestamp).toISOString() : null,
    autoArchiveDuration: t.autoArchiveDuration,
  };
}

// list_threads — треды (прослойка к thread-эндпоинтам Discord). Пагинация повторяет нативную
// модель архивных тредов: before (archive timestamp) + limit → { threads, hasMore }.
// С channelId: первая страница (before пуст) = активные + private-archived (best-effort) + первая
// страница public-archived; далее (before задан) — только следующая страница public-archived.
// Без channelId: активные треды по обслуживаемым гильдиям. Только видимые вызвавшему.
export function registerListThreads(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'list_threads',
    {
      description:
        'Threads you may see. With channelId: that channel/forum\'s active + archived threads. To ' +
        'page older archived threads, pass the oldest returned archivedAt back as before; hasMore ' +
        'signals more remain (limit ≤100, default 50). Private archived threads may appear only on ' +
        'the first page. Without channelId: active threads across all your servers. Returns ' +
        '{ threads, hasMore }. Read one with get_messages(channelId=thread id).',
      inputSchema: {
        channelId: z
          .string()
          .optional()
          .describe('Parent channel/forum id. Omit for active threads across all servers.'),
        before: z
          .string()
          .optional()
          .describe('Page archived threads older than this archive timestamp (ISO 8601). Use with channelId.'),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('Max archived per page (default 50).'),
      },
    },
    async (args, extra) => {
      const caller = callerFromAuth(extra.authInfo);
      const limit = args.limit ?? DEFAULT_LIMIT;
      if (args.before !== undefined && Number.isNaN(Date.parse(args.before))) {
        return errorResult(`Invalid before "${args.before}" (expected ISO 8601 timestamp).`);
      }

      const collected: AnyThreadChannel[] = [];
      let hasMore = false;

      if (args.channelId) {
        const allowed = await canUserViewChannel(deps.discord, caller.userId, args.channelId);
        if (!allowed) return errorResult(`Access denied: you cannot view channel ${args.channelId}.`);
        const channel = await deps.discord.channels.fetch(args.channelId);
        if (!channel || !('threads' in channel)) {
          return errorResult(`Channel ${args.channelId} does not have threads.`);
        }
        const firstPage = args.before === undefined;

        if (firstPage) {
          const active = await channel.threads.fetchActive();
          collected.push(...active.threads.values());
        }

        const pub = await channel.threads.fetchArchived({ type: 'public', before: args.before, limit });
        const pubThreads = [...pub.threads.values()];
        collected.push(...pubThreads);
        hasMore = pub.hasMore;

        // Приватные архивные — только на первой странице: joined-эндпоинт листается по id (не
        // совместим с timestamp-курсором public), а с Manage Threads у бота (fetchAll) их обычно
        // немного. best-effort; per-caller гейт ниже отсекает треды, где вызвавший не член.
        if (firstPage) {
          const me = channel.guild.members.me;
          const botCanManage = me?.permissionsIn(channel).has(PermissionFlagsBits.ManageThreads) ?? false;
          try {
            const priv = await channel.threads.fetchArchived({ type: 'private', fetchAll: botCanManage, limit });
            let privThreads = [...priv.threads.values()];
            // Курсор — по public. Чтобы листание по общему oldest не перескочило public, не отдаём
            // private старше самого старого public на этой странице (когда у public есть продолжение).
            if (pub.hasMore && pubThreads.length > 0) {
              const oldestPub = Math.min(...pubThreads.map((t) => t.archiveTimestamp ?? 0));
              privThreads = privThreads.filter((t) => (t.archiveTimestamp ?? 0) >= oldestPub);
            }
            collected.push(...privThreads);
          } catch {
            // даже joined-private может отдать 403 в краевых случаях — best-effort
          }
        }
      } else {
        for (const guild of deps.discord.guilds.cache.values()) {
          const active = await guild.channels.fetchActiveThreads();
          collected.push(...active.threads.values());
        }
      }

      const visible: AnyThreadChannel[] = [];
      for (const t of collected) {
        if (await canUserView(deps.discord, caller.userId, t.id)) visible.push(t);
      }
      return jsonResult({ threads: visible.map(threadMeta), hasMore });
    },
  );
}
