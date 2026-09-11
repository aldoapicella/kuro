# D31 — Desktop setup and administration contracts

The existing AppPort mutations remain the authority for setup and permissions. This
checkpoint adds the missing read models and trusted desktop operations before their
GUI consumers. Wire v1, the single SQLite writer, and the computation scheduler are
unchanged. An invitation or paired transport key never grants document access.

## Administration views

`getSpaceAdministration` returns an owner-only directory with devices, denial
tombstones, shared capabilities, expiry and allowed relationships. A participant
receives only its current recipient projection. The two output variants are strict
discriminated schemas; the participant variant cannot contain the owner's directory.

`getLocalGrants` and `getDocumentRules` require the custodian-local administrator.
They expose explicit local restrictions and their correct mutation revisions, not
source paths or SQL. A locally denied member can remain visible for deliberate
re-admission only while the shared ceiling still admits that identity. Shared policy
uses `policyRevision`, local grants use `policyEpoch`, and document rules use the
document revision. No screen may substitute one counter for another.

`revokeDevice` removes one linked key from future authorization while retaining its
denial binding. It uses the same atomic shared-policy invalidation as member
revocation. Other device keys belonging to the member remain separately eligible.

Clock uncertainty rejects these administration reads. Recipient projections and
custodian-local permission reads additionally need a current shared lease; cached
stale membership is not an available directory or a permission fallback.

## Trusted desktop surface

DesktopHostPort gains explicit profile/network setup, start/stop, model preparation,
cancellation and status commands. Configuration accepts bounded bootstrap endpoints
and ports. Model commands accept only `embedding` or `summary`; the host selects the
pinned URL, size and checksum. Renderer input cannot select a model URL, local path,
acting identity, runtime binary, worker or IPC channel.

Setup status contains the app version, source commit when known, protection status,
runtime state, available disk bytes and bounded model transfer states. Content-free
recovery commands are identified separately so a failed native prerequisite can be
explained and corrected without exposing protected application state.

Invitation and enrollment exports name an existing space. The host derives identity
and keys from the bound runtime and uses native file selection. Imports continue to
use single-use `VerifiedPairingPort` tokens after explicit comparison of the entire
binding tuple over a separate trusted channel. Enrollment and local grants remain
subsequent independent AppPort actions.

A linked device must share its operator's logical member ID while keeping its own
protected transport seed. The desktop surface therefore includes native export and
verified selection of a public identity association. It contains no private key.
Selection is allowed only before a new profile has established its identity and
cannot overwrite an existing protected record. The renderer never supplies the
member ID used by SessionPort. Owners still verify and enroll the new device key.

The demo compatibility host returns explicit unavailable/denied results for setup
operations. Declaring these contracts does not claim the real setup UI, downloads,
or a distributable release has passed. Those are separate implementation and
end-to-end acceptance checkpoints.
