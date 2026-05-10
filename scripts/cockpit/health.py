#!/usr/bin/env python3
"""
ULTRON v10.4 - Health check.

Verifies all CORE subsystems in one shot:
  - Python + Node.js + claude/gemini/codex CLIs in PATH
  - All cockpit scripts present
  - Config files exist + parse
  - Cron jobs registered
  - Game processes config
  - Pause state
  - Recent audit/usage activity
  - Disk usage of cockpit dir

Output: green check / yellow warn / red fail per item, plus summary.
Exit code: 0 if all green, 2 if any red.

Usage:
    health.py             pretty output
    health.py --json      programmatic
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import COCKPIT_DIR, PROJECTS_JSON, NEWS_DIR  # noqa: E402

ULTRON_SKILL_DIR = Path.home() / ".claude" / "skills" / "ultron"
SCRIPTS_DIR = Path(__file__).resolve().parent
PEER_SCRIPTS = SCRIPTS_DIR.parent

EXPECTED_SCRIPTS = [
    # Core ops
    "cockpit_base.py", "scan_projects.py", "launch_project.py",
    "retention.py", "should_run.py", "brain_config.py", "ultron_paths.py",
    # News
    "news_html_generator.py", "news_alerts.py", "github_trending.py",
    # Standup + calendar
    "ai_standup.py", "calendar_match.py",
    # MCP
    "mcp_installer.py", "mcp_health_check.py", "mcp_allowlist.py",
    "mcp_broker.py", "mcp_creator.py",
    # Quick tools / launchers / health
    "quick_ask.py", "apps_launcher.py", "persona_audit.py",
    "project_editor.py", "project_notes.py", "auto_updater.py",
    "health.py", "validate_skills.py",
    # Memory + skills SSOT
    "memory_bridge.py", "memory_sync.py",
    "skill_manifest.py", "skill_manifest_to_routing.py",
    "skill_manifest_validate.py", "skill_creator.py",
    "skill_discover.py", "skill_finder.py", "skill_graph.py",
    "skill_summarizer.py", "skill_sync.py", "registry_sync.py",
    "agent_manifest.py", "personas_ssot.py",
    # Sprint 3-4 cockpit (audit pipeline + TUI + sessions)
    "audit_index.py", "audit_to_pending.py", "pending_actions.py",
    "apply_proposals.py", "route_quality.py",
    "route_quality_aggregator.py", "context_primer.py",
    "context_packet_builder.py", "cleanup_inventory.py",
    "session_highlights.py", "session_compactor.py",
    "session_replay.py", "tui.py",
    # v14 GENESIS routing
    "intent_dispatcher.py", "routing_decide.py", "dispatcher_audit.py",
    "decay_queue.py",
    # v14 GENESIS doctor v2 + brain
    "doctor.py", "brain_index.py", "generate_L0.py",
    "frontmatter_backfill.py", "multimodel.py", "token_budget.py",
    # v14.4 TOKEN HUNTER (Phase 0 + 1 + 2 + 3)
    "token_baseline.py",
    "skill_lazy_loader.py",
    "cache_telemetry.py",
    "memory_dedupe.py",
    # v14.5 META-PROMPTER (Phase 1 + 3 + 4)
    "prompt_improver.py",
    "prompt_registry.py",
    "prompt_eval.py",
    # v14.6 PERFECT MEMORY (Phase 1 + 2 + 3)
    "embed_vault.py",
    "hybrid_retriever.py",
    # v14.8 ULTRA POLISH (Phase 1 — auto-recall hook lives in hooks/, not here)
    # v14.8 P2: snapshot + validator
    "system_snapshot.py",
    "validate_full_system.py",
    # v14.8 P3: skills catalog → Qdrant
    "embed_skills.py",
    # v14.8: web auto-publisher
    "web_publisher.py",
    # v14.8 P5: cross-encoder re-ranking
    "cross_encoder.py",
    # v14 GENESIS security (Sprint 5-C)
    "hook_input_validator.py", "path_traversal_guard.py",
    "secrets_manager.py", "secrets_scanner.py",
    "settings_integrity.py", "silent_exec.py",
    "skill_provenance.py", "skill_sync_security.py",
    "audit_silent_exec.py",
    # v14 GENESIS alerts + bus
    "alerts.py", "changelog_registry.py",
    # v14.1 GENESIS deadwood
    "deadwood_scanner.py",
    # Misc / one-off / background
    "shadow_review.py", "strip_skill_bom.py", "setup_github_token.py",
    "on_wake.py", "job_supervisor.py", "background_tasks.py",
    "vault_migrator.py", "usage_report.py", "research.py",
    "research_premium.py", "game_detector.py",
]
EXPECTED_PEER_HELPERS = ["shared-duet.ps1"]
EXPECTED_CONFIGS = ["projects.json", "apps.json", "schedule-config.json",
                    "ide-mappings.json", "mcp-catalog.json"]


class Check:
    def __init__(self, name: str, status: str, detail: str = ""):
        self.name = name
        self.status = status   # "ok", "warn", "fail"
        self.detail = detail


def check_binary(name: str) -> Check:
    path = shutil.which(name)
    if path:
        return Check(f"{name} CLI", "ok", path)
    return Check(f"{name} CLI", "fail", "not found in PATH")


def check_python_version() -> Check:
    v = sys.version_info
    if v.major == 3 and v.minor >= 10:
        return Check("Python", "ok", f"{v.major}.{v.minor}.{v.micro}")
    return Check("Python", "warn", f"{v.major}.{v.minor} (>=3.10 recommended)")


def check_scripts() -> list[Check]:
    out = []
    for name in EXPECTED_SCRIPTS:
        p = SCRIPTS_DIR / name
        if p.exists():
            out.append(Check(f"script: {name}", "ok", f"{p.stat().st_size}b"))
        else:
            out.append(Check(f"script: {name}", "fail", "missing"))
    for name in EXPECTED_PEER_HELPERS:
        p = PEER_SCRIPTS / name
        if p.exists():
            out.append(Check(f"helper: {name}", "ok", f"{p.stat().st_size}b"))
        else:
            out.append(Check(f"helper: {name}", "fail", "missing"))
    return out


def check_configs() -> list[Check]:
    out = []
    for name in EXPECTED_CONFIGS:
        p = COCKPIT_DIR / name
        if not p.exists():
            out.append(Check(f"config: {name}", "warn", "absent (will be created on use)"))
            continue
        try:
            json.loads(p.read_text(encoding="utf-8-sig"))
            out.append(Check(f"config: {name}", "ok", f"{p.stat().st_size}b valid"))
        except (json.JSONDecodeError, OSError) as e:
            out.append(Check(f"config: {name}", "fail", f"parse error: {e}"))
    return out


def check_cron_jobs() -> Check:
    """Check Windows Task Scheduler for ULTRON tasks."""
    try:
        result = subprocess.run(
            ["schtasks", "/Query", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=10, encoding="utf-8",
            errors="replace", creationflags=_WIN_HIDDEN,
        )
        if result.returncode != 0:
            return Check("cron jobs", "warn", "schtasks query failed")
        ultron_lines = [l for l in result.stdout.splitlines()
                        if "Ultron" in l or "ULTRON" in l]
        n = len(ultron_lines)
        if n == 0:
            return Check("cron jobs", "warn",
                         "0 tasks (run: ultron schedule install)")
        if n < 5:
            return Check("cron jobs", "warn", f"{n} tasks (expected ~7)")
        return Check("cron jobs", "ok", f"{n} ULTRON tasks scheduled")
    except (subprocess.TimeoutExpired, OSError) as e:
        return Check("cron jobs", "warn", f"check failed: {e}")


def check_pause_state() -> Check:
    pause_file = COCKPIT_DIR / "paused-until.txt"
    if not pause_file.exists():
        return Check("pause state", "ok", "not paused")
    try:
        until = datetime.fromisoformat(pause_file.read_text(encoding="utf-8").strip())
        if until > datetime.now():
            mins = int((until - datetime.now()).total_seconds() / 60)
            return Check("pause state", "warn",
                         f"paused for {mins}min more (until {until.strftime('%H:%M')})")
        return Check("pause state", "ok", "expired pause marker (will clean)")
    except (ValueError, OSError):
        return Check("pause state", "warn", "invalid marker")


def check_recent_audit() -> Check:
    audits_dir = COCKPIT_DIR / "audits"
    if not audits_dir.exists():
        return Check("recent audits", "warn", "no audits yet")
    audits = sorted(audits_dir.glob("*.md"), key=lambda p: p.stat().st_mtime,
                     reverse=True)
    if not audits:
        return Check("recent audits", "warn", "no audits yet")
    latest = audits[0]
    age_days = (datetime.now() -
                datetime.fromtimestamp(latest.stat().st_mtime)).days
    return Check("recent audits", "ok",
                 f"{len(audits)} audits, latest: {latest.stem} ({age_days}d old)")


def check_recent_usage() -> Check:
    cc_dir = Path.home() / ".claude" / "projects"
    if not cc_dir.exists():
        return Check("usage data", "warn", "no Claude Code sessions found")
    cutoff = (datetime.now() - timedelta(days=1)).timestamp()
    recent_count = 0
    for project_dir in cc_dir.iterdir():
        if not project_dir.is_dir():
            continue
        for jsonl in project_dir.glob("*.jsonl"):
            try:
                if jsonl.stat().st_mtime >= cutoff:
                    recent_count += 1
            except OSError:
                continue
    if recent_count == 0:
        return Check("usage data", "warn", "no sessions last 24h")
    return Check("usage data", "ok", f"{recent_count} active sessions (24h)")


def check_news_freshness() -> Check:
    if not NEWS_DIR.exists():
        return Check("news freshness", "warn", "no news dir")
    # news_html_generator.py writes news_YYYYMMDD-HHMMSS.html
    html_files = sorted(NEWS_DIR.glob("news_*.html"),
                        key=lambda p: p.stat().st_mtime, reverse=True)
    if not html_files:
        return Check("news freshness", "warn", "no HTML newsletters yet (run: ultron news)")
    latest = html_files[0]
    age_days = (datetime.now() - datetime.fromtimestamp(latest.stat().st_mtime)).days
    if age_days == 0:
        return Check("news freshness", "ok", f"today's HTML exists ({latest.stat().st_size}b)")
    if age_days <= 2:
        return Check("news freshness", "ok", f"latest: {latest.name} ({age_days}d old)")
    return Check("news freshness", "warn", f"latest: {latest.name} ({age_days}d old — stale)")


def check_consistency() -> Check:
    """v10.5: run consistency-check.py and reflect its exit code in health.

    Avoids the 'ALL GREEN with 2 problems detected' inconsistency.
    """
    script = ULTRON_SKILL_DIR / "scripts" / "consistency-check.py"
    if not script.exists():
        return Check("consistency", "warn", "consistency-check.py missing")
    try:
        r = subprocess.run([sys.executable, str(script)],
                           capture_output=True, text=True, timeout=120,
                           encoding="utf-8", errors="replace",
                           creationflags=_WIN_HIDDEN)
        # Last line typically: '✅ Sin problemas' or '❌ N problema(s) detectado(s):'
        tail = (r.stdout or "").strip().splitlines()
        summary = ""
        for line in reversed(tail):
            if "problema" in line.lower() or "Sin problemas" in line:
                summary = line.strip()
                break
        if r.returncode == 0:
            return Check("consistency", "ok", summary or "no issues")
        return Check("consistency", "warn",
                     summary or f"exit={r.returncode} (run consistency-check)")
    except subprocess.TimeoutExpired:
        return Check("consistency", "warn", "timeout (>120s)")
    except OSError as e:
        return Check("consistency", "warn", f"failed: {e}")


def check_session_cache() -> Check:
    """v12.2: verify ULTRON session cache is fresh (written by SessionStart hook)."""
    session_file = Path.home() / ".ultron" / ".tmp" / "current-session.json"
    if not session_file.exists():
        return Check("session cache", "warn", "no current-session.json (SessionStart hook may be off)")
    try:
        age_mins = (datetime.now() - datetime.fromtimestamp(
            session_file.stat().st_mtime)).total_seconds() / 60
        data = json.loads(session_file.read_text(encoding="utf-8"))
        mode = data.get("mode", "?")
        if age_mins < 1440:  # 24h
            return Check("session cache", "ok", f"mode={mode}, {int(age_mins)}min old")
        return Check("session cache", "warn",
                     f"stale: {int(age_mins/60)}h old (SessionStart hook may be off)")
    except Exception as e:
        return Check("session cache", "warn", f"unreadable: {e}")


def check_pending_proposals() -> Check:
    """v10.5: surface pending L2 proposals so they don't sit unread."""
    proposals_dir = COCKPIT_DIR / "proposals"
    if not proposals_dir.exists():
        return Check("pending proposals", "ok", "none")
    pending = []
    for f in proposals_dir.glob("*.json"):
        if f.stem.endswith(".applied"):
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if data.get("status") == "consumed":
                continue
            n = sum(1 for p in data.get("proposals", [])
                    if p.get("old_string")
                    and p.get("false_positive_risk") in (None, "none", "low"))
            if n > 0:
                pending.append((f.stem, n))
        except (OSError, json.JSONDecodeError):
            continue
    if not pending:
        return Check("pending proposals", "ok", "none")
    total = sum(n for _, n in pending)
    return Check("pending proposals", "warn",
                 f"{len(pending)} file(s), {total} actionable "
                 f"(run: ultron updater apply-auto)")


