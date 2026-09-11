import { mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = resolve(workspace, 'build/packages', `KURO-${process.platform}-${process.arch}`);
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'kuro-package-check-')));
const relocated = join(temporary, 'distribution');
let moved = false;
try {
  // Outside the repository, missing dependencies cannot resolve from its node_modules.
  await rename(source, relocated); moved = true;
  let links = 0;
  async function verifyLinks(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await verifyLinks(path);
      else if (entry.isSymbolicLink()) {
        const target = relative(relocated, await realpath(path));
        if (isAbsolute(target) || target === '..' || target.startsWith('../') || target.startsWith('..\\')) throw new Error('Packaged dependency escaped the distribution');
        links++;
      }
    }
  }
  await verifyLinks(relocated);
  const executable = process.platform === 'darwin' ? join(relocated, 'KURO.app/Contents/MacOS/kuro') : join(relocated, process.platform === 'win32' ? 'kuro.exe' : 'kuro');
  const args = process.argv.slice(2);
  const probe = args.length ? args : ['--probe=host'];
  const result = spawnSync(executable, probe, { cwd: temporary, encoding: 'utf8', timeout: 125_000, killSignal: 'SIGKILL' });
  if (result.status !== 0) throw new Error(`Packaged probe failed: ${result.error?.message ?? result.stderr}`);
  const report = result.stdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.electron);
  if (!report || (report.status !== 'passed' && !(report.foreignKeys && report.fts5 && report.reopen))) throw new Error('Packaged probe did not report success');
  console.log(JSON.stringify({ relocated: true, internalSymlinks: links, ...report }));
} finally {
  if (moved) await rename(relocated, source);
  await rm(temporary, { recursive: true, force: true });
}
