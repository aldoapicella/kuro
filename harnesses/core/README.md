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

For the lost-ACK case, enable the fault before the approval pump so the approved response still arrives and only the requester's durable receipt acknowledgment is withheld:

```text
fault drop-ack
approve DRAFT_ID REVISION VIEW_DIGEST
pump
state
fault none
restart requester
advance 5000
refresh
advance 1000
pump
state
```

The first `state` includes a positive top-level `droppedAcks` count and requester evidence. The response is retried from immutable outbox bytes. `restart` is an orderly close/reopen within this single Node process; it demonstrates SQLite reopen/retry, not physical process-crash recovery. The independent real-transport loopback smoke command is `pnpm --filter @kuro/transport-harness smoke`.

For an authority outage and the original 15-minute lease boundary, run:

```text
fault disconnect
advance 900000
pump
state
fault none
advance 11000
refresh
advance 1000
pump
state
```

The first state shows the requester cannot use the expired projection; the later state is `CURRENT`. The 11-second advance expires the failed outage sync before creating a fresh one. A `refresh` without an outstanding sync schedules its first send one simulated second later; a `refresh` with an outstanding sync reuses that sync and its existing retry schedule. `advance` persists its simulated wall and monotonic time in `harness.json`, so an orderly restart or a later harness process cannot manufacture a clock rollback.

To show that a revoked approval is never revived by regranting membership, approve a draft but do not pump it first, then run:

```text
revoke
advance 5000
refresh
advance 1000
pump
regrant
advance 5000
refresh
advance 1000
pump
state
```

`regrant` restores the original `ALL` member capabilities through the owner `AppPort`; it does not alter the requester's local grants. The previously unsent approval remains cancelled, and a new request/review/approval is required. A `refresh` without an outstanding sync queues its first send for one simulated second later; advance 1,000 milliseconds before pumping it. After a policy change, advance 5,000 milliseconds before that refresh to respect the authority issuance limit.

Other commands: `state`, `revise <draft> <all|spanIds> <summary|none>`, `reviews`, `evidence <response>`, `summary <response>`, `revoke`, `regrant`, `refresh`, `advance <milliseconds>`, `restart <requester|custodian>`, `fault <drop-ack|disconnect|none>`, and `quit`. `summary` first shows that evidence remains readable when simulated generation is unavailable, then explicitly requests and runs the deterministic summary. `fault drop-ack` drops only decoded requester outbound `RESPONSE_ACK` frames and increments top-level `state.droppedAcks`; `fault disconnect` uses the simulated `MemoryNetwork` disconnect fault, and each `fault` command replaces the prior fault. These are single-process, simulated clock/network demonstrations: they do not establish real QVAC, Pear, physical-device, or process-crash behavior.

## VM network peer endpoint

`src/network-peer.ts` is a separate JSON-lines endpoint for local or virtual-network diagnostics. It opens one persistent `CustodyCore` over real HyperDHT in a Bare 1.32.0 worker, using an explicitly ephemeral synthetic seed. It defaults to `FakeAiPort`; set `ai: "qvac"` to inject the real local QVAC adapter through its public factory. This remains a test identity/pairing configuration in both modes. The [combined transport coordinator](../transport/README.md#combined-core-workflow-with-selectable-ai) runs the full scenario with either provider.

Install the frozen workspace and run `pnpm --filter @kuro/transport build:worker` on every host before launching this endpoint directly. For real QVAC, follow the [AI harness prerequisites](../ai/README.md), including native runtime prerequisites and cached model files before blocking external traffic. Start it locally or over SSH with `KURO_CORE_PEER_CONFIG` containing `stateDirectory`, a 64-hex-character `seedHex`, `pairedPeers`, `bootstrap` (`[{"host":"...","port":1234}]`), a 32-hex-character `memberId`, optional `ai` (`"simulated"` or `"qvac"`), and optionally a fixed UDP `localPort`.

It verifies the requested AI provider and emits `ready` with the actual HyperDHT public key and provider banner, then accepts sequential commands such as:

```json
{"requestId":"1","action":"verify","binding":{"kind":"peer","spaceId":"...","peerKey":"...","spaceAlias":"..."}}
{"requestId":"2","action":"selectText","text":"PERMITTED: synthetic text"}
{"requestId":"3","action":"app","method":"getState","input":{}}
{"requestId":"4","action":"tick"}
{"requestId":"5","action":"setDropAck","enabled":true}
{"requestId":"6","action":"diagnostics"}
{"requestId":"7","action":"setAiAvailable","available":false}
{"requestId":"8","action":"stop"}
```

`app` dispatches only a named public `AppCommands` method and returns its public `Result`. `approveDraft` is therefore possible only through an explicit command. `setDropAck` drops only outbound `RESPONSE_ACK` frames while recording bounded message type/digest diagnostics. `setAiAvailable: false` waits for current work to settle and closes the real QVAC runtime when selected; a later `true` creates a fresh real adapter. Evidence remains readable under its current permissions without invoking AI. Diagnostics include bounded AI calls and authorized rank-candidate IDs.

No automatic tick is scheduled; the controller sends `tick` when it wants retries, delivery, or queue work serviced. `tick` starts eligible computation without waiting for it to finish, so the controller polls public state until the index or summary completes. `stop` cancels/stops core work, stops transport and closes AI before acknowledging. The coordinator additionally requires clean peer process exit before reporting the test complete.
