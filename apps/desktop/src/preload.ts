import { contextBridge, ipcRenderer } from 'electron';
import type { CommittedEvent, DesktopHostPort } from '@kuro/contracts';
import { createAppBridge } from './bridge.js';

const app = createAppBridge((name, input) => ipcRenderer.invoke(`kuro:app:${name}`, input), listener => {
  const handler = (_event: Electron.IpcRendererEvent, committed: CommittedEvent): void => { listener(committed); };
  ipcRenderer.on('kuro:committed', handler);
  return () => { ipcRenderer.removeListener('kuro:committed', handler); };
});
const host: DesktopHostPort = Object.freeze({
  getInfo: input => ipcRenderer.invoke('kuro:host:getInfo', input),
  selectText: input => ipcRenderer.invoke('kuro:host:selectText', input),
  selectPairing: input => ipcRenderer.invoke('kuro:host:selectPairing', input),
  setScenario: input => ipcRenderer.invoke('kuro:host:setScenario', input),
} satisfies DesktopHostPort);
contextBridge.exposeInMainWorld('kuro', Object.freeze({ app, host }));
