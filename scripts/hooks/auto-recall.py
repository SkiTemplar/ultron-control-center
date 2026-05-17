#!/usr/bin/env python3
"""ULTRON v15.4.14 — Auto-recall hook (UserPromptSubmit, asyncRewake).

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

v15.4.14 additions:
- Vaulted skills  (~/.ultron/skill-vault/<name>/SKILL.md) are matched
  against the prompt with a keyword scorer and surfaced as VAULT·SKILL hints.
- Vaulted agents  (~/.ultron/agent-vault/<name>.md) are matched the same way
  and surfaced as VAULT·AGENT hints.
  Both are ADDITIVE — they appear after existing vault-note, skill, and agent
  sections and share the overall token budget (no new Qdrant calls).

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
AGENTS_COLLECTION = os.environ.get("ULTRON_AGENTS_COLL", "ultron_agents")
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
# v15.3.5: agent suggestion threshold. Default matches the skill threshold
# but is independently tunable via env so power users can dial it without
# touching features.json.
AGENT_MIN_SCORE = float(os.environ.get("ULTRON_RECALL_AGENT_MIN_SCORE", "0.40"))
AGENT_TOP_N = int(os.environ.get("ULTRON_RECALL_AGENT_TOP", "3"))

# Module-level cache: _do_recall fills this with the top skill match found
# while it was already running its vault query. main() consumes it for the
# combined system-reminder. None when no skill cleared the threshold.
_LAST_SKILL_MATCH: dict | None = None
# v15.3.5: same pattern for top-N agent matches (None when no agent cleared
# AGENT_MIN_SCORE, otherwise a list of dicts).
_LAST_AGENT_MATCHES: list | None = None

# ── v15.4.14: file-based vault scoring ────────────────────────────────────────
# Directories for demoted skills and agents (may not exist on older installs).
_SKILL_VAULT_DIR = Path.home() / ".ultron" / "skill-vault"
_AGENT_VAULT_DIR = Path.home() / ".ultron" / "agent-vault"

# How many vaulted items to surface at most (combined ceiling respects budget).
VAULT_SKILL_TOP_N = int(os.environ.get("ULTRON_RECALL_VAULT_SKILL_TOP", "2"))
VAULT_AGENT_TOP_N = int(os.environ.get("ULTRON_RECALL_VAULT_AGENT_TOP", "2"))

# Minimum keyword score (0..1) to surface a vaulted item.
VAULT_SKILL_MIN_SCORE = float(os.environ.get("ULTRON_RECALL_VAULT_SKILL_MIN", "0.20"))
VAULT_AGENT_MIN_SCORE = float(os.environ.get("ULTRON_RECALL_VAULT_AGENT_MIN", "0.20"))


# ── v15.4.14 helpers ──────────────────────────────────────────────────────────

def _parse_frontmatter(text: str) -> dict[str, str]:
    """Extract name and description from YAML frontmatter (stdlib only).

    Handles both bare scalars and quoted strings for both fields. Stops
    parsing after the closing ``---`` delimiter so it never reads the full
    skill body, keeping I/O cost negligible.

    Args:
        text: Raw file contents, UTF-8.

    Returns:
        Dict with keys ``name`` and/or ``description`` that were found.
        Empty dict when no frontmatter is present.
    """
    import re

    result: dict[str, str] = {}
    lines = text.splitlines()
    # Must start with opening ---
    if not lines or lines[0].strip() != "---":
        return result
    in_fm = False
    for line in lines:
        stripped = line.strip()
        if stripped == "---":
            if not in_fm:
                in_fm = True
                continue
            else:
                break  # closing delimiter reached
        if not in_fm:
            continue
        # Match   key: value   or   key: "value"
        m = re.match(r'^(name|description)\s*:\s*(.*)', line)
        if m:
            key = m.group(1)
            val = m.group(2).strip()
            # Strip surrounding quotes
            if (val.startswith('"') and val.endswith('"')) or (
                val.startswith("'") and val.endswith("'")
            ):
                val = val[1:-1]
            result[key] = val
    return result


def _keyword_score(prompt: str, description: str) -> float:
    """Return a simple keyword overlap score in [0, 1].

    Tokenises both strings into lowercase alphabetic words, then computes
    the Jaccard-like overlap weighted by the query side:

        score = |query_tokens ∩ desc_tokens| / max(|query_tokens|, 1)

    This intentionally mirrors the BM25 spirit (term frequency in the doc
    side is irrelevant here; we only care whether the query terms appear).
    No external deps — pure stdlib ``re`` + ``set``.

    Args:
        prompt: The raw user prompt.
        description: The skill/agent description to score against.

    Returns:
        Float in [0.0, 1.0].
    """
    import re

    def _tokens(s: str) -> set[str]:
        return {w for w in re.findall(r"[a-z]+", s.lower()) if len(w) > 2}

    q_tokens = _tokens(prompt)
    if not q_tokens:
        return 0.0
    d_tokens = _tokens(description)
    overlap = len(q_tokens & d_tokens)
    return round(overlap / len(q_tokens), 4)


def _scan_vault_skills(prompt: str) -> list[dict]:
    """Score all SKILL.md files in skill-vault against *prompt*.

    Reads only the YAML frontmatter block of each file (stops at the second
    ``---`` delimiter) so the I/O cost is small even when hundreds of skills
    are vaulted.

    Args:
        prompt: Raw user prompt text.

    Returns:
        List of ``{name, score, description}`` dicts sorted by score
        descending, filtered to >= VAULT_SKILL_MIN_SCORE, capped at
        VAULT_SKILL_TOP_N entries.
    """
    if not _SKILL_VAULT_DIR.exists():
        return []
    results: list[dict] = []
    for skill_md in _SKILL_VAULT_DIR.glob("*/SKILL.md"):
        try:
            # Read only the first 60 lines — enough to cover any frontmatter.
            lines: list[str] = []
            with skill_md.open(encoding="utf-8-sig", errors="replace") as fh:
                for i, ln in enumerate(fh):
                    lines.append(ln.rstrip("\n"))
                    if i > 60:
                        break
            fm = _parse_frontmatter("\n".join(lines))
            name = fm.get("name") or skill_md.parent.name
            description = fm.get("description", "")
            if not description:
                continue
            score = _keyword_score(prompt, description)
            if score < VAULT_SKILL_MIN_SCORE:
                continue
            results.append({"name": name, "score": score, "description": description})
        except Exception:
            continue
    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:VAULT_SKILL_TOP_N]


def _scan_vault_agents(prompt: str) -> list[dict]:
    """Score all agent markdown files in agent-vault against *prompt*.

    Same frontmatter-only reading strategy as :func:`_scan_vault_skills`.

    Args:
        prompt: Raw user prompt text.

    Returns:
        List of ``{name, score, description}`` dicts sorted by score
        descending, filtered to >= VAULT_AGENT_MIN_SCORE, capped at
        VAULT_AGENT_TOP_N entries.
    """
    if not _AGENT_VAULT_DIR.exists():
        return []
    results: list[dict] = []
    for agent_md in _AGENT_VAULT_DIR.glob("*.md"):
        try:
            lines: list[str] = []
            with agent_md.open(encoding="utf-8-sig", errors="replace") as fh:
                for i, ln in enumerate(fh):
                    lines.append(ln.rstrip("\n"))
                    if i > 60:
                        break
            fm = _parse_frontmatter("\n".join(lines))
            name = fm.get("name") or agent_md.stem
            description = fm.get("description", "")
            if not description:
                continue
            score = _keyword_score(prompt, description)
            if score < VAULT_AGENT_MIN_SCORE:
                continue
            results.append({"name": name, "score": score, "description": description})
        except Exception:
            continue
    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:VAULT_AGENT_TOP_N]


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
    query: str,
    hits: list[dict],
    skill_match: dict | None = None,
    agent_matches: list[dict] | None = None,
    vault_skills: list[dict] | None = None,
    vault_agents: list[dict] | None = None,
) -> str:
    """Render the system-reminder body the model will see.

    Up to five sections when all are available:
      - Vault recall (top-N notes semantically related to the query)
      - Skill suggestion (top-1 skill from ultron_skills collection)
      - Available subagents matching (top-N from ultron_agents collection)
      - Vaulted skills (file-based keyword match, v15.4.14)
      - Vaulted agents (file-based keyword match, v15.4.14)
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

    # v15.3.5: subagent suggestions (semantic match against ultron_agents)
    if agent_matches:
        lines.append("Available subagents matching (semantic match against agents catalog):")
        for am in agent_matches:
            name = am.get("name", "?")
            score = am.get("score", 0.0)
            desc = (am.get("description") or "").replace("\n", " ").strip()
            if len(desc) > 140:
                desc = desc[:140] + "..."
            lines.append(f"  → {name} (similarity {score:.2f})")
            if desc:
                lines.append(f"    {desc}")
        lines.append(
            "  Delegate via the Task tool ONLY if the agent's specialty truly fits the "
            "request — these are suggestions, not orders."
        )
        lines.append("")

    # v15.4.14: vaulted skills (keyword-scored from skill-vault filesystem).
    # These are ADDITIVE — placed after Qdrant-backed sections so they never
    # displace primary recall content.
    if vault_skills:
        for vs in vault_skills:
            name = vs.get("name", "?")
            score_pct = int(round(vs.get("score", 0.0) * 100))
            lines.append(
                f"[VAULT·SKILL·{score_pct}%] {name}"
                " — Restore from Skills tab if useful for this prompt."
            )
        lines.append("")

    # v15.4.14: vaulted agents (keyword-scored from agent-vault filesystem).
    if vault_agents:
        for va in vault_agents:
            name = va.get("name", "?")
            score_pct = int(round(va.get("score", 0.0) * 100))
            lines.append(
                f"[VAULT·AGENT·{score_pct}%] {name}"
                " — Restore from Agents tab to delegate."
            )
        lines.append("")

    lines.append("</ultron-recall>")
    return "\n".join(lines)


