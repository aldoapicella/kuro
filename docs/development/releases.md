# Desktop preview releases

KURO publishes only manually dispatched, unsigned macOS arm64 preview releases
until Developer ID signing and notarization are separately configured and
qualified. The authoritative desktop version is `apps/desktop/package.json`.
For `0.1.0-preview.1`, the tag is `v0.1.0-preview.1` and the exact assets are:

- `KURO-0.1.0-preview.1-darwin-arm64-unsigned-preview.tar.gz`
- `KURO-0.1.0-preview.1-darwin-arm64-unsigned-preview.tar.gz.sha256`

The Release workflow accepts an exact source SHA and version. It checks that the
commit is reachable from `main`, that its existing `core-transport.yml` push
workflow passed, and that the desktop manifest and an authored CHANGELOG section
match the requested version. A workflow run serializes each version and refuses
an existing tag or release.

The trusted `kuro-qualified-macos-arm64` runner performs the only build. It uses
Node 24.19.0, pnpm 11.19.0, a frozen install, desktop build/package, and the
root-owned `scripts/qualify-release.mjs`. That command must write
`build/release-validation.json` with this minimum shape: `version`, `sourceSha`,
`runner: { os: "macOS", arch: "arm64", darwinRelease: "25.5.0",
macOSBuild: "25F71" }`, and `artifact` containing the exact archive `name`,
`sha256`, and `bytes`. It must have one passed check for each of
`source-suite`, `native-qualification`, `relocated-full-real-gui`,
`failure-boundaries`, `offline-virtual-lan-egress-reconnect`,
`clean-relocation-upgrade`, and `model-preparation`; each check has one or more
hashed, size-recorded evidence files under `build/release-evidence/`. The report
has an empty `unmetGates` list. The workflow streams every artifact and evidence
file to validate its digest and size before upload and publication.

Set `KURO_RELEASE_CONFIG` on the qualified runner to an absolute path outside
the repository. Its private JSON contains absolute paths for `embeddingFile`,
`summaryFile`, and `offlineConfiguration`; the last is the private setup JSON
for the isolated virtual-LAN qualification. Do not commit this configuration,
model files, or its setup data. The qualifier rejects relative paths and records
only bounded evidence outputs under `build/release-evidence/`.

## Isolated virtual-LAN qualification

The offline coordinator is `scripts/offline-gui.mjs`. It runs the archived app
in two macOS VZ guests with independent kernels, protected identities, and
SQLite databases on one physical Mac. This is virtual-device evidence. The
source and earlier relocated two-process runs use loopback and share the host
kernel; they cannot satisfy this gate.

`scripts/offline-lima-macos-vlan.sh` writes private Lima definitions under
`$KURO_VALIDATION_HOME/offline/lima`. It verifies the exact macOS 26.5 / 25F71
IPSW before writing them. Set `KURO_MACOS_IPSW` when the image is elsewhere.
It defines two 4-CPU, 12-GiB, 80-GiB macOS guests and a small Linux control guest,
with no host mounts. Creating the dedicated `ko` user-v2 network and starting
the guests are separate Lima operator actions. Do not attach an additional
network. Complete normal graphical login and native Keychain prompts directly
inside each macOS guest before running qualification. The SSH user must be the
same non-root account shown by `/dev/console`; the coordinator fails closed if
the console account or UID differs. It starts native probes and the persistent
GUI driver through a temporary owner-only askpass helper, `sudo -A -k`,
`launchctl asuser`, and a nested `sudo -n -H -u` back to that SSH user with a
system-only `PATH`. The helper is removed and checked after its target command
exits, including the persistent driver's lifetime. It does not send a password
through the driver's NDJSON input or put one in arguments,
environment variables, or evidence.
Each native probe runs under a bounded, detached process-group supervisor.
A timeout or failure sends TERM then KILL only to that probe group, which
includes its Electron helper processes. The coordinator accepts a probe result
only after group absence and GUI-session removal of its exact temporary askpass
helper each emit a distinct cleanup verification. It does not act on SecurityAgent; an
unavailable Keychain authorization remains a failed qualification.

The private `offlineConfiguration` JSON contains `limaHome` and two objects,
`owner` and `requester`, with these fields:

