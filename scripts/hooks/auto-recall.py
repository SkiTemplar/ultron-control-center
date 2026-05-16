#!/usr/bin/env python3
"""ULTRON v14.8 P1 — Auto-recall hook (UserPromptSubmit, asyncRewake).

On the FIRST turn of every Claude Code session, embeds the user prompt with
fastembed (ONNX MPNet — interoperable with the sentence-transformers index
in v14.6's `ultron_vault` collection), queries Qdrant for top-3 semantically
related vault notes, and emits a structured system-reminder so the model
sees the relevant context before it begins.

Architecture (per Research-9 audit):
- Anthropic's `asyncRewake: true` hook flag: exit 2 + stderr → injected as
  system-reminder in the same turn. Sidesteps the 40ms ADR-007 budget
  because asyncRewake hooks run async, not blocking the user-facing turn.
- fastembed (ONNX, in-process) embeds queries in ~50-100ms warm vs
  ~5s for sentence-transformers cold-load. ONNX cache lives in
  ~/.cache/fastembed.
- File-based state (~/.ultron/.tmp/auto-recall-fired-sessions.json) tracks
  which session_ids already had recall fired — keeps cost minimal while
  delivering value where it matters most.

Knob via env:
  ULTRON_AUTO_RECALL  unset|"1" → first-turn-only (default)
                      "0"        → kill switch, never fires
                      "always"   → every turn (power-user)

Failure modes (all → exit 0 silent, no block):
- fastembed missing
- Qdrant down (Docker not yet up post-boot)
- ultron_vault collection missing or empty
- Any unhandled exception (defensive try/except)
- Total runtime exceeds 5s safety cap
"""
from __future__ import annotations

import json
import os
import sys
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path

# Resolve cockpit helpers from the installed .ultron tree. The
# ~/.claude/skills/ultron mirror may only contain markdown skill files.
_SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
_COCKPIT_PATH = str(_SCRIPTS_ROOT / "cockpit")
if _COCKPIT_PATH not in sys.path:
    sys.path.insert(0, _COCKPIT_PATH)

# Silence fastembed/transformers noise that would otherwise pollute the stderr
# system-reminder injection. Specifically the mean-pooling UserWarning on
# multilingual MPNet is informational and irrelevant to the user.
warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)
os.environ.setdefault("PYTHONWARNINGS", "ignore")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

# Cap total runtime at 5s to avoid pathological hangs.
RUNTIME_CAP_S = 5.0

# Anthropic hook contract (per Research-9):
#   exit 0 + stdout empty   → no injection
#   exit 2 + stderr message → message becomes a system-reminder
EXIT_INJECT = 2
EXIT_SILENT = 0

QDRANT_URL = os.environ.get("ULTRON_QDRANT_URL", "http://localhost:6333")
VAULT_COLLECTION = os.environ.get("ULTRON_QDRANT_COLL", "ultron_vault")
SKILLS_COLLECTION = os.environ.get("ULTRON_SKILLS_COLL", "ultron_skills")
# Backwards-compat alias for tests that reference COLLECTION
COLLECTION = VAULT_COLLECTION
# fastembed identifies models with the `sentence-transformers/` prefix even
# though the upstream weights are the same. We use the prefixed name here so
# fastembed resolves correctly; vectors are still interoperable with the
# Qdrant collection that v14.6 indexed via the short name in
# sentence-transformers (same upstream model on Hugging Face).
EMBED_MODEL = os.environ.get(
    "ULTRON_EMBED_MODEL_FASTEMBED",
    "sentence-transformers/paraphrase-multilingual-mpnet-base-v2",
)
TOP_N = int(os.environ.get("ULTRON_RECALL_TOP", "3"))
MIN_SCORE = float(os.environ.get("ULTRON_RECALL_MIN_SCORE", "0.35"))
SKILL_MIN_SCORE = float(os.environ.get("ULTRON_RECALL_SKILL_MIN_SCORE", "0.40"))

# Module-level cache: _do_recall fills this with the top skill match found
# while it was already running its vault query. main() consumes it for the
# combined system-reminder. None when no skill cleared the threshold.
_LAST_SKILL_MATCH: dict | None = None


def _state_path() -> Path:
    return Path.home() / ".ultron" / ".tmp" / "auto-recall-fired-sessions.json"


def _last_recall_path() -> Path:
    return Path.home() / ".ultron" / ".tmp" / "last-recall.json"


def _load_fired() -> set[str]:
    p = _state_path()
    if not p.exists():
        return set()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return set(data.get("session_ids", []))
    except (OSError, json.JSONDecodeError):
        return set()


