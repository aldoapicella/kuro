# KURO desktop

Electron desktop implementation with an isolated renderer and narrow, validated AppPort preload. The UI provides overview, private UTF-8 import, custodian questions, passage selection and human approval, evidence reading, optional summary drafts and job cancellation. Review approval binds the displayed revision and digest. Untrusted passages and summaries render through textContent.

## Run

From the workspace root, use the pinned Node and pnpm versions in package.json:

```sh
pnpm install --frozen-lockfile
pnpm desktop:demo
```

`pnpm desktop:integrated` opens profiles A (requester) and B (custodian) backed by separate SQLite databases. Ask from A, open Reviews in B, review the recipient, conditions and exact passages, approve, then open Evidence in A. AI and transport are simulated and visibly identified. Evidence reading does not start inference. Private imports are not automatically shared.

`pnpm desktop:real -- --config=/absolute/path/config.json` is an integration entry point, not a validated production mode. See src/composition/real.ts for its strict configuration schema. Real startup requires local QVAC models, native adapters and OS-protected secret storage; protected operations remain closed pending validated clock/lifecycle protection. There is no fallback to fake adapters.

## Validation for this handoff

- TypeScript strict typecheck: passed.
- Desktop host/preload/renderer build: passed.
- Contract suite: 10 passed.
- Desktop and integration tests: 2 passed. Includes separate SQLite cores, no delivery before approval, restricted passage exclusion and evidence access when simulated inference is unavailable.
- GUI execution, OS packaging, real QVAC inference and physical cross-device networking: not verified in this environment.
- graphify update unavailable because graphify is not installed.

The desktop is an initial implementation. Owner membership/policy administration currently remains available through public core commands rather than dedicated renderer screens. No automatic permission grants are added by the import UI. Real mode lifecycle validation remains a release gate.

All new UI, desktop code and test fixtures were authored for KURO; no external UI template was copied.
