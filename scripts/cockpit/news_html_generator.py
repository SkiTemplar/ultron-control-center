#!/usr/bin/env python3
"""
ULTRON Times — News HTML Generator (v15.5.18 "Topics + Date-Novelty Edition").

Flow:
1. Build prompt from a local newsletter SKILL.md template + section config
2. Inject --days, --theme, --notes, dedup block into the prompt
3a. [default]   Call Gemini CLI headless → capture stdout HTML → write file → autoopen
3b. [clipboard] Copy prompt to clipboard → user pastes into Gemini/Claude session

Sections: tech (default, the only built-in) + any registered custom section
in ~/.ultron/news_categories.json.

Topic personalisation (v15.5.18):
- File: ~/.ultron/cockpit/news-topics.json (user-editable, gitignored)
- Defaults: ["AI", "Claude Code", "GitHub Claude tooling repos"]
- If the file is missing, defaults are used and a one-time hint is logged.
- Topics are injected into the prompt as PRIORIDAD TEMÁTICA and steer the
  HERO / first-sections / THE BRIEF picks.

Date-novelty (v15.5.18):
- Only articles published today or yesterday (UTC date or local — we accept
  either; the model receives an explicit "TODAY=YYYY-MM-DD, YESTERDAY=..." block).
- Older items are allowed ONLY when they were not covered before (DB miss) —
  the prompt instructs the model to skip stale items, and the DB filter
  enforces this post-hoc against `published_at` when the model returns it.
- The "titulares ya publicados" block was removed from the prompt entirely
  (per user feedback): we no longer feed historical headlines back to the LLM;
  novelty is decided by date + DB hash filter instead.

SQLite dedup history:
- DB: ~/.ultron/cockpit/news_history.db
  Schema (single table news_history):
    id, hash_url, hash_title, hash_summary, title, url, source, summary,
    priority_score, section, published_at, inserted_at
  Indexes: idx_news_hash_url, idx_news_hash_title
- Articles are recorded AFTER a successful HTML render. Cleanup is automatic
  on every run (rows older than DEDUP_WINDOW_DAYS=7 are deleted before the
  fresh-articles filter runs). A manual --cleanup flag is also provided.

Usage:
    python news_html_generator.py                              # tech, 3 days
    python news_html_generator.py --days 7                    # last week
    python news_html_generator.py --theme "AI security week"  # focus topic
    python news_html_generator.py --notes "cover the Gemini 3 launch specifically"
    python news_html_generator.py --clipboard
    python news_html_generator.py --model gemini-2.5-flash
    python news_html_generator.py --no-open
    python news_html_generator.py --no-dedup                  # skip deduplication
    python news_html_generator.py --cleanup                   # delete rows >7d, then exit
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sqlite3
import subprocess
import sys
import webbrowser
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Generator

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import COCKPIT_DIR, NEWS_DIR  # noqa: E402

NEWS_CATEGORIES_FILE = NEWS_DIR.parent / "news_categories.json"

# User-editable topic personalisation (v15.5.18). Gitignored. Hot-loaded
# at every run; missing file → defaults.
NEWS_TOPICS_FILE = COCKPIT_DIR / "news-topics.json"
DEFAULT_TOPICS = ["AI", "Claude Code", "GitHub Claude tooling repos"]

DEFAULT_MODEL = "gemini-3.1-pro"
GEMINI_TIMEOUT_SEC = 600
# Date-novelty: only accept items at most NOVELTY_MAX_AGE_DAYS old
# (today + yesterday by default; the value is exposed via --days but
# capped at 2 unless the user explicitly overrides it).
NOVELTY_MAX_AGE_DAYS = 2
# DB coverage retention: the dedup history is wiped of rows older than this
# on every run AND by --cleanup. Aligns with the user spec: "Cada semana se
# elimina ese archivo para que no tenga noticias ilimitadas."
DEDUP_WINDOW_DAYS = 7
# Legacy file-based dedup window (kept for backward-compat helper functions
# even though the prompt no longer surfaces "titulares ya publicados").
DEDUP_DAYS = 7
DEDUP_MAX_URLS = 80
DEDUP_MIN_NEWS = 25

# SQLite DB lives alongside the other cockpit data files.
NEWS_HISTORY_DB = COCKPIT_DIR / "news_history.db"


def load_topics() -> tuple[list[str], bool]:
    """Return (topics, from_file).

    Reads the user-editable ~/.ultron/cockpit/news-topics.json. Falls back to
    DEFAULT_TOPICS when the file is missing, empty, or malformed (the second
    return value tells the caller whether the load came from disk so we can
    print a one-time hint in the default case).
    """
    if not NEWS_TOPICS_FILE.exists():
        return list(DEFAULT_TOPICS), False
    try:
        data = json.loads(NEWS_TOPICS_FILE.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError):
        return list(DEFAULT_TOPICS), False
    topics = data.get("topics") if isinstance(data, dict) else None
    if not isinstance(topics, list):
        return list(DEFAULT_TOPICS), False
    cleaned = [str(t).strip() for t in topics if str(t).strip()]
    if not cleaned:
        return list(DEFAULT_TOPICS), False
    return cleaned, True

# ── Built-in section configs ───────────────────────────────────────────────────

BUILTIN_SECTIONS: dict[str, dict] = {
    "tech": {
        "label": "Tech & AI",
        "tagline": "AI · Tech · Dev · Security — Daily Brief",
        "accent": "#ffd089",
        "file_suffix": "",
        "sources": (
            "Blogs oficiales (Anthropic, OpenAI, Google AI, DeepMind, Meta AI, Mistral, xAI, DeepSeek); "
            "arxiv cs.AI/cs.CL/cs.SE; HuggingFace papers; "
            "GitHub trending + GitHub Blog; Hacker News front page (top 30); "
            "TechCrunch, The Verge, Ars Technica, The Information; "
            "Cloudflare Blog, Vercel Blog, AWS What's New, Azure updates, GCP releases; "
            "Microsoft DevBlogs, JetBrains releases, Mozilla Hacks; "
            "NVD CVEs (últimos 7d, CVSS≥7), GitHub Advisory DB; "
            "Reuters Tech, Bloomberg Tech, FT Tech para markets/funding; "
            "Release notes Unreal Engine / Unity / JetBrains"
        ),
        "focus_sections": (
            "1. HERO — noticia más impactante del día (AI / Tech / Security)\n"
            "2. AI RESEARCH (3-4): papers notables, benchmarks, evals, breakthroughs\n"
            "3. AI INDUSTRY (3-4): lanzamientos de modelos, APIs, agents, M&A AI\n"
            "4. DEV TOOLING & AGENTS (3-4): Claude Code, Codex, Cursor, Windsurf, "
            "Cline, Aider, MCP servers, IDE integrations\n"
            "5. TECH PLATFORMS (2-3): cloud (AWS/Azure/GCP), Vercel, Cloudflare, "
            "GitHub releases, framework majors, language releases\n"
            "6. SECURITY & REGULATION (2-3): CVEs críticos, supply chain, "
            "prompt injection, AI safety, EU AI Act, FTC, regulators\n"
            "7. MARKETS & FUNDING (1-2): rounds, IPOs, layoffs, M&A en AI/Tech\n"
            "8. GAME DEV CORNER (1 si hay): UE5, Unity, GAS, shaders\n"
            "9. THE BRIEF (8-12 one-liners con link)\n"
        ),
        "priority_note": (
            "PRIORIZA: herramientas que el usuario usa (Claude Code, UE5, Python, TypeScript, C#). "
            "Modelos AI nuevos. CVEs críticos. Tendencias de adopción de agentes AI. "
            "Cobertura horizontal: AI + Tech + Security; no solo AI."
        ),
        "min_news": DEDUP_MIN_NEWS,
    },
}


# ── Section loader ─────────────────────────────────────────────────────────────

def load_sections() -> dict[str, dict]:
    """Merge builtin sections with user-registered custom sections."""
    sections = dict(BUILTIN_SECTIONS)
    if NEWS_CATEGORIES_FILE.exists():
        try:
            data = json.loads(NEWS_CATEGORIES_FILE.read_text(encoding="utf-8"))
            for name, cfg in data.get("custom_sections", {}).items():
                if name not in sections:
                    sections[name] = cfg
        except (json.JSONDecodeError, OSError):
            pass
    return sections


def section_output_path(cfg: dict, date_str: str) -> Path:
    suffix = cfg.get("file_suffix", "")
    return NEWS_DIR / f"newsletter-{date_str}{suffix}.html"


def today_existing_editions(sections: dict, date_str: str) -> dict[str, Path]:
    """Return {label: path} for today's editions that already exist on disk."""
    existing: dict[str, Path] = {}
    for name, cfg in sections.items():
        p = section_output_path(cfg, date_str)
        if p.exists():
            existing[cfg["label"]] = p
    return existing


