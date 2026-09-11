import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Build the native barrier beside the bundled Electron host chunks. Linux and
 * other platforms intentionally stage no addon; the TypeScript loader closes
 * protected operations with CLOCK_UNCERTAIN there. */
export async function buildNativeClock(workspace, output) {
  if (process.platform !== 'darwin') return { built: false, reason: 'unsupported-platform' };
  if (!['arm64', 'x64'].includes(process.arch)) return { built: false, reason: 'unsupported-architecture' };

  const host = resolve(output, 'host');
  const source = resolve(workspace, 'apps/desktop/native/clock.c');
  const headers = resolve(workspace, 'apps/desktop/node_modules/node-api-headers/include');
  const target = resolve(host, 'clock.node');
  await mkdir(host, { recursive: true });
  const compiler = spawnSync('xcrun', ['--sdk', 'macosx', '--find', 'clang'], { cwd: workspace, encoding: 'utf8' });
  if (compiler.status !== 0) throw new Error(`Native clock compiler unavailable: ${compiler.stderr.trim()}`);
  const clang = compiler.stdout.trim();
  if (!clang) throw new Error('Native clock compiler path was empty');
  const sdk = spawnSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { cwd: workspace, encoding: 'utf8' });
  if (sdk.status !== 0 || !sdk.stdout.trim()) throw new Error(`Native clock SDK unavailable: ${sdk.stderr.trim()}`);
  const architecture = process.arch === 'x64' ? 'x86_64' : 'arm64';
  const build = spawnSync(clang, [
    '-arch', architecture, '-isysroot', sdk.stdout.trim(), '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
    '-DNAPI_VERSION=8', '-I', headers, '-bundle', '-undefined', 'dynamic_lookup',
    source, '-o', target,
  ], { cwd: workspace, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`Native clock build failed: ${build.stderr.trim()}`);
  return { built: true, target };
}
