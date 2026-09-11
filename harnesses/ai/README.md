# AI development harness

The harness imports public workspace exports and runs the whole local retrieval loop
over synthetic or supplied evidence: embed every passage, embed the question, rank by
cosine similarity, prepare the exact summary context, then generate grounded claims.

```sh
pnpm install --frozen-lockfile
pnpm --filter @kuro/ai-harness harness
pnpm --filter @kuro/ai probe:runtime
pnpm --filter @kuro/ai-harness harness --with-qvac
pnpm --filter @kuro/ai-harness harness --with-qvac --embeddings-only
```

Ask your own question over your own text:

```sh
pnpm --filter @kuro/ai-harness harness --with-qvac \
  --question "What blocks the release?" --source notes.txt --source status.txt
```

| Flag | Effect |
| --- | --- |
| `--with-qvac` | Load and execute the pinned QVAC models. Without it the backend is scripted. |
| `--question <text>` | The question to answer. Defaults to a synthetic release question. |
| `--source <file>` | Add one UTF-8 text file as a passage. Repeatable; 32 KiB each. |
| `--text <string>` | Add an inline passage. Repeatable. |
| `--limit <n>` | Passages to pass to generation after ranking (default 3, max 6). |
| `--embeddings-only` | Stop after embedding and ranking; never loads the generation model. |
| `--json` | One JSON record per step instead of the readable report. |

With no `--source` or `--text`, a five-passage synthetic corpus of mixed relevance is
used so ranking has to do real work. The default uses the real adapter with a
**scripted QVAC backend**, does not download weights and is included in Linux/macOS CI;
its printed answer is fixed text and is evidence of nothing about inference. Each run
reports provider mode, runtime, complete profiles and outcome, then closes the runtime.
Failed inference exits nonzero; no fake fallback runs.

The AI contract caps one embedding call at four blocks, so the harness batches like the
core does. If the SDK worker fails to start within its default 30 s on a cold host
(first launch, on-access virus scanning), raise it with
`QVAC_RPC_INIT_TIMEOUT_MS=180000`; warm starts take a few seconds.

On macOS arm64, the pinned QVAC native addon links Homebrew OpenSSL 3 at
`/opt/homebrew/opt/openssl@3`; install it with `brew install openssl@3` before real
execution. `@kuro/ai` explicitly depends on `require-asset`, and the workspace narrowly
hoists it so Bare platform packages can resolve their asset loader with pnpm. Hoisting
alone does not reliably install that optional transitive dependency in a clean checkout.
The runtime probe starts the actual SDK worker and checks its heartbeat without loading
models; Linux/macOS CI runs it after a frozen install.

On minimal Ubuntu 24.04 arm64, install `libatomic1` before starting the SDK worker
(`sudo apt-get install libatomic1`). Its RocksDB native dependency needs
`libatomic.so.1`; a package install alone does not provide system shared libraries.

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
