import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { search, SearchIndexNotReadyError, SearchPaginationError } from '../src/discord/search.js';
import { fakeChannel, fakeClient, fakeGuild, restResponse } from './helpers.js';

// Покрывает НАШУ прослойку над Discord Search API: скоупинг по видимым каналам, детект 202,
// дожатие authorId, чанкинг >100 каналов. Сам HTTP-запрос замокан через client.rest.queueRequest.

const TS = '2024-01-01T00:00:00.000Z';

// Один hit-группа в формате raw Search API (messages: RawMessage[][], матч помечен hit:true).
function rawBody(hits: Record<string, unknown>[], total = hits.length) {
  return { total_results: total, messages: hits.map((h) => [{ hit: true, ...h }]) };
}

function clientWith(channels: ReturnType<typeof fakeChannel>[], queueRequest: unknown) {
  return fakeClient({ guilds: { g1: fakeGuild({ id: 'g1', channels }) }, rest: { queueRequest } });
}

describe('search — скоупинг и формат', () => {
  it('single-guild passthrough: hit форматируется, url строится, attachment.name', async () => {
    const client = clientWith([fakeChannel({ id: 'c1' })], async () =>
      restResponse(
        200,
        rawBody([
          {
            id: 'm1',
            channel_id: 'c1',
            timestamp: TS,
            author: { id: 'u2', username: 'bob' },
            attachments: [{ id: 'a1', filename: 'f.png', content_type: 'image/png', size: 10, url: 'http://cdn/x' }],
          },
        ]),
      ),
    );
    const res = await search(client, 'u1', { limit: 25 });
    assert.equal(res.totalResults, 1);
    assert.equal(res.messages.length, 1);
    assert.equal(res.messages[0].url, 'https://discord.com/channels/g1/c1/m1');
    assert.equal(res.messages[0].attachments[0].name, 'f.png');
    assert.equal(res.messages[0].author.id, 'u2');
  });

  it('channelId вне видимых → пусто, fail-closed (rest не дёргается)', async () => {
    let called = false;
    const client = clientWith([fakeChannel({ id: 'c1' })], async () => {
      called = true;
      return restResponse(200, rawBody([]));
    });
    const res = await search(client, 'u1', { limit: 25, channelId: 'cNope' });
    assert.equal(res.totalResults, 0);
    assert.equal(res.messages.length, 0);
    assert.equal(called, false);
  });

  it('HTTP 202 (индекс не готов) → SearchIndexNotReadyError', async () => {
    const client = clientWith([fakeChannel({ id: 'c1' })], async () => restResponse(202, {}));
    await assert.rejects(() => search(client, 'u1', { limit: 25 }), SearchIndexNotReadyError);
  });

  it('authorId дожимается строго: чужой автор в индексе отбрасывается', async () => {
    const client = clientWith([fakeChannel({ id: 'c1' })], async () =>
      restResponse(200, rawBody([{ id: 'm1', channel_id: 'c1', timestamp: TS, author: { id: 'uWebhook' } }])),
    );
    const res = await search(client, 'u1', { limit: 25, authorId: 'u2' });
    assert.equal(res.messages.length, 0); // guard отсёк
    assert.equal(res.totalResults, 1); // счётчик Discord оставляем как есть
  });

  it('hit из недоступного канала → отфильтрован, содержимое не раскрывается (fail-closed)', async () => {
    const secret = 'TOP SECRET leaked content';
    // Видимый набор = [c1]; Discord подмешал хит из cEvil (не виден, canUserView вернёт false).
    const client = clientWith([fakeChannel({ id: 'c1' })], async () =>
      restResponse(
        200,
        rawBody([
          { id: 'm1', channel_id: 'c1', content: 'ok', timestamp: TS, author: { id: 'u2' } },
          { id: 'm2', channel_id: 'cEvil', content: secret, timestamp: TS, author: { id: 'u2' } },
        ]),
      ),
    );
    const res = await search(client, 'u1', { limit: 25 });
    assert.equal(res.messages.length, 1); // недоступный дропнут
    assert.equal(res.messages[0].channelId, 'c1');
    assert.ok(!JSON.stringify(res).includes(secret)); // содержимое не утекло
  });

  it('hit из видимого канала вне переданного набора (тред под родителем) → остаётся', async () => {
    // Discord Search по родителю возвращает и сообщения тредов: channelId=tX не в наборе, но
    // canUserView(tX)=true (тред виден) → хит остаётся.
    const client = fakeClient({
      guilds: { g1: fakeGuild({ id: 'g1', channels: [fakeChannel({ id: 'c1' })] }) },
      fetchable: { tX: fakeChannel({ id: 'tX' }) },
      rest: {
        queueRequest: async () =>
          restResponse(200, rawBody([{ id: 'm1', channel_id: 'tX', timestamp: TS, author: { id: 'u2' } }])),
      },
    });
    const res = await search(client, 'u1', { limit: 25 });
    assert.equal(res.messages.length, 1);
    assert.equal(res.messages[0].channelId, 'tX');
  });

  it('чанкинг >100 каналов: два запроса (100+50), результаты мёржатся, total суммируется', async () => {
    const channels = Array.from({ length: 150 }, (_, i) => fakeChannel({ id: `c${i}` }));
    const seenCounts: number[] = [];
    let n = 0;
    const client = clientWith(channels, async (req: { query: URLSearchParams }) => {
      const ids = req.query.getAll('channel_id');
      seenCounts.push(ids.length);
      n += 1;
      // hit из канала, реально запрошенного в этом чанке — иначе сработает scope-check.
      return restResponse(200, rawBody([{ id: `m${n}`, channel_id: ids[0], timestamp: `2024-01-0${n}T00:00:00.000Z`, author: { id: 'u2' } }], 10));
    });
    const res = await search(client, 'u1', { limit: 25 });
    assert.equal(seenCounts.length, 2);
    assert.deepEqual([...seenCounts].sort((a, b) => a - b), [50, 100]);
    assert.equal(res.totalResults, 20); // 10 + 10
    assert.equal(res.messages.length, 2);
  });

  it('offset>0 при чанкинге (>100 каналов, много запросов) → SearchPaginationError', async () => {
    const channels = Array.from({ length: 150 }, (_, i) => fakeChannel({ id: `c${i}` }));
    const client = clientWith(channels, async () => restResponse(200, rawBody([])));
    await assert.rejects(
      () => search(client, 'u1', { limit: 25, offset: 25 }),
      SearchPaginationError,
    );
  });

  it('offset>0 при единственном запросе (один чанк) → работает', async () => {
    const client = clientWith([fakeChannel({ id: 'c1' })], async () =>
      restResponse(200, rawBody([{ id: 'm1', channel_id: 'c1', timestamp: TS, author: { id: 'u2' } }])),
    );
    const res = await search(client, 'u1', { limit: 25, offset: 25 });
    assert.equal(res.messages.length, 1);
  });
});
