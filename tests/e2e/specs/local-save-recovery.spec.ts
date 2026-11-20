import { promises as fs } from 'node:fs';
import { test, expect, type Page } from '../fixtures/test';
import { waitForProject, readProjects } from '../fixtures/db';
import { Editor } from '../helpers/editor';

async function failProjectWrites(page: Page, fail: boolean) {
  await page.evaluate((blocked) => {
    const state = window as unknown as { __blockProjectWrites?: boolean; __patchedProjectWrites?: boolean };
    state.__blockProjectWrites = blocked;
    if (state.__patchedProjectWrites) return;
    state.__patchedProjectWrites = true;
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'projects' && state.__blockProjectWrites) throw new DOMException('Test storage limit', 'QuotaExceededError');
      return original.apply(this, args);
    };
  }, fail);
}

test('a failed local save stays visible, exports current edits and recovers on retry', async ({ app, page, isDesktop, tauri }, testInfo) => {
  await app.startBlankProject();
  await app.ensurePaletteOpen();
  await app.addElementFrom('Basic', 'Text', 'basic:text');
  await app.textContentInput.fill('保存できた原文');
  await app.textContentInput.blur();
  const original = await waitForProject(page, (row) => JSON.stringify(row.projectData).includes('保存できた原文'));

  await failProjectWrites(page, true);
  await app.textContentInput.fill('復旧ファイルに残す最新の変更');
  await app.textContentInput.blur();
  const recovery = page.locator('[data-save-recovery]');
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText('could not be saved on this device');
  expect(JSON.stringify(await readProjects(page))).not.toContain('復旧ファイルに残す最新の変更');
  await page.screenshot({ path: testInfo.outputPath('save-failure.png') });

  if (isDesktop) {
    await recovery.getByRole('button', { name: 'Export recovery file', exact: true }).click();
    const files = await tauri.waitForFiles(1);
    expect(files[0].path).toContain(`${original.id}-recovery.json`);
    expect(files[0].bytes).toBeGreaterThan(200);
  } else {
    const promised = page.waitForEvent('download');
    await recovery.getByRole('button', { name: 'Export recovery file', exact: true }).click();
    const download = await promised;
    expect(download.suggestedFilename()).toContain(`${original.id}-recovery.json`);
    const file = await download.path();
    const json = JSON.parse(await fs.readFile(file!, 'utf8'));
    expect(JSON.stringify(json.projectData)).toContain('復旧ファイルに残す最新の変更');
    await download.saveAs(testInfo.outputPath('recovery.json'));
  }
  await expect(recovery).toBeVisible();
  await failProjectWrites(page, false);
  await recovery.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(recovery).toHaveCount(0);
  await waitForProject(page, (row) => JSON.stringify(row.projectData).includes('復旧ファイルに残す最新の変更'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await app.waitForBoot();
  await expect(app.board(0).locator('[data-text-body="true"]')).toHaveText('復旧ファイルに残す最新の変更');
});

test('a recovery file opens with its image and imported font in a fresh profile', async ({ app, page, browser, baseURL, isDesktop }, testInfo) => {
  test.skip(isDesktop, 'the fresh profile exercises the web file importer');
  await app.startBlankProject();
  await app.ensurePaletteOpen();
  await app.addElementFrom('Basic', 'Text', 'basic:text');
  const stored = await waitForProject(page, row => JSON.stringify(row.projectData).includes('New Text'));
  const font = await fs.readFile('node_modules/geist/dist/fonts/geist-sans/Geist-Regular.woff2');
  const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/p8AAAAASUVORK5CYII=';
  const projectData = JSON.parse(JSON.stringify(stored.projectData));
  projectData[0].backgroundImage = 'asset:recovery-image';
  projectData[0].elements[0].fontFamily = 'Recovery font';
  const initialFile = testInfo.outputPath('with-assets.json');
  await fs.writeFile(initialFile, JSON.stringify({
    formatVersion: 1, id: 'recovery-assets', name: 'Recovery assets', timestamp: new Date().toISOString(), projectData,
    media: [{ id: 'recovery-image', name: 'pixel.png', mimeType: 'image/png', width: 1, height: 1, size: Buffer.from(imageData, 'base64').length, createdAt: new Date().toISOString() }],
    mediaData: { 'recovery-image': imageData },
    fonts: [{ id: 'recovery-font', family: 'Recovery font', fileName: 'Recovery.woff2', format: 'woff2', mimeType: 'font/woff2', size: font.length, createdAt: new Date().toISOString() }],
    fontData: { 'recovery-font': font.toString('base64') },
  }));
  const chooser = page.waitForEvent('filechooser');
  await app.chooseFromMenu(app.openProjectButton, /From a project file/i);
  await (await chooser).setFiles(initialFile);
  await expect(page).toHaveURL(/projectId=imported_/);
  await expect(app.board(0).locator('[data-text-body="true"]')).toHaveText('New Text');
  await app.elementsOn(0).first().click();
  await failProjectWrites(page, true);
  await app.textContentInput.fill('Recovered with my assets');
  await app.textContentInput.blur();
  const recovery = page.locator('[data-save-recovery]');
  await expect(recovery).toBeVisible();
  const promised = page.waitForEvent('download');
  await recovery.getByRole('button', { name: 'Export recovery file', exact: true }).click();
  const download = await promised;
  const recoveredFile = testInfo.outputPath('portable-recovery.json');
  await download.saveAs(recoveredFile);
  const bundle = JSON.parse(await fs.readFile(recoveredFile, 'utf8'));
  expect(Object.values(bundle.mediaData)).toContain(imageData);
  expect(Object.values(bundle.fontData)).toContain(font.toString('base64'));

  const fresh = await browser.newContext({ baseURL });
  try {
    await fresh.addInitScript(() => {
      localStorage.setItem('open-screenshot-generator.show-startup-tips', '0');
      localStorage.setItem('open-screenshot-generator.local-font-notice-dismissed', '1');
    });
    await fresh.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL!).origin ? route.continue() : route.abort());
    const freshPage = await fresh.newPage();
    const imported = new Editor(freshPage);
    await imported.goto();
    await imported.startBlankProject();
    const pick = freshPage.waitForEvent('filechooser');
    await imported.chooseFromMenu(imported.openProjectButton, /From a project file/i);
    await (await pick).setFiles(recoveredFile);
    await expect(freshPage).toHaveURL(/projectId=imported_/);
    await expect(imported.board(0).locator('[data-text-body="true"]')).toHaveText('Recovered with my assets');
    await expect.poll(() => imported.board(0).locator('img').first().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    expect(await freshPage.evaluate(async () => (await document.fonts.load('16px "Recovery font"')).length)).toBeGreaterThan(0);
    const assets = await freshPage.evaluate(() => new Promise<{ media: number; fonts: number }>((resolve, reject) => {
      const request = indexedDB.open('ProjectDatabase');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['media', 'fonts'], 'readonly');
        const media = tx.objectStore('media').getAll();
        const fonts = tx.objectStore('fonts').getAll();
        tx.oncomplete = () => { resolve({ media: media.result[0]?.blob.size, fonts: fonts.result[0]?.blob.size }); db.close(); };
        tx.onerror = () => reject(tx.error);
      };
    }));
    expect(assets).toEqual({ media: Buffer.from(imageData, 'base64').length, fonts: font.length });
    await freshPage.screenshot({ path: testInfo.outputPath('recovered-assets.png') });
  } finally {
    await fresh.close();
    await failProjectWrites(page, false);
  }
});

