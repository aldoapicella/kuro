import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify((file, args, options, callback) => {
  const child = spawn(file, args, options);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', callback);
  child.once('close', code => code === 0 ? callback(null) : callback(new Error(stderr || `child exited ${code}`)));
});

test('qualification routes both native probes through the module-scope phase runner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuro-offline-qualification-'));
  try {
    const bin = join(directory, 'bin'); await mkdir(bin);
    const ssh = join(bin, 'ssh');
    await writeFile(ssh, `#!/bin/sh
case "$*" in *--probe=*) case "$*" in *"/bin/sh -c "*) ;; *) exit 65 ;; esac ;; esac
case "$*" in
  *--probe=lifecycle*) printf '%s\\n' '{"status":"passed","probe":"lifecycle","nativeClock":true}' ;;
  *--probe=runtime*) if [ "$PROBE_FAILURE" = 1 ]; then printf '%s\\n' 'IDENTITY_UNAVAILABLE' >&2; exit 65; fi; printf '%s\\n' '{"status":"passed","probe":"runtime","storage":{"protection":"os-protected"}}' ;;
  *kern.bootsessionuuid*) printf '%s\\n' '11111111-1111-1111-1111-111111111111' ;;
  *sw_vers*) printf '%s\\n' 'ProductVersion: 26.5' 'BuildVersion: 25F71' 'Darwin 25.5.0 arm64' ;;
  *) exit 64 ;;
esac
`);
    await chmod(ssh, 0o700);
    const configuration = join(directory, 'configuration.json'), evidence = join(directory, 'evidence');
    const peer = {
      instance: 'guest', sshConfig: join(directory, 'ssh.config'), sshHost: 'guest', sudoCredentialPath: '/private/credential',
      guestValidationRoot: '/private/kuro', guestRunRoot: '/private/kuro/run', guestNodePath: '/private/kuro/node', guestNodeModulesPath: '/private/kuro/modules',
    };
    await writeFile(configuration, JSON.stringify({ limaHome: '/private/lima', owner: peer, requester: { ...peer, instance: 'other' } }));
    const entry = join(directory, 'exercise.mjs');
    await writeFile(entry, `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const config = JSON.parse(await readFile(${JSON.stringify(configuration)}, 'utf8'));
const { qualify, scpTransferArgs } = await import(${JSON.stringify(pathToFileURL(resolve('scripts/offline-gui.mjs')).href)});
const transferOptions = ['-F', config.owner.sshConfig, '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none'];
assert.deepEqual(scpTransferArgs(config.owner, 'to', '/host/input', '/private/kuro/run/guest-input'), [...transferOptions, '/host/input', 'guest:/private/kuro/run/guest-input']);
assert.deepEqual(scpTransferArgs(config.owner, 'from', '/host/output', '/private/kuro/run/guest-output'), [...transferOptions, 'guest:/private/kuro/run/guest-output', '/host/output']);
assert.throws(() => scpTransferArgs({ ...config.owner, sshHost: 'guest:other' }, 'to', '/host/input', '/private/kuro/run/guest-input'));
assert.throws(() => scpTransferArgs(config.owner, 'from', '/host/output', '/private/unrelated'));
if (process.env.PROBE_FAILURE) {
  await assert.rejects(() => qualify(config.owner), /guest.native-runtime failed/);
  assert.equal(await readFile(join(${JSON.stringify(evidence)}, 'phases', 'guest.native-runtime.txt'), 'utf8'), 'gui-session-unavailable\\n');
} else {
const native = await qualify(config.owner);
assert.equal(native.lifecycle.probe, 'lifecycle');
assert.equal(native.runtime.storage.protection, 'os-protected');
}
`);
    await run(process.execPath, [entry, '--configuration', configuration, '--archive', '/dev/null', '--source-sha', 'a'.repeat(40), '--version', '0.1.0-preview.1', '--evidence', evidence], {
      cwd: resolve('.'), env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    await run(process.execPath, [entry, '--configuration', configuration, '--archive', '/dev/null', '--source-sha', 'a'.repeat(40), '--version', '0.1.0-preview.1', '--evidence', evidence], {
      cwd: resolve('.'), env: { ...process.env, PROBE_FAILURE: '1', PATH: `${bin}:${process.env.PATH}` },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
