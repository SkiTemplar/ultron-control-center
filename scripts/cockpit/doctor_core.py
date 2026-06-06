"""doctor_core — orchestration layer for ULTRON Doctor.

Wires together rules loading, detections, fix application, and the CLI.
This is the only module in the doctor package that contains side effects
(file writes, subprocess invocations, stdin interaction).

Consumers who only need the data model should import ``doctor_models``
directly; consumers who need to run detections should call
``run_all_detections`` from this module.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

_COCKPIT_DIR = Path(__file__).resolve().parent
if str(_COCKPIT_DIR) not in sys.path:
    sys.path.insert(0, str(_COCKPIT_DIR))

from doctor_models import (  # noqa: E402
    SEVERITY_BLOCKING,
    SEVERITY_WARN,
    Finding,
    Report,
    _append_jsonl,
    _atomic_write_text,
    _now_utc_iso,
)
from doctor_rules import DOCTOR_RULES_YAML, load_rules  # noqa: E402
from doctor_checks import _ALL_DETECTORS, _SECURITY_DETECTORS, measure_token_overhead  # noqa: E402
from doctor_reporters import (  # noqa: E402
    format_health_check,
    format_health_check_json,
    format_human,
    format_token_audit,
    format_token_audit_json,
)

from silent_exec import silent_run  # noqa: E402

ULTRON_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / ".ultron"
DOCTOR_FIX_LOG = ULTRON_HOME / ".tmp" / "doctor-fix-log.jsonl"

# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def run_all_detections(
    rules: dict[str, Any] | None = None,
    detectors: tuple = _ALL_DETECTORS,
) -> Report:
    """Run every detector in *detectors* and return a :class:`Report`.

    Args:
        rules: Pre-loaded rules dict. If ``None`` the default rules path is
               loaded via ``load_rules()``.
        detectors: Tuple of detector callables. Defaults to ``_ALL_DETECTORS``
                   (every detection in ``doctor_checks``).

    Returns:
        A ``Report`` with all findings and elapsed ``runtime_ms``.
    """
    if rules is None:
        rules = load_rules()
    rep = Report()
    t0 = time.perf_counter()
    for det in detectors:
        try:
            rep.extend(det(rules))
        except Exception as exc:  # noqa: BLE001
            rep.add(Finding(
                id=f"integrity:detector_error:{det.__name__}",
                category="integrity",
                severity=SEVERITY_WARN,
                summary=f"Detector {det.__name__} crashed: {type(exc).__name__}",
                detail=f"Exception: {exc!r}",
                fix_action=None,
                fix_command=None,
            ))
    rep.runtime_ms = int((time.perf_counter() - t0) * 1000)
    return rep


# ---------------------------------------------------------------------------
# Fix workflow
# ---------------------------------------------------------------------------


def _confirm(prompt: str) -> bool:
    """Read a y/N answer from stdin. Default N. EOF/KeyboardInterrupt -> N."""
    try:
        ans = input(prompt).strip().lower()
    except (EOFError, KeyboardInterrupt):
        return False
    return ans in ("y", "yes")


def _gate_fix_invocation(yes_flag: bool) -> bool:
    """TTY gate for --fix (F08).

    Refuses to run without ``--yes`` when stdin is piped (non-interactive).
    The ``--yes`` flag must be explicit on the command line — never read from
    env vars or config files.

    Args:
        yes_flag: True if ``--yes`` was passed on the command line.

    Returns:
        True iff fixes may proceed.
    """
    if not sys.stdin.isatty():
        if not yes_flag:
            print(
                "[doctor --fix] requires interactive terminal or "
                "explicit --yes flag",
                file=sys.stderr,
            )
            return False
    return True


def _run_fix(f: Finding) -> int:
    """Execute ``Finding.fix_command`` via ``silent_run`` and return exit code."""
    if not f.fix_command:
        return 0
    try:
        proc = silent_run(list(f.fix_command), timeout=120)
        return int(proc.returncode)
    except Exception:  # noqa: BLE001
        return -1


def apply_fixes_interactively(
    report: Report,
    *,
    stdout: Any = None,
    yes_all: bool = False,
) -> int:
    """Walk every Finding with a non-None fix_command, prompt y/N, run if y.

    Args:
        report: The ``Report`` whose fixable findings are presented.
        stdout: Stream to write prompts/results to (defaults to ``sys.stdout``).
        yes_all: If ``True`` every fix is accepted without prompting (for
                 non-interactive ``--fix --yes`` invocations).

    Returns:
        The count of fixes actually applied (exit code 0 => all accepted ran OK).
    """
    if stdout is None:
        stdout = sys.stdout
    applied = 0
    for f in report.findings:
        if not f.fix_command:
            continue
        print(f"\n[{f.severity.upper()}] {f.summary}", file=stdout)
        for line in f.detail.splitlines():
            print(f"  {line}", file=stdout)
        cmd_str = " ".join(str(t) for t in f.fix_command)
        print(f"  Proposed fix ({f.fix_action}):\n    {cmd_str}", file=stdout)
        if yes_all:
            print("  --yes provided, accepting fix.", file=stdout)
        elif not _confirm("  Apply this fix? [y/N]: "):
            print("  Skipped.", file=stdout)
            continue
        rc = _run_fix(f)
        applied += 1 if rc == 0 else 0
        _append_jsonl(DOCTOR_FIX_LOG, {
            "ts": _now_utc_iso(),
            "finding_id": f.id,
            "fix_action": f.fix_action,
            "fix_command": list(f.fix_command),
            "exit_code": rc,
        })
        print(f"  -> exit={rc}", file=stdout)
    return applied


# ---------------------------------------------------------------------------
# CLI helpers
# ---------------------------------------------------------------------------


def _exit_code_for(report: Report) -> int:
    """Map worst severity to an exit code (0=OK, 1=warn, 2=blocking)."""
    worst = report.worst_severity()
    if worst == SEVERITY_BLOCKING:
        return 2
    if worst == SEVERITY_WARN:
        return 1
    return 0


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """Parse CLI arguments and run the doctor.

    Args:
        argv: Argument list (defaults to ``sys.argv[1:]``).

    Returns:
        Exit code: 0 = no/info findings, 1 = warn, 2 = blocking.
    """
    parser = argparse.ArgumentParser(
        prog="doctor.py",
        description="ULTRON doctor -- inspect installation, surface drift/staleness/retention.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--fix", action="store_true",
                      help="Interactive per-finding fix prompts (y/N each).")
    mode.add_argument("--dry-run", action="store_true",
                      help="Report only, never write (default behavior).")
    mode.add_argument("--health-check", action="store_true",
                      help="Compact view of MCP + ZTMSI + L0 staleness.")
    mode.add_argument("--token-audit", action="store_true",
                      help="E1 gate: always-on token overhead.")
    mode.add_argument("--security", action="store_true",
                      help="S5-C: only run security detectors.")

    parser.add_argument("--json", action="store_true",
                        help="Print JSON report (overrides human format).")
    parser.add_argument("--quiet", action="store_true",
                        help="Suppress all stdout (exit code only).")
    parser.add_argument("--rules", type=str, default=None,
                        help="Path to alternate doctor-rules.yaml.")
    parser.add_argument("--yes", action="store_true",
                        help="Accept every proposed fix (only for --fix in non-interactive mode).")

    args = parser.parse_args(argv)

    rules_path = Path(args.rules) if args.rules else DOCTOR_RULES_YAML
    rules = load_rules(rules_path)

    if args.token_audit:
        if args.json:
            payload = format_token_audit_json(rules, measure_token_overhead)
            if not args.quiet:
                print(json.dumps(payload, ensure_ascii=False, indent=2))
            return 0 if payload["status"] == "pass" else 1
        if not args.quiet:
            print(format_token_audit(rules, measure_token_overhead), end="")
        total, _ = measure_token_overhead()
        limit = int(rules.get("thresholds", {}).get("token_overhead_tokens", 1500))
        return 0 if total <= limit else 1

    if args.security:
        report = run_all_detections(rules, detectors=_SECURITY_DETECTORS)
        if args.json:
            if not args.quiet:
                print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
        elif not args.quiet:
            print(format_human(report), end="")
        return _exit_code_for(report)

    report = run_all_detections(rules)

    if args.health_check:
        if args.json:
            if not args.quiet:
                print(json.dumps(format_health_check_json(report), ensure_ascii=False, indent=2))
        elif not args.quiet:
            print(format_health_check(report), end="")
        hc_findings = [
            f for f in report.findings
            if f.category == "mcp"
            or f.id.startswith("stale:ztmsi")
            or f.id.startswith("stale:l0")
        ]
        return _exit_code_for(Report(findings=hc_findings))

    if args.fix:
        if not _gate_fix_invocation(args.yes):
            return 2
        applied = apply_fixes_interactively(report, yes_all=args.yes)
        if applied > 0:
            return 0
        return _exit_code_for(report)

    if args.json:
        if not args.quiet:
            print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
        else:
            try:
                _atomic_write_text(
                    ULTRON_HOME / ".tmp" / "doctor-weekly.json",
                    json.dumps(report.to_dict(), ensure_ascii=False, indent=2),
                )
            except OSError:
                pass
    elif not args.quiet:
        print(format_human(report), end="")

    return _exit_code_for(report)


if __name__ == "__main__":
    raise SystemExit(main())
