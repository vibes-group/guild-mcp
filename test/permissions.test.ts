import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType } from 'discord.js';
import {
  canUserView,
  canUserViewChannel,
  canView,
  isMemberOfAnyServedGuild,
  visibleChannelsForUser,
} from '../src/discord/permissions.js';
import {
  fakeChannel,
  fakeClient,
  fakeGuild,
  member,
  perms,
  READ_HISTORY,
  VIEW,
  MANAGE_THREADS,
} from './helpers.js';

// Покрывает НАШУ логику гейтинга. Разрешение overwrites (@everyone/роли/категории)
// считает discord.js и проверяется отдельным ручным live-чеклистом.

describe('canView — ViewChannel + ReadMessageHistory', () => {
  const m = member();
  it('оба права → true', () => {
    assert.equal(canView(fakeChannel({ channelPerms: perms(VIEW, READ_HISTORY) }), m), true);
  });
  it('только ViewChannel → false', () => {
    assert.equal(canView(fakeChannel({ channelPerms: perms(VIEW) }), m), false);
  });
  it('только ReadMessageHistory → false', () => {
    assert.equal(canView(fakeChannel({ channelPerms: perms(READ_HISTORY) }), m), false);
  });
  it('ни одного → false', () => {
    assert.equal(canView(fakeChannel({ channelPerms: perms() }), m), false);
  });
  it('permissionsFor вернул null (member не резолвится) → false', () => {
    assert.equal(canView(fakeChannel({ channelPerms: null }), m), false);
  });
});

describe('canUserView — резолв канала + гейт + fail-closed', () => {
  async function view(channel: ReturnType<typeof fakeChannel>, cid = 'c1') {
    return canUserView(fakeClient({ cache: { [cid]: channel } }), 'u1', cid);
  }

  it('текстовый канал, оба права → true', async () => {
    assert.equal(await view(fakeChannel()), true);
  });
  it('канал не найден (нет в кэше, fetch=null) → false', async () => {
    assert.equal(await canUserView(fakeClient(), 'u1', 'missing'), false);
  });
  it('резолв через fetch (не в кэше) → true', async () => {
    const client = fakeClient({ fetchable: { c1: fakeChannel() } });
    assert.equal(await canUserView(client, 'u1', 'c1'), true);
  });
  it('не text-based канал → false', async () => {
    assert.equal(await view(fakeChannel({ textBased: false })), false);
  });
  it('DM-based канал → false', async () => {
    assert.equal(await view(fakeChannel({ dmBased: true })), false);
  });
  it('members.fetch кинул (не в гильдии / ошибка Discord) → false (fail-closed)', async () => {
    assert.equal(await view(fakeChannel({ guildFetchThrows: true })), false);
  });
  it('только ViewChannel без ReadMessageHistory → false', async () => {
    assert.equal(await view(fakeChannel({ channelPerms: perms(VIEW) })), false);
  });

  describe('приватный тред (passesThreadGate)', () => {
    const priv = (over: Partial<Parameters<typeof fakeChannel>[0]> = {}) =>
      fakeChannel({ type: ChannelType.PrivateThread, ...over });

    it('член треда → true', async () => {
      assert.equal(await view(priv({ threadMember: true })), true);
    });
    it('не член треда, без ManageThreads → false', async () => {
      assert.equal(await view(priv({ threadMember: false })), false);
    });
    it('ManageThreads → true даже без членства в треде', async () => {
      assert.equal(
        await view(priv({ threadMember: false, channelPerms: perms(VIEW, READ_HISTORY, MANAGE_THREADS) })),
        true,
      );
    });
  });
});

describe('canUserViewChannel — только ViewChannel (метаданные)', () => {
  async function viewChan(channel: ReturnType<typeof fakeChannel>) {
    return canUserViewChannel(fakeClient({ cache: { c1: channel } }), 'u1', 'c1');
  }

  it('ViewChannel без ReadMessageHistory → true (ключевое отличие от canUserView)', async () => {
    assert.equal(await viewChan(fakeChannel({ channelPerms: perms(VIEW) })), true);
  });
  it('нет ViewChannel → false', async () => {
    assert.equal(await viewChan(fakeChannel({ channelPerms: perms(READ_HISTORY) })), false);
  });
  it('members.fetch кинул → false (fail-closed)', async () => {
    assert.equal(await viewChan(fakeChannel({ guildFetchThrows: true })), false);
  });
  it('приватный тред, не член → false (thread gate применяется и тут)', async () => {
    const priv = fakeChannel({
      type: ChannelType.PrivateThread,
      threadMember: false,
      channelPerms: perms(VIEW),
    });
    assert.equal(await viewChan(priv), false);
  });
});

describe('isMemberOfAnyServedGuild — гейт авторизации', () => {
  it('член хотя бы одной гильдии бота → true', async () => {
    const client = fakeClient({
      guilds: { g1: fakeGuild({ id: 'g1', hasMember: false }), g2: fakeGuild({ id: 'g2', hasMember: true }) },
    });
    assert.equal(await isMemberOfAnyServedGuild(client, 'u1'), true);
  });
  it('не член ни одной → false', async () => {
    const client = fakeClient({
      guilds: { g1: fakeGuild({ id: 'g1', hasMember: false }) },
    });
    assert.equal(await isMemberOfAnyServedGuild(client, 'u1'), false);
  });
  it('бот в 0 гильдий → false (fail-closed, пустой список)', async () => {
    assert.equal(await isMemberOfAnyServedGuild(fakeClient(), 'u1'), false);
  });
});

describe('visibleChannelsForUser — union видимых каналов', () => {
  const viewable = () => fakeChannel({ channelPerms: perms(VIEW, READ_HISTORY) });

  async function visible(guilds: Record<string, unknown>) {
    return visibleChannelsForUser(fakeClient({ guilds }), 'u1');
  }

  it('возвращает только видимые text-based каналы', async () => {
    const chans = [viewable(), fakeChannel({ channelPerms: perms(VIEW) })]; // второй без ReadHistory
    const out = await visible({ g1: fakeGuild({ channels: chans }) });
    assert.equal(out.length, 1);
  });
  it('исключает не-text каналы (категории/voice-без-текста)', async () => {
    const chans = [viewable(), fakeChannel({ textBased: false })];
    const out = await visible({ g1: fakeGuild({ channels: chans }) });
    assert.equal(out.length, 1);
  });
  it('исключает приватный тред, где вызвавший не член', async () => {
    const priv = fakeChannel({ type: ChannelType.PrivateThread, threadMember: false });
    const out = await visible({ g1: fakeGuild({ channels: [viewable(), priv] }) });
    assert.equal(out.length, 1);
  });
  it('включает приватный тред, где вызвавший — член', async () => {
    const priv = fakeChannel({ type: ChannelType.PrivateThread, threadMember: true });
    const out = await visible({ g1: fakeGuild({ channels: [priv] }) });
    assert.equal(out.length, 1);
  });
  it('мульти-гилд: union по всем гильдиям, где состоит', async () => {
    const out = await visible({
      g1: fakeGuild({ id: 'g1', channels: [viewable()] }),
      g2: fakeGuild({ id: 'g2', channels: [viewable(), viewable()] }),
    });
    assert.equal(out.length, 3);
  });
  it('гильдию, где members.fetch кинул, пропускает (не роняет весь обход)', async () => {
    const out = await visible({
      g1: fakeGuild({ id: 'g1', hasMember: false, channels: [viewable()] }),
      g2: fakeGuild({ id: 'g2', hasMember: true, channels: [viewable()] }),
    });
    assert.equal(out.length, 1);
  });
});
