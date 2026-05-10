#!/usr/bin/env python3
"""
ULTRON v12 Session Compactor — post-Stop synthesis pipeline.

The "active learning" component of the BRAIN. Reads the just-finished session
transcript, extracts topics, queries the brain index for related notes, asks
Codex (headless, gpt-5.5) to synthesize: episodic summary, decisions taken,
patterns identified, and proposed wikilinks. Appends the result to
~/.ultron-vault/50_SESSIONS_LOG/auto-<date>-<sid>.md so tomorrow's session
starts with yesterday's lessons in the index.

Triggered by Stop hook only when:
  - mode is HIGH/ULTRA/LEARN AND fresh (TTL passes via memory_sync should-push)
  - transcript exists for the current session-id

Token efficiency:
  - Reads only user prompts + final assistant texts (skips tool results, which
    are noise for synthesis)
  - One Codex call per session (~3-8K tokens out)
  - Output written to vault → next session's brain_index update picks it up

Usage:
    session_compactor.py auto              # use ~/.ultron/.tmp/current-session.json
    session_compactor.py run --session-id <UUID>
    session_compactor.py run --transcript <path-to-jsonl>
    session_compactor.py run --dry-run     # synthesize but don't write

Output goes to: ~/.ultron-vault/50_SESSIONS_LOG/auto-<YYYY-MM-DD>-<sid8>.md
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

# Ensure sibling modules (brain_config) are importable when run directly or from hooks
_COCKPIT_DIR = str(Path(__file__).parent)
if _COCKPIT_DIR not in sys.path:
    sys.path.insert(0, _COCKPIT_DIR)

CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"
VAULT = Path.home() / ".ultron-vault"
SESSIONS_LOG = VAULT / "50_SESSIONS_LOG"
SESSION_CACHE = Path.home() / ".ultron" / ".tmp" / "current-session.json"
INDEX_DB = Path.home() / ".ultron" / "brain_index" / "index.db"

# Skip thresholds + Codex timeout: defaults here, overridable via brain-config.
def _config():
    try:
        from brain_config import load as _load_cfg  # type: ignore
        return _load_cfg()
    except Exception:
        return {}


_CFG = _config()
# Raised from 4 → 8 (Auditor 2): compactor was firing for trivial sessions, generating
# vault notes with no novelty + Codex tax (~4K tk each). 50_SESSIONS_LOG/ was growing
# unbounded with auto-utf8test/test-aud noise.
MIN_TURNS = int(_CFG.get("session_min_turns", 8))
MIN_TOTAL_USER_CHARS = int(_CFG.get("session_min_user_chars", 1500))
# Skip session_ids that look like dev/test artifacts (utf8test, test-*, sample, debug)
_SKIP_SID_PATTERN = re.compile(r"^(utf8test|test-|sample-|debug-)", re.IGNORECASE)
CODEX_MODEL = "gpt-5.5"
CODEX_TIMEOUT_SEC = int(_CFG.get("codex_timeout_sec", 120))


# ── Transcript discovery ──────────────────────────────────────────────────────

def find_transcript(session_id: str | None) -> Path | None:
    """Locate the .jsonl transcript for the given session-id.

    FIX-4c (2026-05-03): Removed the "most-recent jsonl" fallback. If the
    session_id from session-init.ps1 cache doesn't match any transcript stem
    on disk, return None. The previous fallback could compact the transcript
    from a *different* concurrent session, generating polluted vault notes
    attributed to the wrong session_id.

    If matching fails consistently, the underlying bug is in session-init.ps1
    or in how Claude Code emits the transcript UUID — fix THERE, not via a
    silent fallback here.
    """
    if not CLAUDE_PROJECTS.exists():
        return None
    if not session_id:
        return None
    matched: list[tuple[float, Path]] = []
    for proj in CLAUDE_PROJECTS.iterdir():
        if not proj.is_dir():
            continue
        for jl in proj.glob("*.jsonl"):
            if not jl.stem.startswith(session_id):
                continue
            try:
                mtime = jl.stat().st_mtime
            except OSError:
                continue
            matched.append((mtime, jl))
    if matched:
        matched.sort(reverse=True)
        return matched[0][1]
    print(f"[compactor] no transcript matches session_id={session_id} — skipping (no fallback)",
          file=sys.stderr)
    return None


# ── Transcript parsing ────────────────────────────────────────────────────────

def parse_transcript(path: Path) -> dict:
    """Extract minimal signal: user prompts + assistant text turns.

    Returns {n_turns, n_user, total_chars, user_prompts: [str],
             assistant_texts: [str], first_ts, last_ts}.
    """
    user_prompts: list[str] = []
    assistant_texts: list[str] = []
    n_turns = 0
    first_ts = last_ts = None

    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = e.get("timestamp")
            if ts:
                if first_ts is None:
                    first_ts = ts
                last_ts = ts

            t = e.get("type")
            if t == "user":
                c = e.get("message", {}).get("content", "")
                if isinstance(c, str) and c.strip() and not c.startswith("<"):
                    user_prompts.append(c[:2000])
                    n_turns += 1
                elif isinstance(c, list):
                    for item in c:
                        if isinstance(item, dict) and item.get("type") == "text":
                            txt = item.get("text", "")
                            if txt.strip() and not txt.startswith("<"):
                                user_prompts.append(txt[:2000])
                                n_turns += 1
            elif t == "assistant":
                c = e.get("message", {}).get("content", [])
                for item in c if isinstance(c, list) else []:
                    if isinstance(item, dict) and item.get("type") == "text":
                        txt = item.get("text", "")
                        if len(txt) > 100:  # skip terse one-liners
                            assistant_texts.append(txt[:3000])

    total_chars = sum(len(p) for p in user_prompts)
    return {
        "n_turns": n_turns,
        "n_user": len(user_prompts),
        "total_chars": total_chars,
        "user_prompts": user_prompts,
        "assistant_texts": assistant_texts,
        "first_ts": first_ts,
        "last_ts": last_ts,
    }


# ── Brain Index integration ───────────────────────────────────────────────────

def extract_topics(parsed: dict, k: int = 6) -> list[str]:
    """Pull short topical phrases from user prompts. Heuristic: take the first
    sentence of the first 6 prompts, capped at 80 chars."""
    topics: list[str] = []
    for p in parsed["user_prompts"][:k]:
        first_sent = re.split(r"[.\n?!]", p, maxsplit=1)[0].strip()
        if first_sent:
            topics.append(first_sent[:80])
    return topics


def _load_synonyms() -> dict[str, str]:
    try:
        from brain_config import load_synonyms as _ls  # type: ignore
        return _ls()
    except Exception:
        return {}


# W3.2 / Fix3: loaded from ~/.ultron/cockpit/query-synonyms.json at startup
_SYNONYMS: dict[str, str] = _load_synonyms()


def _expand_fts_query(topic: str) -> str | None:
    """Return a synonym-expanded FTS5 query string, or None to use word-split default."""
    tl = topic.lower().strip()
    for term, expansion in _SYNONYMS.items():
        if tl == term or f" {term} " in f" {tl} " or tl.startswith(f"{term} "):
            return expansion
    return None


def query_brain(topics: list[str], top_k: int = 3) -> list[dict]:
    """For each topic, query brain index and collect top-K hits across topics."""
    if not INDEX_DB.exists():
        return []
    try:
        conn = sqlite3.connect(str(INDEX_DB), timeout=10)
    except sqlite3.OperationalError as exc:
        print(f"[compactor] WARN: brain DB locked, skipping context: {exc}", file=sys.stderr)
        return []
    seen: set[int] = set()
    results: list[dict] = []
    try:
        for topic in topics:
            # W3.2: try synonym expansion first for better recall
            expanded = _expand_fts_query(topic)
            if expanded:
                fts_q = expanded
            else:
                # FTS5 prefix matching: split topic into words, OR them
                words = [w for w in re.findall(r"\w{4,}", topic) if w.lower() not in
                          {"para", "pero", "como", "esto", "este", "esta", "esos"}]
                if not words:
                    continue
                fts_q = " OR ".join(f"{w}*" for w in words[:5])
            try:
                rows = conn.execute(
                    "SELECT n.id, n.path, n.title, snippet(notes_fts, 1, '«', '»', '…', 8) "
                    "FROM notes_fts JOIN notes n ON notes_fts.rowid = n.id "
                    "WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts) LIMIT ?",
                    (fts_q, top_k),
                ).fetchall()
            except sqlite3.OperationalError:
                continue
            for nid, path, title, snip in rows:
                if nid in seen:
                    continue
                seen.add(nid)
                results.append({"id": nid, "path": path, "title": title,
                                 "snippet": snip, "topic_match": topic})
    finally:
        conn.close()
    return results[:12]  # cap total


def query_distilled(topics: list[str], distilled_dir: Path,
                    lookback_days: int = 14) -> list[dict]:
    """Scan recent distilled JSONL files and return decision/pattern/seed tuples
    matching any of the given topics. Serves as the fast-scan retrieval tier for
    prior-session knowledge — complementing brain_index (which indexes vault notes)."""
    if not distilled_dir.exists():
        return []
    cutoff = datetime.now() - timedelta(days=lookback_days)
    # Split topics into individual keywords (≥4 chars) for substring matching
    topic_words = {
        w for kw in topics
        for w in re.findall(r"\w{4,}", kw.lower())
    }
    results: list[dict] = []
    try:
        files = sorted(distilled_dir.glob("*.jsonl"),
                       key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return []
    for f in files:
        try:
            if datetime.fromtimestamp(f.stat().st_mtime) < cutoff:
                continue
            lines = f.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            if not line.strip():
                continue
            try:
                t = json.loads(line)
            except json.JSONDecodeError:
                continue
            if t.get("action") not in ("decision", "pattern", "seed"):
                continue
            target = (t.get("target") or "").lower()
            if any(w in target for w in topic_words):
                results.append(t)
    return results[:10]


def cite_notes(note_ids: list[int], session_id: str) -> int:
    """Mark a list of notes as 'cited in this session' in decay_state.

    This closes the loop decay ↔ retrieval (Triple Kirkardo R3 finding):
    when a note is queried by the compactor and its content is injected
    into the synthesis prompt, the note is "fresh in the agent's mind" —
    so its decay score should reflect that. Increments verify_count and
    sets last_seen_in_session, but does NOT reset last_verified_at
    (citation ≠ verification — USER only verifies via explicit
    `ultron decay verify`).

    Returns the number of rows touched.
    """
    if not note_ids or not INDEX_DB.exists():
        return 0
    try:
        conn = sqlite3.connect(str(INDEX_DB), timeout=10)
    except sqlite3.OperationalError as exc:
        print(f"[WARN] decay_state update skipped (db locked): {exc}", file=sys.stderr)
        return 0
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS decay_state ("
            "  note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,"
            "  last_verified_at TEXT NOT NULL,"
            "  criticality TEXT NOT NULL DEFAULT 'medium',"
            "  verify_count INTEGER NOT NULL DEFAULT 0,"
            "  last_seen_in_session TEXT)"
        )
        touched = 0
        for nid in note_ids:
            try:
                row = conn.execute(
                    "SELECT 1 FROM decay_state WHERE note_id = ?", (nid,)
                ).fetchone()
                if row:
                    conn.execute(
                        "UPDATE decay_state SET verify_count = verify_count + 1,"
                        "  last_seen_in_session = ? WHERE note_id = ?",
                        (session_id[:32], nid),
                    )
                else:
                    src = conn.execute(
                        "SELECT mtime FROM notes WHERE id = ?", (nid,)
                    ).fetchone()
                    if not src:
                        continue
                    seed_ts = datetime.fromtimestamp(src[0]).isoformat()
                    conn.execute(
                        "INSERT INTO decay_state(note_id, last_verified_at, "
                        "  criticality, verify_count, last_seen_in_session) "
                        "VALUES (?, ?, 'medium', 1, ?)",
                        (nid, seed_ts, session_id[:32]),
                    )
                touched += 1
            except (sqlite3.OperationalError, sqlite3.DatabaseError):
                continue
        conn.commit()
    except (sqlite3.OperationalError, sqlite3.DatabaseError) as exc:
        print(f"[WARN] decay_state update aborted: {exc}", file=sys.stderr)
    finally:
        conn.close()
    return touched


# ── Synthesis via Codex ───────────────────────────────────────────────────────

SYNTH_PROMPT_TEMPLATE = """You are the ULTRON Session Compactor. Your job: synthesize the just-finished
session into actionable knowledge for tomorrow's session. Strict, factual, terse.

