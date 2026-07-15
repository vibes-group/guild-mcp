import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GuildBasedChannel, Message } from 'discord.js';
import { fetchMessage, fetchMessages, fetchPinned, MessageAccessError } from '../src/discord/messages.js';
import { fakeChannel, fakeClient, perms, READ_HISTORY, VIEW } from './helpers.js';

// Централизованный гейт чтения (messages.ts): ВСЕ message-тулы (get_message/get_messages/
// get_pinned/get_attachment) ходят через него, поэтому «нет прав → бросок» здесь покрывает
// отказ недоступного канала для каждого из них разом.

const msg = (id = 'm1') => ({ id, inGuild: () => true }) as unknown as Message<true>;

// Канал с моком чтения сообщений поверх fakeChannel (права/резолв гильдии — из fakeChannel).
function channel(channelPerms = perms(VIEW, READ_HISTORY)): GuildBasedChannel {
  const one = msg();
  const coll = new Map([[one.id, one]]);
  return {
    ...fakeChannel({ channelPerms }),
    messages: {
      fetch: async (arg: unknown) => (typeof arg === 'string' ? one : coll),
      fetchPinned: async () => coll,
    },
  } as unknown as GuildBasedChannel;
}

const clientWith = (ch: GuildBasedChannel) => fakeClient({ fetchable: { c1: ch } });

describe('messages service — гейт доступа', () => {
  it('fetchMessage: есть права → возвращает сообщение', async () => {
    const res = await fetchMessage(clientWith(channel()), 'u1', 'c1', 'm1');
    assert.equal(res.id, 'm1');
  });
  it('fetchMessage: нет ReadMessageHistory → MessageAccessError (fail-closed)', async () => {
    await assert.rejects(
      () => fetchMessage(clientWith(channel(perms(VIEW))), 'u1', 'c1', 'm1'),
      MessageAccessError,
    );
  });

  it('fetchMessages: есть права → список', async () => {
    const res = await fetchMessages(clientWith(channel()), 'u1', 'c1', { limit: 50 });
    assert.equal(res.length, 1);
  });
  it('fetchMessages: недоступный канал → MessageAccessError', async () => {
    await assert.rejects(
      () => fetchMessages(clientWith(channel(perms(VIEW))), 'u1', 'c1', { limit: 50 }),
      MessageAccessError,
    );
  });

  it('fetchPinned: недоступный канал → MessageAccessError', async () => {
    await assert.rejects(
      () => fetchPinned(clientWith(channel(perms(VIEW))), 'u1', 'c1'),
      MessageAccessError,
    );
  });

  it('канал не резолвится (fetch=null) → MessageAccessError', async () => {
    await assert.rejects(() => fetchMessage(fakeClient(), 'u1', 'missing', 'm1'), MessageAccessError);
  });
});
