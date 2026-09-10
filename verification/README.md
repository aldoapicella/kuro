# KURO design reference

This directory expresses a subset of the architecture as executable contracts: permissions, evidence dependencies, approval, and delivery. It is not a QVAC application, working peer-to-peer prototype, or production security implementation.

## Run

From the repository root:

```sh
python3 verification/run_checks.py
```

The checks use Python and SQLite from the standard library without external packages or network access. Python 3.12 is the recommended development runtime. The command writes `verification/results.json` with test names, outcomes, runtime versions, and SHA-256 hashes of the inspected source and architecture document.

Alternatively, run `python3 -m unittest discover -s verification -v` without generating the record.

## Covered by the reference model

- A matrix of 256 combinations of identity, membership, permissions, document access, and validity.
- No implicit content access through `manage`; only the configured policy authority can satisfy the predicate for broadening content grants.
- Restrictions inherited from every source exposed to a model, including uncited sources.
- Space scope, source versions, question audience, and passage identifiers.
- Exact quotes reconstructed from the registered source version.
- Rejection of dispatch without approval, stale reviews, and duplicate approval.
- Transaction rollback when a failure occurs between approval and outbox insertion.
- Persistence of exact approved bytes across SQLite close/reopen and transport retries.
- Deduplication and rejection of a different peer, space, or payload for the same identifier.
- Revocation before a new dispatch attempt and the limit of control over bytes already handed to transport.

## Not covered

The chosen architecture uses embeddings and a permission-filtered index at the custodian, followed by approved evidence delivery and optional local synthesis at the requester. The 16 reference tests cover the earlier citation, permission, and delivery contract. They do not execute embeddings, retrieval SQL, ranking, index updates, received processing conditions, claim schemas, or semantic-support evaluation. Queueing, concurrency, and memory behavior are also untested.

Identity is abstracted and policy is a trusted input to the model. There is no permission-management UI, network decoder, or QVAC worker. The reference inbox is an in-memory dictionary and does not prove persistence before ACK. Reopening SQLite is not a power-loss or process-crash test during commit.

The TypeScript implementation must read current policy and state in the same SQLite writer transaction. The reference dispatcher reconstructs bytes only to detect inconsistent test inputs; the application dispatcher must validate dependencies and send persisted approved bytes without regeneration.

`qvac-package-inspection.json` is a static inspection record for the published SDK package 0.19.0. Declarations and checksums are not inference results.

## Provenance

This reference code and its tests were written during preparation of the KURO proposal before repository creation, with Codex assistance. They use Python, unittest, and SQLite from the standard library. The architecture applies concepts from the official public companion materials of *Generative AI Design Patterns* and *Building Applications with AI Agents*, cited in the architecture. No implementations from those repositories were copied.
