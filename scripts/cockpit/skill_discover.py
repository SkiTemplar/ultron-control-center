#!/usr/bin/env python3
"""
ULTRON Cockpit - GitHub Skill Discovery.

Search GitHub for community SKILL.md files and cache them locally for review.
Uses GitHub Search API (unauthenticated = 60 req/hour, authenticated = 5000/hour).

Usage:
    skill_discover.py search <query>     Search GitHub for skills matching query
    skill_discover.py fetch <url>        Fetch and cache a skill from GitHub raw URL
    skill_discover.py list               List cached skills pending review
    skill_discover.py preview <name>     Preview a cached skill
    skill_discover.py install <name>     Install cached skill to ~/.claude/skills/
    skill_discover.py clean              Remove old cached skills (>7 days)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SKILLS_DIR = Path.home() / ".claude" / "skills"
CACHE_DIR = Path.home() / ".ultron" / "skill_cache"
GITHUB_API_BASE = "https://api.github.com"
USER_AGENT = "ULTRON-SkillDiscover/1.0"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_github_token() -> str:
    """Get GitHub token from environment or settings.json."""
    # Try environment first
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        return token

    # Try settings.json
    settings_path = Path.home() / ".claude" / "settings.json"
    if settings_path.exists():
        try:
            import json as _json
            settings = _json.loads(settings_path.read_text(encoding="utf-8"))
            # Look in mcpServers for GITHUB_TOKEN
            for server_config in settings.get("mcpServers", {}).values():
                if isinstance(server_config, dict):
                    env = server_config.get("env", {})
                    if isinstance(env, dict) and "GITHUB_TOKEN" in env:
                        token = env.get("GITHUB_TOKEN", "").strip()
                        if token:
                            os.environ["GITHUB_TOKEN"] = token  # Cache in environment
                            return token
        except Exception:
            pass

    return ""


def _headers() -> dict:
    h = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": USER_AGENT,
    }
    token = _get_github_token()
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _get(url: str) -> dict | list:
    """HTTP GET with error handling. Returns parsed JSON."""
    req = urllib.request.Request(url, headers=_headers())
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print("[auth] GitHub Code Search requires authentication.")
            print("       Set GITHUB_TOKEN env var and restart:")
            print("       $env:GITHUB_TOKEN = 'ghp_...'")
            sys.exit(1)
        if e.code in (403, 429):
            print("[rate-limit] Rate limited — set GITHUB_TOKEN env var for higher limits")
            sys.exit(1)
        raise RuntimeError(f"HTTP {e.code}: {e.reason} — {url}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error: {e.reason}") from e


def _get_raw(url: str) -> str:
    """Download raw text content from a URL."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print("[auth] GitHub requires authentication for this request.")
            print("       Set GITHUB_TOKEN env var: $env:GITHUB_TOKEN = 'ghp_...'")
            sys.exit(1)
        if e.code in (403, 429):
            print("[rate-limit] Rate limited — set GITHUB_TOKEN env var for higher limits")
            sys.exit(1)
        raise RuntimeError(f"HTTP {e.code}: {e.reason} — {url}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error: {e.reason}") from e


def _ensure_cache() -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR


def _name_from_url(url: str) -> str:
    """Derive a safe cache folder name from a URL."""
    # Try to extract skill name from path: .../skills/<name>/SKILL.md
    m = re.search(r"skills/([^/]+)/SKILL\.md", url, re.IGNORECASE)
    if m:
        return re.sub(r"[^a-zA-Z0-9_\-]", "_", m.group(1))
    # Fallback: hash of url
    return "skill_" + hashlib.sha1(url.encode()).hexdigest()[:8]


def _is_valid_skill(content: str) -> bool:
    """Minimal validation: must have markdown headers and enough content."""
    has_header = bool(re.search(r"^#+\s+\S", content, re.MULTILINE))
    return has_header and len(content) >= 100


