#!/usr/bin/env python3
"""
ULTRON Skill Finder v3.0 - Interactive skill discovery with Codex & Gemini.

Launches interactive Codex and Gemini CLI sessions with prepared prompts for skill discovery.
User interacts directly with the CLI tools for search, discovery, and installation.

Usage:
    skill_finder.py find-github <keywords>      Launch Codex for GitHub skills search
    skill_finder.py find-web <keywords>         Launch Gemini for web skills discovery
    skill_finder.py list-installed              Show installed skills
    skill_finder.py list-favorites              Show favorite skills with ratings
"""
from __future__ import annotations

import argparse
import atexit
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SKILLS_DIR = Path.home() / ".claude" / "skills"
ULTRON_DIR = Path.home() / ".ultron"
ULTRON_SKILL_INDEX = ULTRON_DIR / "skill_index.json"
ULTRON_SKILL_FAVORITES = ULTRON_DIR / "skill_favorites.json"


def _ensure_dirs() -> None:
    """Create necessary directories."""
    try:
        SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        print(f"[warn] Could not create skills dir: {e}", file=sys.stderr)
    try:
        ULTRON_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        print(f"[warn] Could not create ULTRON dir: {e}", file=sys.stderr)


def _load_installed_skills() -> dict:
    """Load list of installed skills with metadata."""
    installed = {}
    if SKILLS_DIR.exists():
        for skill_dir in SKILLS_DIR.iterdir():
            if skill_dir.is_dir():
                skill_file = skill_dir / "SKILL.md"
                if skill_file.exists():
                    installed[skill_dir.name] = {
                        "path": str(skill_dir),
                        "size": len(skill_file.read_text(encoding="utf-8")),
                        "installed_at": datetime.fromtimestamp(
                            skill_file.stat().st_mtime
                        ).isoformat(),
                    }
    return installed


def _save_skill_index(skills: dict) -> None:
    """Save discovered skills to Ultron index."""
    _ensure_dirs()
    index = {
        "last_discovery": datetime.now(timezone.utc).isoformat(),
        "skills": skills,
    }
    ULTRON_SKILL_INDEX.write_text(
        json.dumps(index, indent=2), encoding="utf-8"
    )


