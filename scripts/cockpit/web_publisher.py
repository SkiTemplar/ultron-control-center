"""ULTRON v14.8 — Web auto-publisher.

Keeps `~/.ultron/web/index.html` fresh by substituting drift-prone metrics
(version, test count, indexed notes, hit rate, release date, tok overhead)
with values pulled from system-snapshot.json + git. Read-only on every other
file in the web/ tree (style.css, script.js, assets — left alone).

Substitution strategy: regex-based, anchor-aware. Each placeholder pattern
includes enough surrounding context that a no-match → no-change keeps the
page intact (safe degradation). Backup `.bak` before any write.

CLI:
  web_publisher.py refresh [--dry-run]    # update index.html
  web_publisher.py status                 # show current values vs source
  web_publisher.py diff                   # show pending changes

Designed to fail-soft: any source missing → leave that field as-is. Stop
hook chain calls this with `--quiet` so partial failures don't block the
pipeline. The web is local-only for now; deploy is a future concern.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

_HERE = Path(__file__).parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def _user_home() -> Path:
    return Path.home()


def _web_index() -> Path:
    return _user_home() / ".ultron" / "web" / "index.html"


def _snapshot_json() -> Path:
    return _user_home() / ".ultron" / ".tmp" / "system-snapshot.json"


# ── Source-of-truth collectors ─────────────────────────────────────────────────


@dataclass
class WebState:
    version: str
    tests_passing: int | None
    notes_indexed: int | None
    vault_vectors: int | None
    cache_hit_rate_pct: float | None
    release_date: str
    git_sha: str
    git_branch: str

    def as_dict(self) -> dict[str, Any]:
        return self.__dict__


def _read_json_safe(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}


def _git_last_commit_date() -> str:
    repo = _user_home() / ".claude" / "skills"
    try:
        out = subprocess.run(
            ["git", "log", "-1", "--pretty=%cs"],
            cwd=str(repo), capture_output=True, text=True, timeout=5,
            creationflags=_WIN_HIDDEN,
        ).stdout.strip()
        return out or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _last_test_count() -> int | None:
    """Best-effort count from pytest cache or last-run report."""
    cache_dir = _user_home() / ".claude" / "skills" / "ultron" / ".pytest_cache"
    nodeids = cache_dir / "v" / "cache" / "nodeids"
    if nodeids.exists():
        try:
            data = json.loads(nodeids.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return len(data)
        except (OSError, json.JSONDecodeError):
            pass
    return None


def collect_state() -> WebState:
    snap = _read_json_safe(_snapshot_json())

    version = "v14.x.x"
    if isinstance(snap.get("version"), dict):
        version = str(snap["version"].get("version") or version)

    notes_indexed = None
    if isinstance(snap.get("brain"), dict):
        notes_indexed = snap["brain"].get("notes")

    vault_vectors = None
    if isinstance(snap.get("qdrant"), dict):
        vault_vectors = snap["qdrant"].get("ultron_vault_points")

    hit_rate = None
    if isinstance(snap.get("cache"), dict):
        hr = snap["cache"].get("hit_rate")
        if isinstance(hr, (int, float)):
            hit_rate = round(hr * 100, 1)

    git = snap.get("git") or {}

    return WebState(
        version=version,
        tests_passing=_last_test_count(),
        notes_indexed=notes_indexed,
        vault_vectors=vault_vectors,
        cache_hit_rate_pct=hit_rate,
        release_date=_git_last_commit_date(),
        git_sha=str(git.get("sha") or ""),
        git_branch=str(git.get("branch") or "main"),
    )


# ── Substitution rules ────────────────────────────────────────────────────────


# Each rule: (anchor_label, regex with one capture group, replacement_template)
# The regex must be specific enough that a wrong match is unlikely. Replacement
# uses Python str.format with `value=...`. If `state.<field>` is None we skip
# the substitution (keep current text).

@dataclass
class Rule:
    label: str
    pattern: str
    template: str   # uses {value} placeholder
    field: str      # WebState attribute used as value (None = no-op)


_RULES = [
    Rule(
        label="page_title",
        # Source HTML uses literal UTF-8 middle dot (·), not the HTML entity.
        pattern=r"<title>ULTRON Genesis [·•] v\d+\.\d+\.\d+</title>",
        template="<title>ULTRON Genesis · {value}</title>",
        field="version",
    ),
    Rule(
        label="brand_version",
        pattern=r'<span class="mono dim">v\d+\.\d+\.\d+</span>',
        template='<span class="mono dim">{value}</span>',
        field="version",
    ),
    Rule(
        label="hero_h1_version",
        pattern=r'<span class="version mono">v\d+\.\d+\.\d+</span>',
        template='<span class="version mono">{value}</span>',
        field="version",
    ),
    Rule(
        label="release_date",
        pattern=r"GENESIS RELEASE &middot; \d{4}-\d{2}-\d{2}",
        template="GENESIS RELEASE &middot; {value}",
        field="release_date",
    ),
    Rule(
        label="hero_specs_tests",
        pattern=r"<span>\d+\s+tests passing</span>",
        template="<span>{value} tests passing</span>",
        field="tests_passing",
    ),
    Rule(
        label="hero_specs_notes",
        pattern=r"<span>\d+\s+notes indexed</span>",
        template="<span>{value} notes indexed</span>",
        field="notes_indexed",
    ),
    Rule(
        label="meta_description_tests",
        pattern=r'(<meta name="description" content="[^"]*?)\d+ tests',
        template=r"\g<1>{value} tests",
        field="tests_passing",
    ),
    Rule(
        label="meta_description_notes",
        pattern=r'(<meta name="description" content="[^"]*?)\d+ indexed notes',
        template=r"\g<1>{value} indexed notes",
        field="notes_indexed",
    ),
    # NOTE: removed `step_tag_footer_version` rule — it was matching the
    # release-history timeline (S0..S5 sprint badges) which contains
    # historical versions that MUST NOT be auto-bumped. The timeline is
    # static editorial content; only the bottom-of-page footer brand line
    # below tracks the current release.
    Rule(
        label="footer_brand_line",
        # Captures "ULTRON v14.0.0 GENESIS &middot; 2026-05-06" in the page
        # footer. Both version and date are bumped from state.
        pattern=r"ULTRON v\d+\.\d+\.\d+ GENESIS &middot; \d{4}-\d{2}-\d{2}",
        template="ULTRON {value} GENESIS &middot; {release_date}",
        field="version",
    ),
    Rule(
        label="prose_notes_indexed_inline",
        # Body prose: "X notes indexed. Every project..."
        pattern=r"\b\d+ notes indexed\.\s+Every project",
        template="{value} notes indexed. Every project",
        field="notes_indexed",
    ),
    Rule(
        label="layer_role_fts5_notes",
        # "SQLite FTS5 &middot; 646 notes &middot;..." (count occurs once)
        pattern=r"SQLite FTS5 &middot; \d+ notes",
        template="SQLite FTS5 &middot; {value} notes",
        field="notes_indexed",
    ),
    Rule(
        label="brain_summary_notes",
        # "646 notes &middot; ~10,240 chunks"
        pattern=r"\b\d+ notes &middot; ~[\d,]+ chunks",
        template="{value} notes &middot; ~10,240 chunks",
        field="notes_indexed",
    ),
    Rule(
        label="summary_notes_indexed_count",
        # `<summary><span>Notes indexed</span><span class="mono">646</span></summary>`
        pattern=r'(<span>Notes indexed</span><span class="mono">)\d+(</span>)',
        template=r"\g<1>{value}\g<2>",
        field="notes_indexed",
    ),
]


def render_replacement(rule: Rule, state: WebState) -> str | None:
    """Build the replacement string for a rule. None if the primary
    value is missing — caller should skip that substitution.

    Templates can reference any state field by name (`{version}`,
    `{release_date}`, etc.) plus the special `{value}` alias for
    the rule's primary field.
    """
    val = getattr(state, rule.field, None)
    if val is None or (isinstance(val, str) and not val):
        return None
    kwargs = state.as_dict()
    kwargs["value"] = val
    try:
        return rule.template.format(**kwargs)
    except (KeyError, IndexError):
        return None


# ── Apply ─────────────────────────────────────────────────────────────────────


@dataclass
class ApplyReport:
    target: str
    state: dict[str, Any]
    rules_applied: list[str]
    rules_skipped: list[str]
    rules_no_match: list[str]
    chars_before: int
    chars_after: int
    dry_run: bool

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__


def apply_substitutions(*, dry_run: bool = False) -> ApplyReport:
    target = _web_index()
    if not target.exists():
        return ApplyReport(
            target=str(target), state={}, rules_applied=[], rules_skipped=[],
            rules_no_match=[], chars_before=0, chars_after=0, dry_run=dry_run,
        )
    text = target.read_text(encoding="utf-8")
    state = collect_state()
    chars_before = len(text)

    applied: list[str] = []
    skipped: list[str] = []
    no_match: list[str] = []

    for rule in _RULES:
        replacement = render_replacement(rule, state)
        if replacement is None:
            skipped.append(rule.label)
            continue
        new_text, n = re.subn(rule.pattern, replacement, text, count=1)
        if n == 0:
            no_match.append(rule.label)
            continue
        text = new_text
        applied.append(rule.label)

    if not dry_run and applied:
        backup = target.with_suffix(target.suffix + ".bak")
        backup.write_text(target.read_text(encoding="utf-8"), encoding="utf-8")
        tmp = target.with_suffix(target.suffix + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, target)

    return ApplyReport(
        target=str(target),
        state=state.as_dict(),
        rules_applied=applied,
        rules_skipped=skipped,
        rules_no_match=no_match,
        chars_before=chars_before,
        chars_after=len(text),
        dry_run=dry_run,
    )


# ── CLI ────────────────────────────────────────────────────────────────────────


def _cmd_refresh(args: argparse.Namespace) -> int:
    report = apply_substitutions(dry_run=args.dry_run)
    if not args.quiet:
        print(json.dumps(report.to_dict(), indent=2, ensure_ascii=False))
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    state = collect_state()
    payload = {
        "web_index": str(_web_index()),
        "web_index_exists": _web_index().exists(),
        "snapshot_json": str(_snapshot_json()),
        "snapshot_json_exists": _snapshot_json().exists(),
        "state_for_substitution": state.as_dict(),
    }
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


def _cmd_diff(args: argparse.Namespace) -> int:
    report = apply_substitutions(dry_run=True)
    print(json.dumps(report.to_dict(), indent=2, ensure_ascii=False))
    return 0 if report.rules_applied else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="web_publisher.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_r = sub.add_parser("refresh", help="apply substitutions to index.html")
    p_r.add_argument("--dry-run", action="store_true")
    p_r.add_argument("--quiet", action="store_true")
    p_r.set_defaults(func=_cmd_refresh)

    p_s = sub.add_parser("status", help="current WebState + paths")
    p_s.set_defaults(func=_cmd_status)

    p_d = sub.add_parser("diff", help="dry-run preview")
    p_d.set_defaults(func=_cmd_diff)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
