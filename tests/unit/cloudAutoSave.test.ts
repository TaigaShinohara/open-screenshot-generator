import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '@/database';
import { cloudApi, type CloudAssetUpload, type CloudAssetUploadResult, type CloudSaveInput } from '@/lib/cloud/api';
import { CloudAutoSaver, type CloudAutoSaveConfig } from '@/lib/cloud/autoSave';
import {
  CloudAutoSaveConsentRequiredError,
  CloudConflictError,
  loadProjectFromCloud,
  saveProjectToCloud,
} from '@/lib/cloud';
import { hasCloudAutoSaveConsent, putCloudLink, type CloudProjectLink } from '@/lib/cloud/links';
import { CloudRequestError, type CloudProject } from '@/lib/cloud/types';
import type { Project } from '@/types/artboard';

const links = new Map<string, CloudProjectLink>();
const remotes = new Map<string, CloudProject>();
const writes: CloudSaveInput[] = [];
const savers: CloudAutoSaver[] = [];
const compressionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CompressionStream');
let accountId: string | null;
const config: CloudAutoSaveConfig = {
  projectId: 'a', accountId: 'owner', available: true, signedIn: true, enabled: true, openToken: 1,
};
const project: Project = {
  id: 'a', name: 'Local project', timestamp: new Date(1),
  projectData: [{
    id: 'board', name: 'Artboard', elements: [], position: { x: 0, y: 0 },
    size: { width: 1206, height: 2622 }, backgroundColor: '#ffffff', zoom: 1,
  }],
};

function remote(id = 'a'): CloudProject {
  return {
    id: `record-${id}`, projectId: id, name: id, boards: 1, docBytes: 1, assetBytes: 0,
    formatVersion: 1, docEncoding: 'none', visibility: 'private', created: '1', updated: '1',
  };
}

function link(consent?: CloudProjectLink['autoSaveConsent'], id = 'a'): CloudProjectLink {
  return {
    projectId: id, recordId: `record-${id}`, accountId: 'owner', savedAt: new Date(1),
    remoteUpdated: '1', visibility: 'private', shareSlug: '', pendingAssets: [],
    ...(consent ? { autoSaveConsent: consent } : {}),
  };
}

async function settle() {
  for (let round = 0; round < 8; round++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function advance(ms: number) {
  mock.timers.tick(ms);
  await settle();
}

function saver(flushLocal: () => Promise<unknown> | void = () => {}) {
  const result = new CloudAutoSaver({ flushLocal });
  savers.push(result);
  return result;
}

function includeImages(ids: string[]) {
  mock.method(db.projects, 'get', async () => ({
    ...project,
    projectData: [{
      ...project.projectData[0],
      elements: ids.map((id) => ({ id, type: 'image', imageSrc: `asset:${id}` })),
    }],
  }));
  mock.method(db.media, 'get', async (id: string) => ({
    id, name: id, mimeType: 'image/png', createdAt: new Date(1), blob: new Blob(['pixels']),
  }));
  mock.method(cloudApi, 'saveProject', async (input: CloudSaveInput) => {
    writes.push(input);
    const saved = { ...remote(input.projectId), updated: 'A-document' };
    remotes.set(saved.id, saved);
    return { project: saved, missing: ids.map((id) => ({ id, kind: 'media' as const })) };
  });
}

beforeEach(() => {
  links.clear(); remotes.clear(); writes.length = 0; accountId = 'owner';
  remotes.set('record-a', remote());
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, value: undefined });
  mock.method(globalThis, 'fetch', async () => { throw new Error('External requests are forbidden in this test'); });
  mock.method(db.cloudLinks, 'get', async (id: string) => links.get(id));
  mock.method(db.cloudLinks, 'put', async (row: CloudProjectLink) => { links.set(row.projectId, row); return row.projectId; });
  mock.method(db.cloudLinks, 'delete', async (id: string) => { links.delete(id); });
  mock.method(db.projects, 'get', async (id: string) => ({ ...project, id }));
  mock.method(db.projects, 'put', async (row: Project) => row.id);
  mock.method(cloudApi, 'accountId', () => accountId);
  mock.method(cloudApi, 'getProject', async (id: string) => remotes.get(id) ?? null);
  mock.method(cloudApi, 'listProjects', async () => ({ projects: [...remotes.values()], limit: 30 }));
  mock.method(cloudApi, 'saveProject', async (input: CloudSaveInput) => {
    writes.push(input);
    const saved = { ...remote(input.projectId), updated: String(Date.now()) };
    remotes.set(saved.id, saved);
    return { project: saved, missing: [] };
  });
  mock.method(cloudApi, 'fetchDoc', async () => new Blob([JSON.stringify({
    formatVersion: 1, id: project.id, name: project.name, projectData: project.projectData, media: [],
  })]));
});

