import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const APPLE_SYSTEM_PREFIXES = ['/System/Library/', '/usr/lib/'];
export const GITHUB_ASSET_LIMIT_BYTES = 2 * 1024 ** 3;

export function isAppleSystemLibrary(library) {
  return APPLE_SYSTEM_PREFIXES.some(prefix => library.startsWith(prefix));
}

export function parseOtoolLibraries(output) {
  return output.split('\n').slice(1).map(line => line.trim().match(/^(.*?) \(compatibility version /)?.[1]).filter(Boolean);
}

export function loaderReference(binary, target, bundleRoot) {
  if (bundleRoot && (!resolve(target).startsWith(`${resolve(bundleRoot)}/`) || !resolve(binary).startsWith(`${resolve(bundleRoot)}/`))) throw new Error(`Vendored library escaped bundle: ${target}`);
  const path = relative(dirname(binary), target);
  if (!path || isAbsolute(path)) throw new Error(`Vendored library escaped bundle: ${target}`);
  return `@loader_path/${path}`;
}

export function previewArchiveName(version, platform = process.platform, arch = process.arch) {
  return `KURO-${version}-${platform}-${arch}-unsigned-preview.tar.gz`;
}

export function isActiveMacosArm64Asset(path) {
  return !path.includes('/prebuilds/') || path.includes('/prebuilds/darwin-arm64/');
}

export function isPotentialMachOPath(path) {
  return path.includes('/Contents/MacOS/') || path.includes('.framework/') || /\.(?:bare|dylib|node)$/.test(path);
}

export function adHocCodeSignArgs(path) {
  return ['--force', '--sign', '-', '--timestamp=none', path];
}

export function assertGitHubAssetSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes >= GITHUB_ASSET_LIMIT_BYTES) throw new Error(`Unsigned preview archive must be smaller than GitHub's 2 GiB asset limit (${bytes} bytes)`);
}

