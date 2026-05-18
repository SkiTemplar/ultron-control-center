# === maintainer-only (not user-facing) ===
# CONTRIBUTING.md flags this as a "starting point" discovery tool. Only
# invoked from `tests/test_silent_exec.py` and ad-hoc audits — no hook,
# control-center or health caller. See docs/MAINTAINERS.md.
"""ULTRON silent-exec audit — discovery script (read-only, NO auto-fix).

Sprint 1 Pilar A. Walks ULTRON's Python and PowerShell sources and flags any
subprocess invocation that could leak a console window on Windows.

Output: JSON to ``~/.ultron/.tmp/silent-audit.json``. USER decides which
hits warrant migration to ``silent_exec.silent_run/popen``; this tool never
edits files.

Detection rules
---------------
**Python (AST):** flag ``subprocess.run(...)`` and ``subprocess.Popen(...)`` whose
keyword arguments do NOT include any of:
  - ``creationflags=...``  (we don't try to evaluate the value — presence is enough
    in the audit phase; manual review confirms the constant)
  - ``capture_output=True``
  - ``stdout=...``         (any explicit stdout redirect)
Calls already routed through ``silent_run`` / ``silent_popen`` are not flagged.

**PowerShell (regex):** flag ``Start-Process`` invocations missing both
``-WindowStyle Hidden`` and ``-NoNewWindow``. Simple line scan — no negative
lookahead. Multi-line continuations may be missed; that's acceptable for an
audit signal (we err toward false positives, not false negatives).

Allowlist
---------
Hard-coded skip set — these files are not flagged:
- ``test_*.py``        (test harnesses; subprocess noise is expected)
- ``audit_silent_exec.py`` (this file — we discuss subprocess in docstrings)
- ``silent_exec.py``   (the wrapper itself)

CLI
---
    uv run python audit_silent_exec.py
    uv run python audit_silent_exec.py --print          # also human summary
    uv run python audit_silent_exec.py --exit-on-hits   # exit 1 if any hit (CI)
"""
from __future__ import annotations

import argparse
import ast
import datetime as _dt
import json
import re
import sys
from pathlib import Path

# ─── Paths ───────────────────────────────────────────────────────────────────
HOME = Path.home()
SKILL_ROOT = HOME / ".claude" / "skills" / "ultron"
COCKPIT_DIR = SKILL_ROOT / "scripts" / "cockpit"
HOOKS_PY_DIR = SKILL_ROOT / "hooks"
HOOKS_PS_DIR = HOME / ".ultron" / "hooks"
OUTPUT_FILE = HOME / ".ultron" / ".tmp" / "silent-audit.json"

# ─── Allowlist ───────────────────────────────────────────────────────────────
ALLOWLIST_NAMES = {"audit_silent_exec.py", "silent_exec.py"}
ALLOWLIST_GLOBS = ("test_",)  # any file whose basename starts with test_

# ─── PowerShell regex ────────────────────────────────────────────────────────
_PS_START_PROCESS_RE = re.compile(r"\bStart-Process\b", re.IGNORECASE)
_PS_HAS_HIDDEN_RE = re.compile(r"-WindowStyle\s+Hidden\b", re.IGNORECASE)
_PS_HAS_NONEWWINDOW_RE = re.compile(r"-NoNewWindow\b", re.IGNORECASE)


def _is_allowlisted(path: Path) -> bool:
    name = path.name
    if name in ALLOWLIST_NAMES:
        return True
    return any(name.startswith(prefix) for prefix in ALLOWLIST_GLOBS)


# ─── Python AST analyzer ─────────────────────────────────────────────────────
class _SubprocessVisitor(ast.NodeVisitor):
    """Walk an AST and record subprocess.run/Popen calls missing silent flags.

    Tracks `from subprocess import run, Popen` aliases per-module so rebound
    bare names like `run(...)` / `Popen(...)` are also flagged. Aliased names
    (`from subprocess import run as r`) are tracked too — `r(...)` flagged.
    """

    SAFE_KWARGS = {"creationflags", "capture_output", "stdout"}

    # Calls already routed through silent_exec wrappers are exempt.
    SILENT_CALLEES = {"silent_run", "silent_popen"}

    def __init__(self, source_lines: list[str]) -> None:
        self.source_lines = source_lines
        self.hits: list[dict] = []
        # Maps local-binding-name → original symbol ("run" or "Popen").
        # Populated by visit_ImportFrom for `from subprocess import ...`.
        self.aliases: dict[str, str] = {}

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:  # noqa: N802
        if node.module == "subprocess":
            for alias in node.names:
                if alias.name in {"run", "Popen"}:
                    bound = alias.asname or alias.name
                    self.aliases[bound] = alias.name
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802 (ast API)
        kind = self._classify_call(node.func)
        if kind:
            self._inspect(node, kind)
        self.generic_visit(node)

    def _classify_call(self, func: ast.AST) -> str | None:
        # subprocess.run(...) / subprocess.Popen(...)
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            if func.value.id == "subprocess" and func.attr in {"run", "Popen"}:
                return f"subprocess.{func.attr}"
        # Bare-name calls — explicitly safe wrappers are skipped.
        if isinstance(func, ast.Name):
            if func.id in self.SILENT_CALLEES:
                return None  # explicitly safe wrapper
            # Rebound subprocess imports: `from subprocess import run` → run(...)
            original = self.aliases.get(func.id)
            if original in {"run", "Popen"}:
                return f"subprocess.{original}"
        return None

    def _inspect(self, node: ast.Call, kind: str) -> None:
        present_kwargs = {kw.arg for kw in node.keywords if kw.arg}
        missing = sorted(self.SAFE_KWARGS - present_kwargs)
        if len(missing) == len(self.SAFE_KWARGS):
            # All three signal kwargs absent → flag it.
            line_idx = node.lineno - 1
            snippet = (
                self.source_lines[line_idx].strip()
                if 0 <= line_idx < len(self.source_lines)
                else ""
            )
            self.hits.append(
                {
                    "line": node.lineno,
                    "kind": kind,
                    "snippet": snippet[:200],
                    "missing": missing,
                }
            )


