import { Client, GatewayIntentBits, Options } from 'discord.js';
import type { Config } from '../config.js';

// Верхняя граница свежести прав вызвавшего: раз в столько секунд свипаем member-кэш, чтобы права
// перечитывались из REST не реже. Штатный отзыв — мгновенно через gateway; это лишь бэкстоп.
const MEMBER_SWEEP_INTERVAL_S = 60;

// Gateway intents: Guilds (каналы/роли) + GuildMembers (права вызвавшего) — этого хватает для
// permission-scoping; поиск/чтение идут через REST. Message Content — privileged intent приложения
// (портал Discord), нужный HTTP Search API, но как gateway-intent не запрашивается.
export function createDiscordClient(_config: Config): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    // По умолчанию member'ы не свипаются и висят вечно — при пропущенном gateway-событии права
    // застряли бы устаревшими. Свипаем всех (кроме самого бота): следующее обращение к правам
    // перечитывает member'а из REST свежим.
    sweepers: {
      ...Options.DefaultSweeperSettings,
      guildMembers: {
        interval: MEMBER_SWEEP_INTERVAL_S,
        filter: () => (member) => member.id !== member.client.user.id,
      },
    },
  });
}
