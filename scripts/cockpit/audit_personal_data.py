#!/usr/bin/env python3
# === maintainer-only (not user-facing) ===
# Pre-publish leakage scanner. No runtime hook / control-center / health
# caller — only invoked manually before cutting a public release. See
# docs/MAINTAINERS.md.
"""audit_personal_data.py — find every Rodrigo-personal reference in the public repo.

Scans EVERY tracked file (git ls-files) for:
- The author's first/last name in any case
- His specific home path (C:\\Users\\Rodrigo and POSIX variants)
- His email + LinkedIn URL (allowed only in AUTHORS, README footer, NOTICE)
- His personal handles / aliases
- His personal config keys (own news feeds, own stock tickers)
- His own persona / agent names (alfred, einstein, jordan, ...)

Output: a Markdown report at ~/.ultron/.tmp/personal-data-audit.md and a summary
to stdout. Returns exit code 1 if any HIGH finding exists (so CI can gate on it).

By default it scans only the working HEAD (git ls-files). Use --history to scan
EVERY blob in the whole git history (git rev-list --all) — this is the
pre-transfer gate: a file scrubbed from HEAD but still reachable with
`git show <old-sha>` would leak to anyone who clones the repo, and the HEAD scan
cannot see it. (maintainer-only, like --strict.)

Usage:
    uv run python scripts/cockpit/audit_personal_data.py
    uv run python scripts/cockpit/audit_personal_data.py --strict    # exit 1 on MEDIUM too
    uv run python scripts/cockpit/audit_personal_data.py --history   # scan ALL git history
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Files where Rodrigo's name + LinkedIn URL are INTENTIONAL — author attribution.
ALLOWED_FILES = {
    "AUTHORS.md",
    "NOTICE",
    "LICENSE",
    "README.md",
    "README.es.md",
    "CHANGELOG.md",          # historical entries reference the author name; new entries must not
    "SECURITY.md",
    "control-center/src-tauri/Cargo.toml",
    "pyproject.toml",
    # v15.5.15 (eval-2 R2): the scanner itself contains every pattern by
    # construction — exclude it so a clean tree exits 0. Same for the
    # leakage-sweep report and the eval-2 markdown (they cite findings
    # verbatim). And docs/MAINTAINERS.md describes the scanner's purpose.
    "scripts/cockpit/audit_personal_data.py",
    "docs/MAINTAINERS.md",
    ".tmp/evals/eval-2-personal-info-leak.md",
    ".tmp/evals/round2/eval-2-personal-info-leak.md",
    ".tmp/evals/round2-leakage-sweep.md",
    # v15.5.20 (eval-1 R5): ULTRA-SWEEP-SUMMARY.md removed from git (was a
    # PII dump that the allowlist laundered). File untracked + content scrubbed.
    # These two Rust files contain LITERAL comments documenting the v15.4 fix
    # that REMOVED a hardcoded "rodrigo@local" string — leaving the comment
    # documents the audit trail and is correct historical record.
    "control-center/src-tauri/src/agents.rs",
    "control-center/src-tauri/src/skills.rs",
}

# Allowed personal-persona name list (his named characters) — flagged HIGH
# anywhere they appear outside of vault / personal areas.
PERSONAL_PERSONAS = [
    "alfred",
    "einstein",
    "jordan-belfort",
    "mike-tyson",
    "novalbos",
    "pana",
    "tio-gilito",
    "tolkien",
    "warren",
    "don-claudio",
    "terry-davis",
    "kirkardo",
]

# Severity buckets.
HIGH_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # v15.5.20 (eval-1 R5): regex tightened to also catch underscore-adjacent
    # matches (e.g. `rodrigo_signal`). Word-boundary `\b` does not separate
    # letters from underscores, so the prior `\bRodrigo\b` missed those.
    ("rodrigo-name",        re.compile(r"(?<![A-Za-z0-9])rodrigo(?![A-Za-z0-9])", re.IGNORECASE)),
    ("fernandez-surname",   re.compile(r"\bFern[áa]ndez\b", re.IGNORECASE)),
    ("personal-home-win",   re.compile(r"C:[\\/]+Users[\\/]+Rodrigo\b", re.IGNORECASE)),
    ("personal-home-posix", re.compile(r"/home/rodrigo\b", re.IGNORECASE)),
    # SkiTemplar is the public GitHub org name and appears legitimately in every
    # installer URL — it is NOT a leak.
    # NOTE: the personal account handle + email are real PII that must NOT be
    # hardcoded in this public script (it ships in the public repo so the CI gate
    # can run). They are loaded at runtime from ULTRON_PII_EXTRA (see below);
    # a public clone without that env var simply skips those two checks.
    ("linkedin-personal",   re.compile(r"linkedin\.com/in/rodrigo-fern", re.IGNORECASE)),
    # v15.5.20 (eval-1 R5): private internal vocabulary the maintainer never
    # intends in public artefacts.
    ("uni-credential",      re.compile(r"\bU-?tad\b|\bPDVJ\b|\bPRGR\b", re.IGNORECASE)),
    ("real-madrid-leak",    re.compile(r"\breal[._\s-]?madrid\b", re.IGNORECASE)),
    ("goodnight-commit",    re.compile(r"GOODNIGHT\s+mega-?commit", re.IGNORECASE)),
    ("eval-internal",       re.compile(r"\beval-\d+\s+R\d\b")),
]

# Extra HIGH literals supplied at runtime via ULTRON_PII_EXTRA (comma-separated).
# Keeps real PII (personal email/handle) OUT of this public script: the
# maintainer exports the var locally (or as a CI secret) to enable those checks;
# absent the var, only the generic name/path patterns above run. Each token is
# matched as a case-insensitive literal.
for _i, _tok in enumerate(
    t.strip() for t in os.environ.get("ULTRON_PII_EXTRA", "").split(",") if t.strip()
):
    HIGH_PATTERNS.append((f"personal-extra-{_i}", re.compile(re.escape(_tok), re.IGNORECASE)))

MEDIUM_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("persona-name", re.compile(
        r"\b(" + "|".join(re.escape(n) for n in PERSONAL_PERSONAS) + r")\b",
        re.IGNORECASE,
    )),
    ("rodrigo-stack", re.compile(r"Rodrigo'?s? (?:tech|own)? ?(?:stack|voice|preferences|setup)",
                                  re.IGNORECASE)),
    ("personal-vault", re.compile(r"\.ultron-vault\b|ultron-vault/", re.IGNORECASE)),
]

# File patterns to skip entirely (binary / generated / vault).
SKIP_PATH_PARTS = {
    ".git", "node_modules", "target", ".venv", "__pycache__", "dist", "build",
    ".uv-cache-rescue", "qdrant_storage", "backups", ".pytest_cache",
}

BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".pdf",
    ".zip", ".tar", ".gz", ".7z",
    ".exe", ".dll", ".so", ".dylib", ".a", ".lib",
    ".woff", ".woff2", ".ttf", ".otf",
    ".db", ".sqlite", ".sqlite3", ".wal",
    ".pyd", ".pyc", ".pyo",
}


def tracked_files() -> list[Path]:
    """git ls-files (HEAD) — only files actually committed to the repo."""
    try:
        out = subprocess.check_output(
            ["git", "-C", str(REPO_ROOT), "ls-files"],
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return []
    return [Path(line.strip()) for line in out.splitlines() if line.strip()]


def is_skippable(path: Path) -> bool:
    if path.suffix.lower() in BINARY_EXT:
        return True
    parts_lower = {p.lower() for p in path.parts}
    return bool(parts_lower & SKIP_PATH_PARTS)


def is_allowed(relpath: str) -> bool:
    norm = relpath.replace("\\", "/")
    return norm in ALLOWED_FILES


def scan() -> dict[str, list[tuple[str, int, str, str]]]:
    """Returns {severity: [(file, line_no, pattern_name, snippet), ...]}."""
    findings: dict[str, list[tuple[str, int, str, str]]] = defaultdict(list)

    for relpath in tracked_files():
        abs_path = REPO_ROOT / relpath
        if is_skippable(relpath):
            continue
        if is_allowed(str(relpath)):
            continue
        try:
            text = abs_path.read_text(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            continue

        for line_no, line in enumerate(text.splitlines(), start=1):
            for pat_name, pat in HIGH_PATTERNS:
                if pat.search(line):
                    findings["HIGH"].append(
                        (str(relpath).replace("\\", "/"), line_no, pat_name, line.strip()[:200])
                    )
            for pat_name, pat in MEDIUM_PATTERNS:
                if pat.search(line):
                    findings["MEDIUM"].append(
                        (str(relpath).replace("\\", "/"), line_no, pat_name, line.strip()[:200])
                    )

    return findings


def history_blobs() -> dict[str, list[str]]:
    """Map blob_sha -> [paths] across ALL git history (git rev-list --all --objects).

    `rev-list --all --objects` lists every object reachable from any ref, one per
    line as "<sha> <path>" (commits have no path and are filtered out). The same
    content committed under several paths shares one sha, so deduping by sha means
    each unique blob is scanned exactly once regardless of how many commits touched it.
    """
    try:
        out = subprocess.check_output(
            ["git", "-C", str(REPO_ROOT), "rev-list", "--all", "--objects"],
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return {}
    blobs: dict[str, list[str]] = defaultdict(list)
    for line in out.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        sha, sep, path = stripped.partition(" ")
        if not sep:
            continue  # commit object — no path, skip
        blobs[sha].append(path)
    return blobs


def read_blobs_batch(shas: list[str]) -> dict[str, str]:
    """Read many objects at once via `git cat-file --batch` (one process, streamed).

    The batch protocol emits, per requested object, a header line
    "<sha> <type> <size>\\n" followed by <size> content bytes and a trailing "\\n".
    Non-blob objects (trees that slipped in) are consumed by size and discarded, so
    the stream parser never desyncs. Missing objects emit "<sha> missing\\n".
    """
    if not shas:
        return {}
    try:
        proc = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "cat-file", "--batch"],
            input=("\n".join(shas) + "\n").encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=600,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return {}

    out = proc.stdout
    result: dict[str, str] = {}
    i, n = 0, len(out)
    while i < n:
        nl = out.find(b"\n", i)
        if nl == -1:
            break
        header = out[i:nl].decode("utf-8", "replace").split(" ")
        i = nl + 1
        if len(header) == 3:
            sha, otype, size_s = header
            try:
                size = int(size_s)
            except ValueError:
                break
            content = out[i : i + size]
            i += size + 1  # skip the content and its trailing newline
            if otype == "blob":
                result[sha] = content.decode("utf-8", "replace")
        elif len(header) == 2 and header[1] in ("missing", "ambiguous"):
            continue
        else:
            break  # unexpected — stop rather than desync
    return result


def scan_history() -> dict[str, list[tuple[str, int, str, str]]]:
    """Scan every unique text blob reachable from any ref for PII patterns.

    Same severity buckets and allow/skip rules as the HEAD scan, but the source is
    the whole history. A blob scrubbed from HEAD is still found here (that is the
    point of the pre-transfer gate). Binary blobs are filtered by path extension
    BEFORE asking git for their content, so .exe/.db/.png history never loads.
    """
    findings: dict[str, list[tuple[str, int, str, str]]] = defaultdict(list)

    # Pick, per unique blob, a representative path that is neither binary nor allow-listed.
    want: dict[str, str] = {}
    for sha, paths in history_blobs().items():
        for path in paths:
            if is_skippable(Path(path)) or is_allowed(path):
                continue
            want[sha] = path
            break

    contents = read_blobs_batch(list(want.keys()))
    for sha, path in want.items():
        text = contents.get(sha)
        if text is None:
            continue
        label = f"{path}@{sha[:9]}"
        for line_no, line in enumerate(text.splitlines(), start=1):
            for pat_name, pat in HIGH_PATTERNS:
                if pat.search(line):
                    findings["HIGH"].append((label, line_no, pat_name, line.strip()[:200]))
            for pat_name, pat in MEDIUM_PATTERNS:
                if pat.search(line):
                    findings["MEDIUM"].append((label, line_no, pat_name, line.strip()[:200]))

    return findings


def render(
    findings: dict[str, list[tuple[str, int, str, str]]],
    scope: str = "every `git ls-files` entry (HEAD)",
) -> str:
    lines: list[str] = []
    lines.append("# Personal Data Audit")
    lines.append("")
    lines.append("Generated by `scripts/cockpit/audit_personal_data.py`.")
    lines.append(f"Scans {scope} for Rodrigo-personal references.")
    lines.append("Allow-list: " + ", ".join(sorted(ALLOWED_FILES)))
    lines.append("")
    lines.append(f"- **HIGH:** {len(findings.get('HIGH', []))} findings")
    lines.append(f"- **MEDIUM:** {len(findings.get('MEDIUM', []))} findings")
    lines.append("")

    for severity in ("HIGH", "MEDIUM"):
        hits = findings.get(severity, [])
        if not hits:
            continue
        lines.append(f"## {severity}")
        lines.append("")
        by_file: dict[str, list[tuple[int, str, str]]] = defaultdict(list)
        for f, ln, pat, snippet in hits:
            by_file[f].append((ln, pat, snippet))
        for f in sorted(by_file):
            lines.append(f"### `{f}` ({len(by_file[f])} hits)")
            for ln, pat, snippet in sorted(by_file[f])[:20]:
                lines.append(f"- L{ln} [{pat}] `{snippet}`")
            if len(by_file[f]) > 20:
                lines.append(f"- … +{len(by_file[f]) - 20} more")
            lines.append("")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true",
                        help="exit 1 on MEDIUM findings too (default: only HIGH)")
    parser.add_argument("--history", action="store_true",
                        help="scan ALL git history (git rev-list --all), not just HEAD "
                             "— pre-transfer gate for scrubbed-but-reachable PII")
    parser.add_argument("--out", type=Path,
                        default=Path.home() / ".ultron" / ".tmp" / "personal-data-audit.md")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if args.history:
        findings = scan_history()
        report = render(findings, scope="ALL git history (`git rev-list --all`)")
    else:
        findings = scan()
        report = render(findings)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(report, encoding="utf-8", newline="\n")

    high = len(findings.get("HIGH", []))
    medium = len(findings.get("MEDIUM", []))
    scope_tag = "history" if args.history else "head"
    print(f"[audit-personal-data] scope={scope_tag} HIGH={high} MEDIUM={medium}")
    print(f"[audit-personal-data] report: {args.out}")

    if high > 0:
        return 1
    if medium > 0 and args.strict:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
