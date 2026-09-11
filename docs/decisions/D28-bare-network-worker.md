# D28 — Bare network worker

Status: implemented. This replaces the Node worker used in the first transport checkpoint with an actual **Bare 1.32.0** process. The Node host still composes core/SQLite and the public `TransportPort`; HyperDHT runs in Bare. Existing contracts, peer framing, keys, approval bytes and pnpm tooling are retained. Electron application packaging remains a separate host integration check.

## Runtime and boundary

`bare-runtime/spawn` launches the pinned platform binary with an explicit worker entry path. A private inherited duplex pipe on descriptor 3 carries initialization and control messages through `bare-pipe`. The protected identity seed is sent over this pipe, never worker arguments, environment variables or stdout. Native stdout/stderr are not forwarded as product diagnostics. The worker must report Bare 1.32.0 before initialization; startup failure has no Node or simulated fallback.

Private IPC uses bounded newline-delimited JSON with explicit hexadecimal binary fields. It is separate from KURO's unchanged four-byte-length peer protocol. Records are at most 131,072 bytes including the delimiter, and pending writes/pre-initialization commands are bounded to 4 MiB. Malformed records, invalid shapes, partial EOF and channel loss fail closed. The network worker exits when its host pipe disappears. A clean stop requires both the worker acknowledgment and exit code zero; timeout termination is reported as failure.

The existing network engine retains authenticated `remotePublicKey`, explicit pairing, bounded sockets/frames, encrypted-stream flush and immutable retry behavior. Initialization commands precede queued pairing/stop commands. Startup checks shutdown after each await so late bootstrap/listen completion cannot reopen a stopped worker.

Bare lacks global `TextEncoder`/`TextDecoder`. The build injects a small one-shot UTF-8 adapter using `bare-buffer`'s native encoding and `isUtf8` validation. This preserves the public contracts' fatal malformed-UTF-8 rejection and BOM semantics. Unsupported streaming decoding throws explicitly. Public contract Unicode roundtrips, malformed UTF-8 and duplicate JSON rejection run under the actual Bare binary.

## Build and host integration

Run `pnpm install --frozen-lockfile` then `pnpm --filter @kuro/transport build:worker`. The ignored artifact is `packages/transport/dist/bare-worker.mjs`. Root `pnpm build`, transport tests and transport harness scripts build it automatically. Direct `node --import tsx ...` harness commands require a prior worker build on every host.

esbuild bundles the network engine and public contracts, leaving HyperDHT, bare-pipe and bare-buffer native packages external. A deployed host must retain their pinned native dependencies, `require-asset`, the platform Bare binary and the built worker asset. The development adapter locates the asset beside its source package. A bundler/compiled-host composition supplies the trusted `HyperDhtTransportOptions.workerUrl` pointing to the packaged asset; this option must never be renderer input. Plain TypeScript output is not an Electron distribution or a self-contained native bundle.

No public DTO or storage migration changes. Protected `SecretStore` requirements and the core/transport permission boundary are unchanged. Process separation does not establish an OS sandbox or encrypt SQLite.

## Validation

At implementation commit `84c1de7`, macOS arm64 / Node 24.19.0 / Bare 1.32.0 passed strict typecheck, build, 128 TypeScript tests (8 contracts, 64 core, 22 transport, 33 AI, 1 integration), and 16 Python reference regressions. Transport tests include actual Bare startup cancellation, malformed IPC, wrong runtime, false shutdown acknowledgment, simultaneous authenticated dials and same-identity restart. The separate-process smoke passed five authenticated D25 messages with relaunch and exact replay.

A subsequent test-only check at `d7a7376` also passed: losing the inherited host pipe before or during network startup exits the actual Bare process without timeout or orphaning. That checkpoint had 23 transport tests, 129 TypeScript tests across the workspace, and unchanged product code from `84c1de7`.

The completion audit then reproduced Node observing process exit before draining the final pipe acknowledgment. The host now waits for child-process `close`, preserving the acknowledgment-plus-zero-exit requirement. The actual Bare regression failed before this fix and passed afterward; all 24 transport tests and strict typecheck passed. The combined simulated-AI/Bare custody scenario completed cleanly as `2c07f49e-ac11-4dd1-aa66-8201daa7f265`. Earlier real-QVAC and offline-network results remain scoped to `84c1de7`.

The combined local custody workflow passed with actual QVAC, Bare HyperDHT and separate SQLite databases: run `6609833a-1bfb-49d1-b404-1400362761e3`. The explicit simulated-AI profile also passed: `c2b6e3ae-368e-471e-ae95-41207ffa2e27`. Both check restricted inputs, exact approval, lost ACK/relaunch, immutable retry/one inbox effect, model-free reads, explicit summary, revocation before dispatch and durable denial. Completion follows acknowledged clean process shutdown. These local results do not establish physical-device or Electron integration.

The same exact commit passed actual QVAC plus Bare on Ubuntu 24.04.4 arm64 in an 8 GiB VM with two independent network namespaces and a direct veth link: run `52b501cb-de82-4fbc-a169-f803dd34dc72`, exit zero. The worker artifact was built inside the guest. Both namespaces had no external route and default-drop egress gates; external TCP controls failed before and after the complete SSH-mode custody scenario. No Node or Bare peer process remained afterward. The dedicated SSH daemon and VM were stopped with model caches and synthetic SQLite state preserved. This is one VM with two network stacks sharing one kernel, not two physical devices. Reproduction uses the [namespace procedure](../../harnesses/transport/README.md#one-vm-with-isolated-peer-network-namespaces) with `ai: "qvac"`.

## Provenance

The pinned [bare-runtime 1.32.0](https://github.com/holepunchto/bare-runtime), [bare-pipe 4.3.1](https://github.com/holepunchto/bare-pipe) and [bare-buffer 3.7.1](https://github.com/holepunchto/bare-buffer) are Apache-2.0; [esbuild 0.28.2](https://github.com/evanw/esbuild) is MIT. `require-asset` 1.2.2 is an explicit runtime dependency, as in D27. The runtime's API is outside its semantic-versioning guarantee, so it is pinned and checked at startup. KURO's bridge and entry point are newly authored against inspected package APIs; no external worker implementation or native source is copied.
