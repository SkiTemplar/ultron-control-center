# Botón 2 — Skill Network (Ultra Triple)

```
Ultron, /ultra /triple — Kirkardo SKILL-NETWORK Triple.

OBJETIVO:
  Auditar el routing skill ↔ persona ↔ plugin de ULTRON según la versión vigente:
  cobertura, colisiones, SSOT, drift entre registries y rutas muertas.

FASE 1 — CLAUDE lee:
  - ~/.claude/skills/ultron/SKILL.md
  - ~/.claude/skills/ultron/references/routing-tables.md
  - ~/.claude/skills/ultron/references/flag-routing.md
  - ~/.claude/skills/ultron/references/skill-alignments.md
  - ~/.claude/skills/ultron/references/skills-loading-protocol.md
  - ~/.claude/skills/ultron/agents/subagent-routing.md
  - ~/.claude/skills/ultron/scripts/cockpit/registry_sync.py
  - ~/.claude/skills/ultron/scripts/cockpit/skill_manifest.py
  - ~/.claude/skills/ultron/scripts/cockpit/routing_decide.py
  - ~/.claude/skills/ultron/scripts/cockpit/route_quality.py
  - ~/.claude/skills/ultron/scripts/cockpit/route_quality_aggregator.py
  - ~/.ultron/skill_manifest.json
  - ~/.ultron/skill_cache/route_quality.json (si existe)

FASE 2 — CODEX peer (--sandbox read-only):
  - Medir cardinalidad real: personas L1, plugins L2, registries Claude/Codex/Agents.
  - Detectar drift entre SKILL.md, routing-tables.md, skill_manifest.json y registries instaladas.
  - Revisar tiebreaks del FAST PATH: determinismo, colisiones y señales ambiguas.
  - Revisar Persona+Plugin pairs contra route_quality data disponible.
  - Revisar registry_sync y skill_manifest: validación de registries, checksums, status active/synced.
  - Reportar rutas muertas, skills huérfanas y skills instaladas nunca routeadas.
  - Devolver issues P0/P1/P2 con archivo:línea.

FASE 3 — GEMINI peer (sin filesystem; internet actual):
  - Comparar patrones actuales de subagents/routing.
  - Evaluar marketplaces/directorios de skills y agentes: gaps que ULTRON debería cubrir.
  - Buenas prácticas de confidence-based routing y fallback explícito.
  - Skills/tooling trending que merezcan discovery, no instalación automática.

FASE 4 — INTEGRACIÓN (Claude):
  - Grafo de conexiones ASCII o Mermaid.
  - Nota Kirkardo SKILL-NETWORK X/10.
  - TOP 3 FIX routing con archivo:línea.
  - TOP 5 FEAT: conexiones, checks, skills a evaluar.
  - Lista de skills huérfanas: instaladas, activas, nunca routeadas.
  - Inconsistencias de conteo reales extraídas, sin usar cifras hardcodeadas.

OUTPUT:
  - ~/.ultron/cockpit/audits/kirkardo-skill-network-{TODAY}.md
  - ~/.ultron/cockpit/audits/kirkardo-skill-network-nota-{TODAY}.md (≤20 líneas)
```
