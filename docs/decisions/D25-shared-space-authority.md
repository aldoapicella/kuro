# D25 — Shared space administration with bounded offline permissions

Status: **accepted design; runtime implementation pending**. Adopted September 10, 2026. This decision extends D19–D21 and the [engineering baseline](../development/engineering-baseline.md). It defines shared membership administration for the MVP; it does not replace a custodian's local document authority.

## Decision and rationale

One designated KURO device is the administrative authority for each private space. Its core owns authoritative membership, verified device bindings, coarse space capabilities, and which peers each member may discover. Other devices obtain recipient-scoped snapshots directly from that pinned authority over authenticated Pear/HyperDHT connections and cache them in their own SQLite database.

The authority is an ordinary installation and may also be a custodian or requester. The two-device demonstration needs no extra server. A deployment may choose an always-available organization-owned device later. A cloud metadata service is allowed by the competition's non-inference rule, but is not required by this design and would hold sensitive membership information.

One writer avoids competing membership updates. Direct authenticated retrieval avoids a new application signing/key-distribution protocol. Replication through other participants, application-signed exports, multi-owner administration, automatic authority election, and CRDTs are deferred. A cache is not an alternative authority and may not issue or renew permissions.

## 1. Authority boundaries

| Authority | May change | Cannot grant |
| --- | --- | --- |
| Shared space owner, acting locally on the pinned authority device | Membership, verified device keys, coarse `search/read/share/receive/manage` capabilities, allowed peer relationships | A custodian's document rights, disclosure approval, or access to their originals |
| Custodian-local policy authority | Its own grants/restrictions, reviewer rights, and local denials | Space membership, another custodian's rights, or permission beyond the shared capability ceiling |
| Ordinary participant | Its authorized local actions and requests | Membership changes through a network message or a replacement authority key |

The owner is a dedicated authority binding, not a consequence of having `manage`. Owner creation gives no implicit `read`, `share`, or `receive` rights. Initial capabilities and local document grants are explicit. All shared administration is local to that authority device in the MVP; other devices show read-only shared settings. Local `manage` continues to mean management only within the custodian's delegated scope.

For shared-space operations, effective access is the intersection of:

```text
verified device and valid local operator session
AND current, unexpired authority snapshot admitting the member/device/action
AND recipient's authorized peer relationship for the operation
AND custodian-local membership/denial overlay and explicit action grants
AND document restrictions, scope, versions, and validity
AND human approval when disclosing evidence
```

A custodian may deny a shared member locally. It cannot use a local membership row to add someone missing from its authority snapshot. The AI and transport never decide these rules. Shared owner compromise can change the shared ceiling but cannot bypass local grants and human review; it remains a serious trust-root compromise requiring recovery.

## 2. Enrollment, pairing, and metadata visibility

1. Creating a space generates a random 128-bit `spaceId` and records the creator's owner identity and authority transport key. One active authority key is pinned per space. The core stores a mapping between this shared space and the local space record.
2. Setup exchanges the authority key/fingerprint and a recipient-specific opaque `spaceAlias` out of band. An invitation is a locator for a proposed trust relationship, not membership or proof of a person's identity.
3. The owner verifies a joining member and the exact device key through the setup channel. The joining device verifies the authority. The owner commits membership, device binding, explicit capabilities, and allowed peer relationships locally. A changed key requires another verified binding; display names cannot substitute for it.
4. The joining device synchronizes directly with the authority. It validates and installs the snapshot before shared-space operations become available. There is no remote self-enrollment or `manage` escalation command.

The authority stores the full space directory. Each recipient receives a **complete projection for that recipient**, containing itself and only the members with which the owner permits it to communicate. Allowed relationships are explicitly configured; authorizing a relationship gives each endpoint the other's minimal identity/key/capability record. It never grants document access. The authority can provide these bindings as the trusted introducer; participants do not need pairwise manual enrollment with every member.

