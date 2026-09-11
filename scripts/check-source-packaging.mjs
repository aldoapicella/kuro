import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const workspace = process.cwd();
const command = process.argv.slice(2);
if (command[0] === '--') command.shift();
if (!command.length) throw new Error('Usage: node scripts/check-source-packaging.mjs <command> [args...]');

async function manifests(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, 'package.json');
    try { await readFile(path); paths.push(path); } catch { /* Not a source package. */ }
  }
  return paths;
}

async function snapshot() {
  const paths = [
    join(workspace, 'package.json'), join(workspace, 'pnpm-lock.yaml'), join(workspace, 'pnpm-workspace.yaml'),
    ...await manifests(join(workspace, 'apps')), ...await manifests(join(workspace, 'packages')), ...await manifests(join(workspace, 'harnesses')),
  ].sort();
  return new Map(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
}

const before = await snapshot();
const result = spawnSync(command[0], command.slice(1), { cwd: workspace, stdio: 'inherit' });
const after = await snapshot();
const changed = [...before].filter(([path, digest]) => after.get(path) !== digest).map(([path]) => path);
if (changed.length) throw new Error(`Packaging changed source manifests or lockfiles: ${changed.map(path => resolve(path)).join(', ')}`);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Packaging source integrity passed (${before.size} manifests and lockfiles).`);
