import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { googleDriveProvider } from '@/lib/account/providers/googleDrive';
import type { AccountSession, ProjectBundle } from '@/lib/account/types';

const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
  else Reflect.deleteProperty(globalThis, 'window');
});
function useFetch(fetch: typeof globalThis.fetch) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { fetch } });
}
const session = { provider: 'google', accessToken: 'fixture-only', account: { id: 'A' } } as AccountSession;
function bundle(): ProjectBundle {
  const meta = { id: 'asset_new', name: 'Image', mimeType: 'image/png', createdAt: new Date().toISOString(), size: 5 };
  const font = { id: 'font_new', family: 'Example', fileName: 'example.woff2', format: 'woff2', mimeType: 'font/woff2', createdAt: meta.createdAt, size: 4 };
  return {
    manifest: { formatVersion: 1, id: 'project', name: 'Updated', timestamp: meta.createdAt, projectData: [], media: [meta], fonts: [font] },
    media: [{ meta, blob: new Blob(['image']) }], fonts: [{ meta: font, blob: new Blob(['font']) }], missingMedia: [],
  };
}

for (const failAt of ['media__asset_new', 'font__font_new', 'project.json', null]) {
  test(`Drive commits the manifest after blobs (${failAt ?? 'success'})`, async () => {
    const events: string[] = [];
    let committed = 'Previous complete project';
    useFetch(async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/upload/drive/')) {
        const multipart = await (init.body as Blob).text();
        const metadata = JSON.parse(multipart.split('\r\n\r\n')[1].split('\r\n')[0]);
        events.push(metadata.name);
        if (metadata.name === failAt) throw new Error('simulated disconnect');
        if (metadata.name === 'project.json') committed = 'Updated';
        return Response.json({ id: metadata.name === 'project.json' ? 'manifest' : metadata.name, version: '2' });
      }
      if (init.method === 'DELETE') { events.push('sweep'); return new Response(null, { status: 204 }); }
      if (url.includes('/files?q=')) return Response.json({ files: [{ id: 'manifest', name: 'project.json' }, { id: 'old', name: 'media__old' }] });
      throw new Error('Unexpected request');
    });
    const pending = googleDriveProvider.saveProject(session, bundle(), undefined, { knownRemoteId: 'folder', renameTo: '' });
    if (failAt) {
      await assert.rejects(pending, /simulated disconnect/);
      assert.equal(committed, 'Previous complete project');
      assert.ok(!events.includes('sweep'));
      if (failAt !== 'project.json') assert.ok(!events.includes('project.json'));
    } else {
      await pending;
      assert.deepEqual(events, ['media__asset_new', 'font__font_new', 'project.json', 'sweep']);
      assert.equal(committed, 'Updated');
    }
  });
}

test('Drive reports absent image and font blobs instead of returning a complete bundle', async () => {
  const original = bundle();
  useFetch(async (input) => {
    const url = String(input);
    if (url.includes('/files?q=')) return Response.json({ files: [{ id: 'manifest', name: 'project.json' }] });
    if (url.includes('/files/manifest?alt=media')) return Response.json(original.manifest);
    throw new Error('Unexpected request');
  });
  const loaded = await googleDriveProvider.loadProject(session, 'folder');
  assert.deepEqual(loaded.missingMedia, ['asset_new', 'font_new']);
  assert.deepEqual(loaded.media, []);
  assert.deepEqual(loaded.fonts, []);
});
