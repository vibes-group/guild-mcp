import { RequestMethod } from '@discordjs/rest';
import { type Client, type GuildBasedChannel, MessageType } from 'discord.js';
import { canUserView, visibleChannelsForUser } from './permissions.js';

// Поиск — прослойка 1:1 к официальному Discord Search API
// (GET /guilds/{id}/messages/search). Параметры/ответ повторяют API.
// Endpoint работает от лица бота и НЕ учитывает права вызвавшего — поэтому область
// поиска ограничиваем сами: в channel_id передаём только видимые вызвавшему каналы.

const MAX_CHANNELS = 100; // максимум channel_id-фильтров на запрос (200 → 400)

// База для ожидаемых ошибок поиска: тул мапит любую в errorResult с её message.
export class SearchError extends Error {}

// Индекс поиска гильдии ещё не построен: endpoint отвечает 202, а не пустой выдачей.
// Пробрасываем наверх, чтобы тул сказал агенту «повтори через пару секунд», а не «ничего нет».
export class SearchIndexNotReadyError extends SearchError {}

// offset применяется Discord к КАЖДОМУ HTTP-запросу отдельно. Когда область поиска рвётся на
// несколько запросов (мульти-guild или >100 каналов → чанки), общий offset поехал бы. Пускаем
// offset только при единственном запросе; иначе — явная ошибка вместо тихо неверной страницы.
export class SearchPaginationError extends SearchError {}

export type HasFilter = 'link' | 'embed' | 'file' | 'image' | 'video' | 'sound' | 'sticker';

export interface SearchParams {
  content?: string;
  channelId?: string; // ограничить одним каналом
  authorId?: string;
  mentions?: string;
  has?: HasFilter[];
  pinned?: boolean;
  minId?: string; // snowflake — сообщения новее
  maxId?: string; // snowflake — сообщения старше
  sortBy?: 'relevance' | 'timestamp';
  sortOrder?: 'asc' | 'desc';
  offset?: number;
  limit: number; // ≤ 25 (потолок страницы Discord)
}

export interface SearchHit {
  id: string;
  channelId: string;
  guildId: string;
  url: string;
  author: {
    id: string | null;
    username: string | null;
    globalName: string | null;
    bot: boolean;
    webhookId: string | null;
  };
  content: string;
  createdAt: string;
  editedAt: string | null;
  pinned: boolean;
  type: string; // имя enum MessageType
  attachments: {
    id: string;
    name: string;
    contentType: string | null;
    size: number | null;
    url: string;
  }[];
  embeds: number; // счётчик; полную карточку разворачивает get_message
}

export interface SearchResult {
  totalResults: number;
  messages: SearchHit[];
}

// raw message из HTTP Search API (snake_case, не структура discord.js).
interface RawMessage {
  id: string;
  channel_id: string;
  content?: string;
  timestamp: string;
  edited_timestamp?: string | null;
  type?: number;
  pinned?: boolean;
  webhook_id?: string;
  author?: { id: string; username: string; global_name?: string | null; bot?: boolean };
  attachments?: { id: string; filename?: string; content_type?: string | null; size?: number; url: string }[];
  embeds?: unknown[];
  hit?: boolean;
}

interface RawSearchResponse {
  messages?: RawMessage[][]; // группы контекста; матч помечен hit:true
  total_results?: number;
}

