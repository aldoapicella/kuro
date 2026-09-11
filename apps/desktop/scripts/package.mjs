import { packager } from '@electron/packager';
import { access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const stage = resolve(workspace, 'build/desktop');
await access(resolve(stage, 'host/main.js'));
console.log(await packager({ dir: stage, name: 'KURO', executableName: 'kuro', electronVersion: '44.3.0', platform: process.platform, arch: process.arch, out: resolve(workspace, 'build/packages'), overwrite: true, asar: false, prune: false, derefSymlinks: false }));
