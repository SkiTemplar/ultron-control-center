# Botón 1 — Memoria (Ultra Triple)

```
Ultron, /ultra /triple — Kirkardo MEMORIA Triple.

OBJETIVO:
  Auditar la memoria L1/L2/L3 de ULTRON según la versión vigente declarada en
  ~/.claude/skills/ultron/SKILL.md y CLAUDE.md: frescura, recuperación,
  compactación, sincronización y riesgos de pérdida de contexto.

FASE 1 — CLAUDE lee:
  - ~/.claude/skills/ultron/CLAUDE.md
  - ~/.claude/skills/ultron/SKILL.md
  - ~/.claude/skills/ultron/memory.md
  - ~/.ultron/INDEX.md
  - ~/.ultron/brain_index/index.db (solo schema/stats; no dump completo)
  - ~/.ultron-vault/00_INDEX/MOC.md
  - ~/.ultron-vault/CC-memories/ (listado + muestra mínima)
  - ~/.claude/skills/ultron/scripts/cockpit/brain_index.py
  - ~/.claude/skills/ultron/scripts/cockpit/brain_config.py
  - ~/.claude/skills/ultron/scripts/cockpit/memory_sync.py
  - ~/.claude/skills/ultron/scripts/cockpit/decay_queue.py
  - ~/.claude/skills/ultron/scripts/cockpit/session_compactor.py
  - ~/.claude/skills/ultron/scripts/cockpit/memory_bridge.py
  - ~/.ultron/.tmp/current-session.json

FASE 2 — CODEX peer (--sandbox read-only):
  - Validar si FTS5 schema + BM25 weights siguen adecuados al volumen real.
  - Revisar decay_queue scoring: defaults, criticality, notas sin frontmatter.
  - Revisar si session_compactor pierde contexto al destilar transcript → vault note + JSONL.
  - Revisar memory_bridge: ciclos, huérfanos, duplicados y wikilink repair.
  - Revisar memory_sync push-async/push-queue: races con varias sesiones HIGH+.
  - Devolver issues P0/P1/P2 con archivo:línea.

FASE 3 — GEMINI peer (sin filesystem; internet actual):
  - Comparar L1/L2/L3 contra patrones actuales de memoria agentic.
  - Evaluar RAG vs FTS5 vs híbrido para vault local.
  - Evaluar Obsidian vault como L2 local.
  - Identificar patrones actuales de memory consolidation aplicables a ULTRON.

FASE 4 — INTEGRACIÓN (Claude):
  - Nota Kirkardo MEMORIA X/10.
  - TOP 3 FIX con script:línea y razón.
  - TOP 5 FEAT roadmap memoria.
  - Decisión: patch de mantenimiento vs minor si cambia arquitectura.
  - Resumen ejecutivo ≤20 líneas.

OUTPUT:
  - ~/.ultron/cockpit/audits/kirkardo-memoria-{TODAY}.md
  - ~/.ultron/cockpit/audits/kirkardo-memoria-nota-{TODAY}.md (≤20 líneas)
```
