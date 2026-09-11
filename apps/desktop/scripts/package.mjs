import packager from '@electron/packager';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const temporary = await mkdtemp(join(tmpdir(), 'kuro-package-'));
const stage = join(temporary, 'app');
try {
  const deploy = spawnSync('pnpm', ['--filter', '@kuro/desktop', 'deploy', '--legacy', '--prod', stage], { cwd: workspace, stdio: 'inherit', shell: process.platform === 'win32' });
  if (deploy.status !== 0) throw new Error('Production dependency staging failed');
  await cp(resolve(workspace, 'build/desktop'), stage, { recursive: true });
  const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
  manifest.main = 'host/main.js'; manifest.name = 'kuro'; manifest.productName = 'KURO';
  delete manifest.devDependencies; delete manifest.scripts;
  await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
  console.log(await packager({ dir: stage, name: 'KURO', executableName: 'kuro', electronVersion: '44.3.0', platform: process.platform, arch: process.arch, out: resolve(workspace, 'build/packages'), overwrite: true, asar: false, prune: false }));
} finally { await rm(temporary, { recursive: true, force: true }); }
