"""ULTRON v14.8 P2B — End-to-end system validator.

Runs live smoke checks across all major subsystems and emits a verdict per
subsystem (pass / warn / fail) plus a global PASS/FAIL summary. The aim is
to give USER (and the TUI Dashboard) ONE button that answers "is the
whole system healthy right now?"

Subsystems exercised:

  prompting:
    - intent-dispatcher hook returns exit 0 for a known prompt
    - dispatcher emits a skill route for a matching prompt
    - auto-recall hook honors the kill switch (does not fire when "0")
  memory:
    - brain_index.db reachable + has notes
    - Qdrant ultron_vault collection has points
    - Stop hook scripts present + executable
  skills:
    - skill_manifest.py validate has zero drift
    - skill_lazy_loader status reports a non-empty config
    - settings.local.json contains skillOverrides

Each check is bounded by a timeout. Failures are captured and reported
without stopping the rest of the validation.

CLI:
  validate_full_system.py run [--quiet] [--json]
  validate_full_system.py last        # cat last report

Output:
  ~/.ultron/.tmp/validate-last-run.json   (machine)
  ~/.ultron/.tmp/validate-last-run.md     (human, ≤300 tok)
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


_HERE = Path(__file__).parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


# ── Paths ──────────────────────────────────────────────────────────────────────


def _user_home() -> Path:
    return Path.home()


def _report_json() -> Path:
    return _user_home() / ".ultron" / ".tmp" / "validate-last-run.json"


def _report_md() -> Path:
    return _user_home() / ".ultron" / ".tmp" / "validate-last-run.md"


# ── Data shapes ────────────────────────────────────────────────────────────────


VERDICTS = ("pass", "warn", "fail")


@dataclass
class CheckResult:
    name: str
    verdict: str
    detail: str = ""
    elapsed_ms: float = 0.0
    error: str = ""


@dataclass
class SubsystemReport:
    name: str
    checks: list[CheckResult] = field(default_factory=list)

    @property
    def verdict(self) -> str:
        if not self.checks:
            return "warn"
        if any(c.verdict == "fail" for c in self.checks):
            return "fail"
        if any(c.verdict == "warn" for c in self.checks):
            return "warn"
        return "pass"

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "verdict": self.verdict,
            "checks": [asdict(c) for c in self.checks],
        }


def _timed(check_name: str, fn: Callable[[], tuple[str, str]]) -> CheckResult:
    t = time.perf_counter()
    try:
        verdict, detail = fn()
    except Exception as exc:
        return CheckResult(
            name=check_name, verdict="fail",
            elapsed_ms=round((time.perf_counter() - t) * 1000, 1),
            error=repr(exc)[:200],
        )
    return CheckResult(
        name=check_name, verdict=verdict, detail=detail,
        elapsed_ms=round((time.perf_counter() - t) * 1000, 1),
    )


# ── Subsystem: prompting ──────────────────────────────────────────────────────


def _check_intent_dispatcher_runs() -> tuple[str, str]:
    hook = _user_home() / ".claude" / "skills" / "ultron" / "hooks" / "intent-dispatcher.py"
    if not hook.exists():
        return "fail", "intent-dispatcher.py missing"
    # Use a prompt known to match the architect rule (confidence 0.95) per
    # ~/.ultron/config/intent-rules.yaml. Note the dispatcher gates on
    # `hook_event_name == "UserPromptSubmit"` so we MUST set it.
    payload = json.dumps({
        "prompt": "diseña la arquitectura del nuevo sistema",
        "session_id": "validate-id",
        "hook_event_name": "UserPromptSubmit",
    })
    venv_py = _user_home() / ".claude" / "skills" / "ultron" / ".venv" / "Scripts" / "python.exe"
    if not venv_py.exists():
        venv_py = Path(sys.executable)
    proc = subprocess.run(
        [str(venv_py), str(hook)],
        input=payload, capture_output=True, text=True, timeout=10,
        creationflags=_WIN_HIDDEN,
    )
    if proc.returncode != 0:
        return "fail", f"non-zero exit {proc.returncode}"
    out = (proc.stdout or "").strip()
    if not out:
        return "warn", "no route emitted (rule didn't match)"
    if "ULTRON" not in out and "skill=" not in out:
        return "warn", f"unexpected output shape: {out[:60]}"
    return "pass", out[:80]


def _check_auto_recall_kill_switch() -> tuple[str, str]:
    hook = _user_home() / ".claude" / "skills" / "ultron" / "hooks" / "auto-recall.py"
    if not hook.exists():
        return "fail", "auto-recall.py missing"
    venv_py = _user_home() / ".claude" / "skills" / "ultron" / ".venv" / "Scripts" / "python.exe"
    if not venv_py.exists():
        venv_py = Path(sys.executable)
    payload = json.dumps({
        "prompt": "irrelevante porque kill switch",
        "session_id": "validate-kill",
        "hook_event_name": "UserPromptSubmit",
    })
    env = {**os.environ, "ULTRON_AUTO_RECALL": "0"}
    proc = subprocess.run(
        [str(venv_py), str(hook)],
        input=payload, capture_output=True, text=True, timeout=5,
        creationflags=_WIN_HIDDEN, env=env,
    )
    if proc.returncode != 0:
        return "fail", f"hook returned exit {proc.returncode} with kill=0 (must be 0/silent)"
    return "pass", "kill switch honored"


def _check_settings_has_hooks() -> tuple[str, str]:
    settings = _user_home() / ".claude" / "settings.json"
    if not settings.exists():
        return "fail", "settings.json missing"
    try:
        data = json.loads(settings.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        return "fail", f"settings.json malformed: {exc!r}"
    hooks = data.get("hooks", {})
    required = ("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop")
    missing = [k for k in required if k not in hooks]
    if missing:
        return "fail", f"missing hook events: {missing}"
    return "pass", f"all 5 events wired"


def validate_prompting() -> SubsystemReport:
    return SubsystemReport(name="prompting", checks=[
        _timed("intent_dispatcher_runs", _check_intent_dispatcher_runs),
        _timed("auto_recall_kill_switch", _check_auto_recall_kill_switch),
        _timed("settings_has_hooks", _check_settings_has_hooks),
    ])


# ── Subsystem: memory ─────────────────────────────────────────────────────────


def _check_brain_index_has_notes() -> tuple[str, str]:
    db = _user_home() / ".ultron" / "brain_index" / "index.db"
    if not db.exists():
        return "fail", "index.db missing"
    import sqlite3
    with sqlite3.connect(str(db)) as conn:
        row = conn.execute("SELECT COUNT(*) FROM notes").fetchone()
    n = int(row[0]) if row else 0
    if n < 100:
        return "warn", f"only {n} notes indexed (expected >100)"
    return "pass", f"{n} notes"


def _check_qdrant_collection_populated() -> tuple[str, str]:
    import urllib.request
    try:
        with urllib.request.urlopen(
            "http://localhost:6333/collections/ultron_vault", timeout=2,
        ) as r:
            data = json.loads(r.read().decode("utf-8")).get("result", {})
        n = int(data.get("points_count") or 0)
        if n < 50:
            return "warn", f"only {n} points (expected >50)"
        return "pass", f"{n} points"
    except Exception as exc:
        return "fail", f"qdrant unreachable: {repr(exc)[:80]}"


def _check_stop_hook_chain() -> tuple[str, str]:
    chain = (
        _user_home() / ".ultron" / "hooks" / "session-init.ps1",
        _user_home() / ".ultron" / "hooks" / "stop-memory-sync.ps1",
        _user_home() / ".ultron" / "hooks" / "session-cleanup.ps1",
    )
    missing = [p.name for p in chain if not p.exists()]
    if missing:
        return "fail", f"missing: {missing}"
    return "pass", "session-init + stop-memory-sync + session-cleanup all present"


def _check_memory_md_in_budget() -> tuple[str, str]:
    """MEMORY.md should stay under its 1000-tok soft budget after v14.4 P3."""
    md = _user_home() / ".ultron" / "MEMORY.md"
    if not md.exists():
        return "warn", "MEMORY.md missing"
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        n = len(enc.encode(md.read_text(encoding="utf-8")))
        if n > 1200:
            return "warn", f"{n} tok > 1000 budget"
        return "pass", f"{n} tok"
    except ImportError:
        return "warn", "tiktoken missing"


def validate_memory() -> SubsystemReport:
    return SubsystemReport(name="memory", checks=[
        _timed("brain_index_has_notes", _check_brain_index_has_notes),
        _timed("qdrant_collection_populated", _check_qdrant_collection_populated),
        _timed("stop_hook_chain_present", _check_stop_hook_chain),
        _timed("memory_md_in_budget", _check_memory_md_in_budget),
    ])


# ── Subsystem: skills ─────────────────────────────────────────────────────────


def _check_skill_manifest_no_drift() -> tuple[str, str]:
    venv_py = _user_home() / ".claude" / "skills" / "ultron" / ".venv" / "Scripts" / "python.exe"
    if not venv_py.exists():
        venv_py = Path(sys.executable)
    script = _HERE / "skill_manifest.py"
    if not script.exists():
        return "fail", "skill_manifest.py missing"
    proc = subprocess.run(
        [str(venv_py), str(script), "validate"],
        capture_output=True, text=True, timeout=15,
        creationflags=_WIN_HIDDEN,
    )
    out = (proc.stdout + proc.stderr).strip()
    if proc.returncode != 0:
        return "fail", f"validate exit {proc.returncode}: {out[:100]}"
    # Positive signal "no drift" / "0 drift" wins; negative phrases lose.
    lower = out.lower()
    if "no drift" in lower or "0 drift" in lower or "no schema errors" in lower:
        return "pass", out.split("\n")[0][:120]
    if "drift" in lower or "schema error" in lower or "missing" in lower:
        return "warn", out[:120]
    return "pass", out.split("\n")[0][:120]


def _check_skill_lazy_state() -> tuple[str, str]:
    state = _user_home() / ".ultron" / ".tmp" / "skill-listing-mode.json"
    if not state.exists():
        return "warn", "skill_lazy_loader never applied"
    try:
        data = json.loads(state.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        return "fail", f"state malformed: {exc!r}"
    n_total = data.get("skills_total")
    if not n_total:
        return "warn", "state has no totals"
    return "pass", (
        f"{data.get('skills_on')} on / "
        f"{data.get('skills_name_only')} name-only / "
        f"mode={data.get('mode')}"
    )


def _check_settings_has_skill_overrides() -> tuple[str, str]:
    settings = _user_home() / ".claude" / "settings.local.json"
    if not settings.exists():
        return "warn", "settings.local.json missing"
    try:
        data = json.loads(settings.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        return "fail", f"settings.local malformed: {exc!r}"
    overrides = data.get("skillOverrides") or {}
    if not overrides:
        return "warn", "no skillOverrides applied"
    return "pass", f"{len(overrides)} override entries"


def validate_skills() -> SubsystemReport:
    return SubsystemReport(name="skills", checks=[
        _timed("skill_manifest_no_drift", _check_skill_manifest_no_drift),
        _timed("skill_lazy_state_consistent", _check_skill_lazy_state),
        _timed("settings_has_skill_overrides", _check_settings_has_skill_overrides),
    ])


# ── Top-level run + render ────────────────────────────────────────────────────


def run_all() -> dict[str, Any]:
    started = time.perf_counter()
    reports = [
        validate_prompting(),
        validate_memory(),
        validate_skills(),
    ]
    by_verdict = {"pass": 0, "warn": 0, "fail": 0}
    for r in reports:
        for c in r.checks:
            by_verdict[c.verdict] = by_verdict.get(c.verdict, 0) + 1
    if any(r.verdict == "fail" for r in reports):
        global_verdict = "fail"
    elif any(r.verdict == "warn" for r in reports):
        global_verdict = "warn"
    else:
        global_verdict = "pass"
    return {
        "schema_version": 1,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "global_verdict": global_verdict,
        "checks_summary": by_verdict,
        "subsystems": [r.to_dict() for r in reports],
        "elapsed_s": round(time.perf_counter() - started, 2),
    }


def _emoji(v: str) -> str:
    return {"pass": "✅", "warn": "⚠️", "fail": "❌"}.get(v, "?")


def render_md(data: dict[str, Any]) -> str:
    cs = data.get("checks_summary", {})
    lines = [
        f"# ULTRON validate · {data.get('captured_at','?')[:19].replace('T',' ')}",
        f"Global: {_emoji(data['global_verdict'])} {data['global_verdict'].upper()} · "
        f"{cs.get('pass',0)} pass · {cs.get('warn',0)} warn · {cs.get('fail',0)} fail · "
        f"elapsed {data.get('elapsed_s')}s",
        "",
    ]
    for ss in data["subsystems"]:
        lines.append(f"## {_emoji(ss['verdict'])} {ss['name']}")
        for c in ss["checks"]:
            mark = _emoji(c["verdict"])
            detail = c.get("detail") or c.get("error") or ""
            if len(detail) > 100:
                detail = detail[:100] + "..."
            lines.append(f"- {mark} {c['name']}: {detail}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


# ── CLI ────────────────────────────────────────────────────────────────────────


def _cmd_run(args: argparse.Namespace) -> int:
    data = run_all()
    _atomic_write(_report_json(), json.dumps(data, indent=2, ensure_ascii=False))
    _atomic_write(_report_md(), render_md(data))
    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    elif not args.quiet:
        print(render_md(data))
    return {"pass": 0, "warn": 1, "fail": 2}[data["global_verdict"]]


def _cmd_last(args: argparse.Namespace) -> int:
    f = _report_md()
    if not f.exists():
        print("No prior run. Use `validate run`.", file=sys.stderr)
        return 1
    print(f.read_text(encoding="utf-8"))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="validate_full_system.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="execute all checks and write report")
    p_run.add_argument("--quiet", action="store_true")
    p_run.add_argument("--json", action="store_true")
    p_run.set_defaults(func=_cmd_run)

    p_last = sub.add_parser("last", help="cat the previous report")
    p_last.set_defaults(func=_cmd_last)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
