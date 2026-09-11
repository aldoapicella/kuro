import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['src/bare-worker-entry.ts'],
  outfile: 'dist/bare-worker.mjs',
  bundle: true, platform: 'neutral', format: 'esm', target: 'es2023',
  external: ['hyperdht', 'bare-pipe', 'bare-buffer'],
  inject: ['src/bare-text-encoding.ts'],
  logLevel: 'warning',
});