# ── Deduplication (file-based, legacy) ────────────────────────────────────────

# Tracking-param strip list — avoids treating same article with utm_* as new.
_TRACKING_PARAMS = re.compile(
    r"[?&](utm_[a-z]+|fbclid|gclid|mc_[a-z]+|ref|ref_src|s|igshid|spm|src|"
    r"campaign_id|email_token|email_subject)=[^&]*",
    re.IGNORECASE,
)


def canonicalize_url(url: str) -> str:
    """Normalize URL for dedup — lowercase host, strip trackers, drop trailing slash."""
    url = url.strip()
    url = _TRACKING_PARAMS.sub("", url)
    # Collapse '?&' / '?' artifacts left after tracker strip
    url = re.sub(r"\?&", "?", url)
    url = re.sub(r"[?&]+$", "", url)
    # Lowercase scheme + host (path is case-sensitive)
    m = re.match(r"^(https?://)([^/]+)(/?.*)$", url, re.IGNORECASE)
    if m:
        url = m.group(1).lower() + m.group(2).lower() + m.group(3)
    # Drop trailing slash unless root
    if url.endswith("/") and url.count("/") > 3:
        url = url[:-1]
    return url


def normalize_title(title: str) -> str:
    """Normalize headline for dedup — lowercase, collapse whitespace, strip punctuation."""
    t = title.lower()
    t = re.sub(r"[^\w\s]", " ", t, flags=re.UNICODE)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def extract_article_urls(html: str) -> list[str]:
    """Extract external article URLs from newsletter HTML (canonicalized)."""
    found = re.findall(r'href="(https?://[^"]{15,300})"', html)
    skip_fragments = ("javascript:", "#", "mailto:", "file://", "localhost",
                      "twitter.com/intent", "facebook.com/sharer", "linkedin.com/share")
    out: list[str] = []
    for u in found:
        if any(s in u for s in skip_fragments):
            continue
        out.append(canonicalize_url(u))
    return out


def extract_article_titles(html: str) -> list[str]:
    """Extract headline-level titles (h1/h2/h3) from newsletter HTML."""
    titles = re.findall(r"<h[123][^>]*>(.+?)</h[123]>", html, re.DOTALL | re.IGNORECASE)
    out: list[str] = []
    for raw in titles:
        clean = re.sub(r"<[^>]+>", "", raw)  # strip nested tags (e.g. <a>)
        clean = re.sub(r"&\w+;", " ", clean)  # strip HTML entities
        clean = clean.strip()
        if 12 <= len(clean) <= 220:  # reject icons/badges + long blocks
            out.append(clean)
    return out


