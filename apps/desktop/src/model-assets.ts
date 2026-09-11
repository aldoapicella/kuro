import { createHash, randomBytes } from 'node:crypto';
import { constants, renameSync } from 'node:fs';
import { mkdir, open, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { KuroError } from '@kuro/contracts';
import type { DesktopModelKind, DesktopModelState } from '@kuro/contracts';

interface ModelAsset { kind: DesktopModelKind; name: string; bytes: number; sha256: string; url: string }
/** Exact @qvac/sdk / inference 0.19.0 registry artifacts; this file does not import or start QVAC. */
export const MODEL_ASSETS: readonly ModelAsset[] = Object.freeze([
  { kind: 'embedding', name: 'GTE_LARGE_FP16', bytes: 669603712,
    sha256: '939f1fb3fcc70f2a250a7e7ad7c2fbdc1397d46f9a8055d053e451829c5293fb',
    url: 'https://huggingface.co/ChristianAzinn/gte-large-gguf/resolve/f9fa5479908e72c2a8b9d6ba112911cd1e51be53/gte-large_fp16.gguf' },
  { kind: 'summary', name: 'QWEN3_1_7B_INST_Q4', bytes: 1056782912,
    sha256: 'c876f159707a4e4f70e045106c69db15bfc935a4981706fd4f65c6e7ea1e81c5',
    url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/d7f544eead698dbd1f15126ef60b45a1e1933222/Qwen3-1.7B-Q4_0.gguf' },
]);
type AssetErrorCode = NonNullable<DesktopModelState['error']>;
class AssetError extends Error { constructor(readonly code: AssetErrorCode) { super(code); } }
interface ModelAssetOptions {
  /** Synthetic descriptors and IO seams are supplied only by unit tests. */
  assets?: readonly ModelAsset[];
  fetch?: typeof fetch;
  freeDiskBytes?: () => Promise<number>;
}

/** Explicit weight transfer only. This is not an inference queue and never calls an AI port. */
export class ModelAssets {
  private readonly assets: readonly ModelAsset[];
  private readonly states = new Map<DesktopModelKind, DesktopModelState>();
  private active: { kind: DesktopModelKind; abort: AbortController; done: Promise<void> } | undefined;
  private readonly accessAbort = new AbortController();
  private closed = false;
  constructor(private readonly directory: string, private readonly options: ModelAssetOptions = {}) {
    this.assets = options.assets ?? MODEL_ASSETS;
    for (const asset of this.assets) this.states.set(asset.kind, { ...this.publicAsset(asset), state: 'missing', downloadedBytes: 0, error: null });
  }
  snapshot(): DesktopModelState[] { return structuredClone([...this.states.values()]); }
  async freeDiskBytes(): Promise<number> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.options.freeDiskBytes) return this.options.freeDiskBytes();
    const info = await statfs(this.directory);
    return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(info.bavail * info.bsize)));
  }
  async inspect(): Promise<void> {
    // Startup verifies existing cache bytes; it never downloads missing weights.
    for (const asset of this.assets) {
      if (this.closed) return;
      await this.begin(asset.kind, false);
      await this.settled();
    }
  }
  async prepare(kind: DesktopModelKind): Promise<void> { await this.begin(kind, true); }
  async cancel(kind: DesktopModelKind): Promise<void> {
    if (this.active?.kind !== kind) return;
    this.active.abort.abort();
    await this.active.done;
  }
  async close(): Promise<void> { this.closed = true; this.accessAbort.abort(); this.active?.abort.abort(); await this.settled(); }
  async settled(): Promise<void> { await this.active?.done; }
  /** Trusted host-only model path. It never crosses the desktop bridge. */
  async path(kind: DesktopModelKind): Promise<string> {
    const state = this.states.get(kind), asset = this.assets.find(item => item.kind === kind);
    if (this.closed || state?.state !== 'ready' || !asset) throw new KuroError('MODEL_UNAVAILABLE');
    const path = join(this.directory, `${kind}.gguf`);
    // Recheck immediately before each SDK load. A startup snapshot is not proof
    // that a user-managed cache still contains the pinned artifact later.
    try {
      if (!await this.verify(path, asset, this.accessAbort.signal) || this.closed) throw new Error('Changed model cache');
    } catch {
      state.state = 'missing'; state.downloadedBytes = 0; state.error = null;
      throw new KuroError('MODEL_UNAVAILABLE');
    }
    return path;
  }
  private async begin(kind: DesktopModelKind, download: boolean): Promise<void> {
    if (this.closed) throw new KuroError('MODEL_UNAVAILABLE');
    if (this.active) throw new KuroError('CAPACITY_EXCEEDED');
    const asset = this.assets.find(item => item.kind === kind);
    if (!asset) throw new KuroError('INVALID_INPUT');
    const abort = new AbortController();
    const active = { kind, abort, done: Promise.resolve() };
    this.active = active;
    active.done = this.transfer(asset, download, abort.signal).finally(() => { if (this.active === active) this.active = undefined; });
  }
  private async transfer(asset: ModelAsset, download: boolean, signal: AbortSignal): Promise<void> {
    const destination = join(this.directory, `${asset.kind}.gguf`);
    const temporary = join(this.directory, `${asset.kind}-${randomBytes(16).toString('hex')}.download`);
    const state = this.states.get(asset.kind)!;
    state.state = 'checking'; state.error = null; state.downloadedBytes = 0;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      let valid = false;
      try { valid = await this.verify(destination, asset, signal); }
      catch (error) { if (!isMissing(error)) throw error; }
      signal.throwIfAborted();
      if (valid) { state.state = 'ready'; state.downloadedBytes = asset.bytes; return; }
      if (!download) { state.state = 'missing'; return; }
      if (await this.freeDiskBytes() < asset.bytes + 512 * 1024 * 1024) throw new AssetError('INSUFFICIENT_DISK');
      state.state = 'downloading';
      const response = await this.get(asset.url, signal);
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new AssetError('NETWORK_FAILURE'); }
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          if (state.downloadedBytes + chunk.length > asset.bytes) throw new AssetError('CHECKSUM_MISMATCH');
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
            if (!bytesWritten) throw new AssetError('STORAGE_FAILURE');
            offset += bytesWritten;
          }
          state.downloadedBytes += chunk.length;
        }
        await handle.sync();
      } finally { await handle.close(); }
      signal.throwIfAborted(); state.state = 'verifying';
      if (!await this.verify(temporary, asset, signal)) throw new AssetError('CHECKSUM_MISMATCH');
      signal.throwIfAborted();
      // Atomic publication is the commit point; cancellation cannot claim to undo it.
      renameSync(temporary, destination);
      state.state = 'ready'; state.downloadedBytes = asset.bytes;
    } catch (error) {
      if (signal.aborted) { state.state = 'cancelled'; state.error = null; }
      else {
        state.state = 'failed';
        state.error = error instanceof AssetError ? error.code : error instanceof TypeError ? 'NETWORK_FAILURE' :
          errorCode(error) === 'ENOSPC' ? 'INSUFFICIENT_DISK' : 'STORAGE_FAILURE';
      }
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  private async verify(path: string, asset: ModelAsset, signal: AbortSignal): Promise<boolean> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== asset.bytes) return false;
      const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      return before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && hash.digest('hex') === asset.sha256;
    } finally { await handle.close(); }
  }
  private async get(initial: string, signal: AbortSignal): Promise<Response> {
    let url = new URL(initial);
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (url.protocol !== 'https:' || url.username || url.password) throw new AssetError('NETWORK_FAILURE');
      const response = await (this.options.fetch ?? fetch)(url, { signal, redirect: 'manual', headers: { 'Accept-Encoding': 'identity' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new AssetError('NETWORK_FAILURE');
      url = new URL(location, url);
    }
    throw new AssetError('NETWORK_FAILURE');
  }
  private publicAsset({ kind, name, bytes, sha256 }: ModelAsset): Pick<DesktopModelState, 'kind' | 'name' | 'bytes' | 'sha256'> { return { kind, name, bytes, sha256 }; }
}
function errorCode(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? error.code : undefined; }
function isMissing(error: unknown): boolean { return errorCode(error) === 'ENOENT'; }
