"""ULTRON v14 Sprint 5-C — Settings Integrity Snapshot + Diff.

Append-only snapshot ledger of ``~/.claude/settings.json`` so we can detect
unauthorized post-install drift in MCPs, hooks, or plugins.

State file: ``~/.ultron/integrity/settings.snapshots.jsonl``

Each snapshot record:

    {"ts": "...", "sha1": "...", "size": N, "mcps_count": N, "hooks_count": N,
     "plugins_count": N, "trigger": "manual|auto|sync", "user_authorized": true,
     "mcps": ["sequential-thinking", ...],
     "hooks": ["PreToolUse:auto-approve-readonly.py", ...],
     "plugins": ["superpowers@superpowers-marketplace", ...]}

The doctor's `--security` mode calls `verify()` which compares the live
settings.json against the most recent ``user_authorized=true`` snapshot.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

_COCKPIT_DIR = Path(__file__).resolve().parent
if str(_COCKPIT_DIR) not in sys.path:
    sys.path.insert(0, str(_COCKPIT_DIR))

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ULTRON_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / ".ultron"
CLAUDE_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / ".claude"
SETTINGS_JSON = CLAUDE_HOME / "settings.json"
SNAPSHOTS_FILE = ULTRON_HOME / "integrity" / "settings.snapshots.jsonl"


def _now_iso() -> str:
    return (_dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)
            .strftime("%Y-%m-%dT%H:%M:%SZ"))


@dataclass(frozen=True)
class Snapshot:
    ts: str
    sha1: str
    size: int
    mcps_count: int
    hooks_count: int
    plugins_count: int
    trigger: str
    user_authorized: bool
    mcps: list[str] = field(default_factory=list)
    hooks: list[str] = field(default_factory=list)
    plugins: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class IntegrityFinding:
    finding_type: str   # "mcp_added" | "mcp_removed" | "hook_added" | ...
    severity: str       # "info" | "warn" | "blocking"
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class DiffReport:
    base_ts: str | None
    current_ts: str
    mcps_added: list[str]
    mcps_removed: list[str]
    hooks_added: list[str]
    hooks_removed: list[str]
    plugins_added: list[str]
    plugins_removed: list[str]
    sha1_changed: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def has_changes(self) -> bool:
        return any((self.mcps_added, self.mcps_removed, self.hooks_added,
                    self.hooks_removed, self.plugins_added,
                    self.plugins_removed, self.sha1_changed))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_settings() -> dict[str, Any] | None:
    if not SETTINGS_JSON.exists():
        return None
    try:
        return json.loads(SETTINGS_JSON.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _file_sha1(path: Path) -> str:
    if not path.exists():
        return ""
    h = hashlib.sha1(usedforsecurity=False)
    try:
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
    except OSError:
        return ""
    return h.hexdigest()


def _walk_hook_paths(hooks: Any) -> list[str]:
    """Return ["EventName:script_basename", ...] for every hook command."""
    out: list[str] = []
    if not isinstance(hooks, dict):
        return out
    for event_name, slot_list in hooks.items():
        if not isinstance(slot_list, list):
            continue
        for slot in slot_list:
            if not isinstance(slot, dict):
                continue
            for h in (slot.get("hooks") or []):
                if not isinstance(h, dict):
                    continue
                cmd = h.get("command", "")
                if not isinstance(cmd, str):
                    continue
                # Extract last path token ending in .py / .ps1 — same heuristic
                # as doctor.py.
                token: str | None = None
                for tok in reversed(cmd.split()):
                    cleaned = tok.strip().strip('"').strip("'")
                    low = cleaned.lower()
                    if low.endswith(".py") or low.endswith(".ps1"):
                        token = cleaned
                        break
                if token:
                    out.append(f"{event_name}:{Path(token).name}")
                else:
                    out.append(f"{event_name}:<inline>")
    return sorted(set(out))


def _extract_state(data: dict[str, Any]) -> tuple[list[str], list[str], list[str]]:
    """Return (mcps, hooks, plugins) sorted lists from a settings.json dict."""
    mcps_raw = data.get("mcpServers") or {}
    mcps = sorted(mcps_raw.keys()) if isinstance(mcps_raw, dict) else []
    hooks = _walk_hook_paths(data.get("hooks"))
    plugins_raw = data.get("enabledPlugins") or {}
    plugins = sorted(plugins_raw.keys()) if isinstance(plugins_raw, dict) else []
    return mcps, hooks, plugins


# ---------------------------------------------------------------------------
# Snapshot IO
# ---------------------------------------------------------------------------

def _read_snapshots() -> list[Snapshot]:
    if not SNAPSHOTS_FILE.exists():
        return []
    out: list[Snapshot] = []
    try:
        with SNAPSHOTS_FILE.open("r", encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                line = raw.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(rec, dict):
                    continue
                try:
                    out.append(Snapshot(
                        ts=str(rec.get("ts", "")),
                        sha1=str(rec.get("sha1", "")),
                        size=int(rec.get("size", 0)),
                        mcps_count=int(rec.get("mcps_count", 0)),
                        hooks_count=int(rec.get("hooks_count", 0)),
                        plugins_count=int(rec.get("plugins_count", 0)),
                        trigger=str(rec.get("trigger", "manual")),
                        user_authorized=bool(rec.get("user_authorized", False)),
                        mcps=list(rec.get("mcps") or []),
                        hooks=list(rec.get("hooks") or []),
                        plugins=list(rec.get("plugins") or []),
                    ))
                except (TypeError, ValueError):
                    continue
    except OSError:
        return []
    return out


def _append_snapshot(snap: Snapshot) -> None:
    SNAPSHOTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(snap.to_dict(), ensure_ascii=False,
                         separators=(",", ":")) + "\n"
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    fd = os.open(str(SNAPSHOTS_FILE), flags, 0o644)
    try:
        os.write(fd, payload.encode("utf-8"))
    finally:
        os.close(fd)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def current_state() -> Snapshot:
    """Return a Snapshot of the current settings.json without persisting."""
    data = _read_settings() or {}
    mcps, hooks, plugins = _extract_state(data)
    return Snapshot(
        ts=_now_iso(),
        sha1=_file_sha1(SETTINGS_JSON),
        size=int(SETTINGS_JSON.stat().st_size) if SETTINGS_JSON.exists() else 0,
        mcps_count=len(mcps),
        hooks_count=len(hooks),
        plugins_count=len(plugins),
        trigger="manual",
        user_authorized=True,
        mcps=mcps,
        hooks=hooks,
        plugins=plugins,
    )


def take_snapshot(trigger: str = "manual",
                   user_authorized: bool = True) -> Snapshot:
    snap_no_meta = current_state()
    snap = Snapshot(
        ts=snap_no_meta.ts,
        sha1=snap_no_meta.sha1,
        size=snap_no_meta.size,
        mcps_count=snap_no_meta.mcps_count,
        hooks_count=snap_no_meta.hooks_count,
        plugins_count=snap_no_meta.plugins_count,
        trigger=trigger,
        user_authorized=user_authorized,
        mcps=list(snap_no_meta.mcps),
        hooks=list(snap_no_meta.hooks),
        plugins=list(snap_no_meta.plugins),
    )
    _append_snapshot(snap)
    return snap


def diff_against_last(authorized_only: bool = True) -> DiffReport:
    snaps = _read_snapshots()
    cur = current_state()
    base: Snapshot | None = None
    for s in reversed(snaps):
        if authorized_only and not s.user_authorized:
            continue
        base = s
        break
    if base is None:
        return DiffReport(
            base_ts=None,
            current_ts=cur.ts,
            mcps_added=cur.mcps,
            mcps_removed=[],
            hooks_added=cur.hooks,
            hooks_removed=[],
            plugins_added=cur.plugins,
            plugins_removed=[],
            sha1_changed=bool(cur.sha1),
        )
    mcps_added = sorted(set(cur.mcps) - set(base.mcps))
    mcps_removed = sorted(set(base.mcps) - set(cur.mcps))
    hooks_added = sorted(set(cur.hooks) - set(base.hooks))
    hooks_removed = sorted(set(base.hooks) - set(cur.hooks))
    plugins_added = sorted(set(cur.plugins) - set(base.plugins))
    plugins_removed = sorted(set(base.plugins) - set(cur.plugins))
    return DiffReport(
        base_ts=base.ts,
        current_ts=cur.ts,
        mcps_added=mcps_added,
        mcps_removed=mcps_removed,
        hooks_added=hooks_added,
        hooks_removed=hooks_removed,
        plugins_added=plugins_added,
        plugins_removed=plugins_removed,
        sha1_changed=cur.sha1 != base.sha1,
    )


def verify() -> list[IntegrityFinding]:
    """Surface findings for doctor --security."""
    findings: list[IntegrityFinding] = []
    if not SETTINGS_JSON.exists():
        findings.append(IntegrityFinding(
            "settings_missing", "warn",
            f"settings.json not found at {SETTINGS_JSON}",
        ))
        return findings
    snaps = _read_snapshots()
    if not snaps:
        # F09 fix: missing baseline is a warn, not info — without a
        # snapshot the integrity check has no anchor and silently
        # rubber-stamps any future drift. Doctor surfaces a warn-level
        # finding with a fix_command that takes the baseline.
        findings.append(IntegrityFinding(
            "no_snapshot", "warn",
            "No prior snapshot recorded yet. Run "
            "`ultron security settings-snapshot` to establish a baseline.",
        ))
        return findings
    diff = diff_against_last(authorized_only=True)
    for name in diff.mcps_added:
        findings.append(IntegrityFinding(
            "mcp_added", "warn",
            f"Unauthorized MCP server added: {name} "
            f"(baseline {diff.base_ts} -> current {diff.current_ts})",
        ))
    for name in diff.mcps_removed:
        findings.append(IntegrityFinding(
            "mcp_removed", "info",
            f"MCP server removed since baseline: {name}",
        ))
    for name in diff.hooks_added:
        findings.append(IntegrityFinding(
            "hook_added", "warn",
            f"Unauthorized hook added: {name}",
        ))
    for name in diff.hooks_removed:
        findings.append(IntegrityFinding(
            "hook_removed", "info",
            f"Hook removed since baseline: {name}",
        ))
    for name in diff.plugins_added:
        findings.append(IntegrityFinding(
            "plugin_added", "warn",
            f"Unauthorized plugin enabled: {name}",
        ))
    for name in diff.plugins_removed:
        findings.append(IntegrityFinding(
            "plugin_removed", "info",
            f"Plugin disabled since baseline: {name}",
        ))
    return findings


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _cli_snapshot(args: argparse.Namespace) -> int:
    snap = take_snapshot(trigger=args.trigger,
                         user_authorized=not args.unauthorized)
    if args.json:
        print(json.dumps(snap.to_dict(), ensure_ascii=False, indent=2))
    else:
        print(f"snapshot: ts={snap.ts} sha1={snap.sha1[:12]} "
              f"mcps={snap.mcps_count} hooks={snap.hooks_count} "
              f"plugins={snap.plugins_count} trigger={snap.trigger}")
    return 0


def _cli_diff(args: argparse.Namespace) -> int:
    diff = diff_against_last(authorized_only=not args.include_unauthorized)
    if args.json:
        print(json.dumps(diff.to_dict(), ensure_ascii=False, indent=2))
        return 0 if not diff.has_changes else 1
    print(f"baseline: {diff.base_ts}")
    print(f"current:  {diff.current_ts}")
    print(f"sha1_changed: {diff.sha1_changed}")
    for label, items in (
        ("mcps_added", diff.mcps_added),
        ("mcps_removed", diff.mcps_removed),
        ("hooks_added", diff.hooks_added),
        ("hooks_removed", diff.hooks_removed),
        ("plugins_added", diff.plugins_added),
        ("plugins_removed", diff.plugins_removed),
    ):
        if items:
            print(f"{label}:")
            for n in items:
                print(f"  - {n}")
    return 0 if not diff.has_changes else 1


def _cli_verify(args: argparse.Namespace) -> int:
    findings = verify()
    if args.json:
        print(json.dumps([f.to_dict() for f in findings],
                          ensure_ascii=False, indent=2))
    else:
        if not findings:
            print("settings integrity OK — no drift since baseline")
        else:
            for f in findings:
                print(f"  [{f.severity}] {f.finding_type}  {f.detail}")
    worst = "info"
    for f in findings:
        if f.severity == "blocking":
            worst = "blocking"
            break
        if f.severity == "warn":
            worst = "warn"
    return 2 if worst == "blocking" else (1 if worst == "warn" else 0)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="settings_integrity.py",
        description="ULTRON settings.json snapshot/diff/verify (S5-C).",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sn = sub.add_parser("snapshot", help="Take a snapshot of current settings.json")
    sn.add_argument("--trigger", default="manual",
                    choices=("manual", "auto", "sync"))
    sn.add_argument("--unauthorized", action="store_true",
                    help="Mark this snapshot as unauthorized (audit only).")
    sn.add_argument("--json", action="store_true")
    sn.set_defaults(func=_cli_snapshot)

    df = sub.add_parser("diff", help="Diff current state against last authorized snapshot")
    df.add_argument("--include-unauthorized", action="store_true")
    df.add_argument("--json", action="store_true")
    df.set_defaults(func=_cli_diff)

    vf = sub.add_parser("verify", help="Surface integrity findings for the doctor")
    vf.add_argument("--json", action="store_true")
    vf.set_defaults(func=_cli_verify)

    ns = p.parse_args(argv)
    return ns.func(ns)


if __name__ == "__main__":
    raise SystemExit(main())
