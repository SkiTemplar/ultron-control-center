#!/usr/bin/env python3
"""
ULTRON CONSISTENCY CHECK · v3.0
Verifica coherencia interna del sistema: versiones, counts, routing matrix, CLAUDE.md, knowledge.

Uso:
    python scripts/consistency-check.py                # static checks only (15 checks)
    python scripts/consistency-check.py --with-codex   # also runs Dual Mode live tests (#16)
                                                       # (consumes ~3-5K Codex tokens, ~30s)

v3.0 (v9.0.0): añade check #14 (Triple Mode artifacts: gemini-duet.ps1, schemas, knowledge),
               check #15 (Pester unit tests Gemini helper). Renumera Dual Mode live de #14 a #16.
v2.2 (v8.1.2): check #12 usa references/settings-snapshot.json como expected (self-contained).
"""
import argparse
import re
import subprocess
import sys
import io
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

ULTRON_DIR = Path.home() / ".claude" / "skills" / "ultron"  # skill markdown root (post-v14.9)
ULTRON_HOME = Path.home() / ".ultron"  # runtime + code root (post-v14.9)
KNOWLEDGE_DIR = ULTRON_HOME / "knowledge"


def _resolve(rel: str) -> Path:
    """Resolve a relative artifact path: scripts/ and tests/ live under ~/.ultron,
    everything else (references/, agents/, *.md) under the skill markdown folder."""
    norm = rel.replace("\\", "/")
    if norm.startswith(("scripts/", "tests/")):
        return ULTRON_HOME / rel
    return ULTRON_DIR / rel

EXPECTED_PERSONA_COUNT = 7  # Actualizar si se añaden/eliminan personas

KNOWN_PERSONAS = {
    "senior-engineer", "gamedev-engineer", "ui-designer", "business-strategist",
    "research-explainer", "windows-admin", "repo-evaluator",
}

EXPECTED_KNOWLEDGE_DOMAINS = {
    "cpp-ue5", "opengl", "cpp-modern", "csharp-unity",
    "python-modern", "typescript-web", "supabase", "claude-platform",
}


# ── Checks ────────────────────────────────────────────────────────────────────

