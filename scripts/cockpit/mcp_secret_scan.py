#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""ULTRON OLA J — MCP literal-secret scanner (READ-ONLY).

Scans MCP/agent config files for LITERAL provider tokens that are committed
as plain values instead of ``${ENV_VAR}`` references. The motivating finding:
``~/.claude.json`` carries a hardcoded ``gho_...`` GitHub token in the
``github-pat`` server (see config/mcp-policy.yaml -> github-pat).

DESIGN INVARIANTS
-----------------
1. READ-ONLY. This script never writes or mutates the scanned files.
2. NEVER prints a token value. A finding reports only:
       {file, key, pattern, prefix (first 4 chars), length}
   The prefix is capped at 4 characters so it can never reveal a usable
   secret, and the raw match is discarded immediately after measuring it.
3. ``${VAR}`` / ``$VAR`` / ``{{VAR}}`` env references are NOT secrets and are
   filtered out before pattern matching.
4. Exit code: 0 = clean, 1 = at least one literal secret found, 2 = usage /
   IO error. CI/doctor can gate on exit 1.

DEFAULT TARGETS (real files, but only safe metadata is emitted):
    ~/.claude/settings.json
    ~/.claude.json

Run:
    uv run python mcp_secret_scan.py            # scan default targets
    uv run python mcp_secret_scan.py --json     # machine-readable report
    uv run python mcp_secret_scan.py --paths a.json b.json
    uv run python mcp_secret_scan.py --self-test # scan an in-memory fixture
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~")))
CLAUDE_SETTINGS = _HOME / ".claude" / "settings.json"
CLAUDE_JSON = _HOME / ".claude.json"

DEFAULT_PATHS: tuple[Path, ...] = (CLAUDE_SETTINGS, CLAUDE_JSON)

# Cap on how much of a matched token may ever surface. 4 chars of a long,
# high-entropy token is not a usable secret but lets a human recognise the
# vendor prefix (e.g. "gho_", "sk-A").
_PREFIX_CHARS = 4

# ---------------------------------------------------------------------------
# Patterns — literal provider tokens. Each entry: (rule_id, label, regex).
# These intentionally match the *value* shape only; env references are
# stripped beforehand so a ${GITHUB_TOKEN} never reaches these.
# ---------------------------------------------------------------------------

_PATTERNS: tuple[tuple[str, str, "re.Pattern[str]"], ...] = (
    ("github_oauth", "github_token", re.compile(r"gho_[A-Za-z0-9]{20,255}")),
    ("github_pat_classic", "github_token", re.compile(r"ghp_[A-Za-z0-9]{20,255}")),
    ("github_app", "github_token", re.compile(r"ghs_[A-Za-z0-9]{20,255}")),
    ("github_pat_fine", "github_token", re.compile(r"github_pat_[A-Za-z0-9_]{20,255}")),
    ("openai_key", "openai_key", re.compile(r"sk-[A-Za-z0-9_\-]{20,255}")),
    ("mem0_key", "mem0_key", re.compile(r"m0-[A-Za-z0-9_\-]{16,255}")),
    ("aws_access_key", "aws_access_key", re.compile(r"AKIA[0-9A-Z]{16}")),
)

# Env-reference shapes that are SAFE (never a literal secret):
#   ${VAR}  $VAR  {{VAR}}  %VAR%
_ENV_REF = re.compile(r"\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|\{\{[^}]+\}\}|%[A-Za-z_][A-Za-z0-9_]*%")


@dataclass(frozen=True)
class Finding:
    """A literal-secret hit. Deliberately omits the secret value."""

    file: str
    key: str          # JSON path / location hint where the token was found
    pattern: str      # rule_id that matched
    label: str        # human label (vendor family)
    prefix: str       # first _PREFIX_CHARS chars only
    length: int       # full length of the matched token


def _strip_env_refs(text: str) -> str:
    """Replace env references with a neutral placeholder so they can't match.

    Keeps offsets-irrelevant: we only need pattern presence, not position.
    """
    return _ENV_REF.sub("ENVREF", text)


