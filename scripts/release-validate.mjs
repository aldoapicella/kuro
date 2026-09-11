import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-preview\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
export const REQUIRED_QUALIFICATION_CHECKS = ['source-suite', 'native-qualification', 'relocated-full-real-gui', 'failure-boundaries', 'offline-virtual-lan-egress-reconnect', 'clean-relocation-upgrade', 'model-preparation'];
export const QUALIFIED_RUNNER = { os: 'macOS', arch: 'arm64', darwinRelease: '25.5.0', macOSBuild: '25F71' };

export function previewArchiveName(version) {
  assertVersion(version);
  return `KURO-${version}-darwin-arm64-unsigned-preview.tar.gz`;
}

export function assertVersion(version) {
  if (!VERSION.test(version)) throw new Error(`Release version must be an unsigned preview SemVer version: ${version}`);
}

export function assertSourceSha(sourceSha) {
  if (!SHA.test(sourceSha)) throw new Error(`Source SHA must be a 40-character lowercase commit ID: ${sourceSha}`);
}

export function releaseNotes(changelog, version) {
  assertVersion(version);
  const heading = `## [${version}]`;
  const start = changelog.indexOf(heading);
  if (start < 0) throw new Error(`CHANGELOG.md has no ${heading} section`);
  const next = changelog.indexOf('\n## ', start + heading.length);
  return changelog.slice(start, next < 0 ? undefined : next).trim() + '\n';
}

export function parseChecksum(text, archiveName) {
  const line = text.trim();
  const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
  if (!match || match[2] !== archiveName) throw new Error(`Checksum must name ${archiveName}`);
  return match[1];
}

export function validateQualificationReport(report, { version, sourceSha, artifact }) {
  if (!report || typeof report !== 'object') throw new Error('Qualification report must be an object');
  if (report.version !== version || report.sourceSha !== sourceSha) throw new Error('Qualification report does not describe the requested source and version');
  for (const [key, expected] of Object.entries(QUALIFIED_RUNNER)) if (report.runner?.[key] !== expected) throw new Error(`Qualification report runner ${key} is not ${expected}`);
  if (!report.artifact || report.artifact.name !== artifact.name || report.artifact.sha256 !== artifact.sha256 || report.artifact.bytes !== artifact.bytes) throw new Error('Qualification report does not describe the exact release archive');
  if (!Array.isArray(report.checks) || report.checks.length !== REQUIRED_QUALIFICATION_CHECKS.length) throw new Error('Qualification report must contain every required check exactly once');
  const names = new Set();
  for (const check of report.checks) {
    if (!check || !REQUIRED_QUALIFICATION_CHECKS.includes(check.name) || names.has(check.name) || check.status !== 'passed') throw new Error('Qualification report has an unknown, duplicate, or non-passing check');
    names.add(check.name);
    if (!Array.isArray(check.evidence) || !check.evidence.length) throw new Error(`Qualification check ${check.name} has no persisted evidence`);
    for (const evidence of check.evidence) if (!evidence || typeof evidence.path !== 'string' || !evidence.path || isAbsolute(evidence.path) || evidence.path.split('/').includes('..') || !DIGEST.test(evidence.sha256) || !Number.isSafeInteger(evidence.bytes) || evidence.bytes < 0) throw new Error(`Qualification check ${check.name} has invalid evidence metadata`);
  }
  if (!Array.isArray(report.unmetGates) || report.unmetGates.length) throw new Error('Qualification report has unmet gates');
}

export function validateOfflineQualification(report, { version, sourceSha, artifactSha256, captures }) {
  if (report?.status !== 'passed' || report.version !== version || report.sourceSha !== sourceSha || report.artifactSha256 !== artifactSha256 ||
      report.freshPeerStartup !== true || report.reconnected !== true || report.externalBlockedBefore !== true || report.externalBlockedAfter !== true ||
      report.cleanup?.verified !== true || report.topology !== 'two-qualified-macos-guests-on-isolated-virtual-lan') throw new Error('Offline virtual GUI qualification did not prove its required boundaries');
  const roles = ['owner', 'requester'], bootIds = roles.map(role => report.native?.[role]?.bootSessionId);
  if (bootIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) || new Set(bootIds.map(id => id.toLowerCase())).size !== 2) throw new Error('Offline qualification requires two distinct live guest boot identities');
  if (!Array.isArray(captures) || captures.length !== 2 || captures.some(item => !Number.isSafeInteger(item.bytes) || item.bytes <= 24)) throw new Error('Offline qualification requires nonempty packet captures from both guests');
  for (const role of roles) {
    const path = `packets/${role}.pcap`;
    if (report.packets?.[role] !== path || captures.filter(item => item.path === path).length !== 1) throw new Error('Offline packet evidence must identify each guest with a relative artifact path');
  }
}

