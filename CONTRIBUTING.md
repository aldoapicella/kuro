# Contributing to KURO

Start with the [architecture](docs/architecture.md). This repository currently contains design documentation, module boundaries, and a Python reference model. The application adapters remain to be implemented.

## Module boundaries

- The renderer consumes `AppPort` through a narrow preload API. It does not receive Node, SQL, sockets, or arbitrary filesystem access.
- The core owns authorization, document versions, persisted workflow state, and the single logical SQLite writer. It consumes `AiPort` and `TransportPort`.
- The AI adapter receives authorized inputs and returns calculations. It cannot grant access, approve disclosure, or transmit evidence.
- The transport provides authenticated peer identity and bytes. It does not read the corpus or rebuild approved payloads.
- Shared contracts have runtime validation as well as TypeScript types. Real adapters and test doubles must satisfy the same observable contract.

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

Application tests must be added with their implementations. Reference-model tests and mock-backed harnesses do not prove that QVAC, Pear, Electron, or cross-device operation works.

## Local tooling and data

See [Graphify setup](docs/development/graphify.md) for installation, graph building, and queries. Keep generated graph output and local assistant integration out of version control.

Use synthetic fixtures and separate private directories for each test identity. Keep keys, runtime databases, model weights, and user documents outside tracked files. `.gitignore` reduces accidental additions; it is not an access-control mechanism.
