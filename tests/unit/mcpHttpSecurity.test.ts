import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createHttpServer } from '../../cli/src/mcp/http';
import { httpRequestStatus, validHttpToken } from '../../cli/src/mcp/httpSecurity';
import { nativeClientConfig } from '@/lib/mcp/clientConfig';

const token = 'fixture_token_for_transport_tests_123456';
test('MCP HTTP requires a strong configured token and unambiguous local headers', () => {
  assert.equal(validHttpToken(undefined), false);
  assert.equal(validHttpToken('short'), false);
  assert.equal(validHttpToken(`${token}\n`), false);
  assert.equal(validHttpToken(token), true);
  const headers = ['Host', 'localhost:8722', 'Authorization', `Bearer ${token}`];
  assert.equal(httpRequestStatus(headers, 8722, token), 200);
  assert.equal(httpRequestStatus(['Host', 'localhost:8722'], 8722, token), 401);
  assert.equal(httpRequestStatus([...headers, 'Authorization', `Bearer ${token}`], 8722, token), 401);
  for (const origin of ['https://hostile.example', 'null', '', 'http://localhost:8722']) {
    assert.equal(httpRequestStatus([...headers, 'Origin', origin], 8722, token), 403);
  }
  assert.equal(httpRequestStatus(['Host', 'attacker.example:8722', 'Authorization', `Bearer ${token}`], 8722, token), 403);
  assert.equal(httpRequestStatus([...headers, 'Host', 'localhost:8722'], 8722, token), 403);
});

test('the real HTTP transport rejects untrusted requests and accepts authenticated initialization', async () => {
  const server = createHttpServer({ json: true } as any, token);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = (server.address() as AddressInfo).port;
    const endpoint = `http://127.0.0.1:${port}/mcp`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    for (const method of ['OPTIONS', 'POST', 'DELETE']) {
      const hostile = await fetch(endpoint, { method, headers: { Origin: 'https://hostile.example', Authorization: `Bearer ${token}` }, ...(method === 'POST' ? { body } : {}) });
      assert.equal(hostile.status, 403);
      assert.equal(hostile.headers.get('access-control-allow-origin'), null);
    }
    const anonymous = await fetch(endpoint, { method: 'POST', body });
    assert.equal(anonymous.status, 401);
    const wrong = await fetch(endpoint, { method: 'POST', body, headers: { Authorization: `Bearer ${token}wrong` } });
    assert.equal(wrong.status, 401);
    const valid = await fetch(endpoint, { method: 'POST', body, headers: { Authorization: `Bearer ${token}` } });
    assert.equal(valid.status, 200);
    assert.ok((await valid.json()).result.serverInfo);
    assert.equal(valid.headers.get('access-control-allow-origin'), null);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('native client configs include authentication without putting secrets in process arguments', () => {
  const connection = { url: 'http://127.0.0.1:8722/mcp', headers: { Authorization: `Bearer ${token}` }, headerFile: '/local/private/mcp-auth-headers' };
  for (const client of ['claude-code', 'vscode', 'cursor'] as const) {
    const config = JSON.parse(nativeClientConfig(client, connection));
    const entry = (config.servers ?? config.mcpServers)['tiger-screen-shot'];
    assert.deepEqual(entry.headers, connection.headers);
  }
  const desktop = JSON.parse(nativeClientConfig('claude-desktop', connection)).mcpServers['tiger-screen-shot'];
  assert.ok(desktop.args.includes('--header-file'));
  assert.ok(!JSON.stringify(desktop).includes(token));
});
