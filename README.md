# KURO

Local AI and peer-to-peer collaboration for confidential knowledge.

KURO lets participants query information held by trusted peers while each custodian retains control of their original documents. A custodian retrieves relevant passages locally with QVAC, reviews the proposed disclosure, and sends only approved evidence. The recipient can read that evidence and optionally summarize it on their own device.

## Project status

The custody core, public TypeScript contracts, persistent SQLite workflow, authenticated Bare transport, and desktop renderer are implemented. Source model downloads and a two-process packaged desktop workflow passed with actual QVAC, Bare, SQLite, and protected identities; approvals and requester-local summaries were explicit automated test actions. The candidate package predates the latest model re-hash security fix, so final source/package qualification, offline GUI evidence, final CI, and release publication remain pending. See the [desktop guide](apps/desktop/README.md) and [release handoff](docs/development/mvp-release-handoff.md) for the exact evidence and limits.

## Design principles

- **Local inference:** embeddings and optional generation run through QVAC on the participating devices.
- **Explicit disclosure:** access checks precede retrieval; an authorized reviewer approves the exact content and recipient.
- **Source custody:** original documents and indexes stay with their custodian. There is no shared global index.
- **Traceable evidence:** references identify the origin, document version, and passage. Generated summaries remain distinct from received evidence.
- **Durable delivery:** approval and outgoing bytes commit together; retries preserve those bytes and receivers deduplicate deliveries.
- **Bounded processing:** receiving evidence does not automatically start a model or authorize forwarding it to another peer.

See the [technical architecture](docs/architecture.md) for contracts, tradeoffs, threat boundaries, and validation requirements.

The [D25 shared-space authority design](docs/decisions/D25-shared-space-authority.md) is implemented in the core: pinned owner administration, recipient projections, separate policy/publication counters, original-send leases, denial/replay checks and explicit namespace recovery. Local document policy and exact human approval remain required. See the [implementation handoff](docs/development/core-transport-handoff.md) for commands, evidence and external gates.

## Getting started

### Desktop preview

`0.1.0-preview.1` is prepared for arm64 **macOS 26.5 / Darwin 25.5.0 / build
25F71** only. Real mode stays closed elsewhere; Linux is used for CI. The package
is not yet published, so do not treat the repository as an installation download.

Plan for 12 GiB free disk space: at least 8 GiB for the app, about 2 GiB for
explicit model downloads, plus working cache. The only tested memory configuration
is an M5 Pro with 48 GB unified memory. Open **Setup**, start a private LAN
workspace, then use **Models** to explicitly prepare the QVAC GTE and Qwen
weights. Downloads report progress, validate SHA-256, and can be cancelled or
retried; no model weights are bundled. macOS may require manual SecurityAgent
approval for protected keychain access.

Use **Spaces** to create or join a space and explicitly select the LAN endpoint.
Use **Permissions** to set shared membership, a local grant, and any document
rule; all are default-deny. Importing documents does not grant access. The GUI
keeps error codes visible and explains recovery steps for clock, permission,
revision, model, network, identity, capacity, cancellation, and expiry failures.

### Development

```sh
git clone https://github.com/aldoapicella/kuro.git
cd kuro
python3 verification/run_checks.py
```

Repository access requires an authorized GitHub account. The reference checks use the Python standard library. Use Python 3.12 for the development tooling; see [Graphify setup](docs/development/graphify.md) for an isolated installation.

