#!/usr/bin/env python3
"""
ULTRON v13.2 — Context Primer (el cable roto, ahora cerrado).

Genera ~/.ultron/.tmp/context.md — ≤400 tokens de contexto pre-computado
para el wake-up de sesión. Claude lee esto al inicio de TODA sesión.

Fuentes (todas best-effort, nunca bloquean):
  - pending_actions.json  → critical/blocking open items
  - recent-highlights.json → últimas N sesiones (1 línea cada una)
  - projects.json / INDEX.md → proyectos activos
  - decay-prime.json      → notas stale a refrescar
  - skill_graph.json      → qué memoria accede cada persona

Salida:
  ~/.ultron/.tmp/context.md    (Claude-readable, tree format, ≤400 tokens)
  ~/.ultron/.tmp/context.json  (structured, para hooks)

CLI:
    context_primer.py generate          # genera context.md + context.json
    context_primer.py show              # imprime el context.md generado
    context_primer.py stats             # muestra tamaño y fuentes usadas
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from ultron_paths import (
    TMP_DIR, COCKPIT_DIR, ULTRON_HOME, VAULT_DIR,
    PENDING_ACTIONS_JSON,
)

CONTEXT_MD   = TMP_DIR / "context.md"
CONTEXT_JSON = TMP_DIR / "context.json"
HIGHLIGHTS_J = TMP_DIR / "recent-highlights.json"
DECAY_J      = TMP_DIR / "decay-prime.json"
SKILL_GRAPH  = COCKPIT_DIR / "skill_graph.json"
PROJECTS_J   = COCKPIT_DIR / "projects.json"
MEMORY_MD    = ULTRON_HOME / "MEMORY.md"

MAX_BLOCKING  = 5
MAX_PROJECTS  = 4
MAX_HIGHLIGHTS= 4
MAX_STALE     = 3
MAX_SKILL_MAP = 5
MAX_RECALL    = 3  # F3: semantic recall hits via brain_index FTS5

# F3: FTS5 query sanitizer. Strips punctuation that FTS5 treats as syntax
# (.,:; -()*+"!? etc.) keeping ASCII + Spanish accented letters. Used to
# build a recall query from highlights/projects without crashing the parser.
_FTS_PUNCT = re.compile(r"[^\w\s áéíóúüñÁÉÍÓÚÜÑ]", re.UNICODE)
_FTS_STOPWORDS = {
    "que", "para", "como", "este", "esta", "estos", "estas", "una", "uno",
    "del", "las", "los", "por", "con", "sin", "the", "and", "for", "with",
    "ultron", "session", "claude",  # too common, drown signal
}


def _sanitize_fts(text: str, max_terms: int = 8) -> str:
    """Sanitize free text into an FTS5-safe OR'd term list."""
    cleaned = _FTS_PUNCT.sub(" ", text.lower())
    terms = [
        t for t in cleaned.split()
        if len(t) >= 4 and t not in _FTS_STOPWORDS
    ]
    return " ".join(terms[:max_terms])


def _recall_via_fts5(seed_text: str, *, top_n: int = MAX_RECALL,
                     exclude_paths: set[str] | None = None) -> list[dict]:
    """Return top-N notes from brain_index FTS5 matching the seed.

    Best-effort: returns [] if the DB is missing, the query fails, or the
    sanitized query is empty. Excludes paths already shown in highlights to
    avoid duplication. Total cost ~10 ms (no embeddings, no MPNet load)."""
    import sqlite3
    db = ULTRON_HOME / "brain_index" / "index.db"
    if not db.exists():
        return []
    query = _sanitize_fts(seed_text)
    if not query:
        return []
    sql = (
        "SELECT notes.path, notes.title, "
        "snippet(notes_fts, 1, '«', '»', '…', 8) AS snippet, "
        "bm25(notes_fts) AS rank "
        "FROM notes_fts JOIN notes ON notes_fts.rowid = notes.id "
        "WHERE notes_fts MATCH ? "
        "ORDER BY rank LIMIT ?"
    )
    excluded = exclude_paths or set()
    out: list[dict] = []
    try:
        conn = sqlite3.connect(str(db))
        try:
            for path, title, snippet, _rank in conn.execute(sql, (query, top_n * 2)):
                if path in excluded:
                    continue
                out.append({"path": path, "title": title or "", "snippet": snippet or ""})
                if len(out) >= top_n:
                    break
        finally:
            conn.close()
    except sqlite3.Error:
        return []
    return out


