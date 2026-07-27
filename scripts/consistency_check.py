#!/usr/bin/env python3
"""
ULTRON CONSISTENCY CHECK · v4.1 (recalibrado auditoría 2026-07-27)

Verifica coherencia interna del sistema. Sprint 3 F14: renamed from
consistency-check.py → consistency_check.py (Python convention), --quiet mode
for hook invocation that writes findings to pending_actions queue.

v15.5.21: dropped the Dual Mode v1 checks (the deprecated PowerShell duet
helper, duet JSON schemas, Pester suites, live duet runner) — that
subsystem was deleted in v15.0.1 when Dual/Triple Mode migrated to the
official Codex plugin. The Codex MCP registration check (section 11)
covers the v2 wiring.

v4.1 (2026-07-27): el checker llevaba 20 falsos positivos por validar un
sistema que ya no existe. Recalibrado contra la realidad: personas L1 se
extraen del quick-reference de SKILL.md (personas_ssot no existe — el
import fallaba en silencio y usaba un fallback de 7 nombres de la era
pre-consolidación); knowledge vive en ~/.ultron-vault/10_KNOWLEDGE/;
5 scripts cockpit retirados; check de versión en CLAUDE.md retirado
(CLAUDE.md lleva la versión de la app, no de la skill).

Uso:
    python scripts/consistency_check.py             # static checks
    python scripts/consistency_check.py --quiet     # only output if issues; logs to pending_actions
"""
import argparse
import re
import subprocess
import sys
import io
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

ULTRON_DIR = Path(__file__).parent.parent
# v4.1: el knowledge layer vive en el vault (~/.ultron/knowledge/ fue retirado).
KNOWLEDGE_DIR = Path.home() / ".ultron-vault" / "10_KNOWLEDGE"


def _resolve_skill_dir() -> Path:
    """Resolve the ULTRON skill directory.

    SKILL.md and the mode-*.md / references/ live in the Claude skills tree
    (~/.claude/skills/ultron/), NOT in the ~/.ultron/ repo. Try the canonical
    location first, then a couple of fallbacks. Callers must tolerate a
    non-existent path (checks skip clean instead of crashing)."""
    candidates = [
        Path.home() / ".claude" / "skills" / "ultron",
        ULTRON_DIR / ".claude" / "skills" / "ultron",
        ULTRON_DIR,  # last resort: legacy assumption (repo == skill)
    ]
    for c in candidates:
        if (c / "SKILL.md").exists():
            return c
    return candidates[0]  # canonical path even if missing — checks handle absence


SKILL_DIR = _resolve_skill_dir()
SKILL_INSTALLED = (SKILL_DIR / "SKILL.md").exists()

# v4.1: la SSOT de personas L1 es el propio quick-reference de SKILL.md
# (tabla `| señal | **persona** |` del FAST PATH). personas_ssot no existe en
# disco — el import fallaba en silencio y el fallback listaba 7 nombres de la
# era pre-consolidación, generando 13 falsos positivos.
PERSONA_ROW_RE = re.compile(r"^\|[^|]+\|\s*\*\*([\w-]+)\*\*\s*\|", re.MULTILINE)


def _load_known_personas():
    skill_md_path = SKILL_DIR / "SKILL.md"
    if not skill_md_path.exists():
        return set()
    return set(PERSONA_ROW_RE.findall(skill_md_path.read_text(encoding="utf-8")))

KNOWN_PERSONAS = _load_known_personas()
EXPECTED_PERSONA_COUNT = len(KNOWN_PERSONAS)

EXPECTED_KNOWLEDGE_DOMAINS = {
    "cpp-ue5", "opengl", "cpp-modern", "csharp-unity",
    "python-modern", "typescript-web", "supabase", "claude-platform",
}


# ── Checks ────────────────────────────────────────────────────────────────────