def check_mode_headers() -> list[str]:
    """Todos los mode-*.md deben declarar una versión en su primer header
    Y esa versión debe coincidir con la de SKILL.md (auditor sin blind spot)."""
    issues = []
    skill_md = (ULTRON_DIR / "SKILL.md").read_text(encoding="utf-8")
    skill_ver = _extract_skill_version(skill_md)
    print(f"  SKILL.md version (referencia): {skill_ver or '(no encontrado)'}")
    for f in sorted(ULTRON_DIR.glob("mode-*.md")):
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
    """Count de personas debe ser consistente entre frontmatter, Layer 1 y JERARQUÍA.

    Post-v14.9.x token-efficiency: la tabla Layer 1 vive en references/routing-tables.md
    (extraída de SKILL.md para reducir boot tokens). El frontmatter ya no incluye
    'enruta a N personas' — el header del tabla ('Layer 1 — Personas (N)') es la SSOT."""
    issues = []
    skill_md = (ULTRON_DIR / "SKILL.md").read_text(encoding="utf-8")
    routing_tables = (ULTRON_DIR / "references" / "routing-tables.md").read_text(encoding="utf-8")

    fm_m = re.search(r"enruta a (\d+) personas", skill_md)
    fm_count = int(fm_m.group(1)) if fm_m else None

    l1_start = routing_tables.find("## Layer 1 — Personas")
    l1_end = routing_tables.find("### Confidence reporting")
    l1_section = routing_tables[l1_start:l1_end] if l1_start != -1 and l1_end != -1 else ""
    l1_rows = re.findall(r"^\|\s*[^|]+\|\s*\*\*[\w-]+\*\*\s*\|", l1_section, re.MULTILINE)
    l1_count = len(l1_rows)

    # JERARQUÍA en SKILL.md ya no lista las personas (movido a routing-tables.md);
    # solo dice "L1 PERSONAS 14". Leemos el número como referencia secundaria.
    j_m = re.search(r"L1 PERSONAS\s+(\d+)|(\d+) especialistas", skill_md)
    j_count = int((j_m.group(1) or j_m.group(2))) if j_m else None

    print(f"  Frontmatter 'enruta a N personas': {fm_count if fm_count else '(no encontrado)'}")
    print(f"  Filas en Layer 1 tabla:            {l1_count}")
    print(f"  JERARQUÍA 'N especialistas':       {j_count if j_count else '(no encontrado)'}")
    print(f"  EXPECTED_PERSONA_COUNT en script:  {EXPECTED_PERSONA_COUNT}")

    if l1_count != EXPECTED_PERSONA_COUNT:
        issues.append(f"Layer 1 tiene {l1_count} filas pero expected es {EXPECTED_PERSONA_COUNT}")
    if fm_count and fm_count != l1_count:
        issues.append(f"Frontmatter dice {fm_count} pero Layer 1 tiene {l1_count} filas")
    if j_count and j_count != l1_count:
        issues.append(f"JERARQUÍA dice {j_count} pero Layer 1 tiene {l1_count} filas")

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
    skill_md = (ULTRON_DIR / "SKILL.md").read_text(encoding="utf-8")
    vp_path = ULTRON_DIR / "references" / "version-policy.md"

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
    """CLAUDE.md debe declarar la misma major version que SKILL.md."""
    issues = []
    claude_md_path = ULTRON_DIR / "CLAUDE.md"
    skill_md_path = ULTRON_DIR / "SKILL.md"

    if not claude_md_path.exists():
        return ["CLAUDE.md no encontrado"]

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
    rm_path = ULTRON_DIR / "references" / "routing-matrix.md"

    if not rm_path.exists():
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
    mh_path = ULTRON_DIR / "mode-high.md"
    if not mh_path.exists():
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
    skill_md = (ULTRON_DIR / "SKILL.md").read_text(encoding="utf-8")

    l1_start = skill_md.find("### Layer 1 — Personas")
    l1_end = skill_md.find("### Confidence reporting")
    l1_section = skill_md[l1_start:l1_end] if l1_start != -1 else ""

    if "`/learn`" in l1_section or "· `/learn`" in l1_section:
        issues.append("/learn aparece como señal de dominio en Layer 1 — es overlay de modo, no señal de persona")
    else:
        print("  ✅ /learn no contamina Layer 1 señales de dominio")

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
        path = ULTRON_DIR / "references" / f
        if path.exists():
            issues.append(f"references/{f} existe — debería estar archivado en ~/.ultron/archive/v6.x-legacy/")

    if not issues:
        print("  ✅ Sin references legacy en el árbol activo")

    return issues


def check_agents_modernized() -> list[str]:
    """agents/ debe tener subagent-routing.md y NO los templates legacy."""
    issues = []
    agents_dir = ULTRON_DIR / "agents"

    legacy_files = ["analyst.md", "dispatcher.md", "researcher.md"]
    for f in legacy_files:
        if (agents_dir / f).exists():
            issues.append(f"agents/{f} legacy todavía existe — debería estar archivado")

    if not (agents_dir / "subagent-routing.md").exists():
        issues.append("agents/subagent-routing.md falta — recurso clave de v7.0")

    if not issues:
        print("  ✅ agents/ modernizado: subagent-routing.md presente, legacy archivado")

    return issues


