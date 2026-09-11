/// <reference path="./bare-runtime.d.ts" />
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { accessSync, constants } from 'node:fs';
import type { Socket } from 'node:net';
import spawn from 'bare-runtime/spawn';
import { BARE_VERSION, encodeIpc, IpcDecoder, MAX_PENDING_IPC_BYTES, parseWorkerReply } from './worker-ipc.js';
import type { FromWorker, ToWorker, WorkerConfig } from './worker-protocol.js';

export interface TransportWorker {
  postMessage(message: ToWorker): void;
  terminate(): Promise<number>;
  on(event: 'message', listener: (message: FromWorker) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  off(event: 'message', listener: (message: FromWorker) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'exit', listener: (code: number) => void): unknown;
}

/** Node host shell around the pinned Bare process. Seed travels only over inherited fd 3. */
export class BareTransportWorker extends EventEmitter implements TransportWorker {
  readonly #child;
  readonly #pipe: Socket;
  readonly #exit: Promise<number>;
  #pendingBytes = 0;
  #beforeInit: Uint8Array[] = [];
  #beforeInitBytes = 0;
  #runtimeReady = false;
  #stopped = false;
  #failed = false;

  constructor(url: URL, config: WorkerConfig) {
    super();
    accessSync(fileURLToPath(url), constants.R_OK);
    this.#child = spawn({ args: [fileURLToPath(url)], stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    this.#pipe = this.#child.stdio[3] as Socket;
    const decoder = new IpcDecoder();
    this.#exit = new Promise(resolve => {
      this.#child.once('error', () => { this.fail(new Error('Bare network worker could not start')); resolve(1); });
      this.#child.once('exit', (code) => {
        const result = code ?? 1;
        if (result === 0 && this.#stopped) this.emit('message', { type: 'stopped' } satisfies FromWorker);
        this.emit('exit', result);
        resolve(result);
      });
    });
    this.#pipe.on('data', (chunk: Uint8Array) => {
      try {
        decoder.push(chunk, value => {
          const message = parseWorkerReply(value);
          if (message.type === 'runtime') {
            if (this.#runtimeReady || message.version !== BARE_VERSION) throw new Error('Unexpected Bare runtime');
            this.#runtimeReady = true;
            this.write(encodeIpc({ type: 'init', config }));
            for (const bytes of this.#beforeInit) { this.#beforeInitBytes -= bytes.length; this.write(bytes); }
            this.#beforeInit = [];
          } else {
            if (!this.#runtimeReady || this.#stopped) throw new Error('Unexpected Bare worker response');
            if (message.type === 'stopped') { this.#stopped = true; this.#pipe.end(); }
            else this.emit('message', message);
          }
        });
      } catch { this.fail(new Error('Invalid Bare network worker IPC')); }
    });
    this.#pipe.once('error', () => this.fail(new Error('Bare network worker channel failed')));
    this.#pipe.once('end', () => {
      try { decoder.finish(); if (!this.#stopped) throw new Error('Worker channel closed'); }
      catch { this.fail(new Error('Bare network worker channel ended unexpectedly')); }
    });
  }

  postMessage(message: ToWorker): void {
    try {
      const bytes = encodeIpc(message);
      if (!this.#runtimeReady) {
        if (this.#failed || this.#beforeInitBytes + bytes.length > MAX_PENDING_IPC_BYTES) throw new Error('Worker channel unavailable');
        this.#beforeInitBytes += bytes.length; this.#beforeInit.push(bytes);
      } else this.write(bytes);
    }
    catch { this.fail(new Error('Bare network worker IPC capacity exceeded')); }
  }
  async terminate(): Promise<number> { this.#child.kill('SIGKILL'); return this.#exit; }
  private write(bytes: Uint8Array): void {
    if (this.#failed || this.#stopped || this.#pendingBytes + this.#beforeInitBytes + bytes.length > MAX_PENDING_IPC_BYTES) throw new Error('Worker channel unavailable');
    this.#pendingBytes += bytes.length;
    this.#pipe.write(bytes, (error) => {
      this.#pendingBytes -= bytes.length;
      if (error) this.fail(new Error('Bare network worker channel write failed'));
    });
  }
  private fail(error: Error): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#beforeInit = []; this.#beforeInitBytes = 0;
    // A synchronous postMessage failure must still reject the pending transport operation.
    this.emit('error', error);
    void this.terminate();
  }
}
