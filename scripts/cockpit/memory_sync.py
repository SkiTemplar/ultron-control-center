#!/usr/bin/env python3
"""
ULTRON v12 "The Brain Update" — Memory L2 sync utility.

Manages the L2 vault (~/.ultron-vault/) — git status, sync, push.
Designed to be cheap (under 200ms in no-op case, no API calls).

Usage:
    memory_sync.py status       Show vault size, file count, last commit, dirty?
    memory_sync.py sync         Stage + commit + push (only if dirty)
    memory_sync.py push         Push to remote (assumes already committed)
    memory_sync.py mode <m>     Set current session mode (HIGH/ULTRA/LEARN/MEDIUM/LOW)
    memory_sync.py should-push  Exit 0 if last session was HIGH+, else exit 1
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

VAULT = Path.home() / ".ultron-vault"
ULTRON_TMP = Path.home() / ".ultron" / ".tmp"
SESSION_MODE_FILE = ULTRON_TMP / "current-session-mode.json"
PUSH_QUEUE_FILE = ULTRON_TMP / "push-queue.json"
PUSH_LOG_FILE = Path.home() / ".ultron" / "logs" / "push-async.log"

HIGH_MODES = {"HIGH", "ULTRA", "LEARN"}


def _mode_ttl() -> timedelta:
    """Read mode_ttl_hours from brain config (defaults to 24h).
    Lazy-imported to keep memory_sync usable even if brain_config is missing."""
    try:
        sys.path.insert(0, str(Path(__file__).parent))
        from brain_config import load as _load_cfg  # type: ignore
        return timedelta(hours=int(_load_cfg().get("mode_ttl_hours", 24)))
    except Exception:
        return timedelta(hours=24)


def _git(*args: str, check: bool = False) -> tuple[int, str, str]:
    if not VAULT.exists():
        return 1, "", "Vault not found"
    try:
        r = subprocess.run(
            ["git", "-C", str(VAULT), *args],
            capture_output=True, text=True, encoding="utf-8", timeout=30,
        )
        if check and r.returncode != 0:
            print(f"[git error] {' '.join(args)}: {r.stderr}", file=sys.stderr)
        return r.returncode, r.stdout, r.stderr
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return 1, "", str(e)


def cmd_status(_args) -> int:
    if not VAULT.exists():
        print(f"[error] Vault not found: {VAULT}")
        return 1
    md_count = sum(1 for _ in VAULT.rglob("*.md"))
    total_size = sum(p.stat().st_size for p in VAULT.rglob("*") if p.is_file())
    rc, last_commit, _ = _git("log", "-1", "--pretty=format:%h %ai %s")
    rc2, status_porcelain, _ = _git("status", "--porcelain")
    rc3, branch, _ = _git("branch", "--show-current")
    rc4, remote, _ = _git("remote", "get-url", "origin")
    dirty = bool(status_porcelain.strip())

    print(f"⌬  ULTRON Brain Vault — {VAULT}")
    print("=" * 70)
    print(f"  Files (.md):  {md_count}")
    print(f"  Total size:   {total_size / 1024:.1f} KB")
    print(f"  Branch:       {branch.strip() if rc3 == 0 else '?'}")
    print(f"  Remote:       {remote.strip() if rc4 == 0 else '(none — local only)'}")
    print(f"  Last commit:  {last_commit.strip() if rc == 0 else '(none)'}")
    print(f"  Dirty:        {'YES' if dirty else 'no'}")
    if dirty:
        print()
        print("  Pending changes:")
        for line in status_porcelain.strip().splitlines()[:10]:
            print(f"    {line}")
    return 0


def cmd_sync(args) -> int:
    if not VAULT.exists():
        print(f"[error] Vault not found: {VAULT}")
        return 1
    rc, status_porc, _ = _git("status", "--porcelain")
    if not status_porc.strip():
        print("[sync] Vault clean — nothing to commit")
        return 0
    msg = args.message or f"sync: {datetime.now().strftime('%Y-%m-%d %H:%M')}"
    _git("add", ".", check=True)
    rc, out, err = _git("commit", "-m", msg)
    if rc != 0:
        print(f"[sync] Commit failed: {err}")
        return rc
    print(f"[sync] Committed: {msg}")
    if args.push:
        return cmd_push(args)
    return 0


def cmd_push(_args) -> int:
    rc, remote, _ = _git("remote", "get-url", "origin")
    if rc != 0 or not remote.strip():
        print("[push] No remote configured — set with:")
        print("  git -C ~/.ultron-vault remote add origin <url>")
        return 1
    rc, out, err = _git("push", "-u", "origin", "main")
    if rc != 0:
        print(f"[push] FAILED: {err.strip()[:200]}")
        return rc
    print(f"[push] OK -> {remote.strip()}")
    return 0


def _append_push_log(msg: str) -> None:
    PUSH_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        with open(PUSH_LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except OSError:
        pass


def _enqueue_push(reason: str) -> None:
    """Add a pending-push marker so SessionStart hook will retry."""
    ULTRON_TMP.mkdir(parents=True, exist_ok=True)
    queue: list[dict] = []
    if PUSH_QUEUE_FILE.exists():
        try:
            queue = json.loads(PUSH_QUEUE_FILE.read_text(encoding="utf-8"))
            if not isinstance(queue, list):
                queue = []
        except (OSError, json.JSONDecodeError):
            queue = []
    queue.append({
        "ts": datetime.now().isoformat(timespec="seconds"),
        "reason": reason,
        "attempts": 0,
    })
    PUSH_QUEUE_FILE.write_text(
        json.dumps(queue, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


PUSH_STATUS_FILE = ULTRON_TMP / "push-status.json"


def cmd_push_async(_args) -> int:
    """Stop-hook entry: spawn 'git push' in background and return immediately.
    The child writes its result (rc + stderr + ts) to push-status.json so the
    next SessionStart's push-queue can detect a silent failure (B3 fix from
    Triple Kirkardo R3 — original version only enqueued on spawn-fail, not on
    git-fail-after-spawn). Never blocks the Stop event."""
    rc, remote, _ = _git("remote", "get-url", "origin")
    if rc != 0 or not remote.strip():
        _append_push_log("skip: no remote configured")
        return 0

    # Detached background process (Windows DETACHED_PROCESS = 0x00000008,
    # CREATE_NEW_PROCESS_GROUP = 0x00000200, plus CREATE_NO_WINDOW = 0x08000000).
    flags = 0
    startupinfo = None
    if os.name == "nt":
        flags = 0x00000008 | 0x00000200 | 0x08000000
        # SW_HIDE via STARTUPINFO — guarantees no console flash even when
        # python.exe (console subsystem) bootstraps the wrapper. Without
        # this, the focus-steal pulls USER out of fullscreen games.
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = subprocess.SW_HIDE

    # Clear any stale status from a previous push so SessionStart sees only
    # this run's outcome.
    try:
        if PUSH_STATUS_FILE.exists():
            PUSH_STATUS_FILE.unlink()
    except OSError:
        pass

    status_path_lit = repr(str(PUSH_STATUS_FILE))
    vault_lit = repr(str(VAULT))

    # Prefer pythonw.exe (Windows subsystem, no console) over python.exe
    # to fully eliminate the brief console flash on launch.
    py_exe = sys.executable
    if os.name == "nt":
        cand = Path(py_exe).with_name("pythonw.exe")
        if cand.exists():
            py_exe = str(cand)

    try:
        # Wrapper script: runs git push, writes status, exits.
        # SessionStart's push-queue inspects push-status.json to detect failure.
        # Inner subprocess.run also passes CREATE_NO_WINDOW + STARTUPINFO so
        # git.exe (also console subsystem) does not flash a window either.
        wrapper = (
            "import subprocess, json, datetime, sys, os\n"
            "si = None\n"
            "flags = 0\n"
            "if os.name == 'nt':\n"
            "    flags = 0x08000000\n"
            "    si = subprocess.STARTUPINFO()\n"
            "    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW\n"
            "    si.wShowWindow = 0\n"
            f"r = subprocess.run("
            f"['git', '-C', {vault_lit}, 'push', '-u', 'origin', 'main'],"
            f"capture_output=True, text=True, timeout=60,"
            f"creationflags=flags, startupinfo=si)\n"
            f"open({status_path_lit}, 'w', encoding='utf-8').write(json.dumps({{"
            f"'rc': r.returncode,"
            f"'stderr': (r.stderr or '')[:500],"
            f"'ts': datetime.datetime.now().isoformat(timespec='seconds')"
            f"}}))\n"
            f"sys.exit(r.returncode)"
        )
        proc = subprocess.Popen(
            [py_exe, "-c", wrapper],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=flags if os.name == "nt" else 0,
            startupinfo=startupinfo,
            close_fds=True,
        )
        _append_push_log(f"async-spawn: pid={proc.pid} exe={Path(py_exe).name} → {remote.strip()}")
        return 0
    except Exception as e:
        _append_push_log(f"async-spawn-failed: {e}")
        _enqueue_push(f"spawn-failed: {e}")
        return 0


def cmd_push_queue(_args) -> int:
    """SessionStart entry: (1) check the previous async push's status file —
    if the child reported a non-zero exit code, enqueue a retry; (2) drain
    the pending-push queue with synchronous attempts."""
    # B3 fix: pick up silent failures from the previous Stop hook's
    # async push (where the spawn succeeded but git push itself failed —
    # offline, conflict, auth expired, etc.).
    if PUSH_STATUS_FILE.exists():
        try:
            status = json.loads(PUSH_STATUS_FILE.read_text(encoding="utf-8"))
            if isinstance(status, dict) and int(status.get("rc", 0)) != 0:
                err = (status.get("stderr") or "")[:200]
                ts = status.get("ts", "?")
                _enqueue_push(f"async-push-failed @ {ts}: {err}")
                _append_push_log(
                    f"async-push-failed-detected: enqueued retry (stderr: {err[:80]})"
                )
            # Consume the status file regardless (success or fail recorded).
            PUSH_STATUS_FILE.unlink(missing_ok=True)
        except (OSError, json.JSONDecodeError, ValueError):
            pass

    if not PUSH_QUEUE_FILE.exists():
        return 0
    try:
        queue = json.loads(PUSH_QUEUE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    if not queue:
        PUSH_QUEUE_FILE.unlink(missing_ok=True)
        return 0

    rc, remote, _ = _git("remote", "get-url", "origin")
    if rc != 0:
        print("[push-queue] no remote — leaving queue intact")
        return 0

    drained = 0
    surviving: list[dict] = []
    for entry in queue:
        rc, _, err = _git("push", "-u", "origin", "main")
        if rc == 0:
            drained += 1
            _append_push_log(f"queue-drained: {entry.get('reason', '?')}")
        else:
            entry["attempts"] = int(entry.get("attempts", 0)) + 1
            entry["last_error"] = (err or "").strip()[:200]
            surviving.append(entry)
            _append_push_log(
                f"queue-retry-failed (attempt {entry['attempts']}): "
                f"{entry['last_error']}",
            )

    if surviving:
        PUSH_QUEUE_FILE.write_text(
            json.dumps(surviving, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    else:
        PUSH_QUEUE_FILE.unlink(missing_ok=True)

    print(f"[push-queue] drained={drained} pending={len(surviving)}")
    return 0


def cmd_mode(args) -> int:
    """Persist the current session mode for the Stop hook to read."""
    mode = args.mode.upper()
    if mode not in {"LOW", "MEDIUM", "HIGH", "ULTRA", "LEARN"}:
        print(f"[error] Unknown mode: {mode}")
        return 1
    ULTRON_TMP.mkdir(parents=True, exist_ok=True)
    SESSION_MODE_FILE.write_text(
        json.dumps({"mode": mode, "ts": datetime.now().isoformat()}),
        encoding="utf-8",
    )
    print(f"[mode] Session mode set: {mode}")
    return 0


def cmd_should_push(_args) -> int:
    """Exit 0 if the most recent session was HIGH+ AND fresh (<MODE_TTL).
    Used by Stop hook: only sync if HIGH/ULTRA/LEARN within the TTL window."""
    if not SESSION_MODE_FILE.exists():
        return 1
    try:
        data = json.loads(SESSION_MODE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 1
    mode = data.get("mode", "MEDIUM").upper()
    if mode not in HIGH_MODES:
        return 1
    ts_raw = data.get("ts", "")
    try:
        stored_at = datetime.fromisoformat(ts_raw)
    except (TypeError, ValueError):
        return 1
    if datetime.now() - stored_at > _mode_ttl():
        # Stale — downgrade to MEDIUM. Don't auto-push for an old session.
        return 1
    return 0


def main() -> int:
    p = argparse.ArgumentParser(prog="memory_sync",
                                 description="ULTRON v12 vault L2 sync utility")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="Show vault status").set_defaults(func=cmd_status)

    sp = sub.add_parser("sync", help="Stage + commit + (optional) push")
    sp.add_argument("-m", "--message", help="Commit message")
    sp.add_argument("--push", action="store_true", help="Push after commit")
    sp.set_defaults(func=cmd_sync)

    sub.add_parser("push", help="Push to remote (synchronous)").set_defaults(
        func=cmd_push)
    sub.add_parser("push-async",
                    help="Spawn push in background (Stop hook entry)").set_defaults(
        func=cmd_push_async)
    sub.add_parser("push-queue",
                    help="Drain pending pushes (SessionStart entry)").set_defaults(
        func=cmd_push_queue)

    sp = sub.add_parser("mode", help="Set current session mode")
    sp.add_argument("mode", help="LOW|MEDIUM|HIGH|ULTRA|LEARN")
    sp.set_defaults(func=cmd_mode)

    sub.add_parser("should-push",
                    help="Exit 0 if last session was HIGH+").set_defaults(
        func=cmd_should_push)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
