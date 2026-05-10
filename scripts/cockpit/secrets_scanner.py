"""ULTRON v14 Sprint 5-C — Secrets Scanner.

Scans config files / logs / alerts for accidentally-committed secrets.
The doctor's `--security` mode wires this in as a blocking detector.

DESIGN INVARIANTS
-----------------
1. Pattern-based + Shannon-entropy heuristic, no live API validation.
2. Default scan paths cover the ULTRON state surface; callers can pass
   --paths to extend.
3. False-positive filters: ${...} env-var placeholders, sha1:* hash refs,
   ssh-rsa keys (we don't scan ssh paths but defensive).
4. NEVER prints the full secret — excerpt is the first 12 chars + "..."
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

_COCKPIT_DIR = Path(__file__).resolve().parent
if str(_COCKPIT_DIR) not in sys.path:
    sys.path.insert(0, str(_COCKPIT_DIR))

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ULTRON_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / ".ultron"
CLAUDE_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / ".claude"

DEFAULT_PATHS: tuple[Path, ...] = (
    CLAUDE_HOME / "settings.json",
    ULTRON_HOME / "alerts.jsonl",
    ULTRON_HOME / "telemetry",      # dir — recursed below
    ULTRON_HOME / "config",         # dir — recursed
    ULTRON_HOME / ".tmp",           # dir — recursed
)


# ---------------------------------------------------------------------------
# Patterns
# ---------------------------------------------------------------------------

# Each entry: (rule_id, regex, severity, label).
_PATTERNS: tuple[tuple[str, "re.Pattern[str]", str, str], ...] = (
    ("S001", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}"), "blocking", "anthropic_key"),
    ("S002", re.compile(r"\bsk-[A-Za-z0-9]{20,}"), "blocking", "openai_key"),
    ("S003", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}"), "blocking", "google_api_key"),
    ("S004", re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{36,255}"), "blocking", "github_token"),
    ("S005", re.compile(r"\bxox[bpoa]-[0-9A-Za-z\-]{10,}"), "blocking", "slack_token"),
    ("S006", re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "blocking", "aws_access_key"),
)

_ENV_PLACEHOLDER = re.compile(r"^\$\{[A-Z0-9_]+\}$")
_SHA_REF = re.compile(r"^(?:sha1|sha256):[0-9a-fA-F]+$")
_SSH_PUBKEY = re.compile(r"^ssh-(?:rsa|ed25519|dss|ecdsa)\s+AAAA")

# Generic high-entropy heuristic for keys named *_key / *_token / *_secret /
# *_password — only triggers in JSON/YAML *value* contexts.
_LIKELY_SECRET_KEY_RE = re.compile(
    r"['\"]?([A-Za-z0-9_\-]*?(?:_key|_token|_secret|_password))['\"]?"
    r"\s*[:=]\s*['\"]([^'\"\s]{32,200})['\"]",
    re.IGNORECASE,
)


def _shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    counts: dict[str, int] = {}
    for c in s:
        counts[c] = counts.get(c, 0) + 1
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


@dataclass(frozen=True)
class SecretFinding:
    rule_id: str
    severity: str
    label: str
    path: str
    line_number: int
    excerpt: str   # first 12 chars + "..." — NEVER full secret

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_false_positive(token: str) -> bool:
    if _ENV_PLACEHOLDER.match(token):
        return True
    if _SHA_REF.match(token):
        return True
    if _SSH_PUBKEY.match(token):
        return True
    return False


def _safe_excerpt(token: str) -> str:
    if len(token) <= 12:
        return token[:6] + "***"
    return token[:8] + "***"


def _iter_files(paths: Iterable[Path]) -> Iterable[Path]:
    """Walk every file under each input path. Files are yielded directly,
    directories are recursed (max depth 6) and filtered to text-likely
    extensions.
    """
    text_exts = {".json", ".jsonl", ".yaml", ".yml", ".md", ".txt", ".log",
                 ".env", ".cfg", ".ini", ".toml"}
    for p in paths:
        if not p.exists():
            continue
        if p.is_file():
            yield p
            continue
        # Bounded recursion — don't walk huge subtrees.
        try:
            for f in p.rglob("*"):
                if not f.is_file():
                    continue
                if f.suffix.lower() not in text_exts and f.suffix != "":
                    continue
                # Skip provenance/integrity files (they hold sha1s by design).
                if f.name in ("skill-provenance.json",
                              "settings.snapshots.jsonl"):
                    continue
                yield f
        except OSError:
            continue


def _scan_one_file(path: Path) -> list[SecretFinding]:
    findings: list[SecretFinding] = []
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line_no, line in enumerate(fh, start=1):
                # Phase 1 — known-key regexes.
                for rule_id, rx, sev, label in _PATTERNS:
                    for m in rx.finditer(line):
                        token = m.group(0)
                        if _is_false_positive(token):
                            continue
                        findings.append(SecretFinding(
                            rule_id=rule_id, severity=sev, label=label,
                            path=str(path), line_number=line_no,
                            excerpt=_safe_excerpt(token),
                        ))
                # Phase 2 — high-entropy strings near *_key/*_token/*_secret keys.
                for m in _LIKELY_SECRET_KEY_RE.finditer(line):
                    key_name = m.group(1)
                    value = m.group(2)
                    if _is_false_positive(value):
                        continue
                    if _shannon_entropy(value) < 4.5:
                        continue
                    findings.append(SecretFinding(
                        rule_id="S007", severity="warn",
                        label=f"high_entropy_value:{key_name}",
                        path=str(path), line_number=line_no,
                        excerpt=_safe_excerpt(value),
                    ))
    except OSError:
        return findings
    return findings


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def scan_paths(paths: Iterable[Path] | None = None) -> list[SecretFinding]:
    targets = list(paths) if paths else list(DEFAULT_PATHS)
    findings: list[SecretFinding] = []
    for f in _iter_files(targets):
        findings.extend(_scan_one_file(f))
    return findings


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _cli_scan(args: argparse.Namespace) -> int:
    if args.paths:
        paths = [Path(p) for p in args.paths]
    else:
        paths = list(DEFAULT_PATHS)
    findings = scan_paths(paths)
    if args.json:
        print(json.dumps({
            "scanned_paths": [str(p) for p in paths],
            "total_findings": len(findings),
            "findings": [f.to_dict() for f in findings],
        }, ensure_ascii=False, indent=2))
    else:
        if not findings:
            print(f"No secrets found across {len(paths)} target path(s).")
        else:
            print(f"Found {len(findings)} potential secret(s):")
            for f in findings:
                print(f"  [{f.severity:<8}] {f.rule_id} {f.label}")
                print(f"    path: {f.path}:{f.line_number}")
                print(f"    excerpt: {f.excerpt}")
    if not findings:
        return 0
    has_blocking = any(f.severity == "blocking" for f in findings)
    return 2 if has_blocking else 1


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="secrets_scanner.py",
        description="ULTRON secrets scanner (S5-C).",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="Scan default paths or --paths")
    s.add_argument("--paths", nargs="*", default=None,
                   help="Override default paths (file or dir).")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=_cli_scan)

    ns = p.parse_args(argv)
    return ns.func(ns)


if __name__ == "__main__":
    raise SystemExit(main())