def check_mode_headers() -> list[str]:
    """Todos los mode-*.md deben declarar una versión en su primer header
    Y esa versión debe coincidir con la de SKILL.md (auditor sin blind spot)."""
    issues = []
    skill_md_path = SKILL_DIR / "SKILL.md"
    if not skill_md_path.exists():
        print(f"  ⚠️  SKILL.md no encontrado en {SKILL_DIR} — check saltado")
        return []
    skill_md = skill_md_path.read_text(encoding="utf-8")
    skill_ver = _extract_skill_version(skill_md)
    print(f"  SKILL.md version (referencia): {skill_ver or '(no encontrado)'}")
    for f in sorted(SKILL_DIR.glob("mode-*.md")):
        text = f.read_text(encoding="utf-8")
        m = re.search(r"^#\s+ULTRON[^·\n]*·\s+(v[\d.]+)", text, re.MULTILINE)
        if not m:
            issues.append(f"{f.name}: no se encuentra header con versión semántica")
            continue
        ver = m.group(1)
        if skill_ver and ver != skill_ver:
            issues.append(f"{f.name}: header={ver} no coincide con SKILL.md={skill_ver}")
            print(f"  ❌ {f.name:<22} header: {ver} (esperado {skill_ver})")
        else:
            print(f"  ✅ {f.name:<22} header: {ver}")
    return issues


def check_persona_count() -> list[str]:
    """v4.1: el quick-reference del FAST PATH declara 'cubre las N personas L1';
    N debe coincidir con las filas de la tabla, y cada persona debe existir en
    disco como skill (~/.claude/skills/<name>/ o <name>.disabled/)."""
    issues = []
    skill_md_path = SKILL_DIR / "SKILL.md"
    if not skill_md_path.exists():
        print(f"  ⚠️  SKILL.md no encontrado en {SKILL_DIR} — check saltado")
        return []
    skill_md = skill_md_path.read_text(encoding="utf-8")

    decl_m = re.search(r"cubre las (\d+) personas L1", skill_md)
    decl_count = int(decl_m.group(1)) if decl_m else None

    print(f"  Declarado 'cubre las N personas L1': {decl_count if decl_count else '(no encontrado)'}")
    print(f"  Filas persona en quick-reference:    {EXPECTED_PERSONA_COUNT}")

    if not KNOWN_PERSONAS:
        return ["No pude extraer personas del quick-reference de SKILL.md (tabla `| señal | **persona** |`)"]
    if decl_count is None:
        issues.append("SKILL.md no declara 'cubre las N personas L1' en el quick-reference")
    elif decl_count != EXPECTED_PERSONA_COUNT:
        issues.append(
            f"SKILL.md declara {decl_count} personas L1 pero el quick-reference tiene {EXPECTED_PERSONA_COUNT} filas"
        )

    skills_root = Path.home() / ".claude" / "skills"
    missing_on_disk = [
        p for p in sorted(KNOWN_PERSONAS)
        if not (skills_root / p).is_dir() and not (skills_root / f"{p}.disabled").is_dir()
    ]
    for p in missing_on_disk:
        issues.append(f"Persona L1 '{p}' del quick-reference NO existe en disco ({skills_root}\\{p}[.disabled])")
    if not missing_on_disk:
        print(f"  ✅ Las {EXPECTED_PERSONA_COUNT} personas L1 existen en disco (activas o .disabled)")

    return issues


def _extract_skill_version(text: str) -> str | None:
    """Extrae versión 'vX.Y.Z' del frontmatter description o header."""
    m = re.search(r"description:.*?ULTRON (v[\d.]+)", text, re.DOTALL)
    if m:
        return m.group(1)
    m = re.search(r"^#\s+ULTRON\s+(v[\d.]+)", text, re.MULTILINE)
    return m.group(1) if m else None


def check_version_policy() -> list[str]:
    """SKILL.md frontmatter y version-policy.md tabla deben coincidir."""
    issues = []
    skill_md_path = SKILL_DIR / "SKILL.md"
    if not skill_md_path.exists():
        print(f"  ⚠️  SKILL.md no encontrado en {SKILL_DIR} — check saltado")
        return []
    skill_md = skill_md_path.read_text(encoding="utf-8")
    vp_path = SKILL_DIR / "references" / "version-policy.md"

    if not vp_path.exists():
        return ["version-policy.md no encontrado"]

    vp = vp_path.read_text(encoding="utf-8")

    fm_ver = _extract_skill_version(skill_md) or "(no encontrado)"

    vp_m = re.search(r"\|\s*\*\*ultron\*\*\s*\|\s*(v[\d.]+)", vp)
    vp_ver = vp_m.group(1) if vp_m else "(no encontrado)"

    print(f"  SKILL.md frontmatter: {fm_ver}")
    print(f"  version-policy.md:    {vp_ver}")

    if fm_ver != vp_ver:
        issues.append(f"Versiones no coinciden: frontmatter={fm_ver}, version-policy={vp_ver}")
    else:
        print(f"  ✅ Versiones consistentes ({fm_ver})")

    return issues