No display names, organization labels, email addresses, private document ACLs, source paths, document identifiers, or document counts enter these snapshots. Members are represented by opaque IDs, public device keys, and capabilities. The authority can still observe the full relationship graph; each participant learns its permitted neighborhood. A node denies omitted peers rather than requesting arbitrary directory pages. Removing a peer from the complete projection removes its cached shared authorization.

The MVP projection is limited to 16 member entries including the recipient, four device keys per member, and the existing five capability names. Never truncate a projection and label it complete. If the authorized neighborhood exceeds the limit, fail issuance and require a smaller configured space; no pagination or partial authorization merge in v1.

## 3. Local persistence and revision domains

All following records belong to `packages/core/` and its one SQLite writer. These are logical schema responsibilities; the implementation migration may normalize them without changing the observable contract.

| Records | Authority device | Participant device |
| --- | --- | --- |
| `space_authorities` | Local/shared space mapping, owner identity, authority key, pairing aliases | Pinned authority key, local/shared space mapping, authority-specific alias |
| Shared membership / allowed peer relationships | Authoritative members, verified device keys, capabilities, scheduled expiry, allowed relationships | Read-only materialized recipient projection; no independent writer |
| `space_state_publications` | Per-space policy revision, per-recipient publication sequence, exact responses for request deduplication | Not writable by the participant |
| `space_state_cache` | Optional local projection evaluated from the same authoritative tables | Latest projection, digest, counters, last accepted response bytes, validity evidence, and sync state |
| Existing grants / restrictions | Custodian-local policy | Custodian-local policy, separate from the shared cache |

Private authority/device keys remain in host-provided protected secret storage. Snapshots and public-key mappings are sensitive application metadata stored outside distributed application code. Transport encryption does not encrypt SQLite.

Two independent counters prevent renewal from masquerading as a policy change:

- `policyRevision`: a per-space positive safe integer, incremented in the same transaction as every effective membership, capability, device-binding, or relationship change. Scheduled changes must be applied before issuance, and an issued lease cannot outlive any included permission's scheduled expiry.
- `publicationSeq`: a per `(spaceId, authorityKey, recipientKey)` positive safe integer, incremented for each newly issued response, including an unchanged renewal or a denial. It does not change `policyRevision`.

Existing `policyEpoch` remains the local effective-policy revision. Installing a changed shared policy increments it and invalidates dependent work atomically; an unchanged renewal does not. `corpusRevision`, `indexGeneration`, and draft revisions keep their existing meanings. Counter exhaustion fails closed rather than wrapping.

On the authority device itself, core may evaluate current authority tables with the same projection and intersection rules without opening a network connection to itself. Apply due permission expiry and the clock gate before authorizing; local ownership is never an exemption from explicit capabilities, document grants, or review.

## 4. Two additional wire messages

Protocol `v: 1` gains `SPACE_STATE_REQUEST` and `SPACE_STATE_RESPONSE`. The [JSON Schema](../../packages/contracts/schemas/space-state-v1.schema.json) is the normative structural definition. [Fixtures](../../fixtures/contracts/v1/space-state/README.md) provide concrete examples. This addition does not implement the remaining five evidence-protocol schemas.

Both messages use the existing four-byte big-endian frame prefix and 32,768-byte body limit. Strict parsing rejects invalid UTF-8, duplicate JSON object keys, extra properties, and oversized frames. SHA-256 values and 32-byte public keys use exactly 64 lowercase hexadecimal characters. New request/member/space IDs and this authority's aliases use exactly 32 lowercase hexadecimal characters. Random identifiers require 128 bits of cryptographic randomness.

`SPACE_STATE_REQUEST` contains only `v`, `type`, `requestId`, and `spaceAlias`. It asks for the authenticated requesting device's complete projection; the requester cannot select another recipient, assert a newer revision, upload policy, or name a method to execute.

`SPACE_STATE_RESPONSE` contains:

