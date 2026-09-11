#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceGuard = join(scriptDirectory, 'release-runner-guard.mjs');
const sourceHook = join(scriptDirectory, 'release-runner-job-started.sh');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'kuro-runner-guard-test-')));
const hookDirectory = join(directory, 'hooks');
const guard = join(hookDirectory, 'guard.mjs');
const hook = join(hookDirectory, 'job-started.sh');
const worker = join(directory, 'bin', 'Runner.Worker');
const bundledNode = join(directory, 'externals', 'node24', 'bin', 'node');
const config = join(directory, 'release-config.json');
const policy = join(hookDirectory, 'expected-release.json');
const event = join(directory, 'event.json');
const marker = join(directory, 'continued-after-denial');

try {
  await mkdir(join(directory, 'bin'), { recursive: true, mode: 0o700 });
  await mkdir(dirname(bundledNode), { recursive: true, mode: 0o700 });
  await mkdir(hookDirectory, { mode: 0o700 });
  await symlink('/bin/sh', worker);
  await symlink(process.execPath, bundledNode);
  await copyFile(sourceGuard, guard);
  await chmod(guard, 0o500);
  await copyFile(sourceHook, hook);
  await chmod(hook, 0o500);
  const configBytes = Buffer.from('{"embeddingFile":"/private/e","summaryFile":"/private/s","offlineConfiguration":"/private/o"}\n');
  await writeFile(config, configBytes, { mode: 0o600 });
  const sha = 'a'.repeat(40);
  const releasePolicy = {
    schemaVersion: 1,
    repository: 'aldoapicella/kuro',
    workflowRef: 'aldoapicella/kuro/.github/workflows/release.yml@refs/heads/main',
    actor: 'aldoapicella',
    eventName: 'workflow_dispatch',
    job: 'qualify',
    ref: 'refs/heads/main',
    workflowSha: sha,
    sourceSha: sha,
    version: '0.1.0-preview.1',
    releaseConfig: {
      path: config,
      sha256: createHash('sha256').update(configBytes).digest('hex'),
      bytes: configBytes.length,
    },
  };
  await writeFile(policy, `${JSON.stringify(releasePolicy)}\n`, { mode: 0o600 });
  await writeFile(event, `${JSON.stringify({ inputs: { source_sha: sha, version: releasePolicy.version } })}\n`, { mode: 0o600 });
  const allowedEnvironment = {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'aldoapicella/kuro',
    GITHUB_REPOSITORY_OWNER: 'aldoapicella',
    GITHUB_WORKFLOW_REF: releasePolicy.workflowRef,
    GITHUB_ACTOR: 'aldoapicella',
    GITHUB_TRIGGERING_ACTOR: 'aldoapicella',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_JOB: 'qualify',
    GITHUB_SHA: sha,
    GITHUB_EVENT_PATH: event,
    KURO_RELEASE_CONFIG: config,
    RUNNER_OS: 'macOS',
    RUNNER_ARCH: 'ARM64',
  };
  const invoke = (environment) => spawnSync(worker, ['-c', `"${hook}"; /usr/bin/touch "${marker}"`], {
    env: environment,
    encoding: 'utf8',
  });

  const allowed = invoke(allowedEnvironment);
  assert.equal(allowed.status, 0, `exact pinned dispatch must be accepted: ${allowed.stderr}`);
  assert.equal((await readFile(marker)).length, 0, 'allowed parent must continue');
  await rm(marker);
  const manual = spawnSync(process.execPath, [guard], { env: { ...allowedEnvironment, GITHUB_EVENT_NAME: 'pull_request' }, encoding: 'utf8' });
  assert.equal(manual.status, 70, 'manual guard invocation must refuse to signal an unrelated parent');
  assert.match(manual.stderr, /refused to signal/);
  for (const [name, value] of [
    ['GITHUB_EVENT_NAME', 'pull_request'],
    ['GITHUB_REPOSITORY', 'contributor/kuro'],
    ['GITHUB_WORKFLOW_REF', 'aldoapicella/kuro/.github/workflows/evil.yml@refs/heads/main'],
    ['GITHUB_REF', 'refs/pull/7/merge'],
    ['GITHUB_ACTOR', 'contributor'],
    ['GITHUB_TRIGGERING_ACTOR', 'contributor'],
    ['GITHUB_JOB', 'attacker-job'],
    ['GITHUB_SHA', 'b'.repeat(40)],
    ['KURO_RELEASE_CONFIG', '/tmp/attacker.json'],
  ]) {
    const result = invoke({ ...allowedEnvironment, [name]: value });
    assert.notEqual(result.status, 0, `${name} mismatch must be denied`);
    assert.match(result.stderr, new RegExp(name));
    await assert.rejects(readFile(marker), { code: 'ENOENT' }, `${name} denial must terminate the parent before it continues`);
  }

  await writeFile(event, `${JSON.stringify({ inputs: { source_sha: 'b'.repeat(40), version: releasePolicy.version } })}\n`, { mode: 0o600 });
  assert.notEqual(invoke(allowedEnvironment).status, 0, 'source input mismatch must be denied');
  await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'source denial must terminate the parent');
  await writeFile(event, `${JSON.stringify({ inputs: { source_sha: sha, version: '0.1.0-preview.2' } })}\n`, { mode: 0o600 });
  assert.notEqual(invoke(allowedEnvironment).status, 0, 'version input mismatch must be denied');
  await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'version denial must terminate the parent');
  await writeFile(event, `${JSON.stringify({ inputs: { source_sha: sha, version: releasePolicy.version } })}\n`, { mode: 0o600 });

  await writeFile(config, Buffer.alloc(configBytes.length, 0x78), { mode: 0o600 });
  assert.notEqual(invoke(allowedEnvironment).status, 0, 'same-length release configuration replacement must be denied');
  await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'configuration denial must terminate the parent');
  await writeFile(config, configBytes, { mode: 0o644 });
  await chmod(config, 0o644);
  assert.notEqual(invoke(allowedEnvironment).status, 0, 'non-private release configuration must be denied');
  await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'mode denial must terminate the parent');
  await chmod(config, 0o600);
  await chmod(policy, 0o644);
  assert.notEqual(invoke(allowedEnvironment).status, 0, 'non-private policy must be denied');
  await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'policy denial must terminate the parent');

  console.log('release runner guard allow/deny checks passed');
} finally {
  await rm(directory, { recursive: true, force: true });
}
