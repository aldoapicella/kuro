import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { openCore, secureIds } from '@kuro/core';
import { FakeAiPort, FakeClock, FakePairing, FakeSession, MemorySelectedFiles } from '@kuro/core/testing';
import { MemoryNetwork, MemoryTransport } from '@kuro/transport';
import type { AppPort, Capability, LocalSession, Result } from '@kuro/contracts';
import type { CustodyCore } from '@kuro/core';

const CUSTODIAN = { memberId: '1'.repeat(32), key: 'a'.repeat(64) };
const REQUESTER = { memberId: '2'.repeat(32), key: 'b'.repeat(64) };
const ALL: Capability[] = ['search', 'read', 'share', 'receive', 'manage'];
const REQUESTER_ACTIONS: Capability[] = ['search', 'read', 'share', 'receive', 'manage'];
type Config = { spaceId: string; alias: string; permittedDocumentId: string; restrictedDocumentId: string; otherSpaceId: string };
type NodeName = 'custodian' | 'requester';
type Node = { core: CustodyCore; app: AppPort; ai: FakeAiPort; clock: FakeClock; pairing: FakePairing; files: MemorySelectedFiles };

class Harness {
  readonly network = new MemoryNetwork();
  readonly nodes = new Map<NodeName, Node>();
  config: Config | null = null;
  private readonly configPath: string;
  constructor(readonly stateDir: string) { this.configPath = join(stateDir, 'harness.json'); }
  async init(): Promise<void> {
    if (existsSync(this.configPath)) throw new Error(`already initialized: ${this.stateDir}`);
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 }); await this.openBoth();
    const custodian = this.node('custodian'); const requester = this.node('requester');
    const space = value(await custodian.app.createSpace({ capabilities: ALL, localActions: ALL })); const alias = secureIds.nextId();
    const enroll = custodian.pairing.verify({ kind: 'member', spaceId: space.spaceId, memberId: REQUESTER.memberId, peerKey: REQUESTER.key, spaceAlias: alias });
    const enrolled = value(await custodian.app.enrollMember({ spaceId: space.spaceId, selectionId: enroll, capabilities: REQUESTER_ACTIONS, validUntilMs: null, expectedRevision: space.policyRevision }));
    const related = value(await custodian.app.setRelationship({ spaceId: space.spaceId, memberId: CUSTODIAN.memberId, otherMemberId: REQUESTER.memberId, allowed: true, validUntilMs: null, expectedRevision: enrolled.policyRevision }));
    value(await custodian.app.setLocalPolicy({ spaceId: space.spaceId, memberId: REQUESTER.memberId, admitted: true, actions: REQUESTER_ACTIONS, validUntilMs: null, expectedRevision: related.policyEpoch }));
    const pairSpace = requester.pairing.verify({ kind: 'authority', spaceId: space.spaceId, authorityKey: CUSTODIAN.key, spaceAlias: alias });
    value(await requester.app.pairSpace({ selectionId: pairSpace, localActions: ALL }));
    this.config = { spaceId: space.spaceId, alias, permittedDocumentId: '', restrictedDocumentId: '', otherSpaceId: '' };
    await this.refresh();
    const requesterSpace = value(await requester.app.getState({})).spaces.find(s => s.spaceId === space.spaceId)!;
    value(await requester.app.setLocalPolicy({ spaceId: space.spaceId, memberId: CUSTODIAN.memberId, admitted: true, actions: ['share'], validUntilMs: null, expectedRevision: requesterSpace.policyEpoch }));
    const peer = requester.pairing.verify({ kind: 'peer', spaceId: space.spaceId, peerKey: CUSTODIAN.key, spaceAlias: alias }); value(await requester.app.pairPeer({ selectionId: peer }));
    this.config.permittedDocumentId = await this.import(custodian, space.spaceId, 'PERMITTED: Acceptance remains provisional until the human reviewer signs the synthetic record.', [{ memberId: CUSTODIAN.memberId, actions: ['read', 'share'], validUntilMs: null }, { memberId: REQUESTER.memberId, actions: ['receive'], validUntilMs: null }]);
    this.config.restrictedDocumentId = await this.import(custodian, space.spaceId, 'RESTRICTED-SENTINEL: Do not disclose this synthetic personnel detail.', [{ memberId: CUSTODIAN.memberId, actions: ['read', 'share'], validUntilMs: null }]);
    const other = value(await custodian.app.createSpace({ capabilities: ALL, localActions: ALL })); this.config.otherSpaceId = other.spaceId;
    await this.import(custodian, other.spaceId, 'PERMITTED: Similar name, but this text belongs to another synthetic space.', [{ memberId: CUSTODIAN.memberId, actions: ['read', 'share'], validUntilMs: null }]);
    this.save(); this.print({ initialized: true, spaceId: space.spaceId, banner: 'SIMULATED AI + SIMULATED MEMORY TRANSPORT. No QVAC or Pear process ran.' });
  }
  async open(): Promise<void> { if (!existsSync(this.configPath)) throw new Error(`not initialized: ${this.stateDir}; run init first`); this.config = JSON.parse(readFileSync(this.configPath, 'utf8')) as Config; await this.openBoth(); }
  async close(): Promise<void> { await Promise.all([...this.nodes.values()].map(node => node.core.stop())); this.nodes.clear(); }
  async state(): Promise<void> { this.print({ custodian: value(await this.node('custodian').app.getState({})), requester: value(await this.node('requester').app.getState({})), networkPendingFrames: this.network.pendingFrames }); }
  async submit(question: string): Promise<void> { this.requireConfig(); this.print(value(await this.node('requester').app.submitQuestion({ spaceId: this.config!.spaceId, custodianKey: CUSTODIAN.key, query: question, ttlSeconds: 3600 }))); }
  async reviews(): Promise<void> { this.requireConfig(); this.print(value(await this.node('custodian').app.listReviews({ spaceId: this.config!.spaceId }))); }
  async inspect(draftId: string): Promise<void> { this.print(value(await this.node('custodian').app.getReview({ draftId }))); }
  async revise(draftId: string, ids: string, summary: string): Promise<void> { const current = value(await this.node('custodian').app.getReview({ draftId })); const selectedSpanIds = ids === 'all' ? current.passages.map(p => p.ref.spanId) : ids.split(','); this.print(value(await this.node('custodian').app.reviseDraft({ draftId, expectedRevision: current.revision, reviewedViewDigest: current.viewDigest, selectedSpanIds, conditions: conditions(summary, current.expiresAtMs) }))); }
  async approve(draftId: string, revision: string, digest: string): Promise<void> { this.print(value(await this.node('custodian').app.approveDraft({ draftId, expectedRevision: Number(revision), reviewedViewDigest: digest }))); }
  async evidence(responseId: string): Promise<void> { this.print(value(await this.node('requester').app.getEvidence({ responseId }))); }
  async summary(responseId: string): Promise<void> { const requester = this.node('requester'); requester.ai.generationAvailable = false; const unavailable = await requester.app.requestLocalSummary({ responseId }); requester.ai.generationAvailable = true; const started = value(await requester.app.requestLocalSummary({ responseId })); await this.pump(); this.print({ unavailable, started, summary: value(await requester.app.getSummary({ summaryId: started.summaryId })) }); }
  async pump(turns = 4): Promise<void> { for (let turn = 0; turn < turns; turn++) { await Promise.all([...this.nodes.values()].map(node => node.core.tick())); this.network.flush(); await Promise.all([...this.nodes.values()].map(node => node.core.settled())); } this.print({ pumped: turns, pendingFrames: this.network.pendingFrames }); }
  async refresh(): Promise<void> { this.requireConfig(); this.print(value(await this.node('requester').app.refreshSpace({ spaceId: this.config!.spaceId }))); await this.pump(); }
  async restart(name: NodeName): Promise<void> { if (name !== 'custodian' && name !== 'requester') throw new Error('restart requires requester or custodian'); await this.node(name).core.stop(); this.nodes.delete(name); await this.openNode(name); this.print({ restarted: name, mode: 'orderly close/reopen in one process; not a process-crash claim' }); }
  async revoke(): Promise<void> { this.requireConfig(); const app = this.node('custodian').app; const space = value(await app.getState({})).spaces.find(s => s.spaceId === this.config!.spaceId)!; this.print(value(await app.setMember({ spaceId: space.spaceId, memberId: REQUESTER.memberId, active: false, capabilities: [], validUntilMs: null, expectedRevision: space.policyRevision }))); }
  async advance(ms: string): Promise<void> { const amount = Number(ms); if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('advance requires nonnegative integer milliseconds'); for (const node of this.nodes.values()) node.clock.advance(amount); this.print({ advancedMs: amount, note: 'Run pump to service retries, expiry, and queued synchronization.' }); }
  fault(name: string): void { if (name === 'drop-ack') this.network.setFaults({ loss: true }); else if (name === 'none') this.network.setFaults({}); else throw new Error('fault must be drop-ack or none'); this.print({ fault: name, note: name === 'drop-ack' ? 'Run immediately after evidence is received, before the next pump, to drop the queued ACK.' : undefined }); }
  private async openBoth(): Promise<void> { await this.openNode('custodian'); await this.openNode('requester'); }
  private async openNode(name: NodeName): Promise<void> { const identity = name === 'custodian' ? CUSTODIAN : REQUESTER; const clock = new FakeClock(); const pairing = new FakePairing(secureIds); const files = new MemorySelectedFiles(secureIds); const ai = new FakeAiPort(); const transport = new MemoryTransport({ network: this.network, publicKey: identity.key, pairedPeers: [name === 'custodian' ? REQUESTER.key : CUSTODIAN.key] }); const session: LocalSession = { memberId: identity.memberId, deviceKey: identity.key, validUntilMs: Number.MAX_SAFE_INTEGER }; const core = await openCore({ databasePath: join(this.stateDir, `${name}.sqlite`), ai, transport, clock, ids: secureIds, sessions: new FakeSession(session), selectedFiles: files, pairing, clockInitiallyTrusted: true }); this.nodes.set(name, { core, app: core.app, ai, clock, pairing, files }); }
  private async import(node: Node, spaceId: string, text: string, rules: { memberId: string; actions: Capability[]; validUntilMs: null }[]): Promise<string> { const selectionId = node.files.add(text); const imported = value(await node.app.importText({ spaceId, selectionId, replaceDocumentId: null, expectedRevision: null, rules })); await this.pump(); return imported.documentId; }
  private node(name: NodeName): Node { const node = this.nodes.get(name); if (!node) throw new Error(`${name} is not running`); return node; }
  private requireConfig(): void { if (!this.config) throw new Error('harness is not initialized'); }
  private save(): void { writeFileSync(this.configPath, `${JSON.stringify(this.config)}\n`, { mode: 0o600 }); }
  private print(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
}
function value<T>(result: Result<T>): T { if (!result.ok) throw new Error(`core returned ${result.error.code}`); return result.value; }
function conditions(summary: string, expiresAtMs: number) { if (summary !== 'summary' && summary !== 'none') throw new Error('conditions must be summary or none'); return { v: 1 as const, allowLocalSummary: summary === 'summary', forwarding: 'forbidden' as const, validForSeconds: 3600, notAfterMs: expiresAtMs }; }
function usage(): string { return 'commands: init | state | submit <question> | reviews | inspect <draft> | revise <draft> <all|spanIds> <summary|none> | review-conditions <draft> <summary|none> | approve <draft> <revision> <digest> | pump [turns] | evidence <response> | summary <response> | fault <drop-ack|none> | restart <requester|custodian> | revoke | advance <ms> | refresh | quit'; }
const stateFlag = process.argv.indexOf('--state'); const stateDir = resolve(stateFlag >= 0 && process.argv[stateFlag + 1] ? process.argv[stateFlag + 1]! : join(process.cwd(), '.kuro-core-harness')); const harness = new Harness(stateDir); let opened = false;
async function execute(line: string): Promise<boolean> { const [command = '', ...rest] = line.trim().split(/\s+/); if (!command || command.startsWith('#')) return true; if (command === 'init') { await harness.init(); opened = true; return true; } if (command === 'quit') return false; if (!opened) { await harness.open(); opened = true; } switch (command) { case 'state': await harness.state(); break; case 'submit': await harness.submit(rest.join(' ')); break; case 'reviews': await harness.reviews(); break; case 'inspect': await harness.inspect(required(rest, 0)); break; case 'revise': await harness.revise(required(rest, 0), required(rest, 1), required(rest, 2)); break; case 'review-conditions': await harness.revise(required(rest, 0), 'all', required(rest, 1)); break; case 'approve': await harness.approve(required(rest, 0), required(rest, 1), required(rest, 2)); break; case 'pump': await harness.pump(rest[0] ? Number(rest[0]) : 4); break; case 'evidence': await harness.evidence(required(rest, 0)); break; case 'summary': await harness.summary(required(rest, 0)); break; case 'fault': harness.fault(required(rest, 0)); break; case 'restart': await harness.restart(required(rest, 0) as NodeName); break; case 'revoke': await harness.revoke(); break; case 'advance': await harness.advance(required(rest, 0)); break; case 'refresh': await harness.refresh(); break; case 'help': process.stdout.write(`${usage()}\n`); break; default: throw new Error(`unknown command: ${command}; ${usage()}`); } return true; }
function required(values: string[], index: number): string { const value = values[index]; if (!value) throw new Error(`missing argument; ${usage()}`); return value; }
const lines = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout, prompt: 'kuro-core> ' }) : createInterface({ input: process.stdin });
if (process.stdin.isTTY) { process.stdout.write('SIMULATED AI + SIMULATED MEMORY TRANSPORT. No QVAC or Pear process ran.\n'); lines.prompt(); }
for await (const line of lines) {
  try { if (!await execute(line)) break; }
  catch (error) { process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`); }
  if (process.stdin.isTTY) lines.prompt();
}
await harness.close();
