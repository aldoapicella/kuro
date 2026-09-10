# Contributing to KURO

Start with the shared [agent instructions](AGENTS.md), [engineering baseline](docs/development/engineering-baseline.md), and relevant [architecture](docs/architecture.md) sections. The baseline defines ownership, contracts and acceptance criteria. The TypeScript contracts, custody core and Node HyperDHT adapter are implemented alongside the Python design reference. Desktop and QVAC adapters integrate through the public ports.

## Module boundaries

- The renderer consumes `AppPort` through a narrow preload API. It does not receive Node, SQL, sockets, or arbitrary filesystem access.
- The core owns authorization, document versions, persisted workflow state, and the single logical SQLite writer. It consumes `AiPort` and `TransportPort`.
- The AI adapter receives authorized inputs and returns calculations. It cannot grant access, approve disclosure, or transmit evidence.
- The transport provides authenticated peer identity and bytes. It does not read the corpus or rebuild approved payloads.
- Shared contracts have runtime validation as well as TypeScript types. Real adapters and test doubles must satisfy the same observable contract.

Shared-space membership, verified device bindings, coarse capabilities and relationships belong to the pinned owner authority. Local policy authorities retain document grants, restrictions, reviewer rights and denials, and may only narrow the shared ceiling. Use the implemented direct-authenticated messages and freshness rules from [D25](docs/decisions/D25-shared-space-authority.md).

## Changes and dependencies

Use focused branches and small pull requests. Describe the resulting behavior, relevant validation, and unresolved limitations. Coordinate breaking interface changes before updating consumers; avoid importing another module's internal files.

Keep migrations and policy checks inside the core. Model/profile changes require compatible indexing and context handling. Pin application runtimes and dependencies after compatibility checks, and maintain one application lockfile when the workspace is configured.

Update the README provenance declaration when incorporating external code, templates, models, or examples. Use KURO consistently in project-facing text and write documentation, comments, and synthetic examples in English.

## Available validation

```sh
python3 verification/run_checks.py
```

This writes a generated local record to `verification/results.json`, which is ignored by Git. To run the reference tests without that record:

```sh
python3 -m unittest discover -s verification -v
```

Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm probe:host`, and `pnpm --filter @kuro/transport-harness smoke`. The [handoff](docs/development/core-transport-handoff.md) maps these checks to requirements. Scoped GitHub Actions cover Linux and macOS; local results do not claim a hosted workflow has run. Reference tests and simulations do not prove QVAC, Electron or physical cross-device operation.

Validate the D25 structural schema and synthetic fixtures with an isolated development dependency:

```sh
uv run --no-project --with jsonschema==4.26.0 python scripts/check-space-state-contract.py
```

This checks structural acceptance/rejection, canonical state digests, response-body digests, and frame sizes. It does not test authenticated fetch, persistence, revocation, or live lease enforcement.

## Local tooling and data

See [Graphify setup](docs/development/graphify.md) for installation, graph building, and queries. `AGENTS.md` is tracked so every checkout receives the shared baseline. Keep generated graph output, third-party assistant skill bundles, and local assistant configuration out of version control.

Use synthetic fixtures and separate private directories for each test identity. Keep keys, runtime databases, model weights, and user documents outside tracked files. `.gitignore` reduces accidental additions; it is not an access-control mechanism.
