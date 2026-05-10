#!/usr/bin/env python3
"""
ULTRON v12.2 Cockpit - AI Standup generator.

Generates a daily morning briefing markdown:
    ~/.ultron/cockpit/standup/YYYY-MM-DD.md

Reads:
  - projects.json
  - deadlines.json
  - news/ALERTS.md
  - git log of active projects (last 24h commits)
  - ~/.ultron/.tmp/current-session.json (Pulse)

Output sections:
  - Yesterday: git commits from active projects last 24h
  - Today: upcoming deadlines (next 7d)
  - Recommendation: top project to focus on (deadline pressure)
  - Alerts: any breaking changes from news scraper
  - Pulse: last session cache + stale knowledge notes

Designed to be a STARTING POINT for the day. Uses NO external LLM calls
(deterministic markdown). For richer Gemini-summarized version, run with --gemini.

Cron: weekday 8AM via Task Scheduler.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import (  # noqa: E402
    Cockpit, COCKPIT_DIR, PROJECTS_JSON,
    DEADLINES_JSON, NEWS_ALERTS,
)


STANDUP_DIR = COCKPIT_DIR / "standup"


# ── Data loaders ─────────────────────────────────────────────────────────────

def load_projects() -> list[dict]:
    return Cockpit.read_json(PROJECTS_JSON, default={"projects": []}).get("projects", [])


def load_deadlines() -> dict:
    return Cockpit.read_json(DEADLINES_JSON, default={"matches": []})


def load_alerts_head(max_lines: int = 25) -> list[str]:
    if not NEWS_ALERTS.exists():
        return []
    return NEWS_ALERTS.read_text(encoding="utf-8").splitlines()[:max_lines]


# ── Git helper ───────────────────────────────────────────────────────────────

def git_commits_since_24h(repo_path: str, max_count: int = 5) -> list[str]:
    """Return up to max_count one-liners of commits in the last 24h."""
    if not shutil.which("git"):
        return []
    try:
        result = subprocess.run(
            ["git", "-C", repo_path, "log", "--since=24.hours", "--oneline",
             f"-n", str(max_count)],
            capture_output=True, text=True, timeout=8, encoding="utf-8",
            creationflags=_WIN_HIDDEN,
        )
        if result.returncode == 0:
            return [l for l in result.stdout.splitlines() if l.strip()]
    except Exception:
        pass
    return []


# ── Sections ─────────────────────────────────────────────────────────────────

def section_yesterday(projects: list[dict]) -> list[str]:
    """Git-based yesterday: show commits from active projects in last 24h."""
    lines = ["## Yesterday", ""]
    active = [p for p in projects if p.get("status") in ("active", "auto-detected")][:8]
    found_any = False
    for proj in active:
        path = proj.get("path", "")
        if not path:
            continue
        commits = git_commits_since_24h(path, max_count=3)
        if commits:
            found_any = True
            name = proj.get("name", proj["id"])
            lines.append(f"**{name}** (`{proj['id']}`)")
            for c in commits:
                lines.append(f"  - `{c}`")
    if not found_any:
        lines.append("_No commits in active projects in the last 24h._")
    lines.append("")
    return lines


def section_today(projects: list[dict], deadlines: dict) -> list[str]:
    today = datetime.now().date()
    horizon = today + timedelta(days=7)

    upcoming = []
    # From projects.json deadlines (manual)
    for p in projects:
        dl = p.get("deadline")
        if not dl:
            continue
        try:
            d = datetime.fromisoformat(dl).date()
            if today <= d <= horizon:
                upcoming.append((d, p["id"], "manual", p.get("name", "")))
        except (ValueError, TypeError):
            continue
    # From Calendar matches
    for m in deadlines.get("matches", []):
        try:
            d = datetime.fromisoformat(m.get("date", "")).date()
            if today <= d <= horizon:
                upcoming.append((d, m.get("project_id", "?"),
                                 f"calendar (score={m.get('score')})",
                                 m.get("event_title", "")))
        except (ValueError, TypeError):
            continue

    if not upcoming:
        return ["## Today / next 7 days", "",
                "_No deadlines in the next 7 days._", ""]

    upcoming.sort(key=lambda x: x[0])
    lines = ["## Today / next 7 days", ""]
    for d, pid, source, title in upcoming:
        days_left = (d - today).days
        tag = "**TODAY**" if days_left == 0 else f"**{days_left}d**"
        lines.append(f"- {tag} `{pid}` - {title} _({source}, {d})_")
    lines.append("")
    return lines


def section_recommendation(projects: list[dict], deadlines: dict) -> list[str]:
    """Recommend a focus project: weighted by deadline pressure."""
    today = datetime.now().date()

    candidates = []  # list of (urgency_score, project_id, reason)
    for p in projects:
        if p.get("status") not in ("active", "auto-detected"):
            continue
        pid = p["id"]
        urgency = 0.0

        # Deadline pressure (closer = higher)
        dl = p.get("deadline")
        if dl:
            try:
                d = datetime.fromisoformat(dl).date()
                days_left = (d - today).days
                if 0 <= days_left <= 14:
                    urgency += (15 - days_left) * 1.5  # 0d=22.5, 14d=1.5
            except (ValueError, TypeError):
                pass

        for m in deadlines.get("matches", []):
            if m.get("project_id") != pid:
                continue
            try:
                d = datetime.fromisoformat(m.get("date", "")).date()
                days_left = (d - today).days
                if 0 <= days_left <= 14:
                    urgency += (15 - days_left) * 1.5 * float(m.get("score", 0.5))
            except (ValueError, TypeError):
                continue

        if urgency > 0:
            candidates.append((urgency, pid, p.get("name", pid)))

    if not candidates:
        return [
            "## Recommendation",
            "",
            "_No clear focus today. No active deadlines in the next 14 days._",
            "_Consider catching up on tech debt or refreshing knowledge._",
            "",
        ]

    candidates.sort(reverse=True)
    top_score, top_pid, top_name = candidates[0]
    runners = candidates[1:3]

    lines = ["## Recommendation", "",
             f"**Focus today: `{top_pid}`** ({top_name})", "",
             f"_Urgency score: {top_score:.1f}_", ""]
    if runners:
        lines.append("**Runner-ups:**")
        for s, pid, name in runners:
            lines.append(f"- `{pid}` (score {s:.1f}) - {name}")
        lines.append("")
    return lines


def section_alerts() -> list[str]:
    head = load_alerts_head()
    if not head:
        return ["## News alerts", "", "_No breaking changes in queue._", ""]
    return ["## News alerts", "", "```"] + head + ["```", ""]


def section_pulse() -> list[str]:
    """Session continuity from ULTRON's own cache."""
    session_file = Path.home() / ".ultron" / ".tmp" / "current-session.json"
    if not session_file.exists():
        return ["## Pulse", "", "_No session cache found._", ""]
    try:
        data = json.loads(session_file.read_text(encoding="utf-8"))
        mode = data.get("mode", "MEDIUM")
        ts = data.get("ts", "?")[:19]
        stale = data.get("stale_notes", [])
        lines = ["## Pulse", "", f"Last session: `{ts}` · Mode: `{mode}`", ""]
        if stale:
            lines.append("Stale knowledge (brain_index top-3):")
            for n in stale[:3]:
                lines.append(f"  - {n}")
        lines.append("")
        return lines
    except Exception:
        return ["## Pulse", "", "_Session cache unreadable._", ""]


