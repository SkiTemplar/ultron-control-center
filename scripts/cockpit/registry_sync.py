#!/usr/bin/env python3
"""
ULTRON v12.2 — Skills Registry Sync

Three registries kept in sync:
    Claude:  ~/.claude/skills/
    Codex:   ~/.codex/skills/
    Agents:  ~/.agents/skills/

Canonical manifest: ~/.ultron/skills-registry.json
Pending queue:      ~/.ultron/pending-sync/<skill>.json
Protocol doc:       ~/.claude/skills/ultron/ULTRON_SYNC.md

Commands:
    status                       Show drift across all three registries
    propagate [--dry-run]        Copy missing universal skills to other registries
    register <name> [opts]       Register skill in manifest + pending queue
    process-pending [--dry-run]  Process ~/.ultron/pending-sync/ queue
    update-manifest              Rebuild manifest from current disk state
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# ── Paths ─────────────────────────────────────────────────────────────────────

HOME = Path.home()
REGISTRIES = {
    "claude":  HOME / ".claude" / "skills",
    "codex":   HOME / ".codex"  / "skills",
    "agents":  HOME / ".agents" / "skills",
}
ULTRON_HOME  = HOME / ".ultron"
MANIFEST     = ULTRON_HOME / "skills-registry.json"
PENDING_DIR  = ULTRON_HOME / "pending-sync"
INDEX_FILE   = ULTRON_HOME / "INDEX.md"
# Dirs to ignore when scanning a registry
_META_DIRS = {".git", ".system", ".claude", "__pycache__"}
_META_FILES = {"README-sync.md", "sync.sh", ".gitignore"}

# Skills that use Claude-specific APIs — never propagate to codex/agents
CLAUDE_EXCLUSIVE = {
    "second-opinion",          # Shells out to Codex CLI — Claude-initiated only
    "skill-improver",          # Uses Claude skill-reviewer agent loop
    "code-review-excellence",  # Has allowed-tools restrictions only applicable in Claude Code
    "claude-skills",           # References Claude-internal skill library — no equivalent elsewhere
    "everything-claude-code",  # Claude Code-specific memory/OWASP harness — not applicable outside CC
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def _scan(registry: str) -> set[str]:
    """Return skill names present in a registry directory."""
    base = REGISTRIES.get(registry)
    if not base or not base.exists():
        return set()
    return {
        p.name for p in base.iterdir()
        if p.is_dir() and p.name not in _META_DIRS
        and p.name not in _META_FILES
        and not p.name.startswith(".")
    }


def _load_manifest() -> dict:
    if MANIFEST.exists():
        try:
            return json.loads(MANIFEST.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    return {
        "version": "1",
        "updated": "",
        "claude_exclusive": sorted(CLAUDE_EXCLUSIVE),
        "skills": {},
    }


def _save_manifest(data: dict) -> None:
    ULTRON_HOME.mkdir(parents=True, exist_ok=True)
    data["updated"] = datetime.now().isoformat(timespec="seconds")
    MANIFEST.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _log_activity(event: str, skill: str) -> None:
    try:
        activity_file = (ULTRON_HOME / "sessions"
                         / datetime.now().strftime("%Y-%m-%d") / "activity.jsonl")
        activity_file.parent.mkdir(parents=True, exist_ok=True)
        entry = json.dumps({
            "ts": datetime.now().isoformat(timespec="seconds"),
            "source": "registry_sync",
            "event": event,
            "skill": skill,
        }, ensure_ascii=False)
        with activity_file.open("a", encoding="utf-8") as f:
            f.write(entry + "\n")
    except OSError:
        pass


def _update_index(skill: str, description: str) -> None:
    """Append skill to INDEX.md Big Brain under ## Skills section."""
    if not INDEX_FILE.exists():
        return
    try:
        content = INDEX_FILE.read_text(encoding="utf-8")
        line = f"- [{skill}](~/.claude/skills/{skill}/SKILL.md) — {description}"
        if skill in content:
            return  # already indexed
        # Find ## Skills section and append after it
        marker = "## Skills"
        if marker in content:
            idx = content.index(marker)
            # Find the end of the section or next ##
            rest = content[idx + len(marker):]
            next_sec = rest.find("\n## ")
            insert_at = idx + len(marker) + (next_sec if next_sec != -1 else len(rest))
            content = content[:insert_at].rstrip() + f"\n{line}\n" + content[insert_at:]
        else:
            content = content.rstrip() + f"\n\n## Skills\n{line}\n"
        INDEX_FILE.write_text(content, encoding="utf-8")
    except OSError:
        pass


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_status(_args) -> int:
    data = _load_manifest()
    exclusive = set(data.get("claude_exclusive", [])) | CLAUDE_EXCLUSIVE

    sets = {name: _scan(name) for name in REGISTRIES}
    all_skills = sets["claude"] | sets["codex"] | sets["agents"]
    universal = all_skills - exclusive

    print("ULTRON Skills Registry — Drift Report")
    print("=" * 50)
    for reg, skills in sets.items():
        print(f"  {reg:<10} {len(skills):>3} skills")
    print()

    missing: dict[str, list[str]] = {"codex": [], "agents": []}
    for sk in sorted(universal):
        for reg in ("codex", "agents"):
            if sk not in sets[reg]:
                missing[reg].append(sk)

    only_codex  = sets["codex"]  - sets["claude"]
    only_agents = sets["agents"] - sets["claude"]

    pending_files = list(PENDING_DIR.glob("*.json")) if PENDING_DIR.exists() else []

    if not any(v for v in missing.values()) and not only_codex and not only_agents:
        print("  All registries in sync.")
    else:
        for reg, sk_list in missing.items():
            if sk_list:
                print(f"  Missing from {reg} ({len(sk_list)}): {', '.join(sk_list)}")
        if only_codex:
            print(f"  Only in Codex (review before propagating): {', '.join(sorted(only_codex))}")
        if only_agents:
            print(f"  Only in Agents (review): {', '.join(sorted(only_agents))}")

    if pending_files:
        print(f"\n  Pending-sync queue: {len(pending_files)} item(s)")
        for pf in pending_files[:5]:
            try:
                d = json.loads(pf.read_text(encoding="utf-8"))
                print(f"    • {d.get('skill','?')} [{d.get('source','?')}] — {d.get('description','')[:60]}")
            except (OSError, json.JSONDecodeError):
                print(f"    • {pf.name} (unreadable)")

    if exclusive & all_skills:
        print(f"\n  Claude-exclusive (not propagated): {', '.join(sorted(exclusive & all_skills))}")

    print()
    return 0