| Field | Meaning |
| --- | --- |
| `v`, `type`, `requestId`, `spaceAlias` | Version, discriminant, and exact request correlation |
| `spaceId`, `authorityKey`, `recipientKey` | Must match the pinned space/authority and authenticated requesting device; body fields never create trust |
| `policyRevision`, `publicationSeq` | Current shared policy and publication sequence for this recipient |
| `projectionScope` | Constant `recipient-authorized-peers-v1`; no arbitrary scopes in the MVP |
| `status` | `ACTIVE` or `DENIED`; denial carries no reason or directory entries |
| `validForMs` | `1..900000` for active state; `0` for denial. The recipient anchors it to the original sync request's send time, not response arrival. |
| `members` | Complete authorized projection; denial uses an empty array |
| `projectionDigest` | SHA-256 of the canonical state object described below |

Each member contains `memberId`, `deviceKeys`, and `capabilities`. In an active projection the requesting device key appears exactly once, under its member. Member IDs and device keys are globally unique within the projection. Capability and device-key arrays contain no duplicates. All members are currently active; omitted members or capabilities mean deny. There is no implicit right from an empty array or missing object.

The canonical digest object uses this exact property order:

```text
spaceId, authorityKey, recipientKey, policyRevision, projectionScope, status, members
```

Each member object uses `memberId, deviceKeys, capabilities` in that order. Sort members by `memberId`, keys lexicographically, and capabilities by `search, read, share, receive, manage`. Serialize compact JSON without whitespace or trailing newline, as UTF-8; all accepted strings here are ASCII. Hash those exact bytes. The request ID, publication sequence, alias, and lease duration are outside this **state** digest, so unchanged renewal preserves it. A separate stored digest of the exact response body detects conflicting responses/retries. A digest is not an authentication mechanism or a signature.

## 5. Authority issuance and recipient installation

The authority validates the transport-authenticated key and `(key, spaceAlias)` binding before reading membership. Only the pinned owner may mutate authority tables through authorized local commands. These network messages expose read-only synchronization.

Within a short writer transaction, the authority applies due policy expiry, reads current state, increments the recipient publication sequence, constructs the complete projection, and persists exact response bytes with `UNIQUE(peerKey, requestId)` and the validated request digest before sending. No network wait occurs inside the transaction.

An identical request retry never mints a new response or renews permission. Before every send, including retries, recheck that the stored response still matches current policy and scheduled validity. If so, return the stored bytes with the same sequence and duration. If policy changed or the recipient is no longer eligible, close generically and require a new request ID for current state; do not rewrite an old response or resend its stale member list. Reusing an ID with different fields is invalid. Retain issuance/deduplication records for at least 24 hours; do not reissue an old ID inside that interval. Expired records can be purged; a new admitted request always evaluates current policy, including revocation. Authority rate limits apply before issuance. As with evidence dispatch, changes after send authorization may not intercept bytes in transit.

A previously verified but now removed device may receive `DENIED` for its own known binding, without member entries. Keep that binding as a denial-only tombstone. Unknown keys or aliases receive a generic closure, without confirming a space or revealing any roster. Ordinary evidence traffic remains denied. Serving a denial does not reactivate membership.

The receiver accepts a new response only from a direct authenticated connection to its pinned authority, for an outstanding sync request, its exact alias/shared space, and its own authenticated device key. A member relaying copied JSON is not an authority. It validates schema, canonical digest, complete-projection semantics, and counters before installation. `ACTIVE` also requires a positive remaining lease. `DENIED` has zero duration and installs durable denial without requiring a positive lease, but still requires valid request correlation and counters.

In one transaction, persist the accepted response, materialized projection, counter high-water marks, validity data, and resulting effective-policy changes. Emit UI/state notifications only after commit. Failed storage leaves prior state and prior expiry unchanged.

- Reject lower `publicationSeq`, lower `policyRevision`, or a conflicting body for an equal publication sequence. High-water marks survive restart and cache expiration.
- A new publication with the same policy revision must have the same projection digest; otherwise reject it as inconsistent authority state. A higher policy revision may legitimately leave this recipient's content unchanged.
- An exact duplicate of an already accepted response is harmless and never extends expiry. Unsolicited or no-longer-outstanding positive responses cannot install or renew state.
- Install higher valid policy revisions atomically and conservatively invalidate pending space work. Missing members/actions are removed, not merged with the old cache. Install `DENIED` as a durable deny state until a newer valid active response; denial does not turn into permission when time passes.