function command(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.trim() || result.error?.message || 'unknown error'}`);
  return result.stdout;
}

async function toolPath(path, aliases) {
  // otool-classic reads a final parenthesized suffix as an architecture selector.
  // Electron helper app names contain parentheses, so inspect through a safe alias.
  if (!path.includes('(')) return path;
  const alias = join(aliases.directory, `macho-${aliases.count++}`);
  await symlink(resolve(path), alias);
  return alias;
}

async function otoolLibraries(path, aliases) {
  return parseOtoolLibraries(command('otool', ['-L', await toolPath(path, aliases)]));
}

async function otoolId(path, aliases) {
  const result = spawnSync('otool', ['-D', await toolPath(path, aliases)], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  return result.stdout.split('\n').slice(1).map(line => line.trim()).find(Boolean);
}

async function isMachO(path) {
  const result = spawnSync('file', ['-b', path], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.includes('Mach-O');
}

async function collectMachO(root) {
  const paths = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && isPotentialMachOPath(path) && isActiveMacosArm64Asset(path) && await isMachO(path)) paths.push(path);
    }
  }
  await visit(root);
  return paths;
}

async function sourceLicense(source) {
  let directory = dirname(source);
  for (let depth = 0; depth < 5; depth++, directory = dirname(directory)) {
    for (const name of ['LICENSE.txt', 'LICENSE', 'COPYING']) {
      const candidate = join(directory, name);
      try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* Continue upward. */ }
    }
  }
  throw new Error(`Redistributable library has no nearby license: ${source}`);
}

/**
 * Copy every non-Apple absolute Mach-O dependency into the app, rewrite all of
 * its consumers to relative loader paths, and fail if any external absolute
 * dependency remains. This runs only after Electron Packager copies staging,
 * so source packages, manifests and pnpm's content store remain untouched.
 */
export async function bundleMacosNativeDependencies(appPath) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return { bundled: 0, machO: 0, skipped: true };
  const contents = join(appPath, 'Contents');
  const nativeRoot = join(contents, 'Frameworks', 'KURONative');
  const licenseRoot = join(contents, 'Resources', 'licenses');
  await mkdir(nativeRoot, { recursive: true });
  await mkdir(licenseRoot, { recursive: true });
  const aliases = { directory: await mkdtemp(join(tmpdir(), 'kuro-macho-')), count: 0 };

  try {
    const machO = await collectMachO(contents);
    const queue = [...machO];
    const vendored = new Map();
    const copiedLicenses = new Set();
    const modified = new Set();
    for (let index = 0; index < queue.length; index++) {
      const binary = queue[index];
      const self = await otoolId(binary, aliases);
      for (const library of await otoolLibraries(binary, aliases)) {
        if (!isAbsolute(library) || isAppleSystemLibrary(library) || library === self) continue;
        let resolved;
        try { resolved = await realpath(library); } catch { throw new Error(`Unbundled external Mach-O dependency: ${library} referenced by ${binary}`); }
        let target = vendored.get(library) ?? vendored.get(resolved);
        if (!target) {
          target = join(nativeRoot, basename(resolved));
          const existing = [...vendored.entries()].find(([, destination]) => destination === target)?.[0];
          if (existing && await realpath(existing) !== resolved) throw new Error(`Vendored dylib basename collision: ${library}`);
          await copyFile(resolved, target);
          const license = await sourceLicense(resolved);
          const licenseTarget = join(licenseRoot, `${basename(resolved)}.LICENSE.txt`);
          if (!copiedLicenses.has(licenseTarget)) await copyFile(license, licenseTarget);
          copiedLicenses.add(licenseTarget);
          queue.push(target);
          modified.add(target);
        }
        vendored.set(library, target);
        vendored.set(resolved, target);
      }
    }

    for (const binary of queue) {
      const self = await otoolId(binary, aliases);
      for (const library of await otoolLibraries(binary, aliases)) {
        if (!isAbsolute(library) || isAppleSystemLibrary(library) || library === self) continue;
        const target = vendored.get(library) ?? vendored.get(await realpath(library));
        if (!target) throw new Error(`Unbundled external Mach-O dependency: ${library} referenced by ${binary}`);
        command('install_name_tool', ['-change', library, loaderReference(binary, target, contents), binary]);
        modified.add(binary);
      }
      if (binary.startsWith(nativeRoot + '/')) {
        command('install_name_tool', ['-id', `@loader_path/${basename(binary)}`, binary]);
        modified.add(binary);
      }
    }

    for (const binary of modified) command('codesign', adHocCodeSignArgs(binary));
    // The preview is ad-hoc signed so macOS accepts its rewritten nested code.
    // This is not a Developer ID signature and does not notarize the app.
    command('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath]);

    const residual = [];
    for (const binary of queue) {
      const self = await otoolId(binary, aliases);
      for (const library of await otoolLibraries(binary, aliases)) {
        if (isAbsolute(library) && !isAppleSystemLibrary(library) && library !== self) residual.push(`${binary}: ${library}`);
      }
    }
    if (residual.length) throw new Error(`Unbundled external Mach-O dependencies remain:\n${residual.join('\n')}`);
    return { bundled: new Set(vendored.values()).size, machO: queue.length, signed: modified.size, skipped: false };
  } finally {
    await rm(aliases.directory, { recursive: true, force: true });
  }
}

export async function writeUnsignedPreviewArchive({ appPath, outputDirectory, version }) {
  const archive = resolve(outputDirectory, previewArchiveName(version));
  command('tar', ['-C', dirname(appPath), '-czf', archive, basename(appPath)]);
  const digest = createHash('sha256');
  let bytes = 0;
  assertGitHubAssetSize((await stat(archive)).size);
  for await (const chunk of createReadStream(archive)) {
    bytes += chunk.length;
    assertGitHubAssetSize(bytes);
    digest.update(chunk);
  }
  const sha256 = digest.digest('hex');
  const checksum = `${archive}.sha256`;
  await writeFile(checksum, `${sha256}  ${basename(archive)}\n`, { encoding: 'utf8', flag: 'w' });
  return { archive, checksum, sha256, bytes };
}
