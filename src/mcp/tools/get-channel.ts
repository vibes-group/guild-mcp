import { ChannelType } from 'discord.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callerFromAuth } from '../../auth/session.js';
import { canUserViewChannel } from '../../discord/permissions.js';
import type { ToolDeps } from '../server.js';
import { errorResult, jsonResult } from './shared.js';

// get_channel — метаданные канала/треда (прослойка к GET /channels/{id}). Для навигации по цепочке
// диалога: тред указывает на родительский канал (parentId) и стартовое сообщение (starterMessageId,
// его id == id треда) → так агент доходит до начала разговора, ушедшего из канала в тред.
export function registerGetChannel(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_channel',
    {
      description:
        'Metadata for a channel or thread: type, name, topic, parentId. A thread also has owner, ' +
        'archive state, and starterMessageId (equals the thread id) — the message it grew from, to ' +
        'walk a conversation back to its start.',
      inputSchema: {
        channelId: z.string().describe('Channel or thread id.'),
      },
    },
    async (args, extra) => {
      const caller = callerFromAuth(extra.authInfo);
      const allowed = await canUserViewChannel(deps.discord, caller.userId, args.channelId);
      if (!allowed) return errorResult(`Access denied: you cannot view channel ${args.channelId}.`);

      const channel = await deps.discord.channels.fetch(args.channelId);
      if (!channel || channel.isDMBased() || !('guildId' in channel)) {
        return errorResult(`Channel ${args.channelId} is not a guild channel.`);
      }

      const meta: Record<string, unknown> = {
        id: channel.id,
        type: ChannelType[channel.type] ?? channel.type,
        name: channel.name,
        guildId: channel.guildId,
        parentId: channel.parentId, // тред → родительский канал; канал → категория
      };
      if ('topic' in channel) meta.topic = channel.topic;
      if (channel.isThread()) {
        meta.ownerId = channel.ownerId;
        // = id треда: у обычного треда сообщение с этим id лежит в parentId, у форум-поста — в самом треде.
        meta.starterMessageId = channel.id;
        meta.archived = channel.archived;
        meta.locked = channel.locked;
        meta.autoArchiveDuration = channel.autoArchiveDuration;
        meta.archiveTimestamp = channel.archiveTimestamp
          ? new Date(channel.archiveTimestamp).toISOString()
          : null;
        meta.messageCount = channel.messageCount;
        meta.memberCount = channel.memberCount;
      }
      return jsonResult(meta);
    },
  );
}
