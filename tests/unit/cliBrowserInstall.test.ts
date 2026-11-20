import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { zipFiles } from '@/lib/website/zip';

test('the CLI browser installer can unpack a download without system archive tools', { timeout: 30_000 }, async () => {
  const filename = 'chrome-linux64/chrome';
  const marker = 'browser-install-control';
  const archive = Buffer.from(await zipFiles([{ path: filename, text: marker }]).arrayBuffer());
  const cache = await mkdtemp(path.join(tmpdir(), 'osg-browser-control-'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(archive.length) });
    response.end(archive);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const port = (server.address() as AddressInfo).port;
    const requireCli = createRequire(path.join(process.cwd(), 'cli/package.json'));
    child = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const { install, Browser, BrowserPlatform } = await import(pathToFileURL(process.env.TIGER_BROWSER_MODULE).href);
      const browser = await install({ browser: Browser.CHROME, platform: BrowserPlatform.LINUX,
        buildId: '133.0.0.0', baseUrl: process.env.TIGER_BROWSER_URL, cacheDir: process.env.TIGER_BROWSER_CACHE });
      process.stdout.write(fs.readFileSync(browser.executablePath, 'utf8'));
    `], {
      env: {
        PATH: '',
        TIGER_BROWSER_MODULE: requireCli.resolve('@puppeteer/browsers'),
        TIGER_BROWSER_URL: `http://127.0.0.1:${port}`,
        TIGER_BROWSER_CACHE: cache,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    child.stdout!.on('data', (chunk) => { output += chunk; });
    child.stderr!.on('data', (chunk) => { errors += chunk; });
    const [status] = await once(child, 'exit');
    assert.equal(status, 0, errors);
    assert.equal(output, marker);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cache, { recursive: true, force: true });
  }
});