test('language settings stay open on a failed save and recover before a reload', async ({ app, page }) => {
  await app.startBlankProject();
  await app.ensurePaletteOpen();
  await app.addElementFrom('Basic', 'Text', 'basic:text');
  await waitForProject(page, row => JSON.stringify(row.projectData).includes('New Text'));
  await failProjectWrites(page, true);
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await page.getByRole('menuitem', { name: /Add language|Manage languages/ }).first().click();
  const manager = page.getByRole('dialog').filter({ hasText: 'Languages' });
  await manager.getByRole('textbox', { name: 'Search languages' }).fill('German');
  await manager.locator('#locale-de-DE').click();
  const seed = manager.getByLabel('Fill in machine translations to start from');
  if (await seed.getAttribute('aria-checked') === 'true') await seed.click();
  const apply = manager.getByRole('button', { name: /^Add 1 language$/ });
  await apply.click();
  await expect(page.locator('[data-save-recovery]')).toBeVisible();
  await expect(apply).toHaveAttribute('aria-busy', 'false');
  await expect(manager).toBeVisible();
  await manager.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(manager).toBeHidden();
  await failProjectWrites(page, false);
  await page.locator('[data-save-recovery]').getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.locator('[data-save-recovery]')).toHaveCount(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await app.waitForBoot();
  await expect(page.locator('button[title^="Showing "]')).toBeVisible();
});

