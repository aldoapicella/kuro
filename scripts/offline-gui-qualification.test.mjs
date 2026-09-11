import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
function runExit(file, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, options); let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => resolveRun({ code, stdout, stderr }));
  });
}
function runWithClosedStdout(file, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, options); let stderr = '';
    child.stdout.on('error', () => {}); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); setTimeout(() => child.stdout.destroy(), 100);
    child.once('close', code => resolveRun({ code, stderr }));
  });
}
async function waitFor(read, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { return await read(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolveWait => setTimeout(resolveWait, 25)); }
  }
}
function assertAbsent(pid) {
  assert.throws(() => process.kill(Number(pid), 0), error => error?.code === 'ESRCH');
}

test('native probe supervisor kills its probe group without touching an unrelated process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuro-offline-native-supervisor-'));
  let unrelated;
  try {
    const fixture = join(directory, 'ignore-term-probe');
    const data = join(directory, 'probe-data'); await mkdir(data);
    await writeFile(fixture, `#!/bin/sh
for argument in "$@"; do case "$argument" in --user-data-dir=*) data=${'${'}argument#*=}${'\n'};; esac; done
/bin/sh -c 'trap "" TERM HUP; while :; do /bin/sleep 1; done' &
child=$!
printf '%s\\n' "$$" > "$data/parent.pid"
printf '%s\\n' "$child" > "$data/child.pid"
trap '' TERM HUP
while :; do /bin/sleep 1; done
`);
    await chmod(fixture, 0o700);
    unrelated = spawn('/bin/sh', ['-c', 'trap "" TERM HUP; while :; do /bin/sleep 1; done'], { detached: true, stdio: 'ignore' });
    const configuration = join(directory, 'configuration.json'), renderer = join(directory, 'render.mjs'), supervisorPath = join(directory, 'supervisor.js');
    await writeFile(configuration, JSON.stringify({ limaHome: '/private/lima', owner: {}, requester: {} }));
    await writeFile(renderer, `import { writeFile } from 'node:fs/promises';
import { nativeProbeSupervisorScript } from ${JSON.stringify(pathToFileURL(resolve('scripts/offline-gui.mjs')).href)};
await writeFile(${JSON.stringify(supervisorPath)}, nativeProbeSupervisorScript({ executablePath: ${JSON.stringify(fixture)}, probe: 'runtime', userDataDirectory: ${JSON.stringify(data)}, timeout: 1000, groupCleanupMarker: 'KURO_NATIVE_PROBE_GROUP_CLEANUP:11111111-1111-1111-1111-111111111111' }));`);
    await run(process.execPath, [renderer, '--configuration', configuration, '--archive', '/dev/null', '--source-sha', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '--version', '0.1.0-preview.1', '--evidence', join(directory, 'evidence')], { cwd: directory });
    const supervisor = await readFile(supervisorPath, 'utf8');
    const result = await runExit(process.execPath, ['-e', supervisor], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result.code, 124, result.stderr || result.stdout);
    assert.match(result.stdout, /KURO_NATIVE_PROBE_GROUP_CLEANUP:/);
    const parentPid = await waitFor(() => readFile(join(data, 'parent.pid'), 'utf8'));
    const childPid = await waitFor(() => readFile(join(data, 'child.pid'), 'utf8'));
    await waitFor(() => { assertAbsent(parentPid.trim()); assertAbsent(childPid.trim()); });
    const epipeResult = await runWithClosedStdout(process.execPath, ['-e', supervisor], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(epipeResult.code, 124, epipeResult.stderr);
    await waitFor(async () => { assertAbsent((await readFile(join(data, 'parent.pid'), 'utf8')).trim()); assertAbsent((await readFile(join(data, 'child.pid'), 'utf8')).trim()); });
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  } finally {
    if (unrelated?.pid) { try { process.kill(-unrelated.pid, 'SIGKILL'); } catch {} }
    await rm(directory, { recursive: true, force: true });
  }
});

