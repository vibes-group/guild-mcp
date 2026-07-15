import 'dotenv/config';
import { z } from 'zod';

// URL-поля валидируем как непустую строку (без format-специфики версии zod);
// строгую проверку схемы https добавим при необходимости.
const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  OAUTH_REDIRECT_URI: z.string().min(1),
  PUBLIC_BASE_URL: z.string().min(1),

  PORT: z.coerce.number().int().positive().default(3000),

  DB_PATH: z.string().default('./data/guild-mcp.db'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
