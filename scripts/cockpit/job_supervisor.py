#!/usr/bin/env python3
"""
ULTRON v10.7 Cockpit — Job Supervisor MVP.

Manages long-running background jobs with persistent state and log capture.
Each job gets a UUID directory under ~/.ultron/cockpit/jobs/<job_id>/ containing
meta.json, stdout.log, stderr.log, and an artifacts/ sub-directory.

Subcommands:
    submit <label> -- <cmd...>   Launch job in background, print job_id
    status <job_id>              Show job status + runtime + exit code
    list [--all] [--n N]        List recent jobs (default last 20)
    cancel <job_id>              Send SIGTERM (Windows: TerminateProcess)
    logs <job_id> [--tail N]    Print last N lines of stdout log (default 40)
    clean [--days N]             Remove jobs older than N days (default 7)

Usage:
    python job_supervisor.py submit "build docs" -- python build_docs.py --all
    python job_supervisor.py list
    python job_supervisor.py status abc123
    python job_supervisor.py logs abc123 --tail 20
    python job_supervisor.py cancel abc123
    python job_supervisor.py clean --days 3
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import COCKPIT_DIR, Cockpit  # noqa: E402

JOBS_DIR = COCKPIT_DIR / "jobs"

# Job status values
STATUS_RUNNING   = "running"
STATUS_DONE      = "done"
STATUS_FAILED    = "failed"
STATUS_CANCELLED = "cancelled"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _job_dir(job_id: str) -> Path:
    return JOBS_DIR / job_id


def _meta_path(job_id: str) -> Path:
    return _job_dir(job_id) / "meta.json"


def _read_meta(job_id: str) -> dict | None:
    p = _meta_path(job_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_meta(job_id: str, meta: dict) -> None:
    p = _meta_path(job_id)
    p.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")


def _is_pid_running(pid: int) -> bool:
    """Best-effort cross-platform PID check."""
    try:
        if os.name == "nt":
            import ctypes
            SYNCHRONIZE = 0x00100000
            handle = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, pid)
            if not handle:
                return False
            ret = ctypes.windll.kernel32.WaitForSingleObject(handle, 0)
            ctypes.windll.kernel32.CloseHandle(handle)
            return ret != 0  # 0 = WAIT_OBJECT_0 (process exited)
        else:
            os.kill(pid, 0)
            return True
    except (OSError, PermissionError):
        return False


def _refresh_status(meta: dict) -> dict:
    """If job is marked running, check if PID is still alive; update meta if needed."""
    if meta.get("status") != STATUS_RUNNING:
        return meta
    pid = meta.get("pid")
    if not pid or not _is_pid_running(pid):
        # Process ended — we can't know exit code without process handle, mark done
        meta["status"] = STATUS_DONE
        meta["finished_at"] = datetime.now().isoformat(timespec="seconds")
        _write_meta(meta["job_id"], meta)
    return meta


def _runtime_str(meta: dict) -> str:
    """Human-readable runtime from started_at to finished_at (or now)."""
    try:
        start = datetime.fromisoformat(meta["started_at"])
        end_str = meta.get("finished_at")
        end = datetime.fromisoformat(end_str) if end_str else datetime.now()
        delta = int((end - start).total_seconds())
        if delta < 60:
            return f"{delta}s"
        m, s = divmod(delta, 60)
        if m < 60:
            return f"{m}m{s:02d}s"
        h, m = divmod(m, 60)
        return f"{h}h{m:02d}m"
    except Exception:
        return "?"


def _status_icon(status: str) -> str:
    return {
        STATUS_RUNNING:   "[running]",
        STATUS_DONE:      "[done]   ",
        STATUS_FAILED:    "[failed] ",
        STATUS_CANCELLED: "[cancel] ",
    }.get(status, "[?]     ")


# ── Commands ──────────────────────────────────────────────────────────────────

def _build_wrapper(job_id: str, cmd: list[str], jdir: Path) -> str:
    """Return Python -c code that runs cmd, captures stdout/stderr, writes exit_code to meta."""
    meta_p = str(_meta_path(job_id)).replace("\\", "\\\\")
    stdout_p = str(jdir / "stdout.log").replace("\\", "\\\\")
    stderr_p = str(jdir / "stderr.log").replace("\\", "\\\\")
    cmd_repr = repr(cmd)
    return (
        "import subprocess,json,sys\n"
        "from pathlib import Path\n"
        "from datetime import datetime\n"
        f"cmd={cmd_repr}\n"
        f"fout=open('{stdout_p}','wb')\n"
        f"ferr=open('{stderr_p}','wb')\n"
        "try:\n"
        "    r=subprocess.run(cmd,stdout=fout,stderr=ferr)\n"
        "    ec=r.returncode\n"
        "finally:\n"
        "    fout.close();ferr.close()\n"
        f"p=Path('{meta_p}')\n"
        "m=json.loads(p.read_text(encoding='utf-8'))\n"
        "m['exit_code']=ec\n"
        "m['status']='done' if ec==0 else 'failed'\n"
        "m['finished_at']=datetime.now().isoformat(timespec='seconds')\n"
        "p.write_text(json.dumps(m,indent=2,ensure_ascii=False),encoding='utf-8')\n"
    )


def cmd_submit(label: str, cmd: list[str]) -> int:
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    job_id = uuid.uuid4().hex[:12]
    jdir = _job_dir(job_id)
    jdir.mkdir(parents=True)
    (jdir / "artifacts").mkdir()

    stdout_log = jdir / "stdout.log"

    meta: dict = {
        "job_id":       job_id,
        "label":        label,
        "cmd":          cmd,
        "status":       STATUS_RUNNING,
        "pid":          None,
        "started_at":   datetime.now().isoformat(timespec="seconds"),
        "finished_at":  None,
        "exit_code":    None,
        "artifacts_dir": str(jdir / "artifacts"),
    }
    _write_meta(job_id, meta)

    try:
        flags = 0
        if os.name == "nt":
            flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        wrapper = _build_wrapper(job_id, cmd, jdir)
        proc = subprocess.Popen(
            [sys.executable, "-c", wrapper],
            creationflags=flags,
        )
        meta["pid"] = proc.pid
        _write_meta(job_id, meta)
        print(f"[jobs] submitted job_id={job_id}  label={label!r}  pid={proc.pid}")
        print(f"       logs: {stdout_log}")
        return 0
    except Exception as e:
        meta["status"] = STATUS_FAILED
        meta["finished_at"] = datetime.now().isoformat(timespec="seconds")
        _write_meta(job_id, meta)
        print(f"[jobs] ERROR: failed to launch: {e}")
        return 1


def cmd_status(job_id: str) -> int:
    meta = _read_meta(job_id)
    if not meta:
        print(f"[jobs] no job found: {job_id}")
        return 1
    meta = _refresh_status(meta)
    icon = _status_icon(meta["status"])
    rt = _runtime_str(meta)
    import shlex as _shlex
    print(f"{icon} {meta['job_id']}  {meta['label']!r}")
    print(f"  cmd:       {_shlex.join(meta['cmd'])}")
    print(f"  pid:       {meta.get('pid', '?')}")
    print(f"  started:   {meta.get('started_at', '?')}")
    print(f"  finished:  {meta.get('finished_at', 'still running')}")
    print(f"  runtime:   {rt}")
    print(f"  exit_code: {meta.get('exit_code', '?')}")
    print(f"  logs:      {_job_dir(job_id) / 'stdout.log'}")
    return 0


def cmd_list(n: int = 20, show_all: bool = False) -> int:
    if not JOBS_DIR.exists():
        print("[jobs] no jobs directory — nothing submitted yet")
        return 0

    entries = []
    for d in sorted(JOBS_DIR.iterdir(), reverse=True):
        meta = _read_meta(d.name)
        if not meta:
            continue
        meta = _refresh_status(meta)
        entries.append(meta)

    if not show_all:
        entries = entries[:n]

    if not entries:
        print("[jobs] no jobs found")
        return 0

    print(f"{'STATUS':<10} {'JOB_ID':<14} {'RUNTIME':<8} {'LABEL'}")
    print("─" * 60)
    for m in entries:
        icon = _status_icon(m["status"]).strip("[] ").ljust(8)
        rt = _runtime_str(m)
        label = m.get("label", "")[:40]
        print(f"{icon:<10} {m['job_id']:<14} {rt:<8} {label}")

    print(f"\n{len(entries)} job(s)")
    return 0


def cmd_cancel(job_id: str) -> int:
    meta = _read_meta(job_id)
    if not meta:
        print(f"[jobs] no job found: {job_id}")
        return 1
    if meta.get("status") != STATUS_RUNNING:
        print(f"[jobs] job {job_id} is not running (status={meta['status']})")
        return 0
    pid = meta.get("pid")
    if not pid:
        print(f"[jobs] job {job_id} has no PID recorded")
        return 1
    try:
        if os.name == "nt":
            import ctypes
            handle = ctypes.windll.kernel32.OpenProcess(1, False, pid)
            if handle:
                ctypes.windll.kernel32.TerminateProcess(handle, 1)
                ctypes.windll.kernel32.CloseHandle(handle)
        else:
            import signal
            os.kill(pid, signal.SIGTERM)
        meta["status"] = STATUS_CANCELLED
        meta["finished_at"] = datetime.now().isoformat(timespec="seconds")
        _write_meta(job_id, meta)
        print(f"[jobs] cancelled job {job_id} (pid={pid})")
        return 0
    except Exception as e:
        print(f"[jobs] ERROR cancelling {job_id}: {e}")
        return 1


def cmd_logs(job_id: str, tail: int = 40) -> int:
    jdir = _job_dir(job_id)
    log = jdir / "stdout.log"
    if not log.exists():
        print(f"[jobs] no stdout log for {job_id}")
        return 1
    lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
    if not lines:
        print(f"[jobs] stdout log is empty for {job_id}")
        return 0
    if tail > 0:
        lines = lines[-tail:]
    for line in lines:
        print(line)
    return 0


def cmd_clean(days: int = 7, include_running: bool = False) -> int:
    import shutil as _shutil
    if not JOBS_DIR.exists():
        print("[jobs] no jobs directory")
        return 0
    cutoff = datetime.now() - timedelta(days=days)
    removed = skipped_running = 0
    for d in JOBS_DIR.iterdir():
        meta = _read_meta(d.name)
        if not meta:
            continue
        if meta.get("status") == STATUS_RUNNING:
            if not include_running:
                skipped_running += 1
                continue
            # Cancel first, then remove
            pid = meta.get("pid")
            if pid:
                try:
                    if os.name == "nt":
                        import ctypes as _ct
                        h = _ct.windll.kernel32.OpenProcess(1, False, pid)
                        if h:
                            _ct.windll.kernel32.TerminateProcess(h, 1)
                            _ct.windll.kernel32.CloseHandle(h)
                    else:
                        import signal
                        os.kill(pid, signal.SIGTERM)
                except Exception:
                    pass
        ts_str = meta.get("finished_at") or meta.get("started_at") or ""
        try:
            ts = datetime.fromisoformat(ts_str)
        except Exception:
            continue
        if ts < cutoff:
            _shutil.rmtree(d, ignore_errors=True)
            removed += 1
    msg = f"[jobs] cleaned {removed} job(s) older than {days} day(s)"
    if skipped_running:
        msg += f"  (skipped {skipped_running} running — use --running to force)"
    print(msg)
    return 0


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description="ULTRON Job Supervisor")
    sub = p.add_subparsers(dest="cmd")

    sv = sub.add_parser("submit", help="launch background job")
    sv.add_argument("label")
    sv.add_argument("command", nargs=argparse.REMAINDER)

    st = sub.add_parser("status", help="show job status")
    st.add_argument("job_id")

    lv = sub.add_parser("list", help="list recent jobs")
    lv.add_argument("--all", action="store_true")
    lv.add_argument("--n", type=int, default=20)

    cv = sub.add_parser("cancel", help="cancel running job")
    cv.add_argument("job_id")

    lgs = sub.add_parser("logs", help="print job stdout")
    lgs.add_argument("job_id")
    lgs.add_argument("--tail", type=int, default=40)

    cl = sub.add_parser("clean", help="remove old finished jobs")
    cl.add_argument("--days", type=int, default=7)
    cl.add_argument("--running", action="store_true",
                    help="also cancel + remove running jobs older than --days")

    args = p.parse_args()
    if not args.cmd:
        p.print_help()
        return 1

    Cockpit.ensure_dirs()

    if args.cmd == "submit":
        # Strip leading "--" separator if present
        raw = args.command or []
        cmd_args = raw[1:] if raw and raw[0] == "--" else raw
        if not cmd_args:
            print("[jobs] ERROR: no command specified after label")
            return 1
        return cmd_submit(args.label, cmd_args)
    if args.cmd == "status":
        return cmd_status(args.job_id)
    if args.cmd == "list":
        return cmd_list(n=args.n, show_all=args.all)
    if args.cmd == "cancel":
        return cmd_cancel(args.job_id)
    if args.cmd == "logs":
        return cmd_logs(args.job_id, tail=args.tail)
    if args.cmd == "clean":
        return cmd_clean(days=args.days, include_running=args.running)
    return 1


if __name__ == "__main__":
    sys.exit(main())