def section_header() -> list[str]:
    today = datetime.now().date()
    return [
        f"# Standup - {today.isoformat()} ({today.strftime('%A')})",
        "",
        f"_Auto-generated {datetime.now().isoformat(timespec='seconds')}_",
        "",
    ]


# ── Optional Gemini polish ───────────────────────────────────────────────────

def gemini_polish(markdown: str) -> str | None:
    if not shutil.which("gemini"):
        return None
    prompt = (
        "You are a no-bullshit productivity coach. Rewrite this morning standup "
        "to be punchier and add a single 1-line insight or warning at the top. "
        "Keep all bullet points and structure intact. Output markdown only.\n\n"
        + markdown
    )
    try:
        result = subprocess.run(
            ["gemini", "-p", prompt, "-m", "flash", "--approval-mode", "plan",
             "-o", "json", "--skip-trust"],
            capture_output=True, text=True, timeout=60, encoding="utf-8",
            creationflags=_WIN_HIDDEN,
        )
        # v10.4.5 fix: Gemini JSON output can span multiple lines.
        # Find first '{' and walk to matching closing brace (depth tracking).
        raw = result.stdout or ""
        first = raw.find("{")
        if first < 0:
            return None
        payload = _extract_json_object(raw[first:])
        if not payload:
            return None
        data = json.loads(payload)
        response = data.get("response", "")
        response = re.sub(r"^```(?:markdown)?\s*", "", response.strip())
        response = re.sub(r"\s*```$", "", response)
        return response or None
    except Exception:
        return None
    return None


def _extract_json_object(text: str) -> str | None:
    """Walk text from first char (assumed '{') to matching '}'."""
    depth = 0
    in_string = False
    escape = False
    for i, ch in enumerate(text):
        if escape:
            escape = False
            continue
        if ch == "\\" and in_string:
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[: i + 1]
    return None


# ── Build ────────────────────────────────────────────────────────────────────

def build(use_gemini: bool = False) -> Path:
    projects = load_projects()
    deadlines = load_deadlines()

    lines: list[str] = []
    lines += section_header()
    lines += section_yesterday(projects)
    lines += section_today(projects, deadlines)
    lines += section_recommendation(projects, deadlines)
    lines += section_alerts()
    lines += section_pulse()

    md = "\n".join(lines)

    if use_gemini:
        polished = gemini_polish(md)
        if polished:
            md = polished

    STANDUP_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")
    out = STANDUP_DIR / f"{today}.md"
    out.write_text(md, encoding="utf-8")
    return out


def main():
    p = argparse.ArgumentParser(description="ULTRON Cockpit AI standup")
    p.add_argument("--gemini", action="store_true", help="Polish with Gemini flash (uses tokens)")
    p.add_argument("--print", action="store_true", help="Print today's standup if it exists")
    p.add_argument("--from-cron", action="store_true",
                   help="(Internal) Apply weekday + daily skip-guard. Manual runs always execute.")
    args = p.parse_args()

    today = datetime.now().strftime("%Y-%m-%d")
    out = STANDUP_DIR / f"{today}.md"

    if args.print:
        if out.exists():
            print(out.read_text(encoding="utf-8"))
        else:
            print("(no standup for today; run without --print to generate)")
        return 0

    # Weekday + daily guard ONLY from cron. Manual runs always execute.
    if args.from_cron:
        from should_run import should_run_weekday
        if not should_run_weekday("standup"):
            wd = datetime.now().weekday()
            reason = "weekend" if wd >= 5 else "already ran today"
            print(f"[standup] Cron skip ({reason})")
            return 0

    path = build(use_gemini=args.gemini)
    print(f"[standup] Wrote {path} ({path.stat().st_size} bytes)")
    if args.from_cron:
        from should_run import mark_ran_today
        mark_ran_today("standup")
    return 0


if __name__ == "__main__":
    sys.exit(main())
