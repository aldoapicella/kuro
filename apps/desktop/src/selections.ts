import { randomBytes } from 'node:crypto';
import { KuroError, VerifiedBindingSchema } from '@kuro/contracts';
import type { VerifiedBinding, VerifiedPairingPort } from '@kuro/contracts';

/** Every field below is part of the out-of-band verification ceremony. */
export function formatBindingVerification(value: VerifiedBinding): string {
  const binding = VerifiedBindingSchema.parse(value);
  const key = binding.kind === 'authority' ? binding.authorityKey : binding.peerKey;
  return [
    `Type: ${binding.kind}`,
    `Space: ${binding.spaceId}`,
    ...(binding.kind === 'member' ? [`Member: ${binding.memberId}`] : []),
    `Key: ${key}`,
    `Space alias: ${binding.spaceAlias}`,
  ].join('\n');
}

/** Register only after the native host has shown a key and obtained local verification. */
export class VerifiedPairings implements VerifiedPairingPort {
  private readonly tokens = new Map<string, { binding: VerifiedBinding; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  register(binding: VerifiedBinding): string {
    for (const [key, value] of this.tokens) if (value.expires <= this.now()) this.tokens.delete(key);
    if (this.tokens.size >= 32) throw new KuroError('CAPACITY_EXCEEDED');
    const token = randomBytes(16).toString('hex');
    this.tokens.set(token, { binding: VerifiedBindingSchema.parse(binding), expires: this.now() + 300_000 });
    return token;
  }
  async consume(token: string): Promise<VerifiedBinding> {
    const selected = this.tokens.get(token); this.tokens.delete(token);
    if (!selected || selected.expires <= this.now()) throw new KuroError('ACCESS_DENIED');
    return structuredClone(selected.binding);
  }
}
