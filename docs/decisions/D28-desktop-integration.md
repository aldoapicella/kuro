# D28: desktop integration checkpoint

The desktop adds strict AppPort reply schemas and a separate DesktopHostPort for native
text selection, verified pairing selection, display-only host information and explicitly
simulated scenarios. Existing AppPort commands, wire v1 and AiPort are unchanged. No host
action accepts a path, acting identity, arbitrary IPC channel or worker command.

Electron 44.3.0, esbuild 0.28.2, @electron/packager 20.3.0 and Playwright 1.63.0 are exact
development dependencies in the existing pnpm workspace. The integration uses the current
shared TypeScript configuration and single lockfile. Native worker dependencies remain
external to the compiled main process; their public packages and adjacent worker assets
are preserved when packaging.

Three explicit modes are provided: demo (FakeAppPort), core-simulated (real SQLite cores,
simulated AI and memory transport), and real (QVAC and HyperDHT adapters). Real startup
never falls back to a simulation. It remains fail-closed for protected operations until
a supported native clock/lifecycle barrier has been validated; merely observing Electron
powerMonitor events is insufficient evidence of B14. No renderer action overrides this gate.

The desktop owns neither permissions nor a second computation queue. Core snapshots are
authoritative; events and periodic refresh reload them. Approval sends only draft ID,
revision and reviewed digest. Evidence remains separate from optional summary drafts.

Electron API references: [security](https://www.electronjs.org/docs/latest/tutorial/security),
[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage),
[powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor).
New desktop source and synthetic fixtures are authored for KURO, without a copied template.
Validation results and remaining runtime gates are recorded in the desktop handoff.
