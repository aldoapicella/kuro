import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, safeStorage } from 'electron';
import { readFile, mkdir, rm, open, realpath } from 'node:fs/promises';
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
import { unavailableSetup } from './setup-unavailable.js';
import { ProfileRuntime } from './profile-runtime.js';
import { IDSchema, KeySchema } from '@kuro/contracts';
import type { VerifiedPairings } from './selections.js';

const here = dirname(fileURLToPath(import.meta.url));
const rendererPath = resolve(here, '../renderer/index.html');
const rendererURL = pathToFileURL(rendererPath).href;
const argument = (name: string): string | undefined => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode = argument('mode') ?? 'real';
const profile = argument('profile') ?? 'A';
// `--ai=qvac` runs real local models behind the simulated transport. Real mode is
// always QVAC; demo mode is always scripted and never loads a model.
const aiChoice = argument('ai') ?? 'simulated';
if (!['demo', 'core-simulated', 'real'].includes(mode) || !['A', 'B'].includes(profile)) throw new Error('Use --mode=demo|core-simulated|real and --profile=A|B');
if (!['simulated', 'qvac'].includes(aiChoice)) throw new Error('Use --ai=simulated|qvac');
if (aiChoice === 'qvac' && mode !== 'core-simulated') throw new Error('--ai=qvac applies to --mode=core-simulated; real mode already uses QVAC');
app.setName('KURO');
const dataDirectory = argument('user-data-dir') ? resolve(argument('user-data-dir')!) : join(app.getPath('appData'), 'KURO', mode, mode === 'core-simulated' ? 'AB' : profile);
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
  app: AppPort; info: DesktopInfo; files?: SelectedTextFiles | undefined; pairing?: VerifiedPairings | undefined;
  fake?: FakeAppPort; pairVerified?: (binding: VerifiedBinding, check: () => void) => Promise<void>;
  checkpoint?: () => number;
  profileRuntime?: ProfileRuntime;
}

async function selectBinding(window: BrowserWindow, check: () => void): Promise<VerifiedBinding | null> {
  const selected = await dialog.showOpenDialog(window, { title: 'Select a KURO pairing record', properties: ['openFile'], filters: [{ name: 'KURO pairing record', extensions: ['json'] }] });
  check();
  if (selected.canceled || !selected.filePaths[0]) return null;
  const binding = VerifiedBindingSchema.parse(await readSelectedRecord(selected.filePaths[0], check));
  check();
  const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Verify this device', message: 'Compare every detail with the other person using a separate trusted channel.', detail: `${formatBindingVerification(binding)}\n\nThe file alone does not verify a person or space.`, buttons: ['Cancel', 'I verified all details'], defaultId: 0, cancelId: 0, noLink: true });
  check();
  return answer.response === 1 ? binding : null;
}

