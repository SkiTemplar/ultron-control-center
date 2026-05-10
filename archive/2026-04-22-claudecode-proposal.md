# Propuesta CC Migration — ARCHIVADO
**Fecha original:** 2026-04-18
**Archivado:** 2026-04-22 (Kirkardo post-cleanup)
**Fuente:** `global/claudecode_proposal.md`

---

## Estado de implementación al archivar

| Fase | Propuesta | Estado |
|------|-----------|--------|
| Fase 1 | Usar `TaskCreate` consistentemente | ✅ Implementado |
| Fase 1 | Usar subagentes nativos (Explore, Plan) cuando aplique | ✅ Implementado |
| Fase 2 | Migrar PROJECT.md de Tortunabo al auto-memory de CC | ✅ Implementado (nota en PROJECT.md lo confirma) |
| Fase 2 | Refinar `description:` de skills para auto-trigger | ✅ Parcial (ULTRON description mejorada) |
| Fase 3 | Hooks `Stop` y `SessionStart` en `.claude/settings.json` | ❌ No implementado — bajo ROI para el flujo actual |
| Fase 4 | Auto-benchmark vía script en hook | ❌ Descartado — benchmark manual es suficiente |
| Fase 4 | Migrar más knowledge a Context7 | ⚠️ Disponible pero no formalizado como regla |

## Decisión final
Las fases 1-2 están implementadas. Las fases 3-4 se descartan: los hooks tienen overhead de setup en Windows y el beneficio marginal no justifica el riesgo de romper el flujo. Context7 se usa ad-hoc cuando corresponde.

El contenido de valor de esta propuesta (decisión de hooks: descartar) está elevado a `global/decisions.md` si aplica.
