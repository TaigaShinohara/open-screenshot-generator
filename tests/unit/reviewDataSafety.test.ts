import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '@/database';
import { deleteImageAsset, listImageAssets } from '@/lib/mcp/assetStore';
import { getMediaAsset } from '@/lib/mediaStore';
import { collectMediaIds } from '@/lib/account/projectBundle';
import { getProvider, listAccountProjects, loadProjectFromAccount, withFreshSession } from '@/lib/account';
import { clearSession, getSession, setSession } from '@/lib/account/store';
import { AccountAuthError, AccountBlockedError, AccountCancelledError, type AccountSession } from '@/lib/account/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const account = (id: string): AccountSession => ({ provider: 'google', accessToken: `fixture-${id}`, account: { id, name: id } } as AccountSession);
afterEach(() => { mock.restoreAll(); clearSession(); });

test('forgetting an uploaded image preserves its shared blob and existing project references', async () => {
  const row = { id: 'asset_shared', name: 'Image', blob: new Blob(['image bytes']), createdAt: new Date(), mimeType: 'image/png', hiddenFromLibrary: false };
  mock.method(db.media, 'get', async () => row);
  mock.method(db.media, 'toArray', async () => [row]);
  mock.method(db.media, 'update', async (_id, changes) => { Object.assign(row, changes); return 1; });
  const removed = mock.method(db.media, 'delete', async () => {});
  const boards = [{ elements: [{ type: 'image', imageSrc: 'asset:asset_shared' }] }] as any;
  assert.equal((await listImageAssets()).length, 1);
  assert.equal(await deleteImageAsset('asset:asset_shared'), true);
  assert.deepEqual(await listImageAssets(), []);
  assert.deepEqual(collectMediaIds(boards), ['asset_shared']);
  assert.equal(await (await getMediaAsset('asset_shared'))?.blob.text(), 'image bytes');
  assert.equal(removed.mock.callCount(), 0);
  assert.equal(await deleteImageAsset('asset_shared'), false);
});

for (const action of ['sign out', 'switch accounts', 'sign in again'] as const) {
  test(`a late refresh cannot undo ${action}`, async () => {
    const old = account('A');
    const refresh = deferred<AccountSession>();
    mock.method(getProvider('google'), 'ensureFreshSession', () => refresh.promise);
    setSession(old);
    const pending = withFreshSession(old);
    await Promise.resolve();
    const next = action === 'sign out' ? null : account(action === 'switch accounts' ? 'B' : 'A');
    setSession(next);
    refresh.resolve({ ...old, accessToken: 'fixture-refreshed' });
    await assert.rejects(pending, AccountCancelledError);
    assert.equal(getSession(), next);
  });
}

test('concurrent callers share one refresh and preserve the renewed session', async () => {
  const old = account('A');
  const refresh = deferred<AccountSession>();
  const ensure = mock.method(getProvider('google'), 'ensureFreshSession', () => refresh.promise);
  setSession(old);
  const requests = [withFreshSession(old), withFreshSession(old)];
  await Promise.resolve();
  assert.equal(ensure.mock.callCount(), 1);
  const fresh = { ...old, accessToken: 'fixture-renewed' };
  refresh.resolve(fresh);
  assert.deepEqual(await Promise.all(requests), [fresh, fresh]);
  assert.equal(getSession(), fresh);
});

test('a synchronous refresh failure can be retried', async () => {
  const session = account('A');
  const ensure = mock.method(getProvider('google'), 'ensureFreshSession', () => { throw new Error('offline'); });
  setSession(session);
  await assert.rejects(withFreshSession(session), /offline/);
  await assert.rejects(withFreshSession(session), /offline/);
  assert.equal(ensure.mock.callCount(), 2);
});

test('an old request auth failure does not sign out a newly selected account', async () => {
  const session = account('A');
  const listing = deferred<any>();
  const started = deferred<void>();
  mock.method(getProvider('google'), 'ensureFreshSession', async () => session);
  mock.method(getProvider('google'), 'listProjects', () => { started.resolve(); return listing.promise; });
  setSession(session);
  const pending = listAccountProjects();
  await started.promise;
  const next = account('B');
  setSession(next);
  listing.reject(new AccountAuthError('Expired'));
  await assert.rejects(pending, AccountAuthError);
  assert.equal(getSession(), next);
});

test('an incomplete cloud bundle is refused before importing any local data', async () => {
  const session = account('A');
  setSession(session);
  mock.method(getProvider('google'), 'ensureFreshSession', async () => session);
  mock.method(getProvider('google'), 'loadProject', async () => ({ manifest: { id: 'existing' }, media: [], fonts: [], missingMedia: ['asset_missing'] }));
  const write = mock.method(db.projects, 'put', async () => { throw new Error('must not write'); });
  let beforeWrite = false;
  await assert.rejects(loadProjectFromAccount('remote', undefined, async () => { beforeWrite = true; }), AccountBlockedError);
  assert.equal(beforeWrite, false);
  assert.equal(write.mock.callCount(), 0);
});

test('a rejected old access token cannot clear a concurrently refreshed session', async () => {
  const old = account('A');
  const listing = deferred<any>();
  const started = deferred<void>();
  const fresh = { ...old, accessToken: 'fixture-new-token' };
  let renew = false;
  mock.method(getProvider('google'), 'ensureFreshSession', async () => renew ? fresh : old);
  mock.method(getProvider('google'), 'listProjects', () => { started.resolve(); return listing.promise; });
  setSession(old);
  const pending = listAccountProjects();
  await started.promise;
  renew = true;
  await withFreshSession(old);
  listing.reject(new AccountAuthError('Old token expired'));
  await assert.rejects(pending, AccountAuthError);
  assert.equal(getSession(), fresh);
});
