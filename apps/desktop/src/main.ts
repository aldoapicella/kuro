import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, safeStorage } from 'electron';
import { readFile, mkdir, writeFile, rm, open, realpath } from 'node:fs/promises';
import { constants, renameSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { AppCommands, DesktopCommands, CommittedEventSchema, VerifiedBindingSchema, KuroError, failure, success } from '@kuro/contracts';
import type { AppPort, DesktopHostPort, DesktopInfo, VerifiedBinding } from '@kuro/contracts';
import type { SelectedTextFiles } from '@kuro/core';
import { FakeAppPort, DEMO_OWNER, demoId } from './fake-app.js';
import { routeCall, trustedSender } from './ipc-router.js';
import type { WindowBinding } from './ipc-router.js';
import { ProtectedSecretStore } from './secret-store.js';
import { DesktopLifecycle } from './lifecycle.js';
import { formatBindingVerification } from './selections.js';
import type { VerifiedPairings } from './selections.js';

const here = dirname(fileURLToPath(import.meta.url));
const rendererPath = resolve(here, '../renderer/index.html');
const rendererURL = pathToFileURL(rendererPath).href;
const argument = (name: string): string | undefined => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode = argument('mode') ?? 'demo';
const profile = argument('profile') ?? 'A';
// `--ai=qvac` runs real local models behind the simulated transport. Real mode is
// always QVAC; demo mode is always scripted and never loads a model.
const aiChoice = argument('ai') ?? 'simulated';
if (!['demo', 'core-simulated', 'real'].includes(mode) || !['A', 'B'].includes(profile)) throw new Error('Use --mode=demo|core-simulated|real and --profile=A|B');
if (!['simulated', 'qvac'].includes(aiChoice)) throw new Error('Use --ai=simulated|qvac');
if (aiChoice === 'qvac' && mode !== 'core-simulated') throw new Error('--ai=qvac applies to --mode=core-simulated; real mode already uses QVAC');
app.setName('KURO');
// A stored index is bound to its embedding profile, so each AI provider keeps its own workspace.
const dataDirectory = join(app.getPath('appData'), 'KURO', mode, mode === 'core-simulated' ? `AB${aiChoice === 'qvac' ? '-qvac' : ''}` : profile);
app.setPath('userData', dataDirectory);
const bindings = new Map<number, WindowBinding>();
let stop = async (): Promise<void> => {};
let suspend = (): void => {};
let resume = async (): Promise<void> => {};
let lock = (): void => {};
let unlock = async (): Promise<void> => {};
let quitting = false;
let timer: ReturnType<typeof setInterval> | undefined;
const suspendSafely = (): void => { try { suspend(); } catch {} };
const invalidateViews = (): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send('kuro:lifecycle:invalidate');
  }
};

interface NodeBinding {
  app: AppPort; info: DesktopInfo; files?: SelectedTextFiles; pairing?: VerifiedPairings;
  fake?: FakeAppPort; pairVerified?: (binding: VerifiedBinding, check: () => void) => Promise<void>;
  checkpoint?: () => number;
}

