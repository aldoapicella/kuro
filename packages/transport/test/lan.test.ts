import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { HyperDhtTransport, InMemorySecretStore, runTransportConformance } from '../src/index.js';

test('an explicit Bare LAN host supplies bootstrap and routing through fresh peer restart', { timeout: 45_000 }, async () => {
  const bootstrapPort = await unusedPort();
  const bootstrap = [{ host: '127.0.0.1', port: bootstrapPort }];
  const owner = new HyperDhtTransport({ secretStore: new InMemorySecretStore(), allowEphemeralTest: true,
    bootstrap, bootstrapPort, localPort: await unusedPort() });
  const participant = new HyperDhtTransport({ secretStore: new InMemorySecretStore(), allowEphemeralTest: true,
    bootstrap, localPort: await unusedPort() });
  try {
    const senderKey = (await owner.start()).publicKey;
    const recipientKey = (await participant.start()).publicKey;
    owner.pair(recipientKey); participant.pair(senderKey);
    const result = await runTransportConformance({ sender: owner, recipient: participant, senderKey, recipientKey,
      timeoutMs: 10_000, reconnectRecipient: async () => {
        await participant.stop();
        assert.equal((await participant.start()).publicKey, recipientKey);
      } });
    assert.equal(result.deliveries, 5);
  } finally {
    // Assert acknowledged shutdown, including the host's bootstrap socket.
    const results = await Promise.allSettled([participant.stop(), owner.stop()]);
    for (const result of results) assert.equal(result.status, 'fulfilled');
  }
  const probe = createSocket('udp4');
  try { await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.bind(bootstrapPort, '0.0.0.0', resolve); }); }
  finally { probe.close(); }
});

async function unusedPort(): Promise<number> {
  const socket = createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
    return socket.address().port;
  } finally { socket.close(); }
}