def _save_fired(fired: set[str]) -> None:
    p = _state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    # Cap to last 200 session ids — file stays small even after months.
    capped = list(fired)[-200:]
    payload = {"session_ids": capped, "updated": datetime.now(timezone.utc).isoformat()}
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)


def _save_last_recall(query: str, hits: list[dict], skill_match: dict | None = None) -> None:
    p = _last_recall_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "query": query,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": EMBED_MODEL,
        "hits": hits,
        "skill_match": skill_match,
    }
    try:
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(p)
    except OSError:
        pass


def _last_skill_match_path():
    return Path.home() / ".ultron" / ".tmp" / "last-skill-match.json"


def _save_last_skill_match(query: str, skill: dict | None) -> None:
    if not skill:
        return
    p = _last_skill_match_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "query": query,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": EMBED_MODEL,
        "skill": skill,
    }
    try:
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(p)
    except OSError:
        pass


def _format_reminder(
    query: str, hits: list[dict], skill_match: dict | None = None,
) -> str:
    """Render the system-reminder body the model will see.

    Two sections when both are available:
      - Vault recall (top-N notes semantically related to the query)
      - Skill suggestion (top-1 skill from ultron_skills collection)
    """
    lines = ["<ultron-recall>"]

    # Vault hits
    if hits:
        lines.append(
            f"Vault search for {query!r} returned {len(hits)} semantically "
            "related notes. Read any that look relevant; ignore those that don't."
        )
        lines.append("")
        for i, h in enumerate(hits, 1):
            path = h.get("path", "?")
            score = h.get("score", 0.0)
            preview = (h.get("preview") or "").replace("\n", " ").strip()
            if len(preview) > 200:
                preview = preview[:200] + "..."
            lines.append(f"{i}. {path} (similarity {score:.2f})")
            if preview:
                lines.append(f"   {preview}")
            lines.append("")
    else:
        lines.append(f"Vault search for {query!r} returned no relevant notes.")
        lines.append("")

    # Skill suggestion (semantic match against ultron_skills collection)
    if skill_match and skill_match.get("name"):
        name = skill_match.get("name")
        score = skill_match.get("score", 0.0)
        kind = skill_match.get("kind", "")
        state = skill_match.get("state", "")
        desc = (skill_match.get("description") or "").replace("\n", " ").strip()
        if len(desc) > 160:
            desc = desc[:160] + "..."
        lines.append("Suggested skill (semantic match against the skills catalog):")
        lines.append(f"  → {name} (kind={kind}, state={state or '?'}, similarity {score:.2f})")
        if desc:
            lines.append(f"  {desc}")
        if state == "vaulted":
            lines.append(
                f"  NOTE: `{name}` is in the skill VAULT (not loaded). If it fits, "
                f"restore it: `ultron skills vault restore {name}` (effective next session / /reload-plugins)."
            )
        else:
            lines.append(
                "  Invoke via the Skill tool ONLY if it actually fits — this is a "
                "suggestion based on semantic match, not a strict route."
            )
        lines.append("")

    lines.append("</ultron-recall>")
    return "\n".join(lines)


def _do_skill_match(client, vector: list[float]) -> dict | None:
    """Query ultron_skills for the top-1 semantic match. Returns dict or None.

    Uses the same vector that vault recall already computed — zero extra
    embedding cost.
    """
    try:
        existing = {c.name for c in client.get_collections().collections}
        if SKILLS_COLLECTION not in existing:
            return None
        results = client.query_points(
            collection_name=SKILLS_COLLECTION,
            query=vector,
            limit=1,
            with_payload=True,
        ).points
    except Exception:
        return None
    if not results:
        return None
    r = results[0]
    score = float(getattr(r, "score", 0.0) or 0.0)
    if score < SKILL_MIN_SCORE:
        return None
    payload = r.payload or {}
    return {
        "name": payload.get("name", ""),
        "score": round(score, 4),
        "kind": payload.get("kind", ""),
        "state": payload.get("state", ""),     # active | vaulted | plugin (v15.0b)
        "tier": payload.get("tier", ""),
        "description": (payload.get("description") or "")[:300],
        "tags": payload.get("tags") or [],
    }