def check_claude_md_version() -> list[str]:
    """v4.1: RETIRADO. ~/.ultron/CLAUDE.md lleva la versión de la APP
    (package.json/Cargo.toml, p.ej. v2.7.1), no la de la skill — comparar
    ambas era un falso positivo permanente. La sincronía de versión de la
    skill ya la cubren los checks 1 (mode files) y 3 (version-policy)."""
    print("  ⚠️  check retirado en v4.1 — CLAUDE.md versiona la app, no la skill")
    return []
    issues = []
    # CLAUDE.md puede vivir en el repo (~/.ultron/) o en el árbol de Claude
    # (~/.claude/). SKILL.md vive en el árbol de skills.
    claude_md_candidates = [
        ULTRON_DIR / "CLAUDE.md",
        SKILL_DIR / "CLAUDE.md",
        Path.home() / ".claude" / "CLAUDE.md",
    ]
    claude_md_path = next((c for c in claude_md_candidates if c.exists()), None)
    skill_md_path = SKILL_DIR / "SKILL.md"

    if claude_md_path is None:
        print(f"  ⚠️  CLAUDE.md no encontrado en {[str(c) for c in claude_md_candidates]} — check saltado")
        return []
    if not skill_md_path.exists():
        print(f"  ⚠️  SKILL.md no encontrado en {SKILL_DIR} — check saltado")
        return []

    claude_md = claude_md_path.read_text(encoding="utf-8")
    skill_md = skill_md_path.read_text(encoding="utf-8")

    skill_ver = _extract_skill_version(skill_md)
    if not skill_ver:
        return ["No pude leer versión de SKILL.md"]

    skill_major_minor = ".".join(skill_ver.lstrip("v").split(".")[:2])  # v7.0.0 → 7.0

    # Buscar en CLAUDE.md cualquier referencia a versión vX.Y
    versions_found = re.findall(r"v\d+\.\d+(?:\.\d+)?", claude_md)
    versions_clean = {v.lstrip("v") for v in versions_found}
    versions_majorminor = {".".join(v.split(".")[:2]) for v in versions_clean}

    print(f"  SKILL.md major.minor:   {skill_major_minor}")
    print(f"  CLAUDE.md versions:     {sorted(versions_found) if versions_found else '(ninguna)'}")

    if not versions_found:
        issues.append("CLAUDE.md no declara ninguna versión vX.Y")
    elif skill_major_minor not in versions_majorminor:
        issues.append(
            f"CLAUDE.md no menciona la versión actual ({skill_major_minor}). "
            f"Encontradas: {sorted(versions_clean)}"
        )
    else:
        print(f"  ✅ CLAUDE.md alineado con SKILL.md (major.minor {skill_major_minor})")

    return issues


def check_routing_matrix_personas() -> list[str]:
    """routing-matrix.md INSTANT ROUTING debe tener las mismas personas que SKILL.md Layer 1."""
    issues = []
    rm_path = SKILL_DIR / "references" / "routing-matrix.md"

    if not rm_path.exists():
        if not SKILL_INSTALLED:
            print("  ⚠️  skill ULTRON no instalada — check saltado")
            return []
        return ["routing-matrix.md no encontrado"]

    rm = rm_path.read_text(encoding="utf-8")

    ir_start = rm.find("## ⚡ INSTANT ROUTING")
    ir_end = rm.find("## ARBOL PRINCIPAL")
    ir_section = rm[ir_start:ir_end] if ir_start != -1 and ir_end != -1 else rm
    rm_personas = set(re.findall(r"\*\*([\w-]+)\*\*", ir_section))
    rm_personas &= KNOWN_PERSONAS

    missing_in_rm = KNOWN_PERSONAS - rm_personas
    for p in sorted(missing_in_rm):
        issues.append(f"Persona '{p}' en SKILL.md Layer 1 pero NO en routing-matrix INSTANT ROUTING")

    if not missing_in_rm:
        print(f"  ✅ routing-matrix.md cubre las {len(KNOWN_PERSONAS)} personas conocidas")

    return issues


