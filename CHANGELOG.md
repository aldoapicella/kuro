# Changelog

All published KURO releases use this file for reviewed release notes. Entries
describe user-visible behavior and release limits; they are not commit logs.

## [0.1.0-preview.1] - 2026-09-11

### Features

- Adds the first macOS arm64 desktop preview packaging path, including a staged
  application manifest that displays its version and source commit.
- Provides local setup for protected identity, private LAN configuration, model
  asset preparation, and the reviewed evidence workflow.

### Fixes

- Keeps packaged dependency links relocatable and bundles required non-system
  macOS native libraries before the preview archive is created.

### Security

- The desktop continues to default deny protected actions until local authority,
  setup, and explicit review requirements are satisfied.

### Upgrade

- This is the first preview. Install it as a separate test profile; no upgrade
  or migration path is established for prior local data.

### Known limitations

- The preview is ad-hoc signed only. It is not Developer ID signed or notarized.
- Release publication remains blocked until the trusted qualified-runner GUI,
  model, transport, lifecycle, and packaging checks produce their report for
  the exact archive. This entry does not claim those gates have run.
- Linux is supported by CI but is not a qualified protected-runtime target.