def check_memory_bridge() -> Check:
    """v12.2: warn if CC project memories are not being bridged to vault."""
    bridge_index = COCKPIT_DIR / "bridge-index.json"
    if not bridge_index.exists():
        return Check("memory bridge", "warn",
                     "never run (run: ultron memory bridge ingest)")
    try:
        data = json.loads(bridge_index.read_text(encoding="utf-8"))
        ingested = data.get("ingested", {})
        updated = data.get("updated", "")
        if updated:
            from datetime import timedelta
            age_hours = (datetime.now() -
                         datetime.fromisoformat(updated)).total_seconds() / 3600
            age_str = f"{age_hours:.0f}h ago"
        else:
            age_str = "unknown"
        n = len(ingested)
        return Check("memory bridge", "ok",
                     f"{n} CC memories synced, last: {age_str}")
    except (json.JSONDecodeError, OSError, ValueError) as e:
        return Check("memory bridge", "warn", f"index unreadable: {e}")


def check_skill_manifest() -> Check:
    """v12.2: warn if skill manifest is missing or has many untracked skills."""
    manifest_path = Path.home() / ".ultron" / "skill_manifest.json"
    if not manifest_path.exists():
        return Check("skill manifest", "warn",
                     "not built (run: ultron skills manifest rebuild)")
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        skills = data.get("skills", {})
        unknown = sum(1 for s in skills.values()
                      if s.get("installer") == "unknown" and s.get("status") == "active")
        updated = data.get("updated", "")[:10]
        total = len(skills)
        if unknown > 10:
            return Check("skill manifest", "warn",
                         f"{total} skills, {unknown} untracked (run: ultron skills manifest sync-prompt)")
        return Check("skill manifest", "ok",
                     f"{total} skills, {unknown} unknown, updated {updated}")
    except (json.JSONDecodeError, OSError) as e:
        return Check("skill manifest", "warn", f"unreadable: {e}")