| Fields | Required value |
| --- | --- |
| `instance`, `sshConfig`, `sshHost` | Distinct Lima names, absolute host paths to their SSH configuration, and the corresponding SSH aliases. The tested names are `ko-o` and `ko-q`. |
| `guestValidationRoot`, `guestRunRoot` | Absolute private guest directories. The run directory must be strictly inside the validation directory; the coordinator checks real paths and symlink containment before destructive cleanup and replaces it for each run. Do not put anything to preserve there. |
| `driverDirectory`, `driverEvidenceDirectory`, `publicRecordDirectory`, `documentDirectory`, `pcapPath` | Separate paths inside `guestRunRoot` for fresh app profiles, screenshots, GUI-exported public records, synthetic inputs, and the capture. |
| `guestNodePath`, `guestNodeModulesPath` | Verified Node 24.19.0 and the repository's pinned Playwright dependencies, staged privately inside `guestValidationRoot` and outside `guestRunRoot`. These drive the test; KURO runs with only system directories on `PATH`. |
| `sudoCredentialPath` | The guest's disposable login credential file, owned by its guest user and mode `0400` or `0600`. The GUI-session path uses a temporary owner-only askpass helper, while the separate non-streaming PF/capture helpers use direct `sudo` stdin. Product-driver stdin remains NDJSON. No credential value belongs in JSON, arguments, environment variables, logs, or Git. |
| `peerIp`, `routerIp`, `managementIp`, `lanInterface` | Observed addresses and non-loopback interface. The current topology uses owner `.3`, requester `.4`, Linux control `.1`, and Lima management `.2` within `192.168.241.0/24`, on `en0`. |
| `modelCache.embedding`, `modelCache.summary` | Each has a guest-private absolute `path`, expected `bytes`, and pinned `sha256`. The paths stay inside `guestValidationRoot`, outside the run directory. Use the model identifiers and hashes from the desktop's model asset definitions. |

The coordinator copies archives, test infrastructure, GUI public records,
screenshots, and packet captures with `/usr/bin/scp`'s default SFTP mode. Each
transfer has one guest endpoint and uses that peer's `sshConfig`/`sshHost` plus
`BatchMode=yes`, `ControlMaster=no`, and `ControlPath=none`, matching remote
commands. Local and guest paths must be absolute, and every guest path remains
inside `guestRunRoot`. Do not use `limactl copy`: it can select a separate NAT
management route that the guest egress gate correctly blocks.

Store the host JSON with mode `0600`. Stage the verified model weights and
test-controller runtime before applying the egress gate. The coordinator copies
the exact supplied archive and current reviewed test scripts, checks their
hashes, extracts the app, and creates fresh profile directories. It does not
seed product permissions, approvals, or databases. Public invitation and
enrollment files originate from the GUI. Native chooser confirmations and
approval clicks are explicit automated test actions.

For a diagnostic run outside the release workflow:

```sh
node scripts/offline-gui.mjs \
  --configuration /absolute/private/path/offline-config.json \
  --archive /absolute/path/KURO-0.1.0-preview.1-darwin-arm64-unsigned-preview.tar.gz \
  --source-sha 0123456789abcdef0123456789abcdef01234567 \
  --version 0.1.0-preview.1 \
  --evidence /absolute/private/path/offline-evidence
```

Use the archive's actual source SHA. A release always invokes this command
itself against its final archive; an externally supplied passing report is not
accepted. Success requires distinct live guest boot IDs, qualified native
probes, fresh GUI setup, exact reviewed delivery, lost-ACK retries, reconnect,
model-free evidence reads, actual QVAC summary and literal citations, and GUI
revocation. Both guests must pass a bounded local `127.0.0.1` TCP control and
fail external TCP controls before and after the workflow. Bounded
Ethernet/IPv4/UDP header captures must show traffic between
their actual LAN addresses. The report records relative capture paths and
verified cleanup; a failed cleanup keeps the gate failed.

The PF helper only operates inside disposable guests. Its rollback is armed
before rules are loaded and committed only after a fresh independent SSH
connection verifies blocked egress. SSH management replies are the explicit
control-plane exception. A 30-minute guest-side recovery timer remains armed
after commit and is cancelled by normal removal. Normal cleanup stops the test processes and captures
and restores each guest's prior PF configuration; host PF is never changed.
Passing the PF and capture controls alone does not qualify the full GUI.

