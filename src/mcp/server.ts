import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from 'discord.js';
import type { Config } from '../config.js';
import type { DB } from '../db/db.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { registerGetAttachment } from './tools/get-attachment.js';
import { registerGetChannel } from './tools/get-channel.js';
import { registerGetMember } from './tools/get-member.js';
import { registerGetMessage } from './tools/get-message.js';
import { registerGetMessages } from './tools/get-messages.js';
import { registerGetPinned } from './tools/get-pinned.js';
import { registerListChannels } from './tools/list-channels.js';
import { registerListThreads } from './tools/list-threads.js';
import { registerSearchMembers } from './tools/search-members.js';
import { registerSearchMessages } from './tools/search-messages.js';

// Общие зависимости тулов. Идентичность вызвавшего берётся per-request из проверенного
// OAuth-токена (extra.authInfo), не из аргументов тула.
//
// ПРАВИЛО ДОСТУПА для новых тулов: содержимое сообщений и вложений читать ТОЛЬКО через
// src/discord/messages.ts (fetchMessage/fetchMessages/fetchPinned) — там гейт по правам
// вызвавшего и Discord-фетч склеены и не могут разъехаться. Прямой channel.messages.* в тулах
// запрещён. Метаданные канала/тредов гейтить через canUserViewChannel перед channels.fetch.
export interface ToolDeps {
  db: DB;
  discord: Client;
  config: Config;
}

export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: 'guild-mcp', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerSearchMessages(server, deps);
  registerGetMessages(server, deps);
  registerGetMessage(server, deps);
  registerGetAttachment(server, deps);
  registerGetChannel(server, deps);
  registerListThreads(server, deps);
  registerGetPinned(server, deps);
  registerListChannels(server, deps);
  registerGetMember(server, deps);
  registerSearchMembers(server, deps);
  return server;
}
