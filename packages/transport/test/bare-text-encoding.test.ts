import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import type { ChildProcess } from 'node:child_process';

const spawn = createRequire(import.meta.url)('bare-runtime/spawn') as (referrer: string, options: { args: string[]; cwd: string; stdio: ['ignore', 'pipe', 'pipe'] }) => ChildProcess;

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const distDirectory = join(packageDirectory, 'dist');
const probeSource = join(distDirectory, 'bare-text-encoding-probe.entry.mjs');
const probeBundle = join(distDirectory, 'bare-text-encoding-probe.bundle.mjs');
const textEncodingShim = fileURLToPath(new URL('../src/bare-text-encoding.ts', import.meta.url));

test('Bare text encoding preserves strict UTF-8 and one-shot decoder semantics', async () => {
  await mkdir(distDirectory, { recursive: true });
  await writeFile(probeSource, `
    import { TextDecoder, TextEncoder } from '../src/bare-text-encoding.ts';
    import { decodeWire, encodeWire } from '@kuro/contracts';
    const encoder = new TextEncoder();
    const text = 'Kürø 🐻';
    const encoded = encoder.encode(text);
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(encoded);
    let malformed = false;
    try { new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.of(0xc3, 0x28)); }
    catch { malformed = true; }
    const replacement = new TextDecoder().decode(Uint8Array.of(0xc3, 0x28));
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf, 0x41);
    const bomStripped = new TextDecoder().decode(bom);
    const bomKept = new TextDecoder('utf8', { ignoreBOM: true }).decode(bom);
    let streaming = false;
    try { new TextDecoder().decode(encoded, { stream: true }); }
    catch { streaming = true; }
    const wire = encodeWire({ v: 1, type: 'SEARCH_REQUEST', requestId: '1'.repeat(32), spaceAlias: '2'.repeat(32), ttlSeconds: 60, query: text, audienceKey: '3'.repeat(64) });
    const roundtrip = decodeWire(wire);
    let malformedWire = false;
    try { decodeWire(Uint8Array.of(0xc3, 0x28)); }
    catch { malformedWire = true; }
    let duplicateKey = false;
    try { decodeWire(encoder.encode('{"v":1,"type":"CLOSED","requestId":"' + '1'.repeat(32) + '","requestId":"' + '2'.repeat(32) + '","spaceAlias":"' + '3'.repeat(32) + '"}')); }
    catch { duplicateKey = true; }
    console.log(JSON.stringify({ encoding: encoder.encoding, bytes: encoded.length, decoded, malformed, replacement, bomStripped, bomKept, streaming, wireQuery: roundtrip.type === 'SEARCH_REQUEST' && roundtrip.query === text, malformedWire, duplicateKey }));
  `);
  try {
    await build({ entryPoints: [probeSource], bundle: true, format: 'esm', platform: 'neutral', external: ['bare-buffer'], inject: [textEncodingShim], outfile: probeBundle, logLevel: 'silent' });
    const result = await runBare(probeBundle);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(output.encoding, 'utf-8');
    assert.equal(output.decoded, 'Kürø 🐻');
    assert.equal(output.malformed, true);
    assert.equal(output.replacement, '�(');
    assert.equal(output.bomStripped, 'A');
    assert.equal(output.bomKept, '\ufeffA');
    assert.equal(output.streaming, true);
    assert.equal(output.wireQuery, true);
    assert.equal(output.malformedWire, true);
    assert.equal(output.duplicateKey, true);
    assert.equal(typeof output.bytes, 'number');
  } finally {
    await rm(probeSource, { force: true });
    await rm(probeBundle, { force: true });
  }
});

function runBare(entry: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bare', { args: [entry], cwd: packageDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('Bare text encoding probe timed out'));
    }, 10_000);
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', fail);
    child.once('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}