def _fmt_size(n: int) -> str:
    if n >= 1024:
        return f"{n/1024:.1f}KB"
    return f"{n}B"


def _fmt_dt(iso: str) -> str:
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return iso[:16]


def _load_meta(cache_name: str) -> dict | None:
    meta_path = CACHE_DIR / cache_name / "meta.json"
    if not meta_path.exists():
        return None
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def search(query: str, max_results: int = 10) -> None:
    """Search GitHub for SKILL.md files matching query."""
    token = _get_github_token()
    if not token:
        print("\n[notice] No GITHUB_TOKEN found. Using unauthenticated rate limit (60 req/hour).")
        print("         To increase limit to 5000 req/hour:")
        print("         • PowerShell: $env:GITHUB_TOKEN = 'ghp_...'")
        print("         • OR settings.json: mcpServers > [server] > env > GITHUB_TOKEN\n")

    print(f"[discover] Searching GitHub for: '{query}' (max {max_results})\n")
    url = (
        f"{GITHUB_API_BASE}/search/code"
        f"?q={urllib.request.quote(query)}+filename:SKILL.md"
        f"&per_page={max_results}"
    )
    try:
        data = _get(url)
    except RuntimeError as e:
        print(f"[error] {e}")
        print("\nTroubleshooting:")
        print("  • If rate-limited: set GITHUB_TOKEN env var")
        print("  • If auth fails: verify token has 'public_repo' scope")
        print("  • Docs: https://docs.github.com/en/rest/search/search-code")
        sys.exit(1)

    items = data.get("items", [])
    total = data.get("total_count", 0)

    if not items:
        print("No results found.")
        if not token:
            print("(Tip: rate limit is low without GITHUB_TOKEN — add one to get more results)")
        return

    print(f"Found {total} total matches, showing {len(items)}:\n")

    # Column widths
    col_name = 28
    col_repo = 36
    col_size = 7

    header = (
        f"{'NAME':<{col_name}}  {'REPO':<{col_repo}}  {'SIZE':>{col_size}}  URL"
    )
    print(header)
    print("-" * (len(header) + 20))

    for item in items:
        repo_name = item.get("repository", {}).get("full_name", "?")
        path = item.get("path", "")
        # Derive skill name from path
        m = re.search(r"skills/([^/]+)/SKILL\.md", path, re.IGNORECASE)
        skill_name = m.group(1) if m else Path(path).parent.name or "unknown"
        html_url = item.get("html_url", "")
        # Build raw URL
        raw_url = (
            "https://raw.githubusercontent.com/"
            + repo_name
            + "/HEAD/"
            + path
        )
        size = item.get("size", 0)
        print(
            f"{skill_name:<{col_name}}  {repo_name:<{col_repo}}  "
            f"{_fmt_size(size):>{col_size}}  {raw_url}"
        )

    print()
    print("To cache a skill: skill_discover.py fetch <raw_url>")
    print()


def fetch(raw_url: str, name: str | None = None) -> None:
    """Download and cache a SKILL.md from a raw GitHub URL."""
    _ensure_cache()
    cache_name = name if name else _name_from_url(raw_url)
    # Sanitize
    cache_name = re.sub(r"[^a-zA-Z0-9_\-]", "_", cache_name)

    target_dir = CACHE_DIR / cache_name
    if target_dir.exists():
        print(f"[discover] Cache entry '{cache_name}' already exists — use a different --name or clean first.")
        return

    print(f"[discover] Fetching: {raw_url}")
    try:
        content = _get_raw(raw_url)
    except RuntimeError as e:
        print(f"[error] {e}")
        sys.exit(1)

    if not _is_valid_skill(content):
        print(
            "[error] Content does not look like a valid SKILL.md "
            "(needs markdown headers and at least 100 characters). Aborting."
        )
        sys.exit(1)

    target_dir.mkdir(parents=True, exist_ok=True)
    skill_path = target_dir / "SKILL.md"
    skill_path.write_text(content, encoding="utf-8")

    # Extract repo from raw URL for metadata
    m = re.search(r"raw\.githubusercontent\.com/([^/]+/[^/]+)/", raw_url)
    repo = m.group(1) if m else "unknown"

    meta = {
        "source_url": raw_url,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "repo": repo,
        "reviewed": False,
    }
    meta_path = target_dir / "meta.json"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    size = len(content.encode("utf-8"))
    print(f"[discover] Cached as '{cache_name}' ({_fmt_size(size)})")
    print(f"           Preview: skill_discover.py preview {cache_name}")
    print(f"           Install: skill_discover.py install {cache_name}")
    print()


