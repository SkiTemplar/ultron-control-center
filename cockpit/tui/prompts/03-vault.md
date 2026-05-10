# Botón 3 — Vault (Ultra Triple)

```
Ultron, /ultra /triple — Kirkardo VAULT Triple.

OBJETIVO:
  Auditar la calidad estructural, semántica y operativa del Obsidian vault L2 de
  ULTRON según la versión vigente.

FASE 1 — CLAUDE lee/lista:
  - ~/.claude/skills/ultron/CLAUDE.md
  - ~/.claude/skills/ultron/SKILL.md
  - ~/.ultron-vault/00_INDEX/MOC.md
  - ~/.ultron-vault/10_KNOWLEDGE/ (listado completo + 1 muestra por dominio)
  - ~/.ultron-vault/20_DECISIONS/ (últimas 10)
  - ~/.ultron-vault/30_PATTERNS/ (índice)
  - ~/.ultron-vault/CC-memories/ (listado actual)
  - ~/.claude/skills/ultron/scripts/cockpit/vault_migrator.py
  - ~/.claude/skills/ultron/scripts/cockpit/frontmatter_backfill.py
  - ~/.claude/skills/ultron/scripts/cockpit/memory_bridge.py
  - ~/.claude/skills/ultron/scripts/cockpit/brain_index.py
  - git remote real de ~/.ultron-vault/ si aplica

MÉTRICAS A EXTRAER:
  - Total notas .md.
  - % notas con frontmatter mínimo: name/type/tags/criticality.
  - % wikilinks rotos y huérfanos.
  - Duplicados probables por título/slug.
  - Dominios densos vs thin.

FASE 2 — CODEX peer (--sandbox read-only):
  - Taxonomía 00/10/20/30: coherencia, solape y carpetas sin dueño.
  - vault_migrator: migrations backwards-compatible y seguras.
  - frontmatter_backfill: cobertura, defaults y riesgo de sobrescritura.
  - memory_bridge: consistencia CC-memories ↔ vault.
  - L3 remote: riesgo de secrets accidentales y archivos que no deberían sincronizarse.
  - Devolver TOP issues P0/P1/P2 con archivo:línea.

FASE 3 — GEMINI peer (sin filesystem; internet actual):
  - Comparar contra patrones actuales de knowledge vaults locales.
  - Evaluar PARA / Zettelkasten / Johnny Decimal para el caso real de ULTRON.
  - Plugins Obsidian relevantes para conexión semántica y mantenimiento.
  - Vector embeddings sobre vault: ROI, coste y complejidad.

FASE 4 — INTEGRACIÓN (Claude):
  - Mapa de calor del vault: dominios densos vs thin.
  - Nota Kirkardo VAULT X/10.
  - TOP 3 FIX: links rotos, frontmatter, duplicados, secrets o taxonomía.
  - TOP 5 FEAT: reorg, embeddings, nuevos dominios, validadores.
  - Resumen ejecutivo ≤20 líneas.

OUTPUT:
  - ~/.ultron/cockpit/audits/kirkardo-vault-{TODAY}.md
  - ~/.ultron/cockpit/audits/kirkardo-vault-nota-{TODAY}.md (≤20 líneas)
```
