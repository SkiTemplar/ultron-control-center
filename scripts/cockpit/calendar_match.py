#!/usr/bin/env python3
"""
ULTRON v10.0 Cockpit - Calendar deadline matching.

Matches Google Calendar events against projects.json by intelligent scoring.
Designed to be invoked by Claude AFTER reading events via the Google Calendar MCP:

    Claude flow:
        1. mcp__claude_ai_Google_Calendar__list_events(timeMin=now, timeMax=+60d)
        2. Build events list as JSON
        3. python calendar_match.py --events events.json
        4. Read ~/.ultron/cockpit/deadlines.json for matched results

Standalone usage (manual / testing):
    python calendar_match.py --events events.json
    python calendar_match.py --sample            # generates synthetic events for testing
    python calendar_match.py --print             # shows current matches

Input event JSON shape (one event per dict):
    {
      "id":         "<google_event_id>",
      "title":      "Tortunabo demo entrega final",
      "description": "Entrega del proyecto Tortunabo en clase de PROGRAM_A",
      "start":      "2026-05-15",
      "end":        "2026-05-15"
    }

Output: ~/.ultron/cockpit/deadlines.json
    {
      "version": "1.0",
      "last_match": "...",
      "matches": [
        {"project_id": "tortunabo", "event_id": "...", "event_title": "...",
         "date": "2026-05-15", "score": 0.95, "reasons": ["name in title"]}
      ],
      "unmatched": [{"event_id": "...", "title": "...", "best_score": 0.42}]
    }

Scoring rubric (0.0 - 1.0):
    + 1.0  project name exact (case-insensitive) in event title
    + 0.9  project id (slug) in event title
    + 0.6  project name in event description
    + 0.5  any tag of the project appears in title/description
    + 0.4  deadline-keyword (entrega, deadline, demo, exam, practica)
           AND any project keyword in title
    Threshold: score >= 0.6 -> match
    Confidence threshold: only auto-link if score >= 0.8 (lower scores reported as suggestions)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import Cockpit, PROJECTS_JSON, DEADLINES_JSON  # noqa: E402


DEADLINE_KEYWORDS = re.compile(
    r"\b(entrega|deadline|demo|exam|examen|practica|práctica|presentation|"
    r"submission|due|fecha\s+limite|fecha\s+l[íi]mite|review)\b",
    re.IGNORECASE,
)

MATCH_THRESHOLD = 0.6
HIGH_CONFIDENCE = 0.8


def load_projects() -> list[dict]:
    return Cockpit.read_json(PROJECTS_JSON, default={"projects": []}).get("projects", [])


def text_contains(needle: str, haystack: str) -> bool:
    if not needle or not haystack or len(needle) < 3:
        return False
    return re.search(rf"\b{re.escape(needle)}\b", haystack, re.IGNORECASE) is not None


def score_event_against_project(event: dict, project: dict) -> tuple[float, list[str]]:
    title = event.get("title", "") or ""
    desc = event.get("description", "") or ""
    blob = f"{title}\n{desc}"

    name = project.get("name", "")
    pid = project.get("id", "")
    tags = project.get("tags", []) or []

    score = 0.0
    reasons = []

    if name and text_contains(name, title):
        score = max(score, 1.0)
        reasons.append("name in title")
    if pid and text_contains(pid, title):
        score = max(score, 0.9)
        reasons.append("id in title")
    if name and text_contains(name, desc):
        score = max(score, 0.6)
        reasons.append("name in description")

    for tag in tags:
        if tag and len(tag) > 3 and text_contains(tag, blob):
            score = max(score, 0.5)
            reasons.append(f"tag '{tag}' matched")
            break

    # Deadline-keyword combo: requires both a deadline word AND some project signal
    if DEADLINE_KEYWORDS.search(blob):
        if name and (text_contains(name, blob) or pid in blob.lower()):
            score = max(score, 0.7)
            if "deadline-keyword + project signal" not in reasons:
                reasons.append("deadline-keyword + project signal")

    return score, reasons


def match_events(events: list[dict], projects: list[dict]) -> dict:
    matches: list[dict] = []
    unmatched: list[dict] = []

    for ev in events:
        best = (0.0, None, [])
        for proj in projects:
            score, reasons = score_event_against_project(ev, proj)
            if score > best[0]:
                best = (score, proj, reasons)

        score, proj, reasons = best
        if score >= MATCH_THRESHOLD and proj:
            matches.append({
                "project_id": proj["id"],
                "event_id":   ev.get("id", ""),
                "event_title": ev.get("title", ""),
                "date":       ev.get("start", ""),
                "score":      round(score, 2),
                "confidence": "high" if score >= HIGH_CONFIDENCE else "low",
                "reasons":    reasons,
            })
        else:
            unmatched.append({
                "event_id":   ev.get("id", ""),
                "title":      ev.get("title", ""),
                "date":       ev.get("start", ""),
                "best_score": round(score, 2),
                "best_project": proj["id"] if proj else None,
            })

    return {
        "version":   "1.0",
        "last_match": datetime.now().isoformat(timespec="seconds"),
        "matches":    matches,
        "unmatched":  unmatched,
    }


def write_output(result: dict) -> Path:
    Cockpit.write_json(DEADLINES_JSON, result)
    return DEADLINES_JSON


def sample_events() -> list[dict]:
    """Generate synthetic events for testing the matcher."""
    today = datetime.now().date()
    return [
        {"id": "ev1",
         "title": "Tortunabo demo entrega final",
         "description": "Entrega del proyecto Tortunabo en clase de PROGRAM_A",
         "start": (today + timedelta(days=18)).isoformat()},
        {"id": "ev2",
         "title": "Examen FIAV - Física e IA",
         "description": "Examen final de la asignatura",
         "start": (today + timedelta(days=10)).isoformat()},
        {"id": "ev3",
         "title": "Practica entrega OrbitalDB",
         "description": "Subir el APK final con la practica de OrbitalDB",
         "start": (today + timedelta(days=4)).isoformat()},
        {"id": "ev4",
         "title": "Cita medico",
         "description": "Revision rutina",
         "start": (today + timedelta(days=2)).isoformat()},
        {"id": "ev5",
         "title": "Demo Niajska deadline",
         "description": "Mostrar landing page completa",
         "start": (today + timedelta(days=21)).isoformat()},
    ]


def main():
    p = argparse.ArgumentParser(description="Calendar -> projects deadline matcher")
    p.add_argument("--events", help="Path to JSON file with events array")
    p.add_argument("--stdin", action="store_true", help="Read events JSON array from stdin")
    p.add_argument("--sample", action="store_true", help="Use synthetic events for testing")
    p.add_argument("--print", action="store_true", help="Print current deadlines.json")
    args = p.parse_args()

    if args.print:
        if DEADLINES_JSON.exists():
            print(DEADLINES_JSON.read_text(encoding="utf-8-sig"))
        else:
            print("(no deadlines.json yet)")
        return 0

    projects = load_projects()
    if not projects:
        print("[calendar] No projects registered. Run scan_projects.py first.", file=sys.stderr)
        return 1

    events: list[dict]
    if args.sample:
        events = sample_events()
        print(f"[calendar] Using {len(events)} sample events")
    elif args.stdin:
        events = json.load(sys.stdin)
    elif args.events:
        events = json.loads(Path(args.events).read_text(encoding="utf-8-sig"))
    else:
        print("[calendar] No input. Use --events <file>, --stdin, --sample or --print",
              file=sys.stderr)
        return 1

    result = match_events(events, projects)
    out_path = write_output(result)

    matches = result["matches"]
    print(f"[calendar] Wrote {out_path}")
    print(f"[calendar] Matched: {len(matches)} | unmatched: {len(result['unmatched'])}")
    for m in matches:
        conf = m["confidence"]
        print(f"  [{conf:<4}] {m['date']} -> {m['project_id']:<28} (score={m['score']}) :: {m['event_title'][:60]}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
