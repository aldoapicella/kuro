import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSocket } from 'node:dgram';
import { createInterface } from 'node:readline';
import HyperDHT from 'hyperdht';
import type { AppCommandName, AppInput, AppOutputs, Capability, Result, StateView } from '@kuro/contracts';

const ALL: Capability[] = ['search', 'read', 'share', 'receive', 'manage'];
const OWNER = '1'.repeat(32); const REQUESTER = '2'.repeat(32); const alias = 'c'.repeat(32);
type VmConfig = { mode: 'local' | 'ssh'; ai: 'simulated' | 'qvac'; bootstrapHost: string; sshConfig?: string; sshHost?: string; guestRepository?: string; guestStateRoot?: string; hostStateRoot?: string; guestPort?: number };
type PeerOutput = { provider?: string; rankCandidateIds?: string[]; aiAvailable?: boolean; type?: string; requestId?: string; publicKey?: string; result?: Result<unknown>; selectionId?: string; diagnostics?: { records: Array<{ direction: string; type: string; digest: string }>; droppedAcks: number; lifecycle: string[] }; stopped?: boolean; aiCalls?: string[]; error?: string };

class Peer {
  #child: ChildProcess; #events: PeerOutput[] = [];
  #waiters = new Map<string, { resolve(event: PeerOutput): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  #failure: Error | null = null; readonly #exit: Promise<void>;
  constructor(start: () => ChildProcess, readonly label: string) {
    this.#child = start();
    this.#exit = new Promise(resolve => {
      this.#child.once('exit', (code, signal) => { this.fail(new Error(`${label} exited (${code ?? signal})`)); resolve(); });
      this.#child.once('error', error => { this.fail(error); resolve(); });
    });
    this.#child.stdin!.on('error', error => this.fail(error)); this.listen();
  }
  private listen(): void {
    createInterface({ input: this.#child.stdout! }).on('line', line => { try { this.receive(JSON.parse(line) as PeerOutput); } catch { /* endpoint only emits JSON */ } });
    this.#child.stderr!.on('data', data => process.stderr.write(`[${this.label}] ${data}`));
  }
  private fail(error: Error): void { this.#failure = error; for (const waiter of this.#waiters.values()) { clearTimeout(waiter.timer); waiter.reject(error); } this.#waiters.clear(); }
  private receive(event: PeerOutput): void { const key = event.requestId ?? event.type ?? ''; const waiter = this.#waiters.get(key); if (waiter) { clearTimeout(waiter.timer); this.#waiters.delete(key); waiter.resolve(event); } else { this.#events.push(event); if (this.#events.length > 64) this.#events.shift(); } }
  wait(key: string, timeout = 20_000): Promise<PeerOutput> { const i = this.#events.findIndex(e => (e.requestId ?? e.type) === key); if (i >= 0) return Promise.resolve(this.#events.splice(i, 1)[0]!); if (this.#failure) return Promise.reject(this.#failure); return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.#waiters.delete(key); reject(new Error(`${this.label} timed out waiting for ${key}`)); }, timeout); this.#waiters.set(key, {resolve,reject,timer}); }); }
  async ready(expectedProvider: string): Promise<string> { const event = await this.wait('ready'); if (event.provider !== expectedProvider) throw new Error(`${this.label} selected the wrong AI provider`); if (!event.publicKey) throw new Error(`${this.label} has no public key`); return event.publicKey; }
  async command(value: object): Promise<PeerOutput> { const requestId = (value as { requestId: string }).requestId; this.#child.stdin!.write(`${JSON.stringify(value)}\n`); const event = await this.wait(requestId); if (event.error) throw new Error(`${this.label}: ${event.error}`); return event; }
  async stop(): Promise<void> { if (this.#child.exitCode !== null || this.#child.signalCode !== null) return; const force = setTimeout(() => this.#child.kill('SIGKILL'), 5_000); try { await this.command({ requestId: `stop-${randomUUID()}`, action: 'stop' }); } catch { this.#child.kill(); } finally { await this.#exit; clearTimeout(force); } }
}

function config(): VmConfig {
  const raw = process.env.KURO_VM_TEST_CONFIG;
  const value = JSON.parse(raw ?? '{}') as Partial<VmConfig>;
  const mode = value.mode ?? (raw === undefined ? 'local' : 'ssh'); const ai = value.ai ?? 'simulated';
  if (mode !== 'local' && mode !== 'ssh') throw new Error('mode must be local or ssh');
  if (ai !== 'simulated' && ai !== 'qvac') throw new Error('ai must be simulated or qvac');
  const bootstrapHost = value.bootstrapHost ?? (mode === 'local' ? '127.0.0.1' : undefined);
  if (typeof bootstrapHost !== 'string' || !bootstrapHost) throw new Error('bootstrapHost is required');
  if (mode === 'ssh') for (const key of ['sshConfig', 'sshHost', 'guestRepository', 'guestStateRoot'] as const) if (typeof value[key] !== 'string' || !value[key]) throw new Error(`${key} is required`);
  return { ...value, mode, ai, bootstrapHost };
}
function shell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function ok<T>(output: PeerOutput): T { const result = output.result as Result<T> | undefined; if (!result?.ok) throw new Error(`public AppPort error: ${result?.ok === false ? result.error.code : 'missing result'}`); return result.value; }
async function app<K extends AppCommandName>(peer: Peer, method: K, input: AppInput<K>): Promise<AppOutputs[K]> { return ok<AppOutputs[K]>(await peer.command({ requestId: randomUUID(), action: 'app', method, input })); }
async function verify(peer: Peer, binding: object): Promise<string> { const out = await peer.command({ requestId: randomUUID(), action: 'verify', binding }); if (!out.selectionId) throw new Error('missing selection id'); return out.selectionId; }
async function select(peer: Peer, text: string): Promise<string> { const out = await peer.command({ requestId: randomUUID(), action: 'selectText', text }); if (!out.selectionId) throw new Error('missing selection id'); return out.selectionId; }
async function diagnostics(peer: Peer) { const out = await peer.command({ requestId: randomUUID(), action: 'diagnostics' }); if (!out.diagnostics) throw new Error('missing diagnostics'); return { ...out.diagnostics, aiCalls: out.aiCalls ?? [], rankCandidateIds: out.rankCandidateIds ?? [], aiAvailable: out.aiAvailable }; }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function reservePort(): Promise<number> { const socket = createSocket('udp4'); await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, '0.0.0.0', resolve); }); const address = socket.address(); await new Promise<void>(resolve => socket.close(() => resolve())); if (typeof address === 'string') throw new Error('no UDP port'); return address.port; }

async function main(): Promise<void> {
  const vm = config(); const provider = vm.ai === 'qvac' ? 'qvac+realHyperDHT' : 'simulatedAI+realHyperDHT'; const run = randomUUID(); const hostState = vm.hostStateRoot ? join(resolve(vm.hostStateRoot), `virtual-core-${run}`) : mkdtempSync(join(tmpdir(), 'kuro-virtual-core-'));
  const bootstrapper = HyperDHT.bootstrapper(await reservePort(), vm.bootstrapHost); await bootstrapper.fullyBootstrapped();
  const bootstrap = [{ host: vm.bootstrapHost, port: bootstrapper.address().port }]; const router = new HyperDHT({ bootstrap, port: await reservePort(), ephemeral: false, host: vm.bootstrapHost, firewalled: false }); await router.fullyBootstrapped();
  const ownerSeed = randomBytes(32); const requesterSeed = randomBytes(32); const ownerKey = Buffer.from(HyperDHT.keyPair(ownerSeed).publicKey).toString('hex'); const requesterKey = Buffer.from(HyperDHT.keyPair(requesterSeed).publicKey).toString('hex');
  const endpoint = new URL('../../core/src/network-peer.ts', import.meta.url).pathname;
  const hostConfig = { ai: vm.ai, stateDirectory: hostState, seedHex: ownerSeed.toString('hex'), pairedPeers: [requesterKey], bootstrap, memberId: OWNER, localPort: await reservePort() };
  const guestConfig = { ai: vm.ai, stateDirectory: vm.mode === 'local' ? join(hostState, 'requester') : `${vm.guestStateRoot}/virtual-core-${run}`, seedHex: requesterSeed.toString('hex'), pairedPeers: [ownerKey], bootstrap, memberId: REQUESTER, localPort: vm.guestPort ?? (vm.mode === 'local' ? await reservePort() : 49747) };
  const host = new Peer(() => spawn(process.execPath, ['--import', 'tsx', endpoint], { env: { ...process.env, KURO_CORE_PEER_CONFIG: JSON.stringify(hostConfig) }, stdio: ['pipe', 'pipe', 'pipe'] }), 'host');
  const remoteStart = () => vm.mode === 'local'
    ? spawn(process.execPath, ['--import', 'tsx', endpoint], { env: { ...process.env, KURO_CORE_PEER_CONFIG: JSON.stringify(guestConfig) }, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn('ssh', ['-F', vm.sshConfig!, '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', vm.sshHost!, `export PATH="$HOME/.local/bin:$PATH"; cd ${shell(vm.guestRepository!)} && env KURO_CORE_PEER_CONFIG=${shell(JSON.stringify(guestConfig))} node --import tsx harnesses/core/src/network-peer.ts`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let guest = new Peer(remoteStart, 'requester');
  const pump = async (rounds = 8) => { for (let n = 0; n < rounds; n++) { await app(host, 'getState', {}); await host.command({ requestId: randomUUID(), action: 'tick' }); await guest.command({ requestId: randomUUID(), action: 'tick' }); await sleep(100); } };
  const until = async <T>(probe: () => Promise<T>, accept: (value: T) => boolean, label: string, timeout = 45_000): Promise<T> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await probe(); if (accept(value)) return value; await pump(1); }
    throw new Error(`Timed out waiting for ${label}`);
  };
  try {
    const [actualOwnerKey, actualRequesterKey] = await Promise.all([host.ready(provider), guest.ready(provider)]); if (actualOwnerKey !== ownerKey || actualRequesterKey !== requesterKey) throw new Error('seed-derived identity mismatch');
    const initial = await app(host, 'createSpace', { capabilities: ALL, localActions: ALL }); const spaceId = initial.spaceId;
    const member = await verify(host, { kind: 'member', spaceId, memberId: REQUESTER, peerKey: requesterKey, spaceAlias: alias });
    let ownerView = await app(host, 'enrollMember', { spaceId, selectionId: member, capabilities: ALL, validUntilMs: null, expectedRevision: initial.policyRevision });
    ownerView = await app(host, 'setRelationship', { spaceId, memberId: OWNER, otherMemberId: REQUESTER, allowed: true, validUntilMs: null, expectedRevision: ownerView.policyRevision });
    const pin = await verify(guest, { kind: 'authority', spaceId, authorityKey: ownerKey, spaceAlias: alias }); await app(guest, 'pairSpace', { selectionId: pin, localActions: ALL }); await app(guest, 'refreshSpace', { spaceId }); await pump();
    let guestState = await until(() => app(guest, 'getState', {}), state => space(state, spaceId).syncState === 'CURRENT', 'fresh authority projection');
    output({ phase: 'authority-current' });
    ownerView = await app(host, 'setLocalPolicy', { spaceId, memberId: REQUESTER, admitted: true, actions: ALL, validUntilMs: null, expectedRevision: ownerView.policyEpoch });
    await app(guest, 'setLocalPolicy', { spaceId, memberId: OWNER, admitted: true, actions: ALL, validUntilMs: null, expectedRevision: space(guestState, spaceId).policyEpoch });
    const peer = await verify(guest, { kind: 'peer', spaceId, peerKey: ownerKey, spaceAlias: alias }); await app(guest, 'pairPeer', { selectionId: peer });
    const rules = [{ memberId: OWNER, actions: ALL, validUntilMs: null }, { memberId: REQUESTER, actions: ['receive'] as Capability[], validUntilMs: null }];
    const importText = async (target: string, text: string, documentRules: typeof rules) => {
      const selectionId = await select(host, text);
      const imported = await app(host, 'importText', { spaceId: target, selectionId, replaceDocumentId: null, expectedRevision: null, rules: documentRules });
      const state = await until(() => app(host, 'getState', {}), state => state.documents.some(doc => doc.documentId === imported.documentId && doc.ingestionState !== 'PENDING'), 'document ingestion', 150_000);
      if (state.documents.find(doc => doc.documentId === imported.documentId)?.ingestionState !== 'COMPLETE') throw new Error('document indexing did not complete');
    };
    await importText(spaceId, 'Outstanding observations remain provisional.', rules); await importText(spaceId, 'RESTRICTED-SENTINEL must never reach review.', [rules[0]!]);
    const other = await app(host, 'createSpace', { capabilities: ALL, localActions: ALL }); await importText(other.spaceId, 'Outstanding observations remain provisional.', [rules[0]!]);
    await app(guest, 'submitQuestion', { spaceId, custodianKey: ownerKey, query: 'What observations remain?', ttlSeconds: 3600 }); await pump();
    let reviews = await until(() => app(host, 'listReviews', { spaceId }), views => views.length === 1, 'authorized review', 150_000); if (reviews.length !== 1 || reviews[0]!.passages.length !== 1 || reviews[0]!.passages[0]!.text !== 'Outstanding observations remain provisional.') throw new Error('forbidden or cross-space text reached review');
    const candidates = (await diagnostics(host)).rankCandidateIds;
    if (JSON.stringify(candidates) !== JSON.stringify(reviews[0]!.passages.map(passage => passage.ref.spanId))) throw new Error('unauthorized vector reached rankAllowed');
    const reviewed = await app(host, 'reviseDraft', { draftId: reviews[0]!.draftId, expectedRevision: reviews[0]!.revision, reviewedViewDigest: reviews[0]!.viewDigest, selectedSpanIds: reviews[0]!.selectedSpanIds, conditions: { v: 1, allowLocalSummary: true, forwarding: 'forbidden', validForSeconds: 3600, notAfterMs: reviews[0]!.expiresAtMs } });
    output({ phase: 'review', syntheticView: reviewed });
    const wrongDigest = `${reviewed.viewDigest[0] === '0' ? '1' : '0'}${reviewed.viewDigest.slice(1)}`;
    for (const token of [{ expectedRevision: reviewed.revision + 1, reviewedViewDigest: reviewed.viewDigest }, { expectedRevision: reviewed.revision, reviewedViewDigest: wrongDigest }]) {
      const invalid = await host.command({ requestId: randomUUID(), action: 'app', method: 'approveDraft', input: { draftId: reviewed.draftId, ...token } });
      if (!invalid.result || invalid.result.ok || invalid.result.error.code !== 'STALE_REVISION') throw new Error('approval accepted a stale review token');
    }
    await guest.command({ requestId: randomUUID(), action: 'setDropAck', enabled: true }); const first = await app(host, 'approveDraft', { draftId: reviewed.draftId, expectedRevision: reviewed.revision, reviewedViewDigest: reviewed.viewDigest }); await pump();
    guestState = await until(() => app(guest, 'getState', {}), state => state.evidenceIds.length === 1, 'durable first evidence'); const evidence = await app(guest, 'getEvidence', { responseId: first.responseId }); const firstDigest = evidence.bodyDigest; const receiptDiagnostics = await diagnostics(guest); if (receiptDiagnostics.droppedAcks < 1) throw new Error('ACK fault was not observed');
    if (receiptDiagnostics.aiCalls.some(method => method === 'prepareSummary' || method === 'runPreparedSummary')) throw new Error('receipt automatically invoked summary inference');
    output({ phase: 'evidence-durable-ack-dropped', responseId: first.responseId });
    await guest.stop(); guest = new Peer(remoteStart, 'requester'); if (await guest.ready(provider) !== requesterKey) throw new Error('requester restart changed identity'); await sleep(5500); await app(guest, 'refreshSpace', { spaceId }); await until(() => app(guest, 'getState', {}), state => space(state, spaceId).syncState === 'CURRENT', 'fresh projection after restart'); const hostDiag = await until(() => diagnostics(host), d => d.records.some(r => r.direction === 'in' && r.type === 'RESPONSE_ACK') && d.records.filter(r => r.direction === 'out' && r.type === 'APPROVED_RESPONSE' && r.digest === firstDigest).length >= 2, 'immutable retry and received ACK'); if (hostDiag.records.filter(r => r.direction === 'out' && r.type === 'APPROVED_RESPONSE' && r.digest === firstDigest).length < 2) throw new Error('immutable response was not retried'); guestState = await app(guest, 'getState', {}); if (guestState.evidenceIds.length !== 1) throw new Error('retry duplicated inbox evidence');
    output({ phase: 'restart-immutable-retry-acknowledged', inboxEffects: 1 });
    const beforeSummary = await diagnostics(guest);
    if (beforeSummary.aiCalls.some(method => method === 'prepareSummary' || method === 'runPreparedSummary')) throw new Error('receipt automatically invoked summary inference');
    await guest.command({ requestId: randomUUID(), action: 'setAiAvailable', available: false }); await app(guest, 'getEvidence', { responseId: first.responseId }); const unavailable = await guest.command({ requestId: randomUUID(), action: 'app', method: 'requestLocalSummary', input: { responseId: first.responseId } }); const unavailableResult = unavailable.result as Result<unknown> | undefined; if (!unavailableResult || unavailableResult.ok || unavailableResult.error.code !== 'MODEL_UNAVAILABLE') throw new Error('summary did not fail honestly'); await guest.command({ requestId: randomUUID(), action: 'setAiAvailable', available: true }); const summaryStart = await app(guest, 'requestLocalSummary', { responseId: first.responseId }); await pump(); const summary = await until(() => app(guest, 'getSummary', { summaryId: summaryStart.summaryId }), view => view.state !== 'SUMMARY_PENDING' && view.state !== 'RUNNING', 'explicit summary draft', 150_000); if (summary.state !== 'DRAFT' || summary.claims[0]?.quotes[0]?.text !== evidence.passages[0]!.text) throw new Error('summary provenance mismatch');
    const summaryCalls = (await diagnostics(guest)).aiCalls;
    if (!summaryCalls.includes('prepareSummary') || !summaryCalls.includes('runPreparedSummary')) throw new Error('explicit summary did not invoke the selected adapter');
    output({ phase: 'model-free-read-and-explicit-summary', provider, summary });
    await app(guest, 'submitQuestion', { spaceId, custodianKey: ownerKey, query: 'What observations remain now?', ttlSeconds: 3600 }); await pump(); reviews = await until(() => app(host, 'listReviews', { spaceId }), views => views.length === 1, 'second authorized review', 150_000); const secondReview = reviews[0]!; const second = await app(host, 'approveDraft', { draftId: secondReview.draftId, expectedRevision: secondReview.revision, reviewedViewDigest: secondReview.viewDigest }); const before = (await diagnostics(host)).records.filter(r => r.direction === 'out' && r.type === 'APPROVED_RESPONSE').length;
    ownerView = space(await app(host, 'getState', {}), spaceId); await app(host, 'setLocalPolicy', { spaceId, memberId: REQUESTER, admitted: false, actions: [], validUntilMs: null, expectedRevision: ownerView.policyEpoch }); await pump(); const after = (await diagnostics(host)).records.filter(r => r.direction === 'out' && r.type === 'APPROVED_RESPONSE').length; if (after !== before) throw new Error(`revoked response ${second.responseId} dispatched`);
    ownerView = space(await app(host, 'getState', {}), spaceId); await app(host, 'setMember', { spaceId, memberId: REQUESTER, active: false, capabilities: [], validUntilMs: null, expectedRevision: ownerView.policyRevision }); await sleep(5500); await app(guest, 'refreshSpace', { spaceId }); await until(() => app(guest, 'getState', {}), state => space(state, spaceId).syncState === 'DENIED', 'durable denial projection');
    output({ phase: 'complete', run, provider, networkMode: vm.mode, stateDirectories: { host: hostState, guest: guestConfig.stateDirectory }, banner: `AUTOMATED SYNTHETIC TEST: ${provider}; explicit automated approval commands and test identities. ${vm.mode === 'local' ? 'Two local processes, not physical-device validation.' : 'Remote peer networking; physical or virtual scope depends on the supplied host.'}` });
  } catch (error) {
    const details = await Promise.allSettled([diagnostics(host), diagnostics(guest)]);
    output({ phase: 'failure-diagnostics', diagnostics: details.map(item => item.status === 'fulfilled' ? item.value : { unavailable: true }) });
    throw error;
  } finally { await Promise.allSettled([host.stop(), guest.stop()]); await router.destroy(); await bootstrapper.destroy(); }
}
function space(state: StateView, id: string) { const value = state.spaces.find(item => item.spaceId === id); if (!value) throw new Error('missing space'); return value; }
function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
await main().catch(error => { output({ phase: 'failed', error: error instanceof Error ? error.message : 'failure', banner: 'AUTOMATED SYNTHETIC TEST failed; inspect bounded endpoint diagnostics from peer output.' }); process.exitCode = 1; });
