import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, link, unlink, realpath, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { KuroError } from '@kuro/contracts';
import type { SecretProtection, SecretStore } from '@kuro/contracts';

export interface SecretProtector {
  protection(): SecretProtection;
  encrypt(value: string): Uint8Array;
  decrypt(value: Uint8Array): string;
}
/** Same-directory fsync + atomic hard-link publication. Never overwrite a winning identity. */
export class ProtectedSecretStore implements SecretStore {
  constructor(private readonly directory: string, private readonly protector: SecretProtector) {}
  async protection(): Promise<SecretProtection> { return this.protector.protection(); }
  private async ready(): Promise<void> {
    if (await this.protection() !== 'os-protected') throw new KuroError('IDENTITY_UNAVAILABLE');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await realpath(this.directory) !== resolve(this.directory) || (await lstat(this.directory)).isSymbolicLink()) throw new KuroError('IDENTITY_UNAVAILABLE');
  }
  private path(name: string): string { return join(this.directory, `${createHash('sha256').update(name).digest('hex')}.sealed`); }
  async read(name: string): Promise<Uint8Array | null> {
    await this.ready();
    let handle;
    try { handle = await open(this.path(name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (hasCode(error, 'ENOENT')) return null; throw new KuroError('IDENTITY_UNAVAILABLE'); }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 16384) throw new KuroError('IDENTITY_UNAVAILABLE');
      const text = this.protector.decrypt(await handle.readFile());
      if (!/^(?:[0-9a-f]{2}){1,4096}$/.test(text)) throw new KuroError('IDENTITY_UNAVAILABLE');
      return new Uint8Array(Buffer.from(text, 'hex'));
    } finally { await handle.close(); }
  }
  async createIfAbsent(name: string, candidate: Uint8Array): Promise<Uint8Array> {
    await this.ready();
    if (!candidate.length || candidate.length > 4096) throw new KuroError('INVALID_INPUT');
    const destination = this.path(name);
    const temporary = join(this.directory, `${randomBytes(16).toString('hex')}.pending`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(this.protector.encrypt(Buffer.from(candidate).toString('hex'))); await handle.sync(); }
    finally { await handle.close(); }
    try {
      try { await link(temporary, destination); } catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
      const winner = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await winner.sync(); } finally { await winner.close(); }
      // Filesystems that cannot provide this durability primitive fail explicitly.
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      const stored = await this.read(name);
      if (!stored) throw new KuroError('IDENTITY_UNAVAILABLE');
      return stored;
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
function hasCode(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && error.code === code; }
