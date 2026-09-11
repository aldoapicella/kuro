import {
  CORE_LIMITS, KuroError, LIMITS, decodeWire, digestBytes, encodeWire, projectionDigest,
} from '@kuro/contracts';
import type {
  AppInput, Capability, Clock, IdSource, LocalSession, SessionPort, SpaceMember,
  SpaceStateRequest, SpaceStateResponse, SpaceView, VerifiedPairingPort,
} from '@kuro/contracts';
import { migrateAuthority } from './authority-schema.js';
import type { SqlValue, Store } from './store.js';

type SpaceRow = {
  space_id: string; authority_key: string; owner_member_id: string | null;
  local_authority_member_id: string; local_alias: string; is_owner: number;
  tombstoned: number;
  policy_revision: number; policy_epoch: number; corpus_revision: number; index_generation: number;
  sync_state: SpaceView['syncState']; last_sync_ms: number | null; wall_deadline_ms: number | null;
  monotonic_deadline_ms: number | null; cache_policy_revision: number | null;
  cache_publication_seq: number | null; cache_projection_digest: string | null;
  cache_response_digest: string | null; cache_request_id: string | null; cache_stale: number;
  next_refresh_wall_ms: number | null;
  sync_backoff_ms: number;
};
type MemberRow = { member_id: string; active: number; capabilities: string; valid_until_ms: number | null };
type BindingRow = { space_id: string; member_id: string; peer_key: string; space_alias: string; denial_only: number };
type LocalPolicyRow = { admitted: number; actions: string; valid_until_ms: number | null };
type IssuedRow = {
  peer_key: string; request_id: string; space_id: string; request_digest: string;
  policy_revision: number; projection_digest: string; issued_wall_ms: number; valid_for_ms: number;
  response_bytes: Uint8Array; response_digest: string; retain_until_ms: number;
};
type PendingRow = {
  space_id: string; authority_key: string; request_id: string; request_bytes: Uint8Array;
  original_wall_ms: number; original_monotonic_ms: number; next_attempt_monotonic_ms: number; attempt_count: number;
};

export interface AuthorityOptions {
  clock: Clock;
  ids: IdSource;
  sessions: SessionPort;
  pairing: VerifiedPairingPort;
  publicKey: string;
  invalidate(spaceId: string, reason?: 'policy' | 'stale' | 'expired' | 'denied' | 'corpus' | 'index'): void;
  remapNamespace?(oldSpaceId: string, newSpaceId: string): void;
}

export interface SyncSend { peerKey: string; bytes: Uint8Array; requestId: string }

const ACTIONS: readonly Capability[] = ['search', 'read', 'share', 'receive', 'manage'];
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

export class Authority {
  #clockEpochValid = false;
  #lifecycleEpoch = 0n;
  #monotonicHighwater: number | null = null;

  constructor(private readonly store: Store, private readonly options: AuthorityOptions) {
    migrateAuthority(store);
  }

