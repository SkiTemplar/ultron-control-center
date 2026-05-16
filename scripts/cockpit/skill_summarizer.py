#!/usr/bin/env python3
"""
ULTRON v12.4 -- Skill Summarizer (Task 6B)

Generates canonical 100-250 token digests for every skill in the manifest.
Stored in ~/.ultron/skill_cache/<name>.json — used for tree-reading (L1.5):
load digest instead of full SKILL.md unless task requires full execution.

Digest schema:
  name, purpose, authority, triggers, expensive_deps, memory_policy,
  mode_cap, routes, category, token_estimate, generated_at

Commands:
    skill_summarizer.py build            Generate digests for all active skills
    skill_summarizer.py show <name>      Print digest for a named skill
    skill_summarizer.py validate         Check all Tier A personas have digests
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import COCKPIT_DIR  # noqa: E402

SKILLS_DIR = Path.home() / ".claude" / "skills"
MANIFEST_PATH = Path.home() / ".ultron" / "skill_manifest.json"
CACHE_DIR = Path.home() / ".ultron" / "skill_cache"

# ── Tier A personas requiring constitution + digest ────────────────────────────
TIER_A = {
    "ultron", "skill-creator", "consolidate-memory", "repo-evaluator",
    "senior-engineer", "ui-designer", "gamedev-engineer", "windows-admin",
}

# ── Hardcoded trigger phrases per skill ───────────────────────────────────────
_TRIGGERS: dict[str, list[str]] = {
    "ultron":               ["modo", "high", "ultra", "low", "dual", "triple", "orchestrator"],
    "senior-engineer":      [".cpp", ".py", ".ts", "bug", "fix", "refactor", "commit", "deploy", "código"],
    "gamedev-engineer":     ["UE5", "Unreal", "Unity", "Blueprint", "GAS", "netcode", "game dev", "shader"],
    "ui-designer":          ["UI", "UX", "diseño", "layout", "color", "wireframe", "interfaz visual"],
    "business-strategist":  ["monetizar", "pricing", "pitch", "ventas", "GTM", "modelo de negocio"],
    "research-explainer":   ["investiga", "explica", "paper", "ciencia", "por qué", "teoría"],
    "windows-admin":        ["proceso", "PowerShell", "driver", "carpeta", "Windows", "sistema"],
    "repo-evaluator":       ["evalúa", "nota", "audit", "score", "review", "ponme nota"],
    "skill-creator":        ["crea skill", "nueva skill", "mejora skill", "skill-creator"],
    "consolidate-memory":   ["consolida", "fusiona", "duplicados", "vault sync", "brain index"],
    "mcp-builder":          ["crea MCP", "servidor MCP", "MCP server"],
    "skill-improver":       ["mejora skill", "refina SKILL.md", "calidad de skill"],
    "superpowers":          ["TDD", "testing", "debug sistemático", "pruebas", "systematic"],
    "differential-review":  ["blast radius", "diff PR", "seguridad en diff"],
    "sharp-edges":          ["APIs peligrosas", "footguns", "secure by default"],
    "insecure-defaults":    ["secrets", "defaults inseguros", "fail-open"],
    "second-opinion":       ["segunda opinión", "Codex review", "Gemini review"],
    "mutation-testing":     ["calidad de test", "mutation", "robustez de tests"],
    "property-based-testing": ["property-based", "hypothesis", "fast-check", "fuzzing"],
    "variant-analysis":     ["bug variants", "patrón de vulnerabilidad", "Semgrep"],
    "webapp-testing":       ["E2E", "Playwright", "testing UI", "test web app"],
    "frontend-design":      ["UI con código", "componentes", "estilos", "frontend"],
    "ui-ux-pro-max":        ["auditoría visual", "UX critique", "accessibility"],
    "material-3-expert":    ["Material You", "diseño Google", "UI moderna"],
    "theme-factory":        ["tema visual", "paleta HTML", "colores en artifact"],
    "performance-profiler": ["rendimiento", "profiling", "bottleneck", "framerate"],
    "tech-debt-tracker":    ["deuda técnica", "refactor planificado"],
    "focused-fix":          ["reparar feature", "módulo con fallos", "cascada"],
    "api-design-reviewer":  ["revisar API REST", "breaking changes", "versionado"],
    "database-schema-designer": ["schema DB", "Supabase", "RLS", "migrations"],
    "audit-context-building":   ["análisis profundo", "context building", "arquitectura interna"],
    "trailmark":            ["graph de llamadas", "blast radius", "entry points", "call chain"],
    "shannon":              ["pentest", "auditoría seguridad", "vulnerabilidades"],
    "supply-chain-risk-auditor": ["supply chain", "paquete malicioso", "npm audit", "CVE"],
    "ask-questions-first":  ["requisitos ambiguos", "dirección no clara"],
    "spec-to-code-compliance": ["cumple la spec", "verifica implementación"],
    "modern-python":        ["Python moderno", "uv", "ruff", "ty", "pytest"],
    "antivibe":             ["log de decisiones", "arquitectura why", "anti-vibe"],
    "developer-first":      ["NestJS", "React", "Tailwind", "dev-first"],
    "hyperframes":          ["video", "animación", "GSAP", "heygen"],
    "everything-claude-code":   ["optimización memoria", "seguridad codebase"],
    "claude-skills":        ["arquitectura general", "cumplimiento", "SOC2"],
    "dimensional-analysis": ["unidades de medida", "fórmulas con errores", "bug de física"],
    "unreal-engine":       ["UE C++ avanzado", "subsistemas UE", "API underdocumented"],
    "code-review-excellence": ["code review", "auditoría de código"],
    "security-review":      ["security review", "auditoría seguridad", "CVE", "SAST"],
    "second-opinion":       ["segunda opinión", "review externo"],
}

# ── Memory policy phrases ─────────────────────────────────────────────────────
_MEMORY_POLICY_TEXT: dict[str, str] = {
    "full-on-execution": "L0+L1+L3 (full SKILL.md loaded every execution)",
    "full-on-audit":     "L1+L2+L3 (full file loaded only during audit/review)",
    "snippet-first":     "L0+L1+L2 snippets (full file only if task demands)",
    "summary-only":      "L0+digest (never load full SKILL.md in normal use)",
}

# ── Expensive dependencies per skill ─────────────────────────────────────────
_EXPENSIVE_DEPS: dict[str, list[str]] = {
    "senior-engineer":      ["superpowers (TDD/debug)", "second-opinion (L4 if Codex)"],
    "gamedev-engineer":     ["senior-engineer (C++ impl)", "unreal-engine"],
    "ui-designer":          ["frontend-design (impl)", "webapp-testing (Playwright)"],
    "repo-evaluator":       ["differential-review", "sharp-edges", "insecure-defaults"],
    "audit-context-building": ["brain_index (FTS5)", "Gemini long context (L4)"],
    "ultron":               ["Codex CLI (dual/triple)", "Gemini MCP (L4)", "all personas"],
    "shannon":              ["Codex sandbox", "variant-analysis"],
}


def _load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        try:
            return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"skills": {}}


def _read_skill_purpose(name: str) -> str:
    """Extract first non-empty, non-header line from SKILL.md as purpose."""
    skill_md = SKILLS_DIR / name / "SKILL.md"
    if not skill_md.exists():
        return ""
    try:
        for line in skill_md.read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and len(stripped) > 15:
                return stripped[:200]
    except OSError:
        pass
    return ""


def _generate_digest(name: str, entry: dict) -> dict:
    """Build a canonical digest from manifest entry + lookup tables."""
    category   = entry.get("category", "misc")
    authority  = entry.get("authority", "utility")
    mode_cap   = entry.get("mode_cap", "MEDIUM")
    read_policy = entry.get("read_policy", "snippet-first")
    memory_layer = entry.get("memory_layer", "L1")
    token_est  = entry.get("estimated_token_cost", 1000)
    route_edges = entry.get("route_edges", [])
    sync_group = entry.get("sync_group", "community")

    triggers = _TRIGGERS.get(name, [])
    expensive = _EXPENSIVE_DEPS.get(name, [])
    memory_text = _MEMORY_POLICY_TEXT.get(read_policy, read_policy)

    # Try to read a one-line purpose from SKILL.md
    purpose = _read_skill_purpose(name)
    if not purpose:
        purpose = f"{category} {authority} — {', '.join(triggers[:3]) or 'general use'}"

    top_routes = [e["to"] for e in route_edges if e.get("strength") == "primary"][:4]
    if not top_routes and route_edges:
        top_routes = [e["to"] for e in route_edges[:3]]

    digest = {
        "name":             name,
        "category":         category,
        "authority":        authority,
        "mode_cap":         mode_cap,
        "sync_group":       sync_group,
        "purpose":          purpose,
        "triggers":         triggers[:6],
        "memory_policy":    memory_text,
        "memory_layer":     memory_layer,
        "expensive_deps":   expensive,
        "primary_routes":   top_routes,
        "token_estimate":   token_est,
        "read_policy":      read_policy,
        "generated_at":     datetime.now().isoformat(),
    }
    return digest


def cmd_build(_args) -> int:
    manifest = _load_manifest()
    skills = manifest.get("skills", {})
    if not skills:
        print("[summarizer] Empty manifest. Run: skill_manifest.py rebuild  first.")
        return 1

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    built = 0
    skipped = 0

    for name, entry in sorted(skills.items()):
        if entry.get("status") == "ghost":
            skipped += 1
            continue
        digest = _generate_digest(name, entry)
        out = CACHE_DIR / f"{name}.json"
        out.write_text(json.dumps(digest, indent=2, ensure_ascii=False), encoding="utf-8")
        built += 1

    print(f"[summarizer] Built {built} digests  ({skipped} ghost skipped)")
    print(f"             Cache dir: {CACHE_DIR}")
    return 0


def cmd_show(args) -> int:
    name = args.name
    cache_file = CACHE_DIR / f"{name}.json"
    if cache_file.exists():
        print(cache_file.read_text(encoding="utf-8"))
        return 0
    # Generate on the fly
    manifest = _load_manifest()
    entry = manifest.get("skills", {}).get(name)
    if not entry:
        print(f"[summarizer] {name!r} not in manifest")
        return 1
    digest = _generate_digest(name, entry)
    print(json.dumps(digest, indent=2, ensure_ascii=False))
    return 0


def cmd_validate(_args) -> int:
    """Verify all Tier A personas have digests and required fields."""
    missing_digest = []
    missing_fields = []
    required = {"purpose", "authority", "mode_cap", "memory_policy", "triggers"}

    for name in sorted(TIER_A):
        cache_file = CACHE_DIR / f"{name}.json"
        if not cache_file.exists():
            missing_digest.append(name)
            continue
        try:
            digest = json.loads(cache_file.read_text(encoding="utf-8"))
            absent = required - set(digest.keys())
            if absent:
                missing_fields.append((name, sorted(absent)))
        except (json.JSONDecodeError, OSError):
            missing_digest.append(name)

    if missing_digest:
        print(f"[validate] Missing digests ({len(missing_digest)}): {', '.join(missing_digest)}")
        print("           Run: skill_summarizer.py build")
    if missing_fields:
        for n, fields in missing_fields:
            print(f"[validate] {n}: missing fields {fields}")
    if not missing_digest and not missing_fields:
        print(f"[validate] All {len(TIER_A)} Tier A personas have complete digests.")
    return 1 if (missing_digest or missing_fields) else 0


def main() -> int:
    import argparse
    p = argparse.ArgumentParser(description="ULTRON v12.4 Skill Summarizer")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build", help="Generate digests for all active skills")
    sp = sub.add_parser("show", help="Print digest for a named skill")
    sp.add_argument("name")
    sub.add_parser("validate", help="Check all Tier A personas have complete digests")
    args = p.parse_args()
    if args.cmd == "build":    return cmd_build(args)
    if args.cmd == "show":     return cmd_show(args)
    if args.cmd == "validate": return cmd_validate(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