def check_mode_high_routing_matrix() -> list[str]:
    """mode-high.md ROUTING MATRIX debe listar las mismas personas que SKILL.md Layer 1."""
    issues = []
    mh_path = SKILL_DIR / "mode-high.md"
    if not mh_path.exists():
        if not SKILL_INSTALLED:
            print("  ⚠️  skill ULTRON no instalada — check saltado")
            return []
        return ["mode-high.md no encontrado"]

    mh = mh_path.read_text(encoding="utf-8")

    rm_start = mh.find("## ROUTING MATRIX")
    rm_end = mh.find("##", rm_start + 5) if rm_start != -1 else -1
    rm_section = mh[rm_start:rm_end] if rm_start != -1 else ""

    mh_personas = set(re.findall(r"\*\*([\w-]+)\*\*", rm_section)) & KNOWN_PERSONAS
    missing = KNOWN_PERSONAS - mh_personas

    for p in sorted(missing):
        issues.append(f"Persona '{p}' en SKILL.md Layer 1 pero NO en mode-high ROUTING MATRIX")

    if not missing:
        print(f"  ✅ mode-high.md ROUTING MATRIX cubre las {len(KNOWN_PERSONAS)} personas")

    return issues


def check_no_learn_in_fast_path() -> list[str]:
    """/learn no debe aparecer como señal de dominio en Layer 1 (es overlay de modo)."""
    issues = []
    skill_md_path = SKILL_DIR / "SKILL.md"
    if not skill_md_path.exists():
        print(f"  ⚠️  SKILL.md no encontrado en {SKILL_DIR} — check saltado")
        return []
    skill_md = skill_md_path.read_text(encoding="utf-8")

    # v4.1: las señales de dominio viven en el quick-reference del FAST PATH.
    fp_start = skill_md.find("## ⚡ FAST PATH")
    fp_end = skill_md.find("## ", fp_start + 5) if fp_start != -1 else -1
    fp_section = skill_md[fp_start:fp_end] if fp_start != -1 and fp_end != -1 else ""

    learn_rows = [r for r in fp_section.splitlines() if r.startswith("|") and "`/learn`" in r]
    if learn_rows:
        issues.append("/learn aparece como señal de dominio en el FAST PATH — es overlay de modo, no señal de persona")
    else:
        print("  ✅ /learn no contamina las señales de dominio del FAST PATH")

    return issues


def check_knowledge_layer() -> list[str]:
    """~/.ultron/knowledge/ debe existir, tener INDEX.md y los dominios esperados."""
    issues = []

    if not KNOWLEDGE_DIR.exists():
        return [f"Knowledge dir no existe: {KNOWLEDGE_DIR}"]

    index_path = KNOWLEDGE_DIR / "INDEX.md"
    if not index_path.exists():
        issues.append(f"INDEX.md no existe en {KNOWLEDGE_DIR}")
    else:
        print(f"  ✅ INDEX.md existe ({index_path.stat().st_size} bytes)")

    found_domains = {p.name for p in KNOWLEDGE_DIR.iterdir() if p.is_dir()}
    missing_domains = EXPECTED_KNOWLEDGE_DOMAINS - found_domains

    for d in sorted(missing_domains):
        issues.append(f"Knowledge domain '{d}' esperado pero no encontrado")

    # Domains con archivos vacíos
    empty_domains = []
    for d in EXPECTED_KNOWLEDGE_DOMAINS:
        domain_path = KNOWLEDGE_DIR / d
        if domain_path.exists():
            md_files = list(domain_path.glob("*.md"))
            if not md_files:
                empty_domains.append(d)

    if empty_domains:
        print(f"  ⚠️  Dominios vacíos (sin .md): {sorted(empty_domains)}")

    if not missing_domains:
        print(f"  ✅ {len(EXPECTED_KNOWLEDGE_DOMAINS)} dominios knowledge presentes")

    return issues


