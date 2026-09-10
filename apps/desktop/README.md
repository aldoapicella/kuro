# Desktop application

Status: planned. Electron host, dependency composition, narrow preload, isolated renderer, configuration, and packaging.

The renderer consumes only `AppPort`; the host injects real or simulated adapters. The interface supports owner-side shared membership administration, read-only participant projections and refresh/lifecycle states, import, questions, passage review, approval, evidence reading, and optional local summaries. See the [architecture](../../docs/architecture.md) and [D25](../../docs/decisions/D25-shared-space-authority.md).