def _load_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _age_h(iso: str) -> float:
    try:
        return (datetime.now() - datetime.fromisoformat(iso)).total_seconds() / 3600
    except (ValueError, TypeError):
        return 0.0


def _age_str(h: float) -> str:
    if h < 1:
        return f"{int(h*60)}m"
    if h < 24:
        return f"{h:.0f}h"
    return f"{h/24:.0f}d"


def build_context() -> tuple[str, dict]:
    """Returns (context_md_text, context_dict)."""
    now = datetime.now()
    lines: list[str] = []
    data: dict = {"generated_at": now.isoformat(timespec="seconds")}

    # ── HEADER ───────────────────────────────────────────────────────────
    lines.append(f"# ULTRON CONTEXT · {now.strftime('%Y-%m-%d %H:%M')}")
    lines.append("> Lee MEMORY.md para orientación completa · brain_index.py query para deep dive")
    lines.append("")

    # ── BLOCKING / CRITICAL PENDING ──────────────────────────────────────
    pending_data = _load_json(PENDING_ACTIONS_JSON)
    blocking = []
    high_open = []
    if pending_data:
        for a in pending_data.get("actions", []):
            if a.get("status") != "open":
                continue
            sev = a.get("severity", "low")
            age = _age_h(a.get("created_at", ""))
            if a.get("blocking") or sev == "critical":
                blocking.append((sev, age, a))
            elif sev == "high":
                high_open.append((age, a))
        blocking.sort(key=lambda x: (-["critical","high","medium","low"].index(x[0])
                                       if x[0] in ["critical","high","medium","low"] else 0,
                                       -x[1]))

    data["blocking_count"] = len(blocking)
    data["high_open_count"] = len(high_open)

    if blocking:
        lines.append(f"## ⚡ BLOCKING ({len(blocking)})")
        for sev, age, a in blocking[:MAX_BLOCKING]:
            g = "🔴" if sev == "critical" else "🟠"
            blk = " [USER ACTION]" if "USER ACTION" in a.get("title", "") else ""
            lines.append(f"- {g} [{a['id']}] {a['title'][:60]}{blk} · {_age_str(age)} old")
        lines.append("")
        data["blocking"] = [{"id": a["id"], "title": a["title"][:60], "age_h": round(age, 1)}
                             for _, age, a in blocking[:MAX_BLOCKING]]
    else:
        lines.append("## ✅ BLOCKING: ninguno")
        lines.append("")

    # ── ACTIVE PROJECTS ───────────────────────────────────────────────────
    projects = _load_json(PROJECTS_J)
    active_projects = []
    if projects and isinstance(projects, list):
        active_projects = [p for p in projects if p.get("status") not in ("archived", "done")]
    elif projects and isinstance(projects, dict):
        active_projects = [p for p in projects.get("projects", [])
                           if p.get("status") not in ("archived", "done")]

    # Fallback: parse MEMORY.md for project list. (INDEX.md fallback retired
    # in v14 GENESIS — INDEX.md was replaced by L0 context.md + L1 brain_index.)
    if not active_projects:
        for md_path in (MEMORY_MD,):
            if md_path.exists():
                try:
                    text = md_path.read_text(encoding="utf-8")
                    m = re.search(r"## .{0,20}PROYECTOS ACTIVOS(.+?)(?:^##|\Z)",
                                  text, re.MULTILINE | re.DOTALL)
                    if m:
                        for line in m.group(1).splitlines():
                            if line.strip().startswith(("- ", "▸", "*")):
                                active_projects.append({"name": line.strip().lstrip("-▸* ")[:80]})
                        break
                except OSError:
                    pass

    if active_projects:
        lines.append(f"## 📁 PROYECTOS ACTIVOS ({len(active_projects)})")
        for p in active_projects[:MAX_PROJECTS]:
            name = p.get("name", "?")[:40]
            path = p.get("path", p.get("cwd", ""))
            path_short = Path(path).name if path else ""
            status = p.get("status", "")
            suffix = f" · {path_short}" if path_short and path_short != name else ""
            st_suffix = f" [{status}]" if status and status not in ("active",) else ""
            lines.append(f"- {name}{suffix}{st_suffix}")
        lines.append("")
        data["active_projects"] = [p.get("name", "?") for p in active_projects[:MAX_PROJECTS]]

    # ── RECENT SESSIONS ───────────────────────────────────────────────────
    highlights = _load_json(HIGHLIGHTS_J)
    if highlights and isinstance(highlights, list) and len(highlights) > 0:
        lines.append(f"## 🗃 SESIONES RECIENTES (últimas {min(len(highlights), MAX_HIGHLIGHTS)})")
        for h in highlights[:MAX_HIGHLIGHTS]:
            # Expected shape: {file, mtime, preview}
            preview = h.get("preview", h.get("summary", ""))
            # Extract first meaningful line from preview
            first = ""
            for ln in preview.splitlines():
                ln = ln.strip()
                if ln and not ln.startswith("#") and len(ln) > 10:
                    # v14.8 D22 fix: trim preview from 100 → 70 chars to keep
                    # context.md under its 400-tok soft budget.
                    first = ln[:70]
                    break
            mtime = h.get("mtime", "")[:10]
            lines.append(f"- {mtime}: {first}")
        lines.append("")
        data["recent_highlights_count"] = min(len(highlights), MAX_HIGHLIGHTS)

    # ── STALE NOTES ───────────────────────────────────────────────────────
    decay = _load_json(DECAY_J)
    stale_items = []
    if decay:
        items = decay if isinstance(decay, list) else decay.get("value", [])
        stale_items = [x for x in items if isinstance(x, dict)]

    if stale_items:
        lines.append(f"## 🔄 STALE (refrescar si el tema aparece)")
        for item in stale_items[:MAX_STALE]:
            title = item.get("title", "?")[:50]
            days = item.get("days_since", 0)
            lines.append(f"- {title} · {days:.0f}d")
        lines.append("")
        data["stale_count"] = len(stale_items)

    # ── RECALL (F3) — top-N notas semantically relevantes via FTS5 ───────
    # Construye seed text combinando últimos highlights + active projects, y
    # consulta brain_index FTS5 (BM25 ranking). Excluye paths que YA aparecen
    # en RECENT SESSIONS para no duplicar.
    seed_parts: list[str] = []
    excluded_paths: set[str] = set()
    if highlights and isinstance(highlights, list):
        for h in highlights[:2]:
            preview = h.get("preview", h.get("summary", "")) or ""
            for ln in preview.splitlines():
                ln = ln.strip()
                if ln and not ln.startswith("#") and len(ln) > 10:
                    seed_parts.append(ln[:140])
                    break
            hp = h.get("path") or h.get("file") or ""
            if hp:
                excluded_paths.add(hp)
    for p in active_projects[:2]:
        name = p.get("name", "")
        if name:
            seed_parts.append(name)
    seed_text = " ".join(seed_parts)
    recall = _recall_via_fts5(seed_text, top_n=MAX_RECALL,
                              exclude_paths=excluded_paths)
    if recall:
        lines.append(f"## 📚 RECALL (top-{len(recall)} brain_index)")
        for r in recall:
            title = (r.get("title") or Path(r.get("path", "")).stem)[:48]
            snip = (r.get("snippet") or "").replace("\n", " ").strip()[:70]
            lines.append(f"- {title} — {snip}")
        lines.append("")
        data["recall_count"] = len(recall)

    # ── SKILL MEMORY MAP ─────────────────────────────────────────────────
    # v14.8 D22 fix: collapsed from N persona-with-paths lines to a single
    # one-liner naming the personas with curated knowledge directories.
    # Detail moved off-context: callers run `skill_graph.py query <name>`.
    graph = _load_json(SKILL_GRAPH)
    if graph and isinstance(graph, list):
        nodes_with_knowledge = [n for n in graph if n.get("knowledge_files")]
        if nodes_with_knowledge:
            personas = " · ".join(
                n["persona"] for n in nodes_with_knowledge[:MAX_SKILL_MAP]
            )
            lines.append(
                f"## 🔀 SKILL MAP: {personas}  "
                "[deep: skill_graph.py query <persona>]"
            )
            lines.append("")
            data["skill_map_count"] = len(nodes_with_knowledge)

    # ── BRAIN COUNT (SSOT) ───────────────────────────────────────────────
    brain_count: int | None = None
    try:
        import sqlite3 as _sqlite3
        _db = ULTRON_HOME / "brain_index" / "index.db"
        if _db.exists():
            _conn = _sqlite3.connect(str(_db))
            brain_count = _conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
            _conn.close()
    except Exception:
        pass
    if brain_count is not None:
        lines.append(f"## 🧠 BRAIN: {brain_count} notas indexadas")
        lines.append("")
        data["brain_count"] = brain_count

    # ── FOOTER ───────────────────────────────────────────────────────────
    lines.append("---")
    lines.append(f"[deep dive: brain_index.py query \"<topic>\"]  "
                 f"[full: MEMORY.md]  "
                 f"[changelog: cockpit/changelog.ndjson]")

    text = "\n".join(lines)
    data["token_estimate"] = len(text) // 4  # rough ~4 chars/token
    return text, data


