# Changelog

All published KURO releases use this file for reviewed release notes. Entries
describe user-visible behavior and release limits; they are not commit logs.

## [0.1.0-preview.1] - 2026-09-11

### Features

- Introduces KURO for macOS arm64, with its version and source commit visible
  in desktop setup. Protected operation requires macOS 26.5, build 25F71.
- Adds desktop setup for OS-protected identities, private spaces, invitations,
  verified devices, membership, relationships, local grants, and document rules.
- Adds explicit private-LAN bootstrap settings and synchronization recovery.
- Prepares local QVAC models through explicit downloads with progress,
  cancellation, retry, free-space checks, and pinned checksum verification.
- Supports importing UTF-8 text, asking a custodian, reviewing exact passages
  and disclosure conditions, approving a saved revision, and receiving durable
  evidence. Reading received evidence requires no model. A permitted local
  summary runs only when requested and includes core-reconstructed citations.

### Fixes

- Keeps packaged dependency links relocatable and bundles required non-system
  macOS native libraries before the preview archive is created.
- Preserves one received evidence item across lost acknowledgments, retries,
  and application restart.
- Keeps received evidence readable when optional summary model files are absent.

### Security

- Membership and device pairing grant no implicit document access. Custodians
  configure local grants and document rules separately.
- Approval is bound to the saved revision, recipient, conditions, and digest.
  Permission or source changes can prevent dispatch of a pending response.
- Revocation, expired authority, and clock or lifecycle uncertainty close
  protected access. Fresh authority synchronization is required after recovery.
- Model files are verified again before loading; changed files require explicit
  preparation. Inference uses local QVAC, with no cloud or scripted fallback.

### Upgrade

- This is the first supported preview, so there is no earlier released version
  to migrate. Start with a fresh profile; development databases are unsupported.
- Quit KURO before replacing the application bundle. Profile data lives outside
  the bundle and survives relocation and replacement of this preview candidate.
  Keep the previous archive for recovery; there is no automatic updater.

### Known limitations

- The preview is ad-hoc signed only. It is not Developer ID signed or notarized.
- Other macOS builds and architectures are unqualified and fail closed for
  protected operation. Linux retains CI coverage but is not a supported desktop
  runtime target.
- Model preparation downloads approximately 1.73 GB. Offline use requires
  verified cached models and an explicitly configured reachable LAN bootstrap.
- The small local summary model can omit details or make mistakes. Read the
  approved evidence and literal citations when assessing a summary.
- Identity secrets use OS protection; the evidence database is not encrypted
  by KURO. Use the operating system's account and disk protections.
