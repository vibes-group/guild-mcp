import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

// Проверенная идентичность вызвавшего: только Discord user id.
// Роли НЕ храним — пересчитываем per-request через бота (актуальное состояние Discord).
export interface CallerIdentity {
  userId: string;
}

// Достаём идентичность ТОЛЬКО из проверенного токена (AuthInfo.extra), никогда из аргументов клиента.
export function callerFromAuth(auth: AuthInfo | undefined): CallerIdentity {
  const userId = auth?.extra?.discordUserId;
  if (typeof userId !== 'string') throw new Error('unauthenticated: no verified Discord identity');
  return { userId };
}
