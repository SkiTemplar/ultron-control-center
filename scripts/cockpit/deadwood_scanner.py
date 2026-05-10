#!/usr/bin/env python3
"""ULTRON v14 GENESIS — Deadwood Scanner (Phase 1, Stages 1-3).

Detects deprecated/dead fragments inside live source files. Three stages:

    Stage 1 — Sentinel scan.   Explicit @ULTRON-DEPRECATED:<ver> blocks with
                               required fields (reason, replaced-by,
                               remove-after). Promotes to BLOCKING once
                               remove-after < today.

    Stage 2 — Heuristic scan.  Regex patterns for "removed in v",
                               "DEPRECATED", "LEGACY -—", TODO-remove,
                               and _OLD/_DEAD/_UNUSED suffixes. Suppresses
                               matches inside Python triple-quoted spans.

    Stage 3 — Cross-reference. ultron.ps1 stub branches, settings.json
                               hook paths, health.py EXPECTED_SCRIPTS
                               drift, manifest vs disk.

Stages 4 (behavioural smoke) and 6 (doctor integration) are deferred to
later Genesis-14.1 phases.

Exit codes:
    0 — no findings, or only INFO findings.
    1 — at least one WARN finding.
    2 — at least one BLOCKING finding.

CLI
---
    python deadwood_scanner.py                    # scan defaults, stdout
    python deadwood_scanner.py --json             # also write JSON sidecar
    python deadwood_scanner.py --report           # also write markdown audit
    python deadwood_scanner.py --quiet            # exit code only
    python deadwood_scanner.py --roots P [P ...]  # custom scan roots
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~")))
ULTRON_HOME = _HOME / ".ultron"
CLAUDE_HOME = _HOME / ".claude"
SKILL_ROOT = CLAUDE_HOME / "skills" / "ultron"
COCKPIT_DIR = SKILL_ROOT / "scripts" / "cockpit"
HOOKS_SKILL_DIR = SKILL_ROOT / "hooks"
HOOKS_HOME_DIR = ULTRON_HOME / "hooks"

AUDIT_DIR = ULTRON_HOME / "audits"
TMP_JSON = ULTRON_HOME / ".tmp" / "deadwood.json"

# Cache-like dirs always skipped
_SKIP_DIRS = frozenset({
    ".git", "__pycache__", ".venv", "node_modules",
    "dist", "build", ".tmp", "fixtures",
})

# File extensions actually scanned for fragments
_SCAN_EXTS = frozenset({
    ".py", ".ps1", ".psm1", ".js", ".ts", ".sh",
    ".sql", ".yaml", ".yml", ".json",
})

# ---------------------------------------------------------------------------
# Sentinel grammar
# ---------------------------------------------------------------------------

_SENTINEL_OPEN = re.compile(
    r"^\s*(?:#|//|--)+\s*@ULTRON-DEPRECATED:(?P<version>[\w.\-]+)\s*$"
)
_SENTINEL_FIELD = re.compile(
    r"^\s*(?:#|//|--)+\s*"
    r"(?P<key>reason|replaced-by|remove-after|owner|severity)\s*:\s*"
    r"(?P<value>.+?)\s*$",
    re.IGNORECASE,
)
_SENTINEL_CLOSE = re.compile(
    r"^\s*(?:#|//|--)+\s*@ULTRON-DEPRECATED-END\s*$"
)

_REQUIRED_SENTINEL_FIELDS = frozenset({"reason", "replaced-by", "remove-after"})

# ---------------------------------------------------------------------------
# Heuristic patterns
# ---------------------------------------------------------------------------

_HEURISTICS = (
    ("removed_in_v",   re.compile(r"(?i)removed in v\d+\.\d+(?:\.\d+)?"),                "MED"),
    ("deprecated_word",re.compile(r"\bDEPRECATED\b(?!\s+INFO)"),                          "LOW"),
    ("legacy_marker",  re.compile(r"\bLEGACY\b\s*[—\-]"),                             "MED"),
    ("todo_remove",    re.compile(r"(?i)^\s*(?:#|//|--)+\s*TODO.*\b(?:remove|delete|drop)\b"), "MED"),
    ("dead_suffix",    re.compile(r"_(?:OLD|DEAD|UNUSED)\b"),                              "LOW"),
)

_SEVERITY_FROM_CONFIDENCE = {"HIGH": "warn", "MED": "warn", "LOW": "info"}

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class Finding:
    file: str
    line_start: int
    line_end: int
    kind: str              # "sentinel" | "heuristic" | "xref"
    severity: str          # "info" | "warn" | "blocking"
    pattern: str           # rule name
    snippet: str = ""
    fields: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Stage 1 — Sentinel scan
# ---------------------------------------------------------------------------


def _scan_sentinels(path: Path, lines: list[str]) -> list[Finding]:
    findings: list[Finding] = []
    open_at: int | None = None
    open_version: str | None = None
    open_fields: dict[str, str] = {}

    for i, line in enumerate(lines, 1):
        if open_at is None:
            m = _SENTINEL_OPEN.match(line)
            if m:
                open_at = i
                open_version = m.group("version")
                open_fields = {}
                continue
            # L1: stray close marker (no matching open) is a maintenance
            # smell — surface it so it doesn't quietly vanish.
            if _SENTINEL_CLOSE.match(line):
                findings.append(Finding(
                    file=str(path),
                    line_start=i,
                    line_end=i,
                    kind="sentinel",
                    severity="warn",
                    pattern="STRAY-DEPRECATED-END",
                    snippet="@ULTRON-DEPRECATED-END without matching open",
                ))
            continue

        # We are inside an open sentinel block
        if _SENTINEL_CLOSE.match(line):
            missing = sorted(_REQUIRED_SENTINEL_FIELDS - set(open_fields.keys()))
            severity = "info"
            if missing:
                severity = "warn"
            after = open_fields.get("remove-after")
            if after:
                try:
                    if datetime.fromisoformat(after.strip()) < datetime.now():
                        severity = "blocking"
                except ValueError:
                    severity = "warn"
            findings.append(Finding(
                file=str(path),
                line_start=open_at,
                line_end=i,
                kind="sentinel",
                severity=severity,
                pattern="ULTRON-DEPRECATED",
                snippet=lines[open_at - 1].strip()[:120],
                fields={"version": open_version, **open_fields,
                        "missing": missing},
            ))
            open_at = None
            open_version = None
            open_fields = {}
            continue

        mf = _SENTINEL_FIELD.match(line)
        if mf:
            open_fields[mf.group("key").lower()] = mf.group("value").strip()

    if open_at is not None:
        findings.append(Finding(
            file=str(path),
            line_start=open_at,
            line_end=len(lines),
            kind="sentinel",
            severity="warn",
            pattern="UNTERMINATED-DEPRECATED",
            snippet="open marker without matching @ULTRON-DEPRECATED-END",
            fields={"version": open_version},
        ))
    return findings


# ---------------------------------------------------------------------------
# Stage 2 — Heuristic scan
# ---------------------------------------------------------------------------


def _docstring_mask(lines: list[str]) -> list[bool]:
    """Per-line mask: True if line is inside a Python triple-quoted span.

    NOTE: Python-only by design. PowerShell here-strings (`@"..."@`) and
    JS template literals are NOT masked. Heuristic hit rate inside these
    constructs is empirically zero in this codebase, so the asymmetry is
    intentional.
    """
    mask = [False] * len(lines)
    in_doc = False
    for idx, line in enumerate(lines):
        # Count *non-overlapping* triple quotes on this line.
        triples = line.count('"""') + line.count("'''")
        if triples == 0:
            mask[idx] = in_doc
            continue
        # If we start inside a docstring, the first triple closes it.
        # Mark the line as inside (boundary belongs to the docstring).
        mask[idx] = True
        if triples % 2 == 1:
            in_doc = not in_doc
    return mask


