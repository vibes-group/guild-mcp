import { randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'discord.js';
import type { Application, Response } from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Config } from '../config.js';
import type { DB } from '../db/db.js';
import * as store from '../db/oauth.repo.js';
import { isMemberOfAnyServedGuild } from '../discord/permissions.js';
import { buildAuthorizeUrl, exchangeCodeForUserId } from './discord-idp.js';

// Пользователь прошёл Discord-логин, но не состоит ни в одной гильдии бота → доступ запрещён.
export class AuthorizationDeniedError extends Error {}

// guild-mcp сам является Authorization Server для MCP-клиента (Claude), а вход пользователя
// федерирует в Discord (Discord как login-IdP). SDK даёт эндпоинты/PKCE/DCR; здесь — логика провайдера.
// Клиенты/токены/refresh персистятся в SQLite (переживают рестарт); pending/codes — эфемерны, в памяти.

const TOKEN_TTL_S = 3600;
const REFRESH_TTL_MS = 60 * 24 * 3600_000; // 60 дней
const CODE_TTL_MS = 5 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;
// Cap на in-memory коллекции: при переполнении вытесняем старейшую запись (memory-DoS через /authorize).
const MAX_PENDING = 1000;
const MAX_CODES = 1000;

// Map сохраняет порядок вставки → старейший ключ первый. Держим размер ≤ max.
function evictOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

interface PendingAuth {
  clientId: string;
  codeChallenge: string;
  redirectUri: string; // redirect_uri клиента (валидируется SDK по зарегистрированным)
  clientState?: string;
  resource?: string;
  expiresAt: number;
}

interface AuthCode {
  codeChallenge: string;
  discordUserId: string;
  clientId: string;
  resource?: string;
  expiresAt: number;
}