afterEach(() => {
  for (const instance of savers.splice(0)) instance.detach();
  mock.timers.reset();
  mock.restoreAll();
  if (compressionDescriptor) Object.defineProperty(globalThis, 'CompressionStream', compressionDescriptor);
});

test('new, imported, legacy and other-account projects stay local with the global switch on', async () => {
  const instance = saver();
  for (const [id, stored] of [
    ['new', null], ['imported', null], ['legacy', link(undefined, 'legacy')],
    ['other', { ...link('manual-save', 'other'), accountId: 'somebody-else' }],
  ] as const) {
    if (stored) links.set(id, stored);
    instance.configure({ ...config, projectId: id });
    instance.noteChange(id);
    await settle();
    instance.saveNow();
    await advance(60_000);
    assert.equal(instance.getStatus().state, 'unlinked');
  }
  assert.equal(writes.length, 0);
});

test('automatic saves reject legacy permission before any remote lookup', async () => {
  links.set('a', link());
  let lookups = 0;
  mock.method(cloudApi, 'getProject', async () => { lookups++; return remote(); });
  await assert.rejects(saveProjectToCloud('a', { origin: 'auto' }), CloudAutoSaveConsentRequiredError);
  assert.equal(lookups, 0);
  assert.equal(writes.length, 0);
  assert.equal(hasCloudAutoSaveConsent(link('manual-save'), null), false);
});

test('a link refresh cannot carry consent from another account or another cloud record', async () => {
  for (const existing of [
    { ...link('manual-save'), accountId: 'other' },
    { ...link('manual-save'), recordId: 'other-record' },
  ]) {
    links.set('a', existing);
    await putCloudLink('a', 'owner', remote(), []);
    assert.equal(links.get('a')?.autoSaveConsent, undefined);
  }
});

test('manual saves record permission, and later automatic saves preserve it and target that record', async () => {
  links.set('a', link());
  const instance = saver();
  instance.configure(config);
  await settle();
  await saveProjectToCloud('a', { origin: 'manual' });
  instance.noteSaved('a');
  await settle();
  assert.equal(links.get('a')?.autoSaveConsent, 'manual-save');
  assert.equal(instance.getStatus().state, 'saved');
  instance.noteChange('a');
  await advance(8_000);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].expectedRecordId, undefined);
  assert.equal(writes[1].expectedRecordId, 'record-a');
  assert.equal(writes[1].expectedUpdated, '1000000');
  assert.equal(links.get('a')?.autoSaveConsent, 'manual-save');
  assert.equal(instance.getStatus().state, 'saved');
});

test('opening an owned cloud copy grants permission, while opening a copy does not', async () => {
  await loadProjectFromCloud('record-a');
  assert.equal(links.get('a')?.autoSaveConsent, 'cloud-open');
  links.clear();
  const copy = await loadProjectFromCloud('record-a', { asCopy: true });
  assert.notEqual(copy.id, 'a');
  assert.equal(links.size, 0);
});

