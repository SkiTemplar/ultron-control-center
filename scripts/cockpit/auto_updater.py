#!/usr/bin/env python3
"""
ULTRON v10.4 - AutoUpdater L1 prototype (detect + audit only, NO apply).

Stage 1 only per Codex's L1/L2/L3 split:
  - L1: detect candidates + run audits (THIS FILE)
  - L2: generate patches (future v10.5)
  - L3: apply + version + changelog (future v10.5+)

This is the safest layer. Nothing modifies files. Just discovers what NEEDS
audit and triggers Kirkardo via persona_audit.py.

Anti-laundering rules baked in:
  - All audits are kirkardo-independent (enforced by persona_audit.py)
  - Doble-audit pattern recommended for critical skills (different runs find
    different issues - validated this session: 7.5/10 vs 7.0/10)
  - False-positive filter: knowledge-cutoff issues flagged for human review
    (e.g. Sonnet penalizing TaskCreate/TaskUpdate which exist post-cutoff)

Usage:
    auto_updater.py scan                   List audit candidates ranked by need
    auto_updater.py audit <skill> [--quick] Run Kirkardo on target
    auto_updater.py history                Show audit history (last 30 days)
    auto_updater.py news-flags             Items in NEWS that suggest skill update
    auto_updater.py propose <audit-file>   L2: generate patches from audit (Sonnet, NO apply)
    auto_updater.py proposals              List pending proposals
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import COCKPIT_DIR, NEWS_DIR, NEWS_ALERTS  # noqa: E402

NEWS_CATEGORIES_FILE = COCKPIT_DIR / "news_categories.json"

SKILLS_DIR = Path.home() / ".claude" / "skills"
AUDITS_DIR = COCKPIT_DIR / "audits"
PROPOSALS_DIR = COCKPIT_DIR / "proposals"   # L2 outputs (NOT auto-applied)
AUTO_UPDATER_LOG = COCKPIT_DIR / "auto_updater.jsonl"
PROPOSE_MODEL = os.environ.get("ULTRON_PROPOSE_MODEL", "claude-sonnet-4-6")
PROPOSE_TIMEOUT = 300
# v10.5: send SKILL.md whole up to 30KB (Sonnet handles 200K tokens; the
# previous 12KB cap forced L2 to emit empty old_string proposals when audits
# referenced lines beyond char 12000). Only trim if the file truly exceeds
# this threshold AND we have to keep the audit body in context too.
SKILL_MD_TRIM_CHARS = 30000

# Patterns in news titles that suggest a specific skill needs review
NEWS_SKILL_TRIGGERS = {
    "ultron":        [r"\bClaude\s*Code\b", r"\bskill\s*update", r"\bMCP\b.*server"],
    "terry-davis":   [r"\bgit\b.*new", r"\brebase\s*update", r"\bworkflow\s*change"],
    "don-claudio":   [r"\bUE5", r"\bUnity\s*\d", r"\bnetcode"],
    "novalbos":      [r"\bC\+\+\s*2[3-9]", r"\bVulkan", r"\bCUDA"],
    "warren":        [r"\bSEC\s*rule", r"\bregulation\b.*market"],
    "tio-gilito":    [r"\bbank\s*API\b", r"\bSpain.*finance"],
}


def list_personas() -> list[Path]:
    if not SKILLS_DIR.exists():
        return []
    return sorted(p for p in SKILLS_DIR.iterdir()
                  if p.is_dir() and (p / "SKILL.md").exists())


def find_recent_audits(days: int = 30) -> dict[str, datetime]:
    """Returns map of {persona_name: most_recent_audit_datetime}."""
    if not AUDITS_DIR.exists():
        return {}
    cutoff = datetime.now() - timedelta(days=days)
    out: dict[str, datetime] = {}
    for f in AUDITS_DIR.glob("*.md"):
        m = re.match(r"^(.+)-(\d{4}-\d{2}-\d{2})\.md$", f.name)
        if not m:
            continue
        try:
            d = datetime.strptime(m.group(2), "%Y-%m-%d")
            if d < cutoff:
                continue
            persona = m.group(1)
            if persona not in out or d > out[persona]:
                out[persona] = d
        except ValueError:
            continue
    return out


def cmd_scan(_args) -> int:
    """List audit candidates ranked by:
      1. Skills NEVER audited (highest priority)
      2. Skills audited >30d ago
      3. Skills with size > 15KB (more surface for issues)"""
    personas = list_personas()
    recent = find_recent_audits(days=30)
    today = datetime.now()

    rows = []
    for p in personas:
        skill_md = p / "SKILL.md"
        size_kb = skill_md.stat().st_size / 1024
        last_audit = recent.get(p.name)
        days_since = (today - last_audit).days if last_audit else None
        # Priority score: never audited = 100, else days_since (capped at 90)
        priority = 100 if last_audit is None else min(days_since, 90)
        # Boost large files
        if size_kb > 15:
            priority += 10
        rows.append({
            "persona": p.name,
            "size_kb": round(size_kb, 1),
            "last_audit": last_audit.strftime("%Y-%m-%d") if last_audit else "never",
            "days_since": days_since if days_since is not None else 999,
            "priority": priority,
        })
    rows.sort(key=lambda r: -r["priority"])

    print(f"AUDIT CANDIDATES ({len(rows)} total)")
    print("=" * 70)
    print(f"{'Persona':<25} {'Size':>8} {'Last audit':<14} {'Days':>6} {'Pri':>5}")
    print("-" * 70)
    for r in rows[:25]:
        days_str = "—" if r["days_since"] == 999 else str(r["days_since"])
        print(f"{r['persona']:<25} {r['size_kb']:>6}KB {r['last_audit']:<14} "
              f"{days_str:>6} {r['priority']:>5}")
    print()
    print("Top 3 next:", [r["persona"] for r in rows[:3]])
    print(f"Run audit: ultron audit run <persona> --quick")
    return 0


def cmd_audit(args) -> int:
    """Delegate to persona_audit.py with structured logging."""
    target = args.skill
    quick = getattr(args, "quick", False)

    cmd = [sys.executable, str(Path(__file__).parent / "persona_audit.py"),
           "run", target]
    if quick:
        cmd.append("--quick")

    print(f"[autoupdater] Triggering audit: {target} {'(QUICK)' if quick else '(FULL)'}")
    result = subprocess.run(cmd, encoding="utf-8")

    # Extract nota from the generated audit file for the log entry
    nota = "?"
    today = datetime.now().strftime("%Y-%m-%d")
    audit_file = AUDITS_DIR / f"{target}-{today}.md"
    if not audit_file.exists():
        candidates = sorted(AUDITS_DIR.glob(f"{target}-*.md"),
                            key=lambda p: p.stat().st_mtime, reverse=True)
        if candidates:
            audit_file = candidates[0]
    if audit_file.exists():
        try:
            head = audit_file.read_text(encoding="utf-8")[:500]
            m = re.search(r"nota:\s*([\d.]+)/10", head)
            if m:
                nota = m.group(1)
        except OSError:
            pass

    log_entry = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "action": "audit",
        "target": target,
        "model": "sonnet" if quick else "opus",
        "exit_code": result.returncode,
        "nota": nota,
    }
    AUTO_UPDATER_LOG.parent.mkdir(parents=True, exist_ok=True)
    with AUTO_UPDATER_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(log_entry) + "\n")
    return result.returncode


def cmd_history(_args) -> int:
    if not AUTO_UPDATER_LOG.exists() and not AUDITS_DIR.exists():
        print("[autoupdater] No history yet")
        return 0
    print("RECENT AUDIT HISTORY")
    print("=" * 70)
    # v13.1 (Sprint 4 final): read from INDEX.json (built by audit_index.py).
    # That file already has nota + veredicto extracted via the canonical
    # `nota_global` || `nota` parser. Falling back to per-file parse only if
    # INDEX.json missing.
    index_path = AUDITS_DIR / "INDEX.json"
    audit_meta: dict[str, dict] = {}
    if index_path.exists():
        try:
            idx = json.loads(index_path.read_text(encoding="utf-8"))
            for entry in idx.get("audits", []):
                audit_meta[entry["file"]] = entry
        except (json.JSONDecodeError, OSError):
            pass

    if AUDITS_DIR.exists():
        audits = sorted(AUDITS_DIR.glob("*.md"), key=lambda p: p.stat().st_mtime,
                         reverse=True)
        for a in audits[:20]:
            mtime = datetime.fromtimestamp(a.stat().st_mtime)
            meta = audit_meta.get(a.name, {})
            # Prefer INDEX.json — has both nota and veredicto
            nota = meta.get("nota") or "?"
            # Strip `/10` suffix if INDEX kept it
            if isinstance(nota, str) and nota.endswith("/10"):
                nota = nota.rsplit("/", 1)[0]
            verdict = meta.get("veredicto") or "?"
            # Truncate veredicto for column alignment
            v_short = verdict[:22] if isinstance(verdict, str) else "?"
            print(f"  {mtime.strftime('%Y-%m-%d %H:%M')}  {a.stem:<35} "
                  f"nota={nota:>4}/10  {v_short}")
    if AUTO_UPDATER_LOG.exists():
        print()
        print("Trigger log (last 10):")
        lines = AUTO_UPDATER_LOG.read_text(encoding="utf-8").splitlines()[-10:]
        for line in lines:
            try:
                e = json.loads(line)
                nota_str = f" nota={e['nota']}/10" if e.get('nota') and e['nota'] != '?' else ""
                print(f"  {e['ts']}  {e['action']:<8} {e.get('target','?'):<25} "
                      f"model={e.get('model','?')} exit={e.get('exit_code','?')}{nota_str}")
            except json.JSONDecodeError:
                continue
    return 0


def cmd_news_flags(_args) -> int:
    """v12: prefer dedicated audit-flags-{date}.md files written by news-publisher
    skill. Falls back to regex scan of legacy news/*.md if no dedicated file
    exists (back-compat with v11.x scraper output).
    """
    if not NEWS_DIR.exists():
        print("[autoupdater] No news directory")
        return 0
    cutoff = datetime.now() - timedelta(days=14)
    flags: dict[str, list[str]] = {}

    # v12: dedicated audit-flags files (preferred source)
    dedicated_used = False
    for md in NEWS_DIR.glob("audit-flags-*.md"):
        try:
            date_str = md.stem.replace("audit-flags-", "")
            d = datetime.fromisoformat(date_str)
            if d < cutoff:
                continue
        except ValueError:
            continue
        try:
            text = md.read_text(encoding="utf-8")
        except OSError:
            continue
        # Parse "## `<skill>`\n- topic1\n- topic2..." blocks
        for skill_match in re.finditer(
            r"##\s*`([^`]+)`\s*\n((?:-\s+.+\n?)+)", text
        ):
            skill = skill_match.group(1).strip()
            topics = [
                ln[2:].strip() for ln in skill_match.group(2).splitlines()
                if ln.startswith("- ")
            ]
            if topics:
                flags.setdefault(skill, []).extend(topics)
                dedicated_used = True

    # Legacy fallback: regex scan of digest .md
    if not dedicated_used:
        for md in NEWS_DIR.glob("20*.md"):
            if md.name.startswith("newsletter-"):
                continue
            try:
                date_str = md.stem
                d = datetime.fromisoformat(date_str)
                if d < cutoff:
                    continue
            except ValueError:
                continue
            try:
                text = md.read_text(encoding="utf-8")
            except OSError:
                continue
            for skill_name, patterns in NEWS_SKILL_TRIGGERS.items():
                for pat in patterns:
                    for m in re.finditer(pat, text, re.IGNORECASE):
                        line_start = text.rfind("\n", 0, m.start()) + 1
                        line_end = text.find("\n", m.end())
                        line = text[line_start:line_end if line_end > 0 else len(text)]
                        flags.setdefault(skill_name, []).append(line.strip()[:120])

    if not flags:
        print("[autoupdater] No skill-update flags in last 14 days")
        return 0
    print("NEWS-DRIVEN AUDIT FLAGS (last 14 days)")
    src = "audit-flags-*.md (dedicated)" if dedicated_used else "legacy regex scan"
    print(f"Source: {src}")
    print("=" * 70)
    for skill, hits in sorted(flags.items()):
        print(f"\n[{skill}] ({len(hits)} hits)")
        for h in hits[:3]:
            print(f"  - {h}")
    print()
    print("Suggested action: ultron self-improve audit <skill> --quick")
    return 0


# @ULTRON-DEPRECATED:14.0.0
#   reason: not surfaced in TUI since v12.4 (Kirkardo clipboard prompts replaced this pipeline)
#   replaced-by: cockpit/tui/prompts/* clipboard prompts launched from the Skills tab
#   remove-after: 2026-11-07
#   owner: USER
def cmd_propose(args) -> int:
    """L2 AutoUpdater: read audit findings + source SKILL.md, generate patches.
    Output: proposals/<audit-stem>.json with list of suggested edits (NOT applied).

    Anti-laundering safeguards:
    - false-positive filter prompt: Sonnet must mark suspect findings
      (e.g. knowledge-cutoff issues like TaskCreate)
    - never modifies files - dry-run by definition (Stage 2)
    - all proposals reviewed by USER before any apply
    """
    audit_path = Path(args.audit_file).resolve()
    if not audit_path.exists():
        print(f"[autoupdater] Audit not found: {audit_path}")
        return 1
    audit_text = audit_path.read_text(encoding="utf-8")

    # Locate source SKILL.md from audit filename: <skill>-<date>.md
    m = re.match(r"^(.+)-\d{4}-\d{2}-\d{2}$", audit_path.stem)
    if not m:
        print(f"[autoupdater] Cannot infer skill from audit name: {audit_path.stem}")
        return 1
    skill_name = m.group(1)
    skill_dir = SKILLS_DIR / skill_name
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        print(f"[autoupdater] SKILL.md not found: {skill_md}")
        return 1
    skill_text = skill_md.read_text(encoding="utf-8")

    claude_bin = shutil.which("claude")
    if not claude_bin:
        print("[autoupdater] claude CLI not found in PATH", file=sys.stderr)
        return 1

    # v10.4 fix: shorter, direct system prompt. Long detailed schema instructions
    # caused Sonnet to time out. Moved false-positive heuristics to plain Spanish
    # (avoids "anti-injection" mistrust trigger seen in early tests).
    system = (
        "Genera patches JSON desde un audit Kirkardo. "
        "Salida: {\"proposals\":[{\"finding_ref\":\"\",\"severity\":\"critical|high|medium|low\","
        "\"target_file\":\"SKILL.md\",\"old_string\":\"\",\"new_string\":\"\","
        "\"rationale\":\"\",\"false_positive_risk\":\"none|low|high\"}]}. "
        "REGLAS DURAS para old_string/new_string: "
        "(1) old_string DEBE ser una sub-cadena exacta y única del SKILL.md (caracteres "
        "literales, incluyendo saltos de línea); el L3 verifica unicidad antes de aplicar. "
        "(2) Si NO puedes encontrar la sub-cadena exacta en el SKILL.md proporcionado, "
        "OMITE esa proposal por completo — NO emitas entries con old_string vacío. "
        "(3) Marca false_positive_risk=high cuando el audit penaliza algo que parece "
        "outdated del auditor (ej: tools recientes de Claude Code como TaskCreate). "
        "En esos casos deja old_string y new_string vacíos. "
        "Solo JSON, sin markdown fences."
    )

    # v10.4 fix: trim large SKILL.md to first N chars to keep total prompt
    # under Sonnet's practical ceiling (audit alone gives plenty of context
    # since findings cite line references).
    skill_excerpt = skill_text
    skill_note = ""
    if len(skill_text) > SKILL_MD_TRIM_CHARS:
        skill_excerpt = skill_text[:SKILL_MD_TRIM_CHARS]
        skill_note = (f"\n[NOTE: SKILL.md trimmed to first {SKILL_MD_TRIM_CHARS} "
                      f"chars of {len(skill_text)}. The audit cites specific "
                      f"sections - reference them for accurate old_string.]\n")

    user = (f"=== KIRKARDO AUDIT ({audit_path.name}, {len(audit_text)}b) ===\n"
            f"{audit_text}\n\n"
            f"=== SOURCE SKILL.md ({skill_md}) ===\n{skill_excerpt}{skill_note}\n\n"
            f"Generate the proposals JSON now.")

    print(f"[autoupdater] L2 propose: {skill_name} via {PROPOSE_MODEL}...")
    print(f"[autoupdater] Audit: {audit_path.name}")
    print(f"[autoupdater] Source: {skill_md} ({len(skill_text)}b)")

    # Windows command-line limit ~32KB. Audit + SKILL.md combined often exceeds.
    # Pass user prompt via stdin to avoid CreateProcess WinError 206.
    cmd = [claude_bin, "--print", "--dangerously-skip-permissions",
           "--model", PROPOSE_MODEL,
           "--append-system-prompt", system]
    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".txt",
                                       delete=False, encoding="utf-8")
    tmp.write(user)
    tmp.close()
    try:
        with open(tmp.name, "r", encoding="utf-8") as fin:
            r = subprocess.run(cmd, stdin=fin, capture_output=True, text=True,
                                timeout=PROPOSE_TIMEOUT, encoding="utf-8")
        if r.returncode != 0:
            print(f"[autoupdater] claude failed exit={r.returncode}", file=sys.stderr)
            if r.stderr:
                print(f"[autoupdater] stderr: {r.stderr[:500]}", file=sys.stderr)
            return r.returncode
        response = (r.stdout or "").strip()
    except subprocess.TimeoutExpired:
        print(f"[autoupdater] timeout after {PROPOSE_TIMEOUT}s", file=sys.stderr)
        return 124
    finally:
        try:
            Path(tmp.name).unlink()
        except OSError:
            pass

    # Strip code fences if present
    cleaned = response
    if "```" in cleaned:
        # Extract content between first ``` and matching ```
        m = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", cleaned, re.DOTALL)
        if m:
            cleaned = m.group(1).strip()
    # Tolerate preamble before JSON: find first '{' and parse from there
    first_brace = cleaned.find("{")
    if first_brace > 0:
        cleaned = cleaned[first_brace:]
    # Tolerate trailing text after JSON: find matching closing brace
    if cleaned.startswith("{"):
        depth = 0
        for i, ch in enumerate(cleaned):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    cleaned = cleaned[:i+1]
                    break
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"[autoupdater] JSON parse failed: {e}", file=sys.stderr)
        print(f"[autoupdater] cleaned start: {cleaned[:400]}", file=sys.stderr)
        return 1

    proposals = payload.get("proposals", [])
    PROPOSALS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = PROPOSALS_DIR / f"{audit_path.stem}.json"
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False),
                         encoding="utf-8")
    print()
    print(f"[autoupdater] Wrote proposals: {out_path}")
    print(f"[autoupdater] {len(proposals)} proposals total")
    high_risk = [p for p in proposals if p.get("false_positive_risk") == "high"]
    actionable = [p for p in proposals
                   if p.get("false_positive_risk") in (None, "none", "low")
                   and p.get("old_string")]
    print(f"  - {len(actionable)} actionable (low/no FP risk + has patch)")
    print(f"  - {len(high_risk)} flagged as high false-positive risk (human review)")
    print()
    print("Summary by severity:")
    for sev in ("critical", "high", "medium", "low"):
        n = sum(1 for p in proposals if p.get("severity") == sev)
        if n:
            print(f"  {sev:<10}: {n}")
    print()
    print(f"Inspect: cat {out_path}")
    print(f"Apply (manual, L3): use Edit tool on each proposal — NOT automated yet.")
    return 0
# @ULTRON-DEPRECATED-END


def cmd_apply(args) -> int:
    """L3 AutoUpdater: launch claude session with proposals as task context.

    NOT automated. Opens new Claude Code window with the proposals JSON loaded
    so user can review each + apply via Edit tool with full context.

    Anti-laundering: NEVER auto-applies. Human-in-the-loop forced.
    """
    proposals_path = Path(args.proposals_file).resolve()
    if not proposals_path.exists():
        print(f"[autoupdater] Proposals file not found: {proposals_path}")
        return 1
    try:
        data = json.loads(proposals_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"[autoupdater] Invalid JSON: {e}")
        return 1
    proposals = data.get("proposals", [])
    if not proposals:
        print("[autoupdater] No proposals in file")
        return 0
    actionable = [p for p in proposals
                  if p.get("old_string") and
                  p.get("false_positive_risk") in (None, "none", "low")]
    print(f"[autoupdater] Loaded {len(proposals)} proposals "
          f"({len(actionable)} actionable, "
          f"{len(proposals) - len(actionable)} flagged FP or no-patch)")

    # Build a context prompt that Claude can act on
    prompt = (
        f"ULTRON L3 AutoUpdater — apply approved proposals.\n\n"
        f"File: {proposals_path}\n"
        f"Total proposals: {len(proposals)}\n"
        f"Actionable (low/no FP risk + has patch): {len(actionable)}\n\n"
        f"Para cada proposal actionable:\n"
        f"1. Lee finding_ref + rationale\n"
        f"2. Verifica que old_string aún existe en el target_file\n"
        f"3. Si tienes confianza: aplica con Edit tool (old_string → new_string)\n"
        f"4. Si dudas: report al usuario y skip\n\n"
        f"NUNCA aplicar si:\n"
        f"- false_positive_risk == 'high'\n"
        f"- old_string vacío o no encontrado\n"
        f"- el patch parece destruir información sin razón clara\n\n"
        f"Después: reporta resumen aplicado vs skipped."
    )

    # Spawn claude in a new window/tab via Windows Terminal if available
    cwd = str(Path.home() / ".claude" / "skills" / "ultron")
    if shutil.which("wt.exe"):
        cmd = ["wt.exe", "new-tab", "--title", "L3 AutoUpdater Apply",
               "-d", cwd, "claude", "--dangerously-skip-permissions", prompt]
        try:
            subprocess.Popen(cmd, creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
            print(f"[autoupdater] Spawned Claude session in Windows Terminal "
                  f"with {len(actionable)} actionable proposals.")
            print(f"[autoupdater] Review/apply each manually with Edit tool.")
        except Exception as e:
            print(f"[autoupdater] Failed to spawn: {e}")
            print(f"[autoupdater] Manual fallback: cd {cwd} && claude")
            return 1
    else:
        print(f"[autoupdater] wt.exe not found. Manual: cd {cwd} && claude")
        print(f"[autoupdater] Then ask Claude to apply proposals from {proposals_path}")
    return 0


# @ULTRON-DEPRECATED:14.0.0
#   reason: not surfaced in TUI since v12.4 (Kirkardo clipboard prompts replaced this pipeline)
#   replaced-by: cockpit/tui/prompts/* clipboard prompts launched from the Skills tab
#   remove-after: 2026-11-07
#   owner: USER
def cmd_full(args) -> int:
    """v10.4.10 — full L1+L2+L3 pipeline en un solo comando.

    Stage 1: audit (Sonnet QUICK ~30-60s)
    Stage 2: propose (Sonnet ~60s)
    Stage 3: apply (spawn Claude session human-gated)

    Anti-laundering preserved: stage 3 sigue requiring human review,
    no auto-apply. Solo automatiza la transición entre stages.
    """
    skill = args.skill
    print(f"[full] === ULTRON CORE Update Pipeline for '{skill}' ===")
    print()

    # Stage 1: audit
    print(f"[full] Stage 1/3: Kirkardo audit (Sonnet QUICK)...")
    audit_args = argparse.Namespace(skill=skill, quick=True)
    rc = cmd_audit(audit_args)
    if rc != 0:
        print(f"[full] Audit failed (exit {rc}). Aborting pipeline.")
        return 1

    # Detect latest audit file for this skill
    today = datetime.now().strftime("%Y-%m-%d")
    audit_path = AUDITS_DIR / f"{skill}-{today}.md"
    if not audit_path.exists():
        # Fallback: most recent matching pattern
        candidates = sorted(AUDITS_DIR.glob(f"{skill}-*.md"),
                             key=lambda p: p.stat().st_mtime, reverse=True)
        if not candidates:
            print(f"[full] No audit produced for '{skill}'. Aborting.")
            return 1
        audit_path = candidates[0]
    print(f"[full] Audit ready: {audit_path}")
    print()

    # Stage 2: propose
    print(f"[full] Stage 2/3: L2 propose (Sonnet patches)...")
    propose_args = argparse.Namespace(audit_file=str(audit_path))
    rc = cmd_propose(propose_args)
    if rc != 0:
        print(f"[full] Propose failed (exit {rc}). Aborting pipeline.")
        return 1

    proposals_path = PROPOSALS_DIR / f"{audit_path.stem}.json"
    if not proposals_path.exists():
        print(f"[full] No proposals file generated. Aborting.")
        return 1
    print(f"[full] Proposals ready: {proposals_path}")
    print()

    # Stage 3: apply (spawn Claude session)
    print(f"[full] Stage 3/3: L3 apply (spawn Claude review session)...")
    apply_args = argparse.Namespace(proposals_file=str(proposals_path))
    rc = cmd_apply(apply_args)
    if rc != 0:
        print(f"[full] Apply spawn failed (exit {rc}).")
        return 1

    print()
    print(f"[full] === Pipeline complete ===")
    print(f"[full] Audit:     {audit_path}")
    print(f"[full] Proposals: {proposals_path}")
    print(f"[full] Apply session spawned in new terminal — review + Edit manually.")
    return 0
# @ULTRON-DEPRECATED-END


def _load_news_categories() -> dict:
    if NEWS_CATEGORIES_FILE.exists():
        try:
            return json.loads(NEWS_CATEGORIES_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"custom_sections": {}}


def _save_news_categories(data: dict) -> None:
    NEWS_CATEGORIES_FILE.parent.mkdir(parents=True, exist_ok=True)
    NEWS_CATEGORIES_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )


BUILTIN_SECTION_NAMES = {"tech"}


def cmd_news_categories(args) -> int:
    """Manage registered news sections (list / add / remove)."""
    sub = getattr(args, "cat_cmd", None)
    data = _load_news_categories()

    if sub == "list" or sub is None:
        print("NEWS SECTIONS")
        print("=" * 60)
        print("Built-in: tech")
        custom = data.get("custom_sections", {})
        if custom:
            print(f"\nCustom ({len(custom)}):")
            for name, cfg in custom.items():
                label = cfg.get("label", name)
                suffix = cfg.get("file_suffix", f"-{name}")
                print(f"  {name:<20} → newsletter-YYYY-MM-DD{suffix}.html  ({label})")
        else:
            print("\nNo custom sections registered.")
        print()
        print("Add:    ultron news-categories add <name> --label <Label> "
              "--focus <topics> --sources <sources>")
        print("Remove: ultron news-categories remove <name>")
        return 0

    if sub == "add":
        name = args.name.lower().replace(" ", "-")
        if name in BUILTIN_SECTION_NAMES:
            print(f"[error] '{name}' is a built-in section and cannot be overridden.")
            return 1
        label = args.label or name.replace("-", " ").title()
        suffix = args.suffix or f"-{name}"
        accent = args.accent or "#a890d8"
        focus = args.focus or f"Noticias sobre {label}"
        sources = args.sources or f"Busca en internet noticias sobre {label}"
        priority_note = args.priority or f"PRIORIZA: noticias más recientes e impactantes sobre {label}."

        cfg = {
            "label": label,
            "tagline": f"{label} — Daily Brief",
            "accent": accent,
            "file_suffix": suffix,
            "sources": sources,
            "focus_sections": (
                f"1. HERO — noticia más impactante sobre {label}\n"
                f"2. NOTICIAS PRINCIPALES (4-5): artículos con contexto e impacto\n"
                f"3. EN PROFUNDIDAD (2-3): análisis, tendencias\n"
                f"4. THE BRIEF (5-8 one-liners con link)\n"
                f"\n{focus}\n"
            ),
            "priority_note": priority_note,
        }
        data.setdefault("custom_sections", {})[name] = cfg
        _save_news_categories(data)
        print(f"[news-categories] Registered section '{name}' ({label})")
        print(f"  Output suffix: newsletter-YYYY-MM-DD{suffix}.html")
        print(f"  Generate: ultron news --section {name}")
        return 0

    if sub == "remove":
        name = args.name.lower().replace(" ", "-")
        if name in BUILTIN_SECTION_NAMES:
            print(f"[error] '{name}' is built-in and cannot be removed.")
            return 1
        custom = data.get("custom_sections", {})
        if name not in custom:
            print(f"[error] Section '{name}' not found in custom sections.")
            return 1
        del custom[name]
        _save_news_categories(data)
        print(f"[news-categories] Removed section '{name}'.")
        return 0

    print(f"[error] Unknown subcommand: {sub}")
    return 1


def cmd_proposals(_args) -> int:
    if not PROPOSALS_DIR.exists():
        print("[autoupdater] No proposals yet")
        return 0
    files = sorted(PROPOSALS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime,
                    reverse=True)
    if not files:
        print("[autoupdater] No proposals yet")
        return 0
    print("PENDING PROPOSALS")
    print("=" * 70)
    for f in files[:20]:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            n = len(data.get("proposals", []))
            mtime = datetime.fromtimestamp(f.stat().st_mtime)
            print(f"  {mtime.strftime('%Y-%m-%d %H:%M')}  {f.stem:<35}  "
                  f"{n} proposal(s)")
        except (OSError, json.JSONDecodeError):
            continue
    return 0


def main():
    p = argparse.ArgumentParser(description="ULTRON AutoUpdater L1 (detect+audit only)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("scan",
                         help="List audit candidates ranked by priority")
    sp.set_defaults(func=cmd_scan)

    sp = sub.add_parser("audit",
                         help="Run Kirkardo audit on target skill")
    sp.add_argument("skill")
    sp.add_argument("--quick", action="store_true",
                    help="Use Sonnet (~5x cheaper) instead of Opus")
    sp.set_defaults(func=cmd_audit)

    sp = sub.add_parser("history",
                         help="Show recent audit history with notas")
    sp.set_defaults(func=cmd_history)

    sp = sub.add_parser("news-flags",
                         help="News items that suggest a specific skill update")
    sp.set_defaults(func=cmd_news_flags)

    sp = sub.add_parser("propose",
                         help="L2: generate patches from audit (Sonnet, NO apply)")
    sp.add_argument("audit_file", help="Path to audit .md file")
    sp.set_defaults(func=cmd_propose)

    sp = sub.add_parser("proposals",
                         help="List pending proposal files")
    sp.set_defaults(func=cmd_proposals)

    sp = sub.add_parser("apply",
                         help="L3: spawn Claude session to review/apply proposals (human-gated)")
    sp.add_argument("proposals_file", help="Path to proposals JSON")
    sp.set_defaults(func=cmd_apply)

    sp = sub.add_parser("news-categories",
                         help="Manage registered news sections (list / add / remove)")
    cat_sub = sp.add_subparsers(dest="cat_cmd")
    cat_sub.add_parser("list", help="List all registered sections")
    cat_add = cat_sub.add_parser("add", help="Register a new news section")
    cat_add.add_argument("name", help="Section ID (e.g. 'crypto', 'gaming')")
    cat_add.add_argument("--label", help="Display name (e.g. 'Crypto & Web3')")
    cat_add.add_argument("--suffix", help="File suffix (e.g. '-crypto')")
    cat_add.add_argument("--accent", help="Accent color hex (default #a890d8)")
    cat_add.add_argument("--focus", help="Focus topics description")
    cat_add.add_argument("--sources", help="Source sites to search")
    cat_add.add_argument("--priority", help="Priority note for Gemini")
    cat_remove = cat_sub.add_parser("remove", help="Remove a custom section")
    cat_remove.add_argument("name", help="Section ID to remove")
    sp.set_defaults(func=cmd_news_categories)

    sp = sub.add_parser("full",
                         help="Full pipeline: audit + propose + apply (chained, human-gated at apply)")
    sp.add_argument("skill", help="Skill name to audit + update")
    sp.set_defaults(func=cmd_full)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
