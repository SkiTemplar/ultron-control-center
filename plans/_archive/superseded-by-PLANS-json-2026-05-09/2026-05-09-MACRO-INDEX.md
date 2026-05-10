---
title: ULTRON Macro Roadmap — INDEX
date: 2026-05-09
status: PLAN-AUTHORITATIVE — entry point
versioning_shift: 2026-05-08 — +2 minor shift applied. v14.2/v14.3 ya consumed por work no-roadmap (news-reduction + Hiper Plans). Macro plan re-mapeado a v14.4 / v14.5 / v14.6 / v15.0.
---

# ULTRON Macro Roadmap — INDEX

> **Entrada principal al plan macro.** Lee este primero al despertar.

> **VERSIONING NOTE (2026-05-08):** Los docs internos de este macro plan
> referencian sprints como v14.2 / v14.3 / v14.4 / v15.0 (numbering original
> 2026-05-09). En realidad arrancamos con +2 minor shift porque v14.2 y v14.3
> ya quedaron tomados por work fuera del roadmap (news-reduction commit
> dcd9f5e + Hiper Plans commit fc5c46a). **Mapping efectivo:**
>
> | Sprint en docs | Versión real |
> |---|---|
> | v14.2 TOKEN HUNTER | **v14.4 TOKEN HUNTER** |
> | v14.3 META-PROMPTER | **v14.5 META-PROMPTER** |
> | v14.4 PERFECT MEMORY | **v14.6 PERFECT MEMORY** |
> | v15.0 ULTRON.io | **v15.0 ULTRON.io** (sin cambio) |
>
> El contenido del plan no cambia, solo la etiqueta de versión final que
> entra en changelog. Cuando los docs internos digan "v14.2" leer "v14.4".

## Los 4 documentos del macro plan

| # | Archivo | Propósito | Tamaño aprox |
|---|---|---|---|
| 1 | `2026-05-09-MACRO-roadmap-v14.2-to-v15.0.md` | **Plan estratégico**. 4 sprints × 5 fases. Acceptance criteria, dependencies, métricas. | ~1100 líneas |
| 2 | `2026-05-09-MACRO-ops-manual.md` | **Manual de operaciones**. Test cases enumerados (137 nuevos), cleanup checklists, sync entre sprints, daily standup template. | ~1000 líneas |
| 3 | `2026-05-09-MACRO-brainstorm-and-risks.md` | **Brainstorm + riesgos**. Alternativas evaluadas (incl. rejected), risk register pre-poblado (15 risks), decision log inicial (7 decisions). | ~600 líneas |
| 4 | `2026-05-09-MACRO-execution-prompts.md` | **Prompts ready-to-fork**. Cada fase tiene su prompt exacto para sub-agente (DEV/TEST/QA/REV/RESOLVED). | ~900 líneas |

## Cómo usar (pickup pattern)

### Día 1 al despertar

1. Lee `MASTER.md` (entry point único, estado consolidado de todos los sprints)
2. Si necesitas detalle táctico: lee este INDEX para localizar el doc relevante
3. Decide qué sprint atacar (v14.6 PERFECT MEMORY pendiente Qdrant decision, v15.0 ULTRON.io paralelo)
4. Spec por sprint en doc #1; test cases en doc #2; alternativas en doc #3; prompts ready-to-fork en doc #4

### Durante un sprint

- Spec autoritativa: doc #1
- Tests a implementar: doc #2 CAPÍTULO 2
- Alternativas si bloqueas: doc #3 CAPÍTULO 1
- Prompts para forks: doc #4

### Al cerrar un sprint

- DoD checklist: doc #2 CAPÍTULO 10
- Documentor prompt: doc #4 sección "Documentor (genérico)"
- Update métricas: ~/.ultron/metrics/sprint-<X>-post.json
- Commit + tag

## Resumen ultra-corto del roadmap (post +2 shift)

```
v14.4 TOKEN HUNTER       (8.5 días)  → -50% tokens/sesión
v14.5 META-PROMPTER      (7 días)    → prompts auto-mejorados
v14.6 PERFECT MEMORY     (10 días)   → Qdrant + embeddings + hybrid
v15.0 ULTRON.io          (10 días)   → web pública profesional ES

Total: ~33 días calendar / ~5 semanas si trabajas casi diario.
```

## Sprint progress tracker (live)

