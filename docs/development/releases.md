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

## Qualified runner lifecycle

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