def cmd_generate(_args) -> int:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    text, data = build_context()
    utf8 = __import__("codecs").getwriter("utf-8")(open(CONTEXT_MD, "wb"))
    utf8.write(text)
    utf8.close()
    CONTEXT_JSON.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8"
    )
    tok = data.get("token_estimate", 0)
    blk = data.get("blocking_count", 0)
    print(f"[context_primer] context.md written ({tok} tokens est., {blk} blocking)")
    return 0


def cmd_show(_args) -> int:
    if CONTEXT_MD.exists():
        print(CONTEXT_MD.read_text(encoding="utf-8"))
    else:
        text, _ = build_context()
        print(text)
    return 0


def cmd_stats(_args) -> int:
    if not CONTEXT_MD.exists():
        print("[context_primer] context.md not yet generated. Run: context_primer.py generate")
        return 1
    text = CONTEXT_MD.read_text(encoding="utf-8")
    lines = text.splitlines()
    tokens = len(text) // 4
    mtime = datetime.fromtimestamp(CONTEXT_MD.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
    print(f"context.md: {len(text)} chars | ~{tokens} tokens | {len(lines)} lines | {mtime}")
    if CONTEXT_JSON.exists():
        d = _load_json(CONTEXT_JSON) or {}
        print(f"  blocking={d.get('blocking_count',0)} "
              f"projects={len(d.get('active_projects',[]))} "
              f"highlights={d.get('recent_highlights_count',0)} "
              f"stale={d.get('stale_count',0)}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="ULTRON Context Primer — genera context.md")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("generate", help="Genera context.md + context.json").set_defaults(func=cmd_generate)
    sub.add_parser("show",     help="Imprime context.md").set_defaults(func=cmd_show)
    sub.add_parser("stats",    help="Muestra métricas del context.md").set_defaults(func=cmd_stats)
    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