def check_no_legacy_refs() -> list[str]:
    """Los 3 references legacy (memory-system, project-lifecycle, dispatch-protocols) NO deben existir."""
    issues = []
    legacy = ["memory-system.md", "project-lifecycle.md", "dispatch-protocols.md"]

    for f in legacy:
        path = SKILL_DIR / "references" / f
        if path.exists():
            issues.append(f"references/{f} existe — debería estar archivado en ~/.ultron/archive/v6.x-legacy/")

    if not issues:
        print("  ✅ Sin references legacy en el árbol activo")

    return issues


def check_agents_modernized() -> list[str]:
    """agents/ debe tener subagent-routing.md y NO los templates legacy."""
    issues = []
    if not SKILL_INSTALLED:
        print("  ⚠️  skill ULTRON no instalada — check saltado")
        return []
    # subagent-routing.md y los templates legacy viven en el árbol de skills.
    agents_dir = SKILL_DIR / "agents"

    legacy_files = ["analyst.md", "dispatcher.md", "researcher.md"]
    for f in legacy_files:
        if (agents_dir / f).exists():
            issues.append(f"agents/{f} legacy todavía existe — debería estar archivado")

    if not (agents_dir / "subagent-routing.md").exists():
        issues.append("agents/subagent-routing.md falta — recurso clave de v7.0")

    if not issues:
        print("  ✅ agents/ modernizado: subagent-routing.md presente, legacy archivado")

    return issues


def check_pester_vault_tests(timeout_sec: int = 60) -> list[str]:
    """v10.0 → v12.2.2: auth-vault.ps1 and its tests removed (Auth Vault deprecated).
    This check is now a no-op — returns [] so health stays green."""
    return []
    timeout_sec = timeout_sec  # keep param to avoid removing the function signature
    issues = []
    tests_file = ULTRON_DIR / "tests" / "auth-vault.Tests.ps1"
    if not tests_file.exists():
        return []

    print(f"  Running: Invoke-Pester {tests_file.name} (DPAPI lifecycle smoke, ~2s)")
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"Invoke-Pester -Script '{tests_file}' -Quiet -EnableExit"],
            capture_output=True, text=True, timeout=timeout_sec,
        )
        for line in result.stdout.splitlines():
            if "Passed:" in line or "Failed:" in line:
                print(f"    {line.strip()}")
        if result.returncode != 0:
            issues.append(f"Pester Vault unit tests failed (exit {result.returncode})")
        else:
            print("  ✅ Pester Vault unit tests passed")
    except subprocess.TimeoutExpired:
        issues.append(f"Pester Vault tests timed out after {timeout_sec}s")
    except FileNotFoundError:
        issues.append("powershell not found in PATH")
    return issues


def check_cockpit_artifacts() -> list[str]:
    """v10.0 Cockpit: scanner + base utilities + scheduler installer + IDE mappings + auth vault deben existir."""
    issues = []
    required = {
        "scripts/cockpit/cockpit_base.py":     "shared utilities (Project dataclass, JSON IO, IDE detection)",
        "scripts/cockpit/scan_projects.py":    "auto-discovery scanner (4.B)",
        "scripts/cockpit/install-scheduler.ps1": "Windows Task Scheduler installer (4 tasks)",
        "scripts/cockpit/launch_project.py":   "IDE launcher (4.E)",
        "scripts/cockpit/ultron.ps1":          "CENTRALITA - single entry point",
        # tui.py removed in v15.4 (Control Center replaces it).
        # v4.1: retention.py, calendar_match.py, ai_standup.py, memory_sync.py
        # y research.py retirados de la lista — no existen en disco (features
        # eliminadas o nunca embarcadas; verificado auditoría 2026-07-27).
    }
    for rel, desc in required.items():
        p = ULTRON_DIR / rel
        if not p.exists():
            issues.append(f"{rel} no existe ({desc})")
        else:
            print(f"  ✅ {rel} ({desc})")

    # ide-mappings.json + cockpit dir under ~/.ultron
    cockpit_dir = Path.home() / ".ultron" / "cockpit"
    if not cockpit_dir.exists():
        issues.append(f"~/.ultron/cockpit/ no existe (run scan_projects.py first)")
    else:
        print(f"  ✅ ~/.ultron/cockpit/ existe")

    ide_map = cockpit_dir / "ide-mappings.json"
    if ide_map.exists():
        try:
            import json
            json.loads(ide_map.read_text(encoding="utf-8"))
            print(f"  ✅ ide-mappings.json (valid JSON)")
        except (json.JSONDecodeError, OSError) as e:
            issues.append(f"ide-mappings.json invalid: {e}")

    if not issues:
        print("  ✅ Cockpit artifacts presentes (scanner + base + scheduler + IDE map)")
    return issues


