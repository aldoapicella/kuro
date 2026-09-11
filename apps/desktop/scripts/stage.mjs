import { cp, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
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
  delete manifest.devDependencies; delete manifest.scripts;
  await replaceManifest(manifestPath, manifest);
}

async function replaceManifest(path, manifest) {
  // pnpm deploy may hard-link workspace files. Replace the staged inode instead
  // of changing bytes shared with the source package or content store.
  const temporary = path + '.desktop-stage';
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, path);
}
