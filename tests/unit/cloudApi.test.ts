import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_PUBLIC_DISCOVER_URL = 'https://cloud.example.invalid';
const { cloudApi } = await import('@/lib/cloud/api');
const { setDiscoverSession } = await import('@/lib/discover/session');

const requests: Array<{ url: string; init: RequestInit }> = [];
const input = {
  projectId: 'local-project', name: 'Project', boards: 1, formatVersion: 1,
  doc: new Blob(['{}']), docEncoding: 'none' as const, manifestAssets: [],
};

beforeEach(() => {
  requests.length = 0;
  setDiscoverSession({ token: 'test-token', viewer: { id: 'owner' } as never, provider: 'github', accountId: 'account' });
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ project: { id: 'record' }, missing: [] }), { status: 200 });
  });
});

afterEach(() => { setDiscoverSession(null); mock.restoreAll(); });

test('manual saves keep the existing create-or-update route', async () => {
  await cloudApi.saveProject(input);
  assert.equal(requests[0].url, 'https://cloud.example.invalid/api/openscreengen/projects');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal((requests[0].init.body as FormData).get('expected_record_id'), null);
});

test('automatic updates use the record route and send both concurrency preconditions', async () => {
  await cloudApi.saveProject({ ...input, expectedRecordId: 'record', expectedUpdated: 'stamp' });
  assert.equal(requests[0].url, 'https://cloud.example.invalid/api/openscreengen/projects/record');
  assert.equal(requests[0].init.method, 'PUT');
  const form = requests[0].init.body as FormData;
  assert.equal(form.get('expected_record_id'), 'record');
  assert.equal(form.get('expected_updated'), 'stamp');
  assert.equal(form.get('project_id'), 'local-project');
});

test('a missing concurrency precondition is rejected before a request', async () => {
  await assert.rejects(cloudApi.saveProject({ ...input, expectedRecordId: 'record' }));
  assert.equal(requests.length, 0);
});

test('an older backend refusal never falls back to the create route', async () => {
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    return new Response('{}', { status: 404 });
  });
  await assert.rejects(cloudApi.saveProject({ ...input, expectedRecordId: 'record', expectedUpdated: 'stamp' }));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.method, 'PUT');
});

test('file uploads bind to their document save revision and use the conditional route', async () => {
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ previousUpdated: 'stamp', updated: 'next' }), { status: 200 });
  });
  const result = await cloudApi.uploadAsset('record', {
    projectId: 'local-project', expectedUpdated: 'stamp', assetId: 'image', kind: 'media',
    blob: new Blob(['pixels']), meta: {},
  });
  assert.deepEqual(result, { previousUpdated: 'stamp', updated: 'next' });
  assert.equal(requests[0].init.method, 'PUT');
  assert.equal(requests[0].url, 'https://cloud.example.invalid/api/openscreengen/projects/record/assets');
  const form = requests[0].init.body as FormData;
  assert.equal(form.get('project_id'), 'local-project');
  assert.equal(form.get('expected_record_id'), 'record');
  assert.equal(form.get('expected_updated'), 'stamp');
});

test('file uploads never fall back to an unconditional POST on older backends', async () => {
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    return new Response('{}', { status: 404 });
  });
  await assert.rejects(cloudApi.uploadAsset('record', {
    projectId: 'local-project', expectedUpdated: 'stamp', assetId: 'image', kind: 'media',
    blob: new Blob(['pixels']), meta: {},
  }));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.method, 'PUT');
});