| Sprint | Phase | Status | Commit |
|---|---|---|---|
| **v14.4 TOKEN HUNTER** | Phase 0 — Baseline measurement | ✅ DONE | `8cb89d2` |
| | Phase 1 — Lazy skill listing | ✅ DONE — 20,326 tok saved (84%) | `591a859` |
| | Phase 2 — Prompt cache audit | ✅ DONE — 96.6% hit rate verified, D24 instrumented | `0520f9b` |
| | Phase 3 — MEMORY.md dedup | ✅ DONE — 1,135 tok saved (53.4%), MEMORY.md 990 tok in budget | `2ddbb29` |
| | Phase 4 — Tool description trim | ✅ DONE — 2,356 tok saved (SKILL 1,858 + CLAUDE proj 498) | `7bdc4ef` |
| | Phase 5 — D22+D24 wiring + smoke + changelog | ✅ DONE — sprint RESOLVED, total saved 23,817 tok | `72f5915` |
| v14.5 META-PROMPTER | — | ✅ RESOLVED — 4 modules + 1 hook + CLI dispatcher + 19 tests | `1396da5` |
| v14.6 PERFECT MEMORY | — | ✅ RESOLVED — Qdrant Docker + MPNet + hybrid retriever (BM25+vec RRF) | `ec48b94` |
| v14.7 BACKUP-WATCH | — | ✅ RESOLVED — weekly robocopy + D25 detector + Task Scheduler | `f1b3e82` |
| v14.8 ULTRA POLISH | — | ✅ RESOLVED — auto-recall + embed_skills + cross-encoder + TUI Recall + D22 fix | `b6c52e1` |
| v15.0 ULTRON.io | — | ⬜ NEXT — web pública profesional ES (10 días) | — |

**Baseline snapshot (pre-v14.4):** `~/.ultron/metrics/baseline-pre-v14.4.json`
- 9,972 tokens total
- context_md=478 · MEMORY_md=2125 · claude_md_global=763 · skill_listing=6606 · tool_descriptions=0
- 2 blocks OVER budget: context_md (478>400 marginal) · MEMORY_md (2125>1000 — Phase 3 target)

## Filosofía global (3 reglas inalterables)

1. **No custom ML training.** Modelos pre-entrenados aplicados quirúrgicamente.
2. **No auto-laundering.** Todo merge/deploy/install requiere REV humano.
3. **Atomic + backup-before-destroy.** Toda operación riesgosa tiene rollback.

## Decisiones que necesitas tomar antes de v14.4

- D-MCP-3 sub-A: Docker local o Qdrant Cloud (default Docker)
- D-MCP-3 sub-B: embedding model local vs API (default local MiniLM)

## Decisiones diferidas hasta más tarde

- v15.0 open-source: defer to Phase 4 (default privado)
- v15.X Windows-MCP: defer al post-roadmap (default no install)

## Riesgos críticos (pre-mitigados)

| Risk | Sprint | Mitigation |
|---|---|---|
| Lazy listing rompe dispatcher | v14.2 P1 | Golden set 50 queries + auto-fallback |
| Cache breakpoint mal puesto | v14.2 P2 | Mock test antes de prod |
| Qdrant install bloquea | v14.4 P0 | Path A + Path B documentados |
| Embedding ES quality | v14.4 P1 | Golden set 50 ES queries + swap a MPNet si falla |
| LLM-as-judge bias | v14.3 P4 | Length-neutrality test obligatorio |
| Web scope creep → SaaS | v15.0 P0 | Timebox 1.5 sem, "es showcase NO producto" |

Lista completa: doc #3 CAPÍTULO 2.

## Pre-condiciones que necesitas verificar al arrancar

```powershell
# Pre-flight checklist (5 min)
ultron status                        # baseline state
git log -3 --oneline                 # últimos commits del sprint anterior
uv run pytest tests/ -q              # 622 green
ultron doctor --quiet --json         # 0 blocking
ultron deadwood --quiet              # exit 0 o 1, NO 2
```

## Métricas baseline a snapshot

Snapshot AHORA (antes del primer sprint) en
`~/.ultron/metrics/baseline-pre-v14.2.json`. Lista en doc #3 CAPÍTULO 4.

## Cuándo este plan se vuelve obsoleto

- Si v14.2 falla en target → re-evaluar antes de v14.3
- Si USER cambia prioridades → replanning session
- Si > 3 risks materializaron simultáneamente → re-evaluar plan

---

— INDEX entry point. Saved 2026-05-09. Updated whenever any of the
4 docs cambia status.