# ── Pending-actions DLQ ───────────────────────────────────────────────────────
# v4.1: upsert directo en cockpit/pending_actions.json. El módulo
# cockpit/pending_actions.py que invocaba v4.0 nunca existió — la escalada
# del Stop hook fallaba en silencio dentro del try/except.

PENDING_ACTIONS_JSON = ULTRON_DIR / "cockpit" / "pending_actions.json"
DRIFT_ID = "CONSISTENCY-DRIFT"


def _load_pending_actions() -> dict:
    import json
    if PENDING_ACTIONS_JSON.exists():
        return json.loads(PENDING_ACTIONS_JSON.read_text(encoding="utf-8"))
    return {"version": 1, "actions": []}


def _save_pending_actions(data: dict):
    import json
    from datetime import datetime
    data["updated_at"] = datetime.now().isoformat(timespec="seconds")
    PENDING_ACTIONS_JSON.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def upsert_consistency_drift(all_issues: list[str]):
    """Escala el drift a la cola (una sola entrada, actualizada in-place)."""
    from datetime import datetime
    data = _load_pending_actions()
    entry = next((a for a in data.get("actions", []) if a.get("id") == DRIFT_ID), None)
    if entry is None:
        entry = {
            "id": DRIFT_ID, "severity": "high", "blocking": False, "deadline": None,
            "source_audit": "stop-hook:consistency_check",
            "created_at": datetime.now().isoformat(timespec="seconds"), "notes": [],
        }
        data.setdefault("actions", []).append(entry)
    summary = "; ".join(all_issues[:3]) + (" ..." if len(all_issues) > 3 else "")
    entry["title"] = f"consistency_check: {len(all_issues)} drift"
    entry["description"] = summary[:500]
    entry["status"] = "open"
    entry.pop("resolved_at", None)
    _save_pending_actions(data)


def resolve_consistency_drift():
    """Con el sistema verde, cierra la entrada de drift si quedó abierta."""
    from datetime import datetime
    data = _load_pending_actions()
    entry = next((a for a in data.get("actions", []) if a.get("id") == DRIFT_ID), None)
    if entry is None or entry.get("status") == "resolved":
        return
    entry["status"] = "resolved"
    entry["resolved_at"] = datetime.now().isoformat(timespec="seconds")
    _save_pending_actions(data)


# ── Main ──────────────────────────────────────────────────────────────────────

def section(title: str):
    print(f"\n{'─'*60}")
    print(f"  {title}")
    print(f"{'─'*60}")


def check_codex_mcp_server_registered() -> list[str]:
    """v8.1.2: verify codex MCP server in settings.json matches expected snapshot.

    Uses references/settings-snapshot.json as the source of truth for expected shape.
    This makes the repo self-contained — a fresh clone can verify expected MCP
    registration without reading user-specific config first.
    """
    issues = []
    import json
    settings_path = Path.home() / ".claude" / "settings.json"
    snapshot_path = SKILL_DIR / "references" / "settings-snapshot.json"

    if not snapshot_path.exists():
        if not SKILL_INSTALLED:
            print("  ⚠️  skill ULTRON no instalada — check saltado")
            return []
        return [f"settings-snapshot.json not found at {snapshot_path} — cannot verify"]
    try:
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        expected = snapshot.get("expected_mcp_codex", {})
    except json.JSONDecodeError as e:
        return [f"settings-snapshot.json invalid JSON: {e}"]

    # ULT-13 (auditoria 2026-07-16): expected_mcp_codex=null declara que Codex
    # corre via plugin/CLI sin MCP server registrado — el check se salta en vez
    # de exigir un MCP que ya no existe en settings.json.
    if not expected:
        return []

    if not settings_path.exists():
        return [f"settings.json not found at {settings_path} (snapshot exists, but live settings missing)"]

    try:
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return [f"settings.json invalid JSON: {e}"]

    mcp = settings.get("mcpServers", {})
    if "codex" not in mcp:
        return ["codex MCP server NOT registered in settings.json (v8.1.0 expects native MCP integration)"]

    codex_cfg = mcp["codex"]
    args_str = " ".join(codex_cfg.get("args", []))

    # Expected type
    expected_type = expected.get("type")
    if expected_type and codex_cfg.get("type") != expected_type:
        issues.append(f"codex MCP type mismatch: expected '{expected_type}', got '{codex_cfg.get('type')}'")

    # Expected command basename
    expected_basename = expected.get("command_basename", "")
    cmd = codex_cfg.get("command", "")
    if expected_basename and not cmd.lower().endswith(expected_basename.lower()):
        issues.append(f"codex MCP command should end with '{expected_basename}', got '{cmd}'")

    # All required substrings present
    for required in expected.get("required_args_substrings", []):
        if required not in args_str:
            issues.append(f"codex MCP args missing required substring: '{required}'")

    # No forbidden substrings
    for forbidden in expected.get("forbidden_args_substrings", []):
        if forbidden in args_str:
            issues.append(f"codex MCP args contain FORBIDDEN substring (security): '{forbidden}'")

    if not issues:
        print(f"  ✅ codex MCP server matches snapshot (sandbox=read-only, model=gpt-5.5)")
    return issues


