# Core development harness

This scriptable two-node demonstration opens a custodian/owner and requester as two real `CustodyCore` instances, each with a separate persistent SQLite database. It deliberately configures `FakeAiPort` and `MemoryTransport`; it does not run QVAC, Pear, a physical two-device exchange, or a process-crash test.

After workspace dependencies are installed, use an empty state directory outside the repository:

```sh
pnpm --filter @kuro/core-harness harness -- --state /tmp/kuro-core-demo
```

The process accepts one command per line, interactively or from stdin. `init` creates the databases, verifies the authority/member and peer aliases through trusted single-use `FakePairing` tokens, configures membership/capabilities/relationship/local grants, synchronizes the requester projection, and imports synthetic text. It fails when the state directory is already initialized and never resets or deletes runtime data.

```text
init
submit What remains provisional?
pump
reviews
inspect DRAFT_ID
review-conditions DRAFT_ID summary
approve DRAFT_ID REVISION VIEW_DIGEST
pump
evidence RESPONSE_ID
summary RESPONSE_ID
quit
```

`inspect` prints the exact stored review, including the revision and digest required by `approve`; human approval is never automatic. The initial corpus contains `PERMITTED`, `RESTRICTED-SENTINEL`, and a similarly named `PERMITTED` document in another space. Only the first has requester `receive` permission, so neither the restricted sentinel nor the other-space text may appear in the review.

For the lost-ACK case, after approval run `pump 1` until the requester has received evidence (which queues its ACK), then run:

```text
fault drop-ack
pump 1
fault none
restart requester
advance 5000
refresh
pump
state
```

The response is retried from immutable outbox bytes and the requester retains one inbox evidence item. `restart` is an orderly close/reopen within this single Node process; it demonstrates SQLite reopen/retry, not physical process-crash recovery. The independent real-transport loopback smoke command is `pnpm --filter @kuro/transport-harness smoke`.

Other commands: `state`, `revise <draft> <all|spanIds> <summary|none>`, `reviews`, `evidence <response>`, `summary <response>`, `revoke`, `refresh`, `advance <milliseconds>`, `restart <requester|custodian>`, `fault <drop-ack|none>`, and `quit`. `summary` first shows that evidence remains readable when simulated generation is unavailable, then explicitly requests and runs the deterministic summary. `advance` changes only the deterministic clocks; run `pump` to service expiry/retries. During an authority outage, `advance 900000` followed by `pump` lets the requester lease expire; new work stays blocked until `refresh` succeeds. After `revoke`, `refresh` installs denial and an unsent delivery is cancelled rather than dispatched.