async function selectBinding(window: BrowserWindow, check: () => void): Promise<VerifiedBinding | null> {
  const selected = await dialog.showOpenDialog(window, { title: 'Select a KURO pairing record', properties: ['openFile'], filters: [{ name: 'KURO pairing record', extensions: ['json'] }] });
  check();
  if (selected.canceled || !selected.filePaths[0]) return null;
  const path = resolve(selected.filePaths[0]);
  if (await realpath(path) !== path) throw new KuroError('INVALID_INPUT');
  check();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let binding: VerifiedBinding;
  try {
    const before = await handle.stat();
    check();
    if (!before.isFile() || before.size < 1 || before.size > 8192) throw new KuroError('INVALID_INPUT');
    const bytes = Buffer.alloc(before.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    check();
    if (read.bytesRead !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new KuroError('STALE_REVISION');
    binding = VerifiedBindingSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } finally { await handle.close(); }
  check();
  const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Verify this device', message: 'Compare every detail with the other person using a separate trusted channel.', detail: `${formatBindingVerification(binding)}\n\nThe file alone does not verify a person or space.`, buttons: ['Cancel', 'I verified all details'], defaultId: 0, cancelId: 0, noLink: true });
  check();
  return answer.response === 1 ? binding : null;
}

async function createWindow(node: NodeBinding): Promise<BrowserWindow> {
  const window = new BrowserWindow({ width: 1420, height: 940, minWidth: 1020, minHeight: 700, show: false, title: `KURO | Device ${node.info.profile}`, backgroundColor: '#f6f7f9', webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false, devTools: !app.isPackaged } });
  let selecting = false;
  const select = async <T>(operation: (check: () => void) => Promise<T>) => {
    if (selecting) return failure('CAPACITY_EXCEEDED');
    selecting = true;
    try {
      const epoch = node.checkpoint?.();
      const check = () => { if (node.checkpoint?.() !== epoch) throw new KuroError('CLOCK_UNCERTAIN'); };
      const value = await operation(check); check(); return success(value);
    } catch (error) { return failure(error instanceof KuroError ? error.code : 'INVALID_INPUT'); }
    finally { selecting = false; }
  };
  const host: DesktopHostPort = {
    getInfo: async () => success(node.fake ? node.fake.info() : structuredClone(node.info)),
    selectText: async () => select(async check => {
      if (node.fake) return { selectionId: demoId(90), displayName: 'synthetic-release-note.txt' };
      const picked = await dialog.showOpenDialog(window, { title: 'Import UTF-8 text', properties: ['openFile'], filters: [{ name: 'UTF-8 text', extensions: ['txt'] }] });
      check();
      if (picked.canceled || !picked.filePaths[0]) return null;
      if (!node.files) throw new KuroError('INVALID_INPUT');
      return { selectionId: node.files.register(picked.filePaths[0]), displayName: basename(picked.filePaths[0]).slice(0, 255) };
    }),
    selectPairing: async () => select(async check => {
      if (node.fake) return { selectionId: demoId(91), binding: { kind: 'member' as const, spaceId: demoId(1), memberId: DEMO_OWNER.memberId, peerKey: DEMO_OWNER.publicKey, spaceAlias: demoId(92) } };
      const binding = await selectBinding(window, check);
      check();
      if (!binding) return null;
      if (!node.pairing) throw new KuroError('ACCESS_DENIED');
      await node.pairVerified?.(binding, check);
      check();
      return { selectionId: node.pairing.register(binding), binding };
    }),
    setScenario: async input => { if (!node.fake) return failure('ACCESS_DENIED'); node.fake.reset(input.scenario); return success(null); },
  };
  const senderId = window.webContents.id;
  bindings.set(senderId, { senderId, url: rendererURL, app: node.app, host, ...(node.checkpoint ? { checkpoint: node.checkpoint } : {}) });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => { event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => { event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false); });
  window.webContents.session.setPermissionCheckHandler(() => false);
  const assets = new Set(['index.html', 'renderer.js', 'styles.css'].map(file => pathToFileURL(resolve(here, '../renderer', file)).href));
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => { callback({ cancel: !assets.has(details.url) }); });
  const unsubscribe = node.app.subscribe(event => {
    const checked = CommittedEventSchema.safeParse(event);
    if (checked.success && !window.webContents.isDestroyed()) window.webContents.send('kuro:committed', checked.data);
  });
  window.on('closed', () => { unsubscribe(); bindings.delete(senderId); });
  await window.loadURL(rendererURL);
  window.show();
  return window;
}

// Fixed, read-only preload barrier. It exposes no native handle or general RPC.
// The sandboxed preload checks it before delivering replies and rendering frames.
ipcMain.on('kuro:lifecycle:epoch', event => {
  let epoch: number | null = null;
  const binding = bindings.get(event.sender.id);
  if (binding && trustedSender({ id: event.sender.id, isMainFrame: event.senderFrame === event.sender.mainFrame, url: event.senderFrame?.url ?? '' }, binding)) {
    try { epoch = binding.checkpoint?.() ?? 0; } catch { /* Closed remains null. */ }
  }
  // Setting returnValue sends the synchronous reply immediately. Set it once.
  event.returnValue = epoch;
});

