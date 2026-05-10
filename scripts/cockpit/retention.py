#!/usr/bin/env python3
"""
ULTRON v10.0 Cockpit - Retention + rotation policy.

Cleans up old log files according to retention rules:
  - routing.jsonl                30 days  (kept-rotated)
  - sessions/<date>/*.json       7 days   (Codex/Gemini snapshots)
  - news/*.md                    30 days  (excluding ALERTS.md)
  - settings.json.*.bak          90 days
  - cockpit/scheduler-logs/*.log keep last 5 by mtime

Run: python retention.py [--dry-run] [--verbose]
Triggered by Task Scheduler daily.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import Cockpit, COCKPIT_DIR, NEWS_DIR  # noqa: E402


USER_HOME = Path.home()
ROUTING_JSONL = USER_HOME / ".ultron" / "sessions"  # routing.jsonl lives in dated subdirs
SETTINGS_BACKUPS = USER_HOME / ".claude"  # settings.json.*.bak
SCHEDULER_LOGS = COCKPIT_DIR / "scheduler-logs"


def rotate_jsonl_in_place(path: Path, retention_days: int, dry_run: bool, verbose: bool) -> tuple[int, int]:
    """Use Cockpit.rotate_jsonl helper. Returns (kept, dropped)."""
    if not path.exists():
        return (0, 0)
    before = sum(1 for _ in path.read_text(encoding="utf-8").splitlines() if _.strip())
    if dry_run:
        # Count what WOULD be kept
        cutoff = datetime.now() - timedelta(days=retention_days)
        kept = 0
        import json as _json
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                ts = datetime.fromisoformat(_json.loads(line).get("ts", ""))
                if ts >= cutoff:
                    kept += 1
            except Exception:
                continue
        return (kept, before - kept)

    Cockpit.rotate_jsonl(path, retention_days=retention_days)
    after = sum(1 for _ in path.read_text(encoding="utf-8").splitlines() if _.strip()) if path.exists() else 0
    return (after, before - after)


def delete_files_older_than(root: Path, days: int, pattern: str = "*",
                            recursive: bool = False, exclude: set | None = None,
                            dry_run: bool = False, verbose: bool = False) -> tuple[int, int]:
    """Delete files matching `pattern` under `root` whose mtime is older than `days`.
    Returns (deleted, kept)."""
    if not root.exists():
        return (0, 0)
    cutoff = (datetime.now() - timedelta(days=days)).timestamp()
    exclude = exclude or set()
    deleted = 0
    kept = 0

    glob_fn = root.rglob if recursive else root.glob
    for f in glob_fn(pattern):
        if not f.is_file():
            continue
        if f.name in exclude:
            kept += 1
            continue
        try:
            if f.stat().st_mtime < cutoff:
                if verbose:
                    print(f"  [del] {f}")
                if not dry_run:
                    f.unlink()
                deleted += 1
            else:
                kept += 1
        except OSError:
            kept += 1
    return (deleted, kept)


def keep_last_n(root: Path, pattern: str, n: int, dry_run: bool, verbose: bool) -> tuple[int, int]:
    """Keep the N most-recently-modified files matching pattern. Delete the rest."""
    if not root.exists():
        return (0, 0)
    files = sorted(root.glob(pattern), key=lambda f: f.stat().st_mtime, reverse=True)
    kept = files[:n]
    to_delete = files[n:]
    for f in to_delete:
        if verbose:
            print(f"  [del] {f}")
        if not dry_run:
            try:
                f.unlink()
            except OSError:
                pass
    return (len(to_delete), len(kept))


def main():
    p = argparse.ArgumentParser(description="ULTRON Cockpit retention/rotation")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--verbose", "-v", action="store_true")
    p.add_argument("--from-cron", action="store_true",
                   help="(Internal) Apply daily skip-guard. Manual runs always execute.")
    args = p.parse_args()

    # Daily guard ONLY from cron. Manual runs always execute.
    if args.from_cron and not args.dry_run:
        from should_run import should_run_today
        if not should_run_today("retention"):
            print("[retention] Cron skip (already ran today)")
            return 0

    print(f"[retention] Run @ {datetime.now().isoformat(timespec='seconds')}{' (dry-run)' if args.dry_run else ''}")

    # 1. Routing telemetry per-day (30d)
    if ROUTING_JSONL.exists():
        for date_dir in ROUTING_JSONL.iterdir():
            if not date_dir.is_dir():
                continue
            jsonl = date_dir / "routing.jsonl"
            if jsonl.exists():
                kept, dropped = rotate_jsonl_in_place(jsonl, 30, args.dry_run, args.verbose)
                if dropped > 0 and args.verbose:
                    print(f"[retention] {jsonl.relative_to(USER_HOME)}: kept={kept} dropped={dropped}")
        # Also delete entire date dirs older than 30d (cleanup empties)
        deleted, kept = delete_files_older_than(
            ROUTING_JSONL, 30, pattern="*", recursive=True,
            dry_run=args.dry_run, verbose=args.verbose,
        )
        print(f"[retention] routing/sessions files: deleted={deleted} kept={kept} (30d)")

    # 3. News digests (30d, but keep ALERTS.md forever)
    if NEWS_DIR.exists():
        deleted, kept = delete_files_older_than(
            NEWS_DIR, 30, pattern="*.md",
            exclude={"ALERTS.md"},
            dry_run=args.dry_run, verbose=args.verbose,
        )
        print(f"[retention] news/*.md: deleted={deleted} kept={kept} (30d, ALERTS preserved)")

    # 4. settings.json backups (90d)
    deleted, kept = delete_files_older_than(
        SETTINGS_BACKUPS, 90, pattern="settings.json.*.bak",
        dry_run=args.dry_run, verbose=args.verbose,
    )
    print(f"[retention] settings.json.*.bak: deleted={deleted} kept={kept} (90d)")

    # 5. Scheduler logs - keep last 5
    if SCHEDULER_LOGS.exists():
        deleted, kept = keep_last_n(SCHEDULER_LOGS, "*.log", n=5,
                                     dry_run=args.dry_run, verbose=args.verbose)
        if deleted or kept:
            print(f"[retention] scheduler-logs: deleted={deleted} kept={kept} (last 5)")

    # 6. v10.5: projects.json backups - keep last 10 (was unbounded → 12+ build-up)
    deleted, kept = keep_last_n(COCKPIT_DIR, "projects.json.*.bak", n=10,
                                 dry_run=args.dry_run, verbose=args.verbose)
    if deleted or kept:
        print(f"[retention] projects.json.*.bak: deleted={deleted} kept={kept} (last 10)")

    # 7. v10.5: auto_updater.jsonl rotation (60d, mirrors activity)
    auto_log = COCKPIT_DIR / "auto_updater.jsonl"
    if auto_log.exists():
        kept, dropped = rotate_jsonl_in_place(auto_log, 60, args.dry_run, args.verbose)
        print(f"[retention] auto_updater.jsonl: kept={kept} dropped={dropped} (60d)")

    # 8. v10.5: SKILL.md backups under skills dirs (30d - per-skill rotation)
    skills_root = USER_HOME / ".claude" / "skills"
    if skills_root.exists():
        total_deleted = 0
        total_kept = 0
        for skill_dir in skills_root.iterdir():
            if not skill_dir.is_dir():
                continue
            for pattern in ("SKILL.md.*.bak", "*.md.*.bak"):
                d, k = delete_files_older_than(
                    skill_dir, 30, pattern=pattern,
                    dry_run=args.dry_run, verbose=args.verbose,
                )
                total_deleted += d
                total_kept += k
        if total_deleted or total_kept:
            print(f"[retention] skills/**/*.md.*.bak: deleted={total_deleted} "
                  f"kept={total_kept} (30d)")

    # 9. v10.5: applied proposals (.applied.json) - keep last 30
    proposals_dir = COCKPIT_DIR / "proposals"
    if proposals_dir.exists():
        deleted, kept = keep_last_n(proposals_dir, "*.applied.json", n=30,
                                     dry_run=args.dry_run, verbose=args.verbose)
        if deleted or kept:
            print(f"[retention] *.applied.json: deleted={deleted} kept={kept} "
                  f"(last 30)")

    # 10. v12.5.0-fix2 (F9): audit index + retention 30d (archive, never delete)
    try:
        import audit_index  # type: ignore
        ns = argparse.Namespace(retention_days=30, dry_run=args.dry_run)
        audit_index.cmd_run(ns)
    except Exception as exc:
        print(f"[retention] audit_index error (non-fatal): {exc}")

    # 11. v14.1: sessions/*.md notes >90d → archive (never delete)
    sessions_root = USER_HOME / ".ultron" / "sessions"
    if sessions_root.exists():
        archive_root = USER_HOME / ".ultron" / "archive" / "sessions"
        cutoff = (datetime.now() - timedelta(days=90)).timestamp()
        archived = 0
        for date_dir in sessions_root.iterdir():
            if not date_dir.is_dir():
                continue
            for md_file in date_dir.glob("*.md"):
                try:
                    if md_file.stat().st_mtime < cutoff:
                        dest_dir = archive_root / date_dir.name
                        if not args.dry_run:
                            dest_dir.mkdir(parents=True, exist_ok=True)
                            md_file.rename(dest_dir / md_file.name)
                        archived += 1
                        if args.verbose:
                            print(f"  [archive] {md_file}")
                except OSError:
                    pass
        if archived:
            print(f"[retention] sessions/*.md >90d: archived={archived}")

    # 12. v14.1: dispatcher-events.jsonl rotation (60d) — guard: file may not exist
    telemetry_dir = USER_HOME / ".ultron" / "cockpit" / "telemetry"
    dispatcher_log = telemetry_dir / "dispatcher-events.jsonl"
    if dispatcher_log.exists():
        kept, dropped = rotate_jsonl_in_place(dispatcher_log, 60, args.dry_run, args.verbose)
        print(f"[retention] dispatcher-events.jsonl: kept={kept} dropped={dropped} (60d)")

    if args.from_cron and not args.dry_run:
        from should_run import mark_ran_today
        mark_ran_today("retention")
    print("[retention] Done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
