#!/usr/bin/env python3
"""
ULTRON v10.6 - L3 AutoUpdater Apply (mechanical + typed ApplyManifest).

Reads proposals/<skill>-<date>.json and applies them deterministically:
  - skips entries with old_string == "" (L2 didn't have full context)
  - skips entries with false_positive_risk == "high"
  - verifies old_string is UNIQUELY present in target_file (no ambiguity)
  - performs replacement via str.replace(old, new, 1) and atomic write
  - backs up target before first edit

v10.6 — Typed ApplyManifest (Codex/Gemini Triple Max recommendation):
  - SHA-256 hash of target before + after each edit
  - Preconditions: file exists, is readable, contains expected substring
  - Expected tests: optional test commands listed per proposal (run if --check)
  - Rollback plan: backup path + reverse-apply script auto-generated
  - Reviewer signature: --signed flag records the user's confirmation

Output formats:
  - proposals/<stem>.applied.json     summary log per run
  - proposals/<stem>.manifest.json    typed ApplyManifest with hashes/preconditions

Usage:
    apply_proposals.py apply <file>                # apply all actionable
    apply_proposals.py apply <file> --dry-run      # preview only
    apply_proposals.py apply <file> --only REF     # single proposal
    apply_proposals.py apply <file> --check        # also run expected_tests
    apply_proposals.py apply <file> --signed       # record reviewer confirmation
    apply_proposals.py rollback <manifest>         # reverse a manifest
    apply_proposals.py verify <manifest>           # confirm hashes still match
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import COCKPIT_DIR, USER_HOME  # noqa: E402

SKILLS_DIR = USER_HOME / ".claude" / "skills"
PROPOSALS_DIR = COCKPIT_DIR / "proposals"


def resolve_target(skill_name: str, target_file: str) -> Path | None:
    """proposals reference target_file like 'SKILL.md' or 'references/foo.md'.
    Resolve relative to the skill directory."""
    base = SKILLS_DIR / skill_name
    if not base.exists():
        return None
    candidate = base / target_file
    if candidate.exists():
        return candidate
    return None


def is_actionable(p: dict) -> tuple[bool, str]:
    """Return (ok, reason). False means skip with reason."""
    if p.get("false_positive_risk") == "high":
        return False, "false_positive_risk=high (human review required)"
    old = p.get("old_string", "")
    if not old:
        return False, "old_string is empty (L2 incomplete context)"
    new = p.get("new_string")
    if new is None:
        return False, "new_string missing"
    if old == new:
        return False, "old_string == new_string (no-op)"
    if not p.get("target_file"):
        return False, "target_file missing"
    return True, ""


def verify_match(text: str, old: str) -> tuple[bool, str]:
    """Verify old appears EXACTLY once in text. Multiple matches = ambiguous."""
    count = text.count(old)
    if count == 0:
        return False, "old_string not found in target"
    if count > 1:
        return False, f"old_string matches {count} times (ambiguous)"
    return True, ""


def infer_skill_from_proposals_file(path: Path) -> str | None:
    """proposals/<skill>-YYYY-MM-DD.json -> skill name."""
    m = path.stem.rsplit("-", 3)
    if len(m) >= 4:
        return "-".join(m[:-3])
    return None


def _sha256_file(path: Path) -> str:
    """SHA-256 of a file's bytes. Used for manifest preconditions."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def apply_one(target_path: Path, old: str, new: str) -> None:
    """Atomic edit: read → replace → tmp → rename."""
    text = target_path.read_text(encoding="utf-8")
    new_text = text.replace(old, new, 1)
    tmp = target_path.with_suffix(target_path.suffix + ".tmp")
    tmp.write_text(new_text, encoding="utf-8")
    tmp.replace(target_path)


