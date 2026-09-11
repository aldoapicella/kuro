import { packager } from '@electron/packager';
import { access, readFile, readdir, realpath, symlink, unlink } from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleMacosNativeDependencies, writeUnsignedPreviewArchive } from './macos-native-deps.mjs';
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const stage = resolve(workspace, 'build/desktop');
await access(resolve(stage, 'host/main.js'));
const output = resolve(workspace, 'build/packages');
const packages = await packager({ dir: stage, name: 'KURO', executableName: 'kuro', electronVersion: '44.3.0', platform: process.platform, arch: process.arch, out: output, overwrite: true, asar: false, prune: false, derefSymlinks: false, afterCopy: [restoreRelativeLinks] });
let native = { bundled: 0, machO: 0, skipped: true };
let preview;
if (process.platform === 'darwin' && process.arch === 'arm64') {
  const app = join(packages[0], 'KURO.app');
  await access(app);
  native = await bundleMacosNativeDependencies(app);
  const manifest = JSON.parse(await readFile(resolve(workspace, 'apps/desktop/package.json'), 'utf8'));
  preview = await writeUnsignedPreviewArchive({ appPath: packages[0], outputDirectory: output, version: manifest.version });
}
console.log(JSON.stringify({ packages, native, preview }));

async function restoreRelativeLinks({ buildPath: appDirectory }) {
  // Packager 20 uses fs.cp without verbatimSymlinks, turning relative pnpm links
  // into absolute references to staging. Relocate every link before distribution.
  const sourceRoot = await realpath(stage);
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const destination = join(directory, entry.name);
      if (entry.isDirectory()) await visit(destination);
      else if (entry.isSymbolicLink()) {
        const source = join(sourceRoot, relative(appDirectory, destination));
        const target = await realpath(source);
        const targetPath = relative(sourceRoot, target);
        if (isAbsolute(targetPath) || targetPath === '..' || targetPath.startsWith('../') || targetPath.startsWith('..\\')) throw new Error('Dependency symlink escaped staging');
        await unlink(destination);
        await symlink(relative(dirname(destination), join(appDirectory, targetPath)), destination);
      }
    }
  }
  await visit(appDirectory);
}
