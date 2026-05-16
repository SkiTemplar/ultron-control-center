"""ULTRON Cockpit — verify [verify: ...] claims embedded in critical docs.

Scans configured docs for lines containing:
    [verify: <shell-command>]              # exit 0 = PASS
    [verify: <cmd>] [expect: <regex>]      # stdout regex match required

Executes each command (Windows shell), captures stdout/stderr, reports
PASS/FAIL/WARN with the first line of evidence. Read-only: never modifies docs.

Usage:
    ultron verify                      # run all configured docs
    ultron verify --json               # machine-readable output
    ultron verify --doc <path>         # only this file
    ultron verify --strict             # exit 1 if any FAIL/WARN
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

HOME = Path.home()
DEFAULT_DOCS = [
    HOME / ".ultron" / "SYSTEM-MAP.md",
    HOME / ".ultron-vault" / "00_INDEX" / "_packets" / "system-state.md",
    HOME / ".ultron-vault" / "00_INDEX" / "_packets" / "system-map.md",
]

CLAIM_RE = re.compile(
    r"\[verify:\s*(?P<cmd>.+?)\](?:\s*\[expect:\s*(?P<expect>.+?)\])?",
)
TIMEOUT_S = 20


@dataclass
class Result:
    doc: str
    line: int
    claim_preview: str
    command: str
    expect: str
    status: str  # PASS / FAIL / WARN / ERROR
    evidence: str
    exit_code: int


def _shorten(s: str, n: int) -> str:
    s = s.strip().splitlines()[0] if s.strip() else ""
    return s[:n] + ("…" if len(s) > n else "")


def run_one(cmd: str, expect_re: str | None) -> tuple[str, str, int]:
    """Returns (status, evidence_first_line, exit_code)."""
    try:
        proc = subprocess.run(
            cmd, shell=True, capture_output=True, text=True,
            timeout=TIMEOUT_S, encoding="utf-8", errors="replace",
        )
    except subprocess.TimeoutExpired:
        return "ERROR", f"timeout after {TIMEOUT_S}s", -1
    except OSError as e:
        return "ERROR", f"OS error: {e}", -1

    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()
    evidence = _shorten(stdout or stderr, 80)

    if expect_re:
        try:
            if re.search(expect_re, stdout, re.IGNORECASE | re.MULTILINE):
                return "PASS", evidence, proc.returncode
            return "FAIL", f"no match for /{expect_re}/ — got: {evidence}", proc.returncode
        except re.error as e:
            return "ERROR", f"bad regex /{expect_re}/: {e}", proc.returncode

    if proc.returncode == 0:
        return "PASS", evidence or "(empty stdout, exit 0)", 0
    return "FAIL", f"exit {proc.returncode} — {evidence}", proc.returncode


def scan_doc(path: Path) -> list[Result]:
    if not path.exists():
        return [Result(str(path), 0, "(file missing)", "", "", "ERROR",
                       "doc not found", -1)]
    out: list[Result] = []
    for n, raw in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        for m in CLAIM_RE.finditer(raw):
            cmd = m.group("cmd").strip()
            expect = (m.group("expect") or "").strip()
            # Strip the [verify:...] suffix for preview
            preview = CLAIM_RE.sub("", raw).strip()
            preview = _shorten(preview.lstrip("-").lstrip("*").strip(), 60)
            status, evidence, code = run_one(cmd, expect or None)
            out.append(Result(
                doc=str(path.relative_to(HOME)) if path.is_absolute() and HOME in path.parents else str(path),
                line=n, claim_preview=preview, command=cmd,
                expect=expect, status=status, evidence=evidence, exit_code=code,
            ))
    return out


STATUS_ICON = {"PASS": "✅", "FAIL": "❌", "WARN": "⚠ ", "ERROR": "💥"}


def render_table(results: list[Result]) -> str:
    if not results:
        return "(no [verify: ...] claims found)"
    rows = ["STATUS  DOC                                          L#    CLAIM"]
    rows.append("-" * 100)
    for r in results:
        icon = STATUS_ICON.get(r.status, "? ")
        doc = (r.doc or "")[-44:]
        rows.append(f"{icon} {r.status:<5}  {doc:<44}  L{r.line:<4}  {r.claim_preview}")
        rows.append(f"          $ {r.command}")
        rows.append(f"          → {r.evidence}")
    rows.append("")
    counts = {"PASS": 0, "FAIL": 0, "WARN": 0, "ERROR": 0}
    for r in results:
        counts[r.status] = counts.get(r.status, 0) + 1
    rows.append(f"Summary: ✅ {counts['PASS']}  ❌ {counts['FAIL']}  ⚠ {counts['WARN']}  💥 {counts['ERROR']}")
    return "\n".join(rows)


def main():
    p = argparse.ArgumentParser(prog="ultron verify", description=__doc__.split("\n")[0])
    p.add_argument("--json", action="store_true", help="JSON output")
    p.add_argument("--doc", action="append", help="path to a specific doc (repeatable)")
    p.add_argument("--strict", action="store_true",
                   help="exit 1 if any FAIL/ERROR")
    args = p.parse_args()

    # Force UTF-8 stdout on Windows so icons render
    if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    docs = [Path(d) for d in args.doc] if args.doc else DEFAULT_DOCS
    results: list[Result] = []
    for d in docs:
        results.extend(scan_doc(d))

    if args.json:
        print(json.dumps([asdict(r) for r in results], indent=2, ensure_ascii=False))
    else:
        print(render_table(results))

    if args.strict and any(r.status in ("FAIL", "ERROR") for r in results):
        sys.exit(1)


if __name__ == "__main__":
    main()