def check_preconditions(target_path: Path, old: str) -> tuple[bool, str]:
    """v10.6 manifest preconditions: file exists, readable, contains old_string
    EXACTLY ONCE (uniqueness already covered by verify_match but re-checked
    here as a separate gate so manifests are auditable)."""
    if not target_path.exists():
        return False, f"target missing: {target_path}"
    if not target_path.is_file():
        return False, f"target not a regular file: {target_path}"
    try:
        text = target_path.read_text(encoding="utf-8")
    except OSError as e:
        return False, f"target not readable: {e}"
    count = text.count(old)
    if count == 0:
        return False, "precondition: old_string absent"
    if count > 1:
        return False, f"precondition: old_string appears {count} times"
    return True, ""


def run_expected_tests(tests: list[str], cwd: Path) -> list[dict]:
    """Run optional `expected_tests` declared on a proposal (e.g.
    ['python -m pytest tests/foo']). Returns per-test exit codes. Tests run
    AFTER the apply succeeds so they validate the resulting state."""
    out = []
    for cmd in tests:
        if not isinstance(cmd, str) or not cmd.strip():
            continue
        try:
            r = subprocess.run(cmd, shell=False, cwd=cwd,
                               capture_output=True, text=True, timeout=120,
                               encoding="utf-8", errors="replace", creationflags=_WIN_HIDDEN)
            out.append({
                "cmd": cmd,
                "exit_code": r.returncode,
                "ok": r.returncode == 0,
                "stdout_tail": (r.stdout or "")[-300:],
                "stderr_tail": (r.stderr or "")[-300:],
            })
        except (OSError, subprocess.TimeoutExpired) as e:
            out.append({"cmd": cmd, "exit_code": -1, "ok": False,
                        "error": str(e)})
    return out


