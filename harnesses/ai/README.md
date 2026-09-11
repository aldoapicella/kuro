# AI development harness

The harness imports public workspace exports and runs embedding, ranking, exact
summary preparation and generation over synthetic evidence.

```sh
pnpm install --frozen-lockfile
pnpm --filter @kuro/ai-harness harness
pnpm --filter @kuro/ai probe:runtime
pnpm --filter @kuro/ai-harness harness --with-qvac
pnpm --filter @kuro/ai-harness harness --with-qvac --embeddings-only
```

The default uses the real adapter with a **scripted QVAC backend**, does not download
weights and is included in Linux/macOS CI. `--with-qvac` uses the actual QVAC runtime
and attempts both embedding and generation. `--embeddings-only` limits that run to
embedding and ranking. Each run reports provider mode, runtime, complete profiles and
outcome, then closes the runtime. Failed inference exits nonzero; no fake fallback runs.

On macOS arm64, the pinned QVAC native addon links Homebrew OpenSSL 3 at
`/opt/homebrew/opt/openssl@3`; install it with `brew install openssl@3` before real
execution. `@kuro/ai` explicitly depends on `require-asset`, and the workspace narrowly
hoists it so Bare platform packages can resolve their asset loader with pnpm. Hoisting
alone does not reliably install that optional transitive dependency in a clean checkout.
The runtime probe starts the actual SDK worker and checks its heartbeat without loading
models; Linux/macOS CI runs it after a frozen install.

Real mode downloads models on first use: approximately 670 MB for GTE and 1.1 GB for
Qwen. QVAC caches weights outside the repository under its configured cache directory
(default `~/.qvac`). The registry download can fall back to the exact pinned HTTP
artifact; the SDK checks its bytes against the registry SHA-256. Models and private
runtime logs must not be committed.

The original PR author reported a successful GTE 1024-dimensional embedding on
Windows/Node 24.19.0 on September 10, 2026. That historical run did not execute
Qwen generation. Current integration evidence is recorded in
[D27](../../docs/decisions/D27-qvac-adapter-integration.md), separately from the earlier
report and scripted tests. Neither a model smoke test nor valid citations measures
retrieval quality or proves that a generated claim is semantically faithful.
