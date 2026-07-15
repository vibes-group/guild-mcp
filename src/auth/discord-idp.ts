import type { Config } from '../config.js';

const DISCORD_API = 'https://discord.com/api/v10';

// Least privilege: только проверенный user id. Роли/членство/каналы считаем через бота
// (permissionsFor), поэтому guilds/guilds.members.read не запрашиваем (least-privilege).
const SCOPE = 'identify';

// URL согласия Discord; state коррелирует запрос с нашим pending-authorization.
export function buildAuthorizeUrl(config: Config, state: string): string {
  const params = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: config.OAUTH_REDIRECT_URI,
    scope: SCOPE,
    state,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

// Обмен authorization code Discord -> access token -> проверенный Discord user id.
export async function exchangeCodeForUserId(config: Config, code: string): Promise<string> {
  const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.DISCORD_CLIENT_ID,
      client_secret: config.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.OAUTH_REDIRECT_URI,
    }),
  });
  if (!tokenRes.ok) throw new Error(`discord token exchange failed: ${tokenRes.status}`);
  const token = (await tokenRes.json()) as { access_token: string };

  const userRes = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!userRes.ok) throw new Error(`discord identify failed: ${userRes.status}`);
  const user = (await userRes.json()) as { id: string };
  return user.id;
}
