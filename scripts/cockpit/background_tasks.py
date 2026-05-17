#!/usr/bin/env python3
"""
ULTRON v12.4 — Background Task Registry (Task 10E)

Defines the canonical set of background automation tasks and their
schedules. Tasks are run by the Stop hook or manually via this script.

Each task entry:
  name, description, script, args, trigger, last_run, status

Commands:
    background_tasks.py list            Show all tasks and last-run status
    background_tasks.py run <name>      Run a task now
    background_tasks.py run-all         Run all auto tasks in dependency order
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

COCKPIT_DIR  = Path(__file__).parent
TASKS_FILE   = Path.home() / ".ultron" / "background_tasks.json"

# ── Canonical task registry ────────────────────────────────────────────────────
TASKS: list[dict] = [
    {
        "name":        "brain-index-update",
        "description": "Update FTS5 brain index from vault notes",
        "script":      "brain_index.py",
        "args":        ["update"],
        "trigger":     "every_stop",
        "priority":    1,
    },
    {
        "name":        "decay-queue-prime",
        "description": "Score note staleness and prime decay queue",
        "script":      "decay_queue.py",
        "args":        ["prime"],
        "trigger":     "every_stop",
        "priority":    2,
    },
    {
        "name":        "skill-manifest-rebuild",
        "description": "Rebuild skill manifest from all scan roots",
        "script":      "skill_manifest.py",
        "args":        ["rebuild"],
        "trigger":     "daily",
        "priority":    3,
    },
    {
        "name":        "skill-digests-build",
        "description": "Regenerate 100-250 token digests for all active skills",
        "script":      "skill_summarizer.py",
        "args":        ["build"],
        "trigger":     "daily",
        "priority":    4,
    },
    {
        "name":        "agent-manifest-rebuild",
        "description": "Rebuild agent manifest from ~/.claude/agents/",
        "script":      "agent_manifest.py",
        "args":        ["rebuild"],
        "trigger":     "daily",
        "priority":    5,
    },
    {
        "name":        "route-quality-init",
        "description": "Seed any new route edges from manifest into route_quality.json",
        "script":      "route_quality.py",
        "args":        ["init"],
        "trigger":     "daily",
        "priority":    6,
    },
    {
        "name":        "route-quality-aggregate",
        "description": "Aggregate today's routing.jsonl telemetry into route_quality.json",
        "script":      "route_quality_aggregator.py",
        "args":        ["aggregate", "--today"],
        "trigger":     "every_stop",
        "priority":    3,
        "timeout":     30,
    },
    {
        "name":        "memory-bridge-sync",
        "description": "Sync CC project memories ↔ vault (wikilink repair)",
        "script":      "memory_bridge.py",
        "args":        ["sync"],
        "trigger":     "weekly",
        "priority":    7,
    },
    {
        "name":        "vault-memory-sync",
        "description": "Git commit + push vault notes to L3 remote",
        "script":      "memory_sync.py",
        "args":        ["push"],
        "trigger":     "high_mode_stop",
        "priority":    8,
    },
    {
        "name":        "validate-skills",
        "description": "Validate + auto-fix SKILL.md frontmatter (BOM, YAML hazards, mojibake) across .claude/.agents/.codex skill roots; flags desc>1024 for manual review",
        "script":      "validate_skills.py",
        "args":        ["fix"],
        "trigger":     "daily",
        "priority":    10,
        "timeout":     45,
    },
]


def _load_state() -> dict:
    if TASKS_FILE.exists():
        try:
            return json.loads(TASKS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"tasks": {}}


def _save_state(state: dict) -> None:
    TASKS_FILE.parent.mkdir(parents=True, exist_ok=True)
    TASKS_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


def _append_finding(findings_path: Path, task_name: str, status: str, output: str) -> None:
    try:
        findings_path.parent.mkdir(parents=True, exist_ok=True)
        entry = json.dumps({
            "ts":     datetime.now().isoformat(timespec="seconds"),
            "task":   task_name,
            "status": status,
            "output": output[-300:],
        }, ensure_ascii=False)
        with findings_path.open("a", encoding="utf-8") as f:
            f.write(entry + "\n")
    except OSError:
        pass


def _run_task(task: dict, state: dict, verbose: bool = True,
              findings_out: Path | None = None) -> bool:
    script = COCKPIT_DIR / task["script"]
    if not script.exists():
        if verbose:
            print(f"  [skip] {task['name']}: script not found ({script})")
        return False
    cmd = [sys.executable, str(script)] + task["args"]
    try:
        task_timeout = task.get("timeout", 60)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=task_timeout,
                                creationflags=_WIN_HIDDEN)
        ok = result.returncode == 0
        combined = (result.stdout + result.stderr).strip()
        state["tasks"][task["name"]] = {
            "last_run":    datetime.now().isoformat(),
            "last_status": "ok" if ok else "error",
            "last_output": combined[-300:],
        }
        if verbose:
            status = "ok" if ok else "FAILED"
            print(f"  [{status:<6}] {task['name']}")
            if not ok and result.stderr:
                print(f"           {result.stderr.strip()[:120]}")
        if not ok and findings_out:
            _append_finding(findings_out, task["name"], "error", combined)
        return ok
    except subprocess.TimeoutExpired:
        task_timeout = task.get("timeout", 60)
        state["tasks"][task["name"]] = {
            "last_run":    datetime.now().isoformat(),
            "last_status": "timeout",
            "last_output": f"timed out after {task_timeout}s",
        }
        if verbose:
            print(f"  [TIMEOUT] {task['name']}")
        if findings_out:
            _append_finding(findings_out, task["name"], "timeout", f"timed out after {task_timeout}s")
        return False
    except OSError as e:
        if verbose:
            print(f"  [ERROR ] {task['name']}: {e}")
        if findings_out:
            _append_finding(findings_out, task["name"], "os-error", str(e))
        return False


def cmd_list(_args) -> int:
    state = _load_state()
    print(f"\nBackground Tasks  ({len(TASKS)} registered)")
    print("=" * 72)
    for task in sorted(TASKS, key=lambda t: t["priority"]):
        ts_info = state.get("tasks", {}).get(task["name"], {})
        last_run = ts_info.get("last_run", "never")[:16].replace("T", " ")
        last_status = ts_info.get("last_status", "—")
        trigger = task["trigger"]
        print(f"  {task['name']:<35} trigger={trigger:<20} last={last_run}  [{last_status}]")
        print(f"    {task['description']}")
    print()
    return 0


def cmd_run(args) -> int:
    name = args.name
    task = next((t for t in TASKS if t["name"] == name), None)
    if not task:
        print(f"[bg] Unknown task: {name!r}")
        print(f"     Available: {', '.join(t['name'] for t in TASKS)}")
        return 1
    state = _load_state()
    ok = _run_task(task, state, verbose=True)
    _save_state(state)
    return 0 if ok else 1


def cmd_run_all(args) -> int:
    trigger_filter = getattr(args, "trigger", None)
    findings_out   = Path(args.findings_out) if getattr(args, "findings_out", None) else None
    state = _load_state()
    today = datetime.now().strftime("%Y-%m-%d")

    candidates = sorted(TASKS, key=lambda t: t["priority"])
    if trigger_filter:
        candidates = [t for t in candidates if t["trigger"] == trigger_filter]
    # Daily tasks: skip if already ran today (idempotent for Stop hook re-runs)
    if trigger_filter == "daily":
        candidates = [t for t in candidates
                      if state.get("tasks", {}).get(t["name"], {}).get("last_run", "")[:10] != today]

    if not candidates:
        print(f"[bg] No tasks to run (trigger={trigger_filter!r}, already ran today or no match)")
        return 0

    print(f"\nRunning {len(candidates)} background task(s) (trigger={trigger_filter or 'all'}) …")
    ok_count = 0
    for task in candidates:
        if _run_task(task, state, verbose=True, findings_out=findings_out):
            ok_count += 1
    _save_state(state)
    print(f"\n[bg] Done: {ok_count}/{len(candidates)} tasks succeeded")
    return 0


def main() -> int:
    import argparse
    p = argparse.ArgumentParser(description="ULTRON v12.4 Background Task Registry")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="Show all tasks and last-run status")
    rp = sub.add_parser("run", help="Run a single task now")
    rp.add_argument("name", help="Task name")
    ra = sub.add_parser("run-all", help="Run all tasks in priority order")
    ra.add_argument("--trigger", default=None,
                    help="Only run tasks with this trigger (every_stop, daily, weekly, high_mode_stop)")
    ra.add_argument("--findings-out", default=None,
                    help="Append failure/timeout findings as JSONL to this path")
    args = p.parse_args()
    if args.cmd == "list":    return cmd_list(args)
    if args.cmd == "run":     return cmd_run(args)
    if args.cmd == "run-all": return cmd_run_all(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
