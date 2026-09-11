#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), 'expected-release.json');

function runnerWorkerPid() {
  const expectedWorker = realpathSync(join(dirname(POLICY_PATH), '..', 'bin', 'Runner.Worker'));
  let pid = process.ppid;
  for (let depth = 0; depth < 4 && Number.isSafeInteger(pid) && pid > 1; depth += 1) {
    const options = { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'] };
    const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], options).trim();
    try {
      if (realpathSync(command) === expectedWorker) return pid;
    } catch {
      // Continue toward the root only for an exact installed Runner.Worker match.
    }
    pid = Number(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid='], options).trim());
  }
  return null;
}

function deny(reason) {
  console.error(`KURO release runner denied the assigned job: ${reason}`);
  let workerPid;
  try {
    workerPid = runnerWorkerPid();
  } catch {
    workerPid = null;
  }
  if (workerPid === null) {
    console.error('KURO release runner refused to signal a process that is not its installed Runner.Worker ancestor.');
    process.exit(70);
  }
  try {
    process.kill(workerPid, 'SIGKILL');
  } catch {
    console.error('KURO release runner could not terminate its parent worker.');
    process.exit(70);
  }
  process.exitCode = 1;
}

function isPrivateRegularFile(stat) {
  return stat.isFile() && (stat.mode & 0o077) === 0 &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}

async function readPrivateFile(path, description) {
  const stat = await lstat(path);
  if (!isPrivateRegularFile(stat)) throw new Error(`${description} is not a private regular file owned by the runner user`);
  const resolved = await realpath(path);
  if (resolved !== path) throw new Error(`${description} must not be a symlink or aliased path`);
  return { bytes: await readFile(path), stat };
}

function requirePolicy(policy) {
  if (policy?.schemaVersion !== 1) throw new Error('unsupported policy schema');
  for (const key of ['repository', 'workflowRef', 'actor', 'eventName', 'job', 'ref', 'workflowSha', 'sourceSha', 'version']) {
    if (typeof policy[key] !== 'string' || policy[key].length === 0) throw new Error(`policy field ${key} is missing`);
  }
  if (!/^[0-9a-f]{40}$/.test(policy.workflowSha) || !/^[0-9a-f]{40}$/.test(policy.sourceSha)) {
    throw new Error('policy commit SHA is invalid');
  }
  const config = policy.releaseConfig;
  if (!config || !isAbsolute(config.path) || !/^[0-9a-f]{64}$/.test(config.sha256) || !Number.isSafeInteger(config.bytes) || config.bytes < 1) {
    throw new Error('policy release configuration identity is invalid');
  }
}

async function main() {
  const policyFile = await readPrivateFile(POLICY_PATH, 'policy');
  let policy;
  try {
    policy = JSON.parse(policyFile.bytes.toString('utf8'));
  } catch {
    throw new Error('policy JSON is invalid');
  }
  requirePolicy(policy);

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (typeof eventPath !== 'string' || !isAbsolute(eventPath)) throw new Error('environment field GITHUB_EVENT_PATH is invalid');
  let event;
  try {
    event = JSON.parse(await readFile(eventPath, 'utf8'));
  } catch {
    throw new Error('workflow event payload is invalid');
  }
  if (event?.inputs?.source_sha !== policy.sourceSha) throw new Error('workflow input source_sha does not match the private policy');
  if (event?.inputs?.version !== policy.version) throw new Error('workflow input version does not match the private policy');

  const expectedEnvironment = new Map([
    ['GITHUB_EVENT_NAME', policy.eventName],
    ['GITHUB_REPOSITORY', policy.repository],
    ['GITHUB_REPOSITORY_OWNER', policy.actor],
    ['GITHUB_WORKFLOW_REF', policy.workflowRef],
    ['GITHUB_ACTOR', policy.actor],
    ['GITHUB_TRIGGERING_ACTOR', policy.actor],
    ['GITHUB_REF', policy.ref],
    ['GITHUB_JOB', policy.job],
    ['GITHUB_SHA', policy.workflowSha],
    ['KURO_RELEASE_CONFIG', policy.releaseConfig.path],
    ['RUNNER_OS', 'macOS'],
    ['RUNNER_ARCH', 'ARM64'],
  ]);

  for (const [name, expected] of expectedEnvironment) {
    if (process.env[name] !== expected) throw new Error(`environment field ${name} does not match the private policy`);
  }

  const configFile = await readPrivateFile(policy.releaseConfig.path, 'release configuration');
  if (configFile.stat.size !== policy.releaseConfig.bytes) throw new Error('release configuration size changed');
  const digest = createHash('sha256').update(configFile.bytes).digest('hex');
  if (digest !== policy.releaseConfig.sha256) throw new Error('release configuration digest changed');

  console.log('KURO release runner accepted the pinned workflow dispatch.');
}

try {
  await main();
} catch (error) {
  deny(error instanceof Error ? error.message : 'guard failure');
}
