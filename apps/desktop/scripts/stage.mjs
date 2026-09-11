import { cp, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';

/** Stage the same installed packages for development and distribution. Keep native
 * dependencies adjacent to their package; never bundle SDK asset resolution. */
export async function stageDesktop(workspace, output) {
  const deploy = spawnSync('pnpm', ['--filter', '@kuro/desktop', '--config.inject-workspace-packages=true', 'deploy', '--prod', output], {
    cwd: workspace, stdio: 'inherit', shell: process.platform === 'win32',
  });
  // pnpm 11 records deploy's production profile in the source workspace cache.
  // Restore the normal development profile through pnpm itself, with the lock frozen.
  const restore = spawnSync('pnpm', ['install', '--frozen-lockfile', '--prod=false'], {
    cwd: workspace, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (deploy.status !== 0) throw new Error('Production dependency staging failed');
  if (restore.status !== 0) throw new Error('Workspace development profile restore failed');
  const root = await realpath(output);
  for (const name of ['contracts', 'core', 'ai', 'transport']) {
    const directory = await realpath(join(output, 'node_modules', '@kuro', name));
    const within = relative(root, directory);
    if (within.startsWith('..') || resolve(root, within) !== directory) throw new Error('Workspace package escaped staging');
    await cp(join(workspace, 'dist/packages', name, 'src'), join(directory, 'compiled'), { recursive: true });
    const manifestPath = join(directory, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.exports = Object.fromEntries(Object.entries(manifest.exports).map(([key, value]) => {
      if (typeof value !== 'string' || !value.endsWith('.ts')) throw new Error('Unsupported workspace export');
      return [key, value.replace('./src/', './compiled/').slice(0, -3) + '.js'];
    }));
    await replaceManifest(manifestPath, manifest);
    if (name === 'transport') {
      await mkdir(join(directory, 'dist'), { recursive: true });
      await unlink(join(directory, 'dist/bare-worker.mjs')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await cp(join(workspace, 'packages/transport/dist/bare-worker.mjs'), join(directory, 'dist/bare-worker.mjs'));
    }
  }
  const manifestPath = join(output, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.main = 'host/main.js'; manifest.name = 'kuro'; manifest.productName = 'KURO';
  manifest.sourceCommit = sourceCommit(workspace);
  delete manifest.devDependencies; delete manifest.scripts;
  await replaceManifest(manifestPath, manifest);
  await removeDevelopmentMetadata(output);
}

function sourceCommit(workspace) {
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' });
  if (status.status !== 0 || status.stdout.trim()) return null;
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: workspace, encoding: 'utf8' });
  return head.status === 0 ? head.stdout.trim() : null;
}

export function isAbsoluteDevelopmentDependency(name, value) {
  return typeof value === 'string' && (value.startsWith('file:/') || value.startsWith(`${name}@file:/`));
}

export function sanitizeShippedManifest(manifest) {
  delete manifest.devDependencies;
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!manifest[field]) continue;
    for (const [name, value] of Object.entries(manifest[field])) {
      if (isAbsoluteDevelopmentDependency(name, value)) delete manifest[field][name];
    }
  }
  if (JSON.stringify(manifest).match(/file:\//)) throw new Error(`Staged manifest retains an absolute development file reference: ${manifest.name ?? 'unknown package'}`);
  return manifest;
}

async function removeDevelopmentMetadata(output) {
  const manifests = [join(output, 'package.json'), ...['contracts', 'core', 'ai', 'transport'].map(name => join(output, 'node_modules', '@kuro', name, 'package.json'))];
  for (const path of manifests) {
    const manifest = sanitizeShippedManifest(JSON.parse(await readFile(path, 'utf8')));
    await replaceManifest(path, manifest);
  }
  const directories = [output];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (entry.name === 'pnpm-lock.yaml' || entry.name === 'package-lock.json' || entry.name === 'yarn.lock') await rm(path);
    }
  }
}

async function replaceManifest(path, manifest) {
  // pnpm deploy may hard-link workspace files. Replace the staged inode instead
  // of changing bytes shared with the source package or content store.
  const temporary = path + '.desktop-stage';
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, path);
}
