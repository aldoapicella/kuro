# KURO

Local AI and peer-to-peer collaboration for confidential knowledge.

KURO lets participants query information held by trusted peers while each custodian retains control of their original documents. A custodian retrieves relevant passages locally with QVAC, reviews the proposed disclosure, and sends only approved evidence. The recipient can read that evidence and optionally summarize it on their own device.

## Project status

Architecture and executable design reference. The Electron application, QVAC inference adapters, and Pear transport are not implemented yet. The Python reference tests exercise authorization and delivery invariants; they do not validate a production application or a working QVAC/Pear integration.

## Design principles

- **Local inference:** embeddings and optional generation run through QVAC on the participating devices.
- **Explicit disclosure:** access checks precede retrieval; an authorized reviewer approves the exact content and recipient.
- **Source custody:** original documents and indexes stay with their custodian. There is no shared global index.
- **Traceable evidence:** references identify the origin, document version, and passage. Generated summaries remain distinct from received evidence.
- **Durable delivery:** approval and outgoing bytes commit together; retries preserve those bytes and receivers deduplicate deliveries.
- **Bounded processing:** receiving evidence does not automatically start a model or authorize forwarding it to another peer.

See the [technical architecture](docs/architecture.md) for contracts, tradeoffs, threat boundaries, and validation requirements.

## Getting started

```sh
git clone https://github.com/aldoapicella/kuro.git
cd kuro
python3 verification/run_checks.py
```

Repository access requires an authorized GitHub account. The reference checks use the Python standard library. Use Python 3.12 for the development tooling; see [Graphify setup](docs/development/graphify.md) for an isolated installation.

Application build commands and dependency versions will be established when the runtime compatibility checks pass. The module directories currently document their intended boundaries and are not installable packages.

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

Record the origin, version, and applicable license of any additional code, templates, models, or examples introduced during implementation. This repository remains private; no open-source license has been selected for KURO.

## Submission access

Reviewers must have repository access throughout evaluation. The demonstration video must be no longer than five minutes and accessible without credentials. A simulated workflow must be identified as simulated; the final submission must demonstrate the actual QVAC integration.
