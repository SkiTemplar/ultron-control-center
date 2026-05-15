"""ULTRON Control Center — doctor wrapper with Control-Center-specific checks.

Invoked by the Tauri `run_doctor` command. Pipes a structured plain-text
report back so the UI can render it directly. Re-uses the legacy
`doctor.py` (when available) for the big system-wide health pass and
adds checks that matter most to the Control Center user.

Exit code: 0 if no critical findings, 1 if any blocking issue.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import List, Tuple

HOME = Path(os.path.expanduser("~"))
ULTRON = HOME / ".ultron"
CLAUDE = HOME / ".claude"
VAULT = HOME / ".ultron-vault"


def _line(level: str, source: str, msg: str) -> Tuple[str, str, str, str]:
    return (level, source, msg, _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds") + "Z")


def check_claude_config() -> List[Tuple[str, str, str, str]]:
    out: List[Tuple[str, str, str, str]] = []
    settings = CLAUDE / "settings.json"
    if not settings.exists():
        out.append(_line("critical", "claude.config", "settings.json not found"))
        return out
    try:
        with settings.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        out.append(_line("critical", "claude.config", f"settings.json parse error: {exc}"))
        return out
    mcps = data.get("mcpServers", {}) or {}
    if not mcps:
        out.append(_line("warn", "claude.config", "No mcpServers configured"))
    else:
        out.append(_line("info", "claude.config", f"{len(mcps)} MCP servers configured"))
    hooks = data.get("hooks", {}) or {}
    if not hooks:
        out.append(_line("warn", "claude.config", "No hooks configured — recall/intent/telemetry off"))
    return out


def check_qdrant_native() -> List[Tuple[str, str, str, str]]:
    out: List[Tuple[str, str, str, str]] = []
    try:
        import urllib.request
        with urllib.request.urlopen("http://localhost:6333/healthz", timeout=2) as r:
            if r.status == 200:
                out.append(_line("info", "qdrant", "healthz OK"))
            else:
                out.append(_line("warn", "qdrant", f"healthz HTTP {r.status}"))
    except Exception as exc:
        out.append(_line("critical", "qdrant", f"not reachable: {exc}"))
    return out


def check_brain_index() -> List[Tuple[str, str, str, str]]:
    out: List[Tuple[str, str, str, str]] = []
    db = ULTRON / "brain_index" / "index.db"
    if not db.exists():
        out.append(_line("critical", "brain.index", "index.db missing — run brain_index.py update"))
        return out
    try:
        conn = sqlite3.connect(str(db))
        cur = conn.cursor()
        cur.execute("SELECT count(*) FROM notes")
        n = cur.fetchone()[0]
        conn.close()
        out.append(_line("info", "brain.index", f"{n} notes indexed"))
    except Exception as exc:
        out.append(_line("critical", "brain.index", f"FTS5 read failed: {exc}"))
    # Age check
    mtime = _dt.datetime.fromtimestamp(db.stat().st_mtime)
    age_hours = (_dt.datetime.now() - mtime).total_seconds() / 3600
    if age_hours > 48:
        out.append(_line("warn", "brain.index", f"stale: {int(age_hours)}h old"))
    return out


def check_vault() -> List[Tuple[str, str, str, str]]:
    out: List[Tuple[str, str, str, str]] = []
    if not VAULT.exists():
        out.append(_line("critical", "vault", "L2 vault not found at ~/.ultron-vault"))
        return out
    md_count = 0
    base_parts = set(VAULT.parts)
    for path in VAULT.rglob("*.md"):
        # Skip dotfile children of the vault (e.g. ~/.ultron-vault/.obsidian),
        # but not the vault root itself which legitimately starts with a dot.
        extra = [p for p in path.parts if p not in base_parts]
        if any(p.startswith(".") for p in extra):
            continue
        md_count += 1
        if md_count > 25_000:
            break
    out.append(_line("info", "vault", f"{md_count} markdown notes"))
    return out


def check_skills_registry() -> List[Tuple[str, str, str, str]]:
    out: List[Tuple[str, str, str, str]] = []
    reg = ULTRON / "skills" / "registry.json"
    if not reg.exists():
        out.append(_line("warn", "skills.registry", "registry.json missing — run skill_vault.py registry"))
        return out
    try:
        with reg.open("r", encoding="utf-8") as f:
            data = json.load(f)
        skills = data.get("skills", {}) or {}
        out.append(_line("info", "skills.registry", f"{len(skills)} skills"))
        broken: List[str] = []
        for key, entry in skills.items():
            path = entry.get("path")
            if path and not Path(path).joinpath("SKILL.md").exists():
                broken.append(key)
        if broken:
            preview = ", ".join(broken[:5])
            extra = f" (+{len(broken) - 5} more)" if len(broken) > 5 else ""
            out.append(_line("warn", "skills.registry", f"{len(broken)} skill paths broken: {preview}{extra}"))
    except Exception as exc:
        out.append(_line("warn", "skills.registry", f"parse failed: {exc}"))
    return out


def check_hooks() -> List[Tuple[str, str, str, str]]:
    out: List[Tuple[str, str, str, str]] = []
    hooks_dir = ULTRON / "scripts" / "hooks"
    if not hooks_dir.exists():
        out.append(_line("warn", "hooks", "hooks directory missing"))
        return out
    required = ["session-init.ps1", "stop-memory-sync.ps1", "ensure-qdrant.ps1"]
    missing = [name for name in required if not (hooks_dir / name).exists()]
    if missing:
        out.append(_line("warn", "hooks", f"missing scripts: {', '.join(missing)}"))
    else:
        out.append(_line("info", "hooks", "all required hook scripts present"))
    return out


def check_legacy_doctor() -> List[Tuple[str, str, str, str]]:
    out: List[Tuple[str, str, str, str]] = []
    legacy = ULTRON / "scripts" / "cockpit" / "doctor.py"
    if not legacy.exists():
        return out
    try:
        result = subprocess.run(
            ["uv", "run", "python", str(legacy), "--json", "--quiet"],
            capture_output=True,
            text=True,
            timeout=45,
        )
    except subprocess.TimeoutExpired:
        out.append(_line("warn", "doctor.legacy", "timed out after 45s"))
        return out
    except Exception as exc:
        out.append(_line("warn", "doctor.legacy", f"invocation failed: {exc}"))
        return out
    if not result.stdout.strip():
        return out
    try:
        payload = json.loads(result.stdout)
    except Exception:
        return out
    for finding in payload.get("findings", [])[:20]:
        out.append(
            _line(
                str(finding.get("severity", "info")),
                f"legacy.{finding.get('category', 'doctor')}",
                str(finding.get("message", "")),
            )
        )
    return out


def main() -> int:
    findings: List[Tuple[str, str, str, str]] = []
    findings.extend(check_claude_config())
    findings.extend(check_qdrant_native())
    findings.extend(check_brain_index())
    findings.extend(check_vault())
    findings.extend(check_skills_registry())
    findings.extend(check_hooks())
    findings.extend(check_legacy_doctor())

    by_level: dict[str, int] = {}
    for level, *_rest in findings:
        by_level[level] = by_level.get(level, 0) + 1

    print(f"ULTRON Doctor · {_dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds')}Z")
    print("=" * 60)
    summary_parts = []
    for level in ("critical", "blocking", "warn", "info"):
        if by_level.get(level):
            summary_parts.append(f"{by_level[level]} {level}")
    print("Summary: " + (" · ".join(summary_parts) if summary_parts else "no findings"))
    print()

    for level, source, msg, ts in findings:
        prefix = {
            "critical": "[CRIT]",
            "blocking": "[BLOCK]",
            "warn": "[WARN]",
            "info": "[ OK ]",
        }.get(level, "[ -- ]")
        print(f"{prefix} {source:<24} {msg}")

    blocking_count = by_level.get("critical", 0) + by_level.get("blocking", 0)
    return 1 if blocking_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
