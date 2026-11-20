import { test, expect } from '../fixtures/test';

const credential = 'Bearer fixture_mcp_credential_not_for_production';
test.use({
  tauriConfig: { responses: {
    abs_mcp_status: { running: true, port: 8722, url: 'http://127.0.0.1:8722/mcp' },
    abs_mcp_connection_config: { url: 'http://127.0.0.1:8722/mcp', headers: { Authorization: credential }, headerFile: '/private/fixture/mcp-auth-headers' },
  } },
});

test('MCP setup reads credentials only on copy and never renders them', async ({ app, page, tauri, isDesktop }) => {
  test.skip(!isDesktop, 'The native connection dialog needs the desktop runtime');
  await app.dismissStartDialog();
  await page.getByTitle('MCP server, click for connection details and tools', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Native clients need the authenticated settings below');
  expect(await tauri.callsTo('abs_mcp_connection_config')).toHaveLength(0);
  await expect(page.locator('body')).not.toContainText(credential);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as any).__copiedMcpConfig = text; },
    } });
  });
  await dialog.getByTitle('Copy snippet', { exact: true }).first().click();
  await expect.poll(async () => (await tauri.callsTo('abs_mcp_connection_config')).length).toBe(1);
  const copied = await page.evaluate(() => (window as any).__copiedMcpConfig);
  expect(JSON.parse(copied).mcpServers['tiger-screen-shot'].headers.Authorization).toBe(credential);
  await expect(page.locator('body')).not.toContainText(credential);
});

test('a clipboard failure does not expose MCP credentials in a toast', async ({ app, page, isDesktop }) => {
  test.skip(!isDesktop, 'The native connection dialog needs the desktop runtime');
  await app.dismissStartDialog();
  await page.getByTitle('MCP server, click for connection details and tools', { exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async () => { throw new Error('denied'); },
    } });
  });
  await page.getByRole('dialog').getByTitle('Copy snippet', { exact: true }).first().click();
  await expect(page.getByText('Check clipboard access and try again', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(credential);
});
