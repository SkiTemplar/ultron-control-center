#!/usr/bin/env python3
"""
ULTRON SKILL DISCOVERY · v1.1
Detecta skills instaladas que no están mapeadas en FAST PATH Layer 1 o Layer 2.
Automatiza: protocols.md § AUTO-MEJORA / SKILL DISCOVERY

Uso:
    python scripts/skill-discovery.py
    python scripts/skill-discovery.py --verbose   (muestra también las skills OK)

Lógica de namespaces:
    Skills bajo plugins/ se cualifican como parent:name cuando el directorio padre
    es un namespace conocido (superpowers, pr-review-toolkit, etc.) — así se reconocen
    como cubiertas por el wildcard superpowers:* / pr-review-toolkit:* de Layer 2.
"""
import sys
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

HOME = Path.home()
SKILLS_DIR = HOME / ".claude" / "skills"
PLUGINS_DIR = HOME / ".claude" / "plugins"

VERBOSE = "--verbose" in sys.argv or "-v" in sys.argv

# ── Skills mapeadas ───────────────────────────────────────────────────────────

LAYER0_META = {
    "ultron", "skill-creator", "consolidate-memory", "mcp-builder",
}

LAYER1_PERSONAS = {
    "senior-engineer", "gamedev-engineer", "ui-designer", "business-strategist",
    "research-explainer", "windows-admin", "repo-evaluator",
}

LAYER2_PLUGINS = {
    "superpowers", "pr-review-toolkit", "feature-dev", "context7",
    "performance-profiler", "tech-debt-tracker", "focused-fix",
    "api-design-reviewer", "database-schema-designer", "ui-ux-pro-max",
    "differential-review", "sharp-edges", "insecure-defaults", "modern-python",
    "hookify", "frontend-design", "webapp-testing", "ask-questions-first",
    "variant-analysis", "property-based-testing", "mutation-testing",
    "spec-to-code-compliance", "second-opinion", "theme-factory",
}

# Skills del sistema / externas que no pertenecen a ULTRON
SYSTEM_SKILLS = {
    # CC built-in / SDK
    "using-superpowers", "init", "review", "security-review",
    "claude-code-setup", "commit-commands", "keybindings-help",
    "update-config", "simplify", "fewer-permission-prompts", "loop", "schedule",
    "claude-api", "statusline-setup",
    # Plugin-dev y marketplace tools (no en FAST PATH de ULTRON)
    "agent-development", "command-development", "hook-development",
    "mcp-integration", "plugin-settings", "plugin-structure", "skill-development",
    "build-mcp-app", "build-mcp-server", "build-mcpb",
    "example-command", "example-skill",
    "math-olympiad", "playground", "session-report",
    "claude-md-improver", "claude-automation-recommender", "claude-opus-4-5-migration",
    # Mensajería (discord/imessage/telegram sub-skills)
    "access", "configure",
    # SuperClaude framework (framework distinto a ULTRON)
    "brainstorm", "confidence-check", "deep-research", "pm",
    "token-efficiency", "troubleshoot",
}

# Namespaces de plugins — cualquier sub-skill bajo estos se considera cubierta
# por el wildcard Layer 2 (ej: superpowers:systematic-debugging → superpowers:*)
PLUGIN_NAMESPACES = LAYER2_PLUGINS | LAYER0_META


def _find_plugin_namespace(skill_dir: Path) -> str | None:
    """
    Busca el namespace del plugin para una skill en plugins/.
    Estrategia: busca un directorio 'skills' en los ancestros; el directorio
    inmediatamente superior es el namespace del plugin (o versión, que tiene
    el plugin como padre).

    Estructura real:  .../{plugin}/{version}/skills/{skill}/SKILL.md
                      .../{plugin}/skills/{skill}/SKILL.md        (sin versión)
                      .../{category}/plugins/{plugin}/skills/{skill}/SKILL.md

    Retorna el nombre del namespace si está en PLUGIN_NAMESPACES, o None.
    """
    parts = skill_dir.parts
    # Buscar índice de 'skills' más cercano al final
    for i in range(len(parts) - 1, 0, -1):
        if parts[i] == "skills":
            # El directorio encima de 'skills' suele ser la versión o el plugin
            above_skills = parts[i - 1]
            above_above = parts[i - 2] if i >= 2 else None

            # Caso: .../superpowers/5.0.7/skills/... → encima es "5.0.7", subir uno más
            if above_skills not in PLUGIN_NAMESPACES and above_above and above_above in PLUGIN_NAMESPACES:
                return above_above
            if above_skills in PLUGIN_NAMESPACES:
                return above_skills
            # No reconocido: no cualificar
            return None
    return None


