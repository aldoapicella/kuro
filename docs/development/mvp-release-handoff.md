# Desktop MVP release acceptance

This is the current release record for desktop preview `0.1.0-preview.1`. The
last complete remote CI checkpoint is `2c4f2e8`; all four Linux/macOS push and
PR jobs passed, including the trusted-runner guard checks. Documentation-only
checkpoint `667068c` also passed all four jobs.
Offline GUI infrastructure and the protected ephemeral release runner are being
validated before integration. No release dispatch or artifact publication has run.

The release target is macOS arm64 on the qualified macOS 26.5 / Darwin 25.5.0 /
25F71 build. Linux is a CI platform only.
The preview is ad-hoc signed, not Developer ID signed or notarized. Existing
native wake evidence is recorded in D30 and is not a substitute for the complete
real GUI workflow.

| Acceptance area | Current evidence | Release status |
| --- | --- | --- |
| Fresh setup and protected identity | GUI profile setup, private bootstrap/UDP choices, start/retry/stop, and protected keychain identities exist. SecurityAgent approval remains a manual macOS action. | Final packaged run pending. |
| Spaces and linked devices | Owner create, join, enroll, pairing verification, invitation/enrollment export, identity linking, and public identity export are in the GUI. | Final expanded GUI pass pending. |
| Permissions | Shared membership, local grants, relationships, and per-document action/expiry rules have desktop controls. Default deny applies; restricted and cross-space content is excluded. | Source and earlier candidate workflow passed; final archive qualification pending. |
| Model preparation | GUI downloads QVAC GTE (669,603,712 B) and Qwen (1,056,782,912 B), with progress, SHA-256 validation, cancel, and retry. Source GUI downloads passed in 20,688.56 ms and 30,870.75 ms respectively, including actual cancellation, retry, and hash verification. Weights are not bundled. | Final release package must include the latest re-hash-before-SDK-load fix. |
| Source real GUI custody | The expanded two-process loopback workflow on `b762992` passed in 57.8 seconds with actual QVAC, Bare, SQLite, and protected identities. Approval and requester-local summary were explicit automated test actions. | Passed for this source run. |
| Failure boundaries | The expanded actual-adapter GUI test passed lost-ACK identical retry, one inbox effect, requester restart, no-model reads, explicit unavailable-model failure, native lock/unlock recovery, fresh synchronization, and owner GUI device revocation. | Source and earlier candidate passed; final archive must be requalified. |
| Native lifecycle | The physical sleep/wake check passed before reboot with simulated AI and transport. | Does not prove full real GUI or offline LAN. |
| Offline LAN | Two VZ macOS 26.5 / 25F71 guests have distinct `192.168.241.3` and `.4` addresses and live boot IDs, separate guest kernels, and verified model caches. Both passed manual PF install, independent SSH egress assertion, UDP capture, and PF removal. The owner guest also loaded the bundled native clock with a ready canary and advancing monotonic samples. | Infrastructure controls passed; no offline GUI or full guest native-runtime/lifecycle pass. |
| Packaging | Candidate archive `2d0288…` (1,860,996,936 B; about 5.5 GiB unpacked) passed a 49.8-second two-process GUI workflow outside the checkout with actual QVAC and Bare, normal OS home, fresh user data, system-only `PATH`, and an optional same-archive requester executable replacement on restart. It verified lost-ACK identical approved-byte retries, one durable inbox effect, model-free evidence read after requester restart, explicit missing-model summary handling, restored-cache actual summary, and lock/unlock invalidation with fresh sync. | That earlier candidate predates the model re-hash fix. The rebuilt `b762992` archive is 1,860,910,230 B, SHA-256 `16798cd58da5f2e788bc64ff59fa994ab5a574a3a08b60fe20aeb16c5a3dc62b`; source manifests were unchanged and relocated signature, host, and native-lifecycle probes passed. Its full GUI launch awaits direct macOS Keychain authorization. |
| CI | All four Linux/macOS jobs passed on `2c4f2e8`, including the model re-hash fix and trusted-runner guard. Local checks passed 178 source tests, 16 reference tests, 16 packaging/release helper tests, the separate runner guard harness, typecheck, and five UI cases. | Offline infrastructure changes still require final CI. |
| Release workflow | Strict source/artifact validation and seven release gates are defined. | Dispatch and publish have not run. |

The practical disk recommendation is 12 GiB free: at least 8 GiB for the
installation, about 2 GiB for weights, and working cache. Memory has only been
tested on an M5 Pro with 48 GB unified memory; no lower configuration is claimed.

A representative `b762992` source run used three synthetic text documents on the
48 GB M5 Pro, with two app processes on loopback and actual QVAC/Bare. Question
to review took 871.65 ms; approval to receipt took 457.87 ms; the explicit local
summary took 2,354.09 ms; the complete failure-and-restart scenario took 57.83 s.
Peak summed RSS was 4,034,854,912 B, sampled every 500 ms across both app process
trees. Shared pages can be counted twice. This is one small-workload measurement,
not a model benchmark or a claim about the final virtual-LAN run.

Automated approvals are test actions. Virtualized networks, lifecycle probes, and
future guest tests must retain their actual scope in release notes. A release is
accepted only when the final source, final CI, complete packaged GUI workflow,
offline GUI evidence, and published bytes satisfy these rows.
