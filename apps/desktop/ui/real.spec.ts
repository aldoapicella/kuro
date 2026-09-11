import { _electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, realpath, rm, writeFile, copyFile, readFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../package.json', import.meta.url));
const executablePath: string = process.env.KURO_GUI_EXECUTABLE ?? require('electron');
const workspace = resolve(import.meta.dirname, '../../..');
const entryPath = process.env.KURO_GUI_HOST ?? join(workspace, 'build/desktop/host/main.js');
const packaged = Boolean(process.env.KURO_GUI_EXECUTABLE);
const lanPortBase = Number(process.env.KURO_GUI_PORT_BASE ?? '42980');
const execute = promisify(execFile);
const profileDirectory = (directory: string, profile: string) => join(directory, 'KURO', 'real', profile);

test.skip(process.env.KURO_REAL_GUI !== '1', 'Trusted qualified macOS arm64 run with actual QVAC and Bare; not a scripted CI substitute.');
test.setTimeout(300_000);

async function launch(directory: string, profile: 'A' | 'B', replacement = false) {
  const binary = replacement && process.env.KURO_GUI_REPLACEMENT_EXECUTABLE ? process.env.KURO_GUI_REPLACEMENT_EXECUTABLE : executablePath;
  await access(packaged ? binary : entryPath);
  const entry = join(directory, `entry-${profile}.mjs`);
  // Infrastructure only: fresh appData and automated native file/verification
  // choices. Every product mutation is triggered by a visible GUI control.
  // Automated consent does not establish a human semantic review.
  await writeFile(entry, `import { app, dialog } from 'electron';
app.setPath('appData', ${JSON.stringify(directory)});
globalThis.kuroTestDialogs = { open: [], save: [], confirmations: [] };
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.kuroTestDialogs.open.shift()] });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: globalThis.kuroTestDialogs.save.shift() });
dialog.showMessageBox = async (_window, options) => { globalThis.kuroTestDialogs.confirmations.push(options); return { response: 1, checkboxChecked: false }; };
await import(${JSON.stringify(pathToFileURL(entryPath).href)});
`);
  const cleanHome = join(directory, 'clean-home'); await mkdir(cleanHome, { recursive: true });
  const runtime = await _electron.launch({ executablePath: binary,
    args: [...(packaged ? [] : [entry]), `--profile=${profile}`, `--user-data-dir=${profileDirectory(directory, profile)}`],
    env: { ...process.env, ...(process.env.KURO_GUI_CLEAN_HOME === '1' ? { HOME: cleanHome } : {}), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 60_000 });
  try {
    const page = await runtime.firstWindow(); page.setDefaultTimeout(15_000);
    if (packaged) await runtime.evaluate(({ dialog }) => {
      // Native chooser automation is installed by Playwright, never shipped as a product API.
      const choices = { open: [] as string[], save: [] as string[], confirmations: [] as unknown[] };
      Object.assign(globalThis, { kuroTestDialogs: choices });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [choices.open.shift()!] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: choices.save.shift()! });
      dialog.showMessageBox = async (...args: unknown[]) => { choices.confirmations.push(args.at(-1)); return { response: 1, checkboxChecked: false }; };
    });
    await expect(page.getByRole('button', { name: 'Setup', exact: true })).toBeVisible();
    return { runtime, page };
  } catch (error) { await runtime.close(); throw error; }
}
async function observe(runtime: ElectronApplication, dropAck = false) {
  await runtime.evaluate(async ({ app }, options) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const require = createRequire(`${app.isPackaged ? app.getAppPath() : options.stage}/package.json`);
    const { HyperDhtTransport } = require('@kuro/transport');
    const { QvacClient } = require('@kuro/ai');
    const observations = { approved: [] as string[], droppedAcks: 0, modelLoads: 0, inference: 0 };
    Object.assign(globalThis, { kuroTestObservations: observations });
    const send = HyperDhtTransport.prototype.send;
    HyperDhtTransport.prototype.send = async function(peer: string, bytes: Uint8Array) {
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (parsed.type === 'APPROVED_RESPONSE') observations.approved.push(Buffer.from(bytes).toString('base64'));
      if (parsed.type === 'RESPONSE_ACK' && options.dropAck) { observations.droppedAcks++; return; }
      return send.call(this, peer, bytes);
    };
    for (const method of ['ensureEmbeddingModelLoaded', 'ensureGenerationModelLoaded', 'embedTexts', 'runCompletion']) {
      const original = QvacClient.prototype[method];
      QvacClient.prototype[method] = function(...args: unknown[]) {
        if (method.startsWith('ensure')) observations.modelLoads++; else observations.inference++;
        return original.apply(this, args);
      };
    }
  }, { stage: join(workspace, 'build/desktop'), dropAck });
}
async function observations(runtime: ElectronApplication) {
  return runtime.evaluate(() => (globalThis as unknown as { kuroTestObservations: { approved: string[]; droppedAcks: number; modelLoads: number; inference: number } }).kuroTestObservations);
}
async function inspect(runtime: ElectronApplication) {
  return runtime.evaluate(async ({ app }) => {
    // Read-only durability observation: this never seeds or changes application state.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(`${app.getPath('userData')}/kuro.sqlite`, { readOnly: true });
    try { return {
      inbox: db.prepare('SELECT response_id,digest,hex(bytes) AS bytes FROM inbox').all(),
      outbox: db.prepare('SELECT state,attempts FROM outbox').all(),
      jobs: db.prepare('SELECT kind,state,error_code FROM jobs').all(),
      approvals: db.prepare('SELECT digest,hex(bytes) AS bytes FROM approvals').all(),
      summaries: db.prepare('SELECT state,error_code FROM summaries').all(),
    }; } finally { db.close(); }
  });
}
async function evidence(page: Page, text: string) {
  await navigate(page, 'Evidence');
  await page.getByRole('button', { name: /^Open evidence / }).click({ timeout: 60_000 });
  await expect(page.getByRole('blockquote').filter({ hasText: text })).toBeVisible();
}
async function refreshSpace(page: Page) {
  await navigate(page, 'Spaces');
  await page.getByRole('button', { name: 'Refresh shared space', exact: true }).click();
  await expect(page.getByText(/^CURRENT · remaining/)).toBeVisible({ timeout: 60_000 });
}
async function choose(runtime: ElectronApplication, kind: 'open' | 'save', path: string) {
  await runtime.evaluate((_electron, choice) => {
    const globals = globalThis as unknown as { kuroTestDialogs: { open: string[]; save: string[] } };
    globals.kuroTestDialogs[choice.kind].push(choice.path);
  }, { kind, path });
}
async function navigate(page: Page, name: string) { await page.getByRole('button', { name, exact: true }).click(); }