test('qualification routes both native probes through the GUI-session cleanup boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuro-offline-qualification-'));
  try {
    const bin = join(directory, 'bin'); await mkdir(bin);
    const ssh = join(bin, 'ssh');
    await writeFile(ssh, `#!/bin/sh
printf '%s\\n' "$*" >> "$SSH_LOG"
helper_marker=$(printf '%s\\n' "$*" | /usr/bin/grep -o 'KURO_NATIVE_PROBE_HELPER_CLEANUP:[0-9a-f-]*' | /usr/bin/head -1)
group_marker=$(printf '%s\\n' "$*" | /usr/bin/grep -o 'KURO_NATIVE_PROBE_GROUP_CLEANUP:[0-9a-f-]*' | /usr/bin/head -1)
emit_markers() { if [ "${'${'}PROBE_MARKER:-both}" = both ]; then printf '%s\\n%s\\n' "$group_marker" "$helper_marker"; elif [ "${'${'}PROBE_MARKER}" = helper ]; then printf '%s\\n' "$helper_marker"; elif [ "${'${'}PROBE_MARKER}" = group ]; then printf '%s\\n' "$group_marker"; elif [ "${'${'}PROBE_MARKER}" = prefix ]; then printf 'x%s\\nx%s\\n' "$group_marker" "$helper_marker"; elif [ "${'${'}PROBE_MARKER}" = suffix ]; then printf '%sx\\n%sx\\n' "$group_marker" "$helper_marker"; fi; }
case "$*" in
  *--probe=lifecycle*) printf '%s\\n' '{"status":"passed","probe":"lifecycle","nativeClock":true}'; emit_markers ;;
  *--probe=runtime*) if [ "${'${'}PROBE_FAILURE:-0}" = 1 ]; then printf '%s\\n' 'IDENTITY_UNAVAILABLE' >&2; emit_markers; exit 65; fi; printf '%s\\n' '{"status":"passed","probe":"runtime","storage":{"protection":"os-protected"}}'; emit_markers ;;
  *kern.bootsessionuuid*) printf '%s\\n' '11111111-1111-1111-1111-111111111111' ;;
  *sw_vers*) printf '%s\\n' 'ProductVersion: 26.5' 'BuildVersion: 25F71' 'Darwin 25.5.0 arm64' ;;
  *) exit 64 ;;
esac
`);
    await chmod(ssh, 0o700);
    const configuration = join(directory, 'configuration.json'), evidence = join(directory, 'evidence'), sshLog = join(directory, 'ssh.log');
    const peer = { instance: 'guest', sshConfig: join(directory, 'ssh.config'), sshHost: 'guest', sudoCredentialPath: '/private/credential', guestValidationRoot: '/private/kuro', guestRunRoot: '/private/kuro/run', guestNodePath: '/private/kuro/node', guestNodeModulesPath: '/private/kuro/modules' };
    await writeFile(configuration, JSON.stringify({ limaHome: '/private/lima', owner: peer, requester: { ...peer, instance: 'other' } }));
    const entry = join(directory, 'exercise.mjs');
    await writeFile(entry, `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const config = JSON.parse(await readFile(${JSON.stringify(configuration)}, 'utf8'));
const { qualify, runNativeProbe, scpTransferArgs } = await import(${JSON.stringify(pathToFileURL(resolve('scripts/offline-gui.mjs')).href)});
const transferOptions = ['-F', config.owner.sshConfig, '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none'];
assert.deepEqual(scpTransferArgs(config.owner, 'to', '/host/input', '/private/kuro/run/guest-input'), [...transferOptions, '/host/input', 'guest:/private/kuro/run/guest-input']);
assert.deepEqual(scpTransferArgs(config.owner, 'from', '/host/output', '/private/kuro/run/guest-output'), [...transferOptions, 'guest:/private/kuro/run/guest-output', '/host/output']);
assert.throws(() => scpTransferArgs({ ...config.owner, sshHost: 'guest:other' }, 'to', '/host/input', '/private/kuro/run/guest-input'));
assert.throws(() => scpTransferArgs(config.owner, 'from', '/host/output', '/private/unrelated'));
await assert.rejects(() => runNativeProbe(config.owner, 'invalid', '/private/kuro/run/data', { executablePath: '/private/kuro/run/probe' }), /invalid/);
await assert.rejects(() => runNativeProbe(config.owner, 'runtime', 'relative', { executablePath: '/private/kuro/run/probe' }), /absolute/);
if (process.env.PROBE_FAILURE) {
  await assert.rejects(() => qualify(config.owner), /guest.native-runtime failed/);
  assert.equal(await readFile(join(${JSON.stringify(evidence)}, 'phases', 'guest.native-runtime.txt'), 'utf8'), 'gui-session-unavailable\\n');
} else if (process.env.PROBE_MARKER && process.env.PROBE_MARKER !== 'both') {
  await assert.rejects(() => runNativeProbe(config.owner, 'runtime', '/private/kuro/run/data', { executablePath: '/private/kuro/run/probe', timeout: 1_000 }), /cleanup was not verified/);
} else {
  const native = await qualify(config.owner);
  assert.equal(native.lifecycle.probe, 'lifecycle');
  assert.equal(native.runtime.storage.protection, 'os-protected');
}
`);
    const baseEnv = { ...process.env, SSH_LOG: sshLog, PATH: `${bin}:${process.env.PATH}` };
    await run(process.execPath, [entry, '--configuration', configuration, '--archive', '/dev/null', '--source-sha', 'a'.repeat(40), '--version', '0.1.0-preview.1', '--evidence', evidence], { cwd: resolve('.'), env: baseEnv });
    const successLog = await readFile(sshLog, 'utf8');
    assert.equal(successLog.split('\n').filter(line => line.includes('--probe=')).length, 2);
    assert.match(successLog, /KURO_NATIVE_PROBE_HELPER_CLEANUP:/);
    assert.match(successLog, /KURO_NATIVE_PROBE_GROUP_CLEANUP:/);
    await writeFile(sshLog, '');
    await run(process.execPath, [entry, '--configuration', configuration, '--archive', '/dev/null', '--source-sha', 'a'.repeat(40), '--version', '0.1.0-preview.1', '--evidence', evidence], { cwd: resolve('.'), env: { ...baseEnv, PROBE_FAILURE: '1' } });
    for (const PROBE_MARKER of ['helper', 'group', 'malformed', 'prefix', 'suffix']) await run(process.execPath, [entry, '--configuration', configuration, '--archive', '/dev/null', '--source-sha', 'a'.repeat(40), '--version', '0.1.0-preview.1', '--evidence', evidence], { cwd: resolve('.'), env: { ...baseEnv, PROBE_MARKER } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