def _load_favorites() -> dict:
    """Load favorites and ratings from disk."""
    if ULTRON_SKILL_FAVORITES.exists():
        try:
            return json.loads(ULTRON_SKILL_FAVORITES.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save_favorites(favorites: dict) -> None:
    """Save favorites and ratings to disk."""
    _ensure_dirs()
    ULTRON_SKILL_FAVORITES.write_text(
        json.dumps(favorites, indent=2), encoding="utf-8"
    )


def _add_favorite(name: str, url: str, rating: int = 5) -> None:
    """Add skill to favorites with rating (1-5)."""
    favorites = _load_favorites()
    favorites[name] = {
        "url": url,
        "rating": max(1, min(5, rating)),
        "added_at": datetime.now(timezone.utc).isoformat(),
    }
    _save_favorites(favorites)


def _format_installed_for_prompt(installed: dict) -> str:
    """Format installed skills for prompt context."""
    if not installed:
        return "No skills installed yet."
    lines = ["Installed skills:"]
    for name in sorted(installed.keys()):
        lines.append(f"  • {name}")
    return "\n".join(lines)


def _search_with_codex(prompt: str) -> str:
    """
    Search using Codex CLI directly. Codex searches internet, returns JSON.
    No user interaction required - Codex does the work.
    """
    print("[codex-search] Searching GitHub with Codex (this may take 30-60 seconds)...")
    print("[codex-search] (Codex is searching internet for repos, stars, activity, etc.)")

    try:
        # Execute Codex with search prompt, capture output
        result = subprocess.run(
            ["codex"],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode != 0:
            if "not found" in result.stderr.lower() or "not recognized" in result.stderr.lower():
                print("\n[ERROR] Codex CLI not found!", file=sys.stderr)
                print("Install with: pipx install openai-cli", file=sys.stderr)
                raise RuntimeError("Codex CLI not installed")
            raise RuntimeError(f"Codex error: {result.stderr}")

        return result.stdout

    except FileNotFoundError:
        print("\n[ERROR] Codex CLI not found!", file=sys.stderr)
        print("Install with: pipx install openai-cli", file=sys.stderr)
        raise RuntimeError("Codex CLI not installed") from None
    except subprocess.TimeoutExpired:
        print("\n[ERROR] Codex search timed out (>120s)", file=sys.stderr)
        raise RuntimeError("Codex search timeout") from None


def _search_with_gemini(prompt: str) -> str:
    """
    Search using Gemini CLI directly. Gemini searches internet with 1M context window.
    Returns JSON with results from web (foros, blogs, stats, trending, etc.).
    No user interaction required - Gemini does the work.
    """
    print("[gemini-search] Searching web with Gemini (this may take 30-60 seconds)...")
    print("[gemini-search] (Gemini is searching: foros, blogs, GitHub, Reddit, stats, trending, etc.)")

    try:
        # Execute Gemini with search prompt, capture output
        result = subprocess.run(
            ["gemini"],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode != 0:
            if "not found" in result.stderr.lower() or "not recognized" in result.stderr.lower():
                print("\n[ERROR] Gemini CLI not found!", file=sys.stderr)
                print("Install with: pip install gemini-cli", file=sys.stderr)
                raise RuntimeError("Gemini CLI not installed")
            raise RuntimeError(f"Gemini error: {result.stderr}")

        return result.stdout

    except FileNotFoundError:
        print("\n[ERROR] Gemini CLI not found!", file=sys.stderr)
        print("Install with: pip install gemini-cli", file=sys.stderr)
        raise RuntimeError("Gemini CLI not installed") from None
    except subprocess.TimeoutExpired:
        print("\n[ERROR] Gemini search timed out (>120s)", file=sys.stderr)
        raise RuntimeError("Gemini search timeout") from None


def find_github_skills(keywords: str) -> None:
    """Launch interactive Codex session to search GitHub for skills."""
    print("\n" + "=" * 80)
    print("CODEX INTERACTIVE SESSION — GitHub Skills Search")
    print("=" * 80)
    print(f"\nSearching for: '{keywords}'")
    print("\nYour search prompt:")
    print("-" * 80)

    prompt = f"""Search GitHub for Claude Code SKILLS matching: '{keywords}'

Look for:
- SKILL.md files
- Active maintenance (<6 months)
- Clear documentation

Recommend TOP 5 with name, URL, description, why valuable, and install notes."""

    print(prompt)
    print("-" * 80)
    print("\nLaunching Codex in interactive window...")
    print("(You can paste the prompt above or search manually)\n")

    try:
        subprocess.Popen(
            ["powershell", "-NoProfile", "-Command", "codex"],
            creationflags=subprocess.CREATE_NEW_CONSOLE
        )
    except FileNotFoundError:
        print("[ERROR] Codex CLI not found!")
        print("Install with: pip install openai-cli")
    except Exception as e:
        print(f"[ERROR] {e}")


def find_web_skills(keywords: str) -> None:
    """Launch interactive Gemini session to search web for skills."""
    print("\n" + "=" * 80)
    print("GEMINI INTERACTIVE SESSION — Web Skills Discovery (1M context)")
    print("=" * 80)
    print(f"\nSearching for: '{keywords}'")
    print("\nYour search prompt:")
    print("-" * 80)

    prompt = f"""Search the WEB for Claude Code SKILLS matching: '{keywords}'

Look at:
- GitHub repos (SKILL.md)
- Trending (GitHub, ProductHunt, Reddit)
- Community forums & blogs
- Project stats (stars, activity)

Filter for:
- Active (<3 months)
- Good documentation
- Community feedback

Recommend TOP 5 with name, URL, description, rating, and install steps."""

    print(prompt)
    print("-" * 80)
    print("\nLaunching Gemini 3.1 in interactive window...")
    print("(You can paste the prompt above or search manually)\n")

    try:
        subprocess.Popen(
            ["powershell", "-NoProfile", "-Command", "gemini"],
            creationflags=subprocess.CREATE_NEW_CONSOLE
        )
    except FileNotFoundError:
        print("[ERROR] Gemini CLI not found!")
        print("Install with: pip install gemini-cli")
    except Exception as e:
        print(f"[ERROR] {e}")


def _install_skills(skills: list) -> None:
    """Install selected skills and sync with Ultron."""
    if not skills:
        return

    print(f"\n[installer] Installing {len(skills)} skill(s)...\n")

    installed_count = 0
    for skill in skills:
        name = skill.get("name", "unknown")
        url = skill.get("url", "")

        if not url:
            print(f"[error] No URL for {name} — skipping")
            continue

        print(f"[installer] Installing '{name}'...")

        # For GitHub skills, use skill_discover.py fetch
        if "github" in url.lower() or "raw.githubusercontent" in url.lower():
            try:
                result = subprocess.run(
                    [
                        sys.executable,
                        str(Path(__file__).parent / "skill_discover.py"),
                        "fetch",
                        url,
                        "--name",
                        name,
                    ],
                    timeout=60,
                )
                if result.returncode == 0:
                    print(f"  ✓ Cached as '{name}'")

                    # Auto-install from cache
                    subprocess.run(
                        [
                            sys.executable,
                            str(Path(__file__).parent / "skill_discover.py"),
                            "install",
                            name,
                            "--force",
                        ],
                        timeout=60,
                    )
                    print(f"  ✓ Installed to ~/.claude/skills/{name}/")
                    installed_count += 1

                    # Ask if want to add to favorites
                    fav = input(f"\nAdd '{name}' to favorites? (y/n, default=y): ").strip().lower()
                    if fav != "n":
                        rating_str = input("Rate (1-5 stars, default=5): ").strip()
                        try:
                            rating = int(rating_str) if rating_str else 5
                        except ValueError:
                            rating = 5
                        _add_favorite(name, url, rating)
                        print(f"  ⭐ Added to favorites (rating: {rating}/5)")

                else:
                    print(f"  ✗ Failed to fetch {name}")
            except Exception as e:
                print(f"  ✗ Error: {e}")
        else:
            print(f"  ⓘ Manual installation required for {url}")

    # Sync with Ultron
    print("\n[sync] Syncing with Ultron...")
    installed = _load_installed_skills()
    _save_skill_index(installed)
    print("[sync] ✓ Skill index updated")
    print(f"[sync] Installed: {installed_count} skill(s)")
    print("[sync] Next: run 'ultron' to refresh dashboard\n")


def list_installed() -> None:
    """Show installed skills."""
    installed = _load_installed_skills()

    if not installed:
        print("\n[skills] No skills installed yet.\n")
        return

    print(f"\n[skills] Installed ({len(installed)} total)\n")
    print(f"{'NAME':<30} {'SIZE':<10} {'INSTALLED':<16}")
    print("-" * 60)

    for name in sorted(installed.keys()):
        meta = installed[name]
        size = f"{meta.get('size', 0) / 1024:.1f}KB"
        installed_at = meta.get("installed_at", "?")[:10]
        print(f"{name:<30} {size:<10} {installed_at:<16}")

    print()


def list_favorites() -> None:
    """Show favorite skills with ratings."""
    favorites = _load_favorites()

    if not favorites:
        print("\n[favorites] No favorite skills yet.\n")
        return

    print(f"\n[favorites] ({len(favorites)} total)\n")
    print(f"{'NAME':<30} {'RATING':<10} {'ADDED':<16}")
    print("-" * 60)

    for name in sorted(favorites.keys()):
        meta = favorites[name]
        rating = f"{'⭐' * meta.get('rating', 0):<10}"
        added_at = meta.get("added_at", "?")[:10]
        print(f"{name:<30} {rating:<10} {added_at:<16}")

    print()


def remove_favorite(name: str) -> None:
    """Remove skill from favorites."""
    favorites = _load_favorites()

    if name not in favorites:
        print(f"[error] '{name}' not in favorites")
        return

    del favorites[name]
    _save_favorites(favorites)
    print(f"[favorites] Removed '{name}'")


def rate_skill(name: str, rating: int) -> None:
    """Update rating for a favorite skill."""
    favorites = _load_favorites()

    if name not in favorites:
        print(f"[error] '{name}' not in favorites")
        return

    rating = max(1, min(5, rating))
    favorites[name]["rating"] = rating
    _save_favorites(favorites)
    print(f"[favorites] '{name}' rated: {'⭐' * rating}")


def main() -> None:
    # Startup message to confirm execution
    print("\n" + "=" * 80)
    print("ULTRON Skill Finder v3.0 — Starting...")
    print("=" * 80)
    print(f"Command line args: {sys.argv}")
    print("=" * 80 + "\n")

    parser = argparse.ArgumentParser(
        prog="skill_finder.py",
        description="ULTRON Skill Finder — Interactive discovery with Codex & Gemini",
    )
    sub = parser.add_subparsers(dest="cmd", metavar="<command>")

    # find-github
    p_gh = sub.add_parser("find-github", help="Find GitHub skills with Codex")
    p_gh.add_argument("keywords", help="Search keywords (e.g., 'authentication')")

    # find-web
    p_web = sub.add_parser("find-web", help="Find web skills with Gemini 3.1")
    p_web.add_argument("keywords", help="Search keywords (e.g., 'testing helpers')")

    # list-installed
    sub.add_parser("list-installed", help="Show installed skills")

    # list-favorites
    sub.add_parser("list-favorites", help="Show favorite skills with ratings")

    # remove-favorite
    p_rm_fav = sub.add_parser("remove-favorite", help="Remove skill from favorites")
    p_rm_fav.add_argument("name", help="Skill name")

    # rate-skill
    p_rate = sub.add_parser("rate-skill", help="Rate a favorite skill (1-5)")
    p_rate.add_argument("name", help="Skill name")
    p_rate.add_argument("rating", type=int, help="Rating 1-5")

    args = parser.parse_args()

    if args.cmd == "find-github":
        find_github_skills(args.keywords)
    elif args.cmd == "find-web":
        find_web_skills(args.keywords)
    elif args.cmd == "list-installed":
        list_installed()
    elif args.cmd == "list-favorites":
        list_favorites()
    elif args.cmd == "remove-favorite":
        remove_favorite(args.name)
    elif args.cmd == "rate-skill":
        rate_skill(args.name, args.rating)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n[FATAL ERROR] {type(e).__name__}: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
    finally:
        print("\nPress Enter to close this window...")
        try:
            input()
        except (EOFError, KeyboardInterrupt):
            pass