test('an update is refused while a project save fails', async ({ app, page, isDesktop, tauri }) => {
  test.skip(!isDesktop, 'the web build has no update installer');
  await app.startBlankProject();
  await app.ensurePaletteOpen();
  await app.addElementFrom('Basic', 'Text', 'basic:text');
  await waitForProject(page, (row) => JSON.stringify(row.projectData).includes('New Text'));
  await failProjectWrites(page, true);
  await app.textContentInput.fill('更新前に保存できない変更');
  await app.textContentInput.blur();
  await expect(page.locator('[data-save-recovery]')).toBeVisible();
  await expect.poll(async () => (await tauri.callsTo('plugin:event|listen')).some(call => call.args.event === 'abs-update-flush')).toBe(true);
  await tauri.emitFromBackend('abs-update-flush', 912);
  const answer = await tauri.waitForCall('abs_update_flushed');
  expect(answer.args).toEqual({ nonce: 912, ok: false });
  await expect(app.board(0).locator('[data-text-body="true"]')).toHaveText('更新前に保存できない変更');
  await failProjectWrites(page, false);
});

test('installing an update blocks editing and a cancelled install restores editing', async ({ app, page, isDesktop, tauri }) => {
  test.skip(!isDesktop, 'the web build has no update installer');
  await app.startBlankProject();
  await app.ensurePaletteOpen();
  await app.addElementFrom('Basic', 'Text', 'basic:text');
  await waitForProject(page, (row) => JSON.stringify(row.projectData).includes('New Text'));
  await expect.poll(async () => (await tauri.callsTo('plugin:event|listen')).some(call => call.args.event === 'abs-update-state')).toBe(true);
  const info = { version: '1.0.10', currentVersion: '1.0.9', notes: null, date: null, critical: false, downloadPage: null, size: null };
  const state = (phase: 'installing' | 'ready') => ({ mode: 'install', reason: null, currentVersion: '1.0.9', phase: { phase, update: info }, checkedAt: null });
  await tauri.emitFromBackend('abs-update-state', state('installing'));
  await expect(page.getByText('Installing the update', { exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(app.elementsOn(0)).toHaveCount(1);
  await tauri.emitFromBackend('abs-update-state', state('ready'));
  await expect(page.getByText('Installing the update', { exact: true })).toHaveCount(0);
  await app.undoButton.click();
  await expect(app.elementsOn(0)).toHaveCount(0);
});

test('a native close is cancelled if the latest edits cannot be saved', async ({ app, page, isDesktop, tauri }) => {
  test.skip(!isDesktop, 'native close requests exist only in the desktop shell');
  await app.startBlankProject();
  await app.ensurePaletteOpen();
  await app.addElementFrom('Basic', 'Text', 'basic:text');
  await waitForProject(page, (row) => JSON.stringify(row.projectData).includes('New Text'));
  await failProjectWrites(page, true);
  await app.textContentInput.fill('閉じる前に復旧する変更');
  await app.textContentInput.blur();
  await expect(page.locator('[data-save-recovery]')).toBeVisible();
  await expect.poll(async () => (await tauri.callsTo('plugin:event|listen')).some(call => call.args.event === 'tauri://close-requested')).toBe(true);
  await tauri.emitFromBackend('tauri://close-requested', null);
  await expect(page.getByText('Keep this window open', { exact: true })).toBeVisible();
  expect(await tauri.callsTo('plugin:window|destroy')).toHaveLength(0);
  await expect(app.board(0).locator('[data-text-body="true"]')).toHaveText('閉じる前に復旧する変更');
  await failProjectWrites(page, false);
});
