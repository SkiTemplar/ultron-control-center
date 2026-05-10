"""ULTRON v14.4 TOKEN HUNTER — Phase 3 MEMORY.md dedup.

Detects facts in `~/.ultron/MEMORY.md` that duplicate content in two read-only
canonical sources (`~/.claude/CLAUDE.md`, `~/.ultron/.tmp/context.md`) and emits
a removal proposal. Only edits MEMORY.md (the other two are user-owned or
auto-regenerated).

Detection levels:
  exact     — normalized line match (case + punctuation + whitespace folded)
  fuzzy     — difflib SequenceMatcher ratio >= --threshold (default 0.85)

Preserved markers:
  Any line containing the literal token `[INTENTIONAL-DUP]` is never proposed
  for removal even if it matches an external canonical line.

CLI:
  memory_dedupe.py status          # counts only
  memory_dedupe.py dryrun [--threshold T]   # proposal diff to stdout
  memory_dedupe.py apply  [--threshold T]   # write with .bak

Safety contract:
  * Atomic write (tempfile + os.replace) with .bak backup before any edit
  * CLAUDE.md and context.md are NEVER opened for write
  * Headers (lines starting with #) and code-fences (```) skipped from dedup
  * Empty MEMORY.md → noop
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import string
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


# ── Paths ──────────────────────────────────────────────────────────────────────


def _user_home() -> Path:
    return Path.home()


def _memory_md() -> Path:
    return _user_home() / ".ultron" / "MEMORY.md"


def _context_md() -> Path:
    return _user_home() / ".ultron" / ".tmp" / "context.md"


def _claude_md() -> Path:
    return _user_home() / ".claude" / "CLAUDE.md"


# ── Constants ──────────────────────────────────────────────────────────────────

DEFAULT_FUZZY_THRESHOLD = 0.85
INTENTIONAL_DUP_MARKER = "[INTENTIONAL-DUP]"
MIN_FACT_CHARS = 12  # ignore very short lines (greetings, table dividers, etc.)


# ── Fact extraction ────────────────────────────────────────────────────────────


@dataclass
class Fact:
    file_label: str
    line_no: int  # 1-based
    raw: str
    normalized: str

    def is_pinned(self) -> bool:
        return INTENTIONAL_DUP_MARKER in self.raw


_PUNCT_TABLE = str.maketrans(
    "", "", string.punctuation + "“”‘’«»·—–…"
)
_WS_RE = re.compile(r"\s+")


def normalize(text: str) -> str:
    """Lowercase + strip punctuation + collapse whitespace."""
    folded = text.lower().translate(_PUNCT_TABLE)
    return _WS_RE.sub(" ", folded).strip()


def parse_facts(path: Path, file_label: str) -> list[Fact]:
    """Split file into fact units. Skips headers, code fences, and short lines."""
    if not path.exists():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    facts: list[Fact] = []
    in_code = False
    for i, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped:
            continue
        # Toggle on code fence
        if stripped.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        if stripped.startswith("#"):
            continue
        if stripped.startswith("|") and stripped.endswith("|"):
            # Markdown table row — skip dividers and headers but keep data rows
            if set(stripped.replace("|", "").strip()) <= set("-: "):
                continue
        if len(stripped) < MIN_FACT_CHARS:
            continue
        facts.append(Fact(
            file_label=file_label,
            line_no=i,
            raw=line,
            normalized=normalize(stripped),
        ))
    return facts


# ── Duplicate detection ────────────────────────────────────────────────────────


@dataclass
class Match:
    target: Fact         # The MEMORY.md fact under review
    canonical: Fact      # The fact in CLAUDE.md / context.md it duplicates
    kind: str            # "exact" | "fuzzy"
    similarity: float


def find_duplicates(
    target_facts: Iterable[Fact],
    canonical_facts: Iterable[Fact],
    *,
    threshold: float = DEFAULT_FUZZY_THRESHOLD,
) -> list[Match]:
    canon_list = list(canonical_facts)
    if not canon_list:
        return []
    canon_by_norm: dict[str, Fact] = {}
    for f in canon_list:
        canon_by_norm.setdefault(f.normalized, f)

    matches: list[Match] = []
    for target in target_facts:
        if target.is_pinned():
            continue

        # Exact match
        if target.normalized in canon_by_norm:
            matches.append(Match(
                target=target,
                canonical=canon_by_norm[target.normalized],
                kind="exact",
                similarity=1.0,
            ))
            continue

        # Fuzzy match — best ratio across canon facts
        best: tuple[float, Fact | None] = (0.0, None)
        for canon in canon_list:
            ratio = difflib.SequenceMatcher(
                None, target.normalized, canon.normalized,
            ).ratio()
            if ratio > best[0]:
                best = (ratio, canon)
        if best[0] >= threshold and best[1] is not None:
            matches.append(Match(
                target=target,
                canonical=best[1],
                kind="fuzzy",
                similarity=best[0],
            ))
    return matches


# ── Diff generation ────────────────────────────────────────────────────────────


@dataclass
class DedupReport:
    target_path: str
    matches: list[Match]
    lines_to_remove: list[int]   # 1-based MEMORY.md line numbers
    chars_before: int
    chars_after: int

    def to_dict(self) -> dict:
        return {
            "target": self.target_path,
            "match_count": len(self.matches),
            "exact": sum(1 for m in self.matches if m.kind == "exact"),
            "fuzzy": sum(1 for m in self.matches if m.kind == "fuzzy"),
            "lines_to_remove": self.lines_to_remove,
            "chars_before": self.chars_before,
            "chars_after": self.chars_after,
            "char_savings": self.chars_before - self.chars_after,
        }


def build_report(
    target_path: Path = None,
    *,
    threshold: float = DEFAULT_FUZZY_THRESHOLD,
) -> DedupReport:
    target_path = target_path or _memory_md()
    target_facts = parse_facts(target_path, "MEMORY.md")
    canonical_facts = (
        parse_facts(_claude_md(), "CLAUDE.md")
        + parse_facts(_context_md(), "context.md")
    )
    matches = find_duplicates(
        target_facts, canonical_facts, threshold=threshold,
    )
    lines_to_remove = sorted({m.target.line_no for m in matches})

    text = target_path.read_text(encoding="utf-8") if target_path.exists() else ""
    chars_before = len(text)
    new_lines = [
        l for i, l in enumerate(text.splitlines(keepends=True), 1)
        if i not in set(lines_to_remove)
    ]
    chars_after = sum(len(l) for l in new_lines)
    return DedupReport(
        target_path=str(target_path),
        matches=matches,
        lines_to_remove=lines_to_remove,
        chars_before=chars_before,
        chars_after=chars_after,
    )


# ── Apply ──────────────────────────────────────────────────────────────────────


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


def apply_report(
    report: DedupReport,
    *,
    dry_run: bool = False,
) -> dict:
    target = Path(report.target_path)
    if not report.lines_to_remove:
        return {"noop": True, "reason": "no duplicates over threshold"}
    if dry_run:
        return {**report.to_dict(), "dry_run": True}

    text = target.read_text(encoding="utf-8")
    backup = target.with_suffix(target.suffix + ".bak")
    backup.write_text(text, encoding="utf-8")

    rm_set = set(report.lines_to_remove)
    new_text = "".join(
        l for i, l in enumerate(text.splitlines(keepends=True), 1)
        if i not in rm_set
    )
    _atomic_write(target, new_text)
    return {**report.to_dict(), "backup": str(backup), "applied": True}


# ── CLI helpers ────────────────────────────────────────────────────────────────


def _print_diff(report: DedupReport, limit: int = 40) -> None:
    print(f"target: {report.target_path}")
    print(
        f"matches: {len(report.matches)} "
        f"({sum(1 for m in report.matches if m.kind=='exact')} exact, "
        f"{sum(1 for m in report.matches if m.kind=='fuzzy')} fuzzy)"
    )
    print(
        f"chars: {report.chars_before:,} -> {report.chars_after:,} "
        f"(save {report.chars_before - report.chars_after:,})"
    )
    print(f"lines to remove: {len(report.lines_to_remove)}")
    print()
    for m in report.matches[:limit]:
        sim = f"{m.similarity*100:.0f}%"
        print(
            f"  [{m.kind:5s} {sim:>4s}] "
            f"L{m.target.line_no:>3d} -> {m.canonical.file_label}:L{m.canonical.line_no}"
        )
        print(f"      target:    {m.target.raw[:90]}")
        print(f"      canonical: {m.canonical.raw[:90]}")
    if len(report.matches) > limit:
        print(f"  ... +{len(report.matches) - limit} more")


def _cmd_status(args: argparse.Namespace) -> int:
    report = build_report(threshold=args.threshold)
    print(json.dumps(report.to_dict(), indent=2))
    return 0


def _cmd_dryrun(args: argparse.Namespace) -> int:
    report = build_report(threshold=args.threshold)
    _print_diff(report, limit=args.limit)
    return 0 if not report.matches else 1


def _cmd_apply(args: argparse.Namespace) -> int:
    report = build_report(threshold=args.threshold)
    out = apply_report(report, dry_run=False)
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="memory_dedupe.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_status = sub.add_parser("status", help="JSON summary, no diff")
    p_status.add_argument("--threshold", type=float, default=DEFAULT_FUZZY_THRESHOLD)
    p_status.set_defaults(func=_cmd_status)

    p_dry = sub.add_parser("dryrun", help="print diff proposal")
    p_dry.add_argument("--threshold", type=float, default=DEFAULT_FUZZY_THRESHOLD)
    p_dry.add_argument("--limit", type=int, default=40)
    p_dry.set_defaults(func=_cmd_dryrun)

    p_app = sub.add_parser("apply", help="apply diff to MEMORY.md (atomic +.bak)")
    p_app.add_argument("--threshold", type=float, default=DEFAULT_FUZZY_THRESHOLD)
    p_app.set_defaults(func=_cmd_apply)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
