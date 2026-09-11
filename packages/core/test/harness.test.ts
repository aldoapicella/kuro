import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { EvidenceView, ReviewView, StateView } from '@kuro/contracts';

type HarnessState = { custodian: StateView; requester: StateView; droppedAcks: number };
type Output = { state: HarnessState; messages: unknown[] };

/** Drive the actual documented CLI; the tests never import the harness implementation. */
class HarnessCli {
  readonly child: ChildProcessWithoutNullStreams;
  readonly errors: string[] = [];
  readonly exit: Promise<number | null>;
  private messages: unknown[] = [];
  private pending: { resolve(output: Output): void; reject(error: Error): void } | null = null;

  constructor(directory: string) {
    const script = fileURLToPath(new URL('../../../harnesses/core/src/main.ts', import.meta.url));
    this.child = spawn(process.execPath, ['--import', 'tsx', script, '--state', directory], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.exit = new Promise(resolve => this.child.once('exit', code => {
      this.pending?.reject(new Error(`Harness exited with ${code}: ${this.errors.join('\n')}`));
      this.pending = null;
      resolve(code);
    }));
    this.child.on('error', error => this.pending?.reject(error));
    this.child.stdin.on('error', error => this.pending?.reject(error));
    createInterface({ input: this.child.stderr }).on('line', line => this.errors.push(line));
    createInterface({ input: this.child.stdout }).on('line', line => {
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { this.pending?.reject(new Error(`Non-JSON harness output: ${line}`)); return; }
      if (typeof value === 'object' && value !== null && 'custodian' in value && 'requester' in value) {
        const pending = this.pending;
        this.pending = null;
        pending?.resolve({ state: value as HarnessState, messages: this.messages.splice(0) });
      } else this.messages.push(value);
    });
  }

  async run(command: string): Promise<Output> {
    assert.equal(this.pending, null, 'CLI commands must remain sequential');
    const output = new Promise<Output>((resolve, reject) => { this.pending = { resolve, reject }; });
    const timer = setTimeout(() => {
      this.pending?.reject(new Error(`Harness timed out at ${command}: ${this.errors.join('\n')}`));
      this.pending = null;
      this.child.kill('SIGKILL');
    }, 15_000);
    this.child.stdin.write(`${command}\nstate\n`);
    try { return await output; }
    finally { clearTimeout(timer); }
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 5_000);
    this.child.stdin.end('quit\n');
    try { assert.equal(await this.exit, 0, this.errors.join('\n')); }
    finally { clearTimeout(timer); }
  }
}

function row(directory: string, peer: string, sql: string, responseId: string) {
  const db = new DatabaseSync(join(directory, `${peer}.sqlite`), { readOnly: true });
  try { return db.prepare(sql).get(responseId)!; }
  finally { db.close(); }
}

async function review(cli: HarnessCli): Promise<ReviewView> {
  await cli.run('submit What acceptance remains provisional?');
  await cli.run('pump');
  const output = await cli.run('reviews');
  const views = output.messages.find(Array.isArray) as ReviewView[] | undefined;
  assert.equal(views?.length, 1, JSON.stringify({ output, errors: cli.errors }));
  assert.equal(views[0]!.passages.length, 1);
  assert.match(views[0]!.passages[0]!.text, /^PERMITTED:/);
  return views[0]!;
}

async function approve(cli: HarnessCli, view: ReviewView): Promise<string> {
  const output = await cli.run(`approve ${view.draftId} ${view.revision} ${view.viewDigest}`);
  const approval = output.messages.find(value => typeof value === 'object' && value !== null && 'responseId' in value) as { responseId: string } | undefined;
  assert.ok(approval);
  return approval.responseId;
}

