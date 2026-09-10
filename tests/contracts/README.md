# Contract conformance tests

Planned alongside `packages/contracts/`: format and behavior checks shared by real and simulated providers. Cover the five evidence messages plus `SPACE_STATE_REQUEST`/`SPACE_STATE_RESPONSE`, canonical digests, recipient binding, `policyRevision` versus `publicationSeq`, lease anchoring, replay/counter rejection, lifecycle stale state, errors, cancellation, identity, and persistence before acknowledgment. Existing design-reference tests reside in `verification/`; D25 notes which state checks still require runtime implementation.

The initial D25 structure/digest check is available in [scripts/check-space-state-contract.py](../../scripts/check-space-state-contract.py). Its [synthetic fixtures and command](../../fixtures/contracts/v1/space-state/README.md) are reusable inputs for future runtime conformance suites, not a replacement for them.
