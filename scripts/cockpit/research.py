#!/usr/bin/env python3
"""
ULTRON v10.1 Cockpit - Research via Gemini CLI.

Replaces (or complements) the RSS scraper for deep weekly research.
Uses gemini CLI directly (no API) to leverage Gemini 3.1 Pro's 2M context
window + native Google Search integration for rich AI news research.

Usage:
    ultron research                # default: weekly digest, ~12 items
    ultron research --topic X      # focused research on specific topic
    ultron research --priority     # only user priority keywords

Output: ~/.ultron/cockpit/news/research-YYYY-MM-DD.md

Cost note: each call ~5-10K Gemini Pro tokens. Cron weekly Sunday 19:00 by default,
manual trigger from TUI (key 'r' in News view) or `ultron research`.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import NEWS_DIR  # noqa: E402


def find_gemini_cli() -> str | None:
    """Locate gemini CLI: PATH first, then %APPDATA%\\npm fallback for Windows global install."""
    found = shutil.which("gemini")
    if found:
        return found
    # Windows npm global install
    npm_dir = Path(os.environ.get("APPDATA", "")) / "npm"
    if npm_dir.exists():
        for ext in (".cmd", ".ps1", ".exe", ""):
            candidate = npm_dir / f"gemini{ext}"
            if candidate.exists():
                return str(candidate)
    return None


PRIORITY_TOPICS = [
    "Claude Opus 4.7", "Claude Mythos", "Anthropic announcements",
    "GPT 5.5", "OpenAI Codex CLI", "OpenAI new releases",
    "Gemini 3.1 Pro", "Gemini 3.1 Flash", "Google AI new releases",
    "MCP protocol updates", "Claude Skills", "AI model regressions",
]


def build_research_prompt(topic: str | None, priority_only: bool) -> str:
    """Construct the prompt sent to Gemini for research."""
    today = datetime.now().strftime("%Y-%m-%d")

    if topic:
        focus = f"the specific topic: '{topic}'"
    elif priority_only:
        focus = "ONLY these specific topics:\n- " + "\n- ".join(PRIORITY_TOPICS)
    else:
        focus = "the AI/LLM industry with PRIORITY on these topics:\n- " + \
                "\n- ".join(PRIORITY_TOPICS) + "\n\nAlso cover other major releases or regressions."

    return f"""You are an AI industry researcher. Today is {today}.

Search the web for the most important news from the LAST 7 DAYS about {focus}

Output a STRUCTURED MARKDOWN digest with EXACTLY this format (no preamble, no afterword):

# AI Research Digest - {today}

## TL;DR (3 bullets max)
- {{1-line punchy summary of the week}}
- {{2nd most important takeaway}}
- {{3rd takeaway, optional}}

## Top items (max 12, ordered by importance)

### 1. {{Headline}}
- **Source:** {{publication name}}
- **Date:** {{YYYY-MM-DD}}
- **URL:** {{full URL}}
- **What:** {{2-3 lines, factual, no fluff}}
- **Impact for the user's stack:** {{1 line: how this affects Claude/Codex/Gemini setup, or "neutral" if no impact}}

### 2. ...

## Breaking changes (deprecations / regressions / API breaks)
- {{item 1 if any, else "None this week"}}

## Sources consulted
{{Bullet list of all URLs you visited}}