def _do_recall(prompt: str) -> list[dict] | None:
    """Embed + query. Returns list of {path, score, preview} or None on failure."""
    try:
        from fastembed import TextEmbedding  # type: ignore
    except Exception:
        return None

    try:
        from qdrant_client import QdrantClient  # type: ignore
    except Exception:
        return None

    try:
        # fastembed re-uses ~/.cache/fastembed — first call downloads ONNX,
        # subsequent calls warm-load from disk in ~50-100ms.
        embedder = TextEmbedding(model_name=EMBED_MODEL)
    except Exception:
        return None

    try:
        # generator → first vector
        vec = next(iter(embedder.embed([prompt])))
        vector = vec.tolist() if hasattr(vec, "tolist") else list(vec)
    except Exception:
        return None

    try:
        client = QdrantClient(url=QDRANT_URL, timeout=2.0)
        existing = {c.name for c in client.get_collections().collections}
        if VAULT_COLLECTION not in existing:
            return None
        results = client.query_points(
            collection_name=VAULT_COLLECTION,
            query=vector,
            limit=TOP_N,
            with_payload=True,
        ).points
    except Exception:
        return None

    # P4: also probe ultron_skills with the SAME vector (zero extra cost).
    # Result attached to module-level cache for the caller to fetch.
    try:
        global _LAST_SKILL_MATCH
        _LAST_SKILL_MATCH = _do_skill_match(client, vector)
    except Exception:
        _LAST_SKILL_MATCH = None

    hits = []
    for r in results:
        score = float(getattr(r, "score", 0.0) or 0.0)
        if score < MIN_SCORE:
            continue
        payload = r.payload or {}
        hits.append({
            "path": payload.get("path", ""),
            "score": round(score, 4),
            "preview": payload.get("preview", "")[:300],
        })
    return hits


def main() -> int:
    started = time.perf_counter()

    # Optional trace file (set ULTRON_AUTO_RECALL_TRACE=1 to enable)
    _trace_path = Path.home() / ".ultron" / ".tmp" / "auto-recall-trace.log"
    _trace = os.environ.get("ULTRON_AUTO_RECALL_TRACE", "") in ("1", "true", "yes")

    def _log(stage: str, detail: str = "") -> None:
        if not _trace:
            return
        try:
            ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
            elapsed = (time.perf_counter() - started) * 1000
            with _trace_path.open("a", encoding="utf-8") as f:
                f.write(f"[{ts}] +{elapsed:6.0f}ms {stage}: {detail}\n")
        except Exception:
            pass

    _log("start")

    # Kill switch
    knob = os.environ.get("ULTRON_AUTO_RECALL", "1").lower()
    _log("knob", knob)
    if knob in ("0", "false", "no", "off"):
        _log("exit", "kill_switch")
        return EXIT_SILENT

    # Read stdin payload through the shared hook validator. Malformed JSON is
    # surfaced through the deduped alerts bus as info; suspicious validation
    # failures remain warn-level inside hook_input_validator.
    try:
        from hook_input_validator import safe_load_stdin
    except Exception as e:
        _log("exit", f"validator_import_error:{e!r}")
        return EXIT_SILENT
    data = safe_load_stdin("UserPromptSubmit")
    if data is None:
        _log("exit", "invalid_or_empty_stdin")
        return EXIT_SILENT

    prompt = (data.get("prompt") or "").strip()
    session_id = str(data.get("session_id") or "").strip()
    _log("parsed", f"prompt_len={len(prompt)} session={session_id[:20]}")
    if not prompt or not session_id:
        _log("exit", "missing_prompt_or_session")
        return EXIT_SILENT

    # Skip slash-commands and trivially-short prompts
    if prompt.startswith("/") or len(prompt) < 12:
        _log("exit", "slash_or_short")
        return EXIT_SILENT

    # First-turn-only by default
    if knob != "always":
        fired = _load_fired()
        if session_id in fired:
            return EXIT_SILENT
        fired.add(session_id)
        try:
            _save_fired(fired)
        except Exception:
            pass  # don't block on state write failure

    # Runtime cap check
    if time.perf_counter() - started > RUNTIME_CAP_S:
        return EXIT_SILENT

    hits = _do_recall(prompt)
    skill_match = _LAST_SKILL_MATCH

    # If neither vault hits nor skill match passed thresholds, stay silent.
    if not hits and not skill_match:
        return EXIT_SILENT

    # Persist for downstream introspection (TUI dashboard, future tools).
    _save_last_recall(prompt, hits or [], skill_match=skill_match)
    _save_last_skill_match(prompt, skill_match)

    # Inject as system-reminder via stderr + exit 2
    reminder = _format_reminder(prompt, hits or [], skill_match=skill_match)
    sys.stderr.write(reminder + "\n")
    sys.stderr.flush()
    return EXIT_INJECT


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Last-resort safety: never block the user prompt
        sys.exit(EXIT_SILENT)