export async function sha256(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

function archiveManifest(archive) {
  // The packager's fixed top-level directory lets us extract only this tiny file;
  // listing an arbitrarily large archive would retain an unbounded path listing.
  const manifest = 'KURO-darwin-arm64/KURO.app/Contents/Resources/app/package.json';
  const extracted = spawnSync('tar', ['-xOzf', archive, manifest], { encoding: 'utf8' });
  if (extracted.status !== 0) throw new Error(`Cannot read staged app manifest: ${extracted.stderr.trim()}`);
  return JSON.parse(extracted.stdout);
}

async function validateEvidence(report, reportPath) {
  const reportDirectory = dirname(reportPath);
  for (const check of report.checks) for (const evidence of check.evidence) {
    const path = resolve(reportDirectory, evidence.path);
    if (relative(reportDirectory, path).startsWith('..')) throw new Error(`Evidence escaped report directory: ${evidence.path}`);
    const info = await stat(path);
    if (!info.isFile() || info.size !== evidence.bytes || await sha256(path) !== evidence.sha256) throw new Error(`Evidence does not match report: ${evidence.path}`);
  }
}

export async function validateRelease({ workspace, version, sourceSha, artifactDirectory, qualificationReport }) {
  assertVersion(version); assertSourceSha(sourceSha);
  const manifest = JSON.parse(await readFile(join(workspace, 'apps/desktop/package.json'), 'utf8'));
  if (manifest.version !== version) throw new Error(`Desktop package version is ${manifest.version}, expected ${version}`);
  const changelog = await readFile(join(workspace, 'CHANGELOG.md'), 'utf8');
  releaseNotes(changelog, version);
  const archive = join(artifactDirectory, previewArchiveName(version));
  const checksum = `${archive}.sha256`;
  const expectedDigest = parseChecksum(await readFile(checksum, 'utf8'), basename(archive));
  const archiveInfo = await stat(archive);
  if (!archiveInfo.isFile() || !Number.isSafeInteger(archiveInfo.size) || archiveInfo.size <= 0 || archiveInfo.size >= 2 * 1024 ** 3) throw new Error(`Release archive must be a non-empty regular file below 2 GiB: ${basename(archive)}`);
  const actualDigest = await sha256(archive);
  if (actualDigest !== expectedDigest) throw new Error(`Checksum mismatch for ${basename(archive)}`);
  const shipped = archiveManifest(archive);
  if (shipped.version !== version) throw new Error(`Shipped app version is ${shipped.version}, expected ${version}`);
  if (shipped.sourceCommit !== sourceSha) throw new Error(`Shipped source commit is ${shipped.sourceCommit}, expected ${sourceSha}`);
  const artifact = { name: basename(archive), sha256: actualDigest, bytes: archiveInfo.size };
  if (qualificationReport) {
    const report = JSON.parse(await readFile(qualificationReport, 'utf8'));
    validateQualificationReport(report, { version, sourceSha, artifact });
    await validateEvidence(report, qualificationReport);
  }
  const result = { version, sourceSha, artifact, unsignedPreview: true };
  return result;
}

export async function validateReleaseMetadata({ workspace, version }) {
  assertVersion(version);
  const manifest = JSON.parse(await readFile(join(workspace, 'apps/desktop/package.json'), 'utf8'));
  if (manifest.version !== version) throw new Error(`Desktop package version is ${manifest.version}, expected ${version}`);
  releaseNotes(await readFile(join(workspace, 'CHANGELOG.md'), 'utf8'), version);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const command = process.argv[2];
  if (command === 'metadata') {
    await validateReleaseMetadata({ workspace: resolve(option('--workspace')), version: option('--version') });
  } else if (command === 'notes') {
    const workspace = resolve(option('--workspace'));
    process.stdout.write(releaseNotes(await readFile(join(workspace, 'CHANGELOG.md'), 'utf8'), option('--version')));
  } else if (command === 'artifacts') {
    const result = await validateRelease({ workspace: resolve(option('--workspace')), version: option('--version'), sourceSha: option('--source-sha'), artifactDirectory: resolve(option('--artifact-directory')), qualificationReport: process.argv.includes('--qualification-report') ? resolve(option('--qualification-report')) : undefined });
    console.log(JSON.stringify(result));
  } else throw new Error('Usage: release-validate.mjs metadata|notes|artifacts');
}