def _sentinel_mask(lines: list[str]) -> list[bool]:
    """Per-line mask: True if the line is inside an @ULTRON-DEPRECATED block.

    Used to suppress heuristic noise inside fragments that are already
    explicitly annotated — the sentinel finding is the canonical signal.
    A stray close marker (no preceding open) is silently ignored here;
    the scan-sentinels pass surfaces it as STRAY-DEPRECATED-END.
    """
    mask = [False] * len(lines)
    open_at: int | None = None
    for idx, line in enumerate(lines):
        if open_at is None:
            if _SENTINEL_OPEN.match(line):
                open_at = idx
                mask[idx] = True
            continue
        mask[idx] = True
        if _SENTINEL_CLOSE.match(line):
            open_at = None
    return mask


def _scan_heuristics(path: Path, lines: list[str]) -> list[Finding]:
    findings: list[Finding] = []
    doc_mask = _docstring_mask(lines) if path.suffix == ".py" else None
    sent_mask = _sentinel_mask(lines)
    for i, line in enumerate(lines, 1):
        if sent_mask[i - 1]:
            continue
        if doc_mask is not None and doc_mask[i - 1]:
            continue
        for name, pat, conf in _HEURISTICS:
            if pat.search(line):
                findings.append(Finding(
                    file=str(path),
                    line_start=i,
                    line_end=i,
                    kind="heuristic",
                    severity=_SEVERITY_FROM_CONFIDENCE[conf],
                    pattern=name,
                    snippet=line.strip()[:120],
                    fields={"confidence": conf},
                ))
                break  # one finding per line is enough
    return findings


