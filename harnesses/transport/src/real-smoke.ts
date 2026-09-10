import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createInterface } from 'node:readline';
import HyperDHT from 'hyperdht';
import { runTransportConformance, type TransportConformanceResult } from '@kuro/transport';
import type { TransportEvent, TransportPort } from '@kuro/contracts';

interface PeerEvent { type: string; publicKey?: string; peerKey?: string; bytesHex?: string; code?: string }
interface ProcessConfig { bootstrap: { host: string; port: number }[]; seedHex: string; pairedPeers: string[]; port: number; holdMessages?: boolean }
interface SendWaiter { resolve(event: PeerEvent): void; reject(error: Error): void; timer: NodeJS.Timeout }

async function main(): Promise<void> {
  const bootstrapper = HyperDHT.bootstrapper(await reserveUdpPort(), '127.0.0.1');
  await bootstrapper.fullyBootstrapped();
  const bootstrap = [{ host: '127.0.0.1', port: bootstrapper.address().port }];
  const router = new HyperDHT({ bootstrap, port: await reserveUdpPort(), ephemeral: false, host: '127.0.0.1', firewalled: false });
  await router.fullyBootstrapped();
  const seedA = randomBytes(32); const seedB = randomBytes(32);
  const keyA = Buffer.from(HyperDHT.keyPair(seedA).publicKey).toString('hex');
  const keyB = Buffer.from(HyperDHT.keyPair(seedB).publicKey).toString('hex');
  const left = new PeerProcess({ bootstrap, port: await reserveUdpPort(), seedHex: seedA.toString('hex'), pairedPeers: [keyB] });
  const right = new PeerProcess({ bootstrap, port: await reserveUdpPort(), seedHex: seedB.toString('hex'), pairedPeers: [keyA], holdMessages: true });
  try {
    await Promise.all([left.wait('ready'), right.wait('ready')]);
    const result: TransportConformanceResult = await runTransportConformance({
      sender: new ChildTransport(left, keyA), recipient: new ChildTransport(right, keyB), senderKey: keyA, recipientKey: keyB,
      reconnectRecipient: () => right.restart(), releaseRecipientObservation: () => right.release(), timeoutMs: 10_000,
    });
    process.stdout.write(`real HyperDHT two-process conformance passed (${result.deliveries} D25 protocol messages)\n`);
  } finally {
    await Promise.allSettled([left.stop(), right.stop()]);
    await router.destroy(); await bootstrapper.destroy();
  }
}

class ChildTransport implements TransportPort {
  constructor(private readonly peer: PeerProcess, private readonly key: string) {}
  async start(): Promise<{ publicKey: string }> { return { publicKey: this.key }; }
  async stop(): Promise<void> { await this.peer.stop(); }
  async send(peerKey: string, bytes: Uint8Array): Promise<void> {
    this.peer.command({ type: 'send', peerKey, bytesHex: Buffer.from(bytes).toString('hex') });
    const outcome = await this.peer.waitSendOutcome();
    if (outcome.type === 'rejected') throw new Error('Child transport rejected send');
  }
  subscribe(listener: (event: TransportEvent) => void): () => void { return this.peer.subscribe(listener); }
}

