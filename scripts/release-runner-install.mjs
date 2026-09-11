#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const VERSION = '2.337.0';
const ARCHIVE = `actions-runner-osx-arm64-${VERSION}.tar.gz`;
const ARCHIVE_SHA256 = '5a2cd92908a93d7276a194e1de6008099f3e7946f3f8e14aa7a1a7b4a31fdec2';
const DOWNLOAD = `https://github.com/actions/runner/releases/download/v${VERSION}/${ARCHIVE}`;
const DEFAULT_ROOT = join(homedir(), '.local', 'share', 'kuro-validation', 'actions-runner');
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${basename(command)} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  return result.stdout;
}

function parseRoot() {
  const index = process.argv.indexOf('--root');
  if (index === -1) return DEFAULT_ROOT;
  if (!process.argv[index + 1] || process.argv.length !== 4) throw new Error('usage: node scripts/release-runner-install.mjs [--root ABSOLUTE_PATH]');
  return resolve(process.argv[index + 1]);
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('the qualified runner requires macOS arm64');
  const root = parseRoot();
  if (root !== DEFAULT_ROOT && !root.startsWith(`${homedir()}/`)) throw new Error('runner root must be a private path below the current home directory');
  try {
    await lstat(root);
    throw new Error(`refusing to replace existing runner root ${root}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const staging = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'kuro-actions-runner-')));
  const stagedRoot = join(staging, 'root');
  const archivePath = join(staging, ARCHIVE);
  try {
    await mkdir(stagedRoot, { mode: 0o700 });
    run('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--tlsv1.2', '--silent', '--show-error', '--output', archivePath, DOWNLOAD]);
    if (await sha256(archivePath) !== ARCHIVE_SHA256) throw new Error('official runner archive SHA-256 mismatch');

    const members = run('/usr/bin/tar', ['-tzf', archivePath]).split('\n').filter(Boolean);
    if (members.length === 0 || members.some((member) => member.startsWith('/') || member.split('/').includes('..'))) {
      throw new Error('runner archive contains an unsafe member path');
    }
    run('/usr/bin/tar', ['-xzf', archivePath, '-C', stagedRoot]);
    const installedFiles = ['config.sh', 'run.sh', join('bin', 'Runner.Listener'), join('bin', 'Runner.Worker'), join('externals', 'node24', 'bin', 'node')];
    for (const required of installedFiles) {
      const stat = await lstat(join(stagedRoot, required));
      if (!stat.isFile()) throw new Error(`runner archive is missing ${required}`);
    }

    const hookDirectory = join(stagedRoot, 'hooks');
    await mkdir(hookDirectory, { mode: 0o700 });
    const guardPath = join(hookDirectory, 'guard.mjs');
    await cp(join(SCRIPT_DIR, 'release-runner-guard.mjs'), guardPath);
    await chmod(guardPath, 0o500);
    const hookPath = join(hookDirectory, 'job-started.sh');
    await cp(join(SCRIPT_DIR, 'release-runner-job-started.sh'), hookPath);
    await chmod(hookPath, 0o500);

    const manifest = {
      schemaVersion: 1,
      runnerVersion: VERSION,
      archive: ARCHIVE,
      archiveSha256: ARCHIVE_SHA256,
      download: DOWNLOAD,
      guardSha256: await sha256(guardPath),
      hookSha256: await sha256(hookPath),
      installedFileSha256: Object.fromEntries(await Promise.all(installedFiles.map(async (path) => [path, await sha256(join(stagedRoot, path))]))),
    };
    await writeFile(join(stagedRoot, 'kuro-install-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
    await chmod(stagedRoot, 0o700);
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    await rename(stagedRoot, root);
    console.log(`Prepared verified GitHub Actions runner v${VERSION} at ${root}.`);
    console.log('The runner is not configured, registered, or running.');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

await main();
