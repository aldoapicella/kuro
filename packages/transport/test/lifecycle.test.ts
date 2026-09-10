/// <reference path="../src/hyperdht.d.ts" />
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import test from 'node:test';
import HyperDHT from 'hyperdht';
import { encodeWire } from '@kuro/contracts';
import { HyperDhtTransport, InMemorySecretStore } from '../src/index.js';

test('concurrent stops serialize a same-identity restart before a new send', async () => {
  const bootstrapper = HyperDHT.bootstrapper(await reserveUdpPort(), '127.0.0.1');
  await bootstrapper.fullyBootstrapped();
  const bootstrap = [{ host: '127.0.0.1', port: bootstrapper.address().port }];
  const router = new HyperDHT({ bootstrap, ephemeral: false, host: '127.0.0.1', firewalled: false });
  await router.fullyBootstrapped();
  const left = new HyperDhtTransport({ secretStore: seededStore(randomBytes(32)), secretName: 'seed', allowEphemeralTest: true, bootstrap });
  const right = new HyperDhtTransport({ secretStore: seededStore(randomBytes(32)), secretName: 'seed', allowEphemeralTest: true, bootstrap });
  try {
    const leftKey = (await left.start()).publicKey;
    const rightKey = (await right.start()).publicKey;
    left.pair(rightKey); right.pair(leftKey);
    const firstStop = left.stop();
    const secondStop = left.stop();
    assert.equal(secondStop, firstStop);
    const restarting = left.start();
    await firstStop;
    assert.equal((await restarting).publicKey, leftKey);
    await right.stop();
    assert.equal((await right.start()).publicKey, rightKey);
    const body = encodeWire({ v: 1, type: 'CLOSED', requestId: '1'.repeat(32), spaceAlias: '2'.repeat(32) });
    const received = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for restarted transport send')), 10_000);
      right.subscribe((event) => { if (event.type === 'message') { clearTimeout(timer); resolve(event.bytes); } });
    });
    await left.send(rightKey, body);
    assert.deepEqual(await received, body);
  } finally {
    await Promise.allSettled([left.stop(), right.stop()]);
    await router.destroy(); await bootstrapper.destroy();
  }
});

function seededStore(seed: Uint8Array): InMemorySecretStore {
  return new InMemorySecretStore('ephemeral-test', new Map([['seed', seed]]));
}
async function reserveUdpPort(): Promise<number> {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', () => resolve()); });
  const address = socket.address();
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  if (typeof address === 'string' || address.port === 0) throw new Error('Could not reserve a UDP port');
  return address.port;
}
