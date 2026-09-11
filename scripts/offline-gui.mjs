#!/usr/bin/env node
/**
 * Host-side coordinator for the two-guest KURO GUI validation. Configuration is
 * deliberately private: it contains only local Lima/SSH paths and never product
 * state, passwords, or model bytes. Product actions are delegated to the guest
 * local Playwright driver through its NDJSON public-GUI contract.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, realpathSync } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const args = parseArgs(process.argv.slice(2));
for (const key of ['configuration', 'archive', 'source-sha', 'version', 'evidence']) if (!args[key]) throw new Error(`Missing --${key}`);
if (!/^[0-9a-f]{40}$/.test(args['source-sha'])) throw new Error('--source-sha must be a Git SHA');
const configuration = JSON.parse(await readFile(resolve(args.configuration), 'utf8'));
const archive = resolve(args.archive), evidence = resolve(args.evidence);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const driverSource = join(workspace, 'apps/desktop/ui/remote-driver.mjs');
const pfSource = join(workspace, 'scripts/offline-macos-guest-pf.sh');
const captureSource = join(workspace, 'scripts/offline-vlan-evidence.sh');
await access(archive); await mkdir(evidence, { recursive: true, mode: 0o700 });
await Promise.all([driverSource, pfSource, captureSource].map(path => access(path)));
const liveDrivers = new Set();
const unverifiedNativeProbeCleanup = new Set();
let capturesStarted = false;
const gatesInstalled = new Set();
const driverSha256 = await sha256(driverSource);
const pfSha256 = await sha256(pfSource), captureSha256 = await sha256(captureSource);

const result = {
  status: 'failed', sourceSha: args['source-sha'], version: args.version,
  artifactSha256: await sha256(archive), freshPeerStartup: false, reconnected: false,
  externalBlockedBefore: false, externalBlockedAfter: false,
  topology: 'two-qualified-macos-guests-on-isolated-virtual-lan',
  native: {}, management: {}, packets: {}, workflow: [], phases: [], testInfra: { driverSha256, pfSha256, captureSha256 }, cleanup: { verified: false }, error: null,
};
const save = async () => writeFile(join(evidence, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });

async function main() { try {
  await runPhase('configuration', () => validate(configuration));
  const archiveManifest = await runPhase('archive-manifest', () => manifestInArchive(archive));
  if (archiveManifest.sourceCommit !== args['source-sha']) throw new Error('Archive sourceCommit does not match --source-sha');
  if (archiveManifest.version !== args.version) throw new Error('Archive version does not match --version');
  const peers = new Map();
  for (const name of ['owner', 'requester']) {
    const peer = configuration[name];
    await runPhase(`${name}.provision`, () => provisionGuestArtifact(peer));
    await runPhase(`${name}.prepare`, () => prepareGuest(peer));
    await runPhase(`${name}.models`, () => provisionModels(peer));
    result.native[name] = await runPhase(`${name}.qualification`, () => qualify(peer));
    peers.set(name, new Driver(name, peer));
  }
  if (result.native.owner.bootSessionId === result.native.requester.bootSessionId) throw new Error('Owner and requester did not expose distinct live virtual-guest boot sessions');
  await runPhase('pf.install', () => Promise.all(['owner', 'requester'].map(installGate)));
  await runPhase('pf.verify-and-commit', () => Promise.all(['owner', 'requester'].map(verifyAndCommitGate)));
  await runPhase('egress.before', () => runEgressControls('before'));
  await runPhase('captures.start', () => startCaptures());
  for (const [name, driver] of peers) await runPhase(`${name}.driver-start`, () => driver.start());

  await runPhase('gui-scenario', () => runScenario(peers));
  await runPhase('egress.after', () => runEgressControls('after'));
  await runPhase('captures.stop', () => stopCaptures());
  await runPhase('packets.collect', () => collectPacketEvidence());
  if (!result.freshPeerStartup || !result.reconnected) throw new Error('Workflow did not prove fresh startup and reconnect');
  result.status = 'passed';
} catch (error) {
  // execFile errors embed their command line, which can contain private SSH
  // and credential-file paths.  Per-step logs are protected; public result
  // metadata intentionally records only this safe failure classification.
  result.error = 'Offline coordinator failed; inspect protected per-step evidence.';
} finally {
  const cleanup = [
    ...(capturesStarted ? await Promise.allSettled(['owner', 'requester'].map(stopCapture)) : []),
    ...(unverifiedNativeProbeCleanup.size ? [{ status: 'rejected', reason: new Error('Native probe cleanup was not verified.') }] : []),
    ...await Promise.allSettled([...drivers()].map(driver => driver.stop())),
    ...await Promise.allSettled([...gatesInstalled].map(removeGate)),
  ];
  if (cleanup.some(item => item.status === 'rejected')) {
    result.status = 'failed'; result.error = result.error ? 'Offline coordinator failed and guest cleanup did not complete.' : 'Offline guest cleanup did not complete.';
  } else {
    result.cleanup = { verified: true };
  }
  await save();
}

if (result.status !== 'passed') process.exitCode = 1;
}

async function runPhase(name, operation) {
  try {
    const value = await operation();
    result.phases.push({ name, status: 'passed' });
    return value;
  } catch (error) {
    const classification = classifyFailure(error);
    result.phases.push({ name, status: 'failed', classification });
    await mkdir(join(evidence, 'phases'), { recursive: true, mode: 0o700 });
    await writeFile(join(evidence, 'phases', `${name.replaceAll(/[^a-z0-9.-]/gi, '_')}.txt`), `${classification}\n`, { mode: 0o600 });
    throw new Error(`${name} failed`);
  }
}
function classifyFailure(error) {
  const message = [
    error instanceof Error ? error.message : '',
    typeof error?.stderr === 'string' ? error.stderr : '',
  ].join('\n');
  if (error?.code === 'ETIMEDOUT') return 'timeout';
  if (error?.code === 'ENOENT') return 'tool-unavailable';
  if (/User interaction is not allowed|IDENTITY_UNAVAILABLE/i.test(message)) return 'gui-session-unavailable';
  if (/not qualified|did not pass|does not match|did not expose/i.test(message)) return 'qualification-rejected';
  return 'command-failed';
}

function validate(config) {
  if (!config || typeof config !== 'object') throw new Error('Configuration must be an object');
  if (typeof config.limaHome !== 'string' || !isAbsolute(config.limaHome)) throw new Error('limaHome must be an absolute path');
  for (const name of ['owner', 'requester']) {
    const peer = config[name];
    for (const key of ['instance', 'sshConfig', 'sshHost', 'sudoCredentialPath', 'pcapPath', 'guestValidationRoot', 'guestRunRoot', 'guestNodePath', 'guestNodeModulesPath', 'driverDirectory', 'driverEvidenceDirectory', 'publicRecordDirectory', 'documentDirectory', 'peerIp', 'routerIp', 'managementIp', 'lanInterface']) if (typeof peer?.[key] !== 'string' || !peer[key]) throw new Error(`${name}.${key} is required`);
    if (!isSshAlias(peer.sshHost)) throw new Error(`${name}.sshHost must be a simple SSH alias`);
    if (peer.lanInterface === 'lo0') throw new Error(`${name}.lanInterface cannot be loopback`);
    for (const path of ['sshConfig', 'sudoCredentialPath', 'guestValidationRoot', 'guestRunRoot', 'guestNodePath', 'guestNodeModulesPath', 'driverDirectory', 'driverEvidenceDirectory', 'publicRecordDirectory', 'documentDirectory', 'pcapPath']) if (!isAbsolute(peer[path])) throw new Error(`${name}.${path} must be absolute`);
    for (const path of ['guestRunRoot', 'guestNodePath', 'guestNodeModulesPath', 'driverDirectory', 'driverEvidenceDirectory', 'publicRecordDirectory', 'documentDirectory', 'pcapPath']) if (!inside(peer.guestValidationRoot, peer[path])) throw new Error(`${name}.${path} must remain under guestValidationRoot`);
    for (const path of ['driverDirectory', 'driverEvidenceDirectory', 'publicRecordDirectory', 'documentDirectory', 'pcapPath']) if (!inside(peer.guestRunRoot, peer[path])) throw new Error(`${name}.${path} must remain under guestRunRoot`);
    for (const asset of ['embedding', 'summary']) {
      const model = peer.modelCache?.[asset];
      if (typeof model?.path !== 'string' || !/^[0-9a-f]{64}$/.test(model.sha256 ?? '') || !Number.isSafeInteger(model.bytes) || model.bytes <= 0) throw new Error(`${name}.modelCache.${asset} needs a pinned guest-private path, SHA-256, and size`);
      if (!inside(peer.guestValidationRoot, model.path)) throw new Error(`${name}.modelCache.${asset}.path must remain under guestValidationRoot`);
    }
  }
  if (config.owner.instance === config.requester.instance) throw new Error('Owner and requester must use distinct virtual guest instances');
  if (config.owner.peerIp === config.requester.peerIp) throw new Error('Virtual LAN peers need distinct guest IP addresses');
}
async function qualify(peer) {
  const lifecycleData = join(peer.guestRunRoot, 'native-lifecycle');
  const runtimeData = join(peer.guestRunRoot, 'native-runtime');
  const platform = await remote(peer, 'sw_vers; uname -srm');
  if (!/ProductVersion:\s*26\.5/.test(platform) || !/BuildVersion:\s*25F71/.test(platform) || !/Darwin 25\.5\.0 arm64/.test(platform)) throw new Error(`${peer.instance} is not qualified`);
  const lifecycleOutput = await runPhase(`${peer.instance}.native-lifecycle`, () => runNativeProbe(peer, 'lifecycle', lifecycleData));
  await saveProbeEvidence(peer, 'lifecycle', lifecycleOutput);
  const runtimeOutput = await runPhase(`${peer.instance}.native-runtime`, () => runNativeProbe(peer, 'runtime', runtimeData));
  await saveProbeEvidence(peer, 'runtime', runtimeOutput);
  const lifecycle = probeResult(lifecycleOutput, 'lifecycle');
  const runtime = probeResult(runtimeOutput, 'runtime');
  if (!lifecycle?.nativeClock || !runtime || runtime.storage?.protection !== 'os-protected') throw new Error(`${peer.instance} did not pass actual lifecycle/native-clock and runtime/os-keychain probes`);
  const bootSessionId = (await remote(peer, 'sysctl -n kern.bootsessionuuid')).trim();
  if (!bootSessionId) throw new Error(`${peer.instance} did not expose a live boot session identifier`);
  return { lifecycle, runtime, bootSessionId };
}
function probeResult(output, probe) {
  return output.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.status === 'passed' && value.probe === probe);
}
async function saveProbeEvidence(peer, probe, output) {
  const directory = join(evidence, 'probes');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, `${peer.instance}-${probe}.jsonl`), output, { mode: 0o600 });
}
async function provisionGuestArtifact(peer) {
  const root = shellQuote(peer.guestRunRoot), archivePath = guestArchivePath(peer), driverPath = guestDriverPath(peer), appManifest = shellQuote(join(guestAppPath(peer), 'Contents/Resources/app/package.json'));
  await assertGuestRunRoot(peer);
  await remote(peer, `rm -rf ${root} && test -x ${shellQuote(peer.guestNodePath)} && test -d ${shellQuote(peer.guestNodeModulesPath)} && mkdir -p ${root} ${shellQuote(dirname(driverPath))} && ln -s ${shellQuote(peer.guestNodeModulesPath)} ${shellQuote(join(dirname(driverPath), 'node_modules'))}`);
  await copyToGuest(peer, archive, archivePath);
  await copyToGuest(peer, driverSource, driverPath);
  await copyToGuest(peer, pfSource, guestPfPath(peer));
  await copyToGuest(peer, captureSource, guestCapturePath(peer));
  const manifest = 'KURO-darwin-arm64/KURO.app/Contents/Resources/app/package.json', quotedArchive = shellQuote(archivePath);
  const command = `shasum -a 256 ${quotedArchive}; printf '\\n---ARCHIVE---\\n'; tar -xOzf ${quotedArchive} ${shellQuote(manifest)}; tar -xzf ${quotedArchive} -C ${root}; codesign --verify --deep --strict ${shellQuote(guestAppPath(peer))}; printf '\\n---APP---\\n'; cat ${appManifest}; printf '\\n---DRIVER---\\n'; shasum -a 256 ${shellQuote(driverPath)} ${shellQuote(guestPfPath(peer))} ${shellQuote(guestCapturePath(peer))}`;
  const { stdout } = await execFile('ssh', [...sshArgs(peer), command], { maxBuffer: 1024 * 1024, timeout: 180_000 });
  const [hashLine, archiveAndApp] = stdout.split('\n---ARCHIVE---\n'), [archiveJson, appAndDriver] = archiveAndApp?.split('\n---APP---\n') ?? [], [appJson, driverLine] = appAndDriver?.split('\n---DRIVER---\n') ?? [];
  if (!hashLine?.startsWith(result.artifactSha256)) throw new Error(`${peer.instance} archive hash differs from --archive`);
  if (JSON.parse(archiveJson).sourceCommit !== args['source-sha'] || JSON.parse(appJson).sourceCommit !== args['source-sha']) throw new Error(`${peer.instance} derived app sourceCommit differs from --source-sha`);
  const [driverHash, pfHash, captureHash] = (driverLine ?? '').trim().split('\n');
  if (!driverHash?.startsWith(driverSha256) || !pfHash?.startsWith(pfSha256) || !captureHash?.startsWith(captureSha256)) throw new Error(`${peer.instance} guest test infrastructure differs from this checkout`);
}
async function runEgressControls(phase) {
  for (const [name, peer] of Object.entries({ owner: configuration.owner, requester: configuration.requester })) {
    const loopbackOutput = join(evidence, `${name}-loopback-${phase}.log`);
    try {
      await writeFile(loopbackOutput, await assertGuestLoopbackTcp(peer), { mode: 0o600 });
    } catch (error) {
      await writeFile(loopbackOutput, 'Guest loopback TCP control failed.\n', { mode: 0o600 });
      throw new Error(`${name} loopback TCP control failed ${phase} workflow`);
    }
    const command = `${shellQuote(guestPfPath(peer))} assert`;
    const output = join(evidence, `${name}-egress-${phase}.log`);
    try {
      await writeFile(output, await privileged(peer, command), { mode: 0o600 });
    } catch (error) {
      await writeFile(output, 'Guest egress assertion failed.\n', { mode: 0o600 });
      throw new Error(`${name} egress control failed ${phase} workflow`);
    }
  }
  if (phase === 'before') result.externalBlockedBefore = true;
  else result.externalBlockedAfter = true;
}
async function assertGuestLoopbackTcp(peer) {
  const script = `const net = require('node:net');
const sockets = new Set();
let client, finished = false;
const server = net.createServer(socket => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  socket.end();
});
const finish = (code, message) => {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  if (client) client.destroy();
  for (const socket of sockets) socket.destroy();
  if (server.listening) server.close(() => {});
  process.stdout.write(message + String.fromCharCode(10), () => process.exit(code));
};
const deadline = setTimeout(() => finish(1, 'loopback TCP timed out'), 3000);
server.once('error', () => finish(1, 'loopback TCP listener failed'));
server.listen({ host: '127.0.0.1', port: 0 }, () => {
  const address = server.address();
  if (!address || typeof address === 'string') return finish(1, 'loopback TCP listener address failed');
  client = net.createConnection({ host: '127.0.0.1', port: address.port });
  client.once('connect', () => finish(0, 'loopback TCP passed'));
  client.once('error', () => finish(1, 'loopback TCP connection failed'));
});`;
  return remote(peer, `${shellQuote(peer.guestNodePath)} -e ${shellQuote(script)}`);
}
async function installGate(name) {
  const peer = configuration[name], other = name === 'owner' ? configuration.requester.peerIp : configuration.owner.peerIp;
  const output = await privileged(peer, `${shellQuote(guestPfPath(peer))} install ${shellQuote(`${other},${peer.routerIp}`)} ${shellQuote(peer.managementIp)}`);
  await writeFile(join(evidence, `${name}-pf-install.log`), output, { mode: 0o600 });
  gatesInstalled.add(name);
}
async function verifyAndCommitGate(name) {
  const peer = configuration[name];
  const management = await verifyManagementTuple(peer);
  result.management[name] = management;
  await writeFile(join(evidence, `${name}-management.json`), `${JSON.stringify(management)}\n`, { mode: 0o600 });
  const output = await privileged(peer, `${shellQuote(guestPfPath(peer))} assert`);
  await writeFile(join(evidence, `${name}-pf-fresh-assert.log`), output, { mode: 0o600 });
  const committed = await privileged(peer, `${shellQuote(guestPfPath(peer))} commit`);
  await writeFile(join(evidence, `${name}-pf-commit.log`), committed, { mode: 0o600 });
}
async function verifyManagementTuple(peer) {
  const tuple = (await remote(peer, 'printf "%s" "$SSH_CONNECTION"')).trim().split(/\s+/);
  const [sourceIp, sourcePort, guestIp, guestPort] = tuple;
  if (tuple.length !== 4 || sourceIp !== peer.managementIp || guestIp !== peer.peerIp || guestPort !== '22' || !/^\d+$/.test(sourcePort) || Number(sourcePort) < 1024 || Number(sourcePort) > 65535) throw new Error(`${peer.instance} fresh SSH management tuple does not match configured virtual LAN control path`);
  return { sourceIp, sourcePort: Number(sourcePort), guestIp, guestPort: Number(guestPort) };
}
async function removeGate(name) {
  const peer = configuration[name];
  const output = await privileged(peer, `${shellQuote(guestPfPath(peer))} remove`);
  await writeFile(join(evidence, `${name}-pf-remove.log`), output, { mode: 0o600 });
  gatesInstalled.delete(name);
}
async function prepareGuest(peer) {
  const paths = [peer.driverDirectory, peer.driverEvidenceDirectory, peer.publicRecordDirectory, peer.documentDirectory];
  const command = `rm -rf ${paths.map(shellQuote).join(' ')} && mkdir -p ${paths.map(shellQuote).join(' ')}`;
  await assertGuestDestructiveTargets(peer, paths);
  await execFile('ssh', [...sshArgs(peer), command], { timeout: 60_000 });
}
async function provisionModels(peer) {
  const profile = peer.instance === configuration.owner.instance ? 'A' : 'B';
  const target = join(peer.driverDirectory, 'KURO', 'real', profile, 'models');
  const command = ['embedding', 'summary'].map(asset => {
    const model = peer.modelCache[asset], destination = join(target, `${asset}.gguf`), source = shellQuote(model.path);
    return `test "$(shasum -a 256 ${source} | awk '{print $1}')" = ${shellQuote(model.sha256)} && test "$(stat -f %z ${source})" = ${shellQuote(String(model.bytes))} && cp ${source} ${shellQuote(destination)} && test "$(shasum -a 256 ${shellQuote(destination)} | awk '{print $1}')" = ${shellQuote(model.sha256)} && test "$(stat -f %z ${shellQuote(destination)})" = ${shellQuote(String(model.bytes))}`;
  }).join(' && ');
  await remote(peer, `mkdir -p ${shellQuote(target)} && ${command}`);
}
function guestArchivePath(peer) { return join(peer.guestRunRoot, basename(archive)); }
function guestAppPath(peer) { return join(peer.guestRunRoot, 'KURO-darwin-arm64', 'KURO.app'); }
function guestDriverPath(peer) { return join(peer.guestRunRoot, 'testinfra', 'remote-driver.mjs'); }
function guestPfPath(peer) { return join(peer.guestRunRoot, 'testinfra', 'offline-macos-guest-pf.sh'); }
function guestCapturePath(peer) { return join(peer.guestRunRoot, 'testinfra', 'offline-vlan-evidence.sh'); }
function guestDriverCommand(peer, name) {
  const profile = name === 'owner' ? 'A' : 'B';
  return `${shellQuote(peer.guestNodePath)} ${shellQuote(guestDriverPath(peer))} --executable=${shellQuote(join(guestAppPath(peer), 'Contents/MacOS/kuro'))} --profile=${profile} --directory=${shellQuote(peer.driverDirectory)} --evidence=${shellQuote(peer.driverEvidenceDirectory)}`;
}
async function startCaptures() {
  capturesStarted = true;
  for (const [name, peer] of Object.entries({ owner: configuration.owner, requester: configuration.requester })) {
    const other = name === 'owner' ? configuration.requester.peerIp : configuration.owner.peerIp;
    const pidPath = join(peer.guestRunRoot, 'testinfra', 'capture.pid');
    const script = `nohup ${shellQuote(guestCapturePath(peer))} ${shellQuote(peer.lanInterface)} ${shellQuote(other)} ${shellQuote(peer.routerIp)} ${shellQuote(peer.pcapPath)} >/dev/null 2>&1 & echo $! >${shellQuote(pidPath)}`;
    const output = await privileged(peer, script);
    await writeFile(join(evidence, `${name}-capture-start.log`), output, { mode: 0o600 });
  }
}
async function stopCaptures() {
  await Promise.all(['owner', 'requester'].map(stopCapture));
  capturesStarted = false;
}
async function stopCapture(name) {
  const peer = configuration[name];
  const pidPath = join(peer.guestRunRoot, 'testinfra', 'capture.pid');
  const script = `test -s ${shellQuote(pidPath)}; pid=$(cat ${shellQuote(pidPath)}); case "$pid" in *[!0-9]*|'') exit 1;; esac; if kill -0 "$pid" 2>/dev/null; then ps -p "$pid" -o command= | grep -F tcpdump | grep -F ${shellQuote(peer.pcapPath)} >/dev/null; kill -INT "$pid"; for attempt in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done; ! kill -0 "$pid" 2>/dev/null; fi; test -s ${shellQuote(peer.pcapPath)}; chmod 644 ${shellQuote(peer.pcapPath)}; rm -f ${shellQuote(pidPath)}`;
  const output = await privileged(peer, script);
  await writeFile(join(evidence, `${name}-capture-stop.log`), output, { mode: 0o600 });
}
async function runScenario(peers) {
  const records = {}, values = {};
  const call = async (name, action, input = {}, { save, check } = {}) => {
    const driver = peers.get(name), response = await driver.call(action, await substitute(input, records, driver.peer, values));
    await collectScreenshot(name, action, response);
    result.workflow.push({ peer: name, action, result: publicResult(response) });
    if (save) {
      if (typeof response.path !== 'string' || !response.path.startsWith('/')) throw new Error(`${action} did not return an exported public path`);
      const destination = join(evidence, 'records', `${save}.json`);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFromGuest(driver.peer, response.path, destination);
      records[save] = { hostPath: destination, sourcePeer: driver.peer, sourcePath: response.path };
    }
    if (check) check(response);
    return response;
  };
  const ownerStart = await call('owner', 'start'), requesterStart = await call('requester', 'start');
  if (!ownerStart.protectedSetup || !requesterStart.protectedSetup) throw new Error('Fresh GUI peers did not show protected native setup');
  const ownerSetup = await call('owner', 'setup', setupInput('owner'), { check: response => requireEqual(response.runtime, 'running', 'owner setup') });
  const requesterSetup = await call('requester', 'setup', setupInput('requester'), { check: response => requireEqual(response.runtime, 'running', 'requester setup') });
  if (ownerSetup.freshPeerStartup !== true || requesterSetup.freshPeerStartup !== true) throw new Error('GUI setup did not prove fresh peers');
  result.freshPeerStartup = true;
  const ownerSpace = await call('owner', 'owner-create-space');
  values.spaceId = requirePublicId(ownerSpace.spaceId, 'spaceId');
  const invitation = await call('owner', 'export-invitation', { path: recordPath('owner', 'invitation') }, { save: 'invitation' });
  values.authorityKey = requireText(invitation.authorityKey, 'authorityKey');
  await call('requester', 'join', { invitationPath: '$record.invitation' });
  const enrollment = await call('requester', 'export-enrollment', { path: recordPath('requester', 'enrollment') }, { save: 'enrollment' });
  values.memberId = requirePublicId(enrollment.memberId, 'memberId'); values.peerKey = requireText(enrollment.peerKey, 'peerKey');
  await call('owner', 'enroll', { enrollmentPath: '$record.enrollment' });
  const ownerPermissions = await call('owner', 'owner-permissions', { requesterMemberId: '$value.memberId' });
  values.ownerId = requirePublicId(ownerPermissions.ownerId, 'ownerId');
  await call('requester', 'requester-permissions', { ownerId: '$value.ownerId' });
  const documents = await prepareDocuments();
  const indexed = await call('owner', 'import-and-index', { allowedPath: documents.allowed, restrictedPath: documents.restricted, otherNamespacePath: documents.other, requesterMemberId: '$value.memberId', spaceId: '$value.spaceId' });
  values.allowedDocumentId = requirePublicId(indexed.allowedId, 'allowedDocumentId');
  const question = 'What are the KURO pilot release conditions?', allowedText = documents.allowedText;
  await call('requester', 'question', { custodianKey: '$value.authorityKey', question });
  await call('requester', 'configure-faults', { dropAck: true }, { check: response => requireEqual(response.dropAck, true, 'ACK loss configuration') });
  const reviewInput = { spaceId: '$value.spaceId', question, recipientKey: '$value.peerKey', allowedText, allowedDocumentId: '$value.allowedDocumentId' };
  const reviewed = await call('owner', 'review-approve', reviewInput, { check: response => { requireEqual(response.approved, true, 'review approval'); requireEqual(response.recipientVerified, true, 'review recipient'); requirePresent(response.reviewRevision, 'review revision'); requirePresent(response.reviewedViewDigest, 'reviewed view digest'); requireCitation(response.citation, 'review'); } });
  const reviewedCitation = reviewed.citation;
  const evidenceInput = { allowedText, allowedDocumentId: '$value.allowedDocumentId' };
  const firstReceipt = await call('requester', 'evidence', { ...evidenceInput, minDroppedAcks: 2 }, { check: response => checkEvidence(response, 2) });
  requireCitationMatch(reviewedCitation, firstReceipt.citation, 'first requester evidence');
  const retryingOwner = await call('owner', 'delivery', { minApprovedSends: 2 }, { check: checkOwnerRetries });
  requireEqual(retryingOwner.delivery.approvals[0].view_digest, reviewed.reviewedViewDigest, 'saved approval view digest');
  compareOwnerApprovalToInbox(retryingOwner, firstReceipt);
  const restarted = await call('requester', 'restart', evidenceInput);
  if (restarted.reconnected !== true) throw new Error('Requester restart did not prove fresh reconnection and evidence reread');
  checkEvidence(restarted.evidence, 0);
  requireCitationMatch(reviewedCitation, restarted.evidence.citation, 'restarted requester evidence');
  result.reconnected = true;
  const ackedOwner = await call('owner', 'delivery', { requireAcked: true }, { check: checkOwnerAcked });
  compareOwnerApprovalToInbox(ackedOwner, restarted.evidence);
  const summary = await call('requester', 'summary', evidenceInput);
  requireCitationMatch(reviewedCitation, summary.citation, 'requester summary');
  await call('owner', 'revoke', { requesterKey: '$value.peerKey' });
}
function setupInput(name) {
  const owner = configuration.owner;
  return { displayName: `Offline ${name}`, bootstrapHost: owner.peerIp, bootstrapPort: 45981, localPort: name === 'owner' ? 45982 : 45983, host: name === 'owner', lanAddress: owner.peerIp };
}
function recordPath(name, record) { return join(configuration[name].publicRecordDirectory, `${record}.json`); }
async function prepareDocuments() {
  const owner = configuration.owner, local = join(evidence, 'synthetic-input'); await mkdir(local, { recursive: true, mode: 0o700 });
  const documents = { allowed: ['allowed.txt', 'KURO pilot release conditions are reviewed locally before approved evidence delivery.\n'], restricted: ['restricted.txt', 'KURO pilot release conditions for RESTRICTED-SENTINEL are not authorized for this requester.\n'], other: ['other-space/allowed.txt', 'KURO pilot release conditions for CROSS-SPACE-SENTINEL belong to another shared space.\n'] };
  const paths = {};
  for (const [key, [name, contents]] of Object.entries(documents)) {
    const hostPath = join(local, name); await mkdir(dirname(hostPath), { recursive: true, mode: 0o700 }); await writeFile(hostPath, contents, { mode: 0o600 });
    const guestPath = join(owner.documentDirectory, name); await remote(owner, `mkdir -p ${shellQuote(dirname(guestPath))}`); await copyToGuest(owner, hostPath, guestPath); paths[key] = guestPath;
  }
  return { ...paths, allowedText: documents.allowed[1].trim() };
}
async function collectScreenshot(peerName, action, response) {
  if (typeof response?.screenshot !== 'string' || !response.screenshot.startsWith('/')) return;
  const peer = configuration[peerName], destination = join(evidence, 'screenshots', `${String(result.workflow.length + 1).padStart(2, '0')}-${peerName}-${action}.png`);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await copyFromGuest(peer, response.screenshot, destination);
}
async function collectPacketEvidence() {
  for (const [name, peer] of Object.entries({ owner: configuration.owner, requester: configuration.requester })) {
    const destination = join(evidence, 'packets', `${name}.pcap`); await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await copyFromGuest(peer, peer.pcapPath, destination);
    if ((await stat(destination)).size <= 24) throw new Error(`${name} packet capture contains no packet records`);
    const other = name === 'owner' ? configuration.requester.peerIp : configuration.owner.peerIp;
    const route = await remote(peer, `route -n get ${shellQuote(other)}; printf '\n---INTERFACE---\n'; tcpdump -nn -r ${shellQuote(peer.pcapPath)}`);
    await writeFile(join(evidence, 'packets', `${name}-route-and-pcap.txt`), route, { mode: 0o600 });
    const endpoint = ip => `${escapeRegExp(ip)}\\.[0-9]+`;
    if (!route.includes(`interface: ${peer.lanInterface}`) || !route.includes(peer.peerIp) || !new RegExp(`IP (?:${endpoint(peer.peerIp)} > ${endpoint(other)}|${endpoint(other)} > ${endpoint(peer.peerIp)})`).test(route)) throw new Error(`${name} packet evidence does not prove a guest-to-guest UDP packet over ${peer.lanInterface}`);
    result.packets[name] = relative(evidence, destination);
  }
}
async function remote(peer, command) {
  const { stdout, stderr } = await execFile('ssh', [...sshArgs(peer), command], { maxBuffer: 4 * 1024 * 1024, timeout: 120_000 }); return `${stdout}${stderr}`;
}
async function guiSession(peer, command, timeout = 120_000, { cleanupMarker = null } = {}) {
  const { stdout, stderr } = await execFile('ssh', [...sshArgs(peer), guiSessionCommand(peer, command, cleanupMarker)], { maxBuffer: 4 * 1024 * 1024, timeout });
  return `${stdout}${stderr}`;
}
async function runNativeProbe(peer, probe, userDataDirectory, { executablePath = join(guestAppPath(peer), 'Contents/MacOS/kuro'), timeout = 180_000 } = {}) {
  if (!['lifecycle', 'runtime'].includes(probe)) throw new Error('Native probe is invalid');
  if (!isAbsolute(executablePath) || !isAbsolute(userDataDirectory)) throw new Error('Native probe executable and user-data paths must be absolute');
  if (!inside(peer.guestRunRoot, executablePath) || !inside(peer.guestRunRoot, userDataDirectory)) throw new Error('Native probe paths must remain under guestRunRoot');
  if (!Number.isSafeInteger(timeout) || timeout < 1_000) throw new Error('Native probe timeout is invalid');
  const helperCleanupMarker = `KURO_NATIVE_PROBE_HELPER_CLEANUP:${randomUUID()}`;
  const groupCleanupMarker = `KURO_NATIVE_PROBE_GROUP_CLEANUP:${randomUUID()}`;
  const cleanupMarkers = [helperCleanupMarker, groupCleanupMarker];
  unverifiedNativeProbeCleanup.add(helperCleanupMarker);
  const supervisor = nativeProbeSupervisorScript({ executablePath, probe, userDataDirectory, timeout, groupCleanupMarker });
  const command = `${shellQuote(peer.guestNodePath)} -e ${shellQuote(supervisor)}`;
  try {
    const output = await guiSession(peer, command, timeout + 10_000, { cleanupMarker: helperCleanupMarker });
    return verifiedNativeProbeOutput(output, cleanupMarkers);
  } catch (error) {
    const output = `${typeof error?.stdout === 'string' ? error.stdout : ''}${typeof error?.stderr === 'string' ? error.stderr : ''}`;
    if (hasCleanupMarkers(output, cleanupMarkers)) unverifiedNativeProbeCleanup.delete(helperCleanupMarker);
    throw error;
  }
}
function verifiedNativeProbeOutput(output, cleanupMarkers) {
  if (!hasCleanupMarkers(output, cleanupMarkers)) throw new Error('Native probe cleanup was not verified');
  unverifiedNativeProbeCleanup.delete(cleanupMarkers[0]);
  return output.split('\n').filter(line => !cleanupMarkers.includes(line)).join('\n');
}
function hasCleanupMarkers(output, cleanupMarkers) {
  const lines = new Set(output.split('\n'));
  return cleanupMarkers.every(marker => lines.has(marker));
}
function nativeProbeSupervisorScript({ executablePath, probe, userDataDirectory, timeout, groupCleanupMarker }) {
  const target = JSON.stringify({ executable: executablePath, args: [`--probe=${probe}`, `--user-data-dir=${userDataDirectory}`], timeout, groupCleanupMarker });
  return `const { spawn } = require('node:child_process');
const target = ${target};
let child, timer, finishing = false, groupCreated = false;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function groupExists() { try { process.kill(-child.pid, 0); return true; } catch (error) { if (error && error.code === 'ESRCH') return false; throw error; } }
async function stopGroup() {
  if (!child || !child.pid || !groupExists()) return true;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(-child.pid, signal); } catch (error) { if (!error || error.code !== 'ESRCH') throw error; }
    for (let attempt = 0; attempt < (signal === 'SIGTERM' ? 10 : 20); attempt += 1) { await pause(100); if (!groupExists()) return true; }
  }
  return !groupExists();
}
async function finish(code) {
  if (finishing) return;
  finishing = true; clearTimeout(timer);
  try {
    if (!groupCreated || !await stopGroup()) { process.exitCode = 70; return; }
    try { process.stdout.write(target.groupCleanupMarker + '\\n'); } catch { process.exitCode = 70; return; }
    process.exitCode = code;
  } catch { process.exitCode = 70; }
}
try {
  child = spawn(target.executable, target.args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  groupCreated = Boolean(child.pid);
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const fail = () => { void finish(70); };
  child.on('error', fail); child.stdout.on('error', fail); child.stderr.on('error', fail);
  process.stdout.on('error', fail); process.stderr.on('error', fail);
  child.once('exit', code => { void finish(code === 0 ? 0 : 1); });
  timer = setTimeout(() => { void finish(124); }, target.timeout);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => { void finish(143); });
} catch { void finish(70); }`;
}
function guiSessionCommand(peer, command, cleanupMarker = null) {
  const helperDirectory = shellQuote(dirname(guestDriverPath(peer)));
  const credential = shellQuote(peer.sudoCredentialPath);
  const content = `#!/bin/sh\nset -eu\nPATH=/usr/bin:/bin:/usr/sbin:/sbin\nexport PATH\ncredential=${credential}\ntest -f "$credential"\ntest ! -L "$credential"\nowner=$(stat -f %Su "$credential")\nmode=$(stat -f %Lp "$credential")\nsize=$(stat -f %z "$credential")\ntest "$owner" = "$(id -un)"\n{ test "$mode" = 400 || test "$mode" = 600; }\ntest "$size" -gt 0\ntest "$size" -le 128\nexec /bin/cat "$credential"\n`;
  const marker = cleanupMarker === null ? ':' : `printf '%s\n' ${shellQuote(cleanupMarker)}`;
  if (cleanupMarker !== null && !/^KURO_NATIVE_PROBE_HELPER_CLEANUP:[0-9a-f-]{36}$/.test(cleanupMarker)) throw new Error('Native probe cleanup marker is invalid');
  const wrapper = `set -eu; PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH; ssh_user=$(id -un); ssh_uid=$(id -u); test "$ssh_uid" -ne 0; console_user=$(stat -f %Su /dev/console); test "$console_user" = "$ssh_user"; console_uid=$(id -u "$console_user"); test "$console_uid" = "$ssh_uid"; helper_directory=${helperDirectory}; test -d "$helper_directory"; test ! -L "$helper_directory"; test "$(stat -f %Su "$helper_directory")" = "$ssh_user"; directory_mode=$(stat -f %Lp "$helper_directory"); case "$directory_mode" in *[!0-7]*|'') exit 1;; esac; test $((0$directory_mode & 022)) -eq 0; helper=$(umask 077; mktemp "$helper_directory/sudo-askpass.XXXXXX"); trap 'rm -f "$helper"' 0 HUP INT TERM; printf %s ${shellQuote(content)} > "$helper"; chmod 700 "$helper"; test -f "$helper"; test ! -L "$helper"; test "$(stat -f %Su "$helper")" = "$ssh_user"; test "$(stat -f %Lp "$helper")" = 700; target_status=0; set +e; SUDO_ASKPASS="$helper" /usr/bin/sudo -A -k /bin/launchctl asuser "$console_uid" /usr/bin/sudo -n -H -u "$ssh_user" /usr/bin/env PATH=/usr/bin:/bin:/usr/sbin:/sbin ${command}; target_status=$?; set -e; rm -f "$helper"; test ! -e "$helper"; test ! -L "$helper"; ${marker}; trap - 0 HUP INT TERM; exit "$target_status"`;
  return `/bin/sh -c ${shellQuote(wrapper)}`;
}
function sshConnectionOptions(peer) { return ['-F', peer.sshConfig, '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none']; }
function sshArgs(peer) { return [...sshConnectionOptions(peer), peer.sshHost]; }
async function privileged(peer, command) {
  const credential = shellQuote(peer.sudoCredentialPath);
  const validate = `owner=$(stat -f %Su ${credential}) mode=$(stat -f %Lp ${credential}); test "$owner" = "$(id -un)" && { test "$mode" = 400 || test "$mode" = 600; }`;
  return remote(peer, `if sudo -n true; then sudo -n sh -c ${shellQuote(command)}; else ${validate} && sudo -S -p '' sh -c ${shellQuote(command)} < ${credential}; fi`);
}
async function copyToGuest(peer, hostPath, guestPath) {
  await execFile('/usr/bin/scp', scpTransferArgs(peer, 'to', hostPath, guestPath), { timeout: 120_000 });
}
async function copyFromGuest(peer, guestPath, hostPath) {
  await execFile('/usr/bin/scp', scpTransferArgs(peer, 'from', hostPath, guestPath), { timeout: 120_000 });
}
function scpTransferArgs(peer, direction, hostPath, guestPath) {
  if (!isSshAlias(peer.sshHost)) throw new Error('Guest transfer requires a simple SSH alias');
  if (!isAbsolute(hostPath) || !isAbsolute(guestPath)) throw new Error('Guest transfer paths must be absolute');
  if (!inside(peer.guestRunRoot, guestPath)) throw new Error('Guest transfer path must remain under guestRunRoot');
  const endpoint = `${peer.sshHost}:${guestPath}`;
  if (direction === 'to') return [...sshConnectionOptions(peer), hostPath, endpoint];
  if (direction === 'from') return [...sshConnectionOptions(peer), endpoint, hostPath];
  throw new Error('Guest transfer direction is invalid');
}
async function substitute(value, records, destinationPeer, values) {
  if (typeof value === 'string' && value.startsWith('$record.')) {
    const record = records[value.slice('$record.'.length)];
    if (!record) throw new Error(`Missing exported record ${value}`);
    if (record.sourcePeer === destinationPeer) return record.sourcePath;
    const guestPath = join(destinationPeer.publicRecordDirectory, basename(record.hostPath));
    await copyToGuest(destinationPeer, record.hostPath, guestPath);
    return guestPath;
  }
  if (typeof value === 'string' && value.startsWith('$value.')) {
    const resolved = values[value.slice('$value.'.length)];
    if (typeof resolved !== 'string' || !resolved) throw new Error(`Missing GUI runtime value ${value}`);
    return resolved;
  }
  if (Array.isArray(value)) return Promise.all(value.map(item => substitute(item, records, destinationPeer, values)));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await substitute(item, records, destinationPeer, values)])));
  return value;
}
function publicResult(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(publicResult);
  const result = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'path' && key !== 'screenshot').map(([key, item]) => [key, publicResult(item)]));
  return typeof value.path === 'string' ? { ...result, exported: true } : result;
}
function* drivers() { yield* liveDrivers; }
class Driver {
  constructor(name, peer) { this.name = name; this.peer = peer; this.pending = new Map(); this.child = null; this.fatal = null; this.stopping = false; }
  async start() {
    this.child = spawn('ssh', [...sshArgs(this.peer), guiSessionCommand(this.peer, guestDriverCommand(this.peer, this.name))], { stdio: ['pipe', 'pipe', 'pipe'] });
    liveDrivers.add(this);
    const fail = error => this.fail(error);
    this.child.on('error', fail);
    this.child.stdin.on('error', fail);
    this.child.stdout.on('error', fail);
    let buffer = '';
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const next = buffer.indexOf('\n'); if (next < 0) break;
        const line = buffer.slice(0, next); buffer = buffer.slice(next + 1);
        if (!line.startsWith('KURO_GUI_RESULT:')) continue;
        let message;
        try { message = JSON.parse(line.slice('KURO_GUI_RESULT:'.length)); } catch (error) { fail(error); return; }
        const pending = this.pending.get(message.id); if (!pending) continue;
        this.pending.delete(message.id); message.ok ? pending.resolve(message.result) : pending.reject(new Error(`${this.name}: ${message.error ?? 'driver error'}`));
      }
    });
    this.child.on('close', () => { if (!this.stopping) fail(new Error(`${this.name} driver SSH exited unexpectedly`)); });
    const stderr = createWriteStream(join(evidence, `${this.name}-driver.stderr.log`), { flags: 'a', mode: 0o600 });
    stderr.on('error', fail); this.child.stderr.pipe(stderr);
    await new Promise((resolve, reject) => { this.child.once('spawn', resolve); this.child.once('error', reject); });
  }
  call(action, input, timeoutMs = 180_000) {
    if (this.fatal) return Promise.reject(this.fatal);
    if (!this.child || this.child.exitCode !== null || !this.child.stdin.writable) return Promise.reject(new Error(`${this.name} driver is not running`));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name}:${action} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      try { this.child.stdin.write(`${JSON.stringify({ id, action, input })}\n`); } catch (error) { this.fail(error); }
    });
  }
  fail(error) {
    if (this.fatal) return;
    this.fatal = error instanceof Error ? error : new Error(`${this.name} driver failed`);
    for (const pending of this.pending.values()) pending.reject(this.fatal);
    this.pending.clear();
  }
  async stop() {
    const child = this.child; if (!child) { liveDrivers.delete(this); return; }
    if (child.exitCode !== null) {
      await assertDriverStopped(this.peer, this.name);
      liveDrivers.delete(this);
      return;
    }
    this.stopping = true;
    try { await this.call('stop', {}, 30_000); } catch { /* continue with verified SSH shutdown */ }
    child.stdin.end();
    if (!await waitForChildClose(child, 10_000)) {
      child.kill('SIGTERM');
      if (!await waitForChildClose(child, 10_000)) {
        child.kill('SIGKILL');
        if (!await waitForChildClose(child, 5_000)) throw new Error(`${this.name} driver SSH process did not exit during cleanup`);
      }
    }
    await assertDriverStopped(this.peer, this.name);
    liveDrivers.delete(this);
  }
}
function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise(resolve => { const timer = setTimeout(() => resolve(false), timeoutMs); child.once('close', () => { clearTimeout(timer); resolve(true); }); });
}
async function assertDriverStopped(peer, name) {
  const profile = name === 'owner' ? 'A' : 'B';
  const app = join(guestAppPath(peer), 'Contents/MacOS/kuro');
  const userData = join(peer.driverDirectory, 'KURO', 'real', profile);
  const driverPattern = `node .*${escapeRegExp(guestDriverPath(peer))}`;
  const appPattern = `${escapeRegExp(app)}.*${escapeRegExp(`--profile=${profile}`)}.*${escapeRegExp(`--user-data-dir=${userData}`)}`;
  const command = `for pattern in ${shellQuote(driverPattern)} ${shellQuote(appPattern)}; do for pid in $(pgrep -f "$pattern" || true); do [ "$pid" = "$$" ] || exit 1; done; done`;
  await remote(peer, command);
}
function isDirectEntry() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isDirectEntry()) await main();
export { guiSessionCommand, nativeProbeSupervisorScript, qualify, runNativeProbe, scpTransferArgs };
async function sha256(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
async function manifestInArchive(path) {
  const manifest = 'KURO-darwin-arm64/KURO.app/Contents/Resources/app/package.json';
  const { stdout } = await execFile('tar', ['-xOzf', path, manifest], { maxBuffer: 1024 * 1024, timeout: 120_000 });
  return JSON.parse(stdout);
}
async function assertGuestRunRoot(peer) {
  const root = shellQuote(peer.guestRunRoot), base = shellQuote(peer.guestValidationRoot), parent = shellQuote(dirname(peer.guestRunRoot));
  await remote(peer, `set -eu; test ! -L ${root}; base_real=$(cd ${base} && pwd -P); parent_real=$(cd ${parent} && pwd -P); case "$parent_real/" in "$base_real/"*) ;; *) exit 1;; esac`);
}
async function assertGuestDestructiveTargets(peer, targets) {
  await assertGuestRunRoot(peer);
  const root = shellQuote(peer.guestRunRoot), quotedTargets = targets.map(shellQuote).join(' ');
  await remote(peer, `set -eu; run_real=$(cd ${root} && pwd -P); set -- ${quotedTargets}; for target; do test ! -L "$target"; parent_real=$(cd "$(dirname "$target")" && pwd -P); case "$parent_real/" in "$run_real/"*) ;; *) exit 1;; esac; done`);
}
function isSshAlias(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value); }
function inside(root, candidate) {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false;
  const safeRoot = posix.normalize(root), safeCandidate = posix.normalize(candidate);
  return safeRoot !== '/' && safeCandidate.startsWith(`${safeRoot}/`);
}
function requireText(value, label) { if (typeof value !== 'string' || !value) throw new Error(`GUI did not return ${label}`); return value; }
function requirePublicId(value, label) { const text = requireText(value, label); if (!/^[a-f0-9]{32}$/.test(text)) throw new Error(`GUI returned invalid ${label}`); return text; }
function requireEqual(actual, expected, label) { if (actual !== expected) throw new Error(`${label} did not return ${String(expected)}`); }
function requirePresent(value, label) { if (value === null || value === undefined || value === '') throw new Error(`GUI did not return ${label}`); return value; }
function requireCitation(value, label) {
  if (!value || typeof value.quote !== 'string' || !value.quote || !value.reference || typeof value.reference !== 'object') throw new Error(`${label} did not return a literal citation`);
  return value;
}
function requireCitationMatch(expected, actual, label) {
  const citation = requireCitation(actual, label);
  if (citation.quote !== expected.quote || JSON.stringify(citation.reference) !== JSON.stringify(expected.reference)) throw new Error(`${label} did not retain the approved literal citation`);
}
function checkEvidence(response, minimumDroppedAcks) {
  const delivery = response?.delivery, observed = response?.observations;
  if (!delivery || !Array.isArray(delivery.inbox) || !Array.isArray(delivery.approvals) || !Array.isArray(delivery.outbox)) throw new Error('Evidence did not return read-only delivery records');
  if (delivery.inbox.length !== 1 || observed?.modelLoads !== 0 || observed?.inference !== 0 || observed?.droppedAcks < minimumDroppedAcks) throw new Error('Requester evidence was not exact, model-free, and observed through the required ACK-loss boundary');
}
function checkOwnerRetries(response) {
  const delivery = response?.delivery, approved = response?.observations?.approved;
  if (!delivery || !Array.isArray(delivery.approvals) || delivery.approvals.length !== 1 || !Array.isArray(approved) || approved.length < 2 || new Set(approved.map(item => item.bytes)).size !== 1) throw new Error('Owner did not retain one approval and send identical approved bytes through the lost-ACK retry');
}
function checkOwnerAcked(response) {
  if (!response?.delivery?.outbox?.some(row => row.state === 'ACKED')) throw new Error('Owner outbox did not become ACKED after requester reconnect');
}
function compareOwnerApprovalToInbox(owner, requester) {
  const approval = owner?.delivery?.approvals?.[0], inbox = requester?.delivery?.inbox?.[0];
  if (!approval || !inbox || approval.digest !== inbox.digest || approval.bytes !== inbox.bytes) throw new Error('Owner approval bytes/digest do not exactly match requester inbox');
}
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const equals = value.indexOf('='), key = equals < 0 ? value.slice(2) : value.slice(2, equals), inline = equals < 0 ? undefined : value.slice(equals + 1);
    const next = inline ?? values[++index];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
    parsed[key] = next;
  }
  return parsed;
}
function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
