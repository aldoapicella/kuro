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

## VM network peer endpoint

`src/network-peer.ts` is a separate JSON-lines endpoint for the virtual-network diagnostic. It opens one persistent `CustodyCore` over real HyperDHT using an explicitly ephemeral, synthetic seed and `FakeAiPort`; it is neither a QVAC nor a production identity configuration. Start it over SSH with `KURO_CORE_PEER_CONFIG` containing `stateDirectory`, a 64-hex-character `seedHex`, `pairedPeers`, `bootstrap` (`[{"host":"...","port":1234}]`), a 32-hex-character `memberId`, and optionally a fixed UDP `localPort`.

It emits `ready` with the actual HyperDHT public key, then accepts sequential commands such as:

```json
{"requestId":"1","action":"verify","binding":{"kind":"peer","spaceId":"...","peerKey":"...","spaceAlias":"..."}}
{"requestId":"2","action":"selectText","text":"PERMITTED: synthetic text"}
{"requestId":"3","action":"app","method":"getState","input":{}}
{"requestId":"4","action":"tick"}
{"requestId":"5","action":"setDropAck","enabled":true}
{"requestId":"6","action":"diagnostics"}
{"requestId":"7","action":"stop"}
```

`app` dispatches only a named public `AppCommands` method and returns its public `Result`. `approveDraft` is therefore possible only through an explicit command. `setDropAck` drops only outbound `RESPONSE_ACK` frames while recording bounded message type/digest diagnostics. No automatic tick is scheduled; the VM controller sends `tick` when it wants retries, delivery, or queue work serviced.