def cmd_apply(args) -> int:
    proposals_path = Path(args.proposals_file).resolve()
    if not proposals_path.exists():
        print(f"[apply] proposals file not found: {proposals_path}")
        return 1

    try:
        data = json.loads(proposals_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"[apply] invalid JSON: {e}")
        return 1

    proposals = data.get("proposals", [])
    if not proposals:
        print("[apply] no proposals in file")
        return 0

    skill_name = infer_skill_from_proposals_file(proposals_path)
    if not skill_name:
        print(f"[apply] cannot infer skill from filename: {proposals_path.stem}")
        return 1
    print(f"[apply] skill={skill_name}  proposals={len(proposals)}  "
          f"file={proposals_path.name}")

    only = getattr(args, "only", None)
    dry = getattr(args, "dry_run", False)
    check_tests = getattr(args, "check", False)
    signed = getattr(args, "signed", False)

    # Group proposals by target file so we backup once per file
    by_target: dict[Path, list[dict]] = {}
    for p in proposals:
        if only and p.get("finding_ref") != only:
            continue
        target_file = p.get("target_file", "SKILL.md")
        target_path = resolve_target(skill_name, target_file)
        if not target_path:
            print(f"  [skip] {p.get('finding_ref','?'):<50} target {target_file} "
                  f"not found")
            continue
        by_target.setdefault(target_path, []).append(p)

    results = []
    backups: dict[Path, Path] = {}
    manifest_entries = []  # v10.6: typed ApplyManifest

    for target_path, plist in by_target.items():
        for p in plist:
            ref = p.get("finding_ref", "?")
            ok, reason = is_actionable(p)
            if not ok:
                print(f"  [skip] {ref:<50} {reason}")
                results.append({"finding_ref": ref, "status": "skipped",
                                "reason": reason})
                continue

            # v10.6: explicit precondition gate (auditable in manifest)
            ok, reason = check_preconditions(target_path, p["old_string"])
            if not ok:
                print(f"  [skip] {ref:<50} {reason}")
                results.append({"finding_ref": ref, "status": "skipped",
                                "reason": reason})
                continue

            # Re-read target each iteration: previous edit may have changed it
            current_text = target_path.read_text(encoding="utf-8")
            ok, reason = verify_match(current_text, p["old_string"])
            if not ok:
                print(f"  [skip] {ref:<50} {reason}")
                results.append({"finding_ref": ref, "status": "skipped",
                                "reason": reason})
                continue

            if dry:
                print(f"  [DRY ] {ref:<50} would apply ({len(p['old_string'])}b "
                      f"-> {len(p['new_string'])}b)")
                results.append({"finding_ref": ref, "status": "dry-run-ok"})
                continue

            # v10.6: hash BEFORE for the manifest
            hash_before = _sha256_file(target_path)

            # Backup target once before first real edit
            if target_path not in backups:
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                backup_path = target_path.with_suffix(
                    target_path.suffix + f".{stamp}.bak")
                shutil.copy2(target_path, backup_path)
                backups[target_path] = backup_path
                print(f"  [bkup] {target_path.name} -> {backup_path.name}")

            try:
                apply_one(target_path, p["old_string"], p["new_string"])
                hash_after = _sha256_file(target_path)
                print(f"  [APLY] {ref:<50} OK")
                results.append({"finding_ref": ref, "status": "applied",
                                "target": str(target_path)})
                # v10.6: record typed manifest entry
                entry = {
                    "finding_ref": ref,
                    "severity": p.get("severity"),
                    "target": str(target_path),
                    "hash_before": hash_before,
                    "hash_after": hash_after,
                    "backup": str(backups[target_path]),
                    "old_len": len(p["old_string"]),
                    "new_len": len(p["new_string"]),
                    "preconditions_passed": True,
                    "expected_tests": p.get("expected_tests", []) or [],
                    "test_results": [],
                }
                if check_tests and entry["expected_tests"]:
                    entry["test_results"] = run_expected_tests(
                        entry["expected_tests"],
                        cwd=Path(target_path).parent,
                    )
                    failed = sum(1 for t in entry["test_results"]
                                 if not t.get("ok"))
                    if failed:
                        print(f"  [TEST] {ref}: {failed} expected_tests failed")
                manifest_entries.append(entry)
            except OSError as e:
                print(f"  [FAIL] {ref:<50} {e}")
                results.append({"finding_ref": ref, "status": "error",
                                "reason": str(e)})

    applied = sum(1 for r in results if r["status"] == "applied")
    skipped = sum(1 for r in results if r["status"] == "skipped")
    errors = sum(1 for r in results if r["status"] == "error")
    print()
    print(f"[apply] applied={applied}  skipped={skipped}  errors={errors}  "
          f"total={len(results)}")

    # Persist apply log + typed manifest
    if not dry:
        applied_log = proposals_path.with_suffix(".applied.json")
        log = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "skill": skill_name,
            "source": str(proposals_path),
            "applied": applied,
            "skipped": skipped,
            "errors": errors,
            "backups": {str(k): str(v) for k, v in backups.items()},
            "results": results,
        }
        applied_log.write_text(json.dumps(log, indent=2, ensure_ascii=False),
                               encoding="utf-8")
        print(f"[apply] log: {applied_log.name}")

        # v10.6: typed ApplyManifest with hashes/preconditions/rollback
        if manifest_entries:
            manifest_path = proposals_path.with_suffix(".manifest.json")
            manifest = {
                "version": "1.0",
                "ts": datetime.now().isoformat(timespec="seconds"),
                "skill": skill_name,
                "source_proposals": str(proposals_path),
                "applied_log": str(applied_log),
                "reviewer": os.environ.get("USER", os.environ.get("USERNAME", "unsigned")) if signed else "unsigned",
                "signed_at": datetime.now().isoformat(timespec="seconds")
                              if signed else None,
                "rollback_plan": {
                    "method": "shutil.copy2(backup, target)",
                    "backups": {str(k): str(v) for k, v in backups.items()},
                },
                "entries": manifest_entries,
            }
            manifest_path.write_text(
                json.dumps(manifest, indent=2, ensure_ascii=False),
                encoding="utf-8")
            print(f"[apply] manifest: {manifest_path.name} "
                  f"(reviewer={manifest['reviewer']})")

        # FIX-A (v13.2): resolve pending_actions for each applied finding_ref.
        # Closes the apply↔pending gap: audit trail existed but queue stayed open.
        if applied > 0:
            _resolved = 0
            _resolve_errors: list[str] = []
            try:
                import importlib.util
                _pa_path = Path(__file__).parent / "pending_actions.py"
                _spec = importlib.util.spec_from_file_location("pending_actions", _pa_path)
                _pa = importlib.util.module_from_spec(_spec)
                _spec.loader.exec_module(_pa)
                for r in results:
                    if r.get("status") == "applied":
                        ref = r.get("finding_ref", "")
                        if not ref:
                            continue
                        try:
                            ok = _pa.resolve_action(
                                ref,
                                note=f"auto-resolved by apply_proposals [{proposals_path.name}]",
                            )
                            if ok:
                                _resolved += 1
                            else:
                                _resolve_errors.append(
                                    f"{ref}: no pending_action with id={ref!r} "
                                    f"(finding_ref mismatch — add pending action manually)"
                                )
                        except Exception as _e:
                            _resolve_errors.append(f"{ref}: {_e}")
            except Exception as _e:
                print(f"[apply] warning: could not load pending_actions.py: {_e}",
                      file=sys.stderr)
            if _resolved:
                print(f"[apply] queue: resolved {_resolved} pending action(s)")
            for _err in _resolve_errors:
                print(f"[apply] warning: queue resolve failed — {_err}", file=sys.stderr)

        # Mark source proposals file as consumed (atomic flag)
        if applied > 0 and errors == 0 and skipped < len(proposals):
            data["status"] = "consumed"
            data["consumed_at"] = datetime.now().isoformat(timespec="seconds")
            proposals_path.write_text(
                json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    return 0 if errors == 0 else 2


def cmd_list(_args) -> int:
    """List proposals files with status (consumed vs pending)."""
    if not PROPOSALS_DIR.exists():
        print("[apply] no proposals directory")
        return 0
    files = sorted(PROPOSALS_DIR.glob("*.json"),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    pending = [f for f in files if not f.stem.endswith(".applied")]
    if not pending:
        print("[apply] no proposals on disk")
        return 0
    print("PENDING PROPOSALS")
    print("=" * 70)
    for f in pending[:20]:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        proposals = data.get("proposals", [])
        actionable = [p for p in proposals
                      if p.get("old_string")
                      and p.get("false_positive_risk") in (None, "none", "low")]
        status = data.get("status", "pending")
        mtime = datetime.fromtimestamp(f.stat().st_mtime)
        print(f"  {mtime:%Y-%m-%d %H:%M}  {f.stem:<35}  "
              f"{len(actionable)}/{len(proposals)} actionable  [{status}]")
    return 0


def cmd_verify(args) -> int:
    """v10.6: confirm hash_after still matches the file on disk for every
    manifest entry. Detects drift since apply (manual edits, other writers)."""
    manifest_path = Path(args.manifest_file).resolve()
    if not manifest_path.exists():
        print(f"[verify] manifest not found: {manifest_path}")
        return 1
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"[verify] invalid JSON: {e}")
        return 1
    entries = manifest.get("entries", [])
    if not entries:
        print("[verify] manifest has no entries")
        return 0
    drift = 0
    for e in entries:
        target = Path(e["target"])
        ref = e.get("finding_ref", "?")
        if not target.exists():
            print(f"  [GONE] {ref:<40} {target}")
            drift += 1
            continue
        current = _sha256_file(target)
        expected = e.get("hash_after")
        if current == expected:
            print(f"  [OK  ] {ref:<40} hash matches")
        else:
            print(f"  [DRIFT] {ref:<40} hash diverged from manifest")
            drift += 1
    print()
    print(f"[verify] {len(entries) - drift}/{len(entries)} entries match")
    return 0 if drift == 0 else 2


def cmd_rollback(args) -> int:
    """v10.6: reverse a typed ApplyManifest by restoring backups in order.
    Each entry's `backup` is copied back to its `target`. Verifies hash_before
    matches the backup before restoring (safety net)."""
    manifest_path = Path(args.manifest_file).resolve()
    if not manifest_path.exists():
        print(f"[rollback] manifest not found: {manifest_path}")
        return 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = manifest.get("entries", [])
    if not entries:
        print("[rollback] manifest empty")
        return 0
    dry = getattr(args, "dry_run", False)
    print(f"[rollback] manifest from {manifest.get('ts','?')} - "
          f"{len(entries)} entries")
    # v10.6.1 fix (Codex Ultra TripleMax CORNERS): when multiple entries
    # touched the same target, ALL share the SAME backup (taken before the
    # first edit). Iterating per-entry with hash_before validation would
    # FAIL for entries 2..N because their hash_before reflects the post-
    # entry-1 state, not the pre-batch state. Solution: collapse entries
    # by target and restore each unique backup ONCE, validating only the
    # FIRST entry's hash_before (which matches the backup).
    by_target: dict[str, list[dict]] = {}
    for e in entries:
        by_target.setdefault(e["target"], []).append(e)

    restored = 0
    errors = 0
    for target_str, target_entries in by_target.items():
        # First entry wrote the backup → its hash_before == backup contents
        first = target_entries[0]
        ref = first.get("finding_ref", "?")
        target = Path(target_str)
        backup = Path(first["backup"])
        n_entries = len(target_entries)
        suffix = f" (collapses {n_entries} entries)" if n_entries > 1 else ""
        if not backup.exists():
            print(f"  [FAIL] {target.name:<32} backup missing: {backup.name}")
            errors += 1
            continue
        backup_hash = _sha256_file(backup)
        expected = first.get("hash_before")
        if expected and backup_hash != expected:
            print(f"  [FAIL] {target.name:<32} backup hash != hash_before "
                  f"(first entry: {ref}){suffix}")
            errors += 1
            continue
        if dry:
            print(f"  [DRY ] {target.name:<32} would restore {backup.name}{suffix}")
            continue
        try:
            shutil.copy2(backup, target)
            print(f"  [REST] {target.name:<32} restored from {backup.name}{suffix}")
            restored += 1
        except OSError as e:
            print(f"  [FAIL] {target.name:<32} {e}")
            errors += 1
    print()
    print(f"[rollback] restored={restored} errors={errors} "
          f"total={len(entries)}")
    return 0 if errors == 0 else 2


def main():
    p = argparse.ArgumentParser(
        description="ULTRON L3 AutoUpdater Apply (mechanical + typed manifest)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("apply", help="Apply actionable proposals from file")
    sp.add_argument("proposals_file", help="Path to proposals JSON")
    sp.add_argument("--dry-run", action="store_true",
                    help="Preview without writing")
    sp.add_argument("--only", help="Apply only the proposal with this finding_ref")
    sp.add_argument("--check", action="store_true",
                    help="Run expected_tests after each apply")
    sp.add_argument("--signed", action="store_true",
                    help="Mark manifest reviewer=<OS user> (audit trail)")
    sp.set_defaults(func=cmd_apply)

    sp = sub.add_parser("list", help="List pending proposal files")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("verify",
                         help="Verify a manifest against current filesystem")
    sp.add_argument("manifest_file")
    sp.set_defaults(func=cmd_verify)

    sp = sub.add_parser("rollback", help="Reverse a typed ApplyManifest")
    sp.add_argument("manifest_file")
    sp.add_argument("--dry-run", action="store_true")
    sp.set_defaults(func=cmd_rollback)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
