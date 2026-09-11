import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSourceSha, assertVersion, parseChecksum, previewArchiveName, releaseNotes, sha256, validateQualificationReport, validateOfflineQualification } from './release-validate.mjs';

test('forms the sole supported unsigned macOS preview name', () => {
  assert.equal(previewArchiveName('0.1.0-preview.1'), 'KURO-0.1.0-preview.1-darwin-arm64-unsigned-preview.tar.gz');
  assert.throws(() => previewArchiveName('0.1.0'));
});

test('rejects noncanonical source commits and malformed checksums', () => {
  assert.throws(() => assertSourceSha('ABC'));
  assert.throws(() => assertVersion('0.1.0-rc.1'));
  for (const version of ['00.1.0-preview.1', '0.01.0-preview.1', '0.1.00-preview.1', '0.1.0-preview.01']) assert.throws(() => assertVersion(version));
  assert.throws(() => parseChecksum('0'.repeat(64) + ' KURO.tar.gz', 'KURO.tar.gz'));
});

test('extracts only the authored version section', () => {
  const changelog = '# Changelog\n\n## [0.1.0-preview.1] - 2026-09-11\n\nPreview notes.\n\n## [Next]\n\nLater.';
  assert.equal(releaseNotes(changelog, '0.1.0-preview.1'), '## [0.1.0-preview.1] - 2026-09-11\n\nPreview notes.\n');
  assert.throws(() => releaseNotes(changelog, '0.1.0-preview.2'));
});

test('requires every fixed macOS qualification gate and exact archive identity', () => {
  const version = '0.1.0-preview.1', sourceSha = 'a'.repeat(40);
  const artifact = { name: previewArchiveName(version), sha256: 'b'.repeat(64), bytes: 42 };
  const report = {
    version, sourceSha, runner: { os: 'macOS', arch: 'arm64', darwinRelease: '25.5.0', macOSBuild: '25F71' }, artifact,
    checks: ['source-suite', 'native-qualification', 'relocated-full-real-gui', 'failure-boundaries', 'offline-virtual-lan-egress-reconnect', 'clean-relocation-upgrade', 'model-preparation'].map(name => ({ name, status: 'passed', evidence: [{ path: `release-evidence/${name}.json`, sha256: 'c'.repeat(64), bytes: 1 }] })), unmetGates: [],
  };
  assert.doesNotThrow(() => validateQualificationReport(report, { version, sourceSha, artifact }));
  assert.throws(() => validateQualificationReport({ ...report, runner: { ...report.runner, arch: 'x64' } }, { version, sourceSha, artifact }));
  assert.throws(() => validateQualificationReport({ ...report, artifact: { ...artifact, bytes: 43 } }, { version, sourceSha, artifact }));
  assert.throws(() => validateQualificationReport({ ...report, checks: report.checks.slice(1) }, { version, sourceSha, artifact }));
  assert.throws(() => validateQualificationReport({ ...report, checks: report.checks.map(check => check.name === 'model-preparation' ? { ...check, evidence: [] } : check) }, { version, sourceSha, artifact }));
});

test('streams artifact hashing without changing its digest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuro-release-test-'));
  try {
    const artifact = join(directory, 'archive.tar.gz');
    await writeFile(artifact, Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a));
    assert.equal(await sha256(artifact), 'ac05ef6d1cf392866a88278845b6477ee943be578a7ab3c90a61e13caa1766e5');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('offline evidence cannot pass with reused guests, stale bytes, unfinished cleanup or missing traffic', () => {
  const version = '0.1.0-preview.1', sourceSha = 'a'.repeat(40), artifactSha256 = 'b'.repeat(64);
  const report = { status: 'passed', version, sourceSha, artifactSha256,
    freshPeerStartup: true, reconnected: true, externalBlockedBefore: true, externalBlockedAfter: true,
    cleanup: { verified: true }, topology: 'two-qualified-macos-guests-on-isolated-virtual-lan',
    native: { owner: { bootSessionId: '11111111-1111-1111-1111-11111111111a' }, requester: { bootSessionId: '22222222-2222-2222-2222-222222222222' } },
    packets: { owner: 'packets/owner.pcap', requester: 'packets/requester.pcap' },
  };
  const expected = { version, sourceSha, artifactSha256, captures: Object.values(report.packets).map(path => ({ path, bytes: 82 })) };
  assert.doesNotThrow(() => validateOfflineQualification(report, expected));
  for (const field of ['version', 'sourceSha', 'artifactSha256']) assert.throws(() => validateOfflineQualification({ ...report, [field]: 'different' }, expected));
  for (const field of ['freshPeerStartup', 'reconnected', 'externalBlockedBefore', 'externalBlockedAfter']) {
    for (const value of [false, 'true', undefined]) assert.throws(() => validateOfflineQualification({ ...report, [field]: value }, expected));
  }
  for (const cleanup of [undefined, { verified: false }, { verified: 'true' }]) assert.throws(() => validateOfflineQualification({ ...report, cleanup }, expected));
  const sameGuest = structuredClone(report); sameGuest.native.requester.bootSessionId = sameGuest.native.owner.bootSessionId.toUpperCase();
  assert.throws(() => validateOfflineQualification(sameGuest, expected));
  assert.throws(() => validateOfflineQualification({ ...report, native: {} }, expected));
  assert.throws(() => validateOfflineQualification({ ...report, packets: { ...report.packets, owner: '/tmp/owner.pcap' } }, expected));
  for (const captures of [[], expected.captures.slice(1), [expected.captures[0], expected.captures[0]], expected.captures.map(item => ({ ...item, bytes: 24 }))]) {
    assert.throws(() => validateOfflineQualification(report, { ...expected, captures }));
  }
});