def list_cached() -> None:
    """List all cached skills with their metadata."""
    _ensure_cache()
    entries = sorted(CACHE_DIR.iterdir()) if CACHE_DIR.exists() else []
    entries = [e for e in entries if e.is_dir()]

    if not entries:
        print("[discover] No cached skills. Use: skill_discover.py search <query>")
        return

    print(f"\n[discover] Cached skills ({len(entries)} total)\n")
    col_name = 28
    col_repo = 36
    col_date = 16
    col_rev = 8
    col_size = 7

    header = (
        f"{'NAME':<{col_name}}  {'REPO':<{col_repo}}  "
        f"{'FETCHED':<{col_date}}  {'REVIEWED':<{col_rev}}  {'SIZE':>{col_size}}"
    )
    print(header)
    print("-" * len(header))

    for entry in entries:
        meta = _load_meta(entry.name)
        skill_file = entry / "SKILL.md"
        size_str = _fmt_size(skill_file.stat().st_size) if skill_file.exists() else "?"
        if meta:
            repo = meta.get("repo", "?")
            fetched = _fmt_dt(meta.get("fetched_at", ""))
            reviewed = "yes" if meta.get("reviewed") else "no"
        else:
            repo = fetched = reviewed = "?"
        print(
            f"{entry.name:<{col_name}}  {repo:<{col_repo}}  "
            f"{fetched:<{col_date}}  {reviewed:<{col_rev}}  {size_str:>{col_size}}"
        )
    print()


def preview(name: str) -> None:
    """Print first 50 lines of a cached SKILL.md plus its metadata."""
    _ensure_cache()
    name = re.sub(r"[^a-zA-Z0-9_\-]", "_", name)
    target_dir = CACHE_DIR / name
    skill_file = target_dir / "SKILL.md"

    if not skill_file.exists():
        print(f"[error] Cached skill '{name}' not found. Run: skill_discover.py list")
        sys.exit(1)

    meta = _load_meta(name)
    if meta:
        print(f"\n[meta]")
        print(f"  Source:   {meta.get('source_url', '?')}")
        print(f"  Repo:     {meta.get('repo', '?')}")
        print(f"  Fetched:  {_fmt_dt(meta.get('fetched_at', ''))}")
        print(f"  Reviewed: {'yes' if meta.get('reviewed') else 'no'}")

    print(f"\n[preview] First 50 lines of '{name}/SKILL.md':\n")
    print("-" * 60)
    lines = skill_file.read_text(encoding="utf-8").splitlines()
    for i, line in enumerate(lines[:50], 1):
        print(f"{i:3}  {line}")
    if len(lines) > 50:
        print(f"     ... ({len(lines) - 50} more lines)")
    print("-" * 60)
    print()


