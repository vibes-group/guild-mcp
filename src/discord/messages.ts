import type { Client, GuildTextBasedChannel, Message } from 'discord.js';
import { canUserView } from './permissions.js';

// Access-controlled reader — ЕДИНСТВЕННЫЙ путь чтения содержимого сообщений и вложений.
// Каждая функция принимает проверенный userId вызвавшего и СНАЧАЛА гейтит канал
// (canUserView), и только потом фетчит. Тулы НЕ должны звать channel.messages.* напрямую —
// иначе гейт и фетч могут разъехаться, и новый тул протечёт содержимым мимо проверки прав.

// Вызвавший не вправе читать канал (нет прав ИЛИ канал не читаемый). Тул мапит в errorResult.
export class MessageAccessError extends Error {}

// Общий гейт: канал, который вызвавший вправе читать, либо бросок (fail-closed).
async function viewableChannel(
  client: Client,
  userId: string,
  channelId: string,
): Promise<GuildTextBasedChannel> {
  if (!(await canUserView(client, userId, channelId))) {
    throw new MessageAccessError(`Access denied: you cannot view channel ${channelId}.`);
  }
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    throw new MessageAccessError(`Channel ${channelId} is not a readable text channel.`);
  }
  return channel;
}

// Опции истории — подмножество MessageManager.fetch (before/after/around + limit).
export interface FetchMessagesOptions {
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
}

// Одно сообщение по id (get_message и get_attachment).
export async function fetchMessage(
  client: Client,
  userId: string,
  channelId: string,
  messageId: string,
): Promise<Message<true>> {
  const channel = await viewableChannel(client, userId, channelId);
  const msg = await channel.messages.fetch(messageId);
  if (!msg.inGuild()) throw new MessageAccessError(`Channel ${channelId} is not a readable text channel.`);
  return msg;
}

// История канала/треда (newest first), только guild-сообщения.
export async function fetchMessages(
  client: Client,
  userId: string,
  channelId: string,
  opts: FetchMessagesOptions,
): Promise<Message<true>[]> {
  const channel = await viewableChannel(client, userId, channelId);
  const msgs = await channel.messages.fetch(opts);
  return [...msgs.values()].filter((m): m is Message<true> => m.inGuild());
}

// Закреплённые сообщения канала, только guild-сообщения.
export async function fetchPinned(
  client: Client,
  userId: string,
  channelId: string,
): Promise<Message<true>[]> {
  const channel = await viewableChannel(client, userId, channelId);
  const pinned = await channel.messages.fetchPinned();
  return [...pinned.values()].filter((m): m is Message<true> => m.inGuild());
}
