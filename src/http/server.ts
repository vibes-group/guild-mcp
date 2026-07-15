import express, { type Application } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from '../config.js';
import { DiscordFederatedProvider, mountAuth } from '../auth/oauth.js';
import { createMcpServer, type ToolDeps } from '../mcp/server.js';

// HTTP-слой на express: OAuth-слой SDK (mcpAuthRouter/requireBearerAuth) express-нативен.
export function createHttpServer(config: Config, deps: ToolDeps): Application {
  const app = express();

  const provider = new DiscordFederatedProvider(config, deps.discord, deps.db);
  provider.pruneExpired(); // однократная чистка протухших токенов на старте
  mountAuth(app, config, provider); // OAuth-эндпойнты + Discord-callback

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL('/mcp', config.PUBLIC_BASE_URL)),
  });

  // MCP Streamable HTTP на /mcp, за bearer. Stateless: сервер+транспорт на запрос;
  // проверенная identity из req.auth пробрасывается транспортом в extra.authInfo тулов.
  app.post('/mcp', bearer, express.json(), async (req, res) => {
    // Fail-closed на неготовый/потерявший сессию Discord-клиент: без него любой tool читал бы
    // пустой кэш. Гейтим только вызовы тулов — initialize/handshake Discord не требует.
    if (req.body?.method === 'tools/call' && !deps.discord.isReady()) {
      res.status(503).json({
        jsonrpc: '2.0',
        id: req.body.id ?? null,
        error: { code: -32000, message: 'Discord connection is not ready; retry later.' },
      });
      return;
    }
    const server = createMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
