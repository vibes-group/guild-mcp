import {
  ChannelType,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  PermissionFlagsBits,
} from 'discord.js';

// Единый источник правды — permissionsFor (base + роли + channel overwrites,
// вкл. персональные member-overwrites). Ноль ручного маппинга «роль→канал».

// Вправе ли member видеть канал: View Channel + Read Message History.
export function canView(channel: GuildBasedChannel, member: GuildMember): boolean {
  const perms = channel.permissionsFor(member);
  if (perms === null) return false; // member не резолвится в этой гильдии
  return perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
}

// Приватный тред виден только добавленному в него ИЛИ носителю Manage Threads. permissionsFor
// этого НЕ учитывает (берёт права родителя) — потому проверяем членство/право отдельно. Для не-
// приватных каналов и публичных тредов гейт прозрачен (видимость наследуется от родителя).
async function passesThreadGate(channel: GuildBasedChannel, member: GuildMember): Promise<boolean> {
  if (channel.type !== ChannelType.PrivateThread) return true;
  if (channel.permissionsFor(member)?.has(PermissionFlagsBits.ManageThreads)) return true;
  try {
    await channel.members.fetch(member.id);
    return true;
  } catch {
    return false; // не член приватного треда
  }
}

// Текстовые каналы гильдии, которые вправе видеть данный member.
// Только text-based (там живут сообщения); категории/голос-без-текста отсекаются.
async function visibleChannelsFor(member: GuildMember): Promise<GuildBasedChannel[]> {
  const out: GuildBasedChannel[] = [];
  for (const ch of member.guild.channels.cache.values()) {
    if (ch.isTextBased() && canView(ch, member) && (await passesThreadGate(ch, member))) {
      out.push(ch);
    }
  }
  return out;
}

// Гильдии, которые обслуживаем: все, где есть бот. Бот приватный — добавить его может только
// владелец приложения, поэтому отдельный allowlist не нужен.
function botGuilds(client: Client): Guild[] {
  return [...client.guilds.cache.values()];
}

// Точечная проверка доступа к одному каналу (для read_messages) — без обхода всех гильдий.
export async function canUserView(client: Client, userId: string, channelId: string): Promise<boolean> {
  const channel =
    client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return false;
  try {
    const member = await channel.guild.members.fetch(userId);
    return canView(channel, member) && (await passesThreadGate(channel, member));
  } catch {
    return false; // fail-closed: не в гильдии ИЛИ ошибка Discord — доступ не выдаём
  }
}

// Видит ли пользователь канал (только ViewChannel, без ReadMessageHistory) — для метаданных
// канала/тредов, где важен сам факт видимости, а не чтение истории. Работает и для тредов
// (permissionsFor учитывает overwrites родителя).
export async function canUserViewChannel(client: Client, userId: string, channelId: string): Promise<boolean> {
  const channel =
    client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId).catch(() => null));
  if (!channel || channel.isDMBased() || !('guild' in channel)) return false;
  try {
    const member = await channel.guild.members.fetch(userId);
    const canSee = channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) ?? false;
    return canSee && (await passesThreadGate(channel, member));
  } catch {
    return false; // fail-closed: не в гильдии ИЛИ ошибка Discord — доступ не выдаём
  }
}

// Состоит ли пользователь хотя бы в одной гильдии бота.
// Гейт авторизации: чужак, не деляший ни одного сервера с ботом, не должен получить токен.
export async function isMemberOfAnyServedGuild(client: Client, userId: string): Promise<boolean> {
  for (const guild of botGuilds(client)) {
    try {
      await guild.members.fetch(userId);
      return true;
    } catch {
      // не member этой гильдии — проверяем следующую
    }
  }
  return false;
}

// Гильдии бота, где вызвавший состоит (опц. сужение до одной по guildId).
// Пересечение «гильдии бота ∩ гильдии пользователя» — область для резолва участников.
export async function callerGuilds(client: Client, userId: string, guildId?: string): Promise<Guild[]> {
  const out: Guild[] = [];
  for (const guild of botGuilds(client)) {
    if (guildId && guild.id !== guildId) continue;
    try {
      await guild.members.fetch(userId);
      out.push(guild);
    } catch {
      continue; // пользователь не в этой гильдии — пропускаем
    }
  }
  return out;
}

// Все видимые вызвавшему каналы через ВСЕ гильдии бота, где он состоит.
// Пересечение «гильдии бота ∩ гильдии пользователя»; роли считаются per-guild.
export async function visibleChannelsForUser(client: Client, userId: string): Promise<GuildBasedChannel[]> {
  const out: GuildBasedChannel[] = [];
  for (const guild of botGuilds(client)) {
    let member: GuildMember;
    try {
      member = await guild.members.fetch(userId);
    } catch {
      continue; // пользователь не в этой гильдии — пропускаем
    }
    out.push(...(await visibleChannelsFor(member)));
  }
  return out;
}
