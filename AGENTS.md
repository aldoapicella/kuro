# KURO agent instructions

These shared instructions apply throughout the repository. Read the [engineering baseline](docs/development/engineering-baseline.md) before implementation, then the relevant sections of the [architecture](docs/architecture.md). Nested instructions may add module-specific detail but must not weaken the shared boundaries. Follow explicit user instructions and higher-priority operating instructions when they conflict; identify any resulting architecture change.

## Before changing files

1. Inspect the current branch, working tree, and existing implementation. Preserve unrelated work. Documentation marked planned is not an implemented dependency.
2. State the module scope and acceptance checks for the task. Use public contracts and the relevant harness to work independently.
3. Check `packages/contracts/` before inventing an interface. If contracts are not implemented yet, follow the baseline's shared bootstrap checkpoint. Do not create private substitutes for public DTOs.
4. Use a focused `codex/` branch and a separate checkout/worktree when simultaneous tasks would otherwise share files. Never reset, force-push, or overwrite another contributor's work to resolve overlap.

## Mandatory implementation rules

- Use English and KURO in code, documentation, UI text, and synthetic fixtures. Keep personal assignments and staffing plans in ignored `local-notes/`.
- Maintain the product flow: custodian retrieval → local human review → approved evidence delivery → optional requester-local summary.
- Execute product inference through local QVAC. No cloud inference, automatic third-peer delegation, or fake inference presented as real.
- Keep authorization, the single SQLite writer, durable workflow, and the single persistent computation queue in `packages/core/`.
- The AI adapter computes over authorized inputs. The transport authenticates peer keys and moves bytes. Neither decides permissions or approves disclosure.
- The renderer uses a narrow `AppPort`. Never expose SQL, Node, arbitrary paths, sockets, worker creation, or SDK instances to it.
- Preserve default-deny policy, authorization before ranking, immutable approved bytes, durable receipt before acknowledgment, and the shared-space authority/freshness rules in [D25](docs/decisions/D25-shared-space-authority.md). See baseline requirements B01–B14.
- Import other packages only through their public exports. Put shared types, strict runtime validators, protocol constants, and observable error semantics in `packages/contracts/`.
- Treat changes to shared contracts, root tooling, dependency locks, fixtures used across modules, and public event semantics as integration changes. Publish them as a separate, reviewable checkpoint before dependent implementation. Preserve existing consumers or migrate them in the same change.
- Keep secrets, source documents, models, databases, generated graphs, and sensitive logs out of Git. Test with synthetic data. Never claim transport encryption encrypts the database.

## Before handing off

- Run the relevant contract suite and module harness, plus integration checks affected by the change. Test observable behavior and failure boundaries, not only mocks of internal calls.
- Distinguish simulated, real-adapter, and physical cross-device results. Report unavailable external checks explicitly; complete all independently testable work.
- Document public commands, configuration, migrations, limitations, and reused material. Update README provenance for incorporated external code or examples.
- Keep changes scoped, inspect the diff for unrelated edits and confidential data, and report exact validation outcomes. Do not claim a planned adapter works.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