# ---------------------------------------------------------------------------
# Walk
# ---------------------------------------------------------------------------


def _iter_targets(roots: list[Path]) -> list[Path]:
    out: list[Path] = []
    seen: set[Path] = set()
    for root in roots:
        if not root.exists():
            continue
        if root.is_file():
            if root.suffix in _SCAN_EXTS:
                real = root.resolve()
                if real not in seen:
                    seen.add(real)
                    out.append(root)
            continue
        for p in root.rglob("*"):
            try:
                rel_parts = p.relative_to(root).parts
            except ValueError:
                continue
            if any(part in _SKIP_DIRS for part in rel_parts):
                continue
            if not p.is_file():
                continue
            if p.suffix not in _SCAN_EXTS:
                continue
            real = p.resolve()
            if real in seen:
                continue
            seen.add(real)
            out.append(p)
    out.sort(key=lambda x: str(x))
    return out


def _scan_one(path: Path) -> list[Finding]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    lines = text.splitlines()
    return _scan_sentinels(path, lines) + _scan_heuristics(path, lines)


# ---------------------------------------------------------------------------
# Stage 3 — Cross-reference graph
# ---------------------------------------------------------------------------


# M5: accept single-quoted, double-quoted, default, and * cases.
# Group 2 captures the case name; group 1 is the (optional) opening quote.
_PS1_CASE = re.compile(r'^\s*(["\']?)([\w-]+|default|\*)\1\s*\{')
_PS1_STUB = re.compile(r"removed in v\d+\.\d+", re.IGNORECASE)
_PS1_CASE_BODY_LOOKAHEAD = 20  # L3: name the magic number
_HELP_LINE = re.compile(
    r'^\s*Write-Host\s+"\s*([\w-]+)\b', re.IGNORECASE
)


def _xref_ultron_ps1(ps1_path: Path | None = None) -> list[Finding]:
    ps1 = ps1_path or (COCKPIT_DIR / "ultron.ps1")
    if not ps1.exists():
        return []
    text = ps1.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()

    cases: list[tuple[str, int]] = []
    seen: set[str] = set()
    for i, line in enumerate(lines, 1):
        m = _PS1_CASE.match(line)
        if m:
            name = m.group(2)
            if name not in seen:
                cases.append((name, i))
                seen.add(name)

    sent_mask = _sentinel_mask(lines)

    findings: list[Finding] = []
    for idx, (name, start) in enumerate(cases):
        next_start = cases[idx + 1][1] if idx + 1 < len(cases) else len(lines) + 1
        end = min(next_start - 1, start + _PS1_CASE_BODY_LOOKAHEAD)
        body = "\n".join(lines[start:end])
        if _PS1_STUB.search(body):
            wrapped = sent_mask[start - 1] if 0 <= start - 1 < len(sent_mask) else False
            findings.append(Finding(
                file=str(ps1),
                line_start=start,
                line_end=end,
                kind="xref",
                severity="info" if wrapped else "warn",
                pattern="STUB_DISPATCH",
                snippet=(f'switch case "{name}" stub (already sentinel-annotated)'
                         if wrapped else
                         f'switch case "{name}" body announces removal'),
                fields={"command": name, "sentinel_wrapped": wrapped},
            ))
    return findings