def check_triple_mode_artifacts() -> list[str]:
    """v9.0 Triple Mode: Gemini helper + schemas + Pester tests + knowledge file deben existir."""
    issues = []
    required = {
        "scripts/shared-duet.ps1":                "helper PowerShell unificado (reemplaza gemini-duet.ps1 + codex-duet.ps1)",
        "references/gemini-duet-schema.json":     "JSON Schema para output Gemini",
        "references/triple-debate-schema.json":   "JSON Schema para síntesis Triple",
        "tests/shared-duet.Tests.ps1":            "Pester unit tests shared helper (reemplaza gemini-duet.Tests.ps1)",
    }
    for rel, desc in required.items():
        p = _resolve(rel)
        if not p.exists():
            issues.append(f"{rel} no existe ({desc})")
        else:
            print(f"  ✅ {rel} ({desc})")

    # Knowledge file in ~/.ultron (cross-repo dependency)
    gemini_kb = KNOWLEDGE_DIR / "claude-platform" / "gemini-cli.md"
    if not gemini_kb.exists():
        issues.append(f"~/.ultron/knowledge/claude-platform/gemini-cli.md no existe")
    else:
        size = gemini_kb.stat().st_size
        print(f"  ✅ knowledge gemini-cli.md ({size} bytes)")

    # Validate JSON schemas parse correctly
    import json
    for schema_rel in ("references/gemini-duet-schema.json", "references/triple-debate-schema.json"):
        try:
            json.loads((ULTRON_DIR / schema_rel).read_text(encoding="utf-8"))
        except (json.JSONDecodeError, FileNotFoundError) as e:
            issues.append(f"{schema_rel}: JSON inválido o no existe ({e})")

    if not issues:
        print("  ✅ Triple Mode artifacts presentes (helper + 2 schemas + Pester + knowledge)")
    return issues


def check_pester_gemini_tests(timeout_sec: int = 60) -> list[str]:
    """v9.0 / v12.2.2: shared-duet.Tests.ps1 covers Gemini + Codex helper (gemini-duet.Tests.ps1 removed)."""
    issues = []
    tests_file = ULTRON_HOME / "tests" / "shared-duet.Tests.ps1"
    if not tests_file.exists():
        return [f"tests/shared-duet.Tests.ps1 not found at {tests_file}"]

    print(f"  Running: Invoke-Pester {tests_file.name} (no Gemini calls, ~1s)")
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
            issues.append(f"Pester Gemini unit tests failed (exit {result.returncode})")
        else:
            print("  ✅ Pester Gemini unit tests passed")
    except subprocess.TimeoutExpired:
        issues.append(f"Pester Gemini tests timed out after {timeout_sec}s")
    except FileNotFoundError:
        issues.append("powershell not found in PATH")
    return issues


def check_pester_vault_tests(timeout_sec: int = 60) -> list[str]:
    """v10.0 → v12.2.2: auth-vault.ps1 and its tests removed (Auth Vault deprecated).
    This check is now a no-op — returns [] so health stays green."""
    return []
    timeout_sec = timeout_sec  # keep param to avoid removing the function signature
    issues = []
    tests_file = ULTRON_HOME / "tests" / "auth-vault.Tests.ps1"
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
        "scripts/cockpit/retention.py":        "log rotation/cleanup (4.D)",
        "scripts/cockpit/ultron.ps1":          "CENTRALITA - single entry point",
        "scripts/cockpit/news_html_generator.py": "On-demand HTML newsletter generator (v12)",
        "scripts/cockpit/calendar_match.py":   "Calendar deadline matching (4.J)",
        "scripts/cockpit/ai_standup.py":       "AI standup daily (4.M)",
        "scripts/cockpit/memory_sync.py":      "Memory L2 vault sync utility (v12)",
        "scripts/cockpit/research.py":         "Gemini-driven research (v10.1)",
        "scripts/cockpit/tui.py":              "Interactive TUI textual (v10.1)",
    }
    for rel, desc in required.items():
        p = _resolve(rel)
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


