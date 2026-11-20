/** Authenticated Streamable HTTP for native clients on loopback. */
import http from 'node:http';
import { httpRequestStatus, validHttpToken } from './httpSecurity.js';
import type { AddressInfo } from 'node:net';
import type { CommandContext } from '../context.js';
import { EXIT, usageError } from '../errors.js';
import { debug, emit, info, ok, warn } from '../log.js';
import { dispatch, isJsonRpcRequest, lazySession, rpcError, toolCount } from './tools.js';

const HOST = '127.0.0.1';

/** Matches MAX_BODY in mcp_server.rs: generous, because arguments carry base64 images. */
const MAX_BODY = 32 * 1024 * 1024;

export function createHttpServer(ctx: CommandContext, token: string): http.Server {
  if (!validHttpToken(token)) throw usageError('MCP HTTP needs a token of at least 32 URL-safe characters.');
  const getSession = lazySession(ctx);
  let sessionCounter = 0;

  const sendEmpty = (res: http.ServerResponse, status: number) => {
    res.writeHead(status);
    res.end();
  };

  const sendJson = (res: http.ServerResponse, status: number, payload: unknown, sessionId?: string) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    });
    res.end(body);
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error(`request body larger than ${Math.round(MAX_BODY / (1024 * 1024))} MB`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const handlePost = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (error) {
      sendJson(res, 413, rpcError(null, -32600, (error as Error).message));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, rpcError(null, -32700, 'invalid JSON'));
      return;
    }

    if (Array.isArray(parsed)) {
      const requests = parsed.filter(isJsonRpcRequest);
      if (!requests.length) {
        sendEmpty(res, 202);
        return;
      }
      const responses = await Promise.all(requests.map((message) => dispatch(message, getSession)));
      // No session header on a batch, matching the Rust server: a batch that
      // happens to contain `initialize` is not how any client handshakes.
      sendJson(res, 200, responses);
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      sendJson(res, 400, rpcError(null, -32600, 'invalid request'));
      return;
    }

    if (!isJsonRpcRequest(parsed)) {
      // A notification or a stray reply. Acknowledged, never bridged: nothing
      // is expected back and the page would answer -32601 to a notification.
      debug(`http: 202 for ${(parsed as { method?: string }).method ?? 'non-request message'}`);
      sendEmpty(res, 202);
      return;
    }

    const isInitialize = (parsed as { method?: unknown }).method === 'initialize';
    const response = await dispatch(parsed, getSession);
    sendJson(res, 200, response, isInitialize ? `osg-mcp-${sessionCounter++}` : undefined);
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const port = (server.address() as AddressInfo).port;
        const status = httpRequestStatus(req.rawHeaders, port, token);
        if (status !== 200) {
          sendEmpty(res, status);
          return;
        }
        // The path is not checked, exactly as the Rust server does not check
        // it. Clients disagree about whether the endpoint is /mcp or /, and
        // there is nothing else on this port to collide with.
        switch (req.method) {
          case 'OPTIONS':
            sendEmpty(res, 204);
            return;
          case 'GET':
            sendEmpty(res, 405);
            return;
          case 'DELETE':
            sendEmpty(res, 200);
            return;
          case 'POST':
            await handlePost(req, res);
            return;
          default:
            sendEmpty(res, 405);
            return;
        }
      } catch (error) {
        warn(`mcp http: ${(error as Error).message}`);
        if (!res.headersSent) sendJson(res, 500, rpcError(null, -32603, (error as Error).message));
        else res.end();
      }
    })();
  });

  // Node closes an idle keep-alive socket after 5 seconds. An MCP client holds
  // one connection open across a whole editing session and can easily go a
  // minute between calls, and a client that writes into the socket as the
  // server is closing it sees ECONNRESET rather than a retry.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;

  return server;
}

export async function serveHttp(ctx: CommandContext, port: number): Promise<number> {
  const token = process.env.OSG_MCP_AUTH_TOKEN;
  if (!validHttpToken(token)) {
    throw usageError('MCP HTTP needs OSG_MCP_AUTH_TOKEN with at least 32 URL-safe characters.', 'Provide it through your secret manager, or use --stdio.');
  }
  const server = createHttpServer(ctx, token);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? usageError(
              `Port ${port} is already in use.`,
              'Another `osg mcp` or the desktop app may already be serving it. Pass --port <n>.'
            )
          : usageError(`Could not listen on ${HOST}:${port}: ${error.message}`)
      );
    };
    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });

  // A port of 0 lets the OS pick, so report the real one rather than the ask.
  const actual = (server.address() as AddressInfo).port;
  const url = `http://${HOST}:${actual}/mcp`;
  const count = toolCount();

  server.on('error', (error) => warn(`mcp http: ${error.message}`));

  if (ctx.json) {
    emit({ ok: true, transport: 'http', url, port: actual, tools: count });
  } else {
    ok(`mcp http on ${url}${count === null ? '' : `, ${count} design tools`}`);
    info('the editor starts on the first tool call. Ctrl+C to stop');
  }

  return await new Promise<number>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      info('mcp http stopping');
      // Keep-alive sockets hold `close` open indefinitely, so the callback
      // would never fire and Ctrl+C would look like a hang.
      server.closeAllConnections?.();
      server.close(() => resolve(EXIT.ok));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
