declare module 'bare-runtime/spawn' {
  import type { ChildProcess, SpawnOptions } from 'node:child_process';
  export default function spawn(options: SpawnOptions & { args: string[] }): ChildProcess;
}
