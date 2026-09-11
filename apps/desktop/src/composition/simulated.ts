import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openCore, SelectedTextFiles, secureIds, systemClock } from '@kuro/core';
import { FakeAiPort, FakeSession } from '@kuro/core/testing';
import { MemoryNetwork, MemoryTransport } from '@kuro/transport';
import { KuroError, IDSchema } from '@kuro/contracts';
import type { AppPort, Capability, Clock, DesktopInfo, Result } from '@kuro/contracts';
import type { CustodyCore } from '@kuro/core';
import { VerifiedPairings } from '../selections.js';
import { DEMO_OWNER, DEMO_REQUESTER, DEMO_TEXT } from '../fake-app.js';

export interface SimulatedNode {
  app: AppPort; core: CustodyCore; ai: FakeAiPort;
  files: SelectedTextFiles; pairing: VerifiedPairings; info: DesktopInfo;
}
const ALL: Capability[] = ['search', 'read', 'share', 'receive', 'manage'];
export function value<T>(result: Result<T>): T { if (!result.ok) throw new KuroError(result.error.code); return result.value; }

/** Real core/SQLite at both ends; deterministic AI and transport are explicitly simulated. */
export async function createSimulatedDesktop(directory: string, clock: Clock = systemClock) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // This directory is created by our host, not a renderer-selected document.
  // Canonicalize its macOS temporary-directory aliases without weakening import checks.
  directory = await realpath(directory);
  const network = new MemoryNetwork();
  const nodes = new Map<'A' | 'B', SimulatedNode>();
  let pumping: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await pumping?.catch(() => {});
      const results = await Promise.allSettled([...nodes.values()].map(node => node.core.stop()));
      if (results.some(r => r.status === 'rejected')) throw new Error('KURO simulated core shutdown failed');
    })();
    return closing;
  };
  const pump = (): Promise<void> => {
    if (closing) return closing;
    pumping ??= (async () => {
      for (let turn = 0; turn < 6; turn++) {
        for (const node of nodes.values()) await node.core.tick();
        network.flush();
        for (const node of nodes.values()) await node.core.settled();
      }
    })().finally(() => { pumping = null; });
    return pumping;
  };
  try {
    for (const profile of ['B', 'A'] as const) {
      const identity = profile === 'A' ? DEMO_REQUESTER : DEMO_OWNER;
      const peer = profile === 'A' ? DEMO_OWNER : DEMO_REQUESTER;
      const files = new SelectedTextFiles(), pairing = new VerifiedPairings(), ai = new FakeAiPort();
      const transport = new MemoryTransport({ network, publicKey: identity.publicKey, pairedPeers: [peer.publicKey] });
      const core = await openCore({ databasePath: join(directory, `${profile}.sqlite`), ai, transport, clock, ids: secureIds, sessions: new FakeSession({ memberId: identity.memberId, deviceKey: identity.publicKey, validUntilMs: Number.MAX_SAFE_INTEGER }), selectedFiles: files, pairing, clockInitiallyTrusted: true });
      nodes.set(profile, { app: core.app, core, ai, files, pairing, info: { mode: 'core-simulated', profile, ...identity, peers: [peer], scenario: null, clockProtection: 'simulated' } });
    }
    const owner = nodes.get('B')!, requester = nodes.get('A')!;
    let spaceId: string;
    try { spaceId = IDSchema.parse((JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')) as { spaceId?: unknown }).spaceId); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      const space = value(await owner.app.createSpace({ capabilities: ALL, localActions: ALL })); spaceId = space.spaceId;
      const spaceAlias = secureIds.nextId();
      const selectionId = owner.pairing.register({ kind: 'member', spaceId, spaceAlias, memberId: DEMO_REQUESTER.memberId, peerKey: DEMO_REQUESTER.publicKey });
      const enrolled = value(await owner.app.enrollMember({ spaceId, selectionId, capabilities: ALL, validUntilMs: null, expectedRevision: space.policyRevision }));
      const related = value(await owner.app.setRelationship({ spaceId, memberId: DEMO_OWNER.memberId, otherMemberId: DEMO_REQUESTER.memberId, allowed: true, validUntilMs: null, expectedRevision: enrolled.policyRevision }));
      value(await owner.app.setLocalPolicy({ spaceId, memberId: DEMO_REQUESTER.memberId, admitted: true, actions: ALL, validUntilMs: null, expectedRevision: related.policyEpoch }));
      value(await requester.app.pairSpace({ selectionId: requester.pairing.register({ kind: 'authority', spaceId, spaceAlias, authorityKey: DEMO_OWNER.publicKey }), localActions: ALL }));
      value(await requester.app.refreshSpace({ spaceId })); await pump();
      const local = value(await requester.app.getState({})).spaces.find(s => s.spaceId === spaceId)!;
      value(await requester.app.setLocalPolicy({ spaceId, memberId: DEMO_OWNER.memberId, admitted: true, actions: ['share'], validUntilMs: null, expectedRevision: local.policyEpoch }));
      value(await requester.app.pairPeer({ selectionId: requester.pairing.register({ kind: 'peer', spaceId, spaceAlias, peerKey: DEMO_OWNER.publicKey }) }));
      const samplePath = join(directory, 'synthetic-release-note.txt');
      await writeFile(samplePath, DEMO_TEXT, { mode: 0o600 });
      value(await owner.app.importText({ spaceId, selectionId: owner.files.register(samplePath), replaceDocumentId: null, expectedRevision: null, rules: [{ memberId: DEMO_OWNER.memberId, actions: ['read', 'share'], validUntilMs: null }, { memberId: DEMO_REQUESTER.memberId, actions: ['receive'], validUntilMs: null }] }));
      const restrictedPath = join(directory, 'synthetic-restricted.txt');
      await writeFile(restrictedPath, 'RESTRICTED-SENTINEL: This synthetic personnel record must never reach requester A.', { mode: 0o600 });
      value(await owner.app.importText({ spaceId, selectionId: owner.files.register(restrictedPath), replaceDocumentId: null, expectedRevision: null, rules: [{ memberId: DEMO_OWNER.memberId, actions: ['read', 'share'], validUntilMs: null }] }));
      await pump();
      await writeFile(join(directory, 'workspace.json'), JSON.stringify({ spaceId }), { mode: 0o600, flag: 'wx' });
    }
    value(await requester.app.refreshSpace({ spaceId })); await pump();
    return { nodes, network, spaceId, pump, close };
  } catch (error) { await close(); throw error; }
}
