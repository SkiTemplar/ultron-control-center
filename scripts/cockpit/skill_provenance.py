"""ULTRON v14 Sprint 5-C — Skill Provenance Tracker.

Tracks origin + integrity hash of every installed skill. State stored in
``~/.ultron/skill-provenance.json``:

  {
    "schema_version": "1",
    "last_updated": "...",
    "skills": {
      "<name>": {
        "source_kind": "local|github|npm|marketplace|manual|unknown",
        "source_url": null,
        "installed_at": "...",
        "skill_md_sha1": "...",
        "trust_level": "trusted|untrusted",
        "scan_decision": "allow|warn|quarantine|block",
        "last_scanned": "..."
      }
    }
  }

The integrity hash detects tampering or post-install drift; the doctor's
new --security mode surfaces drift as a finding.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import sys
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

if sys.platform == "win32":
    import msvcrt  # type: ignore[import-not-found]
else:
    import fcntl  # type: ignore[import-not-found]

_COCKPIT_DIR = Path(__file__).resolve().parent
if str(_COCKPIT_DIR) not in sys.path:
    sys.path.insert(0, str(_COCKPIT_DIR))

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ULTRON_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / ".ultron"
CLAUDE_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / ".claude"
SKILLS_ROOT = CLAUDE_HOME / "skills"
PROVENANCE_FILE = ULTRON_HOME / "skill-provenance.json"

VALID_SOURCE_KINDS = ("local", "github", "npm", "marketplace", "manual", "unknown")


@dataclass(frozen=True)
class ProvenanceFinding:
    skill_name: str
    finding_type: str   # "drift" | "missing_record" | "missing_skill"
    severity: str       # "warn" | "blocking"
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _now_iso() -> str:
    return (_dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)
            .strftime("%Y-%m-%dT%H:%M:%SZ"))


# ---------------------------------------------------------------------------
# Atomic IO
# ---------------------------------------------------------------------------

def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        try:
            os.fsync(fh.fileno())
        except OSError:
            pass
    os.replace(str(tmp), str(path))


def _load_state() -> dict[str, Any]:
    if not PROVENANCE_FILE.exists():
        return {
            "schema_version": "1",
            "last_updated": _now_iso(),
            "skills": {},
        }
    try:
        data = json.loads(PROVENANCE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {
            "schema_version": "1",
            "last_updated": _now_iso(),
            "skills": {},
        }
    if not isinstance(data, dict) or not isinstance(data.get("skills"), dict):
        return {
            "schema_version": "1",
            "last_updated": _now_iso(),
            "skills": {},
        }
    data.setdefault("schema_version", "1")
    data.setdefault("last_updated", _now_iso())
    return data


def _save_state(state: dict[str, Any]) -> None:
    state["last_updated"] = _now_iso()
    _atomic_write_text(
        PROVENANCE_FILE,
        json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True),
    )


# ---------------------------------------------------------------------------
# F04 fix: cross-process lock for read-modify-write operations.
# Mirrors the alerts.py _LockedSection pattern (msvcrt on Windows, fcntl on
# POSIX, threading.Lock for in-process). Prevents lost writes when two
# processes race to record installs of different skills.
# ---------------------------------------------------------------------------

_PROCESS_LOCK = threading.Lock()
_LOCK_TIMEOUT_S = 5.0


class _LockedSection:
    """Context manager: in-process threading.Lock + cross-process file lock.

    Sidecar lock file at ``~/.ultron/skill-provenance.lock``. Best-effort
    with timeout — on lock timeout we degrade to "in-process lock only"
    rather than blocking caller indefinitely. Provenance writes must never
    hang the user's session.
    """

    def __init__(self) -> None:
        self._fd: int | None = None
        self._held_threading = False
        self._held_oslock = False

    def __enter__(self) -> "_LockedSection":
        _PROCESS_LOCK.acquire()
        self._held_threading = True
        try:
            ULTRON_HOME.mkdir(parents=True, exist_ok=True)
            lock_path = ULTRON_HOME / "skill-provenance.lock"
            self._fd = os.open(
                str(lock_path),
                os.O_WRONLY | os.O_CREAT
                | (os.O_BINARY if hasattr(os, "O_BINARY") else 0),
                0o644,
            )
            deadline = time.monotonic() + _LOCK_TIMEOUT_S
            while True:
                try:
                    if sys.platform == "win32":
                        msvcrt.locking(self._fd, msvcrt.LK_NBLCK, 1)
                    else:
                        fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self._held_oslock = True
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        # Degrade gracefully — in-process lock still held.
                        break
                    time.sleep(0.01)
        except OSError:
            self._fd = None
        return self

    def __exit__(self, *exc: Any) -> None:
        try:
            if self._fd is not None and self._held_oslock:
                try:
                    if sys.platform == "win32":
                        msvcrt.locking(self._fd, msvcrt.LK_UNLCK, 1)
                    else:
                        fcntl.flock(self._fd, fcntl.LOCK_UN)
                except OSError:
                    pass
            if self._fd is not None:
                try:
                    os.close(self._fd)
                except OSError:
                    pass
        finally:
            if self._held_threading:
                _PROCESS_LOCK.release()


def read_state() -> dict[str, Any]:
    """Public read helper — load + return the current provenance state.

    F04: exposed so callers (e.g. skill_sync_security.scan_all_installed)
    can look up provenance without reaching into a private symbol.
    """
    return _load_state()


# ---------------------------------------------------------------------------
# Hashing
# ---------------------------------------------------------------------------

def compute_skill_md_sha1(skill_path: Path) -> str:
    """Compute sha1 of the skill's SKILL.md. Empty string if missing."""
    skill_path = Path(skill_path)
    if skill_path.is_file():
        target = skill_path
    else:
        target = skill_path / "SKILL.md"
    if not target.exists():
        return ""
    h = hashlib.sha1(usedforsecurity=False)
    try:
        with target.open("rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
    except OSError:
        return ""
    return h.hexdigest()


def _infer_source_kind(source: str | None) -> str:
    if not source:
        return "unknown"
    s = source.strip().lower()
    if s in ("local", "auto-discover", "built-in", "persona"):
        return "local"
    # marketplace comes before npm so '@addy-agent-skills' is classified
    # correctly (it has a leading '@' but is a marketplace, not an npm pkg).
    if "marketplace" in s or "@addy-agent-skills" in s or "@superpowers" in s:
        return "marketplace"
    if s.startswith("github:") or "github.com" in s:
        return "github"
    if s.startswith("npm:") or s.startswith("@") or "npm" in s:
        return "npm"
    if "manual" in s:
        return "manual"
    return "unknown"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def record_install(skill_name: str, source_kind: str = "unknown",
                   source_url: str | None = None,
                   declared_source: str | None = None,
                   skill_path: Path | None = None,
                   trust_level: str = "untrusted",
                   scan_decision: str = "allow") -> None:
    """Record a skill install. Idempotent — overwrites the entry.

    F04 fix: wrapped in cross-process lock so two processes recording
    different skills never produce a lost write.

    F-MaxDual-R2-Cnew2: ``source_url`` MUST come from a trusted external
    fetch path (installer, package registry, signed manifest). The
    untrusted ``source`` value declared inside the SKILL.md frontmatter
    must be passed via ``declared_source`` only — that field is purely
    informational and is NEVER consulted by the security scanner for
    trust decisions.
    """
    if not isinstance(skill_name, str) or not skill_name.strip():
        return
    if source_kind not in VALID_SOURCE_KINDS:
        source_kind = "unknown"
    sp = skill_path or (SKILLS_ROOT / skill_name)
    sha1 = compute_skill_md_sha1(sp) if sp.exists() else ""
    with _LockedSection():
        state = _load_state()
        now = _now_iso()
        record = state["skills"].get(skill_name, {})
        record.update({
            "source_kind": source_kind,
            "source_url": source_url,
            "declared_source": declared_source,
            "installed_at": record.get("installed_at", now),
            "skill_md_sha1": sha1,
            "trust_level": trust_level,
            "scan_decision": scan_decision,
            "last_scanned": now,
        })
        state["skills"][skill_name] = record
        _save_state(state)


def update_scan_result(skill_name: str, scan_decision: str,
                        skill_path: Path | None = None) -> None:
    """Record latest scan_decision + refresh last_scanned + refresh sha1."""
    if not isinstance(skill_name, str) or not skill_name.strip():
        return
    sp = skill_path or (SKILLS_ROOT / skill_name)
    sha1 = compute_skill_md_sha1(sp) if sp.exists() else ""
    with _LockedSection():
        state = _load_state()
        now = _now_iso()
        record = state["skills"].setdefault(skill_name, {
            "source_kind": "unknown",
            "source_url": None,
            "installed_at": now,
            "skill_md_sha1": "",
            "trust_level": "untrusted",
            "scan_decision": "allow",
            "last_scanned": now,
        })
        record["scan_decision"] = scan_decision
        record["last_scanned"] = now
        record["skill_md_sha1"] = sha1
        _save_state(state)


def verify_integrity(skills_root: Path | None = None) -> list[ProvenanceFinding]:
    """Diff current SKILL.md sha1s vs recorded. Returns drift findings.

    `missing_record`  — skill on disk but not in provenance file (warn).
    `drift`           — sha1 changed since last record (warn).
    `missing_skill`   — provenance has it but disk doesn't (warn).
    """
    root = skills_root or SKILLS_ROOT
    state = _load_state()
    recorded: dict[str, dict[str, Any]] = state.get("skills", {})
    on_disk: set[str] = set()
    findings: list[ProvenanceFinding] = []

    if root.exists():
        for d in root.iterdir():
            if not d.is_dir():
                continue
            if d.name.startswith(".") or d.name == "__pycache__":
                continue
            if not (d / "SKILL.md").exists():
                continue
            on_disk.add(d.name)
            cur_sha = compute_skill_md_sha1(d)
            rec = recorded.get(d.name)
            if not rec:
                findings.append(ProvenanceFinding(
                    skill_name=d.name,
                    finding_type="missing_record",
                    severity="warn",
                    detail=f"Skill on disk has no provenance record. "
                           f"path={d} sha1={cur_sha}",
                ))
                continue
            recorded_sha = rec.get("skill_md_sha1") or ""
            if recorded_sha and cur_sha and recorded_sha != cur_sha:
                findings.append(ProvenanceFinding(
                    skill_name=d.name,
                    finding_type="drift",
                    severity="warn",
                    detail=(f"SKILL.md sha1 drift: "
                            f"recorded={recorded_sha[:12]} actual={cur_sha[:12]} "
                            f"path={d}"),
                ))

    for name in recorded.keys():
        if name not in on_disk:
            findings.append(ProvenanceFinding(
                skill_name=name,
                finding_type="missing_skill",
                severity="warn",
                detail=f"Skill in provenance but absent on disk: "
                       f"{root / name}",
            ))

    return findings


def audit() -> dict[str, Any]:
    """Full report consumed by doctor --security."""
    state = _load_state()
    findings = verify_integrity()
    return {
        "generated_at": _now_iso(),
        "total_recorded": len(state.get("skills", {})),
        "findings": [f.to_dict() for f in findings],
        "by_kind": {
            kind: sum(1 for r in state.get("skills", {}).values()
                      if r.get("source_kind") == kind)
            for kind in VALID_SOURCE_KINDS
        },
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _cli_record(args: argparse.Namespace) -> int:
    record_install(
        args.skill_name,
        source_kind=args.source_kind or _infer_source_kind(args.source_url),
        source_url=args.source_url,
        trust_level=args.trust_level,
        scan_decision=args.scan_decision,
    )
    print(f"recorded: {args.skill_name}")
    return 0


def _cli_verify(args: argparse.Namespace) -> int:
    findings = verify_integrity()
    if args.json:
        print(json.dumps([f.to_dict() for f in findings], indent=2,
                          ensure_ascii=False))
    else:
        if not findings:
            print("integrity OK — no drift, no missing records")
        else:
            for f in findings:
                print(f"  [{f.severity}] {f.finding_type}  {f.skill_name}")
                print(f"    {f.detail}")
    return 0 if not findings else 1


def _cli_audit(args: argparse.Namespace) -> int:
    rep = audit()
    if args.json:
        print(json.dumps(rep, ensure_ascii=False, indent=2))
    else:
        print(f"recorded: {rep['total_recorded']}  "
              f"findings: {len(rep['findings'])}")
        for k, n in rep["by_kind"].items():
            print(f"  {k:<12} {n}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="skill_provenance.py",
        description="ULTRON skill provenance & integrity tracker (S5-C).",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("record", help="Record an install.")
    r.add_argument("skill_name")
    r.add_argument("--source-kind", default=None,
                   choices=list(VALID_SOURCE_KINDS) + [None])
    r.add_argument("--source-url", default=None)
    r.add_argument("--trust-level", default="untrusted",
                   choices=("trusted", "untrusted"))
    r.add_argument("--scan-decision", default="allow",
                   choices=("allow", "warn", "quarantine", "block"))
    r.set_defaults(func=_cli_record)

    v = sub.add_parser("verify", help="Verify integrity of recorded skills.")
    v.add_argument("--json", action="store_true")
    v.set_defaults(func=_cli_verify)

    a = sub.add_parser("audit", help="Full provenance + integrity audit.")
    a.add_argument("--json", action="store_true")
    a.set_defaults(func=_cli_audit)

    ns = p.parse_args(argv)
    return ns.func(ns)


if __name__ == "__main__":
    raise SystemExit(main())