## 6. Freshness, outages, and restarts

Constants for the MVP: maximum lease **900,000 ms (15 minutes)**; sync response timeout **10,000 ms**; normal refresh every **60,000 ms**, with additional random jitter up to **10,000 ms**. There is one outstanding synchronization per space/device. After failure use bounded backoff up to 60 seconds and never extend cached validity. Metadata sync uses a small separate bounded network-control queue, never a QVAC execution slot. The authority allows at most one fresh issuance per paired device/space per five seconds; duplicates reuse a bounded existing response.

Record wall and monotonic time when sending the **first** request attempt. Retries retain these anchors. The deadline is:

```text
monotonicDeadline = originalSendMonotonic + validForMs
wallDeadline      = originalSendWall      + validForMs
```

Positive state is usable only while both deadlines remain in the future. Response transit and retries consume the lease; arrival does not start a new 15-minute period. The authority computes `validForMs` as at most 900,000 and at most the remaining lifetime of every included membership/capability/relationship. It does not return a lease that crosses a scheduled removal. Request timeout consumes the outstanding request; the next attempt uses a new random ID and new correlation state.

The MVP deliberately treats positive cache entries as **STALE after process restart or system suspend/resume**, even if their stored wall deadline appears future. Preserve the projection and high-water marks for display/rollback checks, but require a fresh authority sync before using them to authorize operations. This avoids extending permission across an uncertain clock/process epoch. The core owns a `clockEpochValid` gate checked at every protected operation, including final dispatch authorization. It is closed at startup and suspend; the host must keep content callbacks/scheduling gated through resume until the core atomically marks positive caches stale. The core opens the clock gate only after clock validity is established; each space still needs a fresh valid snapshot. Authority sync and non-content status/recovery operations remain available. Verify this lifecycle barrier on the target runtime; a best-effort resume notification alone is insufficient. If clock/lifecycle validity is uncertain, keep the gate closed. Both deadlines are checked again at every protected operation.

Clock rollback or uncertain clock validity similarly invalidates positive state. Persist a wall-clock high-water mark at security-relevant writes; the authority must not issue new leases after detected clock rollback until local time validity is restored. A trusted, uncompromised host remains an assumption.

While the authority is unreachable, a running device may continue already authorized peer operations only within its remaining valid lease. At expiry or received denial, block new peer requests, retrieval, review/approval, receipt of new evidence, dispatch attempts, and optional synthesis in that shared space; cancel active jobs and discard late outputs. The stored data is not erased. Local maintenance that cannot expose content, and synchronization with the authority, remain available. Displaying existing evidence still requires current local/shared access and delivery conditions; lack of an AI model alone never blocks it.

Apply changed policy in the same core writer used by approval/dispatch. Invalidate pending requests/jobs, reviews, and unsent deliveries conservatively. Unsent revoked approvals cannot be resurrected by a later regrant; re-review is required. An unchanged renewal before expiry does not invalidate work. After a lapse, fresh state allows new work but never silently resurrects obsolete approval or cancelled results.

Do not delete an accepted inbox or deduplication record when access expires. A content-free acknowledgment of an already persisted delivery may be retried to its original authenticated sender if correlation remains valid; it grants no new access. A first-time delivery received without current permission is not accepted or acknowledged as persisted evidence.

Revocation unknown to an offline device cannot take effect before synchronization or expiration. The 15-minute bound applies to the remaining issued lease under valid clocks, not to deletion of delivered copies. Changes after a dispatch attempt's authorization point may not intercept bytes already in transit. This is bounded offline authorization, not globally instantaneous revocation.

## 7. Recovery and user-visible states