def _audit_python(path: Path) -> list[dict]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    try:
        tree = ast.parse(text, filename=str(path))
    except SyntaxError:
        return []
    visitor = _SubprocessVisitor(text.splitlines())
    visitor.visit(tree)
    return visitor.hits


# ─── PowerShell scanner ──────────────────────────────────────────────────────
def _audit_powershell(path: Path) -> list[dict]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    hits: list[dict] = []
    for lineno, raw in enumerate(text.splitlines(), start=1):
        # Skip pure comment lines
        stripped = raw.strip()
        if stripped.startswith("#"):
            continue
        if not _PS_START_PROCESS_RE.search(raw):
            continue
        if _PS_HAS_HIDDEN_RE.search(raw) or _PS_HAS_NONEWWINDOW_RE.search(raw):
            continue
        hits.append(
            {
                "line": lineno,
                "kind": "Start-Process",
                "snippet": stripped[:200],
                "missing": ["-WindowStyle Hidden", "-NoNewWindow"],
            }
        )
    return hits


# ─── Driver ──────────────────────────────────────────────────────────────────
def _walk_python(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return [
        p
        for p in sorted(root.glob("*.py"))
        if p.is_file() and not _is_allowlisted(p)
    ]


def _walk_powershell(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return [
        p
        for p in sorted(root.glob("*.ps1"))
        if p.is_file() and not _is_allowlisted(p)
    ]


def run_audit() -> dict:
    py_files = _walk_python(COCKPIT_DIR) + _walk_python(HOOKS_PY_DIR)
    ps_files = _walk_powershell(HOOKS_PS_DIR)

    hits: list[dict] = []
    for p in py_files:
        for h in _audit_python(p):
            h["file"] = str(p)
            hits.append(h)
    for p in ps_files:
        for h in _audit_powershell(p):
            h["file"] = str(p)
            hits.append(h)

    py_hits = sum(1 for h in hits if h["kind"].startswith("subprocess."))
    ps_hits = sum(1 for h in hits if h["kind"] == "Start-Process")

    return {
        "scanned_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "stats": {
            "py_files": len(py_files),
            "ps1_files": len(ps_files),
            "py_hits": py_hits,
            "ps1_hits": ps_hits,
        },
        "hits": hits,
    }


def _write_json(report: dict) -> None:
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(
        json.dumps(report, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def _print_summary(report: dict) -> None:
    s = report["stats"]
    print(
        f"silent-exec audit  {report['scanned_at']}\n"
        f"  Python files scanned : {s['py_files']:>4}    hits: {s['py_hits']}\n"
        f"  PS1   files scanned : {s['ps1_files']:>4}    hits: {s['ps1_hits']}\n"
        f"  Output: {OUTPUT_FILE}"
    )
    if not report["hits"]:
        print("  (no hits)")
        return
    print()
    print(f"  {'KIND':<22}{'LINE':>6}  FILE")
    print(f"  {'-' * 22}{'-' * 6}  {'-' * 60}")
    for h in report["hits"]:
        print(f"  {h['kind']:<22}{h['line']:>6}  {h['file']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Audit ULTRON sources for non-silent subprocess calls."
    )
    parser.add_argument(
        "--print", dest="do_print", action="store_true",
        help="Also print a human-readable summary to stdout.",
    )
    parser.add_argument(
        "--exit-on-hits", action="store_true",
        help="Exit code 1 if any hits found (for CI gating).",
    )
    args = parser.parse_args(argv)

    report = run_audit()
    _write_json(report)

    if args.do_print:
        _print_summary(report)

    if args.exit_on_hits and report["hits"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