  get clockEpochValid(): boolean { return this.#clockEpochValid; }

  startup(): void {
    this.#clockEpochValid = false;
    const { wall } = this.validClock();
    this.store.transaction(() => {
      const changed = this.store.all<{ space_id: string }>("SELECT space_id FROM authority_spaces WHERE is_owner=0 AND cache_stale=0 AND sync_state NOT IN ('DENIED','UNPAIRED')");
      this.store.run('DELETE FROM pending_space_sync');
      this.store.run("UPDATE authority_spaces SET cache_stale=1,sync_state=CASE WHEN sync_state IN ('DENIED','EXPIRED') THEN sync_state ELSE 'STALE' END,next_refresh_wall_ms=? WHERE is_owner=0", wall);
      for (const { space_id } of changed) this.options.invalidate(space_id, 'stale');
    });
  }

  suspend(): void { this.#clockEpochValid = false; this.#lifecycleEpoch++; }

  resume(trusted: boolean): void {
    this.#clockEpochValid = false;
    this.#lifecycleEpoch++;
    this.#monotonicHighwater = null;
    const { wall } = this.validClock();
    this.store.transaction(() => {
      const changed = this.store.all<{ space_id: string }>("SELECT space_id FROM authority_spaces WHERE is_owner=0 AND cache_stale=0 AND sync_state NOT IN ('DENIED','UNPAIRED')");
      this.store.run('DELETE FROM pending_space_sync');
      this.store.run("UPDATE authority_spaces SET cache_stale=1,sync_state=CASE WHEN sync_state IN ('DENIED','EXPIRED') THEN sync_state ELSE 'STALE' END,next_refresh_wall_ms=? WHERE is_owner=0", wall);
      for (const { space_id } of changed) this.options.invalidate(space_id, 'stale');
    });
    this.#clockEpochValid = trusted;
  }

  tick(): void {
    const { wall, mono } = this.validClock();
    this.store.transaction(() => {
      if (this.detectRollback(wall)) {
        this.#clockEpochValid = false;
        this.staleAllPositive();
        return;
      }
      for (const { space_id } of this.store.all<{ space_id: string }>('SELECT space_id FROM authority_spaces')) {
        this.applyDue(space_id, wall, mono);
      }
      for (const pending of this.store.all<PendingRow>('SELECT * FROM pending_space_sync WHERE ?-original_monotonic_ms>=?', mono, CORE_LIMITS.syncTimeoutMs)) {
        const failed = this.space(pending.space_id);
        this.store.run('DELETE FROM pending_space_sync WHERE space_id=?', pending.space_id);
        this.store.run(`UPDATE authority_spaces SET sync_state=CASE WHEN cache_stale=1 THEN CASE WHEN sync_state='DENIED' THEN 'DENIED' WHEN sync_state='EXPIRED' THEN 'EXPIRED' ELSE 'STALE' END ELSE 'OFFLINE_VALID' END,next_refresh_wall_ms=?,sync_backoff_ms=MIN(sync_backoff_ms*2,60000) WHERE space_id=?`, wall + failed.sync_backoff_ms, pending.space_id);
      }
      for (const row of this.store.all<SpaceRow>(`SELECT s.* FROM authority_spaces s WHERE s.is_owner=0 AND s.tombstoned=0 AND NOT EXISTS(SELECT 1 FROM pending_space_sync p WHERE p.space_id=s.space_id) AND (s.next_refresh_wall_ms IS NULL OR s.next_refresh_wall_ms<=?)`, wall)) this.queueSync(row, true);
      this.store.run('DELETE FROM issued_space_state WHERE retain_until_ms<=?', wall);
      this.recordWall(wall);
    });
  }

  getSpace(spaceId: string): SpaceView { return this.view(this.space(spaceId)); }
  listSpaces(): SpaceView[] { return this.store.all<SpaceRow>('SELECT * FROM authority_spaces ORDER BY space_id').map((row) => this.view(row)); }

  requireSession(): LocalSession {
    const { wall } = this.validClock();
    const session = this.options.sessions.current();
    if (!session || session.validUntilMs <= wall || session.deviceKey !== this.options.publicKey) throw new KuroError('ACCESS_DENIED');
    return session;
  }

  authorizeLocal(spaceId: string, action: Capability): string {
    if (this.space(spaceId).tombstoned) throw new KuroError('ACCESS_DENIED');
    this.requireClock();
    const session = this.requireSession();
    const clock = this.validClock();
    this.store.transaction(() => this.applyDue(spaceId, clock.wall, clock.mono));
    this.assertShared(spaceId, session.memberId, this.options.publicKey, action);
    this.assertLocalOverlay(spaceId, session.memberId, action);
    return session.memberId;
  }

  authorizePeer(spaceId: string, peerKey: string, action: Capability): string {
    if (this.space(spaceId).tombstoned) throw new KuroError('ACCESS_DENIED');
    this.requireClock();
    const session = this.requireSession();
    const clock = this.validClock();
    this.store.transaction(() => this.applyDue(spaceId, clock.wall, clock.mono));
    this.assertMemberActive(spaceId, session.memberId, this.options.publicKey);
    const peerMember = this.memberForKey(spaceId, peerKey);
    this.assertShared(spaceId, peerMember, peerKey, action);
    this.assertRelationship(spaceId, session.memberId, peerMember);
    this.assertLocalOverlay(spaceId, peerMember, action);
    return peerMember;
  }

  aliasForPeer(spaceId: string, peerKey: string): string {
    const row = this.store.get<{ space_alias: string }>('SELECT p.space_alias FROM local_peer_aliases p JOIN authority_spaces s ON s.space_id=p.space_id WHERE p.space_id=? AND p.peer_key=? AND s.tombstoned=0', spaceId, peerKey)
      ?? this.store.get<{ space_alias: string }>('SELECT b.space_alias FROM authority_bindings b JOIN authority_spaces s ON s.space_id=b.space_id WHERE b.space_id=? AND b.peer_key=? AND b.denial_only=0 AND s.tombstoned=0', spaceId, peerKey);
    if (!row) throw new KuroError('ACCESS_DENIED');
    return row.space_alias;
  }

  spaceForPeer(peerKey: string, alias: string): string {
    const row = this.store.get<{ space_id: string }>('SELECT p.space_id FROM local_peer_aliases p JOIN authority_spaces s ON s.space_id=p.space_id WHERE p.peer_key=? AND p.space_alias=? AND s.tombstoned=0', peerKey, alias)
      ?? this.store.get<{ space_id: string }>('SELECT b.space_id FROM authority_bindings b JOIN authority_spaces s ON s.space_id=b.space_id WHERE b.peer_key=? AND b.space_alias=? AND b.denial_only=0 AND s.tombstoned=0', peerKey, alias);
    if (!row) throw new KuroError('ACCESS_DENIED');
    return row.space_id;
  }

  assertDocument(spaceId: string, documentId: string, memberId: string, action: Capability): void {
    if (this.space(spaceId).tombstoned) throw new KuroError('ACCESS_DENIED');
    this.requireClock();
    const now = this.validClock().wall;
    const row = this.store.get('SELECT 1 AS ok FROM document_acl WHERE space_id=? AND document_id=? AND member_id=? AND action=? AND (valid_until_ms IS NULL OR valid_until_ms>?)', spaceId, documentId, memberId, action, now);
    if (!row) throw new KuroError('ACCESS_DENIED');
    this.assertLocalOverlay(spaceId, memberId, action);
    const session = this.requireSession();
    const key = memberId === session.memberId ? this.options.publicKey : this.keyForMember(spaceId, memberId);
    this.assertShared(spaceId, memberId, key, action);
    if (memberId !== session.memberId) {
      this.assertMemberActive(spaceId, session.memberId, this.options.publicKey);
      this.assertRelationship(spaceId, session.memberId, memberId);
    }
  }

  documentPredicate(spaceId: string, memberId: string, action: Capability, documentAlias = 'd'): { sql: string; params: SqlValue[] } {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(documentAlias)) throw new KuroError('INVALID_INPUT');
    if (this.space(spaceId).tombstoned) throw new KuroError('ACCESS_DENIED');
    this.requireClock();
    const space = this.space(spaceId);
    this.assertCacheUsable(space);
    const clock = this.validClock();
    const now = clock.wall;
    const cap = `\"${action}\"`;
    const mono = clock.mono;
    const shared = space.is_owner
      ? `EXISTS (SELECT 1 FROM authority_members am WHERE am.space_id=${documentAlias}.space_id AND am.member_id=? AND am.active=1 AND (am.valid_until_ms IS NULL OR am.valid_until_ms>?) AND instr(am.capabilities,?)>0)`
      : `EXISTS (SELECT 1 FROM cached_members cm JOIN authority_spaces asp ON asp.space_id=cm.space_id WHERE cm.space_id=${documentAlias}.space_id AND cm.member_id=? AND instr(cm.capabilities,?)>0 AND asp.cache_stale=0 AND asp.sync_state NOT IN ('DENIED','EXPIRED','STALE') AND asp.wall_deadline_ms>? AND asp.monotonic_deadline_ms>?)`;
    const sharedParams: SqlValue[] = space.is_owner ? [memberId, now, cap] : [memberId, cap, now, mono];
    return {
      sql: `${documentAlias}.space_id=? AND ${shared} AND EXISTS (SELECT 1 FROM local_policy lp WHERE lp.space_id=${documentAlias}.space_id AND lp.member_id=? AND lp.admitted=1 AND (lp.valid_until_ms IS NULL OR lp.valid_until_ms>?) AND instr(lp.actions,?)>0) AND EXISTS (SELECT 1 FROM document_acl da WHERE da.space_id=${documentAlias}.space_id AND da.document_id=${documentAlias}.document_id AND da.member_id=? AND da.action=? AND (da.valid_until_ms IS NULL OR da.valid_until_ms>?))`,
      params: [spaceId, ...sharedParams, memberId, now, cap, memberId, action, now],
    };
  }

  createSpace(input: AppInput<'createSpace'>): SpaceView {
    const session = this.requireSession();
    const spaceId = this.options.ids.nextId();
    const alias = this.options.ids.nextId();
    const wall = this.validClock().wall;
    return this.write(() => {
      if (this.store.get('SELECT 1 FROM authority_spaces WHERE space_id=?', spaceId)) throw new KuroError('INVALID_INPUT');
      this.assertSpaceCapacity();
      this.store.run(`INSERT INTO authority_spaces(space_id,authority_key,owner_member_id,local_authority_member_id,local_alias,is_owner,policy_revision,policy_epoch,corpus_revision,index_generation,sync_state,cache_stale,next_refresh_wall_ms,sync_backoff_ms)
        VALUES(?,?,?,?,?,1,1,1,0,0,?,0,NULL,1000)`, spaceId, this.options.publicKey, session.memberId, session.memberId, alias, this.#clockEpochValid ? 'CURRENT' : 'STALE');
      this.store.run('INSERT INTO authority_members VALUES(?,?,1,?,NULL)', spaceId, session.memberId, jsonCaps(input.capabilities));
      this.store.run('INSERT INTO authority_bindings VALUES(?,?,?,?,0)', spaceId, session.memberId, this.options.publicKey, alias);
      this.store.run('INSERT INTO local_policy VALUES(?,?,1,?,NULL)', spaceId, session.memberId, jsonCaps(input.localActions));
      this.recordWall(wall); this.emitSpace(spaceId, 1);
      return this.getSpace(spaceId);
    });
  }

  async pairSpace(input: AppInput<'pairSpace'>): Promise<SpaceView> {
    const session = this.requireSession();
    const lifecycleEpoch = this.#lifecycleEpoch;
    const binding = await this.options.pairing.consume(input.selectionId);
    this.assertLifecycleEpoch(lifecycleEpoch);
    if (binding.kind !== 'authority') throw new KuroError('INVALID_INPUT');
    const clock = this.validClock();
    return this.write(() => {
      if (this.store.get('SELECT 1 FROM authority_spaces WHERE space_id=?', binding.spaceId)) throw new KuroError('INVALID_INPUT');
      this.assertSpaceCapacity();
      this.store.run(`INSERT INTO authority_spaces(space_id,authority_key,owner_member_id,local_authority_member_id,local_alias,is_owner,policy_revision,policy_epoch,corpus_revision,index_generation,sync_state,cache_stale,next_refresh_wall_ms,sync_backoff_ms)
        VALUES(?,?,?,?,?,0,1,1,0,0,'STALE',1,?,1000)`, binding.spaceId, binding.authorityKey, null, session.memberId, binding.spaceAlias, clock.wall);
      this.store.run('INSERT INTO local_policy VALUES(?,?,1,?,NULL)', binding.spaceId, session.memberId, jsonCaps(input.localActions));
      this.recordWall(clock.wall); this.emitSpace(binding.spaceId, 1);
      return this.getSpace(binding.spaceId);
    });
  }

  async replaceAuthority(input: AppInput<'replaceAuthority'>): Promise<SpaceView> {
    const session = this.requireSession();
    const lifecycleEpoch = this.#lifecycleEpoch;
    const binding = await this.options.pairing.consume(input.selectionId);
    this.assertLifecycleEpoch(lifecycleEpoch);
    if (binding.kind !== 'authority') throw new KuroError('INVALID_INPUT');
    const clock = this.validClock();
    return this.write(() => {
      const old = this.space(input.oldSpaceId);
      if (old.tombstoned || old.local_authority_member_id !== session.memberId) throw new KuroError('ACCESS_DENIED');
      if (old.policy_epoch !== input.expectedRevision) throw new KuroError('STALE_REVISION');
      if (binding.spaceId === old.space_id || binding.authorityKey === old.authority_key || this.store.get('SELECT 1 FROM authority_spaces WHERE space_id=?', binding.spaceId)) throw new KuroError('INVALID_INPUT');
      this.assertSpaceCapacity();
      if (old.is_owner && (old.owner_member_id !== session.memberId || binding.authorityKey !== this.options.publicKey)) throw new KuroError('ACCESS_DENIED');
      if (!old.is_owner && binding.authorityKey === this.options.publicKey) throw new KuroError('INVALID_INPUT');
      const nextEpoch = checkedIncrement(old.policy_epoch);
      this.store.run("UPDATE authority_spaces SET tombstoned=1,sync_state='DENIED',cache_stale=1,policy_epoch=?,next_refresh_wall_ms=NULL WHERE space_id=?", nextEpoch, old.space_id);
      this.store.run('DELETE FROM pending_space_sync WHERE space_id=?', old.space_id);
      this.store.run(`INSERT INTO authority_spaces(space_id,authority_key,owner_member_id,local_authority_member_id,local_alias,is_owner,policy_revision,policy_epoch,corpus_revision,index_generation,sync_state,cache_stale,next_refresh_wall_ms,sync_backoff_ms)
        VALUES(?,?,?,?,?,?,?,?,0,0,?,?,?,1000)`, binding.spaceId, binding.authorityKey,
        old.is_owner ? session.memberId : null, session.memberId, binding.spaceAlias, old.is_owner, 1, nextEpoch,
        old.is_owner && this.#clockEpochValid ? 'CURRENT' : 'STALE', old.is_owner ? 0 : 1,
        old.is_owner ? null : clock.wall);
      this.store.run(`INSERT INTO local_policy(space_id,member_id,admitted,actions,valid_until_ms)
        SELECT ?,member_id,admitted,actions,valid_until_ms FROM local_policy WHERE space_id=?`, binding.spaceId, old.space_id);
      this.store.run(`INSERT INTO document_acl(space_id,document_id,member_id,action,valid_until_ms)
        SELECT ?,document_id,member_id,action,valid_until_ms FROM document_acl WHERE space_id=?`, binding.spaceId, old.space_id);
      this.store.run(`INSERT INTO local_policy(space_id,member_id,admitted,actions,valid_until_ms) VALUES(?,?,1,?,NULL)
        ON CONFLICT(space_id,member_id) DO UPDATE SET admitted=1,actions=excluded.actions,valid_until_ms=NULL`, binding.spaceId, session.memberId, jsonCaps(input.localActions));
      if (old.is_owner) {
        this.store.run('INSERT INTO authority_members VALUES(?,?,1,?,NULL)', binding.spaceId, session.memberId, jsonCaps(input.capabilities));
        this.store.run('INSERT INTO authority_bindings VALUES(?,?,?,?,0)', binding.spaceId, session.memberId, this.options.publicKey, binding.spaceAlias);
      }
      this.options.remapNamespace?.(old.space_id, binding.spaceId);
      this.options.invalidate(old.space_id, 'denied');
      this.options.invalidate(binding.spaceId, 'policy');
      this.recordWall(clock.wall);
      this.emitSpace(old.space_id, nextEpoch);
      this.emitSpace(binding.spaceId, nextEpoch);
      return this.getSpace(binding.spaceId);
    });
  }

  async enrollMember(input: AppInput<'enrollMember'>): Promise<SpaceView> {
    const lifecycleEpoch = this.#lifecycleEpoch;
    const binding = await this.options.pairing.consume(input.selectionId);
    this.assertLifecycleEpoch(lifecycleEpoch);
    if (binding.kind !== 'member' || binding.spaceId !== input.spaceId) throw new KuroError('INVALID_INPUT');
    this.validClock();
    return this.ownerMutation(input.spaceId, input.expectedRevision, () => {
      const existing = this.store.get<MemberRow>('SELECT member_id,active,capabilities,valid_until_ms FROM authority_members WHERE space_id=? AND member_id=?', input.spaceId, binding.memberId);
      this.store.run(`INSERT INTO authority_members(space_id,member_id,active,capabilities,valid_until_ms) VALUES(?,?,1,?,?)
        ON CONFLICT(space_id,member_id) DO UPDATE SET active=1,capabilities=excluded.capabilities,valid_until_ms=excluded.valid_until_ms`, input.spaceId, binding.memberId, jsonCaps(input.capabilities), input.validUntilMs);
      const keys = this.store.all<{ peer_key: string }>('SELECT peer_key FROM authority_bindings WHERE space_id=? AND member_id=?', input.spaceId, binding.memberId);
      if (!keys.some((row) => row.peer_key === binding.peerKey) && keys.length >= 4) throw new KuroError('CAPACITY_EXCEEDED');
      this.store.run(`INSERT INTO authority_bindings(space_id,member_id,peer_key,space_alias,denial_only) VALUES(?,?,?,?,0)
        ON CONFLICT(space_id,peer_key) DO UPDATE SET member_id=excluded.member_id,space_alias=excluded.space_alias,denial_only=0`, input.spaceId, binding.memberId, binding.peerKey, binding.spaceAlias);
      return !existing || existing.active !== 1 || existing.capabilities !== jsonCaps(input.capabilities) || existing.valid_until_ms !== input.validUntilMs || !keys.some((row) => row.peer_key === binding.peerKey);
    });
  }

  setMember(input: AppInput<'setMember'>): SpaceView {
    return this.ownerMutation(input.spaceId, input.expectedRevision, () => {
      const old = this.store.get<MemberRow>('SELECT member_id,active,capabilities,valid_until_ms FROM authority_members WHERE space_id=? AND member_id=?', input.spaceId, input.memberId);
      if (!old) throw new KuroError('INVALID_INPUT');
      const caps = jsonCaps(input.capabilities);
      const changed = old.active !== Number(input.active) || old.capabilities !== caps || old.valid_until_ms !== input.validUntilMs;
      if (changed) {
        this.store.run('UPDATE authority_members SET active=?,capabilities=?,valid_until_ms=? WHERE space_id=? AND member_id=?', Number(input.active), caps, input.validUntilMs, input.spaceId, input.memberId);
        this.store.run('UPDATE authority_bindings SET denial_only=? WHERE space_id=? AND member_id=?', Number(!input.active), input.spaceId, input.memberId);
      }
      return changed;
    });
  }

  setRelationship(input: AppInput<'setRelationship'>): SpaceView {
    if (input.memberId === input.otherMemberId) throw new KuroError('INVALID_INPUT');
    const [a, b] = [input.memberId, input.otherMemberId].sort() as [string, string];
    return this.ownerMutation(input.spaceId, input.expectedRevision, () => {
      if (!this.store.get('SELECT 1 FROM authority_members WHERE space_id=? AND member_id=?', input.spaceId, a) || !this.store.get('SELECT 1 FROM authority_members WHERE space_id=? AND member_id=?', input.spaceId, b)) throw new KuroError('INVALID_INPUT');
      const old = this.store.get<{ allowed: number; valid_until_ms: number | null }>('SELECT allowed,valid_until_ms FROM authority_relationships WHERE space_id=? AND member_a=? AND member_b=?', input.spaceId, a, b);
      const changed = !old || old.allowed !== Number(input.allowed) || old.valid_until_ms !== input.validUntilMs;
      if (changed) this.store.run(`INSERT INTO authority_relationships VALUES(?,?,?,?,?) ON CONFLICT(space_id,member_a,member_b) DO UPDATE SET allowed=excluded.allowed,valid_until_ms=excluded.valid_until_ms`, input.spaceId, a, b, Number(input.allowed), input.validUntilMs);
      return changed;
    });
  }

  async pairPeer(input: AppInput<'pairPeer'>): Promise<null> {
    const lifecycleEpoch = this.#lifecycleEpoch;
    const binding = await this.options.pairing.consume(input.selectionId);
    this.assertLifecycleEpoch(lifecycleEpoch);
    if (binding.kind !== 'peer') throw new KuroError('INVALID_INPUT');
    const { wall } = this.validClock();
    this.write(() => {
      const space = this.space(binding.spaceId);
      if (!this.tryMemberForKey(binding.spaceId, binding.peerKey)) throw new KuroError('ACCESS_DENIED');
      this.store.run(`INSERT INTO local_peer_aliases VALUES(?,?,?) ON CONFLICT(space_id,peer_key) DO UPDATE SET space_alias=excluded.space_alias`, binding.spaceId, binding.peerKey, binding.spaceAlias);
      this.recordWall(wall);
    });
    return null;
  }

  setLocalPolicy(input: AppInput<'setLocalPolicy'>): SpaceView {
    this.assertLocalAdministrator(input.spaceId);
    const { wall } = this.validClock();
    const space = this.space(input.spaceId);
    if (space.policy_epoch !== input.expectedRevision) throw new KuroError('STALE_REVISION');
    if (input.admitted) for (const action of input.actions) this.assertSharedCeiling(input.spaceId, input.memberId, action);
    return this.write(() => {
      const old = this.store.get<LocalPolicyRow>('SELECT admitted,actions,valid_until_ms FROM local_policy WHERE space_id=? AND member_id=?', input.spaceId, input.memberId);
      const actions = jsonCaps(input.actions);
      const changed = !old || old.admitted !== Number(input.admitted) || old.actions !== actions || old.valid_until_ms !== input.validUntilMs;
      if (changed) {
        this.store.run(`INSERT INTO local_policy VALUES(?,?,?,?,?) ON CONFLICT(space_id,member_id) DO UPDATE SET admitted=excluded.admitted,actions=excluded.actions,valid_until_ms=excluded.valid_until_ms`, input.spaceId, input.memberId, Number(input.admitted), actions, input.validUntilMs);
        this.bumpPolicyEpoch(input.spaceId, 'policy');
      }
      this.recordWall(wall);
      return this.getSpace(input.spaceId);
    });
  }

  setDocumentRules(input: AppInput<'setDocumentRules'>): { revision: number } {
    this.assertLocalAdministrator(input.spaceId);
    const { wall } = this.validClock();
    const grants = new Set<string>();
    for (const rule of input.rules) for (const action of rule.actions) {
      const grant = `${rule.memberId}:${action}`;
      if (grants.has(grant)) throw new KuroError('INVALID_INPUT');
      grants.add(grant);
      this.assertSharedCeiling(input.spaceId, rule.memberId, action);
      this.assertLocalOverlay(input.spaceId, rule.memberId, action);
    }
    return this.write(() => {
      const before = this.store.all<{ member_id: string; action: string; valid_until_ms: number | null }>('SELECT member_id,action,valid_until_ms FROM document_acl WHERE space_id=? AND document_id=? ORDER BY member_id,action', input.spaceId, input.documentId);
      const after = input.rules.flatMap((rule) => rule.actions.map((action) => ({ member_id: rule.memberId, action, valid_until_ms: rule.validUntilMs }))).sort((a, b) => `${a.member_id}:${a.action}`.localeCompare(`${b.member_id}:${b.action}`));
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        this.store.run('DELETE FROM document_acl WHERE space_id=? AND document_id=?', input.spaceId, input.documentId);
        for (const row of after) this.store.run('INSERT INTO document_acl VALUES(?,?,?,?,?)', input.spaceId, input.documentId, row.member_id, row.action, row.valid_until_ms);
        this.bumpPolicyEpoch(input.spaceId, 'policy');
      }
      this.recordWall(wall);
      return { revision: checkedIncrement(input.expectedRevision) };
    });
  }

  bumpCorpus(spaceId: string): SpaceView {
    this.authorizeLocal(spaceId, 'manage');
    const { wall } = this.validClock();
    return this.write(() => {
      const row = this.space(spaceId);
      const next = checkedIncrement(row.corpus_revision);
      this.store.run('UPDATE authority_spaces SET corpus_revision=?,index_generation=0 WHERE space_id=?', next, spaceId);
      this.bumpPolicyEpoch(spaceId, 'corpus');
      this.recordWall(wall);
      return this.getSpace(spaceId);
    });
  }

  activateIndex(spaceId: string, generation: number): void {
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new KuroError('INVALID_INPUT');
    this.authorizeLocal(spaceId, 'manage');
    const { wall } = this.validClock();
    this.write(() => {
      this.store.run('UPDATE authority_spaces SET index_generation=? WHERE space_id=?', generation, spaceId);
      this.options.invalidate(spaceId, 'index');
      this.recordWall(wall);
      this.emitSpace(spaceId, this.space(spaceId).policy_epoch);
    });
  }

  beginSync(spaceId: string): SyncSend {
    const clock = this.validClock();
    const space = this.space(spaceId);
    if (space.is_owner || space.tombstoned) throw new KuroError('INVALID_INPUT');
    const existing = this.store.get<PendingRow>('SELECT * FROM pending_space_sync WHERE space_id=?', spaceId);
    const nowMono = clock.mono;
    if (existing && nowMono - existing.original_monotonic_ms < CORE_LIMITS.syncTimeoutMs) return { peerKey: existing.authority_key, bytes: existing.request_bytes, requestId: existing.request_id };
    return this.write(() => {
      this.store.run('DELETE FROM pending_space_sync WHERE space_id=?', spaceId);
      return this.queueSync(space, false);
    });
  }

  pendingSyncSends(): SyncSend[] {
    const now = this.validClock().mono;
    return this.write(() => {
      const result: SyncSend[] = [];
      for (const row of this.store.all<PendingRow>('SELECT * FROM pending_space_sync WHERE next_attempt_monotonic_ms<=? AND ?-original_monotonic_ms<? ORDER BY original_monotonic_ms', now, now, CORE_LIMITS.syncTimeoutMs)) {
        result.push({ peerKey: row.authority_key, bytes: row.request_bytes, requestId: row.request_id });
        const attempt = row.attempt_count + 1;
        const delay = Math.min(1000 * (2 ** Math.min(attempt, 5)), 60000);
        this.store.run('UPDATE pending_space_sync SET attempt_count=?,next_attempt_monotonic_ms=? WHERE space_id=?', attempt, now + delay, row.space_id);
      }
      return result;
    });
  }

  handleRequest(peerKey: string, request: SpaceStateRequest): Uint8Array {
    let requestBytes: Uint8Array;
    try { requestBytes = encodeWire(request); } catch { throw new KuroError('INVALID_MESSAGE'); }
    const requestDigest = digestBytes(requestBytes);
    const prior = this.store.get<IssuedRow>('SELECT * FROM issued_space_state WHERE peer_key=? AND request_id=?', peerKey, request.requestId);
    if (prior) {
      if (prior.request_digest !== requestDigest) throw new KuroError('INVALID_MESSAGE');
      return this.revalidatePublication(peerKey, request.requestId);
    }
    const binding = this.store.get<BindingRow>(`SELECT b.* FROM authority_bindings b JOIN authority_spaces s ON s.space_id=b.space_id
      WHERE b.peer_key=? AND b.space_alias=? AND s.is_owner=1 AND s.tombstoned=0 AND s.authority_key=?`, peerKey, request.spaceAlias, this.options.publicKey);
    if (!binding) return closed(request);
    return this.write(() => {
      if (!this.#clockEpochValid) return closed(request);
      let clock: { wall: number; mono: number };
      try { clock = this.validClock(); } catch (error) { if (error instanceof KuroError && error.code === 'CLOCK_UNCERTAIN') return closed(request); throw error; }
      const { wall, mono } = clock;
      this.applyDue(binding.space_id, wall, mono);
      const counter = this.store.get<{ publication_seq: number; last_issued_ms: number | null }>('SELECT publication_seq,last_issued_ms FROM publication_counters WHERE space_id=? AND authority_key=? AND recipient_key=?', binding.space_id, this.options.publicKey, peerKey);
      if (counter?.last_issued_ms != null && wall - counter.last_issued_ms < CORE_LIMITS.issuanceIntervalMs) return closed(request);
      const seq = checkedIncrement(counter?.publication_seq ?? 0);
      const space = this.space(binding.space_id);
      const projection = this.buildProjection(binding, wall);
      const body: Omit<SpaceStateResponse, 'projectionDigest'> = {
        v: 1, type: 'SPACE_STATE_RESPONSE', requestId: request.requestId, spaceAlias: request.spaceAlias,
        spaceId: binding.space_id, authorityKey: this.options.publicKey, recipientKey: peerKey,
        policyRevision: space.policy_revision, publicationSeq: seq,
        projectionScope: 'recipient-authorized-peers-v1', status: projection.status,
        validForMs: projection.validForMs, members: projection.members,
      };
      const response: SpaceStateResponse = { ...body, projectionDigest: projectionDigest(body) };
      const bytes = encodeWire(response);
      const responseDigest = digestBytes(bytes);
      this.store.run(`INSERT INTO publication_counters VALUES(?,?,?,?,?) ON CONFLICT(space_id,authority_key,recipient_key) DO UPDATE SET publication_seq=excluded.publication_seq,last_issued_ms=excluded.last_issued_ms`, binding.space_id, this.options.publicKey, peerKey, seq, wall);
      this.store.run('INSERT INTO issued_space_state VALUES(?,?,?,?,?,?,?,?,?,?,?)', peerKey, request.requestId, binding.space_id, requestDigest, space.policy_revision, response.projectionDigest, wall, response.validForMs, bytes, responseDigest, wall + CORE_LIMITS.syncDedupRetentionMs);
      this.recordWall(wall);
      return bytes;
    });
  }

  revalidatePublication(peerKey: string, requestId: string): Uint8Array {
    const row = this.store.get<IssuedRow>('SELECT * FROM issued_space_state WHERE peer_key=? AND request_id=?', peerKey, requestId);
    if (!row) throw new KuroError('INVALID_MESSAGE');
    return this.write(() => {
      let decoded;
      try { decoded = decodeWire(row.response_bytes); } catch { throw new KuroError('STORAGE_FAILURE'); }
      if (decoded.type !== 'SPACE_STATE_RESPONSE') throw new KuroError('INVALID_MESSAGE');
      if (!this.#clockEpochValid) return closed(decoded);
      let clock: { wall: number; mono: number };
      try { clock = this.validClock(); } catch (error) { if (error instanceof KuroError && error.code === 'CLOCK_UNCERTAIN') return closed(decoded); throw error; }
      const { wall: now, mono } = clock;
      this.applyDue(row.space_id, now, mono);
      const space = this.space(row.space_id);
      if (space.tombstoned) return closed(decoded);
      const binding = this.store.get<BindingRow>('SELECT * FROM authority_bindings WHERE space_id=? AND peer_key=? AND space_alias=?', row.space_id, peerKey, decoded.spaceAlias);
      if (!binding || space.policy_revision !== row.policy_revision || (decoded.status === 'ACTIVE' && now - row.issued_wall_ms >= row.valid_for_ms) || digestBytes(row.response_bytes) !== row.response_digest) return closed(decoded);
      return row.response_bytes;
    });
  }

  handleResponse(peerKey: string, response: SpaceStateResponse, exactBytes: Uint8Array): void {
    let decoded;
    try { decoded = decodeWire(exactBytes); } catch { throw new KuroError('INVALID_MESSAGE'); }
    let responseDigest: string;
    try { responseDigest = digestBytes(encodeWire(response)); } catch { throw new KuroError('INVALID_MESSAGE'); }
    if (decoded.type !== 'SPACE_STATE_RESPONSE' || digestBytes(encodeWire(decoded)) !== responseDigest) throw new KuroError('INVALID_MESSAGE');
    const pending = this.store.get<PendingRow>('SELECT * FROM pending_space_sync WHERE request_id=?', response.requestId);
    if (!pending) {
      const duplicate = this.store.get<SpaceRow>('SELECT * FROM authority_spaces WHERE cache_request_id=? AND cache_response_digest=?', response.requestId, digestBytes(exactBytes));
      if (duplicate) return;
      throw new KuroError('INVALID_MESSAGE');
    }
    const space = this.space(pending.space_id);
    if (space.tombstoned) throw new KuroError('ACCESS_DENIED');
    if (peerKey !== pending.authority_key || peerKey !== space.authority_key || response.authorityKey !== peerKey || response.recipientKey !== this.options.publicKey || response.spaceId !== space.space_id || response.spaceAlias !== space.local_alias) throw new KuroError('INVALID_MESSAGE');
    const { wall: nowWall, mono: nowMono } = this.validClock();
    if (response.status === 'ACTIVE' && !this.#clockEpochValid) throw new KuroError('CLOCK_UNCERTAIN');
    if (nowMono - pending.original_monotonic_ms >= CORE_LIMITS.syncTimeoutMs || nowWall < pending.original_wall_ms || nowMono < pending.original_monotonic_ms) throw new KuroError('EXPIRED');
    if (response.status === 'ACTIVE' && (nowWall >= pending.original_wall_ms + response.validForMs || nowMono >= pending.original_monotonic_ms + response.validForMs)) throw new KuroError('EXPIRED');
    const digest = digestBytes(exactBytes);
    this.write(() => {
      this.applyDue(space.space_id, nowWall, nowMono);
      const current = this.space(space.space_id);
      const oldSeq = current.cache_publication_seq ?? 0;
      const oldPolicy = current.cache_policy_revision ?? 0;
      if (response.publicationSeq < oldSeq || response.policyRevision < oldPolicy) throw new KuroError('INVALID_MESSAGE');
      if (response.publicationSeq === oldSeq && current.cache_response_digest !== digest) throw new KuroError('INVALID_MESSAGE');
      if (response.policyRevision === oldPolicy && current.cache_projection_digest && current.cache_projection_digest !== response.projectionDigest) throw new KuroError('INVALID_MESSAGE');
      if (response.publicationSeq === oldSeq && current.cache_response_digest === digest) { this.store.run('DELETE FROM pending_space_sync WHERE space_id=?', space.space_id); return; }
      const changed = response.policyRevision !== oldPolicy || current.cache_projection_digest !== response.projectionDigest || (current.sync_state === 'DENIED') !== (response.status === 'DENIED');
      this.store.run('DELETE FROM cached_members WHERE space_id=?', space.space_id);
      if (response.status === 'ACTIVE') for (const member of response.members) {
        this.store.run('INSERT INTO cached_members VALUES(?,?,?)', space.space_id, member.memberId, jsonCaps(member.capabilities));
        for (const key of member.deviceKeys) this.store.run('INSERT INTO cached_member_keys VALUES(?,?,?)', space.space_id, member.memberId, key);
      }
      this.store.run(`UPDATE authority_spaces SET sync_state=?,last_sync_ms=?,wall_deadline_ms=?,monotonic_deadline_ms=?,cache_policy_revision=?,cache_publication_seq=?,cache_projection_digest=?,cache_response_digest=?,cache_request_id=?,cache_stale=0,policy_revision=?,next_refresh_wall_ms=?,sync_backoff_ms=1000 WHERE space_id=?`,
        response.status === 'DENIED' ? 'DENIED' : 'CURRENT', nowWall,
        response.status === 'DENIED' ? null : pending.original_wall_ms + response.validForMs,
        response.status === 'DENIED' ? null : pending.original_monotonic_ms + response.validForMs,
        response.policyRevision, response.publicationSeq, response.projectionDigest, digest, response.requestId, response.policyRevision,
        nowWall + CORE_LIMITS.refreshIntervalMs + Math.floor(Math.max(0, Math.min(0.999999, this.options.ids.randomUnit())) * (CORE_LIMITS.refreshJitterMs + 1)), space.space_id);
      this.store.run('DELETE FROM pending_space_sync WHERE space_id=?', space.space_id);
      if (changed) this.bumpPolicyEpoch(space.space_id, response.status === 'DENIED' ? 'denied' : 'policy');
      this.recordWall(nowWall);
      if (!changed) this.emitSpace(space.space_id, this.space(space.space_id).policy_epoch);
    });
  }

  private ownerMutation(spaceId: string, expectedRevision: number, mutate: () => boolean): SpaceView {
    this.assertOwner(spaceId);
    const { wall } = this.validClock();
    return this.write(() => {
      const space = this.space(spaceId);
      if (space.policy_revision !== expectedRevision) throw new KuroError('STALE_REVISION');
      if (mutate()) {
        const next = checkedIncrement(space.policy_revision);
        this.store.run('UPDATE authority_spaces SET policy_revision=?,policy_epoch=? WHERE space_id=?', next, checkedIncrement(space.policy_epoch), spaceId);
        this.options.invalidate(spaceId, 'policy');
        this.emitSpace(spaceId, next);
      }
      this.recordWall(wall);
      return this.getSpace(spaceId);
    });
  }

  private assertOwner(spaceId: string): void {
    const session = this.requireSession();
    const space = this.space(spaceId);
    if (space.tombstoned || !space.is_owner || space.authority_key !== this.options.publicKey || space.owner_member_id !== session.memberId) throw new KuroError('ACCESS_DENIED');
  }

  private assertLocalAdministrator(spaceId: string): void {
    const session = this.requireSession();
    const space = this.space(spaceId);
    if (space.local_authority_member_id !== session.memberId) throw new KuroError('ACCESS_DENIED');
    this.authorizeLocal(spaceId, 'manage');
  }

  private assertSharedCeiling(spaceId: string, memberId: string, action: Capability): void {
    const key = memberId === this.requireSession().memberId ? this.options.publicKey : this.keyForMember(spaceId, memberId);
    this.assertShared(spaceId, memberId, key, action);
  }

  private assertShared(spaceId: string, memberId: string, key: string, action: Capability): void {
    const space = this.space(spaceId);
    this.assertCacheUsable(space);
    const now = this.validClock().wall;
    if (space.is_owner) {
      const row = this.store.get<MemberRow>(`SELECT member_id,active,capabilities,valid_until_ms FROM authority_members am
        WHERE space_id=? AND member_id=? AND active=1 AND (valid_until_ms IS NULL OR valid_until_ms>?)
        AND EXISTS(SELECT 1 FROM authority_bindings ab WHERE ab.space_id=am.space_id AND ab.member_id=am.member_id AND ab.peer_key=? AND ab.denial_only=0)`, spaceId, memberId, now, key);
      if (!row || !parseCaps(row.capabilities).includes(action)) throw new KuroError('ACCESS_DENIED');
    } else {
      const row = this.store.get<{ capabilities: string }>(`SELECT cm.capabilities FROM cached_members cm JOIN cached_member_keys ck ON ck.space_id=cm.space_id AND ck.member_id=cm.member_id WHERE cm.space_id=? AND cm.member_id=? AND ck.peer_key=?`, spaceId, memberId, key);
      if (!row || !parseCaps(row.capabilities).includes(action)) throw new KuroError('ACCESS_DENIED');
    }
  }

  private assertMemberActive(spaceId: string, memberId: string, key: string): void {
    const space = this.space(spaceId);
    this.assertCacheUsable(space);
    const { wall } = this.validClock();
    const row = space.is_owner
      ? this.store.get(`SELECT 1 AS ok FROM authority_members am WHERE am.space_id=? AND am.member_id=? AND am.active=1 AND (am.valid_until_ms IS NULL OR am.valid_until_ms>?) AND EXISTS(SELECT 1 FROM authority_bindings ab WHERE ab.space_id=am.space_id AND ab.member_id=am.member_id AND ab.peer_key=? AND ab.denial_only=0)`, spaceId, memberId, wall, key)
      : this.store.get(`SELECT 1 AS ok FROM cached_members cm JOIN cached_member_keys ck ON ck.space_id=cm.space_id AND ck.member_id=cm.member_id WHERE cm.space_id=? AND cm.member_id=? AND ck.peer_key=?`, spaceId, memberId, key);
    if (!row) throw new KuroError('ACCESS_DENIED');
  }

  private assertLocalOverlay(spaceId: string, memberId: string, action: Capability): void {
    const row = this.store.get<LocalPolicyRow>('SELECT admitted,actions,valid_until_ms FROM local_policy WHERE space_id=? AND member_id=?', spaceId, memberId);
    if (!row || !row.admitted || (row.valid_until_ms != null && row.valid_until_ms <= this.validClock().wall) || !parseCaps(row.actions).includes(action)) throw new KuroError('ACCESS_DENIED');
  }

  private assertRelationship(spaceId: string, localMember: string, peerMember: string): void {
    const space = this.space(spaceId);
    if (!space.is_owner) return; // Complete recipient projection proves the authority-approved neighborhood.
    const [a, b] = [localMember, peerMember].sort() as [string, string];
    if (!this.store.get('SELECT 1 FROM authority_relationships WHERE space_id=? AND member_a=? AND member_b=? AND allowed=1 AND (valid_until_ms IS NULL OR valid_until_ms>?)', spaceId, a, b, this.validClock().wall)) throw new KuroError('ACCESS_DENIED');
  }

  private assertCacheUsable(space: SpaceRow): void {
    if (!this.#clockEpochValid) throw new KuroError('CLOCK_UNCERTAIN');
    const clock = this.validClock();
    if (space.tombstoned) throw new KuroError('ACCESS_DENIED');
    if (space.is_owner) return;
    if (space.sync_state === 'DENIED') throw new KuroError('ACCESS_DENIED');
    if (space.cache_stale || space.wall_deadline_ms == null || space.monotonic_deadline_ms == null) throw new KuroError('EXPIRED');
    if (clock.wall >= space.wall_deadline_ms || clock.mono >= space.monotonic_deadline_ms) throw new KuroError('EXPIRED');
  }

  private requireClock(): void {
    if (!this.#clockEpochValid) throw new KuroError('CLOCK_UNCERTAIN');
    this.validClock();
  }

  private applyDue(spaceId: string, wall: number, mono: number): void {
    const space = this.space(spaceId);
    if (space.tombstoned) return;
    if (space.is_owner) {
      const members = this.store.run('UPDATE authority_members SET active=0 WHERE space_id=? AND active=1 AND valid_until_ms IS NOT NULL AND valid_until_ms<=?', spaceId, wall).changes;
      if (members) this.store.run('UPDATE authority_bindings SET denial_only=1 WHERE space_id=? AND member_id IN (SELECT member_id FROM authority_members WHERE space_id=? AND active=0)', spaceId, spaceId);
      const relations = this.store.run('UPDATE authority_relationships SET allowed=0 WHERE space_id=? AND allowed=1 AND valid_until_ms IS NOT NULL AND valid_until_ms<=?', spaceId, wall).changes;
      if (members || relations) {
        const next = checkedIncrement(space.policy_revision);
        this.store.run('UPDATE authority_spaces SET policy_revision=?,policy_epoch=? WHERE space_id=?', next, checkedIncrement(space.policy_epoch), spaceId);
        this.options.invalidate(spaceId, 'expired'); this.emitSpace(spaceId, next);
      }
    }
    const localExpired = this.store.run('UPDATE local_policy SET admitted=0 WHERE space_id=? AND admitted=1 AND valid_until_ms IS NOT NULL AND valid_until_ms<=?', spaceId, wall).changes;
    const documentExpired = this.store.run('DELETE FROM document_acl WHERE space_id=? AND valid_until_ms IS NOT NULL AND valid_until_ms<=?', spaceId, wall).changes;
    if (localExpired || documentExpired) this.bumpPolicyEpoch(spaceId, 'expired');
    const fresh = this.space(spaceId);
    const leaseExpired = fresh.wall_deadline_ms != null && (
      wall >= fresh.wall_deadline_ms || (!fresh.cache_stale && fresh.monotonic_deadline_ms != null && mono >= fresh.monotonic_deadline_ms)
    );
    if (!fresh.is_owner && !['DENIED','EXPIRED'].includes(fresh.sync_state) && leaseExpired) {
      this.store.run("UPDATE authority_spaces SET sync_state='EXPIRED',cache_stale=1 WHERE space_id=?", spaceId);
      this.bumpPolicyEpoch(spaceId, 'expired');
    }
    this.recordWall(wall);
  }

  private staleAllPositive(): void {
    const rows = this.store.all<{ space_id: string }>("SELECT space_id FROM authority_spaces WHERE tombstoned=0 AND (is_owner=1 OR (is_owner=0 AND cache_stale=0 AND sync_state!='DENIED'))");
    this.store.run('DELETE FROM pending_space_sync');
    this.store.run("UPDATE authority_spaces SET cache_stale=1,sync_state=CASE WHEN sync_state IN ('DENIED','EXPIRED') THEN sync_state ELSE 'STALE' END,next_refresh_wall_ms=NULL WHERE is_owner=0 AND tombstoned=0");
    for (const row of rows) this.options.invalidate(row.space_id, 'stale');
  }

  private bumpPolicyEpoch(spaceId: string, reason: 'policy' | 'stale' | 'expired' | 'denied' | 'corpus' | 'index'): void {
    const row = this.space(spaceId);
    const next = checkedIncrement(row.policy_epoch);
    this.store.run('UPDATE authority_spaces SET policy_epoch=? WHERE space_id=?', next, spaceId);
    this.options.invalidate(spaceId, reason);
    this.emitSpace(spaceId, next);
  }

  private buildProjection(binding: BindingRow, wall: number): { status: 'ACTIVE' | 'DENIED'; validForMs: number; members: SpaceMember[] } {
    const recipient = this.store.get<MemberRow>('SELECT member_id,active,capabilities,valid_until_ms FROM authority_members WHERE space_id=? AND member_id=?', binding.space_id, binding.member_id);
    if (binding.denial_only || !recipient?.active || (recipient.valid_until_ms != null && recipient.valid_until_ms <= wall)) return { status: 'DENIED', validForMs: 0, members: [] };
    const ids = new Set<string>([binding.member_id]);
    const relationships = this.store.all<{ member_a: string; member_b: string; valid_until_ms: number | null }>('SELECT member_a,member_b,valid_until_ms FROM authority_relationships WHERE space_id=? AND allowed=1 AND (valid_until_ms IS NULL OR valid_until_ms>?) AND (member_a=? OR member_b=?)', binding.space_id, wall, binding.member_id, binding.member_id);
    for (const rel of relationships) ids.add(rel.member_a === binding.member_id ? rel.member_b : rel.member_a);
    let validFor: number = LIMITS.maxLeaseMs;
    const members: SpaceMember[] = [];
    for (const memberId of [...ids].sort()) {
      const member = this.store.get<MemberRow>('SELECT member_id,active,capabilities,valid_until_ms FROM authority_members WHERE space_id=? AND member_id=? AND active=1 AND (valid_until_ms IS NULL OR valid_until_ms>?)', binding.space_id, memberId, wall);
      if (!member) continue;
      const keys = this.store.all<{ peer_key: string }>('SELECT peer_key FROM authority_bindings WHERE space_id=? AND member_id=? AND denial_only=0 ORDER BY peer_key', binding.space_id, memberId).map((row) => row.peer_key);
      if (!keys.length || keys.length > 4) throw new KuroError('CAPACITY_EXCEEDED');
      if (member.valid_until_ms != null) validFor = Math.min(validFor, member.valid_until_ms - wall);
      members.push({ memberId, deviceKeys: keys, capabilities: parseCaps(member.capabilities) });
      if (members.length > 16) throw new KuroError('CAPACITY_EXCEEDED');
    }
    for (const rel of relationships) if (rel.valid_until_ms != null) validFor = Math.min(validFor, rel.valid_until_ms - wall);
    if (!members.some((member) => member.deviceKeys.includes(binding.peer_key)) || validFor <= 0) return { status: 'DENIED', validForMs: 0, members: [] };
    return { status: 'ACTIVE', validForMs: Math.min(LIMITS.maxLeaseMs, validFor), members };
  }

  private memberForKey(spaceId: string, key: string): string {
    const member = this.tryMemberForKey(spaceId, key);
    if (!member) throw new KuroError('ACCESS_DENIED');
    return member;
  }

  private tryMemberForKey(spaceId: string, key: string): string | null {
    const space = this.space(spaceId);
    if (space.tombstoned) return null;
    const row = space.is_owner
      ? this.store.get<{ member_id: string }>('SELECT member_id FROM authority_bindings WHERE space_id=? AND peer_key=? AND denial_only=0', spaceId, key)
      : this.store.get<{ member_id: string }>('SELECT member_id FROM cached_member_keys WHERE space_id=? AND peer_key=?', spaceId, key);
    return row?.member_id ?? null;
  }

  private keyForMember(spaceId: string, memberId: string): string {
    const space = this.space(spaceId);
    const row = space.is_owner
      ? this.store.get<{ peer_key: string }>('SELECT peer_key FROM authority_bindings WHERE space_id=? AND member_id=? AND denial_only=0 ORDER BY peer_key LIMIT 1', spaceId, memberId)
      : this.store.get<{ peer_key: string }>('SELECT peer_key FROM cached_member_keys WHERE space_id=? AND member_id=? ORDER BY peer_key LIMIT 1', spaceId, memberId);
    if (!row) throw new KuroError('ACCESS_DENIED');
    return row.peer_key;
  }

  private queueSync(space: SpaceRow, retryImmediately: boolean): SyncSend {
    const requestId = this.options.ids.nextId();
    const request: SpaceStateRequest = { v: 1, type: 'SPACE_STATE_REQUEST', requestId, spaceAlias: space.local_alias };
    let bytes: Uint8Array;
    try { bytes = encodeWire(request); } catch { throw new KuroError('IDENTITY_UNAVAILABLE'); }
    const { wall, mono } = this.validClock();
    this.store.run('INSERT INTO pending_space_sync VALUES(?,?,?,?,?,?,?,0)', space.space_id, space.authority_key, requestId, bytes, wall, mono, retryImmediately ? mono : mono + 1000);
    this.store.run("UPDATE authority_spaces SET sync_state=CASE WHEN sync_state IN ('DENIED','EXPIRED') THEN sync_state ELSE 'SYNCING' END,next_refresh_wall_ms=NULL WHERE space_id=?", space.space_id);
    this.recordWall(wall); this.emitSpace(space.space_id, space.policy_epoch);
    return { peerKey: space.authority_key, bytes, requestId };
  }

  private view(row: SpaceRow): SpaceView {
    let clock: { wall: number; mono: number } | null = null;
    try { clock = this.validClock(); } catch (error) { if (!(error instanceof KuroError) || error.code !== 'CLOCK_UNCERTAIN') throw error; }
    let syncState = row.sync_state;
    let remaining = 0;
    if (row.tombstoned) syncState = 'DENIED';
    else if ((!this.#clockEpochValid || !clock) && syncState !== 'DENIED') syncState = 'STALE';
    else if (row.is_owner) syncState = row.authority_key === this.options.publicKey ? 'CURRENT' : 'STALE';
    else if (syncState !== 'DENIED' && syncState !== 'EXPIRED' && row.cache_stale) syncState = 'STALE';
    else if (clock && row.wall_deadline_ms != null && row.monotonic_deadline_ms != null) {
      remaining = Math.max(0, Math.min(row.wall_deadline_ms - clock.wall, row.monotonic_deadline_ms - clock.mono));
      if (!remaining) syncState = 'EXPIRED';
      else if (syncState !== 'SYNCING' && row.last_sync_ms != null && clock.wall - row.last_sync_ms > CORE_LIMITS.refreshIntervalMs) syncState = 'OFFLINE_VALID';
    }
    return {
      spaceId: row.space_id, authorityKey: row.authority_key, isOwner: Boolean(row.is_owner),
      policyRevision: row.policy_revision, policyEpoch: row.policy_epoch, corpusRevision: row.corpus_revision,
      indexGeneration: row.index_generation, syncState, lastSyncMs: row.last_sync_ms,
      remainingValidityMs: Math.floor(remaining),
    };
  }

  private space(spaceId: string): SpaceRow {
    const row = this.store.get<SpaceRow>('SELECT * FROM authority_spaces WHERE space_id=?', spaceId);
    if (!row) throw new KuroError('INVALID_INPUT');
    return row;
  }

  private detectRollback(now: number): boolean {
    const row = this.store.get<{ wall_highwater_ms: number }>('SELECT wall_highwater_ms FROM authority_meta WHERE singleton=1');
    return Boolean(row && now < row.wall_highwater_ms);
  }
  private assertSpaceCapacity(): void {
    const count = this.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM authority_spaces')?.count ?? 0;
    if (count >= CORE_LIMITS.maxSpaces) throw new KuroError('CAPACITY_EXCEEDED');
  }
  checkClock(): void { this.validClock(); }
  private assertLifecycleEpoch(epoch: bigint): void {
    this.validClock();
    if (epoch !== this.#lifecycleEpoch) throw new KuroError('CANCELLED');
  }
  private validClock(): { wall: number; mono: number } {
    let wall: number, mono: number;
    try { wall = this.options.clock.wallNowMs(); mono = this.options.clock.monotonicNowMs(); }
    catch {
      this.markClockUncertain();
      throw new KuroError('CLOCK_UNCERTAIN');
    }
    if (!validTime(wall) || !validTime(mono) || (this.#monotonicHighwater != null && mono < this.#monotonicHighwater) || (validTime(wall) && this.detectRollback(wall))) {
      this.markClockUncertain();
      throw new KuroError('CLOCK_UNCERTAIN');
    }
    this.#monotonicHighwater = mono;
    return { wall, mono };
  }
  private markClockUncertain(): void {
    this.#clockEpochValid = false;
    this.write(() => this.staleAllPositive());
  }
  private recordWall(now: number): void { this.store.run('UPDATE authority_meta SET wall_highwater_ms=MAX(wall_highwater_ms,?) WHERE singleton=1', now); }
  private emitSpace(spaceId: string, revision: number): void { this.store.emit({ entity: 'space', id: spaceId, revision }); }
  private write<T>(operation: () => T): T {
    try { return this.store.transaction(operation); }
    catch (error) { if (error instanceof KuroError) throw error; throw new KuroError('STORAGE_FAILURE'); }
  }
}

function checkedIncrement(value: number): number {
  if (!Number.isSafeInteger(value) || value >= MAX_COUNTER) throw new KuroError('STORAGE_FAILURE');
  return value + 1;
}
function validTime(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function jsonCaps(values: readonly Capability[]): string { return JSON.stringify(ACTIONS.filter((action) => values.includes(action))); }
function parseCaps(value: string): Capability[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new KuroError('STORAGE_FAILURE'); }
  if (!Array.isArray(parsed) || parsed.some((item) => !ACTIONS.includes(item as Capability))) throw new KuroError('STORAGE_FAILURE');
  return ACTIONS.filter((action) => parsed.includes(action));
}
function closed(request: Pick<SpaceStateRequest, 'requestId' | 'spaceAlias'>): Uint8Array {
  return encodeWire({ v: 1, type: 'CLOSED', requestId: request.requestId, spaceAlias: request.spaceAlias });
}