def check_disk_usage() -> Check:
    if not COCKPIT_DIR.exists():
        return Check("disk usage", "warn", "cockpit dir missing")
    total = 0
    file_count = 0
    for p in COCKPIT_DIR.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
                file_count += 1
            except OSError:
                continue
    mb = total / (1024 * 1024)
    if mb > 100:
        return Check("disk usage", "warn",
                     f"{mb:.1f}MB / {file_count} files (consider retention)")
    return Check("disk usage", "ok", f"{mb:.1f}MB / {file_count} files")


def _safe(fn, name: str) -> list[Check]:
    try:
        result = fn()
        return result if isinstance(result, list) else [result]
    except Exception as exc:
        return [Check(name, "fail", f"check threw: {exc}")]


def run_all_checks() -> list[Check]:
    out = []
    for fn, name in [
        (check_python_version,    "Python version"),
        (lambda: check_binary("node"),   "node CLI"),
        (lambda: check_binary("claude"), "claude CLI"),
        (lambda: check_binary("gemini"), "gemini CLI"),
        (lambda: check_binary("codex"),  "codex CLI"),
        (check_scripts,           "scripts"),
        (check_configs,           "configs"),
        (check_cron_jobs,         "cron jobs"),
        (check_pause_state,       "pause state"),
        (check_recent_audit,      "recent audits"),
        (check_recent_usage,      "usage data"),
        (check_news_freshness,    "news freshness"),
        (check_session_cache,     "session cache"),
        (check_pending_proposals, "pending proposals"),
        (check_memory_bridge,     "memory bridge"),
        (check_skill_manifest,    "skill manifest"),
        (check_consistency,       "consistency"),
        (check_disk_usage,        "disk usage"),
    ]:
        out.extend(_safe(fn, name))
    return out