def install(name: str, force: bool = False) -> None:
    """Install a cached skill into ~/.claude/skills/."""
    _ensure_cache()
    name = re.sub(r"[^a-zA-Z0-9_\-]", "_", name)
    src_dir = CACHE_DIR / name

    if not src_dir.exists():
        print(f"[error] Cached skill '{name}' not found. Run: skill_discover.py list")
        sys.exit(1)

    dest_dir = SKILLS_DIR / name
    if dest_dir.exists() and not force:
        print(
            f"[error] Skill '{name}' already exists at {dest_dir}\n"
            f"        Use --force to overwrite."
        )
        sys.exit(1)

    if dest_dir.exists() and force:
        shutil.rmtree(dest_dir)

    SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copytree(str(src_dir), str(dest_dir))

    # Mark as reviewed in cache meta
    meta_path = src_dir / "meta.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["reviewed"] = True
            meta["installed_at"] = datetime.now(timezone.utc).isoformat()
            meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
            # Also update in dest
            (dest_dir / "meta.json").write_text(
                json.dumps(meta, indent=2), encoding="utf-8"
            )
        except Exception:
            pass

    print(f"[discover] Installed '{name}' to {dest_dir}")
    print(f"           Skill is now available in ~/.claude/skills/{name}/")
    print()


def clean(days: int = 7) -> None:
    """Remove cached skills older than `days` days that haven't been installed."""
    _ensure_cache()
    if not CACHE_DIR.exists():
        print("[discover] Cache directory empty — nothing to clean.")
        return

    cutoff = datetime.now(timezone.utc).timestamp() - days * 86400
    removed = 0

    for entry in sorted(CACHE_DIR.iterdir()):
        if not entry.is_dir():
            continue
        meta = _load_meta(entry.name)
        if meta:
            if meta.get("reviewed"):
                continue  # keep installed skills
            try:
                fetched = datetime.fromisoformat(
                    meta.get("fetched_at", "").replace("Z", "+00:00")
                ).timestamp()
            except Exception:
                fetched = 0
        else:
            fetched = entry.stat().st_mtime

        if fetched < cutoff:
            shutil.rmtree(entry)
            print(f"[discover] Removed '{entry.name}' (older than {days} days)")
            removed += 1

    if removed == 0:
        print(f"[discover] Nothing to clean (no unreviewed skills older than {days} days).")
    else:
        print(f"[discover] Cleaned {removed} cached skill(s).")
    print()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="skill_discover.py",
        description="ULTRON — GitHub Skill Discovery",
    )
    sub = parser.add_subparsers(dest="cmd", metavar="<command>")

    # search
    p_search = sub.add_parser("search", help="Search GitHub for skills matching query")
    p_search.add_argument("query", help="Search query (e.g. 'python helper')")
    p_search.add_argument("--max", dest="max_results", type=int, default=10,
                          metavar="N", help="Max results (default: 10)")

    # fetch
    p_fetch = sub.add_parser("fetch", help="Fetch and cache a skill from GitHub raw URL")
    p_fetch.add_argument("url", help="Raw GitHub URL to SKILL.md")
    p_fetch.add_argument("--name", default=None,
                         help="Override cache folder name (default: auto from URL)")

    # list
    sub.add_parser("list", help="List cached skills pending review")

    # preview
    p_preview = sub.add_parser("preview", help="Preview a cached skill")
    p_preview.add_argument("name", help="Cached skill name")

    # install
    p_install = sub.add_parser("install", help="Install cached skill to ~/.claude/skills/")
    p_install.add_argument("name", help="Cached skill name")
    p_install.add_argument("--force", action="store_true",
                           help="Overwrite existing skill if present")

    # clean
    p_clean = sub.add_parser("clean", help="Remove old cached skills")
    p_clean.add_argument("--days", type=int, default=7, metavar="N",
                         help="Remove skills older than N days (default: 7)")

    args = parser.parse_args()

    if args.cmd == "search":
        search(args.query, args.max_results)
    elif args.cmd == "fetch":
        fetch(args.url, args.name)
    elif args.cmd == "list":
        list_cached()
    elif args.cmd == "preview":
        preview(args.name)
    elif args.cmd == "install":
        install(args.name, force=getattr(args, "force", False))
    elif args.cmd == "clean":
        clean(args.days)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
