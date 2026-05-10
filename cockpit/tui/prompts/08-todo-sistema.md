# Botón 8 — Todo el sistema (MaxTriple)

```
Ultron, /ultra /maxtriple --rounds=5 — Kirkardo TOTAL MaxTriple.

OBJETIVO:
  Auditoría holística cross-layer de ULTRON según la versión vigente.
  Ejecutar los 7 audits temáticos previos como referencia read-only y sintetizar
  dependencias, contradicciones, riesgos y roadmap.

REGLA DE COSTE:
  - MaxTriple consume el soft cap del día. Confirmar con USER antes de ejecutar.
  - No aplicar cambios. Solo auditar, priorizar y proponer.

ESTRATEGIA:
  - Phase 0: Claude prepara inventario global read-only desde CLAUDE.md, SKILL.md,
    protocols.md, scripts/cockpit/, hooks, vault, memoria y audits previos.
  - Phase 1: lanzar o reutilizar los 7 audits temáticos:
      memoria · skill-network · vault · hooks · cockpit · self-improve · personas
  - Phase 2: CODEX peer (--sandbox read-only) recibe los 7 reports y busca
    contradicciones cross-axis.
  - Phase 3: GEMINI peer (sin filesystem; internet actual) evalúa ULTRON contra
    patrones actuales de sistemas agentic locales.
  - Phase 4: Claude sintetiza UN plan unificado patch/minor/ARCH.

FASE 4 — ENTREGABLES:
  - Nota Kirkardo GLOBAL X/10 (media ponderada de los 7 + cross-cutting).
  - Matriz de dependencias entre los 7 dominios.
  - TOP 5 FIX críticos cross-system.
  - TOP 10 FEAT priorizados con RICE: reach, impact, confidence, effort.
  - Roadmap patch + minor/ARCH si cambia arquitectura.
  - Riesgos sistémicos y single points of failure.
  - Contradicciones entre reports y decisión de desempate.
  - Changelog entry consolidado propuesto, no aplicado.

OUTPUT:
  - ~/.ultron/cockpit/audits/kirkardo-total-{TODAY}.md
  - ~/.ultron/cockpit/audits/kirkardo-total-nota-{TODAY}.md (≤30 líneas)
  - ~/.ultron/cockpit/audits/kirkardo-total-matrix-{TODAY}.md

REGLAS:
  - Codex y Gemini son peers críticos read-only. Claude orquesta y decide.
  - No ejecutar fixes, no editar archivos, no commit, no push.
  - Bump sugerido: patch si fix/refactor; minor si cambia arquitectura o capacidad.
```
