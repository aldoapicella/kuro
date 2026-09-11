# KURO desktop

Electron desktop implementation with an isolated renderer and narrow, validated AppPort preload. The UI provides overview, private UTF-8 import, custodian questions, passage selection and human approval, evidence reading, optional summary drafts and job cancellation. Review approval binds the displayed revision and digest. Untrusted passages and summaries render through textContent.

Protected review, evidence, and summary details are cleared before authorization reads, on committed state changes, at a known expiry, and when their periodic authorized recheck fails. Async reads carry a view token so an earlier response cannot render after navigation, a newer read, invalidation, or a changed revision. Rechecks leave unchanged data mounted so a reviewer can retain focus and in-progress edits. A changed review must be displayed again with its current revision and digest before approval. The reviewer can explicitly enable `Allow requester-local summary`; it defaults to false and is persisted through `reviseDraft`, which creates a new reviewed revision. Evidence offers summary only when its approved conditions permit it.

The host keeps renderer authority narrow: the renderer receives named AppPort and DesktopHostPort commands only. It cannot provide paths, identities, IPC channel names, SQL, sockets, Node APIs, SDK objects, or worker creation. File and pairing selection occur in the host, validate bounded records, and require an explicit pairing-detail confirmation.

## Run

From the workspace root, use the pinned Node and pnpm versions in package.json:

```sh
pnpm install --frozen-lockfile
pnpm desktop:demo
```

`pnpm desktop:integrated` opens profiles A (requester) and B (custodian) backed by separate SQLite databases. Ask from A, open Reviews in B, review the recipient, conditions and exact passages, approve, then open Evidence in A. AI and transport are simulated and visibly identified. Evidence reading does not start inference. Private imports are not automatically shared.

`pnpm desktop:real -- --config=/absolute/path/config.json` is an integration entry point, not a validated production mode. See src/composition/real.ts for its strict configuration schema. Real startup requires local QVAC models, native adapters and OS-protected secret storage; protected operations remain closed pending validated clock/lifecycle protection. There is no fallback to fake adapters.

## Build, package, and probes

```sh
pnpm desktop:build
pnpm desktop:package
pnpm --filter @kuro/desktop start -- --probe=host
pnpm --filter @kuro/desktop start -- --probe=runtime
pnpm --filter @kuro/desktop start -- --probe=inference
pnpm --filter @kuro/desktop start -- --probe=transport --config=/absolute/path/config.json
node apps/desktop/scripts/probe-package.mjs
```

Desktop staging uses `pnpm deploy --prod` to create an isolated production dependency tree, then restores the source workspace with its frozen lockfile. It copies the compiled public workspace exports and the transport worker beside their staged packages, replaces staged manifests rather than mutating hard-linked source manifests, and leaves native SDK dependency resolution external to bundling. Packaging retains production dependencies and rewrites copied links relative to the distribution. `probe-package.mjs` relocates the app outside the repository, rejects broken or external symlinks, runs the selected probe (host by default), and restores the distribution. It also accepts the runtime, inference, and transport probe arguments above.

On Linux, the installed Chromium sandbox helper must be owned by root with mode `4755`. CI explicitly installs the pinned Electron binary before locating and configuring both development and packaged helpers. It keeps sandboxing enabled during the packaged probe.

The host probe reports Electron's embedded runtime and storage capability. The runtime probe checks OS-protected secret storage with concurrent creation and reopen, loads the public QVAC adapter without fallback downloads, and closes it while authorization remains closed. The inference probe additionally embeds one synthetic identified block. The separate transport probe requires a reachable isolated bootstrap and persistent router, uses two temporary protected identities, and runs the shared five-message conformance suite through actual Bare workers, including recipient restart and clean shutdown. Use the [transport harness](../../harnesses/transport/README.md) to provision the bootstrap/router. No probe opens the core authorization gate.

## Validation status

On September 11, 2026, macOS arm64 validation passed: strict typecheck, 145 TypeScript tests including 11 desktop/host tests, 16 Python reference tests, and three Electron UI tests. The UI tests use real separate SQLite cores with simulated AI/transport, require revised consent before approval, exercise explicit summary, and clear expired protected content.

The unsigned packaged app was relocated outside the checkout and all 943 symlinks resolved inside its distribution. Host, runtime, inference, and transport probes passed under Electron 44.3.0 / Node 24.20.0: SQLite 3.53.4, foreign keys, FTS5 and disk reopen; eight concurrent protected-secret contenders and reopened winner; actual cached GTE_LARGE_FP16 embedding with 1024 dimensions and downloads disabled; five authenticated exact-byte Bare deliveries and recipient identity restart. The distribution is approximately 5.5 GiB with the pinned SDK's native assets. This is a local development package, without signing/notarization or a physical cross-device claim.

The combined two-process QVAC/Bare custody/restart test also passed (run `9270293b-c86c-4981-8be4-7bc00fec4101`). Real-mode clock/lifecycle protection remains initially untrusted: resume is conservative (`resume(false)`) until a trustworthy clock barrier is demonstrated. These probes do not establish a complete real-mode desktop workflow or suspend/resume safety.

The desktop is an initial implementation. Owner membership/policy administration currently remains available through public core commands rather than dedicated renderer screens. No automatic permission grants are added by the import UI. Real mode lifecycle validation remains a release gate.

All new UI, desktop code and test fixtures were authored for KURO; no external UI template was copied.
