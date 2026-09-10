import { encodeWire, projectionDigest, type SpaceStateResponse, type TransportEvent, type TransportPort } from '@kuro/contracts';

export interface TransportConformancePair {
  sender: TransportPort;
  recipient: TransportPort;
  senderKey: string;
  recipientKey: string;
  /** Releases an explicitly delayed authority observation after request send acceptance. */
  releaseAuthorityObservation?: () => void | Promise<void>;
  /** Releases an explicitly delayed recipient observation after response send acceptance. */
  releaseRecipientObservation?: () => void | Promise<void>;
  reconnectRecipient: () => Promise<void>;
  afterReconnect?: () => Promise<void>;
  timeoutMs?: number;
}
export interface TransportConformanceResult { request: Uint8Array; response: Uint8Array; deliveries: 5 }

/** Shared observable checks used by memory tests and the two-process real-provider harness. */
export async function runTransportConformance(pair: TransportConformancePair): Promise<TransportConformanceResult> {
  const firstRequest = spaceStateRequestBytes('1'.repeat(32));
  const firstResponse = activeResponseBytes(pair.senderKey, pair.recipientKey, '1'.repeat(32));
  const authorityEvents: TransportEvent[] = [];
  const recipientEvents: TransportEvent[] = [];
  const unsubscribeAuthority = pair.sender.subscribe((event) => authorityEvents.push(event));
  const unsubscribeRecipient = pair.recipient.subscribe((event) => recipientEvents.push(event));
  try {
    await pair.recipient.send(pair.senderKey, firstRequest);
    if (pair.releaseAuthorityObservation !== undefined) {
      require(authorityEvents.every((event) => event.type !== 'message'), 'request send resolved as a durable receipt');
      await pair.releaseAuthorityObservation();
    }
    const receivedRequest = await takeMessage(authorityEvents, pair.timeoutMs);
    require(receivedRequest.peerKey === pair.recipientKey, 'request identity did not use the authenticated recipient key');
    equalBytes(receivedRequest.bytes, firstRequest, 'authority received changed request bytes');

    await pair.sender.send(pair.recipientKey, firstResponse);
    if (pair.releaseRecipientObservation !== undefined) {
      require(recipientEvents.every((event) => event.type !== 'message'), 'response send resolved as a durable receipt');
      await pair.releaseRecipientObservation();
    }
    const first = await takeMessage(recipientEvents, pair.timeoutMs);
    require(first.peerKey === pair.senderKey, 'response identity did not use the authenticated authority key');
    equalBytes(first.bytes, firstResponse, 'first ACTIVE response changed exact D25 bytes');
    await requireRejected(pair.sender.send('f'.repeat(64), firstResponse), 'unknown paired peer send was accepted');

    await pair.reconnectRecipient();
    await pair.afterReconnect?.();
    const freshRequest = spaceStateRequestBytes('6'.repeat(32));
    const freshResponse = activeResponseBytes(pair.senderKey, pair.recipientKey, '6'.repeat(32));
    await pair.recipient.send(pair.senderKey, freshRequest);
    if (pair.releaseAuthorityObservation !== undefined) await pair.releaseAuthorityObservation();
    const reconnectRequest = await takeMessage(authorityEvents, pair.timeoutMs);
    require(reconnectRequest.peerKey === pair.recipientKey, 'reconnected request lost authenticated recipient provenance');
    equalBytes(reconnectRequest.bytes, freshRequest, 'reconnected request changed exact D25 bytes');
    await pair.sender.send(pair.recipientKey, freshResponse);
    if (pair.releaseRecipientObservation !== undefined) await pair.releaseRecipientObservation();
    const refreshed = await takeMessage(recipientEvents, pair.timeoutMs);
    require(refreshed.peerKey === pair.senderKey, 'reconnected response lost authenticated authority provenance');
    equalBytes(refreshed.bytes, freshResponse, 'fresh ACTIVE response changed exact D25 bytes');
    await pair.sender.send(pair.recipientKey, freshResponse);
    if (pair.releaseRecipientObservation !== undefined) await pair.releaseRecipientObservation();
    const replay = await takeMessage(recipientEvents, pair.timeoutMs);
    equalBytes(replay.bytes, freshResponse, 'immutable response replay changed exact D25 bytes');
    return { request: freshRequest, response: freshResponse, deliveries: 5 };
  } finally { unsubscribeAuthority(); unsubscribeRecipient(); }
}

/** Synthetic D25 ACTIVE body whose identity fields are bound to actual transport keys. */
export function spaceStateRequestBytes(requestId: string): Uint8Array {
  return encodeWire({ v: 1, type: 'SPACE_STATE_REQUEST', requestId, spaceAlias: '2'.repeat(32) });
}

export function activeResponseBytes(authorityKey: string, recipientKey: string, requestId = '1'.repeat(32)): Uint8Array {
  const response: Omit<SpaceStateResponse, 'projectionDigest'> = {
    v: 1, type: 'SPACE_STATE_RESPONSE', requestId, spaceAlias: '2'.repeat(32), spaceId: '3'.repeat(32),
    authorityKey, recipientKey, policyRevision: 1, publicationSeq: 1, projectionScope: 'recipient-authorized-peers-v1', status: 'ACTIVE', validForMs: 60_000,
    members: [
      { memberId: '4'.repeat(32), deviceKeys: [authorityKey], capabilities: ['read'] },
      { memberId: '5'.repeat(32), deviceKeys: [recipientKey], capabilities: ['receive'] },
    ],
  };
  return encodeWire({ ...response, projectionDigest: projectionDigest(response) });
}

async function takeMessage(events: TransportEvent[], timeoutMs = 5_000): Promise<Extract<TransportEvent, { type: 'message' }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const index = events.findIndex((item) => item.type === 'message');
    if (index >= 0) return events.splice(index, 1)[0] as Extract<TransportEvent, { type: 'message' }>;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for a transport message');
}
async function requireRejected(promise: Promise<unknown>, message: string): Promise<void> { try { await promise; } catch { return; } throw new Error(message); }
function equalBytes(actual: Uint8Array, expected: Uint8Array, message: string): void { require(actual.byteLength === expected.byteLength && actual.every((value, index) => value === expected[index]), message); }
function require(condition: boolean, message: string): asserts condition { if (!condition) throw new Error(message); }
