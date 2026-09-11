import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
let electron;
try { electron = require('electron'); }
catch { console.error('Install the pinned desktop runtime first: pnpm --filter @kuro/desktop exec install-electron'); process.exit(1); }
const child = spawn(electron, [resolve(workspace, 'build/desktop/host/main.js'), ...process.argv.slice(2)], { stdio: 'inherit', cwd: resolve(workspace, 'apps/desktop') });
child.on('error', () => { console.error('The Electron executable could not start.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