Normal authority restarts preserve the same key, policy data, and counters. If restoring/loss of storage may roll counters or policy back, the old authority identity must not resume issuance. Recovery for the MVP creates a new random shared `spaceId` and a new authority key, followed by explicit owner-led pairing on each participant. All counter high-water marks and publication/cache records are scoped to `(spaceId, authorityKey, recipientKey)`; retain the old tuple as a tombstone. Counters may start at 1 only in the new namespace. Explicitly remap the local space, bump its effective policy epoch, and invalidate old pending work and aliases. Preserve local documents and local restrictions; do not rewrite old deliveries' provenance or turn old approvals into new-namespace approvals. No automatic trust in successor keys, self-signed handovers, backup promotion, or silent counter reset. This sacrifices availability when the owner device/key is lost; production recovery is deferred.

The desktop shows `UNPAIRED`, `SYNCING`, `CURRENT`, `OFFLINE_VALID`, `EXPIRED`, `DENIED`, or `STALE`, with last successful sync and remaining permission validity. A network icon alone must not imply current permission. An owner can manage membership locally; other participants see their authorized projection and request a refresh. When a lease lapses, clearly explain that the authority must be reached; do not imply the documents disappeared.

## 8. Integration scope and acceptance criteria

`packages/contracts/` owns the two schemas, formats, limits, validation errors, and fixtures. `packages/core/` owns authority commands, publication, cache installation, expiry, and intersection with local policy. `packages/transport/` carries the messages with authenticated keys and bounds; it cannot mutate grants. `apps/desktop/` supplies pairing verification, owner administration, read-only participant state, and clock/lifecycle notifications. `AiPort` remains unchanged.

The runtime implementation must demonstrate:

1. One owner enrolls a verified device; the participant installs its projection and only then performs an allowed peer request.
2. An owner-issued broad capability cannot bypass local document restrictions or human approval. A non-owner with `manage` cannot alter shared membership.
3. A missing peer, duplicate member/device key, wrong authority, wrong recipient/alias/space, inconsistent state digest, or unsupported scope is rejected.
4. An eligible exact sync-request replay returns identical response bytes; an intervening policy change closes the obsolete response without rewriting or resending stale state. Response replay, delay, reconnection, and request retries never move the original lease deadline.
5. A newer sequence with unchanged policy renews without cancelling work; policy mutation invalidates pending work. Lower counters and conflicting equal counters fail after restart too.
6. A dropped response or injected SQLite failure does not install or extend permissions. A removed paired device receives only denial; unknown peers learn no directory.
7. Authority loss permits operations before lease expiry and blocks them at expiry. Restart, suspend/resume, and clock rollback require fresh sync. Queue a dispatch across resume and prove the clock gate blocks it before any content callback is admitted. Scheduled membership expiry shortens the issued lease.
8. Restored authority storage cannot silently roll back identity/counters. A new shared-space/key namespace permits counters starting at 1 only after explicit pairing; old bindings and approvals cannot revive.
9. Each recipient learns only its configured neighborhood; an oversized projection fails issuance rather than silently dropping restrictions.
10. A two-process real Pear check authenticates the authority fetch. Physical offline LAN operation and QVAC inference remain separate integration gates.

The JSON Schema and fixture checks validate only structure and digest examples. They do not prove authentication, transaction ordering, expiry enforcement, replay resistance, or real P2P behavior. The existing Python design-reference suite also does not test this new protocol.

## Sources and limits

- [HyperDHT reference](https://docs.pears.com/reference/building-blocks/hyperdht/) documents known-key encrypted connections and authenticated remote keys; it does not provide KURO's membership policy.
- [Libsodium signature documentation](https://libsodium.gitbook.io/doc/public-key_cryptography/public-key_signatures) distinguishes origin verification from encryption. Application signatures are deferred while authority snapshots are fetched directly.
- [TUF specification](https://theupdateframework.github.io/specification/) motivates separate rollback and expiry checks for authenticated metadata. This is a design analogy; KURO does not implement TUF or claim its guarantees.

The 15-minute lease, refresh schedule, projection limits, restart behavior, and two-message exchange are KURO MVP decisions, not properties guaranteed by these libraries.
