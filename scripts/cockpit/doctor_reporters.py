"""doctor_reporters — output formatters for ULTRON Doctor.

Formats a ``Report`` object as human-readable text, compact health-check
view, or token-audit table. All output is ASCII-safe (Windows cp1252 safe).

No side effects: every function is pure string-building.
"""
from __future__ import annotations

import io
import json

from doctor_models import (
    SEVERITY_BLOCKING,
    SEVERITY_INFO,
    SEVERITY_WARN,
    Report,
    _now_utc_iso,
)


def format_human(report: Report) -> str:
    """Pretty multi-line human report.

    Findings are grouped by severity (blocking first), each with id,
    category, summary, detail, and optional fix label.

    Args:
        report: The completed ``Report`` instance.

    Returns:
        A multi-line ASCII string suitable for stdout.
    """
    buf = io.StringIO()
    buf.write("ULTRON DOCTOR REPORT\n")
    buf.write("====================\n")
    buf.write(f"generated: {_now_utc_iso()}\n")
    buf.write(f"runtime:   {report.runtime_ms} ms\n")
    n = len(report.findings)
    nb = len(report.by_severity(SEVERITY_BLOCKING))
    nw = len(report.by_severity(SEVERITY_WARN))
    ni = len(report.by_severity(SEVERITY_INFO))
    buf.write(f"summary:   {n} finding(s) (blocking={nb} warn={nw} info={ni})\n\n")
    if not report.findings:
        buf.write("OK -- no findings.\n")
        return buf.getvalue()
    for sev in (SEVERITY_BLOCKING, SEVERITY_WARN, SEVERITY_INFO):
        items = report.by_severity(sev)
        if not items:
            continue
        buf.write(f"[{sev.upper()}] ({len(items)})\n")
        buf.write("-" * 80 + "\n")
        for f in items:
            buf.write(f"  - id:       {f.id}\n")
            buf.write(f"    category: {f.category}\n")
            buf.write(f"    summary:  {f.summary}\n")
            for line in f.detail.splitlines():
                buf.write(f"    | {line}\n")
            if f.fix_action:
                buf.write(f"    fix:      {f.fix_action}\n")
            buf.write("\n")
    return buf.getvalue()


def format_health_check(report: Report) -> str:
    """Compact health view: MCP + ZTMSI + L0 status.

    Args:
        report: The completed ``Report`` instance.

    Returns:
        A short ASCII block showing OK / issue count for the three
        health-check subsystems.
    """
    buf = io.StringIO()
    buf.write("ULTRON HEALTH CHECK\n")
    buf.write("===================\n")
    mcp_findings = [f for f in report.findings if f.category == "mcp"]
    if not mcp_findings:
        buf.write("  MCP servers : OK\n")
    else:
        buf.write(f"  MCP servers : {len(mcp_findings)} issue(s)\n")
        for f in mcp_findings:
            buf.write(f"    - {f.summary}\n")
    z_findings = [f for f in report.findings if f.id.startswith("stale:ztmsi")]
    if not z_findings:
        buf.write("  Brain index : OK\n")
    else:
        buf.write(f"  Brain index : {z_findings[0].summary}\n")
    l0_findings = [f for f in report.findings if f.id.startswith("stale:l0")]
    if not l0_findings:
        buf.write("  L0 context  : OK\n")
    else:
        buf.write(f"  L0 context  : {l0_findings[0].summary}\n")
    return buf.getvalue()


def format_token_audit(rules: dict, measure_fn: object) -> str:  # type: ignore[type-arg]
    """E1 gate output: always-on overhead vs configured limit.

    Args:
        rules: Merged rules dict from ``doctor_rules.load_rules()``.
        measure_fn: Callable that returns ``(total_tokens, parts_dict)``
                    (i.e. ``doctor_checks.measure_token_overhead``).

    Returns:
        A columnar ASCII table with per-source token counts, total, limit,
        and PASS/FAIL status.
    """
    from typing import Callable, Tuple
    limit = int(rules.get("thresholds", {}).get("token_overhead_tokens", 1500))
    total, parts = measure_fn()  # type: ignore[call-arg]
    buf = io.StringIO()
    buf.write("ULTRON TOKEN AUDIT (E1)\n")
    buf.write("=======================\n")
    for name, tok in parts.items():
        buf.write(f"  {name:<24} {tok:>6} tok\n")
    buf.write(f"  {'-' * 32}\n")
    buf.write(f"  {'TOTAL':<24} {total:>6} tok\n")
    buf.write(f"  {'LIMIT':<24} {limit:>6} tok\n")
    status = "PASS" if total <= limit else "FAIL"
    buf.write(f"  {'STATUS':<24} {status:>6}\n")
    return buf.getvalue()


def format_token_audit_json(rules: dict, measure_fn: object) -> dict:  # type: ignore[type-arg]
    """Return the token audit as a serialisable dict (for --json output).

    Args:
        rules: Merged rules dict from ``doctor_rules.load_rules()``.
        measure_fn: Callable that returns ``(total_tokens, parts_dict)``.

    Returns:
        A dict with keys ``total``, ``limit``, ``parts``, ``status``.
    """
    limit = int(rules.get("thresholds", {}).get("token_overhead_tokens", 1500))
    total, parts = measure_fn()  # type: ignore[call-arg]
    return {
        "total": total,
        "limit": limit,
        "parts": parts,
        "status": "pass" if total <= limit else "fail",
    }


def format_health_check_json(report: Report) -> dict:  # type: ignore[type-arg]
    """Return the health-check view as a serialisable dict.

    Args:
        report: The completed ``Report`` instance.

    Returns:
        A dict with keys ``generated_at``, ``mcp``, ``ztmsi``, ``l0``.
    """
    return {
        "generated_at": _now_utc_iso(),
        "mcp": [f.to_dict() for f in report.findings if f.category == "mcp"],
        "ztmsi": [
            f.to_dict() for f in report.findings if f.id.startswith("stale:ztmsi")
        ],
        "l0": [f.to_dict() for f in report.findings if f.id.startswith("stale:l0")],
    }