The shared TypeScript contract workspace uses Node 24.19.0 and pnpm 11.19.0. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`, `pnpm test`, and `pnpm probe:host` from the root. The host probe checks actual SQLite/FTS5 and disk reopen support. Terminal Node results do not establish Electron compatibility. See [D26](docs/decisions/D26-runtime-and-contract-checkpoint.md) for the public integration checkpoint and remaining host checks.

## Repository structure

| Path | Purpose |
| --- | --- |
| `apps/desktop/` | Electron host, isolated renderer, preload, and dependency composition. |
| `packages/contracts/` | Shared interfaces, messages, validation, and error semantics. |
| `packages/core/` | Authorization, versioned documents, workflow, SQLite, inbox, and outbox. |
| `packages/ai/` | QVAC integration, embeddings, ranking, and grounded local summaries. |
| `packages/transport/` | Authenticated Pear/HyperDHT transport and bounded framing. |
| `harnesses/` | Independent development environments for adapters and application layers. |
| `fixtures/` | Synthetic evaluation and integration data. |
| `tests/` | Planned contract and application integration tests. |
| `verification/` | Executable Python design reference and its existing tests. |
| `docs/` | Architecture, technical decisions, and development tooling. |

## Development

Read [AGENTS.md](AGENTS.md) and the [engineering baseline](docs/development/engineering-baseline.md) before implementation. They define shared contracts, module ownership, independent harnesses, and integration acceptance criteria. [CONTRIBUTING.md](CONTRIBUTING.md) covers contribution conventions. [Graphify](docs/development/graphify.md) provides an optional local code graph for development; it is not KURO's document index or inference engine.

Generated graphs, model weights, private documents, credentials, and runtime databases are excluded from version control.

## Provenance and dependencies

The following pre-existing material forms the initial base of this submission:

- The architecture and Python design reference were developed during preparation of this same proposal on September 9, 2026, before repository creation, with Codex assistance. They are retained here under the KURO name.
- `verification/` contains that earlier reference implementation and its tests, using Python, unittest, and SQLite from the standard library. Repository paths, documentation, and synthetic example text have been updated.
- `verification/qvac-package-inspection.json` records static inspection of QVAC SDK 0.19.0. It is not evidence of runtime inference.
- The architecture draws on official QVAC, Pear, Electron, and SQLite documentation and public companion materials for *Generative AI Design Patterns* and *Building Applications with AI Agents*. Sources are listed in the architecture. Implementations from those books' repositories have not been incorporated.
- Graphify is third-party development tooling from [Graphify Labs](https://github.com/Graphify-Labs/graphify), distributed as `graphifyy`. Its pinned installation and local integration are documented separately. No Graphify source, third-party skill bundle, model weights, or generated graph is vendored into KURO.
- The space-state schema checker uses [python-jsonschema](https://github.com/python-jsonschema/jsonschema) 4.26.0 (MIT) as an isolated development dependency. KURO's D25 schemas, synthetic fixtures, and checking script were authored for this project; no authorization or transport implementation is supplied by that validator.
- The callable contract checkpoint adds Zod 4.6.1, Ajv 8.20.0 and `@noble/hashes` 2.4.0 (MIT); TypeScript 5.9.3 (Apache-2.0), tsx 4.23.13 and Node type definitions 24.13.4 (MIT) support development. These libraries provide validation, hashing and compilation, not KURO authorization. Application protocol source and synthetic conformance fixtures are newly authored. One root pnpm lockfile pins dependencies.
- The transport uses [HyperDHT 6.34.0](https://github.com/holepunchto/hyperdht) (MIT) and its pinned transitive network/cryptography modules through known-key APIs and authenticated `remotePublicKey`. Bare 1.32.0 runs the network worker; bare-runtime, bare-pipe 4.3.1 and bare-buffer 3.7.1 (Apache-2.0), plus esbuild 0.28.2 (MIT), provide its runtime/IPC/build support. See [D28](docs/decisions/D28-bare-network-worker.md). KURO framing, workers, policy and harness code are newly authored. Node's bundled SQLite supplies storage. No Python reference implementation was ported wholesale, and no model weights or external source documents are bundled.

- The AI adapter uses [QVAC SDK/inference 0.19.0](https://github.com/tetherto/qvac) (Apache-2.0), with pinned GTE/Qwen model descriptors and no bundled weights. Its source adapts the AI implementation introduced in PR #4 to the existing contracts. `require-asset` 1.2.2 (Apache-2.0) supplies Bare's explicitly installed runtime loader. Vitest 2.1.9 (MIT) runs adapter tests; Node runs the SQLite integration. See [D27](docs/decisions/D27-qvac-adapter-integration.md) for provenance, runtime boundaries and model validation.

- The desktop uses Electron 44.3.0, esbuild 0.28.2, @electron/packager 20.3.0 and Playwright 1.63.0 through the pinned workspace. `pnpm deploy --prod` stages the existing dependency graph for distribution; KURO's staging logic, isolated renderer, host safety boundaries, synthetic probes, and UI are newly authored. Native SDK packages remain external runtime dependencies, and no Electron template, model weights, documents, credentials, or generated package output is incorporated into source control. See [D29](docs/decisions/D29-desktop-integration.md).

Record the origin, version, and applicable license of any additional code, templates, models, or examples introduced during implementation. This repository remains private; no open-source license has been selected for KURO.

## Submission access

Reviewers must have repository access throughout evaluation. The demonstration video must be no longer than five minutes and accessible without credentials. A simulated workflow must be identified as simulated; the final submission must demonstrate the actual QVAC integration.