async function readSelectedRecord(selectedPath: string, check: () => void): Promise<unknown> {
  const path = resolve(selectedPath);
  if (await realpath(path) !== path) throw new KuroError('INVALID_INPUT');
  check();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat(); check();
    if (!before.isFile() || before.size < 1 || before.size > 8192) throw new KuroError('INVALID_INPUT');
    const bytes = Buffer.alloc(before.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat(); check();
    if (read.bytesRead !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new KuroError('STALE_REVISION');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await handle.close(); }
}

async function exportRecord(window: BrowserWindow, name: string, value: unknown, check: () => void): Promise<{ displayName: string } | null> {
  const selected = await dialog.showSaveDialog(window, { title: 'Save public KURO verification record', defaultPath: name, filters: [{ name: 'KURO record', extensions: ['json'] }] });
  check();
  if (selected.canceled || !selected.filePath) return null;
  const path = resolve(selected.filePath), temporary = join(dirname(path), `.kuro-${randomBytes(16).toString('hex')}.pending`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
    check(); renameSync(temporary, path);
    return { displayName: basename(path).slice(0, 255) };
  } finally { await rm(temporary, { force: true }); }
}

async function createWindow(node: NodeBinding): Promise<BrowserWindow> {
  const window = new BrowserWindow({ width: 1420, height: 940, minWidth: 1020, minHeight: 700, show: false, title: `KURO | Device ${node.info.profile}`, backgroundColor: '#f6f7f9', webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false, devTools: !app.isPackaged } });
  let selecting = false;
  const select = async <T>(operation: (check: () => void) => Promise<T>, protectedAccess = true) => {
    if (selecting) return failure('CAPACITY_EXCEEDED');
    selecting = true;
    try {
      const epoch = protectedAccess ? node.checkpoint?.() : undefined;
      const check = () => { if (window.isDestroyed()) throw new KuroError('CANCELLED'); if (protectedAccess && node.checkpoint?.() !== epoch) throw new KuroError('CLOCK_UNCERTAIN'); };
      const value = await operation(check); check(); return success(value);
    } catch (error) { return failure(error instanceof KuroError ? error.code : 'INVALID_INPUT'); }
    finally { selecting = false; }
  };
  const host: DesktopHostPort = {
    ...unavailableSetup(node.info),
    getInfo: async () => { if (node.profileRuntime && !node.profileRuntime.running) return failure('ACCESS_DENIED'); return success(node.fake ? node.fake.info() : structuredClone(node.info)); },
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
  if (node.profileRuntime) {
    const controller = node.profileRuntime;
    const command = async <T>(operation: () => Promise<T>) => {
      try { return success(await operation()); } catch (error) { return failure(error instanceof KuroError ? error.code : 'STORAGE_FAILURE'); }
    };
    Object.assign(host, {
      getSetup: async () => command(() => controller.getSetup()),
      saveProfile: async input => command(async () => { await controller.saveProfile(input); return null; }),
      startWorkspace: async () => command(async () => { await controller.start(); return null; }),
      stopWorkspace: async () => command(async () => { await controller.stop(); return null; }),
      prepareModel: async input => command(async () => { await controller.models.prepare(input.kind); return null; }),
      cancelModel: async input => command(async () => { await controller.models.cancel(input.kind); return null; }),
      exportInvitation: async input => select(async check => {
        const binding = await controller.invitation(input.spaceId); check();
        return exportRecord(window, 'KURO-invitation.json', binding, check);
      }),
      exportEnrollment: async input => select(async check => {
        const binding = await controller.enrollment(input.spaceId); check();
        return exportRecord(window, 'KURO-enrollment.json', binding, check);
      }),
      exportIdentity: async () => select(async check => {
        if (!controller.running) throw new KuroError('ACCESS_DENIED');
        return exportRecord(window, 'KURO-linked-identity.json', { kind: 'kuro-linked-identity', version: 1, memberId: controller.info.memberId, sourceKey: controller.info.publicKey }, check);
      }),
      selectLinkedIdentity: async () => select(async check => {
        const selected = await dialog.showOpenDialog(window, { title: 'Select your existing KURO identity record', properties: ['openFile'], filters: [{ name: 'KURO identity', extensions: ['json'] }] });
        check(); if (selected.canceled || !selected.filePaths[0]) return null;
        const record = await readSelectedRecord(selected.filePaths[0], check);
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new KuroError('INVALID_INPUT');
        const item = record as Record<string, unknown>;
        if (Object.keys(item).sort().join(',') !== 'kind,memberId,sourceKey,version' || item.kind !== 'kuro-linked-identity' || item.version !== 1) throw new KuroError('INVALID_INPUT');
        const memberId = IDSchema.parse(item.memberId), sourceKey = KeySchema.parse(item.sourceKey);
        const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Link your device identity', message: 'Verify this member and source device through a separate trusted channel.', detail: `Member: ${memberId}\nSource key: ${sourceKey}\n\nThis creates no membership or document grant. A space owner must separately enroll this new device.`, buttons: ['Cancel', 'I verified my identity'], defaultId: 0, cancelId: 0, noLink: true });
        check(); if (answer.response !== 1) return null;
        await controller.linkIdentity(memberId); check(); return { memberId, sourceKey };
      }, false),
    } satisfies Partial<DesktopHostPort>);
  }
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
      const store = new ProtectedSecretStore(join(dataDirectory, 'secrets'), {
        protection: () => !safeStorage.isEncryptionAvailable() ? 'unavailable' : process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text' ? 'basic_text' : 'os-protected',
        encrypt: text => safeStorage.encryptString(text), decrypt: bytes => safeStorage.decryptString(Buffer.from(bytes)),
      });
      let sourceCommit: string | null = null, version = app.getVersion();
      try { const manifest = JSON.parse(await readFile(resolve(here, '../package.json'), 'utf8')); if (/^[0-9a-f]{40}$/.test(manifest.sourceCommit)) sourceCommit = manifest.sourceCommit; if (typeof manifest.version === 'string') version = manifest.version; } catch {}
      const controller = new ProfileRuntime(dataDirectory, profile as 'A' | 'B', store, version, invalidateViews, sourceCommit);
      await controller.load();
      stop = () => controller.close(); suspend = () => controller.suspend(); resume = () => controller.resume();
      lock = () => controller.lock(); unlock = () => controller.unlock();
      // Existing profiles resume using their saved network configuration. Failures remain
      // visible in the content-free setup view, where users can stop, edit and retry.
      if ((await controller.getSetup()).runtime === 'stopped') await controller.start().catch(() => {});
      await createWindow({ app: controller.app, get info() { return controller.info; }, get files() { return controller.files; }, get pairing() { return controller.pairing; },
        checkpoint: () => controller.checkpoint(), pairVerified: (binding, check) => controller.pairVerified(binding, check), profileRuntime: controller });
      timer = setInterval(() => { void controller.tick().catch(suspendSafely); }, 500);
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