def check_dual_mode_artifacts() -> list[str]:
    """v8.0 Dual Mode: protocol spec + JSON schema + shared helper PS1 deben existir.
    v12.2.2: codex-duet.ps1 + gemini-duet.ps1 merged into shared-duet.ps1."""
    issues = []
    required = {
        "references/dual-mode-protocol.md": "spec del protocolo Dual Mode",
        "references/codex-duet-schema.json": "JSON Schema para output Codex",
        "scripts/shared-duet.ps1":           "helper PowerShell unificado (reemplaza codex-duet + gemini-duet)",
    }

    for rel_path, desc in required.items():
        path = _resolve(rel_path)
        if not path.exists():
            issues.append(f"{rel_path} no encontrado ({desc})")
        elif path.stat().st_size < 200:
            issues.append(f"{rel_path} parece vacío o truncado ({path.stat().st_size} bytes)")

    # Verificar que dual-mode-protocol.md menciona los 3 sub-modos
    dmp = ULTRON_DIR / "references" / "dual-mode-protocol.md"
    if dmp.exists():
        text = dmp.read_text(encoding="utf-8")
        for submode in ("MiniDual", "Dual", "MaxDual"):
            if submode not in text:
                issues.append(f"dual-mode-protocol.md no menciona '{submode}'")

    # Verificar que SKILL.md tiene la sección DUAL MODE OVERLAY
    skill_md = (ULTRON_DIR / "SKILL.md").read_text(encoding="utf-8")
    if "DUAL MODE OVERLAY" not in skill_md:
        issues.append("SKILL.md no contiene sección 'DUAL MODE OVERLAY'")

    if not issues:
        print("  ✅ Dual Mode artifacts presentes y referenciados (3 sub-modos detectados)")

    return issues


# ── Main ──────────────────────────────────────────────────────────────────────

def section(title: str):
    print(f"\n{'─'*60}")
    print(f"  {title}")
    print(f"{'─'*60}")


def check_pester_unit_tests(timeout_sec: int = 60) -> list[str]:
    """v8.1.0 / v12.2.2: Pester tests for shared-duet.ps1 (codex-duet.Tests.ps1 removed)."""
    issues = []
    tests_file = ULTRON_HOME / "tests" / "shared-duet.Tests.ps1"
    if not tests_file.exists():
        return [f"tests/shared-duet.Tests.ps1 not found at {tests_file}"]

    print(f"  Running: Invoke-Pester {tests_file.name} (no Codex calls, ~1s)")
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
            issues.append(f"Pester unit tests failed (exit {result.returncode})")
        else:
            print("  ✅ Pester unit tests passed")
    except subprocess.TimeoutExpired:
        issues.append(f"Pester tests timed out after {timeout_sec}s")
    except FileNotFoundError:
        issues.append("powershell not found in PATH")
    return issues


def check_codex_mcp_server_registered() -> list[str]:
    """v8.1.2: verify codex MCP server in settings.json matches expected snapshot.

    Uses references/settings-snapshot.json as the source of truth for expected shape.
    This makes the repo self-contained — a fresh clone can verify expected MCP
    registration without reading user-specific config first.
    """
    issues = []
    import json
    settings_path = Path.home() / ".claude" / "settings.json"
    snapshot_path = ULTRON_DIR / "references" / "settings-snapshot.json"

    if not snapshot_path.exists():
        return [f"settings-snapshot.json not found at {snapshot_path} — cannot verify"]
    try:
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        expected = snapshot.get("expected_mcp_codex", {})
    except json.JSONDecodeError as e:
        return [f"settings-snapshot.json invalid JSON: {e}"]

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


def check_dual_mode_live(timeout_sec: int = 300) -> list[str]:
    """v8.0.1: optional live test against Codex CLI via dual-mode-test-runner.ps1."""
    issues = []
    runner = ULTRON_HOME / "scripts" / "dual-mode-test-runner.ps1"
    if not runner.exists():
        return [f"dual-mode-test-runner.ps1 not found at {runner}"]

    print(f"  Running: powershell {runner.name} -Test All")
    print(f"  (consumes ~3-5K Codex tokens, may take up to {timeout_sec}s)")
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-File", str(runner), "-Test", "All"],
            capture_output=True, text=True, timeout=timeout_sec,
        )
        # Extract just the SUMMARY line for brevity
        for line in result.stdout.splitlines():
            if "Passed:" in line or "[PASS]" in line or "[FAIL]" in line:
                print(f"    {line.strip()}")
        if result.returncode != 0:
            issues.append(f"Dual Mode live tests failed (exit {result.returncode}). "
                          f"Run manually for full output: powershell {runner} -Test All")
        else:
            print("  ✅ All Dual Mode live tests passed")
    except subprocess.TimeoutExpired:
        issues.append(f"Dual Mode live tests timed out after {timeout_sec}s")
    except FileNotFoundError:
        issues.append("powershell not found in PATH (cannot run live tests)")
    return issues