RULES:
- Be SPECIFIC. No "various sources reported X". Cite the publisher.
- Skip drama, rumors, "user said". Only confirmed releases / posts / benchmarks.
- If <5 high-quality items found, output fewer rather than padding.
- Output ONLY the markdown. No "Here is your digest:" preamble.
"""


def run_gemini_research(prompt: str, model: str = "pro", verbose: bool = False) -> str | None:
    """Invoke gemini CLI with the research prompt. Returns the digest markdown or None."""
    # v10.4.7 fix: gemini.CMD wrapper truncaba prompts largos / perdía flags.
    # Mismo bug que arreglé en gemini-duet.ps1 con node.exe + gemini.js + stdin.
    # Patrón: invoke node.exe directly + pass prompt via stdin redirect.
    node_exe = r"C:\Program Files\nodejs\node.exe"
    if not Path(node_exe).exists():
        node_alt = shutil.which("node")
        if not node_alt:
            print("[research] ERROR: node.exe not found")
            return None
        node_exe = node_alt
    gemini_js = Path(os.environ.get("APPDATA", "")) / "npm" / "node_modules" / "@google" / "gemini-cli" / "bundle" / "gemini.js"
    if not gemini_js.exists():
        print(f"[research] ERROR: gemini.js not found at {gemini_js}")
        print("[research] Install: npm i -g @google/gemini-cli")
        return None

    if verbose:
        print(f"[research] Using node: {node_exe}")
        print(f"[research] Using gemini.js: {gemini_js}")
        print(f"[research] Invoking -m {model} (this may take 30-90s)...")

    # Write prompt to tempfile, pass via stdin
    import tempfile
    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".txt",
                                       delete=False, encoding="utf-8")
    tmp.write(prompt)
    tmp.close()
    try:
        # `--prompt= ` (with space) triggers headless; stdin provides full content.
        # Avoids Windows argv limits + .CMD wrapper truncation.
        cmd = [node_exe, str(gemini_js),
               "--prompt= ",
               "-m", model,
               "--approval-mode", "yolo",
               "-o", "json", "--skip-trust"]
        with open(tmp.name, "r", encoding="utf-8") as fin:
            result = subprocess.run(cmd, stdin=fin, capture_output=True,
                                     text=True, encoding="utf-8", timeout=240,
                                     creationflags=_WIN_HIDDEN)
    except subprocess.TimeoutExpired:
        print("[research] ERROR: gemini timed out after 240s")
        try: Path(tmp.name).unlink()
        except OSError: pass
        return None
    except Exception as e:
        print(f"[research] ERROR: gemini invocation failed: {e}")
        try: Path(tmp.name).unlink()
        except OSError: pass
        return None
    finally:
        try: Path(tmp.name).unlink()
        except (OSError, NameError): pass

    if result.returncode != 0:
        print(f"[research] gemini returned exit {result.returncode}")
        if result.stderr:
            print(f"[research] stderr: {result.stderr[:500]}")
        return None

    # v10.4.5 fix: gemini JSON output is multi-line and prefixed by
    # "Skill X is overriding..." pollution. Find first '{', parse from there
    # until matching closing '}' (depth tracking).
    raw = result.stdout or ""
    first_brace = raw.find("{")
    if first_brace < 0:
        print("[research] ERROR: gemini stdout has no JSON")
        if verbose:
            print(f"[research] raw stdout: {raw[:500]}")
        return None
    payload = raw[first_brace:]
    # Walk to find matching closing brace
    depth = 0
    end = -1
    in_string = False
    escape = False
    for i, ch in enumerate(payload):
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
                end = i + 1
                break
    if end > 0:
        payload = payload[:end]
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as e:
        print(f"[research] ERROR: cannot parse gemini JSON: {e}")
        if verbose:
            print(f"[research] payload start: {payload[:400]}")
        return None

    response = data.get("response", "")
    # Strip optional code fences
    response = re.sub(r"^```(?:markdown)?\s*", "", response.strip())
    response = re.sub(r"\s*```$", "", response)

    # Token usage report
    try:
        models_dict = data.get("stats", {}).get("models", {})
        if models_dict and verbose:
            for model_name, stats in models_dict.items():
                tokens = stats.get("tokens", {})
                print(f"[research] tokens: in={tokens.get('input', '?')} "
                      f"out={tokens.get('candidates', '?')} "
                      f"thoughts={tokens.get('thoughts', '?')}")
    except Exception:
        pass

    return response or None


def write_digest(content: str) -> Path:
    NEWS_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")
    out = NEWS_DIR / f"research-{today}.md"
    out.write_text(content, encoding="utf-8")
    return out


def main():
    p = argparse.ArgumentParser(
        description="ULTRON Cockpit research via Gemini CLI",
        epilog="Tip: --topic accepts multi-word without quotes: ultron research --topic Opus 4.7"
    )
    p.add_argument("--topic", nargs="+",
                   help="Focus topic. Accepts multiple words: --topic Opus 4.7")
    p.add_argument("--priority", action="store_true",
                   help="Restrict to priority keywords only")
    p.add_argument("--model", default="pro", choices=["pro", "flash", "auto"])
    p.add_argument("--print", action="store_true",
                   help="Print today's research if it exists, don't re-run")
    p.add_argument("--from-cron", action="store_true",
                   help="(Internal) Marker that this run came from Task Scheduler. "
                        "Triggers weekly skip-guard. Manual runs always execute.")
    p.add_argument("--verbose", "-v", action="store_true")
    args = p.parse_args()

    # Join multi-word topic
    topic_str = " ".join(args.topic) if args.topic else None

    today = datetime.now().strftime("%Y-%m-%d")
    out = NEWS_DIR / f"research-{today}.md"

    if args.print:
        if out.exists():
            print(out.read_text(encoding="utf-8"))
        else:
            print(f"(no research for {today}; run without --print)")
        return 0

    # Weekly guard ONLY when invoked from cron (--from-cron flag set by Task Scheduler).
    # Manual `ultron research` always executes - that's the user's intent.
    if args.from_cron:
        from should_run import should_run_this_week
        if not should_run_this_week("research", weekday_target=6):
            print("[research] Cron skip (not Sunday yet, or already ran this week).")
            return 0

    print(f"[research] Generating research digest for {today}")
    print(f"[research] Model: gemini {args.model}, topic: {topic_str or '(weekly default)'}")

    prompt = build_research_prompt(topic_str, args.priority)
    digest = run_gemini_research(prompt, model=args.model, verbose=args.verbose)

    if not digest:
        print("[research] FAILED: no digest produced")
        return 1

    path = write_digest(digest)
    print(f"[research] Wrote {path} ({path.stat().st_size} bytes)")
    if args.from_cron:
        from should_run import mark_ran_today
        mark_ran_today("research")
    return 0


if __name__ == "__main__":
    sys.exit(main())