test('manual CLI drops only ACKs and preserves advanced time through peer and process reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kuro-harness-ack-'));
  let cli = new HarnessCli(directory);
  try {
    await cli.run('init');
    await cli.run('fault drop-ack');
    const responseId = await approve(cli, await review(cli));
    let output = await cli.run('pump');
    assert.deepEqual(output.state.requester.evidenceIds, [responseId], 'ACK loss must not drop requests or evidence');
    assert.ok(output.state.droppedAcks >= 1, 'the targeted ACK fault must actually occur');
    const before = row(directory, 'custodian', 'SELECT a.bytes, o.state FROM approvals a JOIN outbox o USING(response_id) WHERE response_id=?', responseId);
    assert.notEqual(before.state, 'ACKED');
    const evidence = (await cli.run(`evidence ${responseId}`)).messages.find(value => typeof value === 'object' && value !== null && 'bodyDigest' in value) as EvidenceView;
    assert.ok(evidence);

    await cli.run('advance 6000');
    output = await cli.run('restart requester');
    assert.equal(output.state.requester.clockEpochValid, true, 'restart must not invent a wall-clock rollback');
    assert.equal(output.state.requester.spaces[0]!.syncState, 'STALE');
    await cli.run('fault none');
    await cli.run('refresh');
    output = await cli.run('pump');
    assert.deepEqual(output.state.requester.evidenceIds, [responseId]);
    const after = row(directory, 'custodian', 'SELECT a.bytes, o.state, o.attempts FROM approvals a JOIN outbox o USING(response_id) WHERE response_id=?', responseId);
    assert.equal(after.state, 'ACKED');
    assert.ok(Number(after.attempts) >= 2);
    assert.deepEqual(after.bytes, before.bytes);
    assert.equal(row(directory, 'requester', 'SELECT count(*) n FROM inbox WHERE response_id=?', responseId).n, 1);

    await cli.close();
    cli = new HarnessCli(directory);
    await cli.run('advance 6000');
    output = await cli.run('refresh');
    assert.equal(output.state.requester.clockEpochValid, true);
    assert.equal(output.state.requester.spaces[0]!.syncState, 'CURRENT', JSON.stringify({ output, errors: cli.errors }));
    const reopened = (await cli.run(`evidence ${responseId}`)).messages.find(value => typeof value === 'object' && value !== null && 'bodyDigest' in value) as EvidenceView;
    assert.equal(reopened.bodyDigest, evidence.bodyDigest);
    assert.equal(reopened.expiresAtMs, evidence.expiresAtMs, 'reopen must not extend received evidence validity');
    assert.equal(cli.errors.filter(line => line.startsWith('ERROR:')).length, 0, cli.errors.join('\n'));
  } finally { await cli.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('manual CLI exposes the original outage lease and regrant cannot revive a cancelled approval', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kuro-harness-outage-'));
  const cli = new HarnessCli(directory);
  try {
    await cli.run('init');
    const receivedId = await approve(cli, await review(cli));
    await cli.run('pump');
    await cli.run('fault disconnect');
    let output = await cli.run('advance 899999');
    assert.equal(output.state.requester.spaces[0]!.remainingValidityMs, 1);
    const readable = await cli.run(`evidence ${receivedId}`);
    assert.ok(readable.messages.some(value => typeof value === 'object' && value !== null && 'bodyDigest' in value));
    await cli.run('pump');
    output = await cli.run('advance 1');
    assert.equal(output.state.requester.spaces[0]!.syncState, 'EXPIRED');
    assert.equal(output.state.requester.spaces[0]!.remainingValidityMs, 0);
    assert.deepEqual(output.state.requester.evidenceIds, [], 'expired authority must gate evidence display');
    assert.equal(row(directory, 'requester', 'SELECT count(*) n FROM inbox WHERE response_id=?', receivedId).n, 1, 'expiry must not erase durable receipt');
    await cli.run('fault none');
    await cli.run('advance 11000');
    await cli.run('refresh');
    await cli.run('advance 1000');
    output = await cli.run('pump');
    assert.equal(output.state.requester.spaces[0]!.syncState, 'CURRENT', JSON.stringify({ output, errors: cli.errors }));

    const pendingId = await approve(cli, await review(cli));
    await cli.run('revoke');
    await cli.run('advance 6000');
    await cli.run('refresh');
    await cli.run('advance 1000');
    output = await cli.run('pump');
    assert.equal(output.state.requester.spaces[0]!.syncState, 'DENIED');
    assert.equal(row(directory, 'custodian', 'SELECT state FROM outbox WHERE response_id=?', pendingId).state, 'CANCELLED');
    await cli.run('regrant');
    await cli.run('advance 6000');
    await cli.run('refresh');
    await cli.run('advance 1000');
    output = await cli.run('pump');
    assert.equal(output.state.requester.spaces[0]!.syncState, 'CURRENT');
    assert.equal(row(directory, 'custodian', 'SELECT state FROM outbox WHERE response_id=?', pendingId).state, 'CANCELLED');
    assert.equal(row(directory, 'requester', 'SELECT count(*) n FROM inbox WHERE response_id=?', pendingId).n, 0);
    assert.ok(!output.state.requester.evidenceIds.includes(pendingId));
    const freshId = await approve(cli, await review(cli));
    output = await cli.run('pump');
    assert.ok(output.state.requester.evidenceIds.includes(freshId), 'a new explicit approval must still work after regrant');
    assert.ok(!output.state.requester.evidenceIds.includes(pendingId));
    assert.equal(row(directory, 'custodian', 'SELECT state FROM outbox WHERE response_id=?', freshId).state, 'ACKED');
    assert.equal(cli.errors.filter(line => line.startsWith('ERROR:')).length, 0, cli.errors.join('\n'));
  } finally { await cli.close(); rmSync(directory, { recursive: true, force: true }); }
});