## Session metadata
- session_id: {session_id}
- date: {date}
- turns: {n_turns}
- duration: {first_ts} → {last_ts}

## User prompts (chronological, first 6 trimmed to 800 chars each)
{user_prompts_block}

## Assistant text turns (last 4 trimmed to 1500 chars each)
{assistant_texts_block}

## Existing related vault notes (brain_index hits — use these in `proposed_wikilinks`)
{candidate_notes_block}

## Output (STRICT JSON — no prose outside)

{{
  "summary": "<3 sentences. What was done, why, what changed. No fluff.>",
  "decisions": [
    {{"decision": "<short>", "rationale": "<short>", "scope": "<file/system/scope>"}}
  ],
  "patterns": [
    {{"pattern": "<rule observed>", "applies_when": "<context>", "novelty": "<new|reaffirmed>"}}
  ],
  "proposed_wikilinks": [
    {{"to_title": "<title from candidate notes>", "why": "<connection>"}}
  ],
  "open_questions": ["<things unresolved that future USER should remember>"],
  "next_session_seeds": ["<concrete ideas to pick up tomorrow>"]
}}

Be ruthless about signal. Empty arrays beat fluff. Cite actual user phrasing where possible."""


def build_synth_prompt(parsed: dict, candidates: list[dict],
                        session_id: str,
                        distilled_hits: list[dict] | None = None) -> str:
    user_block = "\n".join(
        f"- [{i+1}] {p[:800]}" for i, p in enumerate(parsed["user_prompts"][:6])
    ) or "(none)"
    asst_block = "\n\n".join(
        f"--- turn {i+1} ---\n{t[:1500]}"
        for i, t in enumerate(parsed["assistant_texts"][-4:])
    ) or "(none)"
    cand_block = "\n".join(
        f"- [{c['id']}] {c['title']} ({c['path']})\n  > {c['snippet']}"
        for c in candidates
    ) or "(no candidates from brain_index)"
    if distilled_hits:
        cand_block += "\n\n## Distilled hits from prior sessions:\n" + "\n".join(
            f"- [D/{d.get('ts','')}] {d['action']}: {d['target']}"
            f" [{d.get('domain','')}]"
            for d in distilled_hits
        )
    # Escape braces in all user-derived blocks so str.format() doesn't choke
    safe_user = user_block.replace("{", "{{").replace("}", "}}")
    safe_asst = asst_block.replace("{", "{{").replace("}", "}}")
    safe_cand = cand_block.replace("{", "{{").replace("}", "}}")

    return SYNTH_PROMPT_TEMPLATE.format(
        session_id=session_id[:8],
        date=datetime.now().strftime("%Y-%m-%d"),
        n_turns=parsed["n_turns"],
        first_ts=parsed["first_ts"] or "?",
        last_ts=parsed["last_ts"] or "?",
        user_prompts_block=safe_user,
        assistant_texts_block=safe_asst,
        candidate_notes_block=safe_cand,
    )


def _extract_root_json(text: str) -> str | None:
    """Find a top-level balanced JSON object in conversational text.

    Codex / Gemini wrap the JSON in prose ("Here's the JSON: { ... }"). The
    previous regex `\\{[\\s\\S]*?\\}` was non-greedy and "longest" -> with
    nested objects it grabbed an inner sub-object, breaking parsing.

    This walker iterates char-by-char tracking brace depth (string-aware),
    returning the first balanced top-level object. If multiple top-level
    objects exist, picks the LAST one (Codex sometimes prints intermediate
    drafts followed by the final answer).
    """
    candidates: list[str] = []
    i, n = 0, len(text)
    while i < n:
        if text[i] != "{":
            i += 1
            continue
        # Found a candidate start — walk forward tracking depth + string state
        depth = 0
        in_str = False
        escape = False
        start = i
        while i < n:
            c = text[i]
            if in_str:
                if escape:
                    escape = False
                elif c == "\\":
                    escape = True
                elif c == '"':
                    in_str = False
            else:
                if c == '"':
                    in_str = True
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        candidates.append(text[start:i + 1])
                        i += 1
                        break
            i += 1
        else:
            # Walked past EOF without closing — abort this candidate
            break
    return candidates[-1] if candidates else None


def run_codex_synth(prompt: str) -> dict | None:
    """Headless Codex call. Returns parsed JSON or None on failure."""
    codex_bin = shutil.which("codex")
    if not codex_bin:
        return None
    try:
        r = subprocess.run(
            [codex_bin, "exec", "-m", CODEX_MODEL, "-s", "read-only",
             "--skip-git-repo-check", "--ignore-user-config", "-"],
            input=prompt, capture_output=True, text=True,
            encoding="utf-8", timeout=CODEX_TIMEOUT_SEC,
            creationflags=_WIN_HIDDEN,
        )
    except subprocess.TimeoutExpired:
        print(f"[compactor] Codex timeout after {CODEX_TIMEOUT_SEC}s", file=sys.stderr)
        return None
    out = (r.stdout or "").strip()
    blob = _extract_root_json(out)
    if not blob:
        return None
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        return None


# ── Output ────────────────────────────────────────────────────────────────────

def render_markdown(synth: dict, parsed: dict, session_id: str,
                     candidates: list[dict]) -> str:
    """Render the synthesis JSON as Obsidian-flavored markdown."""
    date = datetime.now().strftime("%Y-%m-%d")
    lines = [
        "---",
        f"name: auto-{date}-{session_id[:8]}",
        f"date: {date}",
        f"session_id: {session_id}",
        "type: session-log",
        "auto_generated: true",
        "tags: [auto-compacted, session]",
        "---",
        "",
        f"# Session {date} — {session_id[:8]} (auto-compacted)",
        "",
        f"> Generated by `session_compactor.py` from transcript "
        f"({parsed['n_turns']} turns, {parsed['total_chars']} chars).",
        "",
        "## Summary",
        "",
        synth.get("summary", "(no summary)"),
        "",
    ]

    decisions = synth.get("decisions") or []
    if decisions:
        lines.append("## Decisions")
        lines.append("")
        for d in decisions:
            lines.append(f"- **{d.get('decision', '?')}** — {d.get('rationale', '')} "
                          f"_(scope: {d.get('scope', '?')})_")
        lines.append("")

    patterns = synth.get("patterns") or []
    if patterns:
        lines.append("## Patterns observed")
        lines.append("")
        for p in patterns:
            tag = "🆕" if p.get("novelty") == "new" else "🔁"
            lines.append(f"- {tag} **{p.get('pattern', '?')}** — applies when "
                          f"_{p.get('applies_when', '?')}_")
        lines.append("")

    wl = synth.get("proposed_wikilinks") or []
    if wl:
        lines.append("## Proposed wikilinks")
        lines.append("")
        for link in wl:
            title = link.get("to_title", "?")
            lines.append(f"- [[{title}]] — {link.get('why', '')}")
        lines.append("")

    oq = synth.get("open_questions") or []
    if oq:
        lines.append("## Open questions")
        lines.append("")
        lines.extend(f"- {q}" for q in oq)
        lines.append("")

    seeds = synth.get("next_session_seeds") or []
    if seeds:
        lines.append("## Next-session seeds")
        lines.append("")
        lines.extend(f"- {s}" for s in seeds)
        lines.append("")

    if candidates:
        lines.append("## Related vault notes (brain_index)")
        lines.append("")
        for c in candidates:
            lines.append(f"- {c['title']} (`{c['path']}`)")
        lines.append("")

    return "\n".join(lines)


# ── Structured Distillation (W2.1) ────────────────────────────────────────────

_DOMAIN_SIGNALS: list[tuple[str, str]] = [
    ("ue5", "ue5"), ("unreal", "ue5"), ("blueprint", "ue5"),
    ("unity", "unity"), ("netcode", "ue5"), ("replication", "ue5"),
    ("opengl", "opengl"), ("vulkan", "opengl"), ("shader", "opengl"),
    ("supabase", "supabase"), ("nextjs", "nextjs"), ("next.js", "nextjs"),
    ("react", "nextjs"), ("typescript", "typescript"),
    ("python", "python"), ("c++", "cpp"), ("cpp", "cpp"),
    ("skill", "claude-platform"), ("ultron", "claude-platform"),
    ("memory", "claude-platform"), ("codex", "claude-platform"),
    ("gemini", "claude-platform"), ("hook", "claude-platform"),
    ("vault", "claude-platform"), ("brain", "claude-platform"),
]


def _infer_domain(text: str) -> str:
    tl = text.lower()
    for sig, dom in _DOMAIN_SIGNALS:
        if sig in tl:
            return dom
    return "general"


def write_distilled_tuples(synth: dict, parsed: dict, session_id: str,
                            out_dir: Path) -> Path:
    """Write compact JSON-L distillation alongside the markdown vault note.

    Each tuple ≈ 38 tokens. Serves as a fast-scan routing/retrieval tier:
    decisions, patterns, and next-session seeds extracted from Codex synthesis.
    Output: ~/.ultron-vault/50_SESSIONS_LOG/distilled/auto-<date>-<sid8>.jsonl
    """
    date = datetime.now().strftime("%Y-%m-%d")
    sid8 = session_id[:8]
    tuples: list[dict] = []

    tuples.append({
        "ts": date, "sid": sid8, "domain": "session",
        "action": "compacted",
        "target": f"{parsed['n_turns']}t/{parsed['total_chars']}c",
        "result": "ok", "tags": ["session-log"],
    })

    for d in (synth.get("decisions") or []):
        text = d.get("decision", "")
        tuples.append({
            "ts": date, "sid": sid8,
            "domain": _infer_domain(text + " " + d.get("scope", "")),
            "action": "decision", "target": text[:80],
            "result": d.get("scope", "?"), "tags": ["decision"],
        })

    for p in (synth.get("patterns") or []):
        text = p.get("pattern", "")
        novelty = p.get("novelty", "?")
        tuples.append({
            "ts": date, "sid": sid8,
            "domain": _infer_domain(text + " " + p.get("applies_when", "")),
            "action": "pattern", "target": text[:80],
            "result": novelty, "tags": ["pattern", novelty],
        })

    for seed in (synth.get("next_session_seeds") or []):
        tuples.append({
            "ts": date, "sid": sid8,
            "domain": _infer_domain(seed),
            "action": "seed", "target": seed[:80],
            "result": "pending", "tags": ["next-session"],
        })

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"auto-{date}-{sid8}.jsonl"
    with open(out_path, "w", encoding="utf-8") as f:
        for t in tuples:
            f.write(json.dumps(t, ensure_ascii=False) + "\n")
    return out_path


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_run(args) -> int:
    transcript: Path | None
    session_id: str

    if args.transcript:
        transcript = Path(args.transcript)
        session_id = transcript.stem
    else:
        sid = args.session_id
        if not sid and SESSION_CACHE.exists():
            try:
                cache = json.loads(SESSION_CACHE.read_text(encoding="utf-8"))
                sid = cache.get("SessionId") or cache.get("session_id")
            except (OSError, json.JSONDecodeError):
                sid = None
        transcript = find_transcript(sid)
        if not transcript:
            print(f"[error] No transcript found for session-id={sid}", file=sys.stderr)
            return 1
        session_id = sid or transcript.stem

    if not transcript.exists():
        print(f"[error] Transcript missing: {transcript}", file=sys.stderr)
        return 1

    # Skip dev/test session_ids (utf8test, test-*, sample-*, debug-*) — they
    # leaked into permanent vault storage in earlier runs (4 polluting files
    # surfaced by Auditor 2 of Kirkardo Triple Audit).
    if _SKIP_SID_PATTERN.match(session_id):
        print(f"[compactor] skip: dev/test session_id pattern: {session_id}")
        return 0

    print(f"[compactor] transcript: {transcript}")
    parsed = parse_transcript(transcript)
    print(f"[compactor] turns={parsed['n_turns']} chars={parsed['total_chars']}")

    if parsed["n_turns"] < MIN_TURNS:
        print(f"[compactor] skip: only {parsed['n_turns']} turns (<{MIN_TURNS})")
        return 0
    if parsed["total_chars"] < MIN_TOTAL_USER_CHARS:
        print(f"[compactor] skip: user prompts too short")
        return 0

    # Idempotency guard: if today's vault note for this sid already exists AND
    # is newer than the transcript, the compactor already ran on this session
    # (Stop hook fires multiple times per long session — Auditor 2 finding).
    sid8 = session_id[:8]
    today_str = datetime.now().strftime("%Y-%m-%d")
    existing_note = SESSIONS_LOG / f"auto-{today_str}-{sid8}.md"
    if existing_note.exists() and not args.dry_run:
        try:
            if existing_note.stat().st_mtime >= transcript.stat().st_mtime:
                print(f"[compactor] skip: vault note already current ({existing_note.name})")
                return 0
        except OSError:
            pass

    topics = extract_topics(parsed)
    print(f"[compactor] topics: {len(topics)}")
    candidates = query_brain(topics)
    print(f"[compactor] brain_index candidates: {len(candidates)}")

    distilled_hits = query_distilled(topics, SESSIONS_LOG / "distilled")
    print(f"[compactor] distilled hits: {len(distilled_hits)}")

    # Citation tracking (Triple Kirkardo R3 closure): bump decay verify_count
    # for every note the compactor cited. The note was seen in the agent's
    # working set today — that signal should reduce its staleness score.
    if candidates and not args.dry_run:
        cited_n = cite_notes([c["id"] for c in candidates], session_id)
        print(f"[compactor] decay touched: {cited_n} notes cited")

    prompt = build_synth_prompt(parsed, candidates, session_id, distilled_hits)
    if args.dry_run:
        print("[compactor] dry-run — printing prompt:")
        print("=" * 70)
        print(prompt)
        return 0

    print("[compactor] calling Codex (gpt-5.5)…")
    synth = run_codex_synth(prompt)
    if not synth:
        print("[compactor] Codex synthesis failed (no JSON)", file=sys.stderr)
        return 2

    md = render_markdown(synth, parsed, session_id, candidates)
    SESSIONS_LOG.mkdir(parents=True, exist_ok=True)
    out_path = SESSIONS_LOG / f"auto-{datetime.now().strftime('%Y-%m-%d')}-{session_id[:8]}.md"
    out_path.write_text(md, encoding="utf-8")
    print(f"[compactor] wrote → {out_path}")

    # W2.1: compact JSON-L distillation alongside markdown vault note
    distilled_path = write_distilled_tuples(
        synth, parsed, session_id, SESSIONS_LOG / "distilled"
    )
    print(f"[compactor] distilled → {distilled_path}")
    return 0


def cmd_auto(_args) -> int:
    """Stop-hook entry point: same as 'run' but tolerant of missing pieces."""
    args = argparse.Namespace(transcript=None, session_id=None, dry_run=False)
    rc = cmd_run(args)
    if rc != 0:
        # Stop hook should never block — log error, return 0
        print(f"[compactor] auto exited rc={rc} — ignoring (Stop hook never blocks)")
        return 0
    return 0


def main() -> int:
    p = argparse.ArgumentParser(
        prog="session_compactor",
        description="ULTRON v12 Session Compactor — synthesize session into vault note",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("run", help="Run synthesis explicitly")
    sp.add_argument("--transcript", help="Path to .jsonl transcript")
    sp.add_argument("--session-id", help="Session UUID prefix to find")
    sp.add_argument("--dry-run", action="store_true",
                     help="Print prompt + skip Codex call")
    sp.set_defaults(func=cmd_run)

    sub.add_parser("auto", help="Stop-hook entry (auto-detect from cache)").set_defaults(
        func=cmd_auto)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
