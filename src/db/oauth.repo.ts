import { createHash } from 'node:crypto';
import type { Statement } from 'better-sqlite3';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { DB } from './db.js';

// Токены НЕ хранятся в открытом виде: в БД лежит SHA-256(token). Bearer-токены —
// 256-бит random, потому простого хэша без соли достаточно (прообраз не восстановить).
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url');
}

// Персист OAuth-состояния, чтобы рестарт не разлогинивал.
export interface StoredToken {
  discordUserId: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface StoredRefresh {
  discordUserId: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

interface Stmts {
  saveClient: Statement;
  getClient: Statement;
  saveToken: Statement;
  getToken: Statement;
  delToken: Statement;
  saveRefresh: Statement;
  getRefresh: Statement;
  delRefresh: Statement;
  delUserTokens: Statement;
  delUserRefresh: Statement;
  delExpiredTokens: Statement;
  delExpiredRefresh: Statement;
}

const cache = new WeakMap<DB, Stmts>();

function stmts(db: DB): Stmts {
  let s = cache.get(db);
  if (!s) {
    s = {
      saveClient: db.prepare(`INSERT OR REPLACE INTO oauth_clients (client_id, data) VALUES (?, ?)`),
      getClient: db.prepare(`SELECT data FROM oauth_clients WHERE client_id = ?`),
      saveToken: db.prepare(`
        INSERT OR REPLACE INTO oauth_tokens (token_hash, discord_user_id, client_id, scopes, expires_at, resource)
        VALUES (@token_hash, @discord_user_id, @client_id, @scopes, @expires_at, @resource)`),
      getToken: db.prepare(`SELECT * FROM oauth_tokens WHERE token_hash = ?`),
      delToken: db.prepare(`DELETE FROM oauth_tokens WHERE token_hash = ?`),
      saveRefresh: db.prepare(`
        INSERT OR REPLACE INTO oauth_refresh (token_hash, discord_user_id, client_id, scopes, expires_at)
        VALUES (@token_hash, @discord_user_id, @client_id, @scopes, @expires_at)`),
      getRefresh: db.prepare(`SELECT * FROM oauth_refresh WHERE token_hash = ?`),
      delRefresh: db.prepare(`DELETE FROM oauth_refresh WHERE token_hash = ?`),
      delUserTokens: db.prepare(`DELETE FROM oauth_tokens WHERE discord_user_id = ?`),
      delUserRefresh: db.prepare(`DELETE FROM oauth_refresh WHERE discord_user_id = ?`),
      delExpiredTokens: db.prepare(`DELETE FROM oauth_tokens WHERE expires_at < ?`),
      delExpiredRefresh: db.prepare(`DELETE FROM oauth_refresh WHERE expires_at < ?`),
    };
    cache.set(db, s);
  }
  return s;
}

export function saveClient(db: DB, client: OAuthClientInformationFull): void {
  stmts(db).saveClient.run(client.client_id, JSON.stringify(client));
}

export function getClient(db: DB, clientId: string): OAuthClientInformationFull | undefined {
  const row = stmts(db).getClient.get(clientId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as OAuthClientInformationFull) : undefined;
}

export function saveToken(db: DB, token: string, t: StoredToken): void {
  stmts(db).saveToken.run({
    token_hash: hashToken(token),
    discord_user_id: t.discordUserId,
    client_id: t.clientId,
    scopes: JSON.stringify(t.scopes),
    expires_at: t.expiresAt,
    resource: t.resource ?? null,
  });
}

export function getToken(db: DB, token: string): StoredToken | undefined {
  const r = stmts(db).getToken.get(hashToken(token)) as
    | { discord_user_id: string; client_id: string; scopes: string; expires_at: number; resource: string | null }
    | undefined;
  if (!r) return undefined;
  return {
    discordUserId: r.discord_user_id,
    clientId: r.client_id,
    scopes: JSON.parse(r.scopes) as string[],
    expiresAt: r.expires_at,
    resource: r.resource ?? undefined,
  };
}

export function deleteToken(db: DB, token: string): void {
  stmts(db).delToken.run(hashToken(token));
}

export function saveRefresh(db: DB, token: string, r: StoredRefresh): void {
  stmts(db).saveRefresh.run({
    token_hash: hashToken(token),
    discord_user_id: r.discordUserId,
    client_id: r.clientId,
    scopes: JSON.stringify(r.scopes),
    expires_at: r.expiresAt,
  });
}

export function getRefresh(db: DB, token: string): StoredRefresh | undefined {
  const r = stmts(db).getRefresh.get(hashToken(token)) as
    | { discord_user_id: string; client_id: string; scopes: string; expires_at: number }
    | undefined;
  if (!r) return undefined;
  return {
    discordUserId: r.discord_user_id,
    clientId: r.client_id,
    scopes: JSON.parse(r.scopes) as string[],
    expiresAt: r.expires_at,
  };
}

export function deleteRefresh(db: DB, token: string): void {
  stmts(db).delRefresh.run(hashToken(token));
}

// Отзыв всех токенов пользователя (разлогин при выходе из гильдий).
export function deleteUserTokens(db: DB, discordUserId: string): void {
  stmts(db).delUserTokens.run(discordUserId);
  stmts(db).delUserRefresh.run(discordUserId);
}

// Чистка протухших записей (вызывается на старте; лениво чистятся при доступе).
export function deleteExpired(db: DB, nowMs: number): void {
  stmts(db).delExpiredTokens.run(nowMs);
  stmts(db).delExpiredRefresh.run(nowMs);
}
