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
