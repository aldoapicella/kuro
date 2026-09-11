import { _electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../package.json', import.meta.url));
const executablePath: string = require('electron');
const workspace = resolve(import.meta.dirname, '../../..');
const text = 'The KURO pilot remains provisional.';

async function launch(mode: 'demo' | 'core-simulated') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kuro-desktop-ui-')));
  const entry = join(directory, 'entry.mjs');
  // Test-only entry isolates appData before loading the unchanged production host.
  await writeFile(entry, `import { app } from 'electron';\napp.setPath('appData', ${JSON.stringify(directory)});\nawait import(${JSON.stringify(pathToFileURL(join(workspace, 'build/desktop/host/main.js')).href)});\n`);
  let runtime: ElectronApplication | undefined;
  try {
    runtime = await _electron.launch({ executablePath, args: [entry, `--mode=${mode}`], timeout: 30_000 });
    const errors: string[] = [];
    runtime.process().stderr?.on('data', (chunk: Buffer) => { if (/Uncaught Exception|Object has been destroyed/.test(chunk.toString())) errors.push(chunk.toString()); });
    const windowCount = mode === 'core-simulated' ? 2 : 1;
    await expect.poll(() => runtime!.windows().length).toBe(windowCount);
    for (const page of runtime.windows()) await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible();
    return { runtime, directory, errors, close: async () => {
      await runtime!.close();
      expect(errors).toEqual([]);
      await rm(directory, { recursive: true, force: true });
    } };
  } catch (error) { await runtime?.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}

async function profile(runtime: ElectronApplication, name: 'A' | 'B'): Promise<Page> {
  for (const page of runtime.windows()) if (await page.getByText(`core-simulated · Device ${name}`, { exact: true }).count()) return page;
  throw new Error(`Missing profile ${name}`);
}

test('real SQLite GUI requires revised consent before delivery and explicit summary', async () => {
  const app = await launch('core-simulated');
  try {
    const requester = await profile(app.runtime, 'A'), owner = await profile(app.runtime, 'B');
    await requester.getByRole('button', { name: 'Ask', exact: true }).click();
    await requester.getByLabel('Question', { exact: true }).fill('What are the KURO pilot release conditions?');
    await requester.getByRole('button', { name: 'Send question', exact: true }).click();
    await expect(requester.getByText(/0 evidence bundles/)).toBeVisible();
    await owner.getByRole('button', { name: 'Reviews', exact: true }).click();
    await owner.getByRole('button', { name: 'What are the KURO pilot release conditions?', exact: true }).click();
    await expect(owner.getByText(text, { exact: false })).toBeVisible();
    await expect(owner.getByText(/RESTRICTED-SENTINEL/)).toHaveCount(0);
    const approve = owner.getByRole('button', { name: 'Approve exact reviewed evidence', exact: true });
    await owner.getByLabel('Allow requester-local summary', { exact: true }).check();
    await expect(approve).toBeDisabled();
    await owner.getByRole('button', { name: 'Save passage selection and conditions', exact: true }).click();
    await expect(owner.getByLabel('Allow requester-local summary', { exact: true })).toBeChecked();
    await expect(approve).toBeEnabled();
    await approve.click();
    await requester.getByRole('button', { name: 'Evidence', exact: true }).click();
    await requester.getByRole('button', { name: /^Open evidence / }).click();
    await expect(requester.getByText(text, { exact: false })).toBeVisible();
    await requester.getByRole('button', { name: 'Request optional local summary', exact: true }).click();
    await requester.getByRole('button', { name: /DRAFT/ }).click();
    await expect(requester.getByRole('heading', { name: /Summary draft/ })).toBeVisible();
    await expect(requester.getByRole('blockquote').filter({ hasText: text })).toBeVisible();
    // The real preload must clear a mounted protected view when the host closes,
    // even though this test deliberately uses simulated AI/transport/clocks.
    await app.runtime.evaluate(({ powerMonitor }) => { powerMonitor.emit('suspend'); });
    await expect(requester.getByText(text, { exact: false })).toHaveCount(0);
    await expect(requester.getByText('Protected content paused. Reopen a view after access is restored.', { exact: true })).toBeVisible();
  } finally { await app.close(); }
});

test('visible evidence clears at its validity deadline without a committed event', async () => {
  const app = await launch('demo');
  try {
    const page = app.runtime.windows()[0]!;
    await page.clock.install();
    await page.getByRole('button', { name: 'Evidence', exact: true }).click();
    await page.getByRole('button', { name: /^Open evidence / }).click();
    await expect(page.getByText(text, { exact: false })).toBeVisible();
    await page.clock.fastForward(3_700_000);
    await expect(page.getByText(text, { exact: false })).toHaveCount(0);
  } finally { await app.close(); }
});

test('open evidence and summary are cleared when public simulated authority expires', async () => {
  const app = await launch('demo');
  try {
    const page = app.runtime.windows()[0]!;
    await page.getByRole('button', { name: 'Evidence', exact: true }).click();
    await page.getByRole('button', { name: /^Open evidence / }).click();
    await expect(page.getByText(text, { exact: false })).toBeVisible();
    await page.evaluate(() => window.kuro.host.setScenario({ scenario: 'expired' }));
    await expect(page.getByText(text, { exact: false })).toHaveCount(0);
    await page.evaluate(() => window.kuro.host.setScenario({ scenario: 'ready' }));
    await page.getByRole('button', { name: 'Evidence', exact: true }).click();
    await page.getByRole('button', { name: /^Open evidence / }).click();
    await page.getByRole('button', { name: 'Request optional local summary', exact: true }).click();
    await page.getByRole('button', { name: /DRAFT/ }).click();
    await expect(page.getByText(text, { exact: false })).toBeVisible();
    await page.evaluate(() => window.kuro.host.setScenario({ scenario: 'expired' }));
    await expect(page.getByText(text, { exact: false })).toHaveCount(0);
  } finally { await app.close(); }
});
