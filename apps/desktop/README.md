# KURO desktop

Electron desktop implementation with an isolated renderer and narrow, validated AppPort preload. The UI provides overview, private UTF-8 import, custodian questions, passage selection and human approval, evidence reading, optional summary drafts and job cancellation. Review approval binds the displayed revision and digest. Untrusted passages and summaries render through textContent.

Protected review, evidence, and summary details are cleared before authorization reads, on committed state changes, at a known expiry, and when their periodic authorized recheck fails. Async reads carry a view token so an earlier response cannot render after navigation, a newer read, invalidation, or a changed revision. Rechecks leave unchanged data mounted so a reviewer can retain focus and in-progress edits. A changed review must be displayed again with its current revision and digest before approval. The reviewer can explicitly enable `Allow requester-local summary`; it defaults to false and is persisted through `reviseDraft`, which creates a new reviewed revision. Evidence offers summary only when its approved conditions permit it.

The host keeps renderer authority narrow: the renderer receives named AppPort and DesktopHostPort commands only. It cannot provide paths, identities, IPC channel names, SQL, sockets, Node APIs, SDK objects, or worker creation. File and pairing selection occur in the host, validate bounded records, and require an explicit pairing-detail confirmation.

## Install a published preview

Publication is still awaiting the acceptance gates below. Once a preview appears
in [GitHub Releases](https://github.com/aldoapicella/kuro/releases), download its
`darwin-arm64-unsigned-preview.tar.gz` asset using an account with repository
access. Open the archive in Finder, open the extracted `KURO-darwin-arm64` folder,
and drag **KURO.app** to **Applications**. Double-click KURO to launch it. No
Node, pnpm, compiler, Homebrew installation, or developer checkout is needed.

This preview is not Developer ID signed or notarized. If macOS asks you to
approve this downloaded preview, use **System Settings → Privacy & Security →
Open Anyway**, then confirm **Open**, following
[Apple's per-application instructions](https://support.apple.com/102445).
Protected keychain access can require a separate macOS prompt. Enter the
credential only in that native prompt.

For replacement, quit KURO, replace only **KURO.app** in Applications, and reopen
it. Keep the previous archive for recovery. Profile data is stored separately
under `~/Library/Application Support/KURO/real/A`; moving the app does not move
or erase the profile. This first preview has no earlier supported release to
migrate, and development databases are unsupported.

## First-run setup

The first screen is **Setup**. Enter a device name and private LAN bootstrap details, choose whether to host the private bootstrap, optionally choose a local UDP port, and select **Save profile and start workspace**. You can link an existing identity before the first start; when running, **Export my public identity for a linked device** exports public identity material. macOS may show a SecurityAgent prompt for protected keychain access. Approve it in macOS; KURO never asks you to paste or expose a keychain credential.

Native real mode opens only on arm64 **macOS 26.5 / Darwin 25.5.0 / build 25F71**. Other hosts remain closed; Linux is a CI platform only. KURO does not substitute fake adapters when native real mode is unavailable.

Open **Models** and select **Prepare embedding model** and **Prepare summary model**. KURO downloads QVAC GTE (669,603,712 bytes) and Qwen (1,056,782,912 bytes), about 1.61 GiB together. Weights are not bundled. The GUI reports progress, verifies SHA-256, and provides cancellation and retry. Source GUI downloads passed in 20,688.56 ms and 30,870.75 ms respectively, including actual cancellation, retry, and hash verification.

Use **Spaces** to create an owner space, join or enroll from an exported invitation, verify pairing, refresh a shared space, and export invitation or enrollment material. Choose the explicit private-LAN endpoint for a peer. In **Permissions**, save shared membership, relationships, local grants, and document rules. All three scopes begin denied: shared membership, local permission, and document permission. Importing a document does not grant it to anyone.

The GUI keeps error codes visible and gives a next step: restore the clock and refresh for `CLOCK_UNCERTAIN`; check shared membership plus local/document permission for `ACCESS_DENIED`; refresh and review current data for `STALE_REVISION`; prepare models for `MODEL_UNAVAILABLE`; check the private LAN for `PEER_OFFLINE`; unlock or repair the protected keychain for `IDENTITY_UNAVAILABLE`; and wait, cancel, retry, or refresh after capacity, cancellation, or expiry errors.

## Development, packaging, and probes

Source execution uses the pinned Node and pnpm versions in the root manifest:

```sh
pnpm install --frozen-lockfile
pnpm desktop:real
```

`pnpm desktop:demo` selects explicitly scripted demo data; it does not exercise
real inference or transport. `pnpm desktop:integrated` runs actual core and
SQLite with simulated adapters.

```sh
pnpm desktop:build
pnpm desktop:package
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

`0.1.0-preview.1` needs at least 8 GiB for the app, about 2 GiB for weights, and working cache; 12 GiB free is the practical recommendation. The only tested memory configuration is an M5 Pro with 48 GB unified memory. The rebuilt `b762992` archive is 1,860,910,230 bytes; the earlier measured unpacked distribution was about 5.5 GiB. It contains two vendored non-Apple dylibs with OpenSSL licenses and 943 internal symlinks with no external targets. It is ad-hoc signed, not Developer ID signed or notarized; publication has not run.

| Area | Recorded state |
| --- | --- |
| Source two-process GUI workflow | Commit `b762992` passed the expanded actual-QVAC/Bare workflow in 57.8 seconds, including protected setup, permissions, restricted/cross-space exclusion, explicit automated approval, summary, restart, and revocation. |
| GUI failure coverage | The expanded source test passed lost-ACK identical retry, one inbox effect, requester restart, model-free reading, explicit unavailable-model recovery, lock/unlock invalidation, fresh synchronization, and owner GUI device revocation. |
| Packaged GUI workflow | Candidate archive `2d0288…`, run outside the checkout in a normal OS home with fresh user data and a system-only `PATH`, passed in 49.8 seconds with actual QVAC and Bare. It covered lost-ACK retries, durable inbox exact-byte deduplication, requester restart with model-free evidence reads, missing-model summary recovery, and lock/unlock invalidation with fresh synchronization. |
| Offline LAN | Two macOS 25F71 VZ guests have distinct virtual-LAN addresses and verified model caches. The bundled native clock loads and samples in the owner guest. Both guests passed manual PF install, fresh-SSH egress checks, UDP capture, and removal. Guest GUI login, runtime/lifecycle qualification, and the complete offline workflow remain pending. |
| CI and release | All four Linux/macOS push and PR jobs passed at `b762992`. Its rebuilt archive includes the model re-hash fix and passed relocated host/native-lifecycle probes; full GUI launch awaits native Keychain authorization. Final archive qualification and publication remain pending. |

The lifecycle probe uses native clock behavior with simulated AI and transport. Its earlier physical sleep/wake pass establishes that lifecycle boundary, not a full real-mode GUI or cross-device LAN run. Package and release acceptance is tracked in the [MVP handoff](../../docs/development/mvp-release-handoff.md).

All new UI, desktop code and test fixtures were authored for KURO; no external UI template was copied. The native clock addon uses public Apple APIs with implementation evidence cited in D30. `node-api-headers@1.9.0` comes from the Node.js project under the MIT license.
