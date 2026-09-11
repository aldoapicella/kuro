#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const REPOSITORY = 'aldoapicella/kuro';
const OWNER = 'aldoapicella';
const LABEL = 'kuro-qualified-macos-arm64';
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/release.yml@refs/heads/main`;
const RUNNER_ROOT = join(homedir(), '.local', 'share', 'kuro-validation', 'actions-runner');
const EXPECTED_RUNNER_VERSION = '2.337.0';
const EXPECTED_ARCHIVE_SHA256 = '5a2cd92908a93d7276a194e1de6008099f3e7946f3f8e14aa7a1a7b4a31fdec2';
const GH = '/opt/homebrew/bin/gh';

function usage() {
  return 'usage: node scripts/release-runner-start.mjs --source-sha SHA --version VERSION --config ABSOLUTE_PATH';
}

function parseArguments() {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!['--source-sha', '--version', '--config'].includes(name) || !value || values.has(name)) throw new Error(usage());
    values.set(name, value);
  }
  if (values.size !== 3) throw new Error(usage());
  const sourceSha = values.get('--source-sha');
  const version = values.get('--version');
  const configPath = resolve(values.get('--config'));
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('source SHA must be exactly 40 lowercase hexadecimal characters');
  if (!/^\d+\.\d+\.\d+-preview\.\d+$/.test(version)) throw new Error('version must use the N.N.N-preview.N form');
  if (configPath !== values.get('--config')) throw new Error('release configuration path must be absolute and normalized');
  return { sourceSha, version, configPath };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${basename(command)} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  return result.stdout.trim();
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function verifyPrivateFile(path, description) {
  const stat = await lstat(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error(`${description} must be a private regular file owned by the runner user`);
  }
  if (await realpath(path) !== path) throw new Error(`${description} must not be a symlink or aliased path`);
  return stat;
}

async function verifyInstall() {
  const rootStat = await lstat(RUNNER_ROOT);
  if (!rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && rootStat.uid !== process.getuid())) {
    throw new Error('runner root must be a private directory owned by the runner user');
  }
  if (await realpath(RUNNER_ROOT) !== RUNNER_ROOT) throw new Error('runner root must not be a symlink or aliased path');
  const manifestPath = join(RUNNER_ROOT, 'kuro-install-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.runnerVersion !== EXPECTED_RUNNER_VERSION || manifest.archiveSha256 !== EXPECTED_ARCHIVE_SHA256) {
    throw new Error('runner install manifest does not match the pinned official build');
  }
  const guard = join(RUNNER_ROOT, 'hooks', 'guard.mjs');
  const hook = join(RUNNER_ROOT, 'hooks', 'job-started.sh');
  if (await sha256(guard) !== manifest.guardSha256 || await sha256(hook) !== manifest.hookSha256) {
    throw new Error('installed release guard changed after installation');
  }
  if (!manifest.installedFileSha256 || typeof manifest.installedFileSha256 !== 'object') throw new Error('runner install manifest lacks file identities');
  for (const [path, expected] of Object.entries(manifest.installedFileSha256)) {
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected) || await sha256(join(RUNNER_ROOT, path)) !== expected) {
      throw new Error(`installed runner file changed after installation: ${path}`);
    }
  }
  for (const credential of ['.runner', '.credentials', '.credentials_rsaparams']) {
    try {
      await lstat(join(RUNNER_ROOT, credential));
      throw new Error(`runner still has registration state in ${credential}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return hook;
}

