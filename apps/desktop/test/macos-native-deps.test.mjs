import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertGitHubAssetSize, GITHUB_ASSET_LIMIT_BYTES, adHocCodeSignArgs, isActiveMacosArm64Asset, isAppleSystemLibrary, isPotentialMachOPath, loaderReference, parseOtoolLibraries, previewArchiveName, writeUnsignedPreviewArchive } from '../scripts/macos-native-deps.mjs';
import { sanitizeShippedManifest } from '../scripts/stage.mjs';

test('parses Mach-O dependency paths and retains spaces', () => {
  assert.deepEqual(parseOtoolLibraries('/tmp/example:\n\t/System/Library/Foo (compatibility version 1.0.0, current version 1.0.0)\n\t/opt/acme/lib with space.dylib (compatibility version 1.0.0, current version 1.0.0)\n'), ['/System/Library/Foo', '/opt/acme/lib with space.dylib']);
});

test('permits Apple system libraries and rejects non-system paths', () => {
  assert.equal(isAppleSystemLibrary('/usr/lib/libSystem.B.dylib'), true);
  assert.equal(isAppleSystemLibrary('/System/Library/Frameworks/Metal.framework/Metal'), true);
  assert.equal(isAppleSystemLibrary('/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib'), false);
});

test('uses a loader-relative reference confined to the app bundle', () => {
  const contents = '/tmp/KURO.app/Contents';
  assert.equal(loaderReference('/tmp/KURO.app/Contents/Resources/app/node_modules/native.node', '/tmp/KURO.app/Contents/Frameworks/KURONative/libssl.3.dylib', contents), '@loader_path/../../../Frameworks/KURONative/libssl.3.dylib');
  assert.throws(() => loaderReference('/tmp/KURO.app/Contents/MacOS/kuro', '/private/libssl.3.dylib', contents), /escaped bundle/);
});

test('labels unsigned previews with version platform and architecture', () => {
  assert.equal(previewArchiveName('0.1.0-preview.1', 'darwin', 'arm64'), 'KURO-0.1.0-preview.1-darwin-arm64-unsigned-preview.tar.gz');
});

test('audits only native prebuilds usable by the macOS arm64 runtime', () => {
  assert.equal(isActiveMacosArm64Asset('/bundle/node_modules/native/prebuilds/darwin-arm64/addon.node'), true);
  assert.equal(isActiveMacosArm64Asset('/bundle/node_modules/native/prebuilds/darwin-x64/addon.node'), false);
  assert.equal(isActiveMacosArm64Asset('/bundle/Contents/MacOS/kuro'), true);
});

test('only invokes file inspection for paths that can be Mach-O assets', () => {
  assert.equal(isPotentialMachOPath('/bundle/Contents/MacOS/kuro'), true);
  assert.equal(isPotentialMachOPath('/bundle/node_modules/addon.node'), true);
  assert.equal(isPotentialMachOPath('/bundle/Electron.framework/Versions/A/Electron'), true);
  assert.equal(isPotentialMachOPath('/bundle/node_modules/runtime/index.js'), false);
});

test('uses an ad-hoc, non-notarizing signature for rewritten code', () => {
  assert.deepEqual(adHocCodeSignArgs('/tmp/libssl.3.dylib'), ['--force', '--sign', '-', '--timestamp=none', '/tmp/libssl.3.dylib']);
});

test('removes only staged absolute development dependency references', () => {
  const manifest = sanitizeShippedManifest({ name: 'kuro', dependencies: { '@kuro/ai': '@kuro/ai@file:///Users/alice/kuro/packages/ai', '@kuro/contracts': 'file:/private/tmp/contracts', ajv: '8.20.0' }, devDependencies: { vitest: 'file:///private/tmp/vitest' } });
  assert.deepEqual(manifest, { name: 'kuro', dependencies: { ajv: '8.20.0' } });
  assert.throws(() => sanitizeShippedManifest({ name: 'bad', config: 'file:///private/tmp/config' }), /retains an absolute development/);
  assert.throws(() => sanitizeShippedManifest({ name: 'bad', dependencies: { '@kuro/ai': '@kuro/other@file:///private/tmp/other' } }), /retains an absolute development/);
});

test('enforces GitHub asset size below two GiB', () => {
  assert.doesNotThrow(() => assertGitHubAssetSize(GITHUB_ASSET_LIMIT_BYTES - 1));
  assert.throws(() => assertGitHubAssetSize(GITHUB_ASSET_LIMIT_BYTES), /smaller than GitHub/);
});

test('streams a preview checksum after creating a bounded archive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuro-preview-test-'));
  try {
    const appPath = join(directory, 'KURO.app');
    await mkdir(appPath);
    await writeFile(join(appPath, 'payload.txt'), 'synthetic archive payload');
    const preview = await writeUnsignedPreviewArchive({ appPath, outputDirectory: directory, version: '0.1.0-test' });
    assert.ok(preview.bytes > 0);
    assert.match(await readFile(preview.checksum, 'utf8'), new RegExp(`^${preview.sha256}  KURO-0\\.1\\.0-test-${process.platform}-${process.arch}-unsigned-preview\\.tar\\.gz\\n$`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
