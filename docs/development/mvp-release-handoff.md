# Desktop MVP release acceptance

This is the running acceptance record for the desktop MVP. The baseline is
`c7968ff2bbece827cd483ddf2e3bd683c2e01ab0`; its GitHub Actions run
`34572682445` passed on macOS and Linux. PRs 1–11 are merged. No versioned
GitHub release existed at the start of this work.

The release target is macOS arm64 on the qualified macOS 26.5 / Darwin 25.5.0 /
25F71 build. Linux remains a CI platform until its protected lifecycle is qualified.
The initial distribution will be an explicitly unsigned preview unless signing and
notarization credentials become available. There are no repository Actions secrets
in the inspected baseline. Existing native wake evidence is recorded in D30 and is
not a substitute for the complete real GUI workflow.

| Acceptance area | Baseline / remaining verification |
| --- | --- |
| Fresh profile and protected identity | Real host exists; first-run GUI required. |
| Create/join, invitation, verification, linked devices | Core mutations exist; usable trusted desktop flows required. |
| Shared membership, capabilities, relationships, expiry | Core enforcement exists; administration read models and screens required. |
| Local grants and document restrictions | Core enforcement exists; separate desktop controls required. |
| Network setup and actionable recovery | External JSON currently required; GUI configuration and private LAN hosting required. |
| Model preparation | Explicit download, disk check, progress, checksum, cancellation and retry required. |
| Real GUI custody | Actual QVAC/Bare core harness passed previously; complete fresh GUI setup through summary is pending. |
| Failure boundaries | Existing core/UI suites retained; meaningful setup, revision, expiry, revocation, restart and model-free reading checks required. |
| Offline GUI run | Previous Linux VM namespace core test is separate evidence; packaged GUI run with egress controls is pending. |
| Packaging | Existing directory/probes passed; clean environment, native dylib independence, install, relocation and upgrade remain. |
| CI | Existing Linux/macOS jobs pass; consistent required results, useful reports and expanded package checks required. |
| CD and versioning | Versioned tested artifacts, checksums, reviewed changelog, commit association, publication gates and first preview release required. |
| Human / physical claims | Automated approvals are test actions; virtual networks and scripted lifecycle checks must remain labeled. |

Completion will require an audit of every area above on the final source and the
same bytes published as the downloadable preview. Planned work and individual probes
do not establish release acceptance.