def render_pretty(checks: list[Check]) -> int:
    icons = {"ok": "[OK]  ", "warn": "[WARN]", "fail": "[FAIL]"}
    n_ok = sum(1 for c in checks if c.status == "ok")
    n_warn = sum(1 for c in checks if c.status == "warn")
    n_fail = sum(1 for c in checks if c.status == "fail")

    print()
    print("ULTRON CORE Health Check")
    print("=" * 60)
    # Group output: binaries first, then scripts, then configs, then runtime
    for c in checks:
        icon = icons.get(c.status, "?")
        print(f"  {icon} {c.name:<32} {c.detail}")
    print()
    print(f"Summary: {n_ok} OK · {n_warn} warnings · {n_fail} failures")
    if n_fail > 0:
        print("Status: FAIL — investigate red items above")
        return 2
    if n_warn > 0:
        print("Status: OK with warnings — system functional")
        return 0
    print("Status: ALL GREEN")
    return 0


def main():
    p = argparse.ArgumentParser(description="ULTRON CORE health check")
    p.add_argument("--json", action="store_true", help="JSON output")
    args = p.parse_args()
    checks = run_all_checks()

    if args.json:
        print(json.dumps([{"name": c.name, "status": c.status, "detail": c.detail}
                          for c in checks], indent=2))
        return 0
    return render_pretty(checks)


if __name__ == "__main__":
    sys.exit(main())
