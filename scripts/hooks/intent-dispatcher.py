#!/usr/bin/env python3
"""
ULTRON UserPromptSubmit hook — Intent Dispatcher (S2-B).

Classifies user intent via a 4-step sequential pipeline:
  1. Slash-command short-circuit (skip if prompt starts with /)
  2. intent-rules.yaml exact-match (regex rules, first match wins)
  3. ZTMSI query via chunks_fts SQLite (direct, no subprocess)
  4. Fallthrough no-route (empty stdout)

When confidence >= 0.70, emits ONE line to stdout:
  [ULTRON·{pct}%] skill={id} | ctx={path} ({tokens}tok) | via={source}

If 0.70 <= conf < 0.85, appends " (señal parcial)".

Side-effects:
  - Telemetry JSONL appended to ~/.ultron/telemetry/dispatcher-events.jsonl
  - NEVER modifies the user's prompt
  - NEVER writes tracebacks to stdout (pollutes Claude context)
  - Routing pipeline honours a 40ms internal budget; the trailing
    telemetry append may run just past it (the routing line is already
    flushed to stdout, so the user perceives no delay)
  - NEVER opens any window (PILAR I)
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ── Cockpit path injection (lazy imports from context_packet_builder) ──────────
# Inserted once at module level so cockpit imports resolve without subprocess.
# Must come before any local cockpit import attempt. Resolve from this
# installed hook; the legacy ~/.claude/skills/ultron mirror is markdown-only.
_SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
_COCKPIT_PATH = str(_SCRIPTS_ROOT / "cockpit")
if _COCKPIT_PATH not in sys.path:
    sys.path.insert(0, _COCKPIT_PATH)

# ── Timing budget ──────────────────────────────────────────────────────────────
DEADLINE_MS = 40


def _make_budget(deadline_ms: int = DEADLINE_MS):
    """Create a per-call budget closure with its own t0. Returns a callable
    that yields remaining-ms.

    Each dispatch() invocation gets its own budget — no module-level mutable
    state that could leak between calls or be skewed by import time
    (Codex M3 fix: dispatch() must not depend on module-level _t0).
    """
    t0 = time.perf_counter()

    def _budget_left_ms() -> float:
        return deadline_ms - (time.perf_counter() - t0) * 1000

    return _budget_left_ms


# ── Paths ──────────────────────────────────────────────────────────────────────
_SKILL_ROOT = Path(__file__).parents[1]
_RULES_PATH = Path.home() / ".ultron" / "config" / "intent-rules.yaml"
_MANIFEST_PATH = Path.home() / ".ultron" / "manifest.cache.json"
_INDEX_PATH = Path.home() / ".ultron" / "brain_index" / "index.db"
_TELEMETRY_PATH = Path.home() / ".ultron" / "telemetry" / "dispatcher-events.jsonl"

# ── Module-level caches (per process invocation) ───────────────────────────────
_rules_cache: dict[str, Any] = {}   # {"mtime": float, "rules": list}
_manifest_cache: dict[str, Any] = {}  # {"mtime": float, "skills": list}


# ── YAML minimal loader (stdlib fallback if pyyaml unavailable) ────────────────

def _load_yaml_rules(path: Path) -> list[dict]:
    """Load intent-rules.yaml using PyYAML (preferred) or minimal stdlib fallback."""
    try:
        import yaml  # type: ignore[import]
        with path.open("r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        return data.get("rules", []) if isinstance(data, dict) else []
    except ImportError:
        pass
    # Minimal YAML fallback: only parses the simple key-value format used here
    rules: list[dict] = []
    current: dict = {}
    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\n")
                if line.startswith("  - id:"):
                    if current:
                        rules.append(current)
                    current = {"id": line.split(":", 1)[1].strip()}
                elif line.startswith("    ") and ":" in line and current:
                    k, _, v = line.strip().partition(":")
                    v = v.strip().strip('"').strip("'")
                    # confidence as float
                    if k == "confidence":
                        try:
                            current[k] = float(v)
                        except ValueError:
                            pass
                    else:
                        current[k] = v
        if current:
            rules.append(current)
    except Exception:
        pass
    return rules


def _get_rules() -> list[dict]:
    """Return rules list, using module-level cache keyed by file mtime.

    Codex L1 fix: regex patterns are pre-compiled once per cache load and
    stored in rule['_compiled']. _match_rules uses the compiled object —
    avoids re.compile on every hook invocation (hot path).
    """
    try:
        mtime = _RULES_PATH.stat().st_mtime
    except OSError:
        return []
    cached = _rules_cache.get("data")
    if cached and _rules_cache.get("mtime") == mtime:
        return cached
    rules = _load_yaml_rules(_RULES_PATH)
    # Pre-compile patterns; rules with bad regex get a None marker so we skip
    # them in _match_rules without retrying re.compile each call.
    for rule in rules:
        pattern = rule.get("match", "")
        if not pattern:
            rule["_compiled"] = None
            continue
        try:
            rule["_compiled"] = re.compile(pattern, re.IGNORECASE)
        except re.error:
            rule["_compiled"] = None
    _rules_cache["mtime"] = mtime
    _rules_cache["data"] = rules
    return rules


def _get_manifest() -> list[dict]:
    """Return manifest skills list, using module-level cache keyed by file mtime."""
    try:
        mtime = _MANIFEST_PATH.stat().st_mtime
    except OSError:
        return []
    cached = _manifest_cache.get("data")
    if cached and _manifest_cache.get("mtime") == mtime:
        return cached
    try:
        with _MANIFEST_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        skills = data.get("skills", [])
    except Exception:
        skills = []
    _manifest_cache["mtime"] = mtime
    _manifest_cache["data"] = skills
    return skills


# ── Step 2 — Rules matching ────────────────────────────────────────────────────

def _match_rules(prompt: str) -> dict | None:
    """Return first matching rule dict or None.

    Uses pre-compiled regex from rule['_compiled'] populated by _get_rules.
    """
    rules = _get_rules()
    for rule in rules:
        compiled = rule.get("_compiled")
        if compiled is None:
            continue
        if compiled.search(prompt):
            return rule
    return None


# ── Step 3 — ZTMSI chunks_fts query ───────────────────────────────────────────

_FTS5_SAFE_RE = re.compile(r"[^\w\sÀ-ɏ]", re.UNICODE)


def _fts5_safe(text: str) -> str:
    """Strip FTS5 syntax chars from a user query.

    Removes anything that isn't a Unicode word char, space, or Latin extended
    chars (accented letters). Periods, asterisks, parens etc. cause FTS5 syntax
    errors when passed as MATCH arguments (e.g. '.ts' → 'ts', '(bug)' → 'bug').
    Returns a whitespace-normalised token string safe to pass to FTS5 MATCH.
    """
    cleaned = _FTS5_SAFE_RE.sub(" ", text)
    return " ".join(cleaned.split())


def _query_chunks_fts(prompt: str, top: int = 5,
                       budget_left_ms_fn=None) -> list[dict]:
    """Direct SQLite query against chunks_fts. Returns list of result dicts.

    Hard-bounded by remaining budget: refuses to run if <5ms left, opens DB in
    read-only immutable URI mode (no lock acquisition, fails fast), uses
    timeout=0 so a locked database returns SQLITE_BUSY immediately instead of
    waiting up to 500ms (Codex C1 critical fix). A progress handler aborts the
    query mid-execution if budget is exhausted.
    """
    if not _INDEX_PATH.exists():
        return []
    if budget_left_ms_fn is not None and budget_left_ms_fn() < 5:
        return []
    try:
        # Read-only + immutable: skips lock checks entirely, never blocks on
        # writers. The 'immutable=1' flag is safe because brain_index.py never
        # writes during a query — and even if it did, the dispatcher should not
        # see partial state for a hot-path hook.
        uri = f"file:{_INDEX_PATH.as_posix()}?mode=ro&immutable=1"
        conn = sqlite3.connect(uri, uri=True, timeout=0)
        try:
            # Progress handler: SQLite invokes this every N VDBE instructions
            # (we use 1000 — fine-grained enough to abort within a few ms).
            # Returning non-zero from the handler aborts the query with
            # SQLITE_INTERRUPT. Wrapped in try/except so a budget-fn failure
            # never kills the query.
            if budget_left_ms_fn is not None:
                def _progress() -> int:
                    try:
                        return 1 if budget_left_ms_fn() < 2 else 0
                    except BaseException:
                        return 0
                conn.set_progress_handler(_progress, 1000)
            sql = (
                "SELECT n.path, cf.chunk_idx, cf.token_est, "
                "snippet(chunks_fts, 0, ?, ?, ?, 10) AS snippet, "
                "bm25(chunks_fts) AS bm25_score, "
                "cf.layer, cf.category, cf.domain "
                "FROM chunks_fts cf "
                "JOIN notes n ON n.id = cf.note_id "
                "WHERE chunks_fts MATCH ? "
                "ORDER BY bm25_score LIMIT ?"
            )
            rows = conn.execute(sql, ("«", "»", "…", _fts5_safe(prompt), top)).fetchall()
        finally:
            conn.close()
    except Exception:
        return []
    return [
        {
            "note_path": r[0],
            "chunk_idx": r[1],
            "token_est": r[2],
            "snippet": r[3] or "",
            "bm25": r[4],
            "layer": r[5] or "",
            "category": r[6] or "",
            "domain": r[7] or "",
        }
        for r in rows
    ]


def _bm25_to_confidence(bm25_score: float) -> float:
    """Convert BM25 score (negative, lower = better) to [0,1] confidence.

    BM25 from FTS5 is negative (more negative = higher relevance).
    Empirically, scores around -20 to -5 are good matches.
    We clamp and normalize to [0, 1].
    """
    # Clamp score to [-25, 0]; -25 = max confidence, 0 = no match
    clamped = max(-25.0, min(0.0, bm25_score))
    # Normalize: -25 → 1.0, 0 → 0.0
    return abs(clamped) / 25.0


def _score_against_manifest(
    results: list[dict], manifest_skills: list[dict]
) -> list[dict]:
    """Try to match chunks results to manifest skill triggers. Returns scored routes."""
    if not results:
        return []
    routes = []
    best_chunk = results[0]
    # Build a text blob from top-3 chunks for keyword matching
    text_blob = " ".join(r["snippet"] + " " + r["note_path"] for r in results[:3]).lower()

    for skill in manifest_skills:
        skill_id = skill.get("id", "")
        triggers = skill.get("triggers", [])
        match_count = sum(1 for t in triggers if t.lower() in text_blob)
        if match_count > 0:
            base_conf = _bm25_to_confidence(best_chunk["bm25"])
            # Boost confidence based on trigger overlap
            boost = min(0.15, match_count * 0.05)
            conf = min(0.92, base_conf + boost)
            routes.append({
                "skill_id": skill_id,
                "ctx_path": best_chunk["note_path"],
                "tokens": best_chunk["token_est"],
                "confidence": conf,
                "source": "ztmsi",
            })

    # If no manifest match, still emit a pure ZTMSI route from the best chunk
    if not routes and results:
        base_conf = _bm25_to_confidence(best_chunk["bm25"])
        if base_conf >= 0.70:
            routes.append({
                "skill_id": None,
                "ctx_path": best_chunk["note_path"],
                "tokens": best_chunk["token_est"],
                "confidence": base_conf,
                "source": "ztmsi",
            })
    return routes


# ── Output formatting ──────────────────────────────────────────────────────────

def _sanitize(value: Any) -> str:
    """Strip newlines and ensure single-line output for any field value."""
    return str(value).replace("\n", " ").replace("\r", " ").strip()


# ── Telemetry ──────────────────────────────────────────────────────────────────

def _write_telemetry(
    prompt: str,
    route: str | None,
    conf: float,
    latency_ms: int,
    source: str,
    rule_id: str | None = None,
) -> None:
    """Append a JSONL telemetry event. Failures are silent.

    `rule_id` (v15.5.20+) records which YAML rule matched when source=="rules"
    so dead-rule detection over the telemetry corpus is possible.
    """
    try:
        _TELEMETRY_PATH.parent.mkdir(parents=True, exist_ok=True)
        prompt_hash = hashlib.sha1(prompt.encode("utf-8", errors="replace")).hexdigest()[:16]
        event = {
            "ts": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prompt_hash": prompt_hash,
            "route": route,
            "conf": round(conf, 4),
            "latency_ms": latency_ms,
            "source": source,
            "rule_id": rule_id,
        }
        with _TELEMETRY_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception:
        pass


# ── Main pipeline ──────────────────────────────────────────────────────────────

def _no_route() -> dict:
    """Structured result for a no-route outcome."""
    return {"line": "", "skill_id": None, "confidence": 0.0,
            "source": "none", "rule_id": None}


def _dispatch_result(prompt: str, budget_left_ms_fn=None) -> dict:
    """Structured dispatch — {line, skill_id, confidence, source, rule_id}.

    `line` is the string for stdout (or "" for no-route). The other fields
    carry the real routing data so main() writes telemetry straight from
    the dict instead of regex-parsing the display line — that parse was
    where the v15.4.13 em-dash leak crept in (`skill=—` became the logged
    `route`). Never raises; any exception yields a no-route result.

    Each invocation gets its own budget closure unless the caller provides
    one (Codex M3 fix: per-call t0, no module-level state leakage).
    """
    if budget_left_ms_fn is None:
        budget_left_ms_fn = _make_budget()
    try:
        return _dispatch_result_unsafe(prompt, budget_left_ms_fn)
    except BaseException:
        return _no_route()


def dispatch(prompt: str, budget_left_ms_fn=None) -> str:
    """Back-compat string API — the routing line, or "".

    Kept for the cockpit `intent_dispatcher` shim and the in-process tests
    (test_fallback_graceful, test_slash_command_internal_latency, …).
    main() uses _dispatch_result() for the structured form.
    """
    return _dispatch_result(prompt, budget_left_ms_fn)["line"]


_SHORT_ACK_RE = re.compile(
    r"^(si|sí|ok|vale|dale|yes|continua|continúa|continue|sigue|adelante|gracias|thx|thanks|nope|no|venga|listo)\.?$",
    re.IGNORECASE,
)


def _dispatch_result_unsafe(prompt: str, budget_left_ms_fn) -> dict:
    """Inner dispatch — returns the structured result dict. May raise."""
    # Step 1 — Slash command short-circuit
    if prompt.lstrip().startswith("/"):
        return _no_route()
    # v15.5.18 review: ack short-circuit. Acknowledgements ("si", "ok",
    # "continua", "sigue") don't carry routing intent — skip them so
    # they stop bloating the source=none bucket. (v15.5.11: only ack
    # patterns are skipped, not arbitrarily short prompts — single-token
    # technical nouns like "CUDA"/"UE5" must still route.)
    if _SHORT_ACK_RE.match(prompt.strip()):
        return _no_route()

    if budget_left_ms_fn() < 5:
        return _no_route()

    # Step 2 — Rules exact-match
    rule = _match_rules(prompt)
    if rule:
        confidence = float(rule.get("confidence", 0.90))
        skill_id = rule.get("skill") or rule.get("agent") or rule.get("suggest_tool")
        ctx_path = rule.get("ctx")
        tokens = 0
        if ctx_path:
            ctx_path = str(Path(ctx_path.replace("~", str(Path.home()))).as_posix())
        # ztmsi_query rules: use ZTMSI to find context
        if rule.get("ztmsi_query") and budget_left_ms_fn() >= 10:
            results = _query_chunks_fts(prompt, top=3,
                                          budget_left_ms_fn=budget_left_ms_fn)
            if results:
                ctx_path = results[0]["note_path"]
                tokens = results[0]["token_est"]

        # Build routing line — Codex M2 fix: include suggest_mode and
        # suggest_tool so canonical prompts are fully represented.
        pct = int(confidence * 100)
        skill_str = _sanitize(skill_id) if skill_id else "—"
        ctx_str = _sanitize(ctx_path) if ctx_path else "—"
        tok_str = str(int(tokens))
        line = f"[ULTRON·{pct}%] skill={skill_str} | ctx={ctx_str} ({tok_str}tok) | via=rules"
        suggest_mode = rule.get("suggest_mode")
        if suggest_mode:
            line += f" | mode={_sanitize(suggest_mode)}"
        suggest_tool = rule.get("suggest_tool")
        # If skill_id was already drawn from suggest_tool, don't double-print it.
        if suggest_tool and suggest_tool != skill_id:
            line += f" | tool={_sanitize(suggest_tool)}"
        if 0.70 <= confidence < 0.85:
            line += " (señal parcial)"
        return {"line": line, "skill_id": skill_id, "confidence": confidence,
                "source": "rules", "rule_id": rule.get("id")}

    if budget_left_ms_fn() < 10:
        return _no_route()

    # Step 3 — ZTMSI query + manifest lookup
    results = _query_chunks_fts(prompt, top=5,
                                  budget_left_ms_fn=budget_left_ms_fn)
    if results:
        manifest_skills = _get_manifest()
        routes = _score_against_manifest(results, manifest_skills)
        if routes:
            best = max(routes, key=lambda r: r["confidence"])
            # Threshold subido 0.70 → 0.85 (2026-05-09 intent-rules-precision):
            # ZTMSI con BM25 sobre vault notes da matches incidentales por
            # palabras comunes que no son skill triggers legítimos.
            if best["confidence"] >= 0.85:
                pct = int(best["confidence"] * 100)
                skill_str = _sanitize(best["skill_id"]) if best["skill_id"] else "—"
                ctx_str = _sanitize(best["ctx_path"]) if best["ctx_path"] else "—"
                tok_str = str(int(best["tokens"]))
                line = f"[ULTRON·{pct}%] skill={skill_str} | ctx={ctx_str} ({tok_str}tok) | via={best['source']}"
                if 0.85 <= best["confidence"] < 0.90:
                    line += " (señal parcial)"
                return {"line": line, "skill_id": best["skill_id"],
                        "confidence": best["confidence"],
                        "source": best["source"], "rule_id": None}

    # Step 4 — Fallthrough
    return _no_route()


# ── v15.3.5: agent auto-suggest (additive, budget-gated) ──────────────────────

# Independent budget for the agent suggestion path. The 40ms hook-wide budget
# (DEADLINE_MS) is reserved for the routing pipeline; agent suggestion adds a
# net new SQLite open + BM25 query that needs its own ms allowance. Empirically
# the agent FTS5 path completes in ~3-8ms warm, so 20ms is a safe ceiling.
_AGENT_BUDGET_MS = 20


def _build_agent_suggestion(prompt: str, budget_left_ms_fn=None) -> str:
    """Return a one-line agent suggestion or empty string.

    Wire-format (parallel to the routing line):
      [ULTRON·AGENTS] Consider delegating to subagent: <name1>, <name2> | via=fts

    Behaviour contract:
      * NEVER raises — any failure returns empty string.
      * Slash-command short-circuit — mirrors the dispatch() contract so
        `/whatever` produces NO output (Slash commands are pure UI directives,
        not prompts to route).
      * Short prompts (<12 chars) → no suggestion. Same threshold as
        auto-recall — too little signal to risk a wrong route.
      * Honours `agent_auto_suggest` feature gate (off ⇒ empty).
      * Uses its own _AGENT_BUDGET_MS allowance (default 20ms) — independent
        from the dispatch budget, which is frequently exhausted on no-route
        ZTMSI paths. The `budget_left_ms_fn` arg is accepted for backwards
        compatibility but is no longer consulted internally.
      * Additive: emitted as a separate line; does not modify the existing
        routing line or context packet.
      * FTS5-only path (sync-safe) — Qdrant lives in auto-recall.py.
    """
    if not prompt or prompt.lstrip().startswith("/"):
        return ""
    if len(prompt.strip()) < 12:
        return ""
    # Independent budget — see _AGENT_BUDGET_MS comment. The dispatch budget
    # is often consumed (or even negative) by the time we reach here on
    # no-route ZTMSI paths; agent suggestion would never run. With its own
    # closure we can still afford the ~3-8ms FTS5 lookup.
    agent_budget = _make_budget(_AGENT_BUDGET_MS)
    try:
        import agent_suggest  # type: ignore  # noqa: PLC0415 — lazy import
        if not agent_suggest.is_enabled():
            return ""
        hits = agent_suggest.query_agents_fts(
            prompt,
            budget_left_ms_fn=agent_budget,
        )
    except Exception:
        return ""
    if not hits:
        return ""
    # Cap names list length: top names sorted by score desc.
    hits = sorted(hits, key=lambda h: -h.get("score", 0.0))
    names = [_sanitize(h.get("name", "?")) for h in hits if h.get("name")]
    if not names:
        return ""
    top_score = int(round(hits[0].get("score", 0.0) * 100))
    return (
        f"[ULTRON·AGENTS·{top_score}%] Consider delegating to subagent: "
        f"{', '.join(names)} | via=fts"
    )


# ── Context packet builder (S3-B) ─────────────────────────────────────────────

def _build_context_packet(prompt: str, budget_left_ms_fn) -> str:
    """Try to build an L1 context packet for *prompt*. Returns empty on any failure.

    Lazy-imports context_packet_builder so module load time is unchanged.
    Budget-gated: requires ≥10ms remaining to attempt. All exceptions are
    silently swallowed — a missing or broken builder must NEVER break routing.
    """
    try:
        if budget_left_ms_fn() < 10:
            return ""
        import context_packet_builder  # noqa: PLC0415 — lazy import intentional
        # v15.5.15cap reduced from 600 → 300 tok. Dispatcher rarely
        # consumes the full 600; reducing the cap halves steady-state token cost
        # per turn (~150 → ~75 tok avg) without affecting precision in the
        # macro-test suite.
        packet = context_packet_builder.build(
            query=prompt,
            layer="L1",
            max_tokens=300,
            budget_left_ms_fn=budget_left_ms_fn,
        )
        return packet if isinstance(packet, str) else ""
    except Exception:
        return ""


# Maximum stdin payload accepted from Claude Code. Hard-capped to avoid
# unbounded memory consumption if the upstream stream is malformed or
# adversarial (Codex H1 fix). 1 MB is well above any realistic prompt JSON
# (Claude Code's prompt JSON is typically <10 KB).
_MAX_STDIN_BYTES = 1_048_576


def _read_stdin_bounded() -> bytes:
    """Read stdin with a size bound. Returns bytes (possibly empty).

    Uses os.read so we get EOF semantics directly from the OS — read returns
    when upstream closes the pipe. Reads in chunks until EOF or bound hit.
    If the bound is hit, we return what we have (the JSON parse will fail
    on truncated input, which the caller treats as exit-0-silent).
    """
    chunks: list[bytes] = []
    total = 0
    fd = 0  # stdin file descriptor
    while total < _MAX_STDIN_BYTES:
        try:
            chunk = os.read(fd, min(8192, _MAX_STDIN_BYTES - total))
        except OSError:
            break
        if not chunk:  # EOF
            break
        chunks.append(chunk)
        total += len(chunk)
    return b"".join(chunks)


def main() -> None:
    # F02 fix: import the hook input validator BEFORE starting the budget
    # timer. The first import from the cockpit module tree pulls in alerts
    # (~40ms cold-start on Windows), which would otherwise consume the
    # entire 40ms dispatch budget and starve telemetry/context-packet
    # injection. Putting it here charges the cost to harness startup, not
    # the dispatcher's internal deadline.
    try:
        from hook_input_validator import (
            validate as _hv_validate,
            _alert as _hv_alert,
        )
    except Exception:
        _hv_validate = None  # type: ignore[assignment]
        _hv_alert = None  # type: ignore[assignment]

    budget = _make_budget()
    try:
        # We read stdin ONCE (stdin can't be re-read) and then try the
        # validator against the parsed JSON. If validation fails the
        # validator raises an alert; we fall back to the unvalidated
        # parsed JSON so schema drift never silently drops a legitimate
        # user prompt.
        raw = _read_stdin_bounded()
        try:
            data = json.loads(raw)
        except Exception:
            sys.exit(0)
        if "\x00" in raw.decode("utf-8", errors="replace"):
            if _hv_alert is not None:
                try:
                    _hv_alert("intent-dispatcher",
                              "stdin contains null byte — rejected",
                              "UserPromptSubmit")
                except Exception:
                    pass
            sys.exit(0)
        # F-MaxDual-R2-Cnew1: fail-CLOSED on validation failure.
        # Previously this branch fell through with raw `data`, which
        # defeated the hardening claim. Hooks always exit 0; on a bad
        # payload we skip the dispatcher (Claude still receives the
        # prompt), which is the safer default.
        if _hv_validate is not None:
            try:
                vresult = _hv_validate("UserPromptSubmit", data)
            except Exception:
                vresult = None
            if vresult is not None:
                if vresult.ok and vresult.payload is not None:
                    data = vresult.payload
                else:
                    if _hv_alert is not None:
                        try:
                            _hv_alert(
                                "intent-dispatcher",
                                "validation failed: " + ", ".join(vresult.errors[:5]),
                                "UserPromptSubmit",
                            )
                        except Exception:
                            pass
                    sys.exit(0)

        if data.get("hook_event_name") != "UserPromptSubmit":
            sys.exit(0)

        prompt = data.get("prompt", "")
        if not isinstance(prompt, str):
            sys.exit(0)

        # Pass our budget closure so dispatch shares the same deadline as the
        # whole hook (stdin read already consumed some of it).
        # v15.5.21 em-dash refactor: structured dispatch. Telemetry is
        # written straight from the dict — no regex parse of the display
        # line, so `skill=—` can no longer leak into the logged `route`.
        # rule_id is now the real matched-rule id (the old `rule=` regex
        # never matched — the emitted line carries no `rule=` token).
        result = _dispatch_result(prompt, budget_left_ms_fn=budget)

        latency_ms = int(DEADLINE_MS - budget())
        line = result["line"]

        if line:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

        # v15.5.21: telemetry written UNCONDITIONALLY, from the structured
        # fields. The cold-start budget can be exhausted by the rules-YAML
        # load + dispatch; the routing line (if any) already reached stdout,
        # so a sub-millisecond JSONL append past the deadline is an
        # acceptable trade for the "every routed event is logged" invariant.
        # _write_telemetry swallows all I/O errors.
        _write_telemetry(prompt, result["skill_id"], result["confidence"],
                         latency_ms, result["source"], result["rule_id"])

        # S3-B: context packet — second line AFTER the routing line.
        # Budget-gated (≥10ms), only when there is a line to pair with.
        if line and budget() >= 10:
            ctx_packet = _build_context_packet(prompt, budget)
            if ctx_packet:
                sys.stdout.write(ctx_packet + "\n")
                sys.stdout.flush()

        # v15.3.5: agent auto-suggest line. Additive — fires even on a
        # no-route so agents are surfaced regardless of skill routing.
        agent_line = _build_agent_suggestion(prompt, budget)
        if agent_line:
            sys.stdout.write(agent_line + "\n")
            sys.stdout.flush()

    except BaseException:
        # NEVER write traceback to stdout — it pollutes Claude's injected context
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
