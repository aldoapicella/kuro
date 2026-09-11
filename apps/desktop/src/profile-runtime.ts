import { mkdir, readFile, open, rm } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppCommands, DesktopCommands, VerifiedBindingSchema, failure, KuroError } from '@kuro/contracts';
import type { AppCommandName, AppInput, AppOutputs, CommittedEvent, DesktopInfo, DesktopNetwork, DesktopSetup, ErrorCode, Result, SecretStore, VerifiedBinding } from '@kuro/contracts';
import { createAppBridge } from './bridge.js';
import { createRealDesktop } from './composition/real.js';
import { DesktopLifecycle } from './lifecycle.js';
import { loadNativeClock } from './native-clock.js';
import { ModelAssets } from './model-assets.js';

type Runtime = Awaited<ReturnType<typeof createRealDesktop>>;
type Profile = { displayName: string; network: DesktopNetwork };
const emptyInfo = (profile: 'A' | 'B'): DesktopInfo => ({ mode: 'real', profile, memberId: '0'.repeat(32), publicKey: '0'.repeat(64), scenario: null, peers: [], clockProtection: 'closed', aiProvider: 'qvac' });

/** Host composition and private settings only; all domain mutations stay on AppPort. */
export class ProfileRuntime {
  readonly models: ModelAssets;
  readonly app = createAppBridge((name, input) => this.command(name, input), listener => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; });
  private readonly listeners = new Set<(event: CommittedEvent) => void>();
  private runtime: Runtime | undefined;
  private lifecycle: DesktopLifecycle | undefined;
  private configuration: Profile | undefined;
  private status: DesktopSetup['runtime'] = 'unconfigured';
  private error: ErrorCode | null = null;
  private starting: Promise<void> | undefined;
  private modelInspection: Promise<void> | undefined;
  private records: VerifiedBinding[] = [];
  private epoch = 0;
  private nativeEpoch: number | undefined;
  private closed = false;
  constructor(readonly directory: string, readonly profile: 'A' | 'B', readonly secretStore: SecretStore,
    private readonly version: string, private readonly invalidate: () => void, private readonly sourceCommit: string | null = null) {
    this.models = new ModelAssets(join(directory, 'models'));
  }
  get running(): boolean { return this.runtime !== undefined; }
  get info(): DesktopInfo { return this.runtime?.info ?? emptyInfo(this.profile); }
  get files(): Runtime['files'] | undefined { return this.runtime?.files; }
  get pairing(): Runtime['pairing'] | undefined { return this.runtime?.pairing; }
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const saved: unknown = JSON.parse(await readFile(join(this.directory, 'profile.json'), 'utf8'));
      this.configuration = DesktopCommands.saveProfile.parse(saved);
      this.status = 'stopped';
    } catch (error) {
      if (!isMissing(error)) { this.status = 'failed'; this.error = 'INVALID_INPUT'; }
    }
    this.modelInspection = this.models.inspect();
  }
  async getSetup(): Promise<DesktopSetup> {
    let clockProtection: DesktopSetup['clockProtection'] = 'closed';
    try { loadNativeClock()(); clockProtection = 'native'; } catch { /* Display the unmet qualification; no clock override. */ }
    const embedding = this.models.snapshot().find(model => model.kind === 'embedding');
    return { version: this.version, sourceCommit: this.sourceCommit, profile: this.profile,
      displayName: this.configuration?.displayName ?? null, runtime: this.status, network: this.configuration?.network ?? null,
      platform: process.platform, architecture: process.arch,
      localAddresses: [...new Set(Object.values(networkInterfaces()).flatMap(rows => rows ?? []).filter(row => row.family === 'IPv4').map(row => row.address))].slice(0, 16),
      clockProtection, secretProtection: await this.secretStore.protection(), models: this.models.snapshot(),
      freeDiskBytes: await this.models.freeDiskBytes().catch(() => null), error: this.error,
      embeddingProfile: embedding?.state === 'ready' ? { modelId: embedding.name, modelChecksum: embedding.sha256, dimension: 1024, normalization: 'unit', segmentationVersion: 'utf8-v1' } : null,
    };
  }
  async saveProfile(profile: Profile): Promise<void> {
    if (this.runtime || this.starting) throw new KuroError('ACCESS_DENIED');
    const checked = DesktopCommands.saveProfile.parse(profile);
    await this.save('profile.json', checked);
    this.configuration = checked; this.status = 'stopped'; this.error = null;
  }
  async start(): Promise<void> {
    if (this.closed) throw new KuroError('CANCELLED');
    if (this.runtime) return;
    if (this.starting) return this.starting;
    if (!this.configuration) throw new KuroError('INVALID_INPUT');
    const configuration = this.configuration;
    this.status = 'starting'; this.error = null;
    const starting = this.startRuntime(configuration);
    this.starting = starting;
    try { await starting; } finally { if (this.starting === starting) this.starting = undefined; }
  }
  private async startRuntime(configuration: Profile): Promise<void> {
    let runtime: Runtime | undefined;
    try {
      // Fail before starting peers if this host cannot preserve D25 across sleep.
      loadNativeClock()();
      await this.modelInspection;
      if (this.closed) throw new KuroError('CANCELLED');
      const { network } = configuration;
      runtime = await createRealDesktop(this.directory, this.profile, this.secretStore, {
        bootstrap: network.bootstrap, ...(network.localPort === null ? {} : { localPort: network.localPort }),
        ...(network.bootstrapPort === null ? {} : { bootstrapPort: network.bootstrapPort }),
      }, kind => this.models.path(kind));
      const records: VerifiedBinding[] = [];
      try {
        const saved: unknown = JSON.parse(await readFile(join(this.directory, 'verified-peers.json'), 'utf8'));
        if (!Array.isArray(saved) || saved.length > 128) throw new KuroError('INVALID_INPUT');
        for (const item of saved) records.push(VerifiedBindingSchema.parse(item));
      } catch (error) { if (!isMissing(error)) throw error; }
      this.runtime = runtime; this.records = records;
      this.lifecycle = new DesktopLifecycle([runtime.core], () => runtime!.ai.close(), runtime.clock, this.invalidate);
      for (const binding of records) this.activatePair(binding);
      runtime.app.subscribe(event => { for (const listener of this.listeners) listener(event); });
      this.epoch++; this.nativeEpoch = undefined; this.status = 'running';
    } catch (error) {
      if (runtime) await Promise.allSettled([runtime.core.stop(), runtime.ai.close()]);
      this.runtime = undefined; this.lifecycle = undefined;
      this.status = 'failed'; this.error = error instanceof KuroError ? error.code : 'PEER_OFFLINE';
      throw new KuroError(this.error);
    }
  }
  async stop(): Promise<void> {
    await this.starting?.catch(() => {});
    const lifecycle = this.lifecycle;
    this.epoch++; this.invalidate();
    try { await lifecycle?.close(); }
    finally { this.runtime = undefined; this.lifecycle = undefined; this.nativeEpoch = undefined; this.status = this.configuration ? 'stopped' : 'unconfigured'; }
  }
  async close(): Promise<void> { this.closed = true; await this.models.close(); await this.stop(); }
  checkpoint(): number {
    const epoch = this.lifecycle?.checkpoint();
    if (epoch !== this.nativeEpoch) { this.nativeEpoch = epoch; this.epoch++; }
    return this.epoch;
  }
  suspend(): void { this.lifecycle?.suspend(); }
  async resume(): Promise<void> { await this.lifecycle?.resume(); }
  lock(): void { this.lifecycle?.lock(); }
  async unlock(): Promise<void> { await this.lifecycle?.unlock(); }
  async tick(): Promise<void> { await this.lifecycle?.tick(); }
  async pairVerified(binding: VerifiedBinding, check: () => void): Promise<void> {
    if (!this.runtime) throw new KuroError('ACCESS_DENIED');
    if (this.records.length >= 128) throw new KuroError('CAPACITY_EXCEEDED');
    const key = binding.kind === 'authority' ? binding.authorityKey : binding.peerKey;
    if (!this.info.peers.some(peer => peer.publicKey === key) && this.info.peers.length >= 32) throw new KuroError('CAPACITY_EXCEEDED');
    const records = [...this.records, binding];
    await this.save('verified-peers.json', records, check, () => { this.records = records; this.activatePair(binding); });
  }
  private activatePair(binding: VerifiedBinding): void {
    if (!this.runtime) throw new KuroError('ACCESS_DENIED');
    const publicKey = binding.kind === 'authority' ? binding.authorityKey : binding.peerKey;
    this.runtime.transport.pair(publicKey);
    if (!this.runtime.info.peers.some(peer => peer.publicKey === publicKey)) this.runtime.info.peers.push({ publicKey, memberId: binding.kind === 'member' ? binding.memberId : null });
  }
  async invitation(spaceId: string): Promise<VerifiedBinding> {
    const administration = await this.app.getSpaceAdministration({ spaceId });
    if (!administration.ok) throw new KuroError(administration.error.code);
    if (administration.value.scope !== 'owner') throw new KuroError('ACCESS_DENIED');
    return { kind: 'authority', spaceId, authorityKey: this.info.publicKey, spaceAlias: randomBytes(16).toString('hex') };
  }
  async enrollment(spaceId: string): Promise<VerifiedBinding> {
    const state = await this.app.getState({});
    if (!state.ok) throw new KuroError(state.error.code);
    const space = state.value.spaces.find(item => item.spaceId === spaceId);
    const authority = this.records.find((binding): binding is Extract<VerifiedBinding, { kind: 'authority' }> => binding.kind === 'authority' && binding.spaceId === spaceId && binding.authorityKey === space?.authorityKey);
    if (!space || !authority) throw new KuroError('ACCESS_DENIED');
    return { kind: 'member', spaceId, memberId: this.info.memberId, peerKey: this.info.publicKey, spaceAlias: authority.spaceAlias };
  }
  async linkIdentity(memberId: string): Promise<void> {
    if (this.runtime || this.starting || await this.secretStore.read('kuro.local.member.v1')) throw new KuroError('ACCESS_DENIED');
    const stored = await this.secretStore.createIfAbsent('kuro.local.member.v1', Buffer.from(memberId, 'hex'));
    if (Buffer.from(stored).toString('hex') !== memberId) throw new KuroError('STALE_REVISION');
  }
  private async command<K extends AppCommandName>(name: K, input: AppInput<K>): Promise<Result<AppOutputs[K]>> {
    if (!this.runtime || !Object.hasOwn(AppCommands, name)) return failure('ACCESS_DENIED');
    const command = this.runtime.app[name] as (value: AppInput<K>) => Promise<Result<AppOutputs[K]>>;
    return command(input);
  }
  private async save(name: string, value: unknown, check: () => void = () => {}, published: () => void = () => {}): Promise<void> {
    const temporary = join(this.directory, `${randomBytes(16).toString('hex')}.pending`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
      check(); renameSync(temporary, join(this.directory, name)); published();
    } finally { await rm(temporary, { force: true }); }
  }
}
function isMissing(error: unknown): boolean { return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' ? true : false; }