test('the manual save notification reads partial uploads and cannot grant permission by itself', async () => {
  const instance = saver();
  instance.configure(config);
  await settle();
  instance.noteSaved('a');
  await settle();
  assert.equal(instance.getStatus().state, 'unlinked');
  await putCloudLink('a', 'owner', remote(), ['missing'], 'manual-save');
  instance.noteSaved('a');
  await settle();
  assert.equal(instance.getStatus().state, 'pending');
  assert.equal(instance.getStatus().pendingAssets, 1);
});

test('a manual save completion keeps edits that may have arrived while the request ran', async () => {
  links.set('a', link('manual-save'));
  const instance = saver();
  instance.configure(config);
  await settle();
  instance.noteChange('a');
  await putCloudLink('a', 'owner', remote(), [], 'manual-save');
  instance.noteSaved('a');
  await settle();
  assert.equal(instance.getStatus().state, 'pending');
  await advance(8_000);
  assert.equal(writes.length, 1);
  assert.equal(instance.getStatus().state, 'saved');
});

test('a failed local flush pauses automatic saving before any cloud write, and a retry can recover', async () => {
  links.set('a', link('manual-save'));
  let fail = true;
  const instance = saver(() => { if (fail) throw new Error('The local project could not be saved'); });
  instance.configure(config);
  await settle();
  instance.noteChange('a');
  await advance(8_000);
  assert.equal(writes.length, 0);
  assert.equal(instance.getStatus().state, 'paused');
  assert.equal(instance.getStatus().message, 'The local project could not be saved');
  instance.configure({ ...config, enabled: false });
  instance.configure(config);
  assert.equal(instance.getStatus().state, 'paused');
  assert.equal(instance.getStatus().message, 'The local project could not be saved');
  fail = false;
  instance.saveNow();
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(instance.getStatus().state, 'saved');
});

test('project, account, reopen, sign-out and preference changes during a flush cancel its upload', async () => {
  links.set('a', link('manual-save'));
  for (const next of [
    { ...config, projectId: 'b' }, { ...config, accountId: 'other' },
    { ...config, openToken: 2 }, { ...config, signedIn: false }, { ...config, enabled: false },
  ]) {
    let land = () => {};
    const instance = saver(() => new Promise<void>((resolve) => { land = resolve; }));
    instance.configure(config);
    await settle();
    instance.noteChange('a');
    await advance(8_000);
    assert.equal(instance.getStatus().state, 'saving');
    instance.configure(next);
    land();
    await settle();
    assert.equal(writes.length, 0);
    if (!next.signedIn) assert.equal(instance.getStatus().state, 'signed-out');
    if (!next.enabled) assert.equal(instance.getStatus().state, 'disabled');
    instance.detach();
  }
});

test('a late save for another project cannot arm the current project', async () => {
  const instance = saver();
  instance.configure({ ...config, projectId: 'b' });
  await settle();
  links.set('a', link('manual-save'));
  instance.noteSaved('a');
  instance.noteChange('b');
  await advance(60_000);
  assert.equal(instance.getStatus().state, 'unlinked');
  assert.equal(writes.length, 0);
});

test('a delayed legacy link lookup cannot replace permission read after a manual save', async () => {
  let land = (_row: CloudProjectLink | undefined) => {};
  let reads = 0;
  mock.method(db.cloudLinks, 'get', (id: string) => ++reads === 1
    ? new Promise<CloudProjectLink | undefined>((resolve) => { land = resolve; })
    : Promise.resolve(links.get(id)));
  const instance = saver();
  instance.configure(config);
  links.set('a', link('manual-save'));
  instance.noteSaved('a');
  await settle();
  land(link());
  await settle();
  assert.equal(instance.getStatus().state, 'saved');
});

test('a deleted cloud copy is never recreated by an automatic save', async () => {
  links.set('a', link('manual-save'));
  remotes.clear();
  await assert.rejects(saveProjectToCloud('a', { origin: 'auto' }), CloudAutoSaveConsentRequiredError);
  assert.equal(writes.length, 0);
  assert.equal(links.has('a'), false);
});

