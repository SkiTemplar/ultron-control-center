#!/usr/bin/env python3
"""
ULTRON v11.0 Cockpit - GitHub Trending Scraper.

Scrapes GitHub Trending (daily/weekly) via the unofficial trending API
and GitHub search, no auth required. Focuses on AI/ML/LLM repos plus
USER's tech stack (C#, Python, TypeScript, Unreal Engine).

Output:
  - ~/.ultron/cockpit/trending/YYYY-MM-DD.md  (today's digest)
  - ~/.ultron/cockpit/trending/starred.json   (repos USER starred mentally)
  - ~/.ultron/cockpit/trending/seen.json      (dedup by full_name)

Runs daily on laptop wake (via register_wake_triggers.ps1).
NO external deps — uses urllib only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import Cockpit  # noqa: E402
from should_run import should_run_today, mark_ran_today  # noqa: E402

USER_AGENT = "ULTRON-Cockpit/11.0 (github trending, personal use)"
HTTP_TIMEOUT = 15

# ── Output paths ─────────────────────────────────────────────────────────────
COCKPIT_DIR = Path.home() / ".ultron" / "cockpit"
TRENDING_DIR = COCKPIT_DIR / "trending"
TRENDING_SEEN = TRENDING_DIR / "seen.json"
TRENDING_STARRED = TRENDING_DIR / "starred.json"

# ── GitHub Search API (no auth, 30 req/h unauthenticated) ───────────────────
# Simulates "trending" by searching repos created in last 7 days, sorted by stars.
# Queries are targeted by topic to stay within rate limit (3 searches per run).
GH_API_BASE = "https://api.github.com"

# Search queries — each targets a domain, returns max 30 repos, sorted by stars.
# We run these 3 queries per session (~3 of 30 free requests).
GH_SEARCH_QUERIES = [
    # AI/ML/LLM repos created in last 7 days
    "q=created:>{week_ago}+stars:>20+topic:llm+OR+topic:ai+OR+topic:machine-learning&sort=stars&order=desc&per_page=25",
    # USER's stack: C#, Python, TypeScript, game dev
    "q=created:>{week_ago}+stars:>30+(language:python+OR+language:csharp+OR+language:typescript+OR+language:c%2B%2B)&sort=stars&order=desc&per_page=25",
    # Claude/AI tools - high signal
    "q=created:>{week_ago}+stars:>10+claude+OR+anthropic+OR+codex+OR+gemini-cli&sort=stars&order=desc&per_page=15",
]

# USER's tech stack — boost score for these languages
USER_LANGS = {"python", "c#", "typescript", "c++", "javascript", "lua", "gdscript"}

# AI/ML keyword filter — only keep repos matching at least one
AI_WHITELIST_RE = re.compile(
    r"\b(LLM|GPT|Claude|Gemini|Anthropic|OpenAI|AI|ML|deep.?learn|neural|diffus|"
    r"transformer|RAG|agent|MCP|model|inference|llama|mistral|embedding|vector|"
    r"langchain|llamaindex|copilot|cursor|codex|whisper|stable.diffusion|"
    r"unreal|game.?dev|engine|shader|render|physics|procedural|"
    r"C#|\.NET|ASP\.NET|Unity|Godot|Rider|"
    r"FastAPI|Django|Flask|pydantic|pytest|ruff|uv|"
    r"TypeScript|Next\.?js|React|Vite|Tailwind|Svelte)\b",
    re.IGNORECASE,
)

# Hard blacklist — skip forks of massive repos, tutorial aggregators
BLACKLIST_RE = re.compile(
    r"\b(awesome-list|cheat.?sheet|interview.?prep|leetcode|resume.?template|"
    r"roadmap|100.?days|learn.*from.?zero|beginners.?guide)\b",
    re.IGNORECASE,
)

MAX_ITEMS = 20


# ── HTTP ──────────────────────────────────────────────────────────────────────

def http_get(url: str, headers: dict | None = None, _retries: int = 3) -> bytes | None:
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    for attempt in range(_retries):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 10 * (2 ** attempt)  # 10s → 20s → 40s
                print(f"[trending] 429 rate-limited, retrying in {wait}s ({attempt+1}/{_retries})", file=sys.stderr)
                time.sleep(wait)
                continue
            print(f"[trending] WARN: GET {url} failed: {e}", file=sys.stderr)
            return None
        except Exception as e:
            print(f"[trending] WARN: GET {url} failed: {e}", file=sys.stderr)
            return None
    print(f"[trending] WARN: gave up after {_retries} retries (persistent 429)", file=sys.stderr)
    return None


# ── GitHub Search API ─────────────────────────────────────────────────────────

def fetch_trending(since: str = "daily") -> list[dict]:
    """Fetch trending repos via GitHub Search API (no auth, 30 req/h unauthenticated).
    since: 'daily' (7d lookback), 'weekly' (14d), 'monthly' (30d)."""
    days = {"daily": 7, "weekly": 14, "monthly": 30}.get(since, 7)
    from datetime import timedelta
    week_ago = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")

    all_items: list[dict] = []
    seen_names: set[str] = set()

    for query_tmpl in GH_SEARCH_QUERIES:
        query = query_tmpl.replace("{week_ago}", week_ago)
        url = f"{GH_API_BASE}/search/repositories?{query}"
        data = http_get(url, headers={"Accept": "application/vnd.github.v3+json"})
        if not data:
            continue
        try:
            payload = json.loads(data.decode("utf-8", errors="replace"))
            repos = payload.get("items", [])
        except json.JSONDecodeError:
            continue

        for r in repos:
            name = r.get("full_name", "")
            if not name or name in seen_names:
                continue
            seen_names.add(name)
            all_items.append({
                "full_name": name,
                "description": (r.get("description") or "")[:300],
                "url": r.get("html_url") or f"https://github.com/{name}",
                "language": (r.get("language") or "").lower(),
                "stars": r.get("stargazers_count", 0),
                "added_stars": r.get("stargazers_count", 0),  # not available without auth
                "since": since,
                "source": "gh-search",
                "topics": r.get("topics", []),
            })

    return all_items


# ── Dedup ────────────────────────────────────────────────────────────────────

def load_seen() -> set[str]:
    if not TRENDING_SEEN.exists():
        return set()
    try:
        return set(json.loads(TRENDING_SEEN.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, OSError):
        return set()


def save_seen(seen: set[str]) -> None:
    TRENDING_DIR.mkdir(parents=True, exist_ok=True)
    # Keep last 500 entries (rolling window)
    lst = list(seen)[-500:]
    TRENDING_SEEN.write_text(json.dumps(lst, indent=2), encoding="utf-8")


# ── Scoring ──────────────────────────────────────────────────────────────────

def score(repo: dict) -> int:
    """Higher = more interesting for USER."""
    s = 0
    text = f"{repo['full_name']} {repo['description']}"

    if BLACKLIST_RE.search(text):
        return -99

    if AI_WHITELIST_RE.search(text):
        s += 10

    lang = repo.get("language", "")
    if lang in USER_LANGS:
        s += 5

    added = repo.get("added_stars", 0)
    if added >= 500:
        s += 5
    elif added >= 200:
        s += 3
    elif added >= 50:
        s += 1

    return s


# ── Digest writer ─────────────────────────────────────────────────────────────

def write_digest(items: list[dict], today: str) -> Path:
    TRENDING_DIR.mkdir(parents=True, exist_ok=True)
    out = TRENDING_DIR / f"{today}.md"

    lines = [
        f"# GitHub Trending — {today}",
        f"_Generated by ULTRON v11 · {len(items)} repos_",
        "",
    ]

    by_lang: dict[str, list[dict]] = {}
    other: list[dict] = []
    for r in items:
        lang = r.get("language", "").capitalize() or "Unknown"
        if r.get("language", "") in USER_LANGS:
            by_lang.setdefault(lang, []).append(r)
        else:
            other.append(r)

    for lang in sorted(by_lang):
        lines.append(f"## {lang}")
        for r in by_lang[lang]:
            _repo_line(lines, r)
        lines.append("")

    if other:
        lines.append("## Other")
        for r in other:
            _repo_line(lines, r)
        lines.append("")

    out.write_text("\n".join(lines), encoding="utf-8")
    return out


def _repo_line(lines: list[str], r: dict) -> None:
    added = r.get("added_stars", 0)
    added_str = f" +{added}★" if added else ""
    desc = r.get("description", "")
    desc_str = f" — {desc}" if desc else ""
    lines.append(f"- [{r['full_name']}]({r['url']}){added_str}{desc_str}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="GitHub Trending scraper for ULTRON cockpit")
    ap.add_argument("--from-cron", action="store_true",
                    help="Enforce daily-once marker guard (skip if already ran today)")
    ap.add_argument("--force", action="store_true",
                    help="Ignore daily marker and run anyway")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print output path but don't write files")
    ap.add_argument("--since", default="daily", choices=["daily", "weekly", "monthly"],
                    help="Trending period (default: daily)")
    ap.add_argument("--no-filter", action="store_true",
                    help="Skip AI/ML whitelist filter, show all trending")
    args = ap.parse_args(argv)

    if args.from_cron and not args.force:
        if not should_run_today("github_trending"):
            print("[trending] Already ran today, skipping. Use --force to override.")
            return 0

    today = datetime.now().strftime("%Y-%m-%d")
    print(f"[trending] Fetching GitHub trending ({args.since})…")

    # Fetch via GitHub Search API (3 targeted queries, no auth needed)
    all_items = fetch_trending(since=args.since)
    print(f"[trending] Fetched {len(all_items)} unique repos from GitHub Search API")

    # Dedup by full_name (fetch_trending already deduped internally)
    seen_names: dict[str, dict] = {}
    for r in all_items:
        fn = r["full_name"]
        if fn not in seen_names:
            seen_names[fn] = r

    # Historical dedup (skip repos shown before)
    seen = load_seen()
    new_items = [r for r in seen_names.values() if r["full_name"] not in seen]
    print(f"[trending] {len(seen_names)} repos fetched, {len(new_items)} new (not seen before)")

    # Filter + score
    scored = []
    for r in new_items:
        if not args.no_filter and score(r) < 0:
            continue
        r["_score"] = score(r)
        scored.append(r)

    if not args.no_filter:
        # Keep only AI/ML relevant or USER's langs
        scored = [r for r in scored if r["_score"] > 0]

    scored.sort(key=lambda r: (r["_score"], r.get("added_stars", 0)), reverse=True)
    final = scored[:MAX_ITEMS]

    print(f"[trending] {len(final)} repos after filter (cap={MAX_ITEMS})")

    if not final:
        print("[trending] Nothing new to report today.")
        if args.from_cron and not args.force:
            mark_ran_today("github_trending")
        return 0

    if args.dry_run:
        for r in final:
            print(f"  [{r['_score']:+d}] {r['full_name']} +{r.get('added_stars',0)}★  {r['description'][:80]}")
        return 0

    out_path = write_digest(final, today)
    print(f"[trending] Digest written: {out_path}")

    # Update seen set
    seen.update(r["full_name"] for r in final)
    save_seen(seen)

    if args.from_cron and not args.force:
        mark_ran_today("github_trending")

    return 0


if __name__ == "__main__":
    sys.exit(main())
