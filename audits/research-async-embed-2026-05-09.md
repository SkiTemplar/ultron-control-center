# Research-9 — Async auto-recall hook architecture (2026-05-09)

> Research for ULTRON v14.8 P1: implement automatic vault recall on first user
> prompt of a session, without violating UserPromptSubmit's 40 ms ADR-007
> budget.

---

## Q1 — Embedding server options for Windows (2026)

| Option | Cold | Warm | Windows | Install | Verdict |
|---|---|---|---|---|---|
| **fastembed (Qdrant lib, ONNX)** | ~1-2 s (smaller weights, ORT load) | ~10-50 ms/query (int8 ONNX, batch=1) | ✅ pure Python wheel, no native compile | `pip install fastembed` | **CHOSEN — query path** |
| HF Text Embeddings Inference (TEI) | n/a (server) | 5-15 ms (Rust, GPU/CPU) | ❌ no native Windows binary; Docker or `cargo install` from source only | Docker preferred | Rejected — extra container, build complexity |
| sentence-transformers + Flask/FastAPI | 4-6 s first import (PyTorch + transformers) | 50-100 ms/query CPU MPNet | ✅ pip | Custom code | Rejected — duplicates fastembed strengths |
| Persistent Python daemon + named pipe IPC | One-shot 4-6 s on daemon launch | 50-100 ms/query | ✅ but complex | Custom Windows service | Rejected — daemon lifecycle on Windows is messy |

