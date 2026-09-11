import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KuroError } from '@kuro/contracts';
import type { ClockSample } from './lifecycle-clock.js';

export interface NativeClockMetadata {
  platform: 'darwin';
  release: string;
  osBuild: string;
  arch: string;
  qualified: boolean;
  canaryReady: boolean;
}

interface NativeClockBinding {
  metadata(): NativeClockMetadata;
  snapshot(): ClockSample;
}

/** `addonPath` keeps source-mode probes explicit; bundled Electron code uses the
 * clock.node placed beside its own host chunk by buildNativeClock. */
export function loadNativeClock(addonPath?: string): () => ClockSample {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new KuroError('CLOCK_UNCERTAIN');
  const path = addonPath ?? resolve(dirname(fileURLToPath(import.meta.url)), 'clock.node');
  let binding: NativeClockBinding;
  try {
    binding = createRequire(import.meta.url)(path) as NativeClockBinding;
  } catch {
    throw new KuroError('CLOCK_UNCERTAIN');
  }
  let metadata: NativeClockMetadata;
  try { metadata = binding.metadata(); }
  catch { throw new KuroError('CLOCK_UNCERTAIN'); }
  if (!metadata.qualified || !metadata.canaryReady || metadata.platform !== 'darwin' ||
    metadata.release !== '25.5.0' || metadata.osBuild !== '25F71' || metadata.arch !== 'arm64') throw new KuroError('CLOCK_UNCERTAIN');
  return () => {
    try { return binding.snapshot(); }
    catch { throw new KuroError('CLOCK_UNCERTAIN'); }
  };
}