function formatHit(m: RawMessage, guildId: string): SearchHit {
  return {
    id: m.id,
    channelId: m.channel_id,
    guildId,
    url: `https://discord.com/channels/${guildId}/${m.channel_id}/${m.id}`,
    author: {
      id: m.author?.id ?? null,
      username: m.author?.username ?? null,
      globalName: m.author?.global_name ?? null,
      bot: m.author?.bot ?? false,
      webhookId: m.webhook_id ?? null,
    },
    content: m.content ?? '',
    createdAt: m.timestamp,
    editedAt: m.edited_timestamp ?? null,
    pinned: m.pinned ?? false,
    type: m.type !== undefined ? (MessageType[m.type] ?? String(m.type)) : 'Unknown',
    attachments: (m.attachments ?? []).map((a) => ({
      id: a.id,
      name: a.filename ?? '',
      contentType: a.content_type ?? null,
      size: a.size ?? null,
      url: a.url,
    })),
    embeds: m.embeds?.length ?? 0,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function buildQuery(params: SearchParams, channelIds: string[]): URLSearchParams {
  const qs = new URLSearchParams();
  if (params.content) qs.set('content', params.content);
  if (params.authorId) qs.set('author_id', params.authorId);
  if (params.mentions) qs.set('mentions', params.mentions);
  for (const h of params.has ?? []) qs.append('has', h);
  if (params.pinned !== undefined) qs.set('pinned', String(params.pinned));
  if (params.minId) qs.set('min_id', params.minId);
  if (params.maxId) qs.set('max_id', params.maxId);
  qs.set('sort_by', params.sortBy ?? 'relevance');
  qs.set('sort_order', params.sortOrder ?? 'desc');
  qs.set('limit', String(params.limit));
  qs.set('offset', String(params.offset ?? 0));
  for (const id of channelIds) qs.append('channel_id', id);
  return qs;
}

// author_id в индексе Discord подмешивает сообщения webhook/bot автора — поэтому authorId
// дожимаем строго: обещание «только этот автор» должно держаться точно.
function passesGuard(hit: SearchHit, params: SearchParams): boolean {
  if (params.authorId !== undefined && hit.author.id !== params.authorId) return false;
  return true;
}

// Один HTTP-запрос поиска по фиксированному набору channelIds (≤ MAX_CHANNELS).
async function searchChunk(
  client: Client,
  guildId: string,
  channelIds: string[],
  params: SearchParams,
): Promise<SearchResult> {
  const qs = buildQuery(params, channelIds);
  // discord.js REST manager сам держит rate-limit-бакеты и honor'ит retry_after. queueRequest
  // (в отличие от .get) отдаёт сырой ответ со status: нужно отличить 202 «индекс не готов»
  // от 200 с пустой выдачей — иначе прогрев индекса выглядел бы как «ничего не найдено».
  const res = await client.rest.queueRequest({
    fullRoute: `/guilds/${guildId}/messages/search`,
    method: RequestMethod.Get,
    query: qs,
  });
  if (res.status === 202) {
    throw new SearchIndexNotReadyError(
      "This server's search index is still warming up — retry in a few seconds.",
    );
  }
  const body = (await res.json()) as RawSearchResponse;
  const hits: SearchHit[] = [];
  for (const group of body.messages ?? []) {
    const m = group.find((x) => x.hit) ?? group[0];
    if (!m) continue;
    const hit = formatHit(m, guildId);
    if (passesGuard(hit, params)) hits.push(hit);
  }
  return { totalResults: body.total_results ?? 0, messages: hits };
}

// Поиск в одной guild: чанкует channel_id (если их > MAX_CHANNELS) и мёржит результаты чанков.
async function searchGuild(
  client: Client,
  guildId: string,
  channelIds: string[],
  params: SearchParams,
): Promise<SearchResult> {
  const chunks = chunk(channelIds, MAX_CHANNELS);
  if (chunks.length === 1) return searchChunk(client, guildId, chunks[0], params);

  const seen = new Set<string>();
  const messages: SearchHit[] = [];
  let totalResults = 0;
  for (const set of chunks) {
    const res = await searchChunk(client, guildId, set, params);
    totalResults += res.totalResults; // наборы каналов не пересекаются
    for (const hit of res.messages) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      messages.push(hit);
    }
  }
  return { totalResults, messages };
}

// Видимые вызвавшему каналы, сгруппированные по guild.
function groupByGuild(channels: GuildBasedChannel[]): Map<string, string[]> {
  const byGuild = new Map<string, string[]>();
  for (const c of channels) {
    const list = byGuild.get(c.guildId) ?? [];
    list.push(c.id);
    byGuild.set(c.guildId, list);
  }
  return byGuild;
}

// search_messages backend: ищет по каждой обслуживаемой guild, где состоит вызвавший,
// ограничивая область его видимыми каналами. Мёржит результаты нескольких guild.
// В single-guild (типовой случай) — чистый passthrough порядка Discord; при мульти-guild
// общий порядок по времени (relevance между guild несравним), totalResults суммируется.
export async function search(client: Client, userId: string, params: SearchParams): Promise<SearchResult> {
  const visible = await visibleChannelsForUser(client, userId);
  const byGuild = groupByGuild(visible);

  // Пост-фильтр области. Discord Search по channel_id родителя возвращает и сообщения из тредов
  // внутри него — у такого hit channelId = id треда, не родителя, и это нормально. Поэтому
  // проверяем не «hit из переданного набора», а реальную видимость канала хита вызвавшим: id уже
  // в видимом наборе ЛИБО проходит canUserView (резолвит активные/архивные/приватные треды).
  // Иначе дропаем — fail-closed: бот мог увидеть больше, чем вправе видеть вызвавший.
  const visibleIds = new Set(visible.map((c) => c.id));
  const viewCache = new Map<string, Promise<boolean>>();
  const canSee = (channelId: string): Promise<boolean> => {
    if (visibleIds.has(channelId)) return Promise.resolve(true);
    let p = viewCache.get(channelId);
    if (!p) {
      p = canUserView(client, userId, channelId);
      viewCache.set(channelId, p);
    }
    return p;
  };
  const scoped = async (hits: SearchHit[]): Promise<SearchHit[]> => {
    const out: SearchHit[] = [];
    for (const h of hits) if (await canSee(h.channelId)) out.push(h);
    return out;
  };

  // Ограничение одним каналом: оставляем только его guild и только его id.
  if (params.channelId) {
    const owner = visible.find((c) => c.id === params.channelId);
    if (!owner) return { totalResults: 0, messages: [] }; // канал не виден — fail closed
    byGuild.clear();
    byGuild.set(owner.guildId, [params.channelId]);
  }

  if (byGuild.size === 0) return { totalResults: 0, messages: [] };

  // offset достоверен лишь при одном HTTP-запросе (одна guild, один чанк ≤ MAX_CHANNELS).
  const totalRequests = [...byGuild.values()].reduce(
    (n, ids) => n + Math.ceil(ids.length / MAX_CHANNELS),
    0,
  );
  if ((params.offset ?? 0) > 0 && totalRequests > 1) {
    throw new SearchPaginationError(
      'offset pagination is unavailable when your visible scope spans multiple servers or more ' +
        'than 100 channels — restrict with channelId, or omit offset.',
    );
  }

  if (byGuild.size === 1) {
    const [[guildId, channelIds]] = [...byGuild];
    const res = await searchGuild(client, guildId, channelIds, params);
    return { totalResults: res.totalResults, messages: (await scoped(res.messages)).slice(0, params.limit) };
  }

  let totalResults = 0;
  const merged: SearchHit[] = [];
  for (const [guildId, channelIds] of byGuild) {
    const res = await searchGuild(client, guildId, channelIds, params);
    totalResults += res.totalResults;
    merged.push(...res.messages);
  }
  merged.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { totalResults, messages: (await scoped(merged)).slice(0, params.limit) };
}