- **Sources:** [github.com/qdrant/fastembed](https://github.com/qdrant/fastembed) · [github.com/huggingface/text-embeddings-inference](https://github.com/huggingface/text-embeddings-inference) · [sbert.net efficiency docs](https://sbert.net/docs/sentence_transformer/usage/efficiency.html)
- **Confidence: HIGH** (multiple primary sources confirm install paths and architectures).

## Q2 — fastembed vs sentence-transformers (interoperability)

- **Same model available?** ✅ YES. fastembed officially supports `sentence-transformers/paraphrase-multilingual-mpnet-base-v2` (dim 768) per the supported-models page — listed in the multilingual section.
- **Same vector space?** ✅ YES (de facto). fastembed packages an ONNX export of the same upstream weights, so cosine distances between query (fastembed) and indexed (sentence-transformers) vectors stay meaningful. There can be tiny numerical drift from FP32→FP16 quantisation but it's well below cosine-similarity rounding noise.
- **Performance:** fastembed is consistently 2-3× faster than sentence-transformers on CPU (ONNX Runtime + int8 path), and avoids the multi-second torch import on cold start.
- **Sources:** [fastembed Supported Models](https://qdrant.github.io/fastembed/examples/Supported_Models/) · [HF model card](https://huggingface.co/sentence-transformers/paraphrase-multilingual-mpnet-base-v2)
- **Confidence: HIGH**.

## Q3 — IPC patterns for Windows hooks

| Pattern | Cold IPC | Warm IPC | Windows complexity | Verdict |
|---|---|---|---|---|
| HTTP localhost | ~5 ms | ~1-3 ms | Trivial (`requests` / stdlib `http.client`) | Best if a service is running |
| Named pipe (`\\.\pipe\X`) | ~2 ms | <1 ms | Win32 API, fragile cross-process semantics | Overkill |
| File-based polling | ~10-50 ms (filesystem latency) | ~10-50 ms | Trivial; survives crashes | Good for **delayed** results |
| TCP socket localhost | ~5 ms | ~1-3 ms | Trivial | Equivalent to HTTP, no benefit |

- **Decision:** for the recall hook, **no IPC needed at all** — fastembed runs in-process within the hook script. The "service" is just a Python module load, not a network call. We DO use file-based persistence to write `last-recall.json` so the next turn or `ultron recall status` can read it.
- **Confidence: MED** (in-process is simpler; numbers from generic Windows IPC benchmarks 2024-2025).

## Q4 — Async hook patterns (Anthropic docs)

**Major finding:** Claude Code documents `async: true` and `asyncRewake: true` as first-class hook modes ([code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)).

```jsonc
{
  "type": "command",
  "command": "auto-recall.py",
  "asyncRewake": true,   // background; if exit 2, wakes Claude with stderr as system reminder
  "timeout": 60          // generous; hook controls its own budget internally
}
```

- **Hook fires in background**, doesn't block UserPromptSubmit. The 40 ms ADR-007 budget is **moot** in this mode.
- **If hook finds useful recall hits** → exit code 2 + write the context to stderr → Claude wakes with that text injected as a system reminder.
- **If Qdrant is down / no hits / timeout** → exit code 0 silently → Claude never knows the hook ran.
- **Cross-turn?** No: the hook fires per-prompt, results appear in the same turn (or the next, if Claude already finished responding when the hook completes).
- **Persisting state across turns:** documented patterns are `CLAUDE_ENV_FILE` (limited to specific events) and writing to plain files (universal). For our use case the hook also writes `~/.ultron/.tmp/last-recall.json` for `ultron recall status` introspection.
- **Confidence: HIGH** (primary Anthropic doc).

## Q5 — Fallback if Qdrant down

Cleanest pattern with `asyncRewake: true`:

```python
try:
    client = QdrantClient(url=URL, timeout=2.0)   # short timeout
    client.get_collection(COLLECTION)             # cheap probe
except Exception:
    sys.exit(0)   # silent — no rewake, no system-reminder noise
```

- Hook **never** errors loudly; the worst case is "no recall this turn, retry next turn."
- Optional: write a 1-line breadcrumb to `~/.ultron/.tmp/recall-debug.log` for `ultron doctor` to surface in D26 follow-up.
- **Confidence: HIGH** (standard "fail closed, fail silent" pattern).

---

## Recommended architecture

Run `auto-recall.py` as an `asyncRewake: true` UserPromptSubmit hook. The hook lazily imports `fastembed` (cheap), embeds the user's prompt against the existing `ultron_vault` Qdrant collection (already populated by sentence-transformers), takes the top-3 hits, and exits with code 2 + a short stderr block (the recall as `[ULTRON·recall] <path1> · <path2> · <path3> — see ~/.ultron/.tmp/last-recall.json for excerpts`). Anthropic's documented async-rewake mechanism turns that stderr into a system reminder injected into the same turn (or the immediately next one if Claude has already responded). If Qdrant or the model load fails, the hook exits 0 silently — zero noise, no degradation.

This collapses three decisions in one: **(a)** sidesteps the 40 ms ADR-007 budget entirely (`async`); **(b)** delivers results back to the model (`asyncRewake` + stderr); **(c)** keeps the indexing path (sentence-transformers) and query path (fastembed) sharing one model name and vector space.

## Dependencies to add to `pyproject.toml`

```toml
dependencies = [
  # already present from v14.6:
  # "qdrant-client>=1.10",
  # "sentence-transformers>=3.0",
  # NEW for v14.8 P1:
  "fastembed>=0.3,<1.0",   # query-side embeddings, ONNX, ~2-3× faster than ST on CPU
]
```

No other deps. `fastembed` ships ONNX Runtime and the tokeniser as wheel deps, so install is one `uv pip install` away.

## Open questions / blockers

- None blocking. **Optional decision** for USER: cap recall stderr at 1500 chars to stay polite in `additionalContext`-style injection — recommend yes.
- **Optional follow-up:** write a tiny doctor detector D26 that warns when `last-recall.json` is older than 24 h (signal that the hook is broken or Qdrant has been down).

---

## Sources cited

- [code.claude.com — Hooks](https://code.claude.com/docs/en/hooks)
- [github.com/qdrant/fastembed](https://github.com/qdrant/fastembed)
- [qdrant.github.io/fastembed — Supported Models](https://qdrant.github.io/fastembed/examples/Supported_Models/)
- [github.com/huggingface/text-embeddings-inference](https://github.com/huggingface/text-embeddings-inference)
- [sbert.net — Speeding up Inference](https://sbert.net/docs/sentence_transformer/usage/efficiency.html)
- [huggingface.co — paraphrase-multilingual-mpnet-base-v2](https://huggingface.co/sentence-transformers/paraphrase-multilingual-mpnet-base-v2)
- [github.com/qdrant/fastembed/issues/10](https://github.com/qdrant/fastembed/issues/10)

— Research-9 done. Implementation can proceed.