def cmd_propagate(args) -> int:
    dry = getattr(args, "dry_run", False)
    data = _load_manifest()
    exclusive = set(data.get("claude_exclusive", [])) | CLAUDE_EXCLUSIVE

    sets = {name: _scan(name) for name in REGISTRIES}
    claude_skills = sets["claude"]

    propagated = 0
    skipped_exclusive = 0

    for sk in sorted(claude_skills):
        if sk in exclusive:
            skipped_exclusive += 1
            continue
        src = REGISTRIES["claude"] / sk
        for reg in ("codex", "agents"):
            dst = REGISTRIES[reg] / sk
            if dst.exists():
                continue
            if dry:
                print(f"  [dry] would copy {sk} → {reg}")
                continue
            if not REGISTRIES[reg].exists():
                print(f"  SKIP {reg}: registry dir not found", file=sys.stderr)
                continue
            try:
                shutil.copytree(src, dst)
                print(f"  ✓ {sk} → {reg}")
                propagated += 1
                _log_activity("propagate", sk)
                # update manifest
                entry = data["skills"].setdefault(sk, {"registries": ["claude"]})
                if reg not in entry.get("registries", []):
                    entry.setdefault("registries", ["claude"]).append(reg)
            except Exception as e:
                print(f"  ✗ {sk} → {reg}: {e}", file=sys.stderr)

    if not dry:
        _save_manifest(data)
        print(f"\nPropagated: {propagated}  Skipped (exclusive): {skipped_exclusive}")
    else:
        print(f"\n[dry-run] would propagate skills above. Exclusive skipped: {skipped_exclusive}")
    return 0