def collect_installed() -> dict[str, Path]:
    """
    Recoge todas las skills instaladas.

    Para sub-skills dentro de un namespace conocido (ej: superpowers/.../skills/systematic-debugging/),
    el nombre se cualifica como 'namespace:subskill' para que classify() reconozca
    la cobertura por wildcard Layer 2.
    """
    found: dict[str, Path] = {}

    if SKILLS_DIR.exists():
        for p in SKILLS_DIR.iterdir():
            if p.is_dir() and (p / "SKILL.md").exists():
                found[p.name] = p

    if PLUGINS_DIR.exists():
        for skill_md in PLUGINS_DIR.rglob("SKILL.md"):
            skill_dir = skill_md.parent
            name = skill_dir.name
            namespace = _find_plugin_namespace(skill_dir)

            if namespace:
                qualified = f"{namespace}:{name}"
                if qualified not in found:
                    found[qualified] = skill_dir
            else:
                if name not in found:
                    found[name] = skill_dir

    return found


def classify(name: str) -> tuple[str, str]:
    """Devuelve (símbolo, etiqueta) para una skill."""
    base = name.split(":")[0]  # namespace de plugin:subskill

    if name == "ultron":
        return "⭐", "L0 META — el orquestador"
    if base in LAYER0_META:
        return "🔵", "L0 META"
    if name in LAYER1_PERSONAS or base in LAYER1_PERSONAS:
        return "✅", "L1 PERSONA — en FAST PATH"
    if base in LAYER2_PLUGINS:
        # Sub-skill de plugin conocido (cubierta por wildcard plugin:*)
        sub = name.split(":", 1)[1] if ":" in name else None
        label = f"L2 PLUGIN — {base}:* cubre {sub}" if sub else "L2 PLUGIN — en FAST PATH"
        return "✅", label
    if name in SYSTEM_SKILLS or base in SYSTEM_SKILLS:
        return "⚙️ ", "Sistema / Externo — no ULTRON"
    return "⚠️ ", "SIN MAPEAR"


def main():
    installed = collect_installed()

    if not installed:
        print("⚠️  No se encontraron skills instaladas en ~/.claude/skills/ ni ~/.claude/plugins/")
        sys.exit(0)

    print(f"\n{'='*70}")
    print(f"ULTRON SKILL DISCOVERY · v1.1 · {len(installed)} skills encontradas")
    print(f"{'='*70}\n")

    unmapped = []
    counts = {"L0": 0, "L1": 0, "L2": 0, "SYS": 0, "UNMAPPED": 0}

    for name in sorted(installed):
        symbol, label = classify(name)
        is_unmapped = "SIN MAPEAR" in label

        if is_unmapped:
            unmapped.append(name)
            counts["UNMAPPED"] += 1
            print(f"{symbol}  {name:<45} {label}")
        else:
            if "L0" in label:
                counts["L0"] += 1
            elif "L1" in label:
                counts["L1"] += 1
            elif "L2" in label:
                counts["L2"] += 1
            else:
                counts["SYS"] += 1

            if VERBOSE:
                print(f"{symbol}  {name:<45} {label}")

    if not VERBOSE and not unmapped:
        # Mostrar resumen compacto si todo está OK
        for name in sorted(installed):
            symbol, label = classify(name)
            print(f"{symbol}  {name:<45} {label}")

    print(f"\n{'='*70}")
    print(f"RESUMEN: L0={counts['L0']} · L1={counts['L1']} · L2={counts['L2']} · SYS={counts['SYS']} · SIN MAPEAR={counts['UNMAPPED']}")

    if unmapped:
        print(f"\n⚠️  {len(unmapped)} skills SIN MAPEAR — ¿nueva persona o plugin a integrar?:\n")
        for s in unmapped:
            print(f"   {s}")
            print(f"   → ¿Persona nueva?  → Layer 1 + routing-matrix.md + mode-high.md")
            print(f"   → ¿Plugin nuevo?   → Layer 2 con señal trigger en SKILL.md\n")
        print("→ Protocolo: protocols.md § AUTO-MEJORA / SKILL DISCOVERY")
        sys.exit(1)
    else:
        print("✅ Todas las skills instaladas están mapeadas en FAST PATH.")
        sys.exit(0)


if __name__ == "__main__":
    main()