// Initial real host check is intentionally model-free. The complete custody
// case below will provision only verified model files, never application state.
test('fresh real GUI configures a protected identity, persists and restarts without models', async ({}, testInfo) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kuro-real-setup-')));
  let runtime: ElectronApplication | undefined;
  try {
    const launched = await launch(directory, 'A'); runtime = launched.runtime; const page = launched.page;
    await expect(page.getByText(/os-protected/)).toBeVisible();
    await expect(page.getByText(/native/)).toBeVisible();
    await testInfo.attach('fresh-setup', { body: await page.screenshot(), contentType: 'image/png' });
    console.log(await page.locator('main').innerText());
    // Controls are selected from their visible accessible labels, never AppPort.
    await page.getByLabel('Device name', { exact: true }).fill('Synthetic owner');
    await page.getByLabel('Private bootstrap host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Bootstrap port', { exact: true }).fill('42971');
    await page.getByLabel('Local UDP port', { exact: true }).fill('42972');
    await page.getByLabel(/Host.*LAN/).check();
    await page.getByLabel('LAN bootstrap address', { exact: true }).selectOption('127.0.0.1');
    await page.getByRole('button', { name: 'Save profile and start workspace', exact: true }).click();
    await expect(page.getByText(/Runtime: running/)).toBeVisible({ timeout: 60_000 });
    await navigate(page, 'Models');
    await expect(page.getByText(/missing · 0%/)).toHaveCount(2);
    await navigate(page, 'Overview');
    await expect(page.getByText(/0 documents/)).toBeVisible();
    await runtime.close(); runtime = undefined;
    const reopened = await launch(directory, 'A', true); runtime = reopened.runtime;
    await navigate(reopened.page, 'Setup');
    await expect(reopened.page.getByText(/Runtime: running/)).toBeVisible();
    await expect(reopened.page.getByLabel('Device name', { exact: true })).toHaveValue('Synthetic owner');
    await testInfo.attach('reopened-setup', { body: await reopened.page.screenshot(), contentType: 'image/png' });
  } finally { await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('real GUI explicitly downloads, cancels, retries and verifies the pinned models', async ({}, testInfo) => {
  test.skip(process.env.KURO_GUI_DOWNLOAD_MODELS !== '1', 'Explicit trusted release test downloads 1.73 GB through GUI.');
  test.setTimeout(900_000);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kuro-real-download-')));
  let runtime: ElectronApplication | undefined;
  try {
    const opened = await launch(directory, 'A'); runtime = opened.runtime;
    await navigate(opened.page, 'Models');
    await expect(opened.page.getByText(/Free disk space: [0-9]+ MB/)).toBeVisible();
    const facts = [];
    for (const [kind, digest] of [
      ['embedding', '939f1fb3fcc70f2a250a7e7ad7c2fbdc1397d46f9a8055d053e451829c5293fb'],
      ['summary', 'c876f159707a4e4f70e045106c69db15bfc935a4981706fd4f65c6e7ea1e81c5'],
    ] as const) {
      await opened.page.getByRole('button', { name: `Prepare ${kind} model`, exact: true }).click();
      await expect(opened.page.getByText(/downloading · [0-9]+% · [1-9][0-9]* \/ /)).toBeVisible({ timeout: 120_000 });
      await opened.page.getByRole('button', { name: `Cancel ${kind} download`, exact: true }).click();
      await expect(opened.page.getByText(/cancelled · /)).toBeVisible();
      const started = performance.now();
      await opened.page.getByRole('button', { name: `Prepare ${kind} model`, exact: true }).click();
      const ready = kind === 'embedding' ? 1 : 2;
      await expect(opened.page.getByText(/ready · 100%/)).toHaveCount(ready, { timeout: 600_000 });
      const path = join(profileDirectory(directory, 'A'), 'models', `${kind}.gguf`);
      const hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
      expect(hash.digest('hex')).toBe(digest);
      facts.push({ kind, sha256: digest, bytes, downloadAndVerificationMs: performance.now() - started, cancelledAndRetried: true });
    }
    await opened.page.screenshot({ path: testInfo.outputPath('explicit-downloads-verified.png') });
    await writeFile(testInfo.outputPath('model-preparation.json'), JSON.stringify({ packaged, source: 'fixed product HTTPS URLs; actual GUI transfers, no seeded weights', models: facts }, null, 2));
    await runtime.close(); runtime = undefined;
    const reopened = await launch(directory, 'A'); runtime = reopened.runtime;
    await navigate(reopened.page, 'Models');
    await expect(reopened.page.getByText(/ready · 100%/)).toHaveCount(2, { timeout: 30_000 });
  } finally { await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
});

const allCapabilities = ['search', 'read', 'share', 'receive', 'manage'];
async function setCapabilities(page: Page, group: string, actions: string[]) {
  const field = page.getByRole('group', { name: group, exact: true });
  for (const action of allCapabilities) await field.getByRole('checkbox', { name: action, exact: true }).setChecked(actions.includes(action));
}
async function setup(page: Page, name: string, port: number, host: boolean) {
  await page.getByLabel('Device name', { exact: true }).fill(name);
  await page.getByLabel('Private bootstrap host', { exact: true }).fill('127.0.0.1');
  await page.getByLabel('Bootstrap port', { exact: true }).fill(String(lanPortBase + 1));
  await page.getByLabel('Local UDP port', { exact: true }).fill(String(port));
  await page.getByLabel('Host a private LAN bootstrap', { exact: true }).setChecked(host);
  if (host) await page.getByLabel('LAN bootstrap address', { exact: true }).selectOption('127.0.0.1');
  await page.getByRole('button', { name: 'Save profile and start workspace', exact: true }).click();
  await expect(page.getByText('Runtime: running', { exact: true })).toBeVisible({ timeout: 60_000 });
}
async function localGrant(page: Page, memberId: string, actions: string[]) {
  const row = page.locator('div.source').filter({ has: page.getByLabel(`Admit ${memberId}`, { exact: true }) });
  await row.getByLabel(`Admit ${memberId}`, { exact: true }).check();
  await setCapabilities(page, `Local actions for ${memberId}`, actions);
  await row.getByRole('button', { name: 'Save local grant', exact: true }).click();
  await expect(page.getByRole('status', { includeHidden: true })).not.toHaveText(/^(ACCESS_DENIED|STALE_REVISION|INVALID_INPUT)$/);
}
async function importText(runtime: ElectronApplication, page: Page, path: string) {
  await navigate(page, 'Import');
  const previous = await page.locator('main').innerText();
  await choose(runtime, 'open', path);
  await page.getByRole('button', { name: 'Choose text file and import', exact: true }).click();
  await expect.poll(async () => (await page.locator('main').innerText()).match(/[a-f0-9]{32} · /g)?.length ?? 0).toBeGreaterThan(previous.match(/[a-f0-9]{32} · /g)?.length ?? 0);
  const next = await page.locator('main').innerText();
  return [...next.matchAll(/([a-f0-9]{32}) · /g)].map(item => item[1]!).find(id => !previous.includes(id))!;
}

test('two real GUI processes complete explicit custody and QVAC summary with restricted and cross-space exclusion', async ({}, testInfo) => {
  test.skip(!process.env.KURO_GUI_EMBEDDING_FILE || !process.env.KURO_GUI_SUMMARY_FILE, 'Provide verified model cache paths for this trusted actual-model test.');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kuro-real-custody-')));
  const runtimes: ElectronApplication[] = [];
  const rootPids = new Set<number>();
  const track = (runtime: ElectronApplication) => {
    runtimes.push(runtime);
    const child = runtime.process(), pid = child.pid;
    if (pid === undefined) throw new Error('Cannot observe the launched app process');
    rootPids.add(pid); child.once('exit', () => { rootPids.delete(pid); });
  };
  const started = performance.now();
  let peakRssBytes = 0, sampling = false, sampleError: unknown;
  const sample = async () => {
    if (sampling) return; sampling = true;
    try {
      const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,rss=']);
      const rows = stdout.trim().split('\n').map(row => {
        const fields = row.trim().split(/\s+/).map(Number);
        if (fields.length !== 3 || fields.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid process resource sample');
        return fields as [number, number, number];
      });
      const pids = new Set(rootPids);
      for (let changed = true; changed;) { changed = false; for (const [pid, parent] of rows) if (pids.has(parent) && !pids.has(pid)) { pids.add(pid); changed = true; } }
      peakRssBytes = Math.max(peakRssBytes, rows.filter(([pid]) => pids.has(pid)).reduce((sum, row) => sum + row[2]! * 1024, 0));
    } catch (error) { sampleError = error; } finally { sampling = false; }
  };
  const sampler = setInterval(() => { void sample(); }, 500);
  try {
    for (const profile of ['A', 'B']) {
      const models = join(directory, 'KURO', 'real', profile, 'models'); await mkdir(models, { recursive: true });
      await copyFile(process.env.KURO_GUI_EMBEDDING_FILE!, join(models, 'embedding.gguf'));
      await copyFile(process.env.KURO_GUI_SUMMARY_FILE!, join(models, 'summary.gguf'));
    }
    const owner = await launch(directory, 'A'); track(owner.runtime);
    await setup(owner.page, 'Synthetic custodian', lanPortBase + 2, true);
    await observe(owner.runtime);
    let requester = await launch(directory, 'B'); track(requester.runtime);
    await setup(requester.page, 'Synthetic requester', lanPortBase + 3, false);
    await observe(requester.runtime, true);
    await navigate(owner.page, 'Spaces');
    await setCapabilities(owner.page, 'Owner capabilities', allCapabilities);
    await setCapabilities(owner.page, 'Local actions', allCapabilities);
    await owner.page.getByRole('button', { name: 'Create owner space', exact: true }).click();
    const invitationPath = join(directory, 'invitation.json');
    await choose(owner.runtime, 'save', invitationPath);
    await owner.page.getByRole('button', { name: 'Export invitation', exact: true }).click();
    await expect.poll(async () => readFile(invitationPath, 'utf8').catch(() => '')).not.toBe('');
    const invitation = JSON.parse(await readFile(invitationPath, 'utf8')) as { spaceId: string; authorityKey: string };
    await navigate(requester.page, 'Spaces');
    await setCapabilities(requester.page, 'Local actions', allCapabilities);
    await choose(requester.runtime, 'open', invitationPath);
    await requester.page.getByRole('button', { name: 'Verify pairing and continue', exact: true }).click();
    const enrollmentPath = join(directory, 'enrollment.json');
    await choose(requester.runtime, 'save', enrollmentPath);
    await requester.page.getByRole('button', { name: 'Export enrollment', exact: true }).click();
    await expect.poll(async () => readFile(enrollmentPath, 'utf8').catch(() => '')).not.toBe('');
    const enrollment = JSON.parse(await readFile(enrollmentPath, 'utf8')) as { memberId: string; peerKey: string };
    await setCapabilities(owner.page, 'Owner capabilities', allCapabilities);
    await choose(owner.runtime, 'open', enrollmentPath);
    await owner.page.getByRole('button', { name: 'Verify pairing and continue', exact: true }).click();
    await navigate(owner.page, 'Permissions');
    const ownerId = await owner.page.getByLabel('Relationship source member', { exact: true }).inputValue();
    await owner.page.getByLabel('Relationship target member', { exact: true }).selectOption(enrollment.memberId);
    await owner.page.getByLabel('Relationship allowed', { exact: true }).check();
    await owner.page.getByRole('button', { name: 'Save relationship', exact: true }).click();
    await expect(owner.page.getByLabel(`Admit ${enrollment.memberId}`, { exact: true })).not.toBeChecked();
    await localGrant(owner.page, enrollment.memberId, allCapabilities);
    await navigate(requester.page, 'Spaces');
    await requester.page.getByRole('button', { name: 'Refresh shared space', exact: true }).click();
    await expect(requester.page.getByText(/^CURRENT · remaining/)).toBeVisible({ timeout: 60_000 });
    await navigate(requester.page, 'Permissions');
    await localGrant(requester.page, ownerId, ['share']);
    const permitted = 'The KURO pilot remains provisional. Final release requires explicit local review of the acceptance record.';
    const allowedPath = join(directory, 'release-note.txt'), restrictedPath = join(directory, 'restricted-note.txt');
    const otherPath = join(directory, 'other-space', 'release-note.txt');
    await mkdir(join(directory, 'other-space'));
    await writeFile(allowedPath, permitted);
    await writeFile(restrictedPath, 'RESTRICTED-SENTINEL: The confidential pilot budget is 418 credits.');
    await writeFile(otherPath, 'CROSS-SPACE-SENTINEL: The KURO pilot requires an unrelated private decision.');
    const documentId = await importText(owner.runtime, owner.page, allowedPath);
    await navigate(owner.page, 'Permissions');
    const doc = owner.page.locator('div.source').filter({ has: owner.page.getByRole('heading', { name: `Document ${documentId}`, exact: true }) });
    await doc.getByLabel('Add document rule member', { exact: true }).selectOption(enrollment.memberId);
    await doc.getByRole('group', { name: 'New document rule actions', exact: true }).getByRole('checkbox', { name: 'receive', exact: true }).check();
    await doc.getByRole('button', { name: 'Add document rule', exact: true }).click();
    await importText(owner.runtime, owner.page, restrictedPath);
    await navigate(owner.page, 'Spaces');
    await setCapabilities(owner.page, 'Owner capabilities', allCapabilities); await setCapabilities(owner.page, 'Local actions', allCapabilities);
    await owner.page.getByRole('button', { name: 'Create owner space', exact: true }).click();
    await importText(owner.runtime, owner.page, otherPath);
    await owner.page.getByLabel('Shared space', { exact: true }).selectOption(invitation.spaceId);
    await navigate(owner.page, 'Models');
    await expect(owner.page.getByText(/ready · 100%/)).toHaveCount(2);
    await owner.page.getByRole('button', { name: 'Start authorized index rebuild', exact: true }).click();
    await navigate(owner.page, 'Import');
    await expect(owner.page.getByText(`${documentId} · COMPLETE`, { exact: true })).toBeVisible({ timeout: 120_000 });
    await navigate(requester.page, 'Ask');
    await requester.page.getByLabel('Custodian', { exact: true }).selectOption(invitation.authorityKey);
    const question = 'What are the KURO pilot release conditions?';
    await requester.page.getByLabel('Question', { exact: true }).fill(question);
    const questionAt = performance.now();
    await requester.page.getByRole('button', { name: 'Send question', exact: true }).click();
    await navigate(owner.page, 'Reviews');
    await owner.page.getByRole('button', { name: question, exact: true }).click({ timeout: 120_000 });
    await expect(owner.page.getByRole('blockquote').filter({ hasText: permitted })).toBeVisible();
    await expect(owner.page.getByText(/RESTRICTED-SENTINEL|CROSS-SPACE-SENTINEL/)).toHaveCount(0);
    await expect(owner.page.getByText(`Recipient: ${enrollment.peerKey}`, { exact: true })).toBeVisible();
    await expect(owner.page.getByText(/Review revision .*digest [a-f0-9]{64}/)).toBeVisible();
    const reviewAt = performance.now();
    await owner.page.getByLabel('Allow requester-local summary', { exact: true }).check();
    await expect(owner.page.getByRole('button', { name: 'Approve exact reviewed evidence', exact: true })).toBeDisabled();
    await owner.page.getByRole('button', { name: 'Save passage selection and conditions', exact: true }).click();
    await owner.page.screenshot({ path: testInfo.outputPath('automated-test-reviewed-view.png') });
    await owner.page.getByRole('button', { name: 'Approve exact reviewed evidence', exact: true }).click();
    await navigate(requester.page, 'Evidence');
    await requester.page.getByRole('button', { name: /^Open evidence / }).click({ timeout: 60_000 });
    await expect(requester.page.getByRole('blockquote').filter({ hasText: permitted })).toBeVisible();
    await expect(requester.page.getByText(/RESTRICTED-SENTINEL|CROSS-SPACE-SENTINEL/)).toHaveCount(0);
    const receiptAt = performance.now();
    expect(await observations(requester.runtime)).toMatchObject({ modelLoads: 0, inference: 0 });
    const received = await inspect(requester.runtime), approved = await inspect(owner.runtime);
    expect(received.inbox).toHaveLength(1); expect(received.jobs).toHaveLength(0);
    expect(received.inbox[0]!.bytes).toBe(approved.approvals[0]!.bytes);
    expect(received.inbox[0]!.digest).toBe(approved.approvals[0]!.digest);
    // Fault infrastructure drops only ACKs. Actual Bare delivers every approved retry.
    await expect.poll(async () => (await observations(requester.runtime)).droppedAcks, { timeout: 30_000 }).toBeGreaterThan(1);
    expect((await inspect(requester.runtime)).inbox).toHaveLength(1);
    const sent = (await observations(owner.runtime)).approved;
    expect(sent.length).toBeGreaterThan(1); expect(new Set(sent).size).toBe(1);
    await requester.runtime.close();
    await rm(join(profileDirectory(directory, 'B'), 'models'), { recursive: true });
    requester = await launch(directory, 'B', true); track(requester.runtime);
    await observe(requester.runtime);
    await refreshSpace(requester.page);
    await evidence(requester.page, permitted);
    expect(await observations(requester.runtime)).toMatchObject({ modelLoads: 0, inference: 0 });
    expect((await inspect(requester.runtime)).inbox).toEqual(received.inbox);
    await expect.poll(async () => (await inspect(owner.runtime)).outbox[0]?.state, { timeout: 45_000 }).toBe('ACKED');
    await navigate(requester.page, 'Models');
    await expect(requester.page.getByText(/missing · 0%/)).toHaveCount(2);
    await evidence(requester.page, permitted);
    await requester.page.getByRole('button', { name: 'Request optional local summary', exact: true }).click();
    await expect.poll(async () => (await inspect(requester.runtime)).summaries[0]?.state).toBe('FAILED');
    expect((await inspect(requester.runtime)).summaries[0]?.error_code).toBe('MODEL_UNAVAILABLE');
    await evidence(requester.page, permitted);
    await requester.page.screenshot({ path: testInfo.outputPath('durable-evidence-without-models.png') });
    // Reinstall verified weights only; profile/database/permissions remain those created in GUI.
    await requester.runtime.close();
    const models = join(profileDirectory(directory, 'B'), 'models'); await mkdir(models, { recursive: true });
    await copyFile(process.env.KURO_GUI_EMBEDDING_FILE!, join(models, 'embedding.gguf'));
    await copyFile(process.env.KURO_GUI_SUMMARY_FILE!, join(models, 'summary.gguf'));
    requester = await launch(directory, 'B'); track(requester.runtime);
    await observe(requester.runtime); await refreshSpace(requester.page); await evidence(requester.page, permitted);
    const summaryStart = performance.now();
    await requester.page.getByRole('button', { name: 'Request optional local summary', exact: true }).click();
    await requester.page.getByRole('button', { name: /DRAFT/ }).click({ timeout: 120_000 });
    await expect(requester.page.getByRole('heading', { name: /Summary draft/ })).toBeVisible();
    await expect(requester.page.getByRole('blockquote')).not.toHaveCount(0);
    await expect(requester.page.getByText(/RESTRICTED-SENTINEL|CROSS-SPACE-SENTINEL/)).toHaveCount(0);
    const summaryAt = performance.now();
    await requester.page.screenshot({ path: testInfo.outputPath('actual-qvac-summary.png') });
    expect((await observations(requester.runtime)).inference).toBeGreaterThan(0);
    // Native event fault, not a physical sleep claim. Lock must clear rendered evidence.
    await requester.runtime.evaluate(({ powerMonitor }) => { powerMonitor.emit('lock-screen'); });
    await expect(requester.page.getByRole('blockquote')).toHaveCount(0);
    await requester.runtime.evaluate(({ powerMonitor }) => { powerMonitor.emit('unlock-screen'); });
    await refreshSpace(requester.page); await evidence(requester.page, permitted);
    await sample(); expect(sampleError).toBeUndefined(); expect(peakRssBytes).toBeGreaterThan(0);
    const metrics = { approval: 'automated GUI test, not human semantic review', inference: 'actual QVAC', transport: 'actual Bare/HyperDHT', topology: 'two processes on loopback, shared macOS kernel', packaged, cleanEnvironment: { isolatedUserData: true, isolatedHome: process.env.KURO_GUI_CLEAN_HOME === '1', systemOnlyPath: true, protectedStorage: 'logged-in OS keychain' }, failures: ['lost ACK', 'identical retry', 'one inbox effect', 'receiver restart', 'model-free receipt and reading', 'explicit summary without models fails', 'native lock/unlock event and fresh authority sync'], questionToReviewMs: reviewAt - questionAt, reviewToReceiptMs: receiptAt - reviewAt, explicitSummaryMs: summaryAt - summaryStart, totalMs: summaryAt - started, peakRssBytes, resourceMethod: '500ms samples of summed RSS for both app process trees; includes shared-page double counting; same Mac' };
    console.log(JSON.stringify(metrics)); await writeFile(testInfo.outputPath('metrics.json'), JSON.stringify(metrics, null, 2));
  } finally { clearInterval(sampler); for (const runtime of runtimes.reverse()) await runtime.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