export class DiscordFederatedProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, PendingAuth>();
  private readonly codes = new Map<string, AuthCode>();

  constructor(
    private readonly config: Config,
    private readonly discord: Client,
    private readonly db: DB,
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => store.getClient(this.db, id),
      registerClient: (client) => {
        // SDK уже сгенерил client_id/secret и передал полный объект — только сохраняем.
        const full = client as OAuthClientInformationFull;
        store.saveClient(this.db, full);
        return full;
      },
    };
  }

  // Начало флоу: запоминаем PKCE-challenge клиента и редиректим пользователя на согласие Discord.
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const state = randomUUID();
    evictOldest(this.pending, MAX_PENDING);
    this.pending.set(state, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      clientState: params.state,
      resource: params.resource?.href,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    res.redirect(buildAuthorizeUrl(this.config, state));
  }

  // Discord-callback (наш эндпоинт): обменять discord code -> user id, минтить наш auth code,
  // вернуть URL редиректа обратно к MCP-клиенту с нашим code + его state.
  async handleDiscordCallback(discordCode: string, state: string): Promise<string> {
    const pend = this.pending.get(state);
    if (!pend) throw new Error('unknown state');
    this.pending.delete(state);
    if (pend.expiresAt < Date.now()) throw new Error('authorization request expired');

    const discordUserId = await exchangeCodeForUserId(this.config, discordCode);

    // Гейт: доступ только тем, кто делит с ботом хотя бы одну гильдию (не чужакам).
    if (!(await isMemberOfAnyServedGuild(this.discord, discordUserId))) {
      throw new AuthorizationDeniedError(
        'You are not a member of any Discord server this bot is in.',
      );
    }

    const code = randomBytes(32).toString('base64url');
    evictOldest(this.codes, MAX_CODES);
    this.codes.set(code, {
      codeChallenge: pend.codeChallenge,
      discordUserId,
      clientId: pend.clientId,
      resource: pend.resource,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const url = new URL(pend.redirectUri);
    url.searchParams.set('code', code);
    if (pend.clientState !== undefined) url.searchParams.set('state', pend.clientState);
    return url.href;
  }

  // SDK локально валидирует PKCE: S256(code_verifier) должен совпасть с этим challenge.
  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const c = this.codes.get(authorizationCode);
    if (!c) throw new Error('invalid authorization code');
    return c.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
    const c = this.codes.get(authorizationCode);
    if (!c || c.clientId !== client.client_id) throw new Error('invalid authorization code');
    this.codes.delete(authorizationCode);
    if (c.expiresAt < Date.now()) throw new Error('authorization code expired');
    return this.issueTokens(c.discordUserId, client.client_id, [], c.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    // InvalidGrantError → SDK отдаёт 400 invalid_grant (клиент переавторизуется);
    // обычный Error SDK мапит в 500 (клиент не перелогинится).
    const r = store.getRefresh(this.db, refreshToken);
    if (!r || r.clientId !== client.client_id) throw new InvalidGrantError('invalid refresh token');
    store.deleteRefresh(this.db, refreshToken); // rotation: старый refresh одноразовый
    if (r.expiresAt < Date.now()) throw new InvalidGrantError('refresh token expired');
    // Членство перепроверяется и на refresh: вышедший из всех гильдий не должен
    // получать свежий access (хоть и инертный на чтении). Провал → разлогин.
    if (!(await isMemberOfAnyServedGuild(this.discord, r.discordUserId))) {
      store.deleteUserTokens(this.db, r.discordUserId);
      throw new InvalidGrantError('access revoked: no longer a member of any served guild');
    }
    return this.issueTokens(r.discordUserId, client.client_id, scopes ?? r.scopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // InvalidTokenError (не обычный Error!) → SDK отдаёт 401, и клиент понимает,
    // что надо переавторизоваться. Обычный Error SDK мапит в 500 (клиент не перелогинится).
    const t = store.getToken(this.db, token);
    if (!t) throw new InvalidTokenError('invalid token');
    if (t.expiresAt < Date.now()) {
      store.deleteToken(this.db, token);
      throw new InvalidTokenError('token expired');
    }
    // Членство перепроверяется на каждый запрос: вышел/исключён из всех гильдий бота
    // → немедленно разлогиниваем (отзываем все его токены) → 401 → переавторизация.
    if (!(await isMemberOfAnyServedGuild(this.discord, t.discordUserId))) {
      store.deleteUserTokens(this.db, t.discordUserId);
      throw new InvalidTokenError('access revoked: no longer a member of any served guild');
    }
    return {
      token,
      clientId: t.clientId,
      scopes: t.scopes,
      expiresAt: Math.floor(t.expiresAt / 1000),
      resource: t.resource ? new URL(t.resource) : undefined,
      extra: { discordUserId: t.discordUserId },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    store.deleteToken(this.db, request.token);
    store.deleteRefresh(this.db, request.token);
  }

  private issueTokens(discordUserId: string, clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const access = randomBytes(32).toString('base64url');
    const refreshTok = randomBytes(32).toString('base64url');
    store.saveToken(this.db, access, {
      discordUserId,
      clientId,
      scopes,
      expiresAt: Date.now() + TOKEN_TTL_S * 1000,
      resource,
    });
    store.saveRefresh(this.db, refreshTok, {
      discordUserId,
      clientId,
      scopes,
      expiresAt: Date.now() + REFRESH_TTL_MS,
    });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_S,
      refresh_token: refreshTok,
      scope: scopes.length > 0 ? scopes.join(' ') : undefined,
    };
  }

  // Чистка протухшего (вызывается однократно на старте). Expired токены/refresh — из БД;
  // expired pending/codes — из in-memory. Лениво они и так отбрасываются при доступе.
  pruneExpired(): void {
    const now = Date.now();
    store.deleteExpired(this.db, now);
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
  }
}

// Монтирует OAuth-эндпойнты SDK (в корень) + наш Discord-callback.
export function mountAuth(app: Application, config: Config, provider: DiscordFederatedProvider): void {
  const issuerUrl = new URL(config.PUBLIC_BASE_URL);
  const resourceServerUrl = new URL('/mcp', config.PUBLIC_BASE_URL);

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      scopesSupported: ['identify'],
      resourceName: 'guild-mcp',
      resourceServerUrl,
    }),
  );

  const callbackPath = new URL(config.OAUTH_REDIRECT_URI).pathname;
  app.get(callbackPath, (req, res) => {
    const { code, state } = req.query;
    if (typeof code !== 'string' || typeof state !== 'string') {
      res.status(400).send('missing code/state');
      return;
    }
    provider
      .handleDiscordCallback(code, state)
      .then((redirect) => res.redirect(redirect))
      .catch((e: unknown) => {
        if (e instanceof AuthorizationDeniedError) {
          res.status(403).send('Access denied. You are not a member of any Discord server this bot is in.');
          return;
        }
        console.error('oauth callback error:', e);
        res.status(400).send('OAuth callback failed.');
      });
  });
}
