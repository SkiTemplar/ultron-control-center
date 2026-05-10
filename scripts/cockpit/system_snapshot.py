"""ULTRON v14.8 P2A — System snapshot collector.

Aggregates the live state of every ULTRON subsystem into two files that the
TUI dashboard, doctor, and (optionally) the model itself can read without
re-querying each subsystem individually:

  ~/.ultron/.tmp/system-snapshot.json   — full structured data (machine)
  ~/.ultron/.tmp/system-snapshot.md     — ≤150 token compact summary (human)

The MD form is deliberately small enough to drop into a system-reminder or
context.md companion without burning the cache budget. The JSON keeps the
full detail for the TUI and any future consumers.

Subsystems collected (each function fails-soft and reports its own error):
  - version       SKILL.md frontmatter
  - mode          ~/.ultron/.tmp/current-session-mode.json
  - qdrant        live REST query against ultron-qdrant
  - brain         brain_index.db points + last update mtime
  - backup        ~/.ultron/.tmp/backup-last-run.json + freshness
  - recall        ~/.ultron/.tmp/last-recall.json
  - doctor        invokes doctor.py --json, parses severity counts
  - cache         cache_telemetry.detector_status() short-circuit
  - skills        skill_lazy_loader status (read-only)
  - tests         pytest cache hash + last reported counts
  - git           subprocess rev-parse HEAD + log -1 oneline

CLI:
  system_snapshot.py refresh          # collect + write both files
  system_snapshot.py show             # cat the MD file (no refresh)
  system_snapshot.py json             # cat the JSON file (no refresh)
  system_snapshot.py refresh --quiet  # write but don't print

Read-only on every subsystem. Writes only the two snapshot files. Atomic
write (tempfile + os.replace) so partial-state never appears on disk.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

# Make sibling cockpit modules importable even when invoked via uv.
_HERE = Path(__file__).parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def _user_home() -> Path:
    return Path.home()


def _read_json_safe(path: Path) -> Any:
    """Read JSON, tolerating BOM that PowerShell often writes (utf-8-sig)."""
    raw = path.read_text(encoding="utf-8-sig")
    return json.loads(raw)


def _snapshot_json() -> Path:
    return _user_home() / ".ultron" / ".tmp" / "system-snapshot.json"


def _snapshot_md() -> Path:
    return _user_home() / ".ultron" / ".tmp" / "system-snapshot.md"


# ── Subsystem collectors ───────────────────────────────────────────────────────


def collect_version() -> dict[str, Any]:
    skill_md = _user_home() / ".claude" / "skills" / "ultron" / "SKILL.md"
    if not skill_md.exists():
        return {"error": "SKILL.md not found"}
    try:
        text = skill_md.read_text(encoding="utf-8")
        m = re.search(r"^version:\s*(\S+)", text, re.MULTILINE)
        version = m.group(1).strip().strip('"') if m else None
    except OSError as exc:
        return {"error": repr(exc)}
    return {"version": version or "?"}


def collect_mode() -> dict[str, Any]:
    f = _user_home() / ".ultron" / ".tmp" / "current-session-mode.json"
    if not f.exists():
        return {"mode": "MEDIUM", "source": "default"}
    try:
        data = _read_json_safe(f)
        return {
            "mode": str(data.get("mode") or "MEDIUM"),
            "registered_at": data.get("registered_at"),
            "source": "file",
        }
    except (OSError, json.JSONDecodeError) as exc:
        return {"mode": "?", "error": repr(exc)}


def collect_qdrant() -> dict[str, Any]:
    """Hit Qdrant REST API directly — no qdrant-client import needed."""
    try:
        import urllib.request
        with urllib.request.urlopen("http://localhost:6333/collections", timeout=2) as r:
            data = json.loads(r.read().decode("utf-8"))
        cols = data.get("result", {}).get("collections", []) or []
        names = [c.get("name") for c in cols]
        info: dict[str, Any] = {"reachable": True, "collections": names}
        for name in names:
            try:
                with urllib.request.urlopen(
                    f"http://localhost:6333/collections/{name}", timeout=2,
                ) as r2:
                    cdata = json.loads(r2.read().decode("utf-8")).get("result", {})
                info[f"{name}_points"] = cdata.get("points_count", 0)
            except Exception:
                continue
        return info
    except Exception as exc:
        return {"reachable": False, "error": repr(exc)[:120]}


def collect_brain() -> dict[str, Any]:
    db = _user_home() / ".ultron" / "brain_index" / "index.db"
    if not db.exists():
        return {"present": False}
    try:
        import sqlite3
        with sqlite3.connect(str(db)) as conn:
            row = conn.execute("SELECT COUNT(*) FROM notes").fetchone()
            count = int(row[0]) if row else 0
        return {
            "present": True,
            "notes": count,
            "db_size_kb": round(db.stat().st_size / 1024, 0),
            "last_updated": datetime.fromtimestamp(
                db.stat().st_mtime, tz=timezone.utc,
            ).isoformat(timespec="seconds"),
        }
    except Exception as exc:
        return {"present": True, "error": repr(exc)[:120]}


def collect_backup() -> dict[str, Any]:
    f = _user_home() / ".ultron" / ".tmp" / "backup-last-run.json"
    if not f.exists():
        return {"never_run": True}
    try:
        data = _read_json_safe(f)
        last_iso = str(data.get("last_run") or "")
        try:
            last = datetime.fromisoformat(last_iso)
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            age_h = round((datetime.now(timezone.utc) - last).total_seconds() / 3600, 1)
        except (TypeError, ValueError):
            age_h = None
        results = data.get("results") or {}
        ok_count = sum(1 for v in results.values() if isinstance(v, dict) and v.get("ok"))
        total = len(results)
        return {
            "last_run": last_iso,
            "age_h": age_h,
            "dry_run": bool(data.get("dry_run")),
            "sources_ok": f"{ok_count}/{total}",
            "backup_root": data.get("backup_root"),
        }
    except (OSError, json.JSONDecodeError) as exc:
        return {"error": repr(exc)[:120]}


def collect_recall() -> dict[str, Any]:
    f = _user_home() / ".ultron" / ".tmp" / "last-recall.json"
    if not f.exists():
        return {"present": False}
    try:
        data = _read_json_safe(f)
        hits = data.get("hits") or []
        top = hits[0] if hits else None
        return {
            "present": True,
            "captured_at": data.get("captured_at"),
            "query": (data.get("query") or "")[:80],
            "top_score": (round(float(top["score"]), 3) if top else None),
            "top_path": (top.get("path") if top else None),
            "hits_count": len(hits),
        }
    except (OSError, json.JSONDecodeError) as exc:
        return {"present": True, "error": repr(exc)[:120]}


def collect_doctor() -> dict[str, Any]:
    """Invoke doctor.py --json and parse severity. Bounded by a 30s timeout."""
    doctor = _HERE / "doctor.py"
    if not doctor.exists():
        return {"error": "doctor.py not found"}
    try:
        result = subprocess.run(
            [sys.executable, str(doctor), "--json"],
            capture_output=True, text=True, timeout=30,
            creationflags=_WIN_HIDDEN,
            cwd=str(_HERE),
        )
        # doctor exits 0/1/2 by severity; either way stdout has JSON
        if not result.stdout.strip():
            return {"error": "no output"}
        data = json.loads(result.stdout)
        sev: dict[str, int] = {"info": 0, "warn": 0, "blocking": 0}
        for f in data.get("findings", []):
            s = f.get("severity")
            if s in sev:
                sev[s] += 1
        return {
            "blocking": sev["blocking"],
            "warn": sev["warn"],
            "info": sev["info"],
            "total": data.get("summary", {}).get("total"),
            "exit_code": result.returncode,
        }
    except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError) as exc:
        return {"error": repr(exc)[:120]}


def collect_cache() -> dict[str, Any]:
    try:
        import cache_telemetry  # type: ignore
        status = cache_telemetry.detector_status()
        return {
            "hit_rate": status.get("hit_rate"),
            "verdict": status.get("verdict"),
            "turns": status.get("turns_observed"),
            "window_days": status.get("window_days"),
        }
    except Exception as exc:
        return {"error": repr(exc)[:120]}


def collect_skills() -> dict[str, Any]:
    state = _user_home() / ".ultron" / ".tmp" / "skill-listing-mode.json"
    if not state.exists():
        return {"mode": "full", "source": "default"}
    try:
        data = _read_json_safe(state)
        return {
            "mode": data.get("mode"),
            "skills_total": data.get("skills_total"),
            "skills_on": data.get("skills_on"),
            "skills_name_only": data.get("skills_name_only"),
            "applied_at": data.get("applied_at"),
        }
    except (OSError, json.JSONDecodeError) as exc:
        return {"error": repr(exc)[:120]}


def collect_tests() -> dict[str, Any]:
    """Best-effort: read .pytest_cache lastfailed; counts come from last run."""
    cache_dir = _user_home() / ".claude" / "skills" / "ultron" / ".pytest_cache"
    if not cache_dir.exists():
        return {"present": False}
    lastfailed = cache_dir / "v" / "cache" / "lastfailed"
    if lastfailed.exists():
        try:
            failed = json.loads(lastfailed.read_text(encoding="utf-8"))
            return {"present": True, "last_failed_count": len(failed)}
        except (OSError, json.JSONDecodeError):
            pass
    return {"present": True, "last_failed_count": 0}


def collect_git() -> dict[str, Any]:
    repo = _user_home() / ".claude" / "skills"
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(repo), capture_output=True, text=True, timeout=5,
            creationflags=_WIN_HIDDEN,
        ).stdout.strip()
        msg = subprocess.run(
            ["git", "log", "-1", "--pretty=%s"],
            cwd=str(repo), capture_output=True, text=True, timeout=5,
            creationflags=_WIN_HIDDEN,
        ).stdout.strip()
        branch = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=str(repo), capture_output=True, text=True, timeout=5,
            creationflags=_WIN_HIDDEN,
        ).stdout.strip()
        dirty = bool(subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(repo), capture_output=True, text=True, timeout=5,
            creationflags=_WIN_HIDDEN,
        ).stdout.strip())
        return {"sha": sha, "branch": branch, "subject": msg, "dirty": dirty}
    except Exception as exc:
        return {"error": repr(exc)[:120]}


# ── Aggregation + render ───────────────────────────────────────────────────────


def collect_all(*, skip_doctor: bool = False) -> dict[str, Any]:
    """Run all collectors in sequence. ~3-30s depending on doctor inclusion."""
    started = time.perf_counter()
    out: dict[str, Any] = {
        "schema_version": 1,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "version": collect_version(),
        "mode": collect_mode(),
        "qdrant": collect_qdrant(),
        "brain": collect_brain(),
        "backup": collect_backup(),
        "recall": collect_recall(),
        "cache": collect_cache(),
        "skills": collect_skills(),
        "tests": collect_tests(),
        "git": collect_git(),
    }
    if not skip_doctor:
        out["doctor"] = collect_doctor()
    out["elapsed_s"] = round(time.perf_counter() - started, 2)
    return out


def _fmt_age(age_h: Any) -> str:
    if not isinstance(age_h, (int, float)):
        return "?"
    if age_h < 1:
        return f"{int(age_h * 60)}m"
    if age_h < 24:
        return f"{int(age_h)}h"
    return f"{int(age_h / 24)}d"


def render_md(data: dict[str, Any]) -> str:
    """Render the compact ≤150 token Markdown summary."""
    v = data.get("version", {})
    g = data.get("git", {})
    m = data.get("mode", {})
    q = data.get("qdrant", {})
    br = data.get("brain", {})
    sk = data.get("skills", {})
    bk = data.get("backup", {})
    rc = data.get("recall", {})
    dc = data.get("doctor", {})
    ca = data.get("cache", {})
    ts_iso = data.get("captured_at") or "?"

    # Status emojis
    def _s(ok: bool) -> str:
        return "✅" if ok else "⚠️"

    qdrant_ok = q.get("reachable") is True
    backup_ok = (bk.get("sources_ok", "0/0") != "0/0") or (bk.get("never_run") is False)
    if bk.get("never_run"):
        backup_ok = False
    doctor_ok = (dc.get("blocking") or 0) == 0
    cache_ok = ca.get("verdict") == "pass"

    vault_pts = q.get("ultron_vault_points", "?")
    notes = br.get("notes", "?")

    lines = [
        f"# ULTRON snapshot · {ts_iso[:16].replace('T', ' ')}",
        f"{v.get('version','?')} · {m.get('mode','?')} · "
        f"{g.get('branch','?')}@{g.get('sha','?')}"
        f"{' (dirty)' if g.get('dirty') else ''}",
        "",
        "## Memory",
        f"- Vault: {vault_pts} vec / {notes} FTS5 notes",
        f"- Backup: {bk.get('sources_ok','?')} sources · {_fmt_age(bk.get('age_h'))} ago"
        if not bk.get('never_run') else "- Backup: never run",
        f"- Recall: top {rc.get('top_score','?')} on {(rc.get('top_path') or '?').split(chr(92))[-1][:40]}"
        if rc.get('present') else "- Recall: never fired",
        "",
        "## Subsystems",
        f"- Skills: {sk.get('skills_on','?')} on / {sk.get('skills_name_only','?')} name-only",
        f"- Cache: {round(float(ca.get('hit_rate',0))*100,1)}% ({ca.get('verdict','?')})"
        if ca.get('hit_rate') is not None else "- Cache: ?",
        f"- Doctor: {dc.get('blocking',0)} blocking · {dc.get('warn',0)} warn"
        if 'blocking' in dc else "- Doctor: ?",
        "",
        "## Health",
        f"{_s(qdrant_ok)} Qdrant · {_s(br.get('present') or False)} FTS5 · "
        f"{_s(doctor_ok)} Doctor · {_s(cache_ok)} Cache · {_s(backup_ok)} Backup",
    ]
    return "\n".join(lines)


# ── Atomic writers ─────────────────────────────────────────────────────────────


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


def write_snapshot(data: dict[str, Any]) -> None:
    _atomic_write(_snapshot_json(), json.dumps(data, indent=2, ensure_ascii=False))
    _atomic_write(_snapshot_md(), render_md(data))


# ── CLI ────────────────────────────────────────────────────────────────────────


def _cmd_refresh(args: argparse.Namespace) -> int:
    data = collect_all(skip_doctor=args.skip_doctor)
    write_snapshot(data)
    if not args.quiet:
        print(_snapshot_md().read_text(encoding="utf-8"))
        print(f"\n[snapshot] elapsed {data.get('elapsed_s')}s · "
              f"json={_snapshot_json()} · md={_snapshot_md()}")
    return 0


def _cmd_show(args: argparse.Namespace) -> int:
    md = _snapshot_md()
    if not md.exists():
        print("No snapshot yet. Run: system_snapshot.py refresh", file=sys.stderr)
        return 1
    print(md.read_text(encoding="utf-8"))
    return 0


def _cmd_json(args: argparse.Namespace) -> int:
    j = _snapshot_json()
    if not j.exists():
        print("No snapshot yet. Run: system_snapshot.py refresh", file=sys.stderr)
        return 1
    print(j.read_text(encoding="utf-8"))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="system_snapshot.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_refresh = sub.add_parser("refresh", help="collect + write both files")
    p_refresh.add_argument("--quiet", action="store_true")
    p_refresh.add_argument("--skip-doctor", action="store_true",
                           help="skip the doctor invocation (faster: ~3s vs ~30s)")
    p_refresh.set_defaults(func=_cmd_refresh)

    p_show = sub.add_parser("show", help="cat the markdown snapshot")
    p_show.set_defaults(func=_cmd_show)

    p_json = sub.add_parser("json", help="cat the json snapshot")
    p_json.set_defaults(func=_cmd_json)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