def _iter_json_strings(node: object, prefix: str = "$") -> Iterable[tuple[str, str]]:
    """Yield (json_path, string_value) for every string leaf in a JSON tree.

    Walking the parsed JSON (rather than raw text) lets us attribute each hit
    to a real config key without ever logging surrounding values.
    """
    if isinstance(node, dict):
        for k, v in node.items():
            yield from _iter_json_strings(v, f"{prefix}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _iter_json_strings(v, f"{prefix}[{i}]")
    elif isinstance(node, str):
        yield prefix, node


def _scan_string(value: str) -> list[tuple[str, str, str, int]]:
    """Return (rule_id, label, prefix, length) for literal tokens in `value`.

    Env references are stripped first, so ${GITHUB_TOKEN} yields nothing.
    The matched substring is measured then dropped; only prefix+length escape.
    """
    cleaned = _strip_env_refs(value)
    hits: list[tuple[str, str, str, int]] = []
    for rule_id, label, rx in _PATTERNS:
        for m in rx.finditer(cleaned):
            token = m.group(0)
            hits.append((rule_id, label, token[:_PREFIX_CHARS], len(token)))
            del token  # do not keep the secret around
    return hits


def scan_text(file_label: str, text: str) -> list[Finding]:
    """Scan a blob of text. Tries JSON parse for keyed attribution; falls back
    to a line scan if the file is not valid JSON.
    """
    findings: list[Finding] = []
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        parsed = None

    if parsed is not None:
        for json_path, value in _iter_json_strings(parsed):
            for rule_id, label, prefix, length in _scan_string(value):
                findings.append(
                    Finding(file_label, json_path, rule_id, label, prefix, length)
                )
        return findings

    # Non-JSON fallback: scan line by line, key = "line:<n>".
    for lineno, line in enumerate(text.splitlines(), start=1):
        for rule_id, label, prefix, length in _scan_string(line):
            findings.append(
                Finding(file_label, f"line:{lineno}", rule_id, label, prefix, length)
            )
    return findings


def scan_file(path: Path) -> list[Finding]:
    """Read a file (read-only) and scan it. Missing files are skipped quietly."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return []
    except OSError as exc:  # pragma: no cover - environment dependent
        print(f"warn: cannot read {path}: {exc}", file=sys.stderr)
        return []
    return scan_text(str(path), text)


def _report(findings: list[Finding], as_json: bool) -> None:
    if as_json:
        print(json.dumps([asdict(f) for f in findings], indent=2))
        return
    if not findings:
        print("OK: no literal MCP secrets found.")
        return
    print(f"FOUND {len(findings)} literal secret(s):")
    for f in findings:
        # NOTE: only prefix + length are ever printed; never the token value.
        print(
            f"  - file={f.file} key={f.key} pattern={f.pattern} "
            f"label={f.label} prefix={f.prefix!r} length={f.length}"
        )


# ---------------------------------------------------------------------------
# Self-test: scan an in-memory fixture (no real files, no real secrets).
# Verifies (a) a literal token is caught, (b) a ${VAR} ref is NOT caught.
# ---------------------------------------------------------------------------

def _self_test() -> int:
    fixture = {
        "mcpServers": {
            "github": {"headers": {"Authorization": "Bearer ${GITHUB_TOKEN}"}},
            "github-pat": {"env": {"GITHUB_TOKEN": "gho_" + "A" * 36}},
        }
    }
    text = json.dumps(fixture)
    findings = scan_text("<fixture>", text)
    literal = [f for f in findings if f.pattern == "github_oauth"]
    env_only = [f for f in findings if "${" in f.key]  # should be empty
    ok = len(literal) == 1 and not env_only
    # Confirm the value never leaks: prefix must be <= _PREFIX_CHARS.
    leak_safe = all(len(f.prefix) <= _PREFIX_CHARS for f in findings)
    _report(findings, as_json=False)
    if ok and leak_safe:
        print("self-test: PASS (literal caught, env-ref ignored, value not leaked)")
        return 0
    print("self-test: FAIL", file=sys.stderr)
    return 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="mcp_secret_scan.py",
        description=(
            "READ-ONLY scanner for LITERAL MCP secrets in config files. "
            "Reports file/key/pattern/prefix/length only; never the token value. "
            "Exit 1 if any literal secret is found."
        ),
    )
    parser.add_argument(
        "--paths",
        nargs="*",
        help="Files to scan (default: ~/.claude/settings.json ~/.claude.json).",
    )
    parser.add_argument(
        "--json", action="store_true", help="Emit findings as JSON."
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Scan an in-memory fixture instead of real files.",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        return _self_test()

    targets: tuple[Path, ...]
    if args.paths:
        targets = tuple(Path(p) for p in args.paths)
    else:
        targets = DEFAULT_PATHS

    all_findings: list[Finding] = []
    for path in targets:
        all_findings.extend(scan_file(path))

    _report(all_findings, args.json)
    return 1 if all_findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