def cmd_register(args) -> int:
    skill = args.skill
    source = getattr(args, "source", "claude")
    desc = getattr(args, "desc", "") or ""
    universal = not getattr(args, "claude_only", False)

    PENDING_DIR.mkdir(parents=True, exist_ok=True)
    entry = {
        "skill": skill,
        "source": source,
        "ts": datetime.now().isoformat(timespec="seconds"),
        "description": desc[:200],
        "universal": universal,
    }
    out = PENDING_DIR / f"{skill}.json"
    out.write_text(json.dumps(entry, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  Registered pending: {out}")
    print(f"  Run `ultron skills registry process-pending` to propagate.")
    return 0


def cmd_process_pending(args) -> int:
    dry = getattr(args, "dry_run", False)
    if not PENDING_DIR.exists():
        print("  No pending-sync directory found. Nothing to process.")
        return 0

    files = list(PENDING_DIR.glob("*.json"))
    if not files:
        print("  Pending-sync queue is empty.")
        return 0

    data = _load_manifest()
    exclusive = set(data.get("claude_exclusive", [])) | CLAUDE_EXCLUSIVE
    processed = []

    for pf in files:
        try:
            entry = json.loads(pf.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            print(f"  ✗ {pf.name}: unreadable ({e})", file=sys.stderr)
            continue

        skill   = entry.get("skill", "")
        source  = entry.get("source", "claude")
        desc    = entry.get("description", "")
        is_univ = entry.get("universal", True)

        if not skill:
            print(f"  ✗ {pf.name}: missing 'skill' field — skipped")
            continue
        if skill in exclusive or not is_univ:
            print(f"  ~ {skill}: Claude-exclusive — added to manifest, not propagated")
            manifest_entry = data["skills"].setdefault(skill, {"registries": [source]})
            if "claude_only" not in manifest_entry:
                manifest_entry["claude_only"] = True
            processed.append(pf)
            continue

        src_dir = REGISTRIES.get(source, REGISTRIES["claude"]) / skill
        propagated_to = []

        for reg, reg_dir in REGISTRIES.items():
            if reg == source:
                continue
            dst = reg_dir / skill
            if dst.exists():
                continue
            if not src_dir.exists():
                print(f"  ✗ {skill}: source dir not found in {source}")
                break
            if dry:
                print(f"  [dry] would copy {skill} [{source}] → {reg}")
                continue
            if not reg_dir.exists():
                continue
            try:
                shutil.copytree(src_dir, dst)
                propagated_to.append(reg)
                _log_activity("process-pending", skill)
            except Exception as e:
                print(f"  ✗ {skill} → {reg}: {e}", file=sys.stderr)

        if propagated_to or dry:
            if not dry:
                print(f"  ✓ {skill} → {', '.join(propagated_to) or 'already everywhere'}")
            manifest_entry = data["skills"].setdefault(skill, {})
            regs = manifest_entry.get("registries", [source])
            for r in propagated_to:
                if r not in regs:
                    regs.append(r)
            manifest_entry["registries"] = regs
            manifest_entry["description"] = desc
            if not dry:
                _update_index(skill, desc)
                processed.append(pf)

    if not dry:
        _save_manifest(data)
        for pf in processed:
            pf.unlink(missing_ok=True)
        print(f"\nProcessed: {len(processed)}/{len(files)}")
    return 0


def cmd_update_manifest(_args) -> int:
    sets = {name: _scan(name) for name in REGISTRIES}
    all_skills = sets["claude"] | sets["codex"] | sets["agents"]

    data = _load_manifest()
    data["claude_exclusive"] = sorted(CLAUDE_EXCLUSIVE)

    for sk in sorted(all_skills):
        entry = data["skills"].setdefault(sk, {})
        regs = [r for r, s in sets.items() if sk in s]
        entry["registries"] = sorted(regs)

    _save_manifest(data)
    print(f"  Manifest updated: {len(all_skills)} skills, {MANIFEST}")
    return 0


def cmd_health(_args) -> int:
    """Registry health score: total/synced/unsynced/drift/score (0-100)."""
    from pathlib import Path as _Path
    skill_manifest_path = _Path.home() / ".ultron" / "skill_manifest.json"
    route_quality_path  = _Path.home() / ".ultron" / "skill_cache" / "route_quality.json"

    sets = {name: _scan(name) for name in REGISTRIES}
    all_skills = sets["claude"] | sets["codex"] | sets["agents"]
    total = len(all_skills)

    # Synced = present in claude AND at least one other registry (or claude-exclusive)
    synced = sum(
        1 for sk in all_skills
        if (sk in sets["claude"] and (sk in sets["codex"] or sk in sets["agents"]))
           or sk in CLAUDE_EXCLUSIVE
    )
    unsynced = total - synced

    # Drift = skills in manifest but not on disk (ghost)
    drift = 0
    if skill_manifest_path.exists():
        try:
            sm = json.loads(skill_manifest_path.read_text(encoding="utf-8"))
            drift = sum(1 for e in sm.get("skills", {}).values() if e.get("status") == "ghost")
        except (json.JSONDecodeError, OSError):
            pass

    # Route quality: % edges with ≥1 run
    routes_tracked = 0
    routes_with_data = 0
    if route_quality_path.exists():
        try:
            rq = json.loads(route_quality_path.read_text(encoding="utf-8-sig"))
            edges = rq.get("edges", {})
            routes_tracked = len(edges)
            routes_with_data = sum(1 for e in edges.values() if e.get("runs", 0) > 0)
        except (json.JSONDecodeError, OSError):
            pass

    # Score formula (0-100):
    #   sync_ratio       * 50  (synced/total, max 50 pts)
    #   ghost_penalty    * 20  (0 ghosts = 20 pts, proportional deduction)
    #   route_coverage   * 30  (routes with data / total, max 30 pts)
    sync_ratio = (synced / total) if total else 1.0
    ghost_ratio = (drift / total) if total else 0.0
    route_coverage = (routes_with_data / routes_tracked) if routes_tracked else 0.0

    score = round(
        sync_ratio * 50
        + (1.0 - ghost_ratio) * 20
        + route_coverage * 30
    )

    # Cleanup inventory checks (Task 13)
    cleanup_report_dir = Path.home() / ".ultron" / "cockpit" / "audits"
    cleanup_reports   = sorted(cleanup_report_dir.glob("cleanup-report-*.md")) if cleanup_report_dir.exists() else []
    last_cleanup      = cleanup_reports[-1].stem.replace("cleanup-report-", "") if cleanup_reports else "never"
    stale_backups = 0
    archive_dir = Path.home() / ".ultron" / "archive"
    if archive_dir.exists():
        stale_backups = sum(1 for d in archive_dir.iterdir() if d.is_dir())

    status_icon = "✓" if score >= 80 else ("~" if score >= 60 else "✗")
    print(f"\nRegistry Health  [{status_icon}]  score={score}/100")
    print("=" * 50)
    print(f"  Total skills:      {total}")
    print(f"  Synced:            {synced}  ({sync_ratio*100:.0f}%)")
    print(f"  Unsynced:          {unsynced}")
    print(f"  Ghost (drift):     {drift}")
    print(f"  Route edges:       {routes_tracked}  (with data: {routes_with_data})")
    print(f"  Score breakdown:   sync={sync_ratio*50:.1f}  ghost={(1-ghost_ratio)*20:.1f}  routes={route_coverage*30:.1f}")
    print(f"  Last cleanup scan: {last_cleanup}")
    print(f"  Archive dirs:      {stale_backups}")
    print()
    return 0


def cmd_validate_routes(_args) -> int:
    """Validate route_quality.json for schema integrity and data anomalies.

    Checks:
    - Required edge fields present and correctly typed
    - successes <= runs (data integrity)
    - Self-loops (from == to)
    - Degraded routes: runs >= 5 and success_rate < 0.40
    Returns 0 if clean, 1 if violations found.
    """
    from pathlib import Path as _Path
    route_quality_path = _Path.home() / ".ultron" / "skill_cache" / "route_quality.json"

    if not route_quality_path.exists():
        print("[validate-routes] route_quality.json not found — nothing to validate")
        return 0

    try:
        rq = json.loads(route_quality_path.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"[validate-routes] FAIL — cannot load route_quality.json: {e}")
        return 1

    edges = rq.get("edges", {})
    _REQUIRED_FIELDS = {"from", "to", "runs", "successes", "last_outcome"}
    violations: list[str] = []
    warnings:   list[str] = []

    for key, edge in edges.items():
        missing = _REQUIRED_FIELDS - set(edge.keys())
        if missing:
            violations.append(f"  MISSING FIELDS  {key!r}: {sorted(missing)}")
            continue

        runs      = edge.get("runs", 0)
        successes = edge.get("successes", 0)
        from_s    = edge.get("from", "")
        to_s      = edge.get("to", "")

        if not isinstance(runs, int) or runs < 0:
            violations.append(f"  BAD runs        {key!r}: runs={runs!r}")
        if not isinstance(successes, int) or successes < 0:
            violations.append(f"  BAD successes   {key!r}: successes={successes!r}")
        if isinstance(runs, int) and isinstance(successes, int) and successes > runs:
            violations.append(f"  DATA INTEGRITY  {key!r}: successes({successes}) > runs({runs})")
        if from_s == to_s and from_s:
            violations.append(f"  SELF-LOOP       {key!r}")
        if isinstance(runs, int) and runs >= 5 and isinstance(successes, int):
            rate = successes / runs
            if rate < 0.40:
                warnings.append(f"  DEGRADED ROUTE  {key!r}: {successes}/{runs} ({rate*100:.0f}% success)")

    if violations:
        print(f"\n[validate-routes] {len(violations)} violation(s) found:")
        for v in violations:
            print(v)
    if warnings:
        print(f"\n[validate-routes] {len(warnings)} warning(s):")
        for w in warnings:
            print(w)
    if not violations and not warnings:
        print(f"[validate-routes] OK — {len(edges)} edges checked, no violations")

    return 1 if violations else 0


def _cmd_include_agents(args) -> int:
    """Task 9: Rebuild agent manifest and report agents present/absent."""
    import subprocess as _sp
    agent_script = Path(__file__).parent / "agent_manifest.py"
    if not agent_script.exists():
        print("[registry_sync] agent_manifest.py not found in cockpit dir")
        return 1
    dry_run = getattr(args, "dry_run", False)
    if dry_run:
        print("[registry_sync --include-agents] dry-run — would call: agent_manifest.py rebuild + status")
        return 0
    try:
        r1 = _sp.run([sys.executable, str(agent_script), "rebuild"],
                     capture_output=True, text=True, timeout=30)
        if r1.returncode == 0:
            print(r1.stdout.strip())
        else:
            print(f"[WARNING] rebuild exited {r1.returncode}: {r1.stderr.strip()[:200]}")
        r2 = _sp.run([sys.executable, str(agent_script), "status"],
                     capture_output=True, text=True, timeout=30)
        print(r2.stdout.strip())
        return 0
    except (OSError, _sp.TimeoutExpired) as e:
        print(f"[registry_sync] include-agents failed: {e}")
        return 1


def _cmd_auto_discover(_args) -> int:
    """S4: Scan ~/.claude/skills/*/SKILL.md for KTP frontmatter.
    Appends new entries to ~/.ultron/skills.manifest.yaml (source: auto-discover).
    Skills in manifest without a SKILL.md on disk are auto-deprecated.
    Writes telemetry to ~/.ultron/telemetry/sync-events.jsonl.
    """
    import json as _json
    from datetime import datetime as _dt

    _MANIFEST_YAML = HOME / ".ultron" / "skills.manifest.yaml"
    _TELEMETRY = HOME / ".ultron" / "telemetry" / "sync-events.jsonl"
    _SKILLS_DIR = REGISTRIES["claude"]

    # ── YAML load/save helpers (PyYAML required) ──────────────────────────────
    try:
        import yaml as _yaml
    except ImportError:
        print("[auto-discover] ERROR: PyYAML not installed — run: uv pip install pyyaml",
              file=sys.stderr)
        return 1

    def _load_manifest_yaml():
        if not _MANIFEST_YAML.exists():
            return []
        try:
            data = _yaml.safe_load(_MANIFEST_YAML.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except Exception:
            return []

    def _save_manifest_yaml(entries):
        _MANIFEST_YAML.parent.mkdir(parents=True, exist_ok=True)
        tmp = _MANIFEST_YAML.with_suffix(".yaml.tmp")
        tmp.write_text(
            _yaml.dump(entries, allow_unicode=True, sort_keys=False,
                       default_flow_style=False),
            encoding="utf-8",
        )
        if _MANIFEST_YAML.exists():
            _MANIFEST_YAML.unlink()
        tmp.rename(_MANIFEST_YAML)

    def _parse_fm(text: str):
        if not text.startswith("---"):
            return None
        end = text.find("---", 3)
        if end == -1:
            return None
        try:
            fm = _yaml.safe_load(text[3:end])
            return fm if isinstance(fm, dict) else None
        except Exception:
            return None

    def _synth_triggers(skill_id: str, fm: dict) -> list:
        import re as _re
        parts = _re.split(r"[:\-_]", skill_id.lower())
        result = [p for p in parts if len(p) > 2 and p not in ("pro", "dev", "the", "and")]
        if fm.get("category") and fm["category"] not in result:
            result.append(fm["category"].lower())
        seen: set = set()
        deduped = []
        for t in result:
            if t not in seen:
                seen.add(t)
                deduped.append(t)
        return deduped or [skill_id.lower()]

    def _infer_cost(fm: dict) -> str:
        return {"persona": "medium", "meta": "high", "hookify": "low",
                "mcp": "medium", "skill": "medium"}.get(
            fm.get("kind", "").lower(), "medium")

    def _extract_desc(fm: dict, skill_id: str) -> str:
        if fm.get("description"):
            d = str(fm["description"]).strip()
            return d[:117] + "..." if len(d) > 120 else d
        return f"{skill_id} skill"

    # ── S5-C: pre-flight security scanner + provenance recorder ──────────────
    # Lazy imports — scanner is optional; if it fails we keep going but log.
    _security_scanner = None
    _provenance = None
    _security_decisions: dict = {}
    _security_blocked: set = set()
    _security_quarantined: set = set()
    try:
        import skill_sync_security as _security_scanner  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        _security_scanner = None
    try:
        import skill_provenance as _provenance  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        _provenance = None

    # ── Load existing manifest ─────────────────────────────────────────────────
    entries = _load_manifest_yaml()
    existing_names: set = {e.get("name") for e in entries if e.get("name")}
    today = __import__("datetime").date.today().isoformat()

    added = 0
    skipped = 0
    disk_ids: set = set()

    # ── Scan SKILL.md files ────────────────────────────────────────────────────
    if _SKILLS_DIR.exists():
        for skill_dir in sorted(_SKILLS_DIR.iterdir()):
            if not skill_dir.is_dir() or skill_dir.name.startswith("."):
                continue
            skill_md = skill_dir / "SKILL.md"
            if not skill_md.exists():
                continue
            disk_ids.add(skill_dir.name)
            try:
                text = skill_md.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            fm = _parse_fm(text)
            if fm is None:
                continue
            skill_id = skill_dir.name

            # S5-C: scan BEFORE adding to the manifest. If decision is "block"
            # we refuse. If "quarantine" we move skill aside. If "warn" we
            # proceed but raise an alert. If "allow" we proceed normally.
            scan_decision = "allow"
            if _security_scanner is not None:
                try:
                    # F01 fix: pass source=None so the scanner consults
                    # provenance/local-root trust rather than honoring a
                    # frontmatter-declared `source` (which a malicious skill
                    # could spoof).
                    verdict = _security_scanner.scan_skill(
                        skill_dir, source=None,
                    )
                    scan_decision = verdict.decision
                    _security_decisions[skill_id] = scan_decision
                    if scan_decision == "block":
                        _security_blocked.add(skill_id)
                        try:
                            import alerts as _alerts_mod  # type: ignore[import-not-found]
                            _alerts_mod.write_dedupe(
                                "blocking", "registry_sync",
                                f"BLOCKED skill registration: {skill_id} "
                                f"(security scan)",
                                dedupe_tag=f"sec_block:{skill_id}",
                                window_seconds=3600,
                                tags=["security", "registry_sync"],
                            )
                        except Exception:  # noqa: BLE001
                            pass
                        # Skip writing this skill into the manifest.
                        continue
                    if scan_decision == "quarantine":
                        # S5-C: only ALERT during sync. Actual quarantine
                        # (filesystem move) requires explicit
                        # `ultron security scan <path>` + manual approval.
                        # Auto-quarantining during a routine sync is too
                        # destructive — a single false positive would delete
                        # a legitimate skill mid-flow.
                        _security_quarantined.add(skill_id)
                        # F05 + F-MaxDual-R2-Hnew1 fix: mutate the in-memory
                        # `entries` list directly so the quarantine status
                        # survives the final `_save_manifest_yaml(entries)`
                        # at the end of auto-discover. Calling
                        # `set_security_status` alone on disk would race —
                        # the later in-memory save would clobber the
                        # written status. New skills (not yet in entries)
                        # are not added at all — `continue` below skips
                        # them, alert is the only signal.
                        first_rule = (verdict.findings[0].rule_id
                                       if verdict.findings else "unknown")
                        for _e in entries:
                            if _e.get("name") == skill_id:
                                _e["deprecated"] = True
                                _e["security_status"] = "quarantine_pending"
                                _e["security_status_reason"] = (
                                    f"security_quarantine_pending:{first_rule}")
                                break
                        try:
                            import alerts as _alerts_mod
                            _alerts_mod.write_dedupe(
                                "warn", "registry_sync",
                                f"QUARANTINE-recommended skill: {skill_id} "
                                f"(manual review required)",
                                dedupe_tag=f"sec_quar_pending:{skill_id}",
                                window_seconds=3600,
                                tags=["security", "registry_sync",
                                      "quarantine_pending"],
                            )
                        except Exception:  # noqa: BLE001
                            pass
                        continue
                    if scan_decision == "warn":
                        try:
                            import alerts as _alerts_mod
                            _alerts_mod.write_dedupe(
                                "warn", "registry_sync",
                                f"Security WARN on skill: {skill_id}",
                                dedupe_tag=f"sec_warn:{skill_id}",
                                window_seconds=3600,
                                tags=["security", "registry_sync"],
                            )
                        except Exception:  # noqa: BLE001
                            pass
                except Exception:  # noqa: BLE001 — never break sync for scan errors
                    pass

            if skill_id in existing_names:
                skipped += 1
                continue
            entry = {
                "name": skill_id,
                "source": "auto-discover",
                "triggers": _synth_triggers(skill_id, fm),
                "tags": [str(fm[f]).lower() for f in ("category", "kind", "tier") if fm.get(f)],
                "cost_tier": _infer_cost(fm),
                "dispatcher_priority": 3,
                "deprecated": False,
                "replaces": [],
                "last_used": None,
                "last_synced": today,
                "description": _extract_desc(fm, skill_id),
            }
            for ktp in ("kind", "category", "tier"):
                if fm.get(ktp):
                    entry[ktp] = fm[ktp]
            entries.append(entry)
            existing_names.add(skill_id)
            added += 1

            # S5-C: record provenance for the new skill so future drift checks
            # have a baseline sha1.
            #
            # F-MaxDual-R2-Cnew2: NEVER record the SKILL.md frontmatter
            # `source` value as `source_url`. That field is the trust
            # anchor used by the security scanner; if we let the skill
            # populate it, the next scan trusts the attacker. FM source
            # is recorded only as `declared_source` (informational, never
            # consulted for trust). `source_url` stays None until a
            # trusted installer (out-of-band fetch) populates it.
            if _provenance is not None:
                try:
                    fm_src = fm.get("source") if isinstance(fm, dict) else None
                    declared = fm_src if isinstance(fm_src, str) else None
                    src_kind = _provenance._infer_source_kind(declared)
                    _provenance.record_install(
                        skill_id, source_kind=src_kind,
                        source_url=None,
                        declared_source=declared,
                        skill_path=skill_dir,
                        scan_decision=scan_decision,
                    )
                except Exception:  # noqa: BLE001
                    pass

    # ── Auto-deprecate stale auto-discover entries ────────────────────────────
    deprecated = 0
    for entry in entries:
        name = entry.get("name", "")
        if (entry.get("source") == "auto-discover"
                and name not in disk_ids
                and not entry.get("deprecated", False)):
            entry["deprecated"] = True
            deprecated += 1

    _save_manifest_yaml(entries)

    # ── Telemetry ─────────────────────────────────────────────────────────────
    try:
        _TELEMETRY.parent.mkdir(parents=True, exist_ok=True)
        ev = _json.dumps({
            "ts": _dt.now().isoformat(timespec="seconds"),
            "source": "registry_sync.auto-discover",
            "event": "auto-discover",
            "added": added,
            "skipped_existing": skipped,
            "auto_deprecated": deprecated,
            "total": len(entries),
        }, ensure_ascii=False)
        with _TELEMETRY.open("a", encoding="utf-8") as f:
            f.write(ev + "\n")
    except OSError:
        pass

    # ── Report ────────────────────────────────────────────────────────────────
    print(f"[auto-discover] Scan complete")
    print(f"  SKILL.md on disk:   {len(disk_ids)}")
    print(f"  New entries added:  {added}")
    print(f"  Already in manifest:{skipped}")
    print(f"  Auto-deprecated:    {deprecated}")
    print(f"  Total in manifest:  {len(entries)}")
    if _security_blocked or _security_quarantined:
        print(f"  Security blocked:    {len(_security_blocked)}"
              f" {sorted(_security_blocked)[:5]}")
        print(f"  Security quarantined:{len(_security_quarantined)}"
              f" {sorted(_security_quarantined)[:5]}")
    print(f"  YAML:               {_MANIFEST_YAML}")
    return 0


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> int:
    # Short aliases — expand before argparse sees them
    _ALIASES = {
        "s":  "status",
        "p":  "propagate",
        "r":  "register",
        "pp": "process-pending",
        "u":  "update-manifest",
        "h":  "health",
        "ad": "auto-discover",
    }
    if len(sys.argv) > 1 and sys.argv[1] in _ALIASES:
        sys.argv[1] = _ALIASES[sys.argv[1]]

    p = argparse.ArgumentParser(
        description="ULTRON Skills Registry Sync",
        epilog="Aliases: s=status  p=propagate  r=register  pp=process-pending  u=update-manifest",
    )
    sub = p.add_subparsers(dest="cmd")

    sub.add_parser("status",           help="Show drift across registries  [alias: s]")

    prop = sub.add_parser("propagate",   help="Copy missing universal skills  [alias: p]")
    prop.add_argument("--dry-run", action="store_true")

    reg = sub.add_parser("register",     help="Queue a skill for sync  [alias: r]")
    reg.add_argument("skill")
    reg.add_argument("--source", default="claude", choices=["claude", "codex", "agents"])
    reg.add_argument("--desc", default="")
    reg.add_argument("--claude-only", action="store_true")

    proc = sub.add_parser("process-pending", help="Propagate queued skills  [alias: pp]")
    proc.add_argument("--dry-run", action="store_true")

    sub.add_parser("update-manifest",  help="Rebuild manifest from disk  [alias: u]")
    sub.add_parser("health",           help="Registry health score  [alias: h]")
    sub.add_parser("validate-routes",  help="Validate route_quality.json for anomalies")

    agents_p = sub.add_parser("include-agents",
                               help="Rebuild agent manifest and report agents present/absent")
    agents_p.add_argument("--dry-run", action="store_true")

    sub.add_parser("auto-discover",
                   help="Scan ~/.claude/skills/*/SKILL.md for KTP frontmatter, "
                        "append to skills.manifest.yaml  [alias: ad]")

    args = p.parse_args()

    if args.cmd == "include-agents":
        return _cmd_include_agents(args)

    if args.cmd == "auto-discover":
        return _cmd_auto_discover(args)

    dispatch = {
        "status":          cmd_status,
        "propagate":       cmd_propagate,
        "register":        cmd_register,
        "process-pending": cmd_process_pending,
        "update-manifest": cmd_update_manifest,
        "health":          cmd_health,
        "validate-routes": cmd_validate_routes,
    }
    fn = dispatch.get(args.cmd)
    if not fn:
        p.print_help()
        return 1
    return fn(args)


if __name__ == "__main__":
    sys.exit(main())