test('automatic saving cannot force an overwrite of a newer cloud copy', async () => {
  links.set('a', link('manual-save'));
  remotes.set('record-a', { ...remote(), updated: 'newer' });
  await assert.rejects(saveProjectToCloud('a', { origin: 'auto', force: true }), CloudConflictError);
  assert.equal(writes.length, 0);
});

test('another device saving during a file upload prevents the next automatic overwrite', async () => {
  links.set('a', link('manual-save'));
  includeImages(['image']);
  mock.method(cloudApi, 'uploadAsset', async (_record: string, asset: CloudAssetUpload) => {
    remotes.set('record-a', { ...remote(), name: 'B document', updated: 'B-document' });
    assert.equal(asset.expectedUpdated, 'A-document');
    throw new CloudRequestError('The document changed before the upload', 409);
  });
  await assert.rejects(saveProjectToCloud('a', { origin: 'auto' }), CloudConflictError);
  assert.equal(links.get('a')?.remoteUpdated, '1');
  await assert.rejects(saveProjectToCloud('a', { origin: 'auto' }), CloudConflictError);
  assert.equal(remotes.get('record-a')?.name, 'B document');
  assert.equal(writes.length, 1);
});

test('a file response from another revision or a legacy backend cannot advance the saved link', async () => {
  includeImages(['image']);
  for (const response of [
    { previousUpdated: 'B-document', updated: 'B-file' },
    'B-file' as unknown as CloudAssetUploadResult,
  ]) {
    links.set('a', link('manual-save'));
    remotes.set('record-a', remote());
    mock.method(cloudApi, 'uploadAsset', async () => {
      remotes.set('record-a', { ...remote(), name: 'B document', updated: 'B-file' });
      return response;
    });
    await assert.rejects(saveProjectToCloud('a', { origin: 'auto' }), CloudConflictError);
    assert.equal(links.get('a')?.remoteUpdated, '1');
    await assert.rejects(saveProjectToCloud('a', { origin: 'auto' }), CloudConflictError);
    assert.equal(remotes.get('record-a')?.name, 'B document');
  }
  assert.equal(writes.length, 2);
});

test('files advance the saved revision only through confirmed replies from the same save', async () => {
  links.set('a', link('manual-save'));
  includeImages(['first', 'second']);
  const expected: string[] = [];
  mock.method(cloudApi, 'uploadAsset', async (_record: string, asset: CloudAssetUpload) => {
    expected.push(asset.expectedUpdated);
    const updated = `A-file-${expected.length}`;
    remotes.set('record-a', { ...remote(), updated });
    return { previousUpdated: asset.expectedUpdated, updated };
  });
  await saveProjectToCloud('a', { origin: 'auto' });
  assert.deepEqual(expected, ['A-document', 'A-file-1']);
  assert.equal(links.get('a')?.remoteUpdated, 'A-file-2');
});

test('signing out while a cloud request finishes cannot show the project as saved', async () => {
  links.set('a', link('manual-save'));
  let land = () => {};
  mock.method(cloudApi, 'saveProject', () => new Promise<{ project: CloudProject; missing: [] }>((resolve) => {
    land = () => resolve({ project: remote(), missing: [] });
  }));
  const instance = saver();
  instance.configure(config);
  await settle();
  instance.noteChange('a');
  await advance(8_000);
  accountId = null;
  instance.configure({ ...config, signedIn: false, accountId: null });
  land();
  await settle();
  assert.equal(instance.getStatus().state, 'signed-out');
});

test('a conditional update conflict becomes the existing conflict dialog state', async () => {
  links.set('a', link('manual-save'));
  mock.method(cloudApi, 'saveProject', async () => {
    remotes.set('record-a', { ...remote(), updated: 'newer' });
    throw new CloudRequestError('The cloud copy changed', 409);
  });
  const instance = saver();
  instance.configure(config);
  await settle();
  instance.noteChange('a');
  await advance(8_000);
  assert.equal(instance.getStatus().state, 'paused');
  assert.equal(instance.getStatus().conflict?.updated, 'newer');
});
