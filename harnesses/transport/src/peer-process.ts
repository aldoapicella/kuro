import { createInterface } from 'node:readline';
import { InMemorySecretStore, HyperDhtTransport } from '@kuro/transport';

interface ProcessConfig { bootstrap: { host: string; port: number }[]; seedHex: string; pairedPeers: string[]; holdMessages?: boolean }
const config = JSON.parse(process.env.KURO_TRANSPORT_CONFIG ?? '') as ProcessConfig;
const secret = new InMemorySecretStore('ephemeral-test', new Map([['smoke-seed', Buffer.from(config.seedHex, 'hex')]]));
const transport = new HyperDhtTransport({ secretStore: secret, secretName: 'smoke-seed', allowEphemeralTest: true, bootstrap: config.bootstrap, pairedPeers: config.pairedPeers });
const heldMessages: Array<{ peerKey: string; bytesHex: string }> = [];
let releaseMessages = config.holdMessages !== true;
transport.subscribe((event) => {
  if (event.type !== 'message') return;
  const message = { peerKey: event.peerKey, bytesHex: Buffer.from(event.bytes).toString('hex') };
  if (!releaseMessages) heldMessages.push(message); else output({ type: 'message', ...message });
});
const started = await transport.start();
output({ type: 'ready', publicKey: started.publicKey });
createInterface({ input: process.stdin }).on('line', (line) => { void command(line); });

async function command(line: string): Promise<void> {
  const value = JSON.parse(line) as { type: 'send' | 'restart' | 'release' | 'pair' | 'remove-pair' | 'stop'; peerKey?: string; bytesHex?: string };
  if (value.type === 'send' && value.peerKey !== undefined && value.bytesHex !== undefined) {
    try { await transport.send(value.peerKey, Buffer.from(value.bytesHex, 'hex')); output({ type: 'sent' }); }
    catch (error) { output({ type: 'rejected', code: error instanceof Error ? error.message : 'send failed' }); }
    return;
  }
  if (value.type === 'restart') { await transport.stop(); releaseMessages = config.holdMessages !== true; const restarted = await transport.start(); output({ type: 'ready', publicKey: restarted.publicKey }); return; }
  if (value.type === 'release') { releaseMessages = true; for (const message of heldMessages.splice(0)) output({ type: 'message', ...message }); return; }
  if (value.type === 'pair' && value.peerKey !== undefined) { transport.pair(value.peerKey); output({ type: 'updated' }); return; }
  if (value.type === 'remove-pair' && value.peerKey !== undefined) { transport.removePair(value.peerKey); output({ type: 'updated' }); return; }
  if (value.type === 'stop') { await transport.stop(); process.exit(0); }
}
function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
