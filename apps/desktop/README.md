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

The first screen is **Setup**. Enter a device name and private LAN bootstrap details, choose whether to host the private bootstrap, optionally choose a local UDP port, and select **Save profile and start workspace**. You can link an existing identity before the first start; when running, **Export my public identity for a linked device** exports public identity material. macOS may show a SecurityAgent prompt for protected keychain access. Approve it in macOS; KURO never asks you to paste or expose a keychain credential.

Native real mode opens only on arm64 **macOS 26.5 / Darwin 25.5.0 / build 25F71**. Other hosts remain closed; Linux is a CI platform only. KURO does not substitute fake adapters when native real mode is unavailable.

Open **Models** and select **Prepare embedding model** and **Prepare summary model**. KURO downloads QVAC GTE (669,603,712 bytes) and Qwen (1,056,782,912 bytes), about 1.61 GiB together. Weights are not bundled. The GUI reports progress, verifies SHA-256, and provides cancellation and retry. Source GUI downloads passed in 20,688.56 ms and 30,870.75 ms respectively, including actual cancellation, retry, and hash verification.

Use **Spaces** to create an owner space, join or enroll from an exported invitation, verify pairing, refresh a shared space, and export invitation or enrollment material. Choose the explicit private-LAN endpoint for a peer. In **Permissions**, save shared membership, relationships, local grants, and document rules. All three scopes begin denied: shared membership, local permission, and document permission. Importing a document does not grant it to anyone.

The GUI keeps error codes visible and gives a next step: restore the clock and refresh for `CLOCK_UNCERTAIN`; check shared membership plus local/document permission for `ACCESS_DENIED`; refresh and review current data for `STALE_REVISION`; prepare models for `MODEL_UNAVAILABLE`; check the private LAN for `PEER_OFFLINE`; unlock or repair the protected keychain for `IDENTITY_UNAVAILABLE`; and wait, cancel, retry, or refresh after capacity, cancellation, or expiry errors.

## Build, package, and probes

```sh
pnpm --filter @kuro/desktop build
pnpm --filter @kuro/desktop package
pnpm --filter @kuro/desktop start -- --probe=host
pnpm --filter @kuro/desktop start -- --probe=runtime
pnpm --filter @kuro/desktop start -- --probe=inference
pnpm --filter @kuro/desktop start -- --probe=lifecycle
node apps/desktop/scripts/probe-package.mjs
node apps/desktop/scripts/probe-package.mjs --probe=lifecycle
```

Desktop staging uses `pnpm deploy --prod` to create an isolated production dependency tree, then restores the source workspace with its frozen lockfile. It copies the compiled public workspace exports and the transport worker beside their staged packages, replaces staged manifests rather than mutating hard-linked source manifests, removes unused absolute development references and lockfiles, and records `sourceCommit` only for a clean verified Git HEAD. Packaging retains production dependencies and rewrites copied links relative to the distribution. On macOS arm64 it keeps all staged native assets, audits Mach-O dependencies used by that runtime, vendors non-Apple absolute dylibs into `Contents/Frameworks/KURONative`, rewrites their load paths relative to each consumer, and copies their licenses into `Contents/Resources/licenses`. The package fails if an external absolute Mach-O dependency remains. It writes a streamed SHA-256 for `KURO-<version>-darwin-arm64-unsigned-preview.tar.gz` only when the archive is smaller than GitHub's 2 GiB asset limit; the version comes from the desktop manifest. The preview is ad-hoc signed only so macOS accepts rewritten nested code; it is not Developer ID signed or notarized. `probe-package.mjs` relocates the app outside the repository, rejects broken or external symlinks, runs the selected probe (host by default), and restores the distribution. It also accepts the runtime, inference, and transport probe arguments above.

On Linux, the installed Chromium sandbox helper must be owned by root with mode `4755`. CI explicitly installs the pinned Electron binary before locating and configuring both development and packaged helpers. It keeps sandboxing enabled during the packaged probe.

The host probe reports Electron's embedded runtime and storage capability. The runtime probe checks OS-protected secret storage with concurrent creation and reopen, loads the public QVAC adapter without fallback downloads, and closes it while authorization remains closed. The inference probe additionally embeds one synthetic identified block. The separate transport probe requires a reachable isolated bootstrap and persistent router, uses two temporary protected identities, and runs the shared five-message conformance suite through actual Bare workers, including recipient restart and clean shutdown. Use the [transport harness](../../harnesses/transport/README.md) to provision the bootstrap/router.

The lifecycle probe uses the actual native Clock and two SQLite cores with explicitly simulated AI/transport and injected suspend. It opens the qualified gate, discards a pending evidence reply, resumes with stale participant authority, and verifies that a fresh synchronization restores evidence access. `--probe=lifecycle-sleep` instead waits up to 90 seconds for a physical sleep/wake while deliberately blocking JavaScript power-event dispatch. It requires the native barrier to close first. This command does not put the Mac to sleep itself. Build prerequisites on macOS include Xcode Command Line Tools; the native addon uses pinned Node-API headers and is staged beside the host bundle.

## Preview size and validation

`0.1.0-preview.1` needs at least 8 GiB for the app, about 2 GiB for weights, and working cache; 12 GiB free is the practical recommendation. The only tested memory configuration is an M5 Pro with 48 GB unified memory. The archive is 1,860,996,936 bytes and the unpacked distribution is about 5.5 GiB. It contains two vendored non-Apple dylibs with OpenSSL licenses and 943 internal symlinks with no external targets. It is ad-hoc signed, not Developer ID signed or notarized; publication has not run.

| Area | Recorded state |
| --- | --- |
| Source two-process GUI workflow | Passed in 49.2 seconds with actual QVAC, Bare, SQLite, protected identity, setup, default-deny grants, restricted/cross-space exclusion, explicit automated approval, and requester-local summary. |
| GUI failure coverage | Reached lost-ACK identical retry, one inbox restart, model-free reading, and explicit unavailable-model handling. A fixture defect was fixed; final expanded pass pending. |
| Packaged GUI workflow | Candidate archive `2d0288…`, run outside the checkout in a normal OS home with fresh user data and a system-only `PATH`, passed in 49.8 seconds with actual QVAC and Bare. It covered lost-ACK retries, durable inbox exact-byte deduplication, requester restart with model-free evidence reads, missing-model summary recovery, and lock/unlock invalidation with fresh synchronization. |
| Offline LAN | No offline GUI pass yet. A matching macOS 25F71 restore image download was verified; guest provisioning is in progress. |
| CI and release | Four Linux/macOS push and PR jobs were green at checkpoint `28d7145`. The candidate archive predates the latest re-hash-before-SDK-load security fix; final source/package qualification, CI, release dispatch, and publication remain pending. |

The lifecycle probe uses native clock behavior with simulated AI and transport. Its earlier physical sleep/wake pass establishes that lifecycle boundary, not a full real-mode GUI or cross-device LAN run. Package and release acceptance is tracked in the [MVP handoff](../../docs/development/mvp-release-handoff.md).

All new UI, desktop code and test fixtures were authored for KURO; no external UI template was copied. The native clock addon uses public Apple APIs with implementation evidence cited in D30. `node-api-headers@1.9.0` comes from the Node.js project under the MIT license.