class PeerProcess {
  #child: ChildProcess;
  readonly #config: ProcessConfig;
  readonly #events: PeerEvent[] = [];
  readonly #context: string[] = [];
  readonly #waiters = new Map<string, Array<(event: PeerEvent) => void>>();
  readonly #sendWaiters: SendWaiter[] = [];
  readonly #listeners = new Set<(event: TransportEvent) => void>();
  constructor(config: ProcessConfig) {
    this.#config = config;
    this.#child = this.startChild();
  }
  private startChild(): ChildProcess {
    const child = spawn(process.execPath, ['--import', 'tsx', new URL('./peer-process.ts', import.meta.url).pathname], { env: { ...process.env, KURO_TRANSPORT_CONFIG: JSON.stringify(this.#config) }, stdio: ['pipe', 'pipe', 'inherit'] });
    createInterface({ input: child.stdout! }).on('line', (line) => this.receive(JSON.parse(line) as PeerEvent));
    return child;
  }
  command(value: object): void { this.#child.stdin!.write(`${JSON.stringify(value)}\n`); }
  wait(type: string, timeoutMs = 15_000): Promise<PeerEvent> {
    const index = this.#events.findIndex((event) => event.type === type);
    if (index >= 0) return Promise.resolve(this.#events.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for peer ${type}; ${this.context()}`)), timeoutMs);
      const waiters = this.#waiters.get(type) ?? [];
      waiters.push((event) => { clearTimeout(timer); resolve(event); }); this.#waiters.set(type, waiters);
    });
  }
  waitSendOutcome(timeoutMs = 15_000): Promise<PeerEvent> {
    const index = this.#events.findIndex((event) => event.type === 'sent' || event.type === 'rejected');
    if (index >= 0) return Promise.resolve(this.#events.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for peer send outcome; ${this.context()}`)), timeoutMs);
      this.#sendWaiters.push({ resolve, reject, timer });
    });
  }
  subscribe(listener: (event: TransportEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async restart(): Promise<void> { await this.stop(); this.#child = this.startChild(); await this.wait('ready'); }
  release(): void { this.command({ type: 'release' }); }
  async stop(): Promise<void> {
    const child = this.#child;
    if (child.exitCode !== null) return;
    this.command({ type: 'stop' });
    const timeout = setTimeout(() => child.kill(), 5_000);
    const force = setTimeout(() => child.kill('SIGKILL'), 6_000);
    await once(child, 'exit');
    clearTimeout(timeout); clearTimeout(force);
  }
  private receive(event: PeerEvent): void {
    if (event.type === 'message' && event.peerKey !== undefined && event.bytesHex !== undefined) {
      const delivery: TransportEvent = { type: 'message', peerKey: event.peerKey, bytes: Buffer.from(event.bytesHex, 'hex') };
      for (const listener of this.#listeners) { try { listener(delivery); } catch { /* A harness observer cannot stop the peer. */ } }
    }
    const lifecycle = this.transportEvent(event);
    if (lifecycle !== null) {
      this.#context.push(lifecycle.type === 'error' ? `error:${lifecycle.code}` : `${lifecycle.type}:${lifecycle.peerKey}`);
      if (this.#context.length > 8) this.#context.shift();
      for (const listener of this.#listeners) { try { listener(lifecycle); } catch { /* A harness observer cannot stop the peer. */ } }
    }
    const sendWaiter = (event.type === 'sent' || event.type === 'rejected') ? this.#sendWaiters.shift() : undefined;
    if (sendWaiter !== undefined) { clearTimeout(sendWaiter.timer); sendWaiter.resolve(event); return; }
    const waiter = this.#waiters.get(event.type)?.shift();
    if (waiter !== undefined) waiter(event); else this.#events.push(event);
  }
  private transportEvent(event: PeerEvent): TransportEvent | null {
    if ((event.type === 'connected' || event.type === 'disconnected') && event.peerKey !== undefined) return { type: event.type, peerKey: event.peerKey };
    if (event.type === 'error' && (event.code === 'PEER_OFFLINE' || event.code === 'INVALID_MESSAGE' || event.code === 'CAPACITY_EXCEEDED')) return { type: 'error', code: event.code };
    return null;
  }
  private context(): string { return this.#context.length === 0 ? 'no transport lifecycle events' : `transport events: ${this.#context.join(', ')}`; }
}

async function reserveUdpPort(): Promise<number> {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', () => resolve()); });
  const address = socket.address();
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  if (typeof address === 'string' || address.port === 0) throw new Error('Could not reserve a UDP port');
  return address.port;
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

await main();
