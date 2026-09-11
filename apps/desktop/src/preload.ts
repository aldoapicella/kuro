import { contextBridge, ipcRenderer } from 'electron';
import type { CommittedEvent, DesktopHostPort } from '@kuro/contracts';
import { failure, KuroError } from '@kuro/contracts';
import { createAppBridge } from './bridge.js';
import { RendererBarrier } from './renderer-barrier.js';

const barrier = new RendererBarrier(() => ipcRenderer.sendSync('kuro:lifecycle:epoch'), () => {
  window.dispatchEvent(new Event('kuro:lifecycle-invalidated'));
});
const invoke = async (channel: string, input: unknown, recovery = false) => {
  try { return recovery ? await ipcRenderer.invoke(channel, input) : await barrier.deliver(() => ipcRenderer.invoke(channel, input)); }
  catch (error) { return failure(error instanceof KuroError ? error.code : 'CLOCK_UNCERTAIN'); }
};
ipcRenderer.on('kuro:lifecycle:invalidate', () => { barrier.invalidate(); });
const checkFrame = (): void => {
  try { barrier.check(); } catch { /* Invalidation clears protected DOM synchronously. */ }
  requestAnimationFrame(checkFrame);
};
requestAnimationFrame(checkFrame);
document.addEventListener('visibilitychange', () => { if (document.hidden) barrier.invalidate(); });

const app = createAppBridge((name, input) => invoke(`kuro:app:${name}`, input), listener => {
  const handler = (_event: Electron.IpcRendererEvent, committed: CommittedEvent): void => {
    try { barrier.check(); listener(committed); } catch { /* Never deliver across a closed epoch. */ }
  };
  ipcRenderer.on('kuro:committed', handler);
  return () => { ipcRenderer.removeListener('kuro:committed', handler); };
});
const host: DesktopHostPort = Object.freeze({
  getInfo: input => invoke('kuro:host:getInfo', input),
  selectText: input => invoke('kuro:host:selectText', input),
  selectPairing: input => invoke('kuro:host:selectPairing', input),
  setScenario: input => invoke('kuro:host:setScenario', input),
  getSetup: input => invoke('kuro:host:getSetup', input, true),
  saveProfile: input => invoke('kuro:host:saveProfile', input, true),
  startWorkspace: input => invoke('kuro:host:startWorkspace', input, true),
  stopWorkspace: input => invoke('kuro:host:stopWorkspace', input, true),
  prepareModel: input => invoke('kuro:host:prepareModel', input, true),
  cancelModel: input => invoke('kuro:host:cancelModel', input, true),
  exportInvitation: input => invoke('kuro:host:exportInvitation', input),
  exportEnrollment: input => invoke('kuro:host:exportEnrollment', input),
  exportIdentity: input => invoke('kuro:host:exportIdentity', input),
  selectLinkedIdentity: input => invoke('kuro:host:selectLinkedIdentity', input, true),
} satisfies DesktopHostPort);
contextBridge.exposeInMainWorld('kuro', Object.freeze({ app, host }));
