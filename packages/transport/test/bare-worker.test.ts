import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import spawn from 'bare-runtime/spawn';
import type { Socket } from 'node:net';
import childProcess, { type ChildProcess } from 'node:child_process';
import { BareTransportWorker } from '../src/bare-worker.js';
import { encodeIpc, IpcDecoder, MAX_IPC_BYTES, parseHostCommand, parseWorkerReply } from '../src/worker-ipc.js';
import type { WorkerConfig } from '../src/worker-protocol.js';

const config: WorkerConfig = { seed: new Uint8Array(32).fill(1), bootstrap: [], port: undefined, pairedPeers: [], maxConnections: 2, maxBufferedBytes: 131088, maxQueuedSends: 2, connectionTimeoutMs: 1000 };

test('loss of the inherited host pipe exits Bare before and during network startup', async () => {
  for (const initialize of [false, true]) {
    const child = spawn({ args: [fileURLToPath(new URL('../dist/bare-worker.mjs', import.meta.url))], stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    const pipe = child.stdio[3] as Socket;
    pipe.on('error', () => {});
    const exited = once(child, 'exit');
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
    try {
      await once(pipe, 'data'); // Actual Bare runtime has opened its inherited pipe.
      if (initialize) pipe.write(encodeIpc({ type: 'init', config: { ...config, bootstrap: [{ host: '127.0.0.1', port: 9 }] } }));
      pipe.end();
      assert.deepEqual(await exited, [1, null]);
      assert.equal(timedOut, false);
    } finally { clearTimeout(timer); child.kill('SIGKILL'); pipe.destroy(); }
  }
});

test('stopping the actual Bare worker before its handshake or bootstrap completes exits cleanly', async () => {
  for (const waitMs of [0, 100]) {
    const worker = new BareTransportWorker(new URL('../dist/bare-worker.mjs', import.meta.url), { ...config, bootstrap: [{ host: '127.0.0.1', port: 9 }] });
    let acknowledged = false;
    worker.on('message', message => { if (message.type === 'stopped') acknowledged = true; });
    const exited = once(worker, 'exit');
    const timeout = setTimeout(() => { void worker.terminate(); }, 5000);
    try {
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      worker.postMessage({ type: 'pair', peerKey: 'a'.repeat(64) });
      worker.postMessage({ type: 'stop' });
      assert.deepEqual(await exited, [0]);
      assert.equal(acknowledged, true);
    } finally { clearTimeout(timeout); await worker.terminate(); }
  }
});

test('private IPC preserves exact binary values across split and combined reads', () => {
  const records = [encodeIpc({ type: 'init', config }), encodeIpc({ type: 'send', id: 7, peerKey: 'a'.repeat(64), bytes: Uint8Array.of(0, 255, 10, 13, 128) })];
  const input = Buffer.concat(records);
  const values: unknown[] = [];
  const decoder = new IpcDecoder();
  decoder.push(input.subarray(0, 5), value => values.push(parseHostCommand(value)));
  decoder.push(input.subarray(5), value => values.push(parseHostCommand(value)));
  decoder.finish();
  assert.deepEqual(values[0], { type: 'init', config });
  assert.deepEqual(values[1], { type: 'send', id: 7, peerKey: 'a'.repeat(64), bytes: Uint8Array.of(0, 255, 10, 13, 128) });
});

test('private IPC rejects oversized records, truncation, malformed UTF-8 and invalid shapes', () => {
  const decoder = new IpcDecoder();
  decoder.push(new Uint8Array(MAX_IPC_BYTES).fill(32), () => assert.fail('incomplete frame'));
  assert.throws(() => decoder.push(Uint8Array.of(10), () => {}), /exceeds limit/);
  assert.throws(() => decoder.finish(), /Truncated/);
  assert.throws(() => new IpcDecoder().push(Uint8Array.of(0xc3, 0x28, 10), () => {}));
  assert.throws(() => parseHostCommand({ type: 'send', id: 1, peerKey: 'a'.repeat(64), bytes: 'ff0' }));
  assert.throws(() => parseWorkerReply({ type: 'event', event: { type: 'message', peerKey: 'not-a-key', bytes: 'ff' } }));
  assert.throws(() => parseWorkerReply({ type: 'stopped', unexpected: true }));
});

test('Bare process failure and a false shutdown acknowledgement cannot report clean stop', async (t) => {
  for (const [name, action, expected] of [
    ['wrong runtime', `pipe.write(JSON.stringify({type:'runtime',version:'0.0.0'})+'\\n');`, 'error'],
    ['truncated output', `pipe.end('{');`, 'error'],
    ['oversized output', `pipe.write('x'.repeat(131073));`, 'error'],
    ['nonzero after ack', `pipe.end(JSON.stringify({type:'stopped'})+'\\n', () => Bare.exit(7));`, 'exit'],
  ] as const) {
    await t.test(name, async () => {
      const prefix = name === 'wrong runtime' ? '' : `pipe.write(JSON.stringify({type:'runtime',version:Bare.versions.bare})+'\\n');`;
      await withWorker(`
        import Pipe from 'bare-pipe';
        const pipe = new Pipe(3);
        ${prefix}
        ${name === 'wrong runtime' ? action : `pipe.once('data', () => { ${action} });`}
      `, async worker => {
        let stopped = false;
        worker.on('message', message => { if (message.type === 'stopped') stopped = true; });
        const event = await waitForOutcome(worker, expected);
        if (expected === 'exit') assert.equal(event, 7);
        assert.equal(stopped, false);
      });
    });
  }
});

test('clean shutdown drains its pipe acknowledgement even when process exit is observed first', async () => {
  const originalSpawn = childProcess.spawn;
  // Pause after the runtime banner so the final ACK remains in the OS pipe at process exit.
  // Node documents that exit can precede stdio drain; close is the lifecycle boundary.
  childProcess.spawn = ((...args: unknown[]) => {
    const child = Reflect.apply(originalSpawn, childProcess, args) as ChildProcess;
    const pipe = child.stdio[3] as Socket | undefined;
    if (pipe) pipe.once('data', () => pipe.pause());
    return child;
  }) as typeof childProcess.spawn;
  try {
    await withWorker(`
      import Pipe from 'bare-pipe';
      const pipe = new Pipe(3);
      pipe.write(JSON.stringify({type:'runtime',version:Bare.versions.bare})+'\\n');
      pipe.once('data', () => pipe.end(JSON.stringify({type:'stopped'})+'\\n', () => Bare.exit(0)));
    `, async worker => {
      let stopped = false;
      worker.on('message', message => { if (message.type === 'stopped') stopped = true; });
      const exitCode = await waitForOutcome(worker, 'exit');
      assert.equal(exitCode, 0);
      assert.equal(stopped, true, 'clean process exit lost the still-buffered shutdown ACK');
    });
  } finally { childProcess.spawn = originalSpawn; }
});

function waitForOutcome(worker: BareTransportWorker, expected: 'error' | 'exit'): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bare failure fixture timed out')), 5000);
    worker.once(expected, value => { clearTimeout(timer); resolve(value); });
    // The malformed IPC path emits error and then terminates. Retain a listener for cleanup.
    worker.on('error', () => {});
  });
}

async function withWorker(source: string, check: (worker: BareTransportWorker) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(fileURLToPath(new URL('../dist/worker-test-', import.meta.url)));
  const outfile = join(directory, 'worker.mjs');
  let worker: BareTransportWorker | undefined;
  try {
    await build({ stdin: { contents: source, resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, outfile, bundle: true, platform: 'neutral', format: 'esm', external: ['bare-pipe'], logLevel: 'silent' });
    worker = new BareTransportWorker(pathToFileURL(outfile), config);
    await check(worker);
  } finally {
    await worker?.terminate();
    await rm(directory, { recursive: true, force: true });
  }
}