def main():
    parser = argparse.ArgumentParser(description="ULTRON consistency check")
    parser.add_argument("--with-codex", action="store_true",
                        help="Also run Dual Mode live tests against Codex CLI "
                             "(consumes ~3-5K tokens, ~30s)")
    args = parser.parse_args()

    print(f"\n{'='*60}")
    print("ULTRON CONSISTENCY CHECK · v3.0")
    if args.with_codex:
        print("  (with --with-codex: live Dual Mode tests enabled)")
    print(f"{'='*60}")

    all_issues: list[str] = []

    section("1. HEADERS DE VERSIÓN EN MODE FILES")
    all_issues.extend(check_mode_headers())

    section("2. COUNT DE PERSONAS")
    all_issues.extend(check_persona_count())

    section("3. VERSION-POLICY SYNC")
    all_issues.extend(check_version_policy())

    section("4. CLAUDE.md VERSIÓN ALINEADA")
    all_issues.extend(check_claude_md_version())

    section("5. ROUTING MATRIX vs SKILL.md PERSONAS")
    all_issues.extend(check_routing_matrix_personas())

    section("6. MODE-HIGH ROUTING MATRIX vs SKILL.md PERSONAS")
    all_issues.extend(check_mode_high_routing_matrix())

    section("7. /learn NO EN LAYER 1 SEÑALES")
    all_issues.extend(check_no_learn_in_fast_path())

    section("8. KNOWLEDGE LAYER (~/.ultron/knowledge/)")
    all_issues.extend(check_knowledge_layer())

    section("9. NO REFERENCES LEGACY")
    all_issues.extend(check_no_legacy_refs())

    section("10. AGENTS/ MODERNIZADO")
    all_issues.extend(check_agents_modernized())

    section("11. DUAL MODE ARTIFACTS (v8.0)")
    all_issues.extend(check_dual_mode_artifacts())

    section("12. CODEX MCP SERVER REGISTRATION (v8.1)")
    all_issues.extend(check_codex_mcp_server_registered())

    section("13. PESTER UNIT TESTS (v8.1) — Codex")
    all_issues.extend(check_pester_unit_tests())

    section("14. TRIPLE MODE ARTIFACTS (v9.0) — Gemini helper + schemas + knowledge")
    all_issues.extend(check_triple_mode_artifacts())

    section("15. PESTER UNIT TESTS (v9.0) — Gemini")
    all_issues.extend(check_pester_gemini_tests())

    section("16. COCKPIT ARTIFACTS (v10.0) — scanner + base + scheduler + IDE map + vault")
    all_issues.extend(check_cockpit_artifacts())

    section("17. PESTER UNIT TESTS (v10.0) — Auth Vault DPAPI lifecycle")
    all_issues.extend(check_pester_vault_tests())

    if args.with_codex:
        section("18. DUAL MODE LIVE TESTS (Codex)")
        all_issues.extend(check_dual_mode_live())

    print(f"\n{'='*60}")
    if all_issues:
        print(f"❌ {len(all_issues)} problema(s) detectado(s):\n")
        for i, issue in enumerate(all_issues, 1):
            print(f"  {i}. {issue}")
        print()
        sys.exit(1)
    else:
        print("✅ Sistema consistente. Ningún drift detectado.")
        sys.exit(0)


if __name__ == "__main__":
    main()