def main():
    parser = argparse.ArgumentParser(description="ULTRON consistency check")
    parser.add_argument("--quiet", action="store_true",
                        help="Only print if issues found (Stop hook mode); "
                             "writes findings to pending_actions on failure.")
    args = parser.parse_args()

    # Quiet mode: capture stdout
    _real_stdout = sys.stdout
    if args.quiet:
        sys.stdout = io.StringIO()

    print(f"\n{'='*60}")
    print("ULTRON CONSISTENCY CHECK · v4.1")
    print(f"{'='*60}")

    all_issues: list[str] = []

    section("1. HEADERS DE VERSIÓN EN MODE FILES")
    all_issues.extend(check_mode_headers())

    section("2. COUNT DE PERSONAS")
    all_issues.extend(check_persona_count())

    section("3. VERSION-POLICY SYNC")
    all_issues.extend(check_version_policy())

    section("4. CLAUDE.md VERSIÓN ALINEADA (retirado v4.1)")
    all_issues.extend(check_claude_md_version())

    section("5. ROUTING MATRIX vs SKILL.md PERSONAS")
    all_issues.extend(check_routing_matrix_personas())

    section("6. MODE-HIGH ROUTING MATRIX vs SKILL.md PERSONAS")
    all_issues.extend(check_mode_high_routing_matrix())

    section("7. /learn NO EN LAYER 1 SEÑALES")
    all_issues.extend(check_no_learn_in_fast_path())

    section("8. KNOWLEDGE LAYER (~/.ultron-vault/10_KNOWLEDGE/)")
    all_issues.extend(check_knowledge_layer())

    section("9. NO REFERENCES LEGACY")
    all_issues.extend(check_no_legacy_refs())

    section("10. AGENTS/ MODERNIZADO")
    all_issues.extend(check_agents_modernized())

    section("11. CODEX MCP SERVER REGISTRATION (v8.1)")
    all_issues.extend(check_codex_mcp_server_registered())

    section("12. COCKPIT ARTIFACTS (v10.0) — scanner + base + scheduler + IDE map + vault")
    all_issues.extend(check_cockpit_artifacts())

    section("13. PESTER UNIT TESTS (v10.0) — Auth Vault DPAPI lifecycle")
    all_issues.extend(check_pester_vault_tests())

    print(f"\n{'='*60}")
    if all_issues:
        print(f"❌ {len(all_issues)} problema(s) detectado(s):\n")
        for i, issue in enumerate(all_issues, 1):
            print(f"  {i}. {issue}")
        print()
        if args.quiet:
            captured = sys.stdout.getvalue()
            sys.stdout = _real_stdout
            sys.stderr.write(captured)
        try:
            upsert_consistency_drift(all_issues)
        except Exception:
            pass  # never crash hook
        sys.exit(1)
    else:
        try:
            resolve_consistency_drift()
        except Exception:
            pass  # never crash hook
        if args.quiet:
            sys.stdout = _real_stdout  # silent on success
        else:
            print("✅ Sistema consistente. Ningún drift detectado.")
        sys.exit(0)


if __name__ == "__main__":
    main()
