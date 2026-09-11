# D29: desktop integration checkpoint

The desktop adds strict AppPort reply schemas and a separate DesktopHostPort for native
text selection, verified pairing selection, display-only host information and explicitly
simulated scenarios. Existing AppPort commands, wire v1 and AiPort are unchanged. No host
action accepts a path, acting identity, arbitrary IPC channel or worker command.

Electron 44.3.0, esbuild 0.28.2, @electron/packager 20.3.0 and Playwright 1.63.0 are exact
development dependencies in the existing pnpm workspace. The integration uses the current
shared TypeScript configuration and single lockfile. Desktop staging uses `pnpm deploy --prod`
to create an isolated production tree, copies compiled public workspace exports and the
transport worker into that tree, and replaces staged manifests without mutating source
hard links. It then restores the frozen source workspace profile. Native SDK dependencies
remain external to bundling and adjacent to their staged package for runtime asset lookup.

Three explicit modes are provided: demo (FakeAppPort), core-simulated (real SQLite cores,
simulated AI and memory transport), and real (QVAC and HyperDHT adapters). Real startup
never falls back to a simulation. It remains fail-closed for protected operations until
a supported native clock/lifecycle barrier has been validated; merely observing Electron
powerMonitor events is insufficient evidence of B14. No renderer action overrides this gate.

The desktop owns neither permissions nor a second computation queue. Core snapshots are
authoritative; events and periodic refresh reload them. Protected detail views clear before
their authorization reads, when committed state changes, at expiry, and when their periodic
authorized getter rejects. A token prevents late review, evidence, or summary reads from
rendering after navigation, replacement, or invalidation. Unchanged periodic results leave
the mounted view intact; changed results replace it with the current authorized revision.
Approval sends only draft ID, revision and reviewed digest. Evidence remains separate from
optional summary drafts. `allowLocalSummary` defaults to false; a reviewer must explicitly
persist it through `reviseDraft`, yielding a new revision and digest before approval.

The host validates selected text and pairing records and confines the renderer to named,
validated AppPort and DesktopHostPort calls. The renderer has no arbitrary paths, identities,
IPC channels, Node APIs, SQL, sockets, SDK instances, or worker creation. Runtime and
inference probes run only synthetic local checks: protected secret creation/reopen, public
QVAC adapter load/close, and, for inference, one synthetic embedding. A separate transport
probe takes configured external bootstrap nodes and runs the public five-message conformance
suite using two actual Bare workers and temporary protected identities. All probes leave the
authorization gate closed.

Electron API references: [security](https://www.electronjs.org/docs/latest/tutorial/security),
[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage),
[powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor).
New desktop source and synthetic fixtures are authored for KURO, without a copied template.
`desktop:build`, `desktop:package`, and Electron `--probe=host|runtime|inference|transport`
are the relevant execution paths. `probe-package.mjs` relocates the package outside the
checkout and validates every symlink before execution. On September 11, 2026 the macOS
arm64 distribution passed all four probes: Electron 44.3.0, Node 24.20.0, SQLite 3.53.4,
OS-protected concurrent creation/reopen, actual cached GTE embedding, and five authenticated
Bare deliveries with recipient restart and clean shutdown. The [desktop README](../../apps/desktop/README.md)
records validation scope. The existing contracts and root pnpm configuration remain intact.

Real clock/lifecycle safety remains a release gate: startup and resume are initially untrusted
(`resume(false)`) until a trustworthy synchronous barrier is shown. A dedicated user-space
IORegisterForSystemPower callback is insufficient: macOS can proceed with forced sleep after
30 seconds without its acknowledgement, so a stalled helper could miss pre-sleep closure.
See [Apple QA1340](https://developer.apple.com/library/archive/qa/qa1340/_index.html).
The callback cannot prove that a protected operation immediately after wake observes a
changed epoch. This implementation does not weaken D25 or enable trust on a best-effort event.