for (const [surface, commands] of [['app', AppCommands], ['host', DesktopCommands]] as const) {
  for (const name of Object.keys(commands)) ipcMain.handle(`kuro:${surface}:${name}`, async (event, input: unknown) => {
    const binding = bindings.get(event.sender.id);
    if (!binding) return failure('ACCESS_DENIED');
    const sender = { id: event.sender.id, isMainFrame: event.senderFrame === event.sender.mainFrame, url: event.senderFrame?.url ?? '' };
    const reply = await routeCall(binding, sender, surface, name, input);
    // Do not deliver a pending response into a replaced document.
    if (event.sender.isDestroyed() || event.senderFrame?.url !== rendererURL) return failure('ACCESS_DENIED');
    return reply;
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { BrowserWindow.getAllWindows()[0]?.focus(); });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const probe = argument('probe');
    if (probe === 'lifecycle' || probe === 'lifecycle-sleep') {
      try {
        const { runLifecycleProbe } = await import('./lifecycle-probe.js');
        let powerEvents = 0;
        const observed = () => { powerEvents++; };
        if (probe === 'lifecycle-sleep') { powerMonitor.on('suspend', observed); powerMonitor.on('resume', observed); }
        console.log(JSON.stringify(await runLifecycleProbe(probe === 'lifecycle-sleep' ? () => powerEvents : undefined))); app.quit(); return;
      } catch (error) {
        console.error(JSON.stringify({ probe, status: 'failed', code: error instanceof KuroError ? error.code : 'LIFECYCLE_PROBE_FAILED', authorizationGate: 'closed' }));
        app.exit(1); return;
      }
    }
    if (probe === 'host') {
      const { runHostProbe } = await import('./probe.js');
      console.log(JSON.stringify(runHostProbe())); app.quit(); return;
    }
    if (probe === 'runtime' || probe === 'inference' || probe === 'transport') {
      const { runRuntimeProbe, runtimeProbeErrorCode } = await import('./runtime-probe.js');
      try {
        const protector = {
          protection: () => !safeStorage.isEncryptionAvailable() ? 'unavailable' as const : process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text' ? 'basic_text' as const : 'os-protected' as const,
          encrypt: (text: string) => safeStorage.encryptString(text), decrypt: (bytes: Uint8Array) => safeStorage.decryptString(Buffer.from(bytes)),
        };
        let result;
        if (probe === 'transport') {
          const configurationPath = argument('config');
          if (!configurationPath) throw new KuroError('INVALID_INPUT');
          const { readRealConfiguration } = await import('./composition/real.js');
          const configuration = readRealConfiguration(JSON.parse(await readFile(resolve(configurationPath), 'utf8')));
          result = await runRuntimeProbe({ mode: 'transport', protector, configuration });
        } else result = await runRuntimeProbe({ mode: probe, protector });
        console.log(JSON.stringify(result)); app.quit(); return;
      } catch (error) {
        console.error(JSON.stringify({ probe, status: 'failed', code: runtimeProbeErrorCode(error), authorizationGate: 'closed' }));
        app.exit(1); return;
      }
    }
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    if (mode === 'demo') {
      const fake = new FakeAppPort(profile as 'A' | 'B');
      stop = async () => { fake.close(); };
      await createWindow({ app: fake.app, info: fake.info(), fake });
    } else if (mode === 'core-simulated') {
      const { createSimulatedDesktop } = await import('./composition/simulated.js');
      // One QVAC runtime serves both simulated devices: this is still one physical
      // host with one model runtime, and its guard keeps jobs serialized.
      // Loading this module is explicit; a failed SDK never falls back to a fake port.
      const ai = aiChoice === 'qvac' ? await import('@kuro/ai').then(({ createAiAdapter, QvacClient }) => createAiAdapter(new QvacClient())) : undefined;
      let runtime;
      try { runtime = await createSimulatedDesktop(dataDirectory, ai ? { createAi: () => ai.port } : {}); }
      catch (error) { await ai?.close().catch(() => {}); throw error; }
      const lifecycle = new DesktopLifecycle([...runtime.nodes.values()].map(node => node.core), () => ai?.close() ?? Promise.resolve(), undefined, invalidateViews);
      stop = async () => { await runtime.close(); await ai?.close(); };
      suspend = () => lifecycle.suspend(); resume = () => lifecycle.resume();
      lock = () => lifecycle.lock(); unlock = () => lifecycle.unlock();
      timer = setInterval(() => { void runtime.pump().catch(suspendSafely); }, 500);
      for (const id of [profile, profile === 'A' ? 'B' : 'A'] as const) await createWindow({ ...runtime.nodes.get(id as 'A' | 'B')!, checkpoint: () => lifecycle.checkpoint() });
    } else {
      const configurationPath = argument('config');
      if (!configurationPath) throw new KuroError('INVALID_INPUT');
      const { createRealDesktop, readRealConfiguration } = await import('./composition/real.js');
      const configuration = readRealConfiguration(JSON.parse(await readFile(resolve(configurationPath), 'utf8')));
      const store = new ProtectedSecretStore(join(dataDirectory, 'secrets'), {
        protection: () => !safeStorage.isEncryptionAvailable() ? 'unavailable' : process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text' ? 'basic_text' : 'os-protected',
        encrypt: text => safeStorage.encryptString(text), decrypt: bytes => safeStorage.decryptString(Buffer.from(bytes)),
      });
      const runtime = await createRealDesktop(dataDirectory, profile as 'A' | 'B', store, configuration);
      const lifecycle = new DesktopLifecycle([runtime.core], () => runtime.ai.close(), runtime.clock, invalidateViews);
      stop = () => lifecycle.close(); suspend = () => lifecycle.suspend(); resume = () => lifecycle.resume();
      lock = () => lifecycle.lock(); unlock = () => lifecycle.unlock();
      const peersPath = join(dataDirectory, 'verified-peers.json');
      const records: VerifiedBinding[] = [];
      const add = (binding: VerifiedBinding): void => {
        const publicKey = binding.kind === 'authority' ? binding.authorityKey : binding.peerKey;
        runtime.transport.pair(publicKey);
        if (!runtime.info.peers.some(peer => peer.publicKey === publicKey)) runtime.info.peers.push({ publicKey, memberId: binding.kind === 'member' ? binding.memberId : null });
      };
      try {
        const saved: unknown = JSON.parse(await readFile(peersPath, 'utf8'));
        if (!Array.isArray(saved) || saved.length > 32) throw new KuroError('INVALID_INPUT');
        for (const record of saved) { const binding = VerifiedBindingSchema.parse(record); records.push(binding); add(binding); }
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      await createWindow({ ...runtime, checkpoint: () => lifecycle.checkpoint(), pairVerified: async (binding, check) => {
        if (records.length >= 32) throw new KuroError('CAPACITY_EXCEEDED');
        const updated = [...records, binding];
        const temporary = join(dataDirectory, `${randomBytes(16).toString('hex')}.json`);
        let published = false;
        try {
          await writeFile(temporary, JSON.stringify(updated), { flag: 'wx', mode: 0o600 });
          check();
          // No await between final authorization, atomic publication and activation.
          renameSync(temporary, peersPath); published = true; records.push(binding); add(binding);
        } finally { if (!published) await rm(temporary, { force: true }); }
      } });
      timer = setInterval(() => { void lifecycle.tick().catch(suspendSafely); }, 500);
    }
    powerMonitor.on('suspend', suspendSafely);
    powerMonitor.on('lock-screen', () => { try { lock(); } catch {} });
    const resumeConservatively = (): void => { void resume().catch(suspendSafely); };
    powerMonitor.on('resume', resumeConservatively);
    powerMonitor.on('unlock-screen', () => { void unlock().catch(suspendSafely); });
  }).catch(async error => {
    await stop().catch(() => {});
    dialog.showErrorBox('KURO could not start', `Startup stopped (${error instanceof KuroError ? error.code : 'RUNTIME_UNAVAILABLE'}). Check the desktop README for this mode and its runtime requirements.`);
    app.exit(1);
  });
}
app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  if (timer) clearInterval(timer);
  suspendSafely();
  void stop().then(() => app.quit(), () => app.exit(1));
});