_QUOTED_TOKEN = re.compile(r'"([^"]+)"|\'([^\']+)\'')
_BARE_PATH_TOKEN = re.compile(r"([A-Za-z]:\\[^\s\"']+|/[^\s\"']+|~[^\s\"']*)")
_SCRIPT_SUFFIXES = frozenset({".py", ".ps1", ".sh", ".js", ".ts", ".cmd", ".bat"})


def _extract_path_candidates(cmd: str) -> list[str]:
    """Extract path-like tokens from a hook command.

    Quoted paths come first — they can contain spaces. After stripping
    those, the bare-path regex sweeps the remainder. Without this
    quoted-first pass, ``python "C:\\Program Files\\app.py"`` would be
    truncated at the space and produce a HOOK_PATH_MISSING false positive.
    """
    out: list[str] = []
    for m in _QUOTED_TOKEN.finditer(cmd):
        token = m.group(1) or m.group(2)
        if token and (("/" in token) or ("\\" in token)
                       or token.startswith("~")):
            out.append(token)
    stripped = _QUOTED_TOKEN.sub(" ", cmd)
    out.extend(_BARE_PATH_TOKEN.findall(stripped))
    return out


def _xref_settings_hooks(settings_path: Path | None = None) -> list[Finding]:
    settings = settings_path or (CLAUDE_HOME / "settings.json")
    if not settings.exists():
        return []
    try:
        cfg = json.loads(settings.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    findings: list[Finding] = []
    hooks_section = cfg.get("hooks", {})
    if not isinstance(hooks_section, dict):
        return []
    for event, matchers in hooks_section.items():
        if not isinstance(matchers, list):
            continue
        for entry in matchers:
            for hook in entry.get("hooks", []) if isinstance(entry, dict) else []:
                cmd = hook.get("command", "")
                for raw in _extract_path_candidates(cmd):
                    candidate = raw
                    if candidate.startswith("~"):
                        candidate = str(_HOME) + candidate[1:].replace("/", os.sep)
                    p = Path(candidate)
                    # Skip non-script paths (binaries, args)
                    if p.suffix.lower() not in _SCRIPT_SUFFIXES:
                        continue
                    if not p.exists():
                        findings.append(Finding(
                            file=str(settings),
                            line_start=0,
                            line_end=0,
                            kind="xref",
                            severity="blocking",
                            pattern="HOOK_PATH_MISSING",
                            snippet=f"{event}: {raw}",
                            fields={"event": event, "command": cmd},
                        ))
                        break
    return findings


def _xref_health_expected_scripts(health_path: Path | None = None,
                                   cockpit_dir: Path | None = None) -> list[Finding]:
    health = health_path or (COCKPIT_DIR / "health.py")
    cock = cockpit_dir or COCKPIT_DIR
    if not health.exists() or not cock.exists():
        return []
    text = health.read_text(encoding="utf-8", errors="replace")
    expected: set[str] = set()
    try:
        import ast
        tree = ast.parse(text)
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                names = [t.id for t in node.targets if isinstance(t, ast.Name)]
                if "EXPECTED_SCRIPTS" not in names:
                    continue
                value = node.value
                if isinstance(value, (ast.List, ast.Tuple, ast.Set)):
                    for elt in value.elts:
                        if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                            expected.add(elt.value)
                break
    except (SyntaxError, ValueError) as exc:
        # M4: don't silently return [] — surface the unparseability so a
        # broken health.py is visible to whoever runs the scanner.
        return [Finding(
            file=str(health),
            line_start=0,
            line_end=0,
            kind="xref",
            severity="warn",
            pattern="HEALTH_PY_UNPARSEABLE",
            snippet=f"ast.parse({health.name}) failed: {type(exc).__name__}: {exc}",
            fields={"error_type": type(exc).__name__},
        )]
    if not expected:
        return []
    # Helpers (`_foo.py`) and test files (`test_*.py`) are intentionally
    # absent from EXPECTED_SCRIPTS; they're not user-facing scripts.
    actual = {
        p.name for p in cock.glob("*.py")
        if p.is_file()
        and not p.name.startswith("_")
        and not p.name.startswith("test_")
    }
    missing_from_expected = sorted(actual - expected - {"__init__.py"})
    if not missing_from_expected:
        return []
    return [Finding(
        file=str(health),
        line_start=0,
        line_end=0,
        kind="xref",
        severity="warn",
        pattern="HEALTH_EXPECTED_SCRIPTS_DRIFT",
        snippet=f"{len(missing_from_expected)} cockpit scripts not declared in EXPECTED_SCRIPTS",
        fields={
            "missing_count": len(missing_from_expected),
            "sample": missing_from_expected[:10],
        },
    )]


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def run_scan(roots: list[Path]) -> list[Finding]:
    findings: list[Finding] = []
    for path in _iter_targets(roots):
        findings.extend(_scan_one(path))
    findings.extend(_xref_ultron_ps1())
    findings.extend(_xref_settings_hooks())
    findings.extend(_xref_health_expected_scripts())
    findings.sort(key=lambda f: (f.file, f.line_start, f.pattern))
    return findings


def exit_code(findings: list[Finding]) -> int:
    if any(f.severity == "blocking" for f in findings):
        return 2
    if any(f.severity == "warn" for f in findings):
        return 1
    return 0


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def _rel_to_home(p: str) -> str:
    try:
        return str(Path(p).relative_to(_HOME))
    except ValueError:
        return p


def render_markdown(findings: list[Finding]) -> str:
    by_sev: dict[str, list[Finding]] = {"blocking": [], "warn": [], "info": []}
    for f in findings:
        by_sev.setdefault(f.severity, []).append(f)
    lines = [
        f"# Deadwood Scanner — {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
        f"Total findings: **{len(findings)}**  "
        f"(blocking={len(by_sev['blocking'])}, "
        f"warn={len(by_sev['warn'])}, "
        f"info={len(by_sev['info'])})",
        "",
    ]
    by_kind: dict[str, int] = {}
    for f in findings:
        by_kind[f.kind] = by_kind.get(f.kind, 0) + 1
    if by_kind:
        lines.append("Findings by kind: " + ", ".join(
            f"{k}={v}" for k, v in sorted(by_kind.items())) + ".")
        lines.append("")
    for sev in ("blocking", "warn", "info"):
        items = by_sev.get(sev, [])
        if not items:
            continue
        lines += [f"## {sev.upper()} ({len(items)})", ""]
        for f in items:
            rng = (f"L{f.line_start}" if f.line_start == f.line_end
                   else f"L{f.line_start}-{f.line_end}")
            lines.append(
                f"- `{_rel_to_home(f.file)}:{rng}` "
                f"`[{f.kind}/{f.pattern}]` {f.snippet}"
            )
            extra = {k: v for k, v in f.fields.items() if v not in (None, "", [], {})}
            if extra:
                lines.append(
                    f"  - `{json.dumps(extra, ensure_ascii=False, sort_keys=True)}`"
                )
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def cmd_scan(args: argparse.Namespace) -> int:
    if args.roots:
        roots = [Path(r) for r in args.roots]
    else:
        roots = [
            COCKPIT_DIR,
            HOOKS_SKILL_DIR,
            HOOKS_HOME_DIR,
        ]

    findings = run_scan(roots)

    if not args.quiet:
        sys.stdout.write(render_markdown(findings))

    if args.json:
        _atomic_write(
            TMP_JSON,
            json.dumps([asdict(f) for f in findings], ensure_ascii=False, indent=2),
        )

    if args.report:
        out = AUDIT_DIR / f"deadwood-{datetime.now().strftime('%Y-%m-%d')}.md"
        _atomic_write(out, render_markdown(findings))
        if not args.quiet:
            print(f"[deadwood] report -> {out}", file=sys.stderr)

    return exit_code(findings)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="deadwood_scanner",
        description="ULTRON v14 GENESIS — Deadwood Scanner (Phase 1, stages 1-3).",
    )
    p.add_argument("--roots", nargs="*",
                   help="Scan roots (default: cockpit + hook dirs).")
    p.add_argument("--json", action="store_true",
                   help=f"Write JSON sidecar to {TMP_JSON}.")
    p.add_argument("--report", action="store_true",
                   help=f"Write markdown report to {AUDIT_DIR}/deadwood-<date>.md.")
    p.add_argument("--quiet", action="store_true",
                   help="No stdout; exit code only.")
    args = p.parse_args(argv)
    return cmd_scan(args)


if __name__ == "__main__":
    sys.exit(main())
