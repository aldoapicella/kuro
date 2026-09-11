import Pipe from 'bare-pipe';
import Buffer from 'bare-buffer';
import { runNetworkWorker } from './hyperdht-worker.js';
import { encodeIpc, IpcDecoder, MAX_PENDING_IPC_BYTES, parseHostCommand } from './worker-ipc.js';
import type { FromWorker, ToWorker } from './worker-protocol.js';

declare const Bare: { versions: { bare: string }; exit(code: number): never };

const pipe = new Pipe(3, { allowHalfOpen: false });
const decoder = new IpcDecoder();
let handler: ((message: ToWorker) => void) | undefined;
let pendingBytes = 0;
let closing = false;

function send(message: FromWorker | { type: 'runtime'; version: string }): void {
  const bytes = encodeIpc(message);
  if (closing || pendingBytes + bytes.length > MAX_PENDING_IPC_BYTES) Bare.exit(1);
  pendingBytes += bytes.length;
  pipe.write(Buffer.from(bytes), (error: Error | null) => {
    pendingBytes -= bytes.length;
    if (error) Bare.exit(1);
  });
}
pipe.on('data', (chunk: unknown) => {
  try {
    if (!(chunk instanceof Uint8Array)) throw new Error('Invalid pipe input');
    decoder.push(chunk, (value) => {
      const command = parseHostCommand(value);
      if (command.type === 'init') {
        if (handler !== undefined) throw new Error('Duplicate initialization');
        runNetworkWorker(command.config, {
          onMessage(callback) { handler = callback; },
          postMessage: send,
          close() { closing = true; pipe.end(); },
        });
      } else {
        if (handler === undefined) throw new Error('Worker is not initialized');
        handler(command);
      }
    });
  } catch { Bare.exit(1); }
});
// The inherited channel is also the lifetime boundary: parent loss cannot orphan a DHT.
pipe.on('end', () => { if (!closing) Bare.exit(1); });
pipe.on('close', () => { if (!closing) Bare.exit(1); });
pipe.on('error', () => Bare.exit(1));
send({ type: 'runtime', version: Bare.versions.bare });
