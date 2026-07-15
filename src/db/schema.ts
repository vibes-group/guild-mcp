// Схема БД инлайном (аналог go:embed): едет внутри скомпилированного dist,
// без чтения с диска и без копирования .sql в build.
// Персист OAuth-состояния, чтобы рестарт/ребут не разлогинивал.
// token_hash хранит SHA-256(token), не сам токен: дамп тома бесполезен для захвата сессий.
export const SCHEMA = `
-- Эфемерные pending/authorization-codes не храним — живут секунды во время логина.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id  TEXT PRIMARY KEY,
  data       TEXT NOT NULL           -- JSON OAuthClientInformationFull
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash       TEXT PRIMARY KEY,
  discord_user_id  TEXT NOT NULL,
  client_id        TEXT NOT NULL,
  scopes           TEXT NOT NULL,     -- JSON string[]
  expires_at       INTEGER NOT NULL,  -- unix ms
  resource         TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(discord_user_id);

CREATE TABLE IF NOT EXISTS oauth_refresh (
  token_hash       TEXT PRIMARY KEY,
  discord_user_id  TEXT NOT NULL,
  client_id        TEXT NOT NULL,
  scopes           TEXT NOT NULL,     -- JSON string[]
  expires_at       INTEGER NOT NULL   -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON oauth_refresh(discord_user_id);
`;