def load_recent_dedup_corpus(cfg: dict, days: int = DEDUP_DAYS) -> tuple[list[str], list[str], int]:
    """Return (urls, titles, file_count) from recent newsletters of this section.

    URLs and titles are deduplicated within the corpus. file_count is how many
    historic newsletter files contributed to the dedup set — surfaced in logs.
    """
    cutoff = datetime.now() - timedelta(days=days)
    suffix = cfg.get("file_suffix", "")
    pattern = f"newsletter-*{suffix}.html" if suffix else "newsletter-*.html"

    all_urls: list[str] = []
    all_titles: list[str] = []
    file_count = 0
    for f in NEWS_DIR.glob(pattern):
        # For tech (no suffix), skip section-specific files (they have extra suffixes)
        if not suffix and re.search(r"newsletter-\d{4}-\d{2}-\d{2}-.+\.html", f.name):
            continue
        try:
            mtime = datetime.fromtimestamp(f.stat().st_mtime)
        except OSError:
            continue
        if mtime < cutoff:
            continue
        try:
            html = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        all_urls.extend(extract_article_urls(html))
        all_titles.extend(extract_article_titles(html))
        file_count += 1

    seen_url: set[str] = set()
    urls_out: list[str] = []
    for u in all_urls:
        if u not in seen_url:
            seen_url.add(u)
            urls_out.append(u)

    seen_title: set[str] = set()
    titles_out: list[str] = []
    for t in all_titles:
        norm = normalize_title(t)
        if norm and norm not in seen_title:
            seen_title.add(norm)
            titles_out.append(t)

    return urls_out[:DEDUP_MAX_URLS], titles_out[:DEDUP_MAX_URLS], file_count


def load_recent_dedup_urls(cfg: dict, days: int = DEDUP_DAYS) -> list[str]:
    """Backward-compat shim — returns URLs only. Prefer load_recent_dedup_corpus."""
    urls, _titles, _count = load_recent_dedup_corpus(cfg, days=days)
    return urls


# ── SQLite dedup history ───────────────────────────────────────────────────────

_DB_SCHEMA = """
CREATE TABLE IF NOT EXISTS news_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    hash_url       TEXT NOT NULL,
    hash_title     TEXT NOT NULL,
    hash_summary   TEXT,
    title          TEXT NOT NULL,
    url            TEXT NOT NULL,
    source         TEXT,
    summary        TEXT,
    priority_score REAL,
    section        TEXT,
    published_at   TEXT,
    inserted_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_news_hash_url   ON news_history(hash_url);
CREATE INDEX IF NOT EXISTS idx_news_hash_title ON news_history(hash_title);
"""


def _sha1(text: str) -> str:
    """Return the lowercase hex SHA-1 of *text* encoded as UTF-8."""
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _hash_url(url: str) -> str:
    """Canonical-URL hash: strip tracking params + fragments, lowercase host."""
    return _sha1(canonicalize_url(url))


def _hash_title(title: str) -> str:
    """Normalised-title hash: lowercase, strip punctuation, collapse whitespace."""
    return _sha1(normalize_title(title))


def _hash_summary(summary: str | None) -> str | None:
    """SHA-1 of first 80 chars of normalised summary, or None if no summary."""
    if not summary:
        return None
    normalised = re.sub(r"\s+", " ", summary.lower().strip())[:80]
    return _sha1(normalised) if normalised else None


@contextmanager
def open_db() -> Generator[sqlite3.Connection, None, None]:
    """Open (and lazily create) news_history.db, yielding a ready connection."""
    NEWS_HISTORY_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(NEWS_HISTORY_DB))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        conn.executescript(_DB_SCHEMA)
        conn.commit()
        yield conn
    finally:
        conn.close()


def seen_recently(
    conn: sqlite3.Connection,
    hash_url: str,
    hash_title: str,
    hash_summary: str | None,
    days: int = 30,
) -> bool:
    """Return True if any of the three hashes appear in news_history within *days* days.

    Any single match is sufficient — same URL with different title, or same title
    with different URL, both count as a duplicate.
    """
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")

    # Always check URL and title hashes.
    row = conn.execute(
        """
        SELECT 1 FROM news_history
        WHERE inserted_at >= ?
          AND (hash_url = ? OR hash_title = ?)
        LIMIT 1
        """,
        (cutoff, hash_url, hash_title),
    ).fetchone()
    if row:
        return True

    # Only check summary hash when we actually have one.
    if hash_summary:
        row = conn.execute(
            """
            SELECT 1 FROM news_history
            WHERE inserted_at >= ?
              AND hash_summary = ?
            LIMIT 1
            """,
            (cutoff, hash_summary),
        ).fetchone()
        if row:
            return True

    return False


def cleanup_old_rows(conn: sqlite3.Connection, days: int = DEDUP_WINDOW_DAYS) -> int:
    """Delete news_history rows older than *days* days. Returns rows removed.

    Called automatically at the start of every generator run (so the user
    never has to schedule a cron job) and also invocable via --cleanup for
    one-shot housekeeping. The schema retention spec is documented in the
    module docstring.
    """
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    cur = conn.execute("DELETE FROM news_history WHERE inserted_at < ?", (cutoff,))
    conn.commit()
    return cur.rowcount or 0


