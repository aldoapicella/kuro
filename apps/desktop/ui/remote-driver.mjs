#!/usr/bin/env node
// Guest-local driver for the qualified offline LAN run. It intentionally has no
// product API access: all mutations use visible controls, with only native file
// chooser shims and read-only SQLite inspection installed in Electron main.
import { _electron } from '@playwright/test';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
const ALL = ['search', 'read', 'share', 'receive', 'manage'];
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (!match) throw new Error(`Expected --name=value, got ${arg}`);
  return [match[1], match[2]];
}));
if (!args.executable || !args.directory || !args.evidence || !['A', 'B'].includes(args.profile)) {
  throw new Error('Usage: remote-driver.mjs --executable=/abs/KURO.app/.../kuro --profile=A|B --directory=/abs/test-data --evidence=/abs/evidence');
}
const executable = resolve(args.executable), directory = await realpath(resolve(args.directory)), evidenceDirectory = resolve(args.evidence);
const profile = args.profile;
const profileDirectory = join(directory, 'KURO', 'real', profile);
let runtime;
let page;
let screenshotNumber = 0;
let setupComplete = false;
let closing;
let initialProfileWasFresh;

function log(message, extra) { process.stderr.write(`[kuro-gui-${profile}] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}\n`); }
function fail(message) { throw new Error(message); }
async function waitForText(text, timeout = 60_000) { await page.getByText(text).waitFor({ state: 'visible', timeout }); }
async function navigate(name) {
  await page.getByRole('button', { name, exact: true }).click();
  if (name === 'Setup') await page.getByText('KURO setup', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 });
  else await page.locator('main').locator('h1').filter({ hasText: name }).waitFor({ state: 'visible', timeout: 60_000 });
}
async function screenshot(label) {
  await mkdir(evidenceDirectory, { recursive: true });
  const path = join(evidenceDirectory, `${String(++screenshotNumber).padStart(2, '0')}-${profile}-${label}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}
async function installTestSeams() {
  await runtime.evaluate(({ dialog }) => {
    const choices = { open: [], save: [], confirmations: [] };
    Object.assign(globalThis, { kuroTestDialogs: choices });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [choices.open.shift()] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: choices.save.shift() });
    dialog.showMessageBox = async (...values) => { choices.confirmations.push(values.at(-1)); return { response: 1, checkboxChecked: false }; };
  });
}
async function choose(kind, path) {
  await runtime.evaluate((_electron, choice) => globalThis.kuroTestDialogs[choice.kind].push(choice.path), { kind, path });
}
async function observe(dropAck = false) {
  await runtime.evaluate(async ({ app }, option) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const requireFromApp = createRequire(`${app.getAppPath()}/package.json`);
    const { HyperDhtTransport } = requireFromApp('@kuro/transport');
    const { QvacClient } = requireFromApp('@kuro/ai');
    const key = Symbol.for('kuro.remote-driver.observer');
    const existing = globalThis[key];
    if (existing) { existing.dropAck = option.dropAck; return; }
    const state = { dropAck: option.dropAck, observations: { approved: [], droppedAcks: 0, modelLoads: 0, inference: 0 } };
    Object.assign(globalThis, { kuroTestObservations: state.observations });
    Object.defineProperty(globalThis, key, { value: state, configurable: true });
    const send = HyperDhtTransport.prototype.send;
    HyperDhtTransport.prototype.send = async function(peer, bytes) {
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (parsed.type === 'APPROVED_RESPONSE') state.observations.approved.push(Buffer.from(bytes).toString('base64'));
      if (parsed.type === 'RESPONSE_ACK' && state.dropAck) { state.observations.droppedAcks++; return; }
      return send.call(this, peer, bytes);
    };
    for (const method of ['ensureEmbeddingModelLoaded', 'ensureGenerationModelLoaded', 'embedTexts', 'runCompletion']) {
      const original = QvacClient.prototype[method];
      QvacClient.prototype[method] = function(...methodArgs) { if (method.startsWith('ensure')) state.observations.modelLoads++; else state.observations.inference++; return original.apply(this, methodArgs); };
    }
  }, { dropAck });
}
async function observations() { return runtime.evaluate(() => globalThis.kuroTestObservations); }
async function waitForValue(read, matches, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    if (Date.now() >= deadline) fail(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function inspect() {
  return runtime.evaluate(async ({ app }) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(`${app.getPath('userData')}/kuro.sqlite`, { readOnly: true });
    try { return {
      inbox: db.prepare('SELECT response_id,digest,hex(bytes) AS bytes FROM inbox').all(),
      outbox: db.prepare('SELECT state,attempts FROM outbox').all(),
      jobs: db.prepare('SELECT kind,state,error_code FROM jobs').all(),
      approvals: db.prepare('SELECT digest,view_digest,hex(bytes) AS bytes FROM approvals').all(),
      summaries: db.prepare('SELECT state,error_code FROM summaries').all(),
    }; } finally { db.close(); }
  });
}
async function delivery(input = {}) {
  let db = await inspect();
  let observed = await observations();
  const minApprovedSends = Number(input.minApprovedSends ?? 0);
  if (!Number.isSafeInteger(minApprovedSends) || minApprovedSends < 0) fail('minApprovedSends must be a non-negative integer');
  if (minApprovedSends) observed = await waitForValue(observations, value => value.approved.length >= minApprovedSends, `${minApprovedSends} approved sends`);
  if (input.requireAcked) db = await waitForValue(inspect, value => value.outbox.some(row => row.state === 'ACKED'), 'ACKED owner outbox', 45_000);
  const approvedSends = observed.approved.map(bytes => ({ bytes, digest: createHash('sha256').update(Buffer.from(bytes, 'base64')).digest('hex') }));
  if (approvedSends.length && new Set(approvedSends.map(item => item.bytes)).size !== 1) fail('Approved retries did not preserve exact bytes');
  return { delivery: db, observations: { ...observed, approved: approvedSends } };
}
async function waitForRecord(path) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const details = await stat(path);
      if (details.isFile() && details.size > 0) return JSON.parse(await readFile(path, 'utf8'));
    } catch {}
    if (Date.now() >= deadline) fail(`Exported record was not created: ${path}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
function processId() {
  const pid = runtime?.process().pid;
  if (!Number.isSafeInteger(pid) || pid < 1) fail('Cannot observe the launched app process');
  return pid;
}
async function closeRuntime() {
  if (closing) return closing;
  if (!runtime) return;
  const active = runtime;
  runtime = undefined; page = undefined;
  closing = active.close().finally(() => { closing = undefined; });
  return closing;
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function profileWasFresh() {
  if (await exists(join(profileDirectory, 'profile.json')) || await exists(join(profileDirectory, 'kuro.sqlite'))) return false;
  try { return !(await readdir(join(profileDirectory, 'secrets'))).some(name => name.endsWith('.sealed')); }
  catch { return true; }
}
async function setCapabilities(group, actions) {
  const field = page.getByRole('group', { name: group, exact: true });
  for (const action of ALL) await field.getByRole('checkbox', { name: action, exact: true }).setChecked(actions.includes(action));
}
async function localGrant(memberId, actions) {
  const row = page.locator('div.source').filter({ has: page.getByLabel(`Admit ${memberId}`, { exact: true }) });
  await row.getByLabel(`Admit ${memberId}`, { exact: true }).check();
  await setCapabilities(`Local actions for ${memberId}`, actions);
  await row.getByRole('button', { name: 'Save local grant', exact: true }).click();
  await page.getByRole('status', { includeHidden: true }).filter({ hasText: /^(ACCESS_DENIED|STALE_REVISION|INVALID_INPUT)$/ }).waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
}
async function refreshSpace() {
  await navigate('Spaces');
  await page.getByRole('button', { name: 'Refresh shared space', exact: true }).click();
  await page.getByText(/^CURRENT · remaining/).waitFor({ state: 'visible', timeout: 60_000 });
}
async function selectSpace(spaceId) {
  if (typeof spaceId !== 'string' || !/^[a-f0-9]{32}$/.test(spaceId)) fail('Expected exact shared space id');
  await page.getByLabel('Shared space', { exact: true }).selectOption(spaceId);
}
async function importText(path) {
  await navigate('Import');
  const before = await page.locator('main').innerText();
  await choose('open', path);
  await page.getByRole('button', { name: 'Choose text file and import', exact: true }).click();
  await page.waitForFunction(previous => document.querySelector('main')?.innerText !== previous, before, { timeout: 60_000 });
  const after = await page.locator('main').innerText();
  const ids = [...after.matchAll(/([a-f0-9]{32}) · /g)].map(match => match[1]);
  return ids.find(id => !before.includes(id)) ?? fail('GUI import did not expose a new document id');
}
async function verifyLiteralCitation(documentId, text) {
  const quote = page.getByRole('blockquote').filter({ hasText: text }).first();
  await quote.waitFor({ state: 'visible', timeout: 60_000 });
  const literal = await quote.innerText();
  if (literal !== text && literal !== `${text}\n`) fail(`Expected permitted quote was not preserved literally: ${JSON.stringify(literal)}`);
  const citation = quote.locator('xpath=following-sibling::code[1]');
  const raw = await citation.innerText();
  let reference;
  try { reference = JSON.parse(raw); } catch { fail('Expected literal citation is not valid JSON'); }
  if (reference.documentId !== documentId || typeof reference.spanId !== 'string') fail('Expected literal citation for the permitted document is absent');
  return { quote: literal, reference };
}
async function openEvidence(input) {
  await navigate('Evidence'); await page.getByRole('button', { name: /^Open evidence / }).click({ timeout: 60_000 });
  const text = await page.locator('main').innerText();
  if (/RESTRICTED-SENTINEL|CROSS-SPACE-SENTINEL/.test(text)) fail('Excluded sentinel reached evidence GUI');
  if (typeof input.allowedText !== 'string' || typeof input.allowedDocumentId !== 'string') fail('Evidence requires allowedText and allowedDocumentId');
  const citation = await verifyLiteralCitation(input.allowedDocumentId, input.allowedText);
  const minDroppedAcks = Number(input.minDroppedAcks ?? 0);
  if (!Number.isSafeInteger(minDroppedAcks) || minDroppedAcks < 0) fail('minDroppedAcks must be a non-negative integer');
  let observed = await observations();
  if (minDroppedAcks) observed = await waitForValue(observations, value => value.droppedAcks >= minDroppedAcks, `${minDroppedAcks} dropped ACKs`);
  const delivery = await inspect();
  if (delivery.inbox.length !== 1 || delivery.jobs.length !== 0 || observed.modelLoads !== 0 || observed.inference !== 0 || observed.droppedAcks < minDroppedAcks) fail('Receipt must persist exactly one evidence bundle without a model load or inference');
  return { delivery, observations: observed, literalCitation: true, citation, screenshot: await screenshot('evidence') };
}
async function start() {
  if (runtime) return { profile, running: true };
  await access(executable); await mkdir(evidenceDirectory, { recursive: true });
  if (initialProfileWasFresh === undefined) initialProfileWasFresh = await profileWasFresh();
  runtime = await _electron.launch({ executablePath: executable, args: [`--profile=${profile}`, `--user-data-dir=${profileDirectory}`], env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 60_000 });
  try {
    page = await runtime.firstWindow(); page.setDefaultTimeout(20_000);
    await installTestSeams();
    await page.getByRole('button', { name: 'Setup', exact: true }).waitFor({ state: 'visible' });
    await navigate('Setup');
    await page.getByText(/(?:Secret|Key) protection: os-protected/).waitFor({ state: 'visible' });
    await page.getByText(/Clock protection: native/).waitFor({ state: 'visible' });
    const setupText = await page.locator('main').innerText();
    if (!/os-protected/.test(setupText) || !/native/.test(setupText)) fail('Qualified macOS protected-storage/native-clock UI proof is missing');
    if (setupComplete) await observe(false);
    const stage = await screenshot('start');
    return { profile, protectedSetup: true, processId: processId(), screenshot: stage };
  } catch (error) { await closeRuntime().catch(() => {}); throw error; }
}
async function command(action, input = {}) {
  if (action !== 'start' && !runtime) fail('Call start before product actions');
  switch (action) {
    case 'start': return start();
    case 'setup': {
      await page.getByLabel('Device name', { exact: true }).fill(input.displayName);
      await page.getByLabel('Private bootstrap host', { exact: true }).fill(input.bootstrapHost);
      await page.getByLabel('Bootstrap port', { exact: true }).fill(String(input.bootstrapPort));
      await page.getByLabel('Local UDP port', { exact: true }).fill(String(input.localPort));
      await page.getByLabel('Host a private LAN bootstrap', { exact: true }).setChecked(Boolean(input.host));
      if (input.host) await page.getByLabel('LAN bootstrap address', { exact: true }).selectOption(input.lanAddress);
      await page.getByRole('button', { name: 'Save profile and start workspace', exact: true }).click();
      await waitForText('Runtime: running');
      await observe(false); setupComplete = true;
      return { freshPeerStartup: initialProfileWasFresh === true, processId: processId(), screenshot: await screenshot('setup'), runtime: 'running' };
    }
    case 'owner-create-space': {
      await navigate('Spaces'); await setCapabilities('Owner capabilities', ALL); await setCapabilities('Local actions', ALL);
      await page.getByRole('button', { name: 'Create owner space', exact: true }).click();
      await page.getByText(/^Owner · [a-f0-9]{32}/).waitFor({ state: 'visible', timeout: 60_000 });
      const ownerText = await page.locator('main').innerText();
      const spaceId = ownerText.match(/Owner · ([a-f0-9]{32})/)?.[1] ?? fail('Owner space id absent from GUI');
      return { spaceId, screenshot: await screenshot('owner-space') };
    }
    case 'export-invitation': {
      await navigate('Spaces'); await choose('save', input.path); await page.getByRole('button', { name: 'Export invitation', exact: true }).click();
      const record = await waitForRecord(input.path);
      return { spaceId: record.spaceId, authorityKey: record.authorityKey, path: input.path, screenshot: await screenshot('invitation') };
    }
    case 'join': {
      await navigate('Spaces'); await setCapabilities('Local actions', ALL); await choose('open', input.invitationPath);
      await page.getByRole('button', { name: 'Verify pairing and continue', exact: true }).click();
      return { screenshot: await screenshot('joined') };
    }
    case 'export-enrollment': {
      await navigate('Spaces'); await choose('save', input.path); await page.getByRole('button', { name: 'Export enrollment', exact: true }).click();
      const record = await waitForRecord(input.path);
      return { memberId: record.memberId, peerKey: record.peerKey, path: input.path, screenshot: await screenshot('enrollment') };
    }
    case 'enroll': {
      await navigate('Spaces'); await setCapabilities('Owner capabilities', ALL); await choose('open', input.enrollmentPath);
      await page.getByRole('button', { name: 'Verify pairing and continue', exact: true }).click();
      return { screenshot: await screenshot('enrolled') };
    }
    case 'owner-permissions': {
      await navigate('Permissions');
      const ownerId = await page.getByLabel('Relationship source member', { exact: true }).inputValue();
      await page.getByLabel('Relationship target member', { exact: true }).selectOption(input.requesterMemberId);
      await page.getByLabel('Relationship allowed', { exact: true }).check(); await page.getByRole('button', { name: 'Save relationship', exact: true }).click();
      const admitted = page.getByLabel(`Admit ${input.requesterMemberId}`, { exact: true }); if (await admitted.isChecked()) fail('Expected default-deny local grant before explicit admission');
      await localGrant(input.requesterMemberId, ALL);
      return { ownerId, screenshot: await screenshot('owner-permissions') };
    }
    case 'requester-permissions': {
      await refreshSpace(); await navigate('Permissions'); await localGrant(input.ownerId, ['share']);
      return { screenshot: await screenshot('requester-permissions') };
    }
    case 'import-and-index': {
      const allowedId = await importText(input.allowedPath);
      await navigate('Permissions'); const doc = page.locator('div.source').filter({ has: page.getByRole('heading', { name: `Document ${allowedId}`, exact: true }) });
      await doc.getByLabel('Add document rule member', { exact: true }).selectOption(input.requesterMemberId);
      await doc.getByRole('group', { name: 'New document rule actions', exact: true }).getByRole('checkbox', { name: 'receive', exact: true }).check();
      await doc.getByRole('button', { name: 'Add document rule', exact: true }).click();
      const restrictedId = await importText(input.restrictedPath);
      await navigate('Spaces'); await setCapabilities('Owner capabilities', ALL); await setCapabilities('Local actions', ALL); await page.getByRole('button', { name: 'Create owner space', exact: true }).click();
      const otherId = await importText(input.otherNamespacePath);
      await page.getByLabel('Shared space', { exact: true }).selectOption(input.spaceId);
      await navigate('Models'); await page.getByText(/ready · 100%/).first().waitFor({ state: 'visible', timeout: 30_000 });
      await page.getByRole('button', { name: 'Start authorized index rebuild', exact: true }).click(); await navigate('Import');
      await page.getByText(`${allowedId} · COMPLETE`, { exact: true }).waitFor({ state: 'visible', timeout: 120_000 });
      return { allowedId, restrictedId, otherId, screenshot: await screenshot('indexed') };
    }
    case 'question': {
      await navigate('Ask'); await page.getByLabel('Custodian', { exact: true }).selectOption(input.custodianKey);
      await page.getByLabel('Question', { exact: true }).fill(input.question ?? 'What are the KURO pilot release conditions?');
      await page.getByRole('button', { name: 'Send question', exact: true }).click();
      await page.locator('main').locator('h1').filter({ hasText: 'Overview' }).waitFor({ state: 'visible', timeout: 60_000 });
      return { screenshot: await screenshot('question') };
    }
    case 'review-approve': {
      await navigate('Reviews'); await selectSpace(input.spaceId); const question = input.question ?? 'What are the KURO pilot release conditions?'; await page.getByRole('button', { name: question, exact: true }).click({ timeout: 120_000 });
      const body = await page.locator('main').innerText();
      if (/RESTRICTED-SENTINEL|CROSS-SPACE-SENTINEL/.test(body)) fail('Excluded sentinel reached review GUI');
      const review = /Review revision (\d+) · digest ([a-f0-9]{64})/.exec(body);
      if (!review) fail('Review revision/digest UI proof missing');
      if (typeof input.recipientKey !== 'string' || !body.includes(`Recipient: ${input.recipientKey}`)) fail('Review recipient does not match the enrolled requester');
      if (typeof input.allowedText !== 'string' || typeof input.allowedDocumentId !== 'string') fail('Review requires allowedText and allowedDocumentId');
      await verifyLiteralCitation(input.allowedDocumentId, input.allowedText);
      await page.getByLabel('Allow requester-local summary', { exact: true }).check(); await page.getByRole('button', { name: 'Save passage selection and conditions', exact: true }).click();
      const savedBody = await waitForValue(
        () => page.locator('main').innerText(),
        value => {
          const match = /Review revision (\d+) · digest ([a-f0-9]{64})/.exec(value);
          return Boolean(match && Number(match[1]) > Number(review[1]));
        },
        'saved review revision/digest',
      );
      const saved = /Review revision (\d+) · digest ([a-f0-9]{64})/.exec(savedBody);
      if (!saved) fail('Saved review revision/digest UI proof is missing');
      if (/RESTRICTED-SENTINEL|CROSS-SPACE-SENTINEL/.test(savedBody)) fail('Excluded sentinel reached saved review GUI');
      if (!savedBody.includes(`Recipient: ${input.recipientKey}`)) fail('Saved review recipient does not match the enrolled requester');
      const conditionsText = /Conditions: (\{.*\})/.exec(savedBody)?.[1];
      let conditions;
      try { conditions = JSON.parse(conditionsText); } catch { fail('Saved review conditions UI proof is missing'); }
      if (conditions.allowLocalSummary !== true || typeof conditions.notAfterMs !== 'number') fail('Saved review consent or expiry conditions are missing');
      const citation = await verifyLiteralCitation(input.allowedDocumentId, input.allowedText);
      const stage = await screenshot('automated-test-reviewed-view'); await page.getByRole('button', { name: 'Approve exact reviewed evidence', exact: true }).click();
      return { approved: true, citation, literalCitation: true, recipientVerified: true, reviewRevision: Number(saved[1]), reviewedViewDigest: saved[2], conditions, screenshot: stage };
    }
    case 'evidence': return openEvidence(input);
    case 'delivery': return delivery(input);
    case 'summary': {
      await page.getByRole('button', { name: 'Request optional local summary', exact: true }).click();
      await page.getByRole('button', { name: /DRAFT/ }).click({ timeout: 120_000 }); await page.getByRole('heading', { name: /Summary draft/ }).waitFor({ state: 'visible' });
      const text = await page.locator('main').innerText(); if (/RESTRICTED-SENTINEL|CROSS-SPACE-SENTINEL/.test(text)) fail('Excluded sentinel reached QVAC summary GUI');
      const observed = await observations(); if (observed.inference < 1) fail('No actual QVAC inference observed for GUI summary');
      if (typeof input.allowedText !== 'string' || typeof input.allowedDocumentId !== 'string') fail('Summary requires allowedText and allowedDocumentId');
      const citation = await verifyLiteralCitation(input.allowedDocumentId, input.allowedText);
      return { observations: observed, citation, literalCitation: true, screenshot: await screenshot('actual-qvac-summary') };
    }
    case 'restart': {
      const previousProcessId = processId(); await closeRuntime();
      const launched = await start();
      if (launched.processId === previousProcessId) fail('Restart reused the previous app process');
      await refreshSpace(); const evidence = await openEvidence(input);
      return { ...launched, previousProcessId, freshSharedSync: true, reconnected: true, evidence, screenshot: await screenshot('restart-fresh-sync') };
    }
    case 'configure-faults': { await observe(Boolean(input.dropAck)); return { dropAck: Boolean(input.dropAck) }; }
    case 'revoke': {
      await navigate('Permissions'); const member = page.locator('div.source').filter({ has: page.getByText(`${input.requesterKey} · linked`, { exact: true }) });
      await member.getByRole('button', { name: 'Revoke linked device', exact: true }).click(); await page.getByText(`${input.requesterKey} · revoked`, { exact: true }).waitFor({ state: 'visible' });
      return { screenshot: await screenshot('revoked') };
    }
    case 'stop': { await closeRuntime(); return { stopped: true }; }
    default: fail(`Unsupported action: ${action}`);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let terminating = false;
const terminate = signal => {
  if (terminating) return;
  terminating = true;
  void closeRuntime().finally(() => { if (signal) process.exit(0); });
};
process.once('SIGTERM', () => terminate('SIGTERM'));
process.once('SIGINT', () => terminate('SIGINT'));
for await (const line of lines) {
  let request;
  try {
    request = JSON.parse(line); if (!request || typeof request.id !== 'string' || typeof request.action !== 'string') fail('Each request needs string id and action');
    const result = await command(request.action, request.input ?? {});
    process.stdout.write(`KURO_GUI_RESULT:${JSON.stringify({ id: request.id, ok: true, result })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error); log('command failed', { id: request?.id, message });
    process.stdout.write(`KURO_GUI_RESULT:${JSON.stringify({ id: request?.id ?? null, ok: false, error: message })}\n`);
  }
}
await closeRuntime().catch(() => {});
