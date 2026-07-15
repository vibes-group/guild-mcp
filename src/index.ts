import { Events } from 'discord.js';
import { loadConfig } from './config.js';
import { openDb } from './db/db.js';
import { createDiscordClient } from './discord/client.js';
import { createHttpServer } from './http/server.js';

// Старт: config -> db -> discord login+ready -> http+mcp.
async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config);
  const discord = createDiscordClient(config);
  const deps = { db, discord, config };

  await discord.login(config.DISCORD_BOT_TOKEN);
  // login() резолвится до наполнения guilds.cache — ждём фактической готовности клиента, иначе
  // первые запросы увидят пустой кэш гильдий и отдадут ложное «ничего не видно» вместо retry.
  if (!discord.isReady()) {
    await new Promise<void>((resolve) => discord.once(Events.ClientReady, () => resolve()));
  }

  const app = createHttpServer(config, deps);
  app.listen(config.PORT, () => console.log(`guild-mcp http listening on :${config.PORT}`));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