## Qualified runner lifecycle

Run the listener in the logged-in macOS GUI account on the qualified host.
Native Keychain approval for a newly built app remains a direct macOS action;
the release scripts do not bypass it. The two validation guests also require
their own graphical sessions and protected-storage access.

Prepare the runner once with `node scripts/release-runner-install.mjs`. The
installer downloads the official `actions/runner` 2.337.0 macOS arm64 archive,
verifies its published SHA-256
`5a2cd92908a93d7276a194e1de6008099f3e7946f3f8e14aa7a1a7b4a31fdec2`, and
installs it under the private
`~/.local/share/kuro-validation/actions-runner` directory. This does not
register or start a runner. The upstream runner is MIT licensed; its source and
release checksums are published at <https://github.com/actions/runner>.
GitHub's current self-hosted runner guidance is at
<https://docs.github.com/en/actions/reference/runners/self-hosted-runners>;
the administrator hook contract is documented at
<https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts>.

After the final source is the exact `main` tip, its required CI has passed, and
the owner has queued the Release workflow on `main`, start the one-job listener:

```sh
node scripts/release-runner-start.mjs \
  --source-sha 0123456789abcdef0123456789abcdef01234567 \
  --version 0.1.0-preview.1 \
  --config /absolute/private/path/release-config.json
```

The launcher requires GitHub CLI authentication as `aldoapicella`, checks the
source against the current GitHub `main` tip, and requests a short-lived runner
registration token without printing or writing it. It passes the token through
the runner's masked `ACTIONS_RUNNER_INPUT_TOKEN` process environment, registers
with `--ephemeral --disableupdate`, runs in the foreground for one job, and then
confirms through the authenticated runner-list API that GitHub removed the
ephemeral registration. If it remains, the launcher deletes only its randomized
runner name and confirms absence before removing local state. Never run it as a
service or leave it waiting for later work. The launcher also removes its
one-job work directory and local credentials. If cleanup cannot confirm
deregistration, remove the offline runner in the repository Actions settings
before any retry.

The administrator job-start hook is installed outside every checkout and reads
only its sibling mode-0600 policy. It permits the `qualify` job only when the
event is `workflow_dispatch`, the repository and actor are `aldoapicella/kuro`
and `aldoapicella`, the workflow reference is exactly
`.github/workflows/release.yml@refs/heads/main`, the workflow and source SHA are
the expected main tip, and the version, macOS arm64 runner identity, and private
release configuration path, size, and digest match. A pull request or other
workflow that requests the known label therefore fails before any workflow,
pre-action, or container step executes. A failed hook alone is insufficient
because a workflow step can declare `if: always()`; on denial the installed
hook terminates its parent Runner.Worker so no later condition is evaluated.
GitHub's runner downloads referenced action packages while preparing a job
before invoking the hook, so an unauthorized queued job can consume the
ephemeral runner and cause download and work-directory activity until launcher
cleanup; it cannot execute the downloaded action.
Queue a fresh exact dispatch and start a newly registered ephemeral runner after
such a denial.

Run `node scripts/release-runner-guard.test.mjs` after changing the policy or
hook. The test covers the exact allow case, PR/workflow/actor/ref/SHA/version and
configuration-path denials, same-length configuration replacement, and private
file modes.

For this first preview, `clean-relocation-upgrade` proves persistent-schema
preservation and reopen across candidate replacement. Its evidence must state
that no earlier supported KURO release exists; it does not claim a migration.

GitHub-hosted publication downloads those exact uploaded bytes. It does not
rebuild. It rechecks the archive digest, staged manifest version and source
commit before creating the prerelease tag and uploading the archive, checksum,
and validation report. Existing tags and draft or published releases are checked
before publication. Publication then atomically claims the exact source tag;
`--verify-tag` prevents release creation from inventing a different target. A
preview must not be described as Developer ID signed,
notarized, stable, or fully qualified unless the corresponding credentials and
evidence are added in a later release.

The qualified artifact has `build/` as its upload root. After download it must
contain `release/packages/` with the archive and checksum,
`release/release-validation.json`, and `release/release-evidence/`. The publish
job verifies this layout before reading or publishing any file.
