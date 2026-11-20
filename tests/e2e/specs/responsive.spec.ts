import { test, expect } from '../fixtures/test';
import { canvasBottomBarsOverlap } from '../helpers/canvas';
import { put, waitForProject } from '../fixtures/db';

const SIZES = [
  { width: 1600, height: 1000 },
  { width: 1440, height: 900 },
  { width: 1180, height: 820 },
  { width: 1080, height: 810 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
];

test('canvas controls remain separate at desktop, tablet and phone widths', async ({ app, page }) => {
  await app.startBlankProject();
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await expect(page.locator('[data-canvas-tools]')).toBeVisible();
    await expect(page.locator('[data-canvas-zoom]')).toBeVisible();
    await expect.poll(() => canvasBottomBarsOverlap(page), { message: String(size.width) }).toBe(false);
    const hiddenByAnotherControl = await page.locator('[data-canvas-controls] button:enabled').evaluateAll((buttons) =>
      buttons.filter((button) => {
        const rect = button.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return !hit || !button.contains(hit);
      }).map((button) => button.getAttribute('title') || button.textContent)
    );
    expect(hiddenByAnotherControl, String(size.width)).toEqual([]);
  }
});

test('Undo, Redo and zoom accept real clicks at a small laptop width', async ({ app, page }) => {
  await page.setViewportSize({ width: 1080, height: 810 });
  await app.startBlankProject();
  await app.ensurePaletteOpen();
  await app.addElementFrom('Basic', 'Text', 'basic:text');
  await app.undoButton.click();
  await expect(app.elementsOn(0)).toHaveCount(0);
  await app.redoButton.click();
  await expect(app.elementsOn(0)).toHaveCount(1);
  const before = await app.zoomLevel();
  await app.zoomOutButton.click();
  expect(await app.zoomLevel()).toBeLessThan(before);
  await app.zoomInButton.click();
  expect(await app.zoomLevel()).toBe(before);
});

test('a long project name and motion timeline stay clear of the canvas controls', async ({ app, page }, testInfo) => {
  await app.startBlankProject();
  await app.ensurePaletteOpen();
  await app.addElementFrom('Basic', 'Text', 'basic:text');
  const stored = await waitForProject(page, row => JSON.stringify(row.projectData).includes('New Text'));
  const boards = JSON.parse(JSON.stringify(stored.projectData));
  boards[0].previewDurationSeconds = 3;
  boards[0].elements[0].animation = { enter: 'fade', enterDelay: 0, enterDuration: 0.2 };
  await put(page, 'projects', { ...stored, timestamp: new Date(), name: 'とても長いプロジェクト名・日本語とEnglishを含むストア画像の最終確認用プロジェクト', projectData: boards });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await app.waitForBoot();
  const timeline = page.locator('[data-preview-timeline]');
  await expect(timeline).toBeVisible();
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await expect.poll(async () => {
      const controls = await page.locator('[data-canvas-controls]').boundingBox();
      const track = await timeline.boundingBox();
      return !!controls && !!track && track.y + track.height <= controls.y;
    }, { message: String(size.width) }).toBe(true);
    if (size.width >= 768) {
      const name = page.getByTitle('Double-click to rename project');
      await expect(name).toBeVisible();
      const fits = await name.evaluate(element => {
        const text = element.getBoundingClientRect();
        const footer = element.closest('[data-canvas-controls]')!;
        const overlaps = (other: Element) => {
          const box = other.getBoundingClientRect();
          return text.left < box.right && text.right > box.left && text.top < box.bottom && text.bottom > box.top;
        };
        return [...footer.querySelectorAll('[data-canvas-tools], [data-canvas-zoom]')].every(other => !overlaps(other));
      });
      expect(fits, String(size.width)).toBe(true);
    }
  }
  await page.screenshot({ path: testInfo.outputPath('timeline-controls-phone.png') });
});

test.describe('touch controls', () => {
  test.use({ hasTouch: true });
  test('Undo, Redo and zoom accept finger taps on a phone', async ({ app, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await app.startBlankProject();
    await app.ensurePaletteOpen();
    await app.addElementFrom('Basic', 'Text', 'basic:text');
    const palette = page.locator('[data-mobile="true"][data-sidebar="sidebar"]');
    if (await palette.isVisible()) {
      const viewport = page.viewportSize()!;
      await page.touchscreen.tap(viewport.width - 8, viewport.height / 2);
      await expect(palette).toBeHidden();
    }
    const tap = async (button: import('@playwright/test').Locator) => {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
    };
    await tap(app.undoButton);
    await expect(app.elementsOn(0)).toHaveCount(0);
    await tap(app.redoButton);
    await expect(app.elementsOn(0)).toHaveCount(1);
    const before = await app.zoomLevel();
    await tap(app.zoomOutButton);
    expect(await app.zoomLevel()).toBeLessThan(before);
    await tap(app.zoomInButton);
    expect(await app.zoomLevel()).toBe(before);
  });
});
