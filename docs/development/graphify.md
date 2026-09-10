# Graphify development tooling

KURO uses [Graphify](https://github.com/Graphify-Labs/graphify) as local development tooling for navigating code relationships. The official Python package is `graphifyy`; its CLI is `graphify`. It is separate from KURO's document retrieval and QVAC inference pipeline.

## Install

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then run from the repository:

```sh
sh scripts/setup-graphify.sh
```

The setup pins `graphifyy` to **0.9.57**, requests Python **3.12** in an isolated uv tool environment, and installs these extras:

| Extra | Capability |
| --- | --- |
| `mcp` | Serve a generated graph through the Model Context Protocol. |
| `pdf` | Extract PDF content. |
| `office` | Read supported Office document formats. |
| `watch` | Rebuild code relationships after local file changes. |
| `svg` | Export a static graph visualization. |

The base package includes the local parsing, graph, and query dependencies. No external graph database, Node runtime, or LLM API key is required for the code-only workflow. Optional remote inference backends and external database integrations are not part of this setup.

The script also registers the project-local Codex skill and integration files. These files, including `AGENTS.md` and `.codex/`, are ignored by Git rather than vendored. Restart the shell if uv adds its tool directory to PATH. Reload the project or start a new Codex task if the newly installed skill is not yet visible. Graphify's [installation documentation](https://graphify.com/docs/install) describes supported assistant integrations.

## Build and inspect the code graph

```sh
graphify extract . --code-only
graphify cluster-only . --no-label
graphify query "approval outbox permissions" --budget 800
graphify explain "Outbox"
```

`--code-only` uses local structural parsing and skips semantic document/media extraction. `--no-label` avoids model-based community naming. This workflow does not index the full meaning of the architecture documents; it maps the implemented code, currently the Python reference model and development scripts.

Generated files stay in `graphify-out/`:

- `graph.json`: graph nodes, relationships, and provenance.
- `GRAPH_REPORT.md`: graph analysis report.
- `graph.html`: interactive visualization produced by clustering/export.

After code changes, run `graphify update .`. The updater can also add deterministic Markdown structure, such as headings and links; this is not semantic LLM extraction. To regenerate the report without model-based naming, run `graphify cluster-only . --no-label` again. The optional `graphify watch .` command stays active until stopped; setup does not start a background watcher or install Git hooks.

`.graphifyignore` excludes private inputs, local assistant configuration, and generated state. `.gitignore` excludes the graph and local caches from commits. Never treat development graph output as KURO's confidential-document access-control system.

## MCP server

The installed `graphify-mcp` executable serves the local graph over stdio:

```sh
graphify-mcp --graph graphify-out/graph.json
```

This process is intended for an MCP client, not an interactive terminal session. Starting it manually waits for protocol messages. It does not open an HTTP listener by default.

For clients that configure stdio servers, use the absolute executable path returned by `command -v graphify-mcp` and an absolute graph path. The optional server is installed alongside the CLI; the project-local Codex registration above uses the skill/CLI integration.

## Scope and provenance

Graphify is third-party developer tooling. Its source, assistant skill bundle, generated graph, and Python environment are not tracked in KURO. The README declares this dependency and the pre-existing KURO design reference.

A successful code graph or MCP response verifies this development tool installation. It does not establish that the KURO application, local QVAC models, or Pear transport have been implemented or tested.
