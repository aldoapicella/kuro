import { randomBytes } from 'node:crypto';
import type { SecretProtection, SecretStore } from '@kuro/contracts';

export class TransportSecretError extends Error {
  constructor(message: string, readonly protection: SecretProtection) { super(message); }
}

export async function loadOrCreateSeed(store: SecretStore, name: string, allowEphemeralTest = false): Promise<Uint8Array> {
  const protection = await store.protection();
  if (protection !== 'os-protected' && !(allowEphemeralTest && protection === 'ephemeral-test')) {
    throw new TransportSecretError('Transport requires os-protected secret storage', protection);
  }
  const existing = await store.read(name);
  const seed = existing ?? await store.createIfAbsent(name, new Uint8Array(randomBytes(32)));
  if (!(seed instanceof Uint8Array) || seed.byteLength !== 32) throw new TransportSecretError('Transport seed has invalid length', protection);
  return new Uint8Array(seed);
}

/** Deliberately named test-only secret store; it must be opted into by the transport constructor. */
export class InMemorySecretStore implements SecretStore {
  #values = new Map<string, Uint8Array>();
  constructor(private readonly mode: SecretProtection = 'ephemeral-test', initial: ReadonlyMap<string, Uint8Array> = new Map()) {
    for (const [name, value] of initial) this.#values.set(name, new Uint8Array(value));
  }
  async protection(): Promise<SecretProtection> { return this.mode; }
  async read(name: string): Promise<Uint8Array | null> {
    const value = this.#values.get(name);
    return value === undefined ? null : new Uint8Array(value);
  }
  async createIfAbsent(name: string, candidate: Uint8Array): Promise<Uint8Array> {
    if (!this.#values.has(name)) this.#values.set(name, new Uint8Array(candidate));
    return new Uint8Array(this.#values.get(name)!);
  }
}
