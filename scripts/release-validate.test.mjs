import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSourceSha, assertVersion, parseChecksum, previewArchiveName, releaseNotes, sha256, validateQualificationReport } from './release-validate.mjs';

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