def _agent_auto_suggest_enabled() -> bool:
    """Feature-gate: features.json → agent_auto_suggest (default True).

    Reads cockpit/features.json via the agent_suggest helper if available,
    falling back to True so the wiring is opt-out. Failures keep the feature
    on — the goal is to make agents discoverable, not silently hidden.
    """
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "cockpit"))
        import agent_suggest  # type: ignore
        return bool(agent_suggest.is_enabled())
    except Exception:
        return True


def _do_agent_match(client, vector: list[float]) -> list[dict] | None:
    """Top-N semantic agent suggestions. Returns list or None.

    Uses the SAME query vector that vault recall already computed (zero
    extra embedding cost — that's why this lives in _do_recall rather than
    as a separate hook).
    """
    if not _agent_auto_suggest_enabled():
        return None
    try:
        existing = {c.name for c in client.get_collections().collections}
        if AGENTS_COLLECTION not in existing:
            return None
        results = client.query_points(
            collection_name=AGENTS_COLLECTION,
            query=vector,
            limit=AGENT_TOP_N,
            with_payload=True,
        ).points
    except Exception:
        return None
    out: list[dict] = []
    for r in results:
        score = float(getattr(r, "score", 0.0) or 0.0)
        if score < AGENT_MIN_SCORE:
            continue
        payload = r.payload or {}
        out.append({
            "name": payload.get("name", ""),
            "score": round(score, 4),
            "model": payload.get("model", ""),
            "tools": payload.get("tools", []),
            "description": (payload.get("description") or "")[:200],
        })
    return out or None


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

    # v15.3.5: also probe ultron_agents with the SAME vector.
    try:
        global _LAST_AGENT_MATCHES
        _LAST_AGENT_MATCHES = _do_agent_match(client, vector)
    except Exception:
        _LAST_AGENT_MATCHES = None

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
    agent_matches = _LAST_AGENT_MATCHES

    # v15.4.14: file-based vault scans (no Qdrant, pure keyword scoring).
    # Wrapped defensively so any filesystem issue stays silent.
    try:
        vault_skills: list[dict] = _scan_vault_skills(prompt)
    except Exception:
        vault_skills = []
    try:
        vault_agents: list[dict] = _scan_vault_agents(prompt)
    except Exception:
        vault_agents = []

    # If neither vault hits, skill match, agent matches, nor vault items
    # passed thresholds, stay silent.
    # v15.3.5: agent matches alone are a valid reason to surface.
    # v15.4.14: vault hints alone are also a valid reason.
    if not hits and not skill_match and not agent_matches and not vault_skills and not vault_agents:
        return EXIT_SILENT

    # Persist for downstream introspection (TUI dashboard, future tools).
    _save_last_recall(prompt, hits or [], skill_match=skill_match)
    _save_last_skill_match(prompt, skill_match)

    # Inject as system-reminder via stderr + exit 2
    reminder = _format_reminder(
        prompt,
        hits or [],
        skill_match=skill_match,
        agent_matches=agent_matches,
        vault_skills=vault_skills or None,
        vault_agents=vault_agents or None,
    )
    sys.stderr.write(reminder + "\n")
    sys.stderr.flush()
    return EXIT_INJECT


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Last-resort safety: never block the user prompt
        sys.exit(EXIT_SILENT)