function githubApi(args) {
  return run(GH, ['api', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', ...args]);
}

function registrationToken(endpoint) {
  const response = githubApi(['--method', 'POST', `repos/${REPOSITORY}/actions/runners/${endpoint}`]);
  const parsed = JSON.parse(response);
  if (typeof parsed.token !== 'string' || parsed.token.length < 20) throw new Error(`GitHub did not issue a ${endpoint}`);
  return parsed.token;
}

function runnerEnvironment() {
  const allowed = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];
  return {
    ...Object.fromEntries(allowed.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
    SHELL: '/bin/zsh',
  };
}

function findRegisteredRunner(runnerName) {
  try {
    const pages = JSON.parse(githubApi(['--paginate', '--slurp', `repos/${REPOSITORY}/actions/runners?per_page=100`]));
    const runners = Array.isArray(pages) ? pages.flatMap((page) => Array.isArray(page?.runners) ? page.runners : []) : [];
    return runners.find((runner) => runner?.name === runnerName) ?? null;
  } catch {
    return undefined;
  }
}

function confirmDeregistered(runnerName) {
  const registered = findRegisteredRunner(runnerName);
  if (registered === null) return true;
  if (!registered || !Number.isSafeInteger(registered.id)) return false;
  try {
    githubApi(['--method', 'DELETE', `repos/${REPOSITORY}/actions/runners/${registered.id}`]);
    return findRegisteredRunner(runnerName) === null;
  } catch {
    return false;
  }
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('the qualified runner requires macOS arm64');
  const { sourceSha, version, configPath } = parseArguments();
  const hookPath = await verifyInstall();
  const configStat = await verifyPrivateFile(configPath, 'release configuration');
  JSON.parse(await readFile(configPath, 'utf8'));

  const login = githubApi(['user', '--jq', '.login']);
  if (login !== OWNER) throw new Error(`GitHub CLI must be authenticated as ${OWNER}`);
  const mainSha = githubApi([`repos/${REPOSITORY}/commits/main`, '--jq', '.sha']);
  if (mainSha !== sourceSha) throw new Error('source SHA must equal the current GitHub main tip before the runner is exposed');

  const policy = {
    schemaVersion: 1,
    repository: REPOSITORY,
    workflowRef: WORKFLOW_REF,
    actor: OWNER,
    eventName: 'workflow_dispatch',
    job: 'qualify',
    ref: 'refs/heads/main',
    workflowSha: sourceSha,
    sourceSha,
    version,
    releaseConfig: {
      path: configPath,
      sha256: await sha256(configPath),
      bytes: configStat.size,
    },
  };
  const runnerName = `kuro-qualified-${sourceSha.slice(0, 12)}-${randomBytes(4).toString('hex')}`;
  if (findRegisteredRunner(runnerName) !== null) throw new Error('could not establish a unique absent runner name before registration');
  const workDirectory = `_work-${sourceSha.slice(0, 12)}`;
  const policyPath = join(RUNNER_ROOT, 'hooks', 'expected-release.json');
  const temporaryPolicy = `${policyPath}.${process.pid}.tmp`;
  const baseEnvironment = {
    ...runnerEnvironment(),
    ACTIONS_RUNNER_HOOK_JOB_STARTED: hookPath,
    KURO_RELEASE_CONFIG: configPath,
  };
  let registrationAttempted = false;
  try {
    await writeFile(temporaryPolicy, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporaryPolicy, policyPath);
    await chmod(policyPath, 0o600);
    const token = registrationToken('registration-token');
    const configurationEnvironment = {
      ...baseEnvironment,
      ACTIONS_RUNNER_INPUT_URL: `https://github.com/${REPOSITORY}`,
      ACTIONS_RUNNER_INPUT_TOKEN: token,
      ACTIONS_RUNNER_INPUT_NAME: runnerName,
      ACTIONS_RUNNER_INPUT_LABELS: LABEL,
      ACTIONS_RUNNER_INPUT_WORK: workDirectory,
    };
    registrationAttempted = true;
    const configuration = spawnSync(join(RUNNER_ROOT, 'config.sh'), ['--unattended', '--ephemeral', '--disableupdate'], {
      cwd: RUNNER_ROOT,
      env: configurationEnvironment,
      stdio: 'inherit',
    });
    if (configuration.status !== 0) throw new Error('ephemeral runner configuration failed');
    console.log(`Listening for exactly one pinned KURO release job as ${runnerName}.`);
    const runner = spawn(join(RUNNER_ROOT, 'run.sh'), [], { cwd: RUNNER_ROOT, env: baseEnvironment, stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => runner.kill(signal));
    const exitCode = await new Promise((resolveExit, reject) => {
      runner.once('error', reject);
      runner.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
    });
    if (exitCode !== 0) throw new Error(`runner exited with status ${exitCode}`);
  } finally {
    if (registrationAttempted && !confirmDeregistered(runnerName)) {
      console.error('Warning: automatic runner deregistration could not be confirmed; remove the exact offline runner in GitHub before retrying.');
    }
    await rm(temporaryPolicy, { force: true });
    await rm(policyPath, { force: true });
    await rm(join(RUNNER_ROOT, '_diag'), { recursive: true, force: true });
    await rm(join(RUNNER_ROOT, workDirectory), { recursive: true, force: true });
    for (const credential of ['.runner', '.credentials', '.credentials_rsaparams']) await rm(join(RUNNER_ROOT, credential), { force: true });
  }
}

await main();
