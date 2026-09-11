import { spawn } from 'node:child_process';
import { open, mkdir, mkdtemp, readFile, writeFile, stat, realpath, rm, cp, readdir } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSourceSha, assertVersion, previewArchiveName, REQUIRED_QUALIFICATION_CHECKS, QUALIFIED_RUNNER, sha256, validateRelease, validateOfflineQualification } from './release-validate.mjs';

// This runner produces evidence by executing the final archive. It has no skip,
// simulated-inference, or externally supplied passing-report escape hatch.
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = name => { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`); return process.argv[index + 1]; };
const version = option('--version'), sourceSha = option('--source-sha'), reportPath = resolve(option('--report'));
assertVersion(version); assertSourceSha(sourceSha);
const evidenceDirectory = join(dirname(reportPath), 'release-evidence');
await mkdir(evidenceDirectory, { recursive: true });
const report = { version, sourceSha, runner: { ...QUALIFIED_RUNNER }, artifact: null, checks: [], unmetGates: [...REQUIRED_QUALIFICATION_CHECKS] };
const archive = join(workspace, 'build/packages', previewArchiveName(version));
let temporary;

async function command(name, executable, args, { env = process.env, timeoutMs = 600_000, cwd = workspace } = {}) {
  console.log(`Qualification: ${name}`);
  const path = join(evidenceDirectory, `${name}.log`), output = await open(path, 'w', 0o600);
  try {
    await new Promise((accept, reject) => {
      const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', output.fd, output.fd] });
      const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      const timer = setTimeout(() => { kill(); reject(new Error(`${name} timed out`)); }, timeoutMs);
      const sizeCheck = setInterval(() => { void output.stat().then(info => { if (info.size > 20 * 1024 * 1024) { kill(); reject(new Error(`${name} exceeded its diagnostic limit`)); } }).catch(reject); }, 1000);
      const finish = () => { clearTimeout(timer); clearInterval(sizeCheck); };
      child.once('error', error => { finish(); reject(error); });
      child.once('close', (code, signal) => { finish(); code === 0 ? accept() : reject(new Error(`${name} failed (${code ?? signal}); see ${path}`)); });
    });
  } finally { await output.close(); }
  return path;
}
async function passed(name, paths) {
  const evidence = [];
  for (const path of paths) evidence.push({ path: relative(dirname(reportPath), path), sha256: await sha256(path), bytes: (await stat(path)).size });
  report.checks.push({ name, status: 'passed', evidence });
  report.unmetGates = report.unmetGates.filter(item => item !== name);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
async function files(directory, suffix) {
  const paths = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) paths.push(...await files(path, suffix));
    else if (item.isFile() && item.name.endsWith(suffix)) paths.push(path);
  }
  return paths;
}

try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || release() !== QUALIFIED_RUNNER.darwinRelease) throw new Error('A qualified macOS arm64 runner is required');
  const buildLog = await command('platform', '/usr/bin/sw_vers', ['-buildVersion']);
  if ((await readFile(buildLog, 'utf8')).trim() !== QUALIFIED_RUNNER.macOSBuild) throw new Error('The native clock has not been qualified on this macOS build');
  const headLog = await command('source-head', 'git', ['rev-parse', 'HEAD']);
  if ((await readFile(headLog, 'utf8')).trim() !== sourceSha) throw new Error('Qualification checkout is not the requested source SHA');
  const cleanLog = await command('source-clean', 'git', ['status', '--porcelain']);
  if ((await readFile(cleanLog, 'utf8')).trim()) throw new Error('Release source must be clean before qualification');
  if (!process.env.KURO_RELEASE_CONFIG) throw new Error('Set KURO_RELEASE_CONFIG to the private qualified-runner configuration described in releases.md');
  const configuration = JSON.parse(await readFile(process.env.KURO_RELEASE_CONFIG, 'utf8'));
  for (const key of ['embeddingFile', 'summaryFile', 'offlineConfiguration']) if (typeof configuration[key] !== 'string' || !configuration[key].startsWith('/')) throw new Error(`Runner configuration needs absolute ${key}`);
  for (const key of ['embeddingFile', 'summaryFile', 'offlineConfiguration']) await stat(configuration[key]);
  const releaseMetadata = await validateRelease({ workspace, version, sourceSha, artifactDirectory: dirname(archive) });
  report.artifact = releaseMetadata.artifact;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');

  const suite = [];
  suite.push(await command('typecheck', 'pnpm', ['typecheck']));
  suite.push(await command('source-tests', 'pnpm', ['test']));
  suite.push(await command('reference-tests', 'pnpm', ['test:reference']));
  suite.push(await command('qvac-worker', 'pnpm', ['--filter', '@kuro/ai', 'probe:runtime']));
  suite.push(await command('transport-harness', 'pnpm', ['--filter', '@kuro/transport-harness', 'smoke']));
  suite.push(await command('core-harness', 'pnpm', ['--filter', '@kuro/transport-harness', 'core-smoke']));
  suite.push(await command('release-helper-tests', process.execPath, ['--test', 'apps/desktop/test/macos-native-deps.test.mjs', 'scripts/release-validate.test.mjs', 'scripts/release-runner-guard.test.mjs', 'scripts/offline-gui-qualification.test.mjs']));
  await passed('source-suite', suite);

  temporary = await realpath(await mkdtemp(join(tmpdir(), 'kuro-qualified-release-')));
  await command('extract-final-archive', '/usr/bin/tar', ['-xzf', archive, '-C', temporary]);
  const app = join(temporary, 'KURO-darwin-arm64/KURO.app'), executable = join(app, 'Contents/MacOS/kuro');
  const native = [buildLog, await command('archive-signature', '/usr/bin/codesign', ['--verify', '--deep', '--strict', app])];
  const nativeEnv = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const probe of ['host', 'runtime', 'lifecycle']) {
    const path = await command(`relocated-${probe}`, executable, [`--probe=${probe}`, `--user-data-dir=${join(temporary, `probe-${probe}`)}`], { env: nativeEnv, cwd: temporary, timeoutMs: 150_000 });
    const result = (await readFile(path, 'utf8')).trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.electron);
    if (!result || (result.status !== 'passed' && !(result.foreignKeys && result.fts5 && result.reopen))) throw new Error(`Relocated ${probe} did not report success`);
    native.push(path);
  }
  await passed('native-qualification', native);

  const replacement = join(temporary, 'replacement/KURO.app'); await mkdir(dirname(replacement));
  await command('candidate-replacement', '/bin/cp', ['-cR', app, replacement]);
  await command('replacement-signature', '/usr/bin/codesign', ['--verify', '--deep', '--strict', replacement]);
  const guiJson = join(evidenceDirectory, 'gui-results.json');
  const guiLog = await command('packaged-real-gui', 'pnpm', ['exec', 'playwright', 'test', '--config=apps/desktop/playwright.config.ts', 'real.spec.ts', '--reporter=line,json'], {
    timeoutMs: 1_200_000,
    env: { ...process.env, KURO_REAL_GUI: '1', KURO_GUI_DOWNLOAD_MODELS: '1', KURO_GUI_EXECUTABLE: executable,
      KURO_GUI_REPLACEMENT_EXECUTABLE: join(replacement, 'Contents/MacOS/kuro'), KURO_GUI_EMBEDDING_FILE: configuration.embeddingFile,
      KURO_GUI_SUMMARY_FILE: configuration.summaryFile, PLAYWRIGHT_JSON_OUTPUT_NAME: guiJson },
  });
  const gui = JSON.parse(await readFile(guiJson, 'utf8'));
  if (gui.stats?.expected !== 3 || gui.stats?.unexpected || gui.stats?.flaky || gui.stats?.skipped) throw new Error('Every required real GUI test must pass without skipping or retries');
  const guiEvidence = join(evidenceDirectory, 'gui');
  await cp(join(workspace, 'build/desktop-ui-results'), guiEvidence, { recursive: true });
  const metricsPaths = await files(guiEvidence, 'metrics.json'), preparationPaths = await files(guiEvidence, 'model-preparation.json');
  if (metricsPaths.length !== 1 || preparationPaths.length !== 1) throw new Error('GUI workload and explicit download evidence are required');
  const metrics = JSON.parse(await readFile(metricsPaths[0], 'utf8'));
  if (!metrics.packaged || !(metrics.peakRssBytes > 0) || !metrics.candidateReplacement || metrics.priorSupportedRelease !== null) throw new Error('Packaged GUI resource and candidate-replacement evidence is missing');
  await passed('relocated-full-real-gui', [guiLog, guiJson, ...metricsPaths]);
  await passed('failure-boundaries', [suite[1], native.at(-1), ...metricsPaths]);
  await passed('clean-relocation-upgrade', [guiJson, ...metricsPaths]);
  await passed('model-preparation', [guiJson, ...preparationPaths]);

  // The offline runner must provision fresh peers inside qualified guests and
  // operate their GUI. It cannot consume a report supplied as an environment flag.
  const offlineLog = await command('offline-virtual-gui', process.execPath, ['scripts/offline-gui.mjs', '--configuration', configuration.offlineConfiguration,
    '--archive', archive, '--source-sha', sourceSha, '--version', version, '--evidence', join(evidenceDirectory, 'offline')], { timeoutMs: 1_800_000 });
  const offlineReportPath = join(evidenceDirectory, 'offline/result.json');
  const offline = JSON.parse(await readFile(offlineReportPath, 'utf8'));
  const packetCaptures = await files(join(evidenceDirectory, 'offline'), '.pcap');
  validateOfflineQualification(offline, { version, sourceSha, artifactSha256: report.artifact.sha256,
    captures: await Promise.all(packetCaptures.map(async path => ({ path: relative(join(evidenceDirectory, 'offline'), path), bytes: (await stat(path)).size }))),
  });
  await passed('offline-virtual-lan-egress-reconnect', [offlineLog, offlineReportPath, ...packetCaptures]);
  if (await sha256(archive) !== report.artifact.sha256 || (await stat(archive)).size !== report.artifact.bytes) throw new Error('The archive changed during qualification');
  await validateRelease({ workspace, version, sourceSha, artifactDirectory: dirname(archive), qualificationReport: reportPath });
  console.log(JSON.stringify({ status: 'passed', version, sourceSha, artifact: report.artifact }));
} catch (error) {
  report.failure = error instanceof Error ? error.message : 'Qualification failed';
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  throw error;
} finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
