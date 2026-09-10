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

interface AcceptedMessage { peerKey: string; bytes: Uint8Array }
interface Observation {
  transport: TransportPort;
  sendPeerKey: string;
  expectedPeerKey: string;
  bytes: Uint8Array;
  events: TransportEvent[];
  accepted: AcceptedMessage[];
  release: (() => void | Promise<void>) | undefined;
  assertUndeliveredOnFirstRelease?: string;
  acceptPreviouslyAccepted?: boolean;
}

/** Shared observable checks used by memory tests and the two-process real-provider harness. */
export async function runTransportConformance(pair: TransportConformancePair): Promise<TransportConformanceResult> {
  const firstRequest = spaceStateRequestBytes('1'.repeat(32));
  const firstResponse = activeResponseBytes(pair.senderKey, pair.recipientKey, '1'.repeat(32));
  const authorityEvents: TransportEvent[] = [];
  const recipientEvents: TransportEvent[] = [];
  const accepted: AcceptedMessage[] = [];
  const unsubscribeAuthority = pair.sender.subscribe((event) => authorityEvents.push(event));
  const unsubscribeRecipient = pair.recipient.subscribe((event) => recipientEvents.push(event));
  try {
    const timeoutMs = pair.timeoutMs ?? 5_000;
    await sendUntilObserved({
      transport: pair.recipient, sendPeerKey: pair.senderKey, expectedPeerKey: pair.recipientKey, bytes: firstRequest, events: authorityEvents, accepted,
      release: pair.releaseAuthorityObservation, assertUndeliveredOnFirstRelease: 'request send resolved as a durable receipt',
    }, timeoutMs);
    await sendUntilObserved({
      transport: pair.sender, sendPeerKey: pair.recipientKey, expectedPeerKey: pair.senderKey, bytes: firstResponse, events: recipientEvents, accepted,
      release: pair.releaseRecipientObservation, assertUndeliveredOnFirstRelease: 'response send resolved as a durable receipt',
    }, timeoutMs);
    await requireRejected(pair.sender.send('f'.repeat(64), firstResponse), 'unknown paired peer send was accepted');

    await pair.reconnectRecipient();
    await pair.afterReconnect?.();
    const freshRequest = spaceStateRequestBytes('6'.repeat(32));
    const freshResponse = activeResponseBytes(pair.senderKey, pair.recipientKey, '6'.repeat(32));
    await sendUntilObserved({ transport: pair.recipient, sendPeerKey: pair.senderKey, expectedPeerKey: pair.recipientKey, bytes: freshRequest, events: authorityEvents, accepted, release: pair.releaseAuthorityObservation }, timeoutMs);
    await sendUntilObserved({ transport: pair.sender, sendPeerKey: pair.recipientKey, expectedPeerKey: pair.senderKey, bytes: freshResponse, events: recipientEvents, accepted, release: pair.releaseRecipientObservation }, timeoutMs);
    await sendUntilObserved({ transport: pair.sender, sendPeerKey: pair.recipientKey, expectedPeerKey: pair.senderKey, bytes: freshResponse, events: recipientEvents, accepted, release: pair.releaseRecipientObservation, acceptPreviouslyAccepted: true }, timeoutMs);
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

/** Retries acceptance of immutable application bytes; acceptance alone is not a receipt. */
async function sendUntilObserved(observation: Observation, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const retryWindowMs = Math.min(250, Math.max(25, Math.floor(timeoutMs / 10)));
  let attempts = 0;
  while (Date.now() < deadline) {
    try { await sendBeforeDeadline(observation.transport.send(observation.sendPeerKey, observation.bytes), deadline); }
    catch (error) { if (error instanceof Error && error.message === 'Transport acceptance timed out') throw timeoutError(attempts, observation.events); throw error; }
    attempts++;
    if (attempts === 1 && observation.release !== undefined && observation.assertUndeliveredOnFirstRelease !== undefined) {
      require(observation.events.every((event) => event.type !== 'message'), observation.assertUndeliveredOnFirstRelease);
    }
    await observation.release?.();
    if (await takeExpected(observation, Math.min(deadline, Date.now() + retryWindowMs))) return;
  }
  throw timeoutError(attempts, observation.events);
}
/** Discards only a byte-identical authenticated duplicate already accepted by this suite. */
async function takeExpected(observation: Observation, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    const index = observation.events.findIndex((item) => item.type === 'message');
    if (index < 0) { await new Promise<void>((resolve) => setTimeout(resolve, 10)); continue; }
    const message = observation.events.splice(index, 1)[0] as Extract<TransportEvent, { type: 'message' }>;
    if (!observation.acceptPreviouslyAccepted && observation.accepted.some((accepted) => accepted.peerKey === message.peerKey && equal(message.bytes, accepted.bytes))) continue;
    require(message.peerKey === observation.expectedPeerKey, 'transport message did not use the expected authenticated peer key');
    equalBytes(message.bytes, observation.bytes, 'transport message did not preserve exact expected D25 bytes');
    observation.accepted.push({ peerKey: message.peerKey, bytes: new Uint8Array(message.bytes) });
    return true;
  }
  return false;
}
async function requireRejected(promise: Promise<unknown>, message: string): Promise<void> { try { await promise; } catch { return; } throw new Error(message); }
function equalBytes(actual: Uint8Array, expected: Uint8Array, message: string): void { require(actual.byteLength === expected.byteLength && actual.every((value, index) => value === expected[index]), message); }
function equal(actual: Uint8Array, expected: Uint8Array): boolean { return actual.byteLength === expected.byteLength && actual.every((value, index) => value === expected[index]); }
async function sendBeforeDeadline(send: Promise<void>, deadline: number): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error('Transport observation deadline elapsed');
  let timer: NodeJS.Timeout | undefined;
  await new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Transport acceptance timed out')), remainingMs);
    void send.then(() => { if (timer !== undefined) clearTimeout(timer); resolve(); }, (error: unknown) => { if (timer !== undefined) clearTimeout(timer); reject(error); });
  });
}
function timeoutError(attempts: number, events: TransportEvent[]): Error { return new Error(`Timed out waiting for exact authenticated transport message after ${attempts} accepted sends; ${eventContext(events)}`); }
function eventContext(events: TransportEvent[]): string {
  const context = events.filter((event) => event.type !== 'message').slice(-8).map((event) => event.type === 'error' ? `error:${event.code}` : `${event.type}:${event.peerKey}`);
  return context.length === 0 ? 'no transport lifecycle events' : `transport events: ${context.join(', ')}`;
}
function require(condition: boolean, message: string): asserts condition { if (!condition) throw new Error(message); }
