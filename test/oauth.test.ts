import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Response } from 'express';
import { DiscordFederatedProvider } from '../src/auth/oauth.js';
import { openDb } from '../src/db/db.js';
import * as store from '../src/db/oauth.repo.js';
import { config, fakeClient, fakeGuild } from './helpers.js';

const CLIENT = { client_id: 'c1' } as OAuthClientInformationFull;
const future = () => Date.now() + 1_000_000;
const past = () => Date.now() - 1_000;

// isMember — состоит ли вызвавший в единственной гильдии бота.
function newProvider(isMember = true) {
  const cfg = config();
  const discord = fakeClient({ guilds: { g1: fakeGuild({ id: 'g1', hasMember: isMember }) } });
  const db = openDb(cfg);
  return { provider: new DiscordFederatedProvider(cfg, discord, db), db };
}

describe('токены хранятся хэшом (SHA-256), не в открытом виде', () => {
  it('oauth_tokens.token = SHA-256(raw), lookup по raw работает', () => {
    const { db } = newProvider();
    const raw = 'super-secret-access';
    store.saveToken(db, raw, { discordUserId: 'u1', clientId: 'c1', scopes: [], expiresAt: future() });
    const row = db.prepare('SELECT token_hash FROM oauth_tokens').get() as { token_hash: string };
    assert.equal(row.token_hash, createHash('sha256').update(raw).digest('base64url'));
    assert.notEqual(row.token_hash, raw);
    assert.ok(store.getToken(db, raw));
    db.close();
  });

  it('oauth_refresh.token = SHA-256(raw)', () => {
    const { db } = newProvider();
    const raw = 'super-secret-refresh';
    store.saveRefresh(db, raw, { discordUserId: 'u1', clientId: 'c1', scopes: [], expiresAt: future() });
    const row = db.prepare('SELECT token_hash FROM oauth_refresh').get() as { token_hash: string };
    assert.equal(row.token_hash, createHash('sha256').update(raw).digest('base64url'));
    assert.notEqual(row.token_hash, raw);
    db.close();
  });

  it('verifyAccessToken: lookup по raw через хэш работает end-to-end', async () => {
    const { provider, db } = newProvider(true);
    store.saveToken(db, 'acc-raw', {
      discordUserId: 'u1',
      clientId: 'c1',
      scopes: ['identify'],
      expiresAt: future(),
    });
    const info = await provider.verifyAccessToken('acc-raw');
    assert.equal(info.extra?.discordUserId, 'u1');
    db.close();
  });
});

describe('exchangeRefreshToken — rotation + TTL + гейт членства', () => {
  it('rotation: старый refresh инвалидируется, выдаётся новый', async () => {
    const { provider, db } = newProvider(true);
    store.saveRefresh(db, 'old-refresh', { discordUserId: 'u1', clientId: 'c1', scopes: [], expiresAt: future() });
    const toks = await provider.exchangeRefreshToken(CLIENT, 'old-refresh');
    assert.ok(toks.refresh_token && toks.refresh_token !== 'old-refresh');
    assert.equal(store.getRefresh(db, 'old-refresh'), undefined); // одноразовый
    assert.ok(store.getRefresh(db, toks.refresh_token as string)); // новый персистнут
    db.close();
  });

  it('несуществующий refresh → InvalidGrantError (400 invalid_grant)', async () => {
    const { provider, db } = newProvider(true);
    await assert.rejects(() => provider.exchangeRefreshToken(CLIENT, 'nope'), InvalidGrantError);
    db.close();
  });

  it('чужой client_id → InvalidGrantError', async () => {
    const { provider, db } = newProvider(true);
    store.saveRefresh(db, 'r', { discordUserId: 'u1', clientId: 'other', scopes: [], expiresAt: future() });
    await assert.rejects(() => provider.exchangeRefreshToken(CLIENT, 'r'), InvalidGrantError);
    db.close();
  });

  it('протухший refresh → InvalidGrantError', async () => {
    const { provider, db } = newProvider(true);
    store.saveRefresh(db, 'r', { discordUserId: 'u1', clientId: 'c1', scopes: [], expiresAt: past() });
    await assert.rejects(() => provider.exchangeRefreshToken(CLIENT, 'r'), InvalidGrantError);
    db.close();
  });

  it('вышедший из всех гильдий → InvalidGrantError + отзыв всех токенов юзера', async () => {
    const { provider, db } = newProvider(false); // не член
    store.saveRefresh(db, 'r', { discordUserId: 'u1', clientId: 'c1', scopes: [], expiresAt: future() });
    store.saveToken(db, 'acc', { discordUserId: 'u1', clientId: 'c1', scopes: [], expiresAt: future() });
    await assert.rejects(() => provider.exchangeRefreshToken(CLIENT, 'r'), InvalidGrantError);
    assert.equal(store.getToken(db, 'acc'), undefined); // access отозван
    assert.equal(store.getRefresh(db, 'r'), undefined); // refresh отозван
    db.close();
  });
});

describe('in-memory лимиты и чистка', () => {
  it('pending cap: старейший state вытесняется при переполнении', async () => {
    const { provider, db } = newProvider(true);
    const states: string[] = [];
    const res = {
      redirect: (u: string) => {
        states.push(new URL(u).searchParams.get('state') as string);
      },
    } as unknown as Response;
    const params = { codeChallenge: 'x', redirectUri: 'https://client.test/cb', state: 'cs' } as AuthorizationParams;
    for (let i = 0; i < 1001; i++) {
      await provider.authorize(CLIENT, params, res); // MAX_PENDING=1000 → 1001-й вытесняет первый
    }
    await assert.rejects(() => provider.handleDiscordCallback('code', states[0]), /unknown state/);
    db.close();
  });

  it('pruneExpired чистит протухшие токены/refresh из БД, живые оставляет', () => {
    const { provider, db } = newProvider(true);
    store.saveToken(db, 'expired', { discordUserId: 'u1', clientId: 'c1', scopes: [], expiresAt: past() });
    store.saveToken(db, 'live', { discordUserId: 'u1', clientId: 'c1', scopes: [], expiresAt: future() });
    store.saveRefresh(db, 'expired-ref', { discordUserId: 'u1', clientId: 'c1', scopes: [], expiresAt: past() });
    provider.pruneExpired();
    assert.equal(store.getToken(db, 'expired'), undefined);
    assert.ok(store.getToken(db, 'live'));
    assert.equal(store.getRefresh(db, 'expired-ref'), undefined);
    db.close();
  });
});
