import {
  ChannelType,
  type Client,
  type GuildBasedChannel,
  type GuildMember,
  PermissionFlagsBits,
  PermissionsBitField,
  type PermissionResolvable,
} from 'discord.js';
import type { Config } from '../src/config.js';

// Настоящий PermissionsBitField discord.js — .has() считается достоверно.
export function perms(...flags: PermissionResolvable[]): PermissionsBitField {
  return new PermissionsBitField(flags);
}

export const VIEW = PermissionFlagsBits.ViewChannel;
export const READ_HISTORY = PermissionFlagsBits.ReadMessageHistory;
export const MANAGE_THREADS = PermissionFlagsBits.ManageThreads;

export function config(): Config {
  return {
    DISCORD_CLIENT_ID: 'discord-client',
    OAUTH_REDIRECT_URI: 'https://example.test/oauth/discord/callback',
    DB_PATH: ':memory:',
  } as Config;
}

export function member(id = 'u1'): GuildMember {
  return { id } as unknown as GuildMember;
}

// fetch, который кидает (нет member'а / ошибка Discord) — для fail-closed веток.
const throwFetch = async (): Promise<never> => {
  throw new Error('member not resolvable');
};

type ChannelOpts = {
  id?: string;
  type?: ChannelType;
  textBased?: boolean;
  dmBased?: boolean;
  guildId?: string | null;
  /** права, которые permissionsFor вернёт (null = member не резолвится). */
  channelPerms?: PermissionsBitField | null;
  /** true → член приватного треда (thread.members.fetch резолвится). */
  threadMember?: boolean;
  /** guild.members.fetch кидает (не в гильдии / ошибка Discord) — для fail-closed. */
  guildFetchThrows?: boolean;
};

export function fakeChannel(opts: ChannelOpts = {}): GuildBasedChannel {
  const {
    id = 'c1',
    type = ChannelType.GuildText,
    textBased = true,
    dmBased = false,
    guildId = 'g1',
    channelPerms = perms(VIEW, READ_HISTORY),
    threadMember = false,
    guildFetchThrows = false,
  } = opts;

  return {
    id,
    type,
    guildId,
    isTextBased: () => textBased,
    isDMBased: () => dmBased,
    permissionsFor: () => channelPerms,
    members: {
      fetch: threadMember ? async () => member() : throwFetch,
    },
    guild: {
      members: {
        fetch: guildFetchThrows ? throwFetch : async () => member(),
      },
    },
  } as unknown as GuildBasedChannel;
}

type ClientOpts = {
  /** channelId → канал в кэше. */
  cache?: Record<string, GuildBasedChannel>;
  /** channelId → канал, доступный только через fetch (не в кэше). */
  fetchable?: Record<string, GuildBasedChannel>;
  /** guildId → гильдия для guilds.cache (isMemberOfAnyServedGuild / visibleChannelsForUser). */
  guilds?: Record<string, unknown>;
  /** мок client.rest (для search — queueRequest, отдающий { status, json }). */
  rest?: unknown;
};

export function fakeClient(opts: ClientOpts = {}): Client {
  const { cache = {}, fetchable = {}, guilds = {}, rest } = opts;
  return {
    channels: {
      cache: new Map(Object.entries(cache)),
      fetch: async (id: string) => fetchable[id] ?? null,
    },
    guilds: {
      cache: new Map(Object.entries(guilds)),
    },
    rest,
  } as unknown as Client;
}

// Мок ответа client.rest.queueRequest: ResponseLike с нужными status/json.
export function restResponse(status: number, body: unknown): { status: number; json: () => Promise<unknown> } {
  return { status, json: async () => body };
}

type GuildOpts = {
  id?: string;
  /** член ли «наш» пользователь этой гильдии (guild.members.fetch резолвится). */
  hasMember?: boolean;
  /** каналы гильдии для visibleChannelsFor (итерируются через member.guild.channels.cache). */
  channels?: GuildBasedChannel[];
};

// visibleChannelsFor читает member.guild.channels.cache — потому fetched-member
// указывает обратно на гильдию с этими каналами.
export function fakeGuild(opts: GuildOpts = {}): unknown {
  const { id = 'g1', hasMember = true, channels = [] } = opts;
  const channelsCache = new Map(channels.map((c, i) => [String(i), c]));
  const guildRef = { id, channels: { cache: channelsCache } };
  const m = { id: 'u1', guild: guildRef } as unknown as GuildMember;
  return {
    id,
    channels: { cache: channelsCache },
    members: {
      fetch: hasMember ? async () => m : throwFetch,
    },
  };
}