def record_article(conn: sqlite3.Connection, article: dict) -> None:
    """Insert one article into news_history after a successful newsletter render.

    Args:
        conn: Open SQLite connection (caller manages commit/rollback).
        article: Dict with at minimum 'title' and 'url' keys.  Optional keys:
                 source, summary, priority_score, section, published_at.
    """
    title = article.get("title", "").strip()
    url = article.get("url", "").strip()
    if not title or not url:
        return  # Skip malformed entries silently.

    summary = article.get("summary") or None
    conn.execute(
        """
        INSERT INTO news_history
            (hash_url, hash_title, hash_summary, title, url,
             source, summary, priority_score, section, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            _hash_url(url),
            _hash_title(title),
            _hash_summary(summary),
            title,
            url,
            article.get("source") or None,
            summary,
            article.get("priority_score") or None,
            article.get("section") or None,
            article.get("published_at") or None,
        ),
    )


# ── JSON article array extraction ─────────────────────────────────────────────

def extract_json_articles(output: str) -> list[dict]:
    """Parse the structured JSON article array the model emits before the HTML.

    The agent spec mandates that the model emits a JSON array of article objects
    before the <!DOCTYPE html> block.  We tolerate the array being inside a
    markdown fence or bare.  Returns an empty list on any parse failure so the
    caller can degrade gracefully.
    """
    # Try to find a JSON array that precedes <!DOCTYPE (case-insensitive).
    doctype_pos = output.lower().find("<!doctype")
    if doctype_pos < 0:
        doctype_pos = len(output)
    prefix = output[:doctype_pos]

    # Strip optional ```json fence.
    prefix = re.sub(r"^```(?:json)?\s*", "", prefix.strip(), flags=re.IGNORECASE)
    prefix = re.sub(r"```\s*$", "", prefix.strip())

    # Find a top-level [...] array. The previous greedy `(\[[\s\S]*\])`
    # spanned from the first `[` to the last `]` in the whole prefix,
    # which broke on markdown link lists or extra unrelated arrays
    # (gemini review v15.4.16). Walk from each `[` outward, tracking
    # bracket depth, and return the first balanced array that parses
    # as a list of dicts.
    starts = [i for i, c in enumerate(prefix) if c == "["]
    for start in starts:
        depth = 0
        for i in range(start, len(prefix)):
            c = prefix[i]
            if c == "[":
                depth += 1
            elif c == "]":
                depth -= 1
                if depth == 0:
                    candidate = prefix[start : i + 1]
                    try:
                        data = json.loads(candidate)
                        if isinstance(data, list) and all(isinstance(a, dict) for a in data):
                            return data
                    except json.JSONDecodeError:
                        pass
                    break  # try next outer `[`
    return []


# ── Nav bar ────────────────────────────────────────────────────────────────────

def build_nav_instruction(existing: dict[str, Path], current_label: str) -> str:
    """Return prompt text instructing Gemini to add an edition navigation bar."""
    # All labels: existing + current (if not yet saved)
    all_labels = sorted({*existing.keys(), current_label})
    if len(all_labels) < 2:
        return ""

    items: list[str] = []
    for label in all_labels:
        if label == current_label:
            items.append(
                f'  <span style="color:#ffd089;font-family:\'JetBrains Mono\',monospace;'
                f'font-size:0.8rem;padding:0.3rem 0.8rem;border-radius:4px;'
                f'background:#1a1500;border:1px solid #ffd089;">{label}</span>'
            )
        elif label in existing:
            items.append(
                f'  <a href="{existing[label].name}" style="color:#888;text-decoration:none;'
                f'font-family:\'JetBrains Mono\',monospace;font-size:0.8rem;'
                f'padding:0.3rem 0.8rem;border-radius:4px;border:1px solid #2a2a2a;">'
                f'{label}</a>'
            )

    nav_html = (
        '<nav style="display:flex;gap:0.75rem;justify-content:center;'
        'padding:0.6rem 2rem;background:#0f0f0f;border-bottom:1px solid #2a2a2a;'
        'flex-wrap:wrap;">\n'
        + "\n".join(items)
        + "\n</nav>"
    )
    return (
        "\n\nNAVEGACIÓN DE EDICIONES — Insertar este bloque HTML exactamente "
        "después del cierre </header> y ANTES del HERO:\n"
        f"{nav_html}\n"
    )


# ── Prompt building ────────────────────────────────────────────────────────────

def build_section_prompt(
    cfg: dict,
    days: int,
    theme: str | None,
    notes: str | None,
    dedup_urls: list[str],
    nav_instruction: str,
    dedup_titles: list[str] | None = None,
    db_dedup_hashes: tuple[list[str], list[str]] | None = None,
    topics: list[str] | None = None,
) -> str:
    """Build the full Gemini prompt for one newsletter section.

    Args:
        cfg: Section config dict.
        days: Coverage window in days.
        theme: Optional special theme override.
        notes: Optional free-form editor notes.
        dedup_urls: Canonicalized URLs from recent HTML files (legacy, no longer
                    surfaced verbatim — kept for the URL count signal only).
        nav_instruction: HTML nav bar injection block, or empty string.
        dedup_titles: Kept for API compat; no longer rendered into the prompt
                      (per user spec: "que en el prompt no incluya lo de
                      titulares ya publicados"). Novelty is now date+DB driven.
        db_dedup_hashes: Optional (url_hashes, title_hashes) already in DB — shown
                         to the model as an aggregate count signal only.
        topics: User-personalised priority topics (defaults to DEFAULT_TOPICS).
    """
    date_str = datetime.now().strftime("%-d de %B de %Y") if sys.platform != "win32" \
        else datetime.now().strftime("%d de %B de %Y").lstrip("0")
    today_iso = datetime.now().strftime("%Y-%m-%d")
    yesterday_iso = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    timeframe = f"últimas {days * 24}h / {days} días"
    min_news = cfg.get("min_news", DEDUP_MIN_NEWS)
    active_topics = topics or list(DEFAULT_TOPICS)

    prompt = f"""Eres el redactor del ULTRON Times — edición {cfg['label']}.
Genera un newsletter HTML5 con la profundidad de un periódico digital profesional.
Diseño: auténtico periódico digital premium — artículos con lead paragraph, contexto e impacto real.

SECCIÓN: {cfg['label'].upper()}
Tagline: "{cfg['tagline']}"
Ventana: {timeframe}

ESTRUCTURA OBLIGATORIA (mínimo {min_news} noticias REALES):

{cfg['focus_sections']}
DISEÑO (mismo en todas las ediciones — paleta ULTRON Times):
- Background #0a0a0a · cards #131313 · hero #1a1a1a
- Text #e8e8e8 · muted #888 · accent principal para esta edición: {cfg['accent']}
- Inter/Segoe UI body, JetBrains Mono code/meta
- Headlines font-weight 700, hero h1 2.5rem, cards h2 1.25rem
- Mobile-first responsive @media (max-width: 768px)
- Border #2a2a2a entre secciones

HEADER:
- Logo "⌬ ULTRON Times" en {cfg['accent']}
- Tagline "{cfg['tagline']}"
- Fecha: {date_str}

{cfg['priority_note']}

PRIORIDAD TEMÁTICA (personalización del usuario — sobrescribe defaults):
{chr(10).join(f"  · {t}" for t in active_topics)}
→ HERO y primera mitad del newsletter deben estar dominadas por estas temáticas.
→ Si algo es claramente de estas áreas, súbele 0.10 al priority_score.
→ Edit en ~/.ultron/cockpit/news-topics.json para reordenar / personalizar.

VENTANA DE NOVEDAD (estricta — solo noticias frescas):
  · TODAY     = {today_iso}
  · YESTERDAY = {yesterday_iso}
→ Solo incluye items con published_at ∈ {{TODAY, YESTERDAY}}.
→ Si una noticia tiene >2 días, OMÍTELA salvo que sea un breakthrough sin
   cobertura previa (en ese caso, márcala explícitamente en el summary).
→ Si no encuentras {min_news} items frescos, ENVÍA MENOS — nunca rellenes
   con noticias viejas (mejor 12 frescas que 25 recicladas).

FUENTES (busca activamente en internet):
{cfg['sources']}

PRIORITY SCORING (ultron-news rubric — assign priority_score 0-1 to each article):
- 0.95+ : GitHub AI / Claude Code / new LLM model release / agentic framework launch
- 0.80-0.94 : significant dev tooling (IDE plugins, CLI tools, MCP servers, eval frameworks)
- 0.50-0.79 : research papers with code, infra news (Vercel, Cloudflare, Supabase product launches)
- 0.20-0.49 : industry chatter (funding rounds, hires, partnerships)
- < 0.20 : drop — do not include

EDITORIAL DISCIPLINE (ultron-news rules — mandatory):
- No marketing-speak. Verbs over adjectives. "Anthropic ships X" beats "Anthropic announces innovative X".
- No filler. If you cannot find 8 articles above 0.5, ship fewer — never pad with low-priority items.
- One sentence summary max — the newsletter is scannable; readers click for depth.
- Always link the primary source. Blog post > tweet > secondary coverage.
- Section headers in CAPS with em-dash separator: e.g. "AI RESEARCH — {date_str}".
- Date stamps on every article (ISO format in data, human format in render).

EVITA:
- "Alguien dijo en Twitter" sin fuente verificable
- Marketing copy sin substancia ("revolutionary", "game-changing", "innovative")
- Noticias >7 días presentadas como "today"
- Fillers — sé concreto o omite
- Hallucinations: 10 noticias reales > 15 inventadas

CALIDAD:
- Cada artículo cita SOURCE + LINK real (URL completa) — always the primary source
- Los leads son SUBSTANTIVOS: contexto + qué pasó + impacto
- Cero placeholders
- Total mínimo: {min_news} items con sustancia (only those above priority_score 0.20)
"""

    # Navigation bar
    if nav_instruction:
        prompt += nav_instruction

    # NO "titulares ya publicados" block (v15.5.18 — user feedback):
    # listing 60 past headlines inside the prompt was both noisy and useless,
    # because the section is static and we want each newsletter to contain
    # genuinely new items rather than items the model is told to avoid by
    # title. Novelty is enforced two other ways:
    #   1. The TODAY/YESTERDAY block above (the model is told to skip
    #      anything older than 2 days unless explicitly novel).
    #   2. The DB-level filter after generation drops any article whose
    #      hash already appears in news_history within DEDUP_WINDOW_DAYS.
    # We still tell the model that a persistent history exists so it knows
    # the pipeline will drop duplicates that slip through — just as a count
    # signal, no headlines or URLs are leaked back into the prompt.
    if db_dedup_hashes:
        url_hashes, title_hashes = db_dedup_hashes
        if url_hashes or title_hashes:
            prompt += (
                f"\n\nHISTORIAL DE COBERTURA — El pipeline mantiene un historial "
                f"persistente con {len(url_hashes)} URLs y {len(title_hashes)} "
                f"titulares cubiertos en los últimos {DEDUP_WINDOW_DAYS} días. "
                "Cualquier artículo que coincida por hash se descartará "
                "automáticamente tras la generación — prioriza novedad real "
                "para evitar que el HTML se vacíe.\n"
            )

    # Theme override
    if theme:
        prompt += (
            f"\n\nTEMA ESPECIAL: \"{theme}\"\n"
            f"→ HERO: noticia más importante sobre este tema\n"
            f"→ Añadir sección \"{theme}\" antes de THE BRIEF\n"
            f"→ Resto de secciones: condensar si solapan con el tema\n"
        )

    # User notes
    if notes:
        prompt += f"\n\nNOTAS ADICIONALES DEL EDITOR:\n{notes}\n"

    prompt += (
        "\n\n[OUTPUT INSTRUCTION — CRITICAL]\n"
        "Tu respuesta debe tener DOS partes en orden:\n\n"
        "PARTE 1 — JSON array de artículos (ANTES del HTML):\n"
        "Emite un array JSON con cada artículo que incluyas en el newsletter.\n"
        "Formato exacto (una sola línea de JSON por artículo, array completo):\n"
        '[{"title":"...","url":"...","source":"...","summary":"...","priority_score":0.92,'
        '"section":"DEV TOOLING & AGENTS","published_at":"YYYY-MM-DD"}, ...]\n\n'
        "PARTE 2 — HTML5 completo:\n"
        "Imprime SOLO el HTML5 completo, desde <!DOCTYPE html> hasta </html>.\n"
        "NADA de markdown fences (no ```html). NADA de explicación previa.\n"
        "NADA después del </html>. Solo HTML directo, ready-to-render.\n"
    )
    return prompt


# ── Validation ────────────────────────────────────────────────────────────────

def validate_html(html: str) -> tuple[bool, str]:
    low = html.lower().strip()
    if not (low.startswith("<!doctype") or low.startswith("<html")):
        return False, "no empieza con <!DOCTYPE o <html>"
    if "</html>" not in low:
        return False, "falta </html> de cierre"
    if not any(tag in low for tag in ("<article", "<section", "<main")):
        return False, "no contiene <article>, <section>, ni <main>"
    size = len(html.encode("utf-8"))
    if size < 5_000:
        return False, f"HTML demasiado pequeño ({size}b, esperado >5KB)"
    if size > 1_000_000:
        return False, f"HTML demasiado grande ({size}b, esperado <1MB)"
    return True, "ok"


# ── Audit flags ───────────────────────────────────────────────────────────────

def extract_audit_flags(html: str) -> dict[str, list[str]]:
    m = re.search(r"<!--\s*AUDIT_FLAGS:\s*\n?(.+?)\n?\s*-->", html, re.DOTALL)
    if not m:
        return {}
    flags: dict[str, list[str]] = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        skill, topics_str = line.split(":", 1)
        skill = skill.strip()
        topics = [t.strip() for t in topics_str.split(",") if t.strip()]
        if skill and topics:
            flags[skill] = topics
    return flags


def write_audit_flags_file(flags: dict[str, list[str]]) -> Path | None:
    if not flags:
        return None
    NEWS_DIR.mkdir(parents=True, exist_ok=True)
    date = datetime.now().strftime("%Y-%m-%d")
    flag_file = NEWS_DIR / f"audit-flags-{date}.md"
    lines = [
        f"# News Audit Flags — {date}", "",
        "_Generado por ULTRON Times news_html_generator.py._", "",
        "Skills que requieren revisión:", "",
    ]
    for skill, topics in sorted(flags.items()):
        lines.append(f"## `{skill}`")
        for t in topics:
            lines.append(f"- {t}")
        lines.append("")
    lines += ["---", "", "**Para repo-evaluator** — ejecutar audit:", "```bash"]
    for skill in sorted(flags.keys()):
        lines.append(f"ultron self-improve audit {skill} --quick")
    lines += ["```"]
    flag_file.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    return flag_file


# ── Gemini / clipboard ────────────────────────────────────────────────────────

def _strip_code_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```\w*\s*\n", "", text, count=1).strip()
        if text.endswith("```"):
            text = text[:-3].strip()
    return text


def copy_to_clipboard(text: str) -> bool:
    """Copy `text` to the Windows clipboard preserving UTF-8.

    Bug we're fixing: piping a UTF-8 string into PowerShell stdin via
    subprocess produces mojibake (ÔÇö, ├¡, ├▒, etc.) because PowerShell
    interprets stdin in the legacy OEM codepage by default, not UTF-8.
    Fix: drop the text into a temp file with a UTF-8 BOM and use
    Get-Content -Encoding UTF8 | Set-Clipboard, which reads explicitly
    as UTF-8.
    """
    import tempfile
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8-sig", suffix=".txt",
            delete=False, newline="",
        ) as tf:
            tf.write(text)
            tmp = tf.name
        # -LiteralPath avoids glob expansion on paths with [ ] etc.
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"Get-Content -Raw -Encoding UTF8 -LiteralPath '{tmp}' | Set-Clipboard"],
            capture_output=True, timeout=10,
            creationflags=_WIN_HIDDEN,
        )
        return True
    except Exception:
        return False
    finally:
        if tmp:
            try:
                import os
                os.unlink(tmp)
            except OSError:
                pass


def call_gemini(prompt: str, out_path: Path, model: str) -> tuple[bool, str, str]:
    """Call Gemini CLI and write the HTML portion to *out_path*.

    Returns:
        (success, reason, raw_stdout) — raw_stdout is the full model output
        (JSON + HTML) so the caller can parse the article array.
    """
    gemini_bin = shutil.which("gemini")
    if not gemini_bin:
        return False, "gemini CLI no encontrado en PATH", ""

    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = subprocess.run(
            [gemini_bin, "--approval-mode", "plan", "-m", model, "-p", prompt],
            capture_output=True, text=True, encoding="utf-8",
            timeout=GEMINI_TIMEOUT_SEC,
            creationflags=_WIN_HIDDEN,
        )
    except subprocess.TimeoutExpired:
        return False, f"timeout ({GEMINI_TIMEOUT_SEC}s)", ""
    except Exception as e:
        return False, f"exec error: {e}", ""

    if r.returncode != 0:
        err = r.stderr or ""
        if "429" in err or "RESOURCE_EXHAUSTED" in err:
            return False, "Gemini 429 capacity exhausted. Retry in ~1min or use --clipboard.", ""
        return False, f"gemini exit {r.returncode}: {err[:300]}", ""

    raw_stdout = r.stdout or ""
    html = _strip_code_fences(raw_stdout)

    # Isolate the HTML portion (from <!DOCTYPE to </html>).
    doctype_pos = html.lower().find("<!doctype")
    if doctype_pos > 0:
        html = html[doctype_pos:]
    end_idx = html.lower().rfind("</html>")
    if end_idx > 0:
        html = html[:end_idx + len("</html>")]

    if len(html) < 1000 or "</html>" not in html.lower():
        return False, f"stdout sin HTML válido ({len(html)} chars). Usa --clipboard para modo manual.", raw_stdout

    try:
        out_path.write_text(html, encoding="utf-8", newline="\n")
    except OSError as e:
        return False, f"write failed: {e}", raw_stdout
    return True, "stdout-capture", raw_stdout


# ── SQLite post-render: filter candidates + record published articles ──────────

def _is_stale_published_at(value: str | None,
                            max_age_days: int = NOVELTY_MAX_AGE_DAYS) -> bool:
    """Return True if *value* is a parseable ISO date older than *max_age_days*.

    Unparseable / missing values return False — we never drop an item just
    because the model omitted the date (the DB hash filter is the safety net
    in that case). Accepts plain YYYY-MM-DD as well as full ISO 8601 stamps.
    """
    if not value:
        return False
    try:
        # Take only the date portion to be tolerant of "+00:00" / "Z" suffixes.
        date_part = str(value).strip()[:10]
        dt = datetime.strptime(date_part, "%Y-%m-%d")
    except (ValueError, TypeError):
        return False
    age = datetime.now() - dt
    return age > timedelta(days=max_age_days)


def filter_candidates_with_db(
    conn: sqlite3.Connection,
    articles: list[dict],
    days: int = DEDUP_WINDOW_DAYS,
) -> tuple[list[dict], int]:
    """Remove articles already seen in news_history within *days* days.

    Also enforces the date-novelty rule: any article whose `published_at`
    parses as older than NOVELTY_MAX_AGE_DAYS (default 2) is dropped UNLESS
    its hash is genuinely new to the DB — that's the "no se ha cubierto"
    exception from the user spec. Items without a `published_at` field are
    treated as unknown-date and not dropped on novelty alone.

    Args:
        conn: Open DB connection.
        articles: Candidate article dicts from the model's JSON array.
        days: Dedup window in days.

    Returns:
        (fresh_articles, dropped_count)
    """
    fresh: list[dict] = []
    dropped = 0
    for art in articles:
        title = art.get("title", "").strip()
        url = art.get("url", "").strip()
        if not title or not url:
            fresh.append(art)  # Malformed entries pass through — not our business.
            continue
        h_url = _hash_url(url)
        h_title = _hash_title(title)
        h_summary = _hash_summary(art.get("summary"))
        already_seen = seen_recently(conn, h_url, h_title, h_summary, days=days)
        stale_date = _is_stale_published_at(art.get("published_at"))
        # User spec: "se han cubierto, una noticia sí se ha cubierto, se
        # guarda en el archivo". So:
        #  - already_seen (in DB)         → drop (dup)
        #  - stale + not already_seen     → drop (old AND already covered
        #                                          OR old-but-untracked
        #                                          either way: not "today/yesterday")
        # Result: we drop on either condition.
        if already_seen or stale_date:
            dropped += 1
        else:
            fresh.append(art)
    return fresh, dropped


def record_articles(conn: sqlite3.Connection, articles: list[dict]) -> int:
    """Bulk-insert *articles* into news_history after a successful render.

    Args:
        conn: Open DB connection.
        articles: Article dicts that made it into the final newsletter.

    Returns:
        Number of rows actually inserted.
    """
    inserted = 0
    for art in articles:
        try:
            record_article(conn, art)
            inserted += 1
        except sqlite3.Error:
            pass  # Non-fatal — a duplicate insert just means the hash was already there.
    conn.commit()
    return inserted


def _load_db_dedup_hashes(
    conn: sqlite3.Connection, days: int = 30
) -> tuple[list[str], list[str]]:
    """Return (url_hashes, title_hashes) already in DB for the last *days* days.

    Used to pass a count signal into the prompt so the model is aware that the
    pipeline will enforce DB-level dedup on its output.
    """
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    rows = conn.execute(
        "SELECT hash_url, hash_title FROM news_history WHERE inserted_at >= ?",
        (cutoff,),
    ).fetchall()
    url_hashes = [r["hash_url"] for r in rows]
    title_hashes = [r["hash_title"] for r in rows]
    return url_hashes, title_hashes


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    sections = load_sections()
    section_names = list(sections.keys())

    p = argparse.ArgumentParser(
        prog="news_html_generator",
        description="ULTRON Times — Multi-section newsletter generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  ultron news                                 # tech, 3 días\n"
            "  ultron news --days 7                        # semana completa\n"
            "  ultron news --theme 'AI security week'      # sección especial\n"
            "  ultron news --clipboard                     # modo manual\n"
        ),
    )
    p.add_argument("--section", default="tech", choices=section_names,
                   help=f"Sección a generar (default: tech). Opciones: {', '.join(section_names)}")
    p.add_argument("--days", type=int, default=3,
                   help="Ventana de cobertura en días (default 3)")
    p.add_argument("--theme", default=None,
                   help="Tema especial — Hero y sección extra se centran aquí")
    p.add_argument("--notes", default=None,
                   help="Notas libres del editor")
    p.add_argument("--model", default=DEFAULT_MODEL,
                   help=f"Gemini model (default {DEFAULT_MODEL})")
    p.add_argument("--clipboard", action="store_true",
                   help="Copiar el prompt al portapapeles en lugar de llamar a Gemini")
    p.add_argument("--no-open", action="store_true",
                   help="No abrir en navegador tras generar")
    p.add_argument("--no-dedup", action="store_true",
                   help="Desactivar deduplicación de artículos anteriores")
    p.add_argument("--cleanup", action="store_true",
                   help=(f"Borrar filas de news_history.db más antiguas que "
                         f"{DEDUP_WINDOW_DAYS} días y salir."))
    args = p.parse_args()

    # Cleanup-only mode: housekeeping shortcut. Useful from a Stop hook or
    # from cron; the same cleanup also runs implicitly at the top of every
    # full generation below.
    if args.cleanup:
        with open_db() as conn:
            removed = cleanup_old_rows(conn, days=DEDUP_WINDOW_DAYS)
        print(f"[cleanup] news_history.db → {removed} filas eliminadas "
              f"(>{DEDUP_WINDOW_DAYS} días)")
        return 0

    cfg = sections[args.section]
    date_str = datetime.now().strftime("%Y-%m-%d")

    print("=" * 80)
    print(f"ULTRON Times — {cfg['label']} (v15.5.18)")
    print("=" * 80)

    # Load user-personalised topics (or defaults).
    active_topics, from_file = load_topics()
    if from_file:
        print(f"[topics] {len(active_topics)} from news-topics.json: "
              f"{', '.join(active_topics)}")
    else:
        print(f"[topics] defaults: {', '.join(active_topics)} "
              f"(edit {NEWS_TOPICS_FILE} to personalise)")

    # Check which other editions exist today (for nav bar)
    existing = today_existing_editions(sections, date_str)
    nav_instruction = build_nav_instruction(existing, cfg["label"])
    if nav_instruction:
        print(f"[nav] Ediciones hoy: {', '.join(existing.keys())} → añadiendo nav bar")

    # ── File-based dedup (legacy, feeds the prompt) ───────────────────────────
    dedup_urls: list[str] = []
    dedup_titles: list[str] = []
    if not args.no_dedup:
        dedup_urls, dedup_titles, dedup_files = load_recent_dedup_corpus(cfg, days=DEDUP_DAYS)
        if dedup_urls or dedup_titles:
            print(f"[dedup-files] lookback {DEDUP_DAYS}d · {dedup_files} newsletters → "
                  f"{len(dedup_urls)} URLs + {len(dedup_titles)} titulares se excluyen")

    # ── SQLite-based dedup (persistent, feeds both prompt + post-filter) ───────
    # Implicit weekly housekeeping: every run wipes rows older than
    # DEDUP_WINDOW_DAYS (=7) BEFORE we count hashes for the prompt and
    # before we filter the candidates. This guarantees the DB never grows
    # unbounded even without an external cron job. The user can also run
    # `news_html_generator.py --cleanup` for a manual sweep.
    db_dedup_hashes: tuple[list[str], list[str]] | None = None
    if not args.no_dedup:
        with open_db() as conn:
            removed = cleanup_old_rows(conn, days=DEDUP_WINDOW_DAYS)
            if removed:
                print(f"[dedup-db]    housekeeping → {removed} filas "
                      f"eliminadas (>{DEDUP_WINDOW_DAYS}d)")
            db_dedup_hashes = _load_db_dedup_hashes(conn, days=DEDUP_WINDOW_DAYS)
        url_h_count, title_h_count = db_dedup_hashes
        print(f"[dedup-db]    history DB → {len(url_h_count)} URL hashes + "
              f"{len(title_h_count)} title hashes ({DEDUP_WINDOW_DAYS}d window)")

    prompt = build_section_prompt(
        cfg, args.days, args.theme, args.notes, dedup_urls, nav_instruction,
        dedup_titles=dedup_titles,
        db_dedup_hashes=db_dedup_hashes,
        topics=active_topics,
    )
    print(f"[prompt] sección={args.section} días={args.days}" +
          (f" · tema='{args.theme}'" if args.theme else "") +
          (f" · notas={len(args.notes)} chars" if args.notes else "") +
          (f" · dedup_urls={len(dedup_urls)}" if dedup_urls else "") +
          (f" · dedup_titles={len(dedup_titles)}" if dedup_titles else ""))

    # ── Clipboard mode ────────────────────────────────────────────────────────
    if args.clipboard:
        out_path = NEWS_DIR / section_output_path(cfg, date_str).name
        # Inject the explicit save instruction so Gemini writes the HTML
        # to the right path. Without this, Gemini guesses cwd root and
        # the newsletter ends up in C:\Users\<user>\ instead of
        # ~/.ultron/cockpit/news/.
        save_instruction = (
            "\n\n[SAVE INSTRUCTION — CRITICAL]\n"
            f"Save the final HTML to this exact ABSOLUTE path:\n"
            f"  {out_path}\n"
            "Use your file-write tool (e.g. write_file). Do NOT save to the\n"
            "current working directory root. The directory already exists.\n"
            "After saving, confirm with a single line: 'Saved to <path>'.\n"
        )
        full_prompt = prompt + save_instruction
        ok = copy_to_clipboard(full_prompt)
        if ok:
            print("[clipboard] Prompt copiado al portapapeles.")
            print(f"[clipboard] Gemini guardará el resultado en: {out_path}")
            print("[clipboard] Dedup DB recording requires --no-clipboard (headless) mode.")
        else:
            print("[clipboard] No pude copiar. Imprimiendo prompt:\n")
            print(full_prompt)
        return 0

    # ── Gemini headless mode ──────────────────────────────────────────────────
    NEWS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = section_output_path(cfg, date_str)

    print(f"[gemini] Generando con {args.model} (timeout {GEMINI_TIMEOUT_SEC}s)...")
    print(f"[gemini] Output → {out_path}")
    ok, reason, raw_stdout = call_gemini(prompt, out_path, args.model)

    if not ok:
        print(f"[error] {reason}")
        print("[tip] Prueba: --clipboard para modo manual, o --model gemini-2.5-flash")
        return 1

    html = out_path.read_text(encoding="utf-8")
    valid, vreason = validate_html(html)
    if not valid:
        print(f"[warn] HTML inválido: {vreason} (archivo guardado para inspección)")
        return 1

    print(f"[ok] HTML válido — {len(html):,} chars  ({reason})")

    # ── Parse model's JSON article array ──────────────────────────────────────
    articles_from_model = extract_json_articles(raw_stdout)
    if articles_from_model:
        print(f"[articles] Modelo emitió {len(articles_from_model)} artículos en JSON")
    else:
        # Fallback: build minimal article dicts from URLs/titles extracted from HTML
        # so we can still record something to the DB even when the model skips the JSON.
        fallback_urls = extract_article_urls(html)
        fallback_titles = extract_article_titles(html)
        articles_from_model = [
            {"title": t, "url": u}
            for t, u in zip(fallback_titles, fallback_urls)
        ]
        if articles_from_model:
            print(f"[articles] Fallback: {len(articles_from_model)} artículos extraídos del HTML")

    # ── SQLite: filter duplicates + record published articles ─────────────────
    # NOTE: the rendered HTML at out_path has ALREADY been written above. The
    # primary dedup defence is the prompt-side hash list passed to the LLM,
    # which usually keeps duplicates out of the HTML entirely. This DB pass
    # is a post-hoc audit: only fresh articles are inserted, and a warning
    # is printed if duplicates slipped past the prompt — re-run the
    # generator to get a clean HTML when that happens.
    if not args.no_dedup and articles_from_model:
        with open_db() as conn:
            fresh_articles, dropped_count = filter_candidates_with_db(
                conn, articles_from_model, days=DEDUP_WINDOW_DAYS
            )
            print(f"[dedup-db]    {dropped_count} artículos descartados como duplicados "
                  f"({len(fresh_articles)} frescos registrados en DB)")
            inserted = record_articles(conn, fresh_articles)
            print(f"[dedup-db]    {inserted} artículos insertados en news_history.db")
            if dropped_count > 0:
                print(f"[warn-dedup]  {dropped_count} duplicados llegaron al HTML — "
                      "el modelo ignoró el prompt-side hash list. "
                      "Considera re-correr el generador para un HTML limpio.")
    elif args.no_dedup and articles_from_model:
        print("[dedup-db]    Saltando DB (--no-dedup activo)")

    # ── Audit flags ───────────────────────────────────────────────────────────
    flags = extract_audit_flags(html)
    if flags:
        flag_file = write_audit_flags_file(flags)
        print(f"[audit] {len(flags)} skill(s) flagged → {flag_file}")
        for skill, topics in flags.items():
            print(f"        {skill}: {', '.join(topics)}")
    else:
        print("[audit] Sin flags de skill hoy")

    if not args.no_open:
        try:
            webbrowser.open(out_path.as_uri())
            print(f"[browser] Abierto: {out_path}")
        except Exception:
            print(f"[browser] Abre manualmente: {out_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
