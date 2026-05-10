---
title: ULTRON Macro-Roadmap v14.2 → v15.0 — AI-driven execution plan
date: 2026-05-09
status: PLAN-AUTHORITATIVE (executable by AI subagents per phase)
authors: Claude (Opus 4.7) + USER
schema_version: 2
supersedes: 2026-05-09-roadmap-v14.2-to-v15.0.md
---

# ULTRON Macro-Roadmap — Genesis-14.1 → Public Showcase

> Este documento es el plan autoritativo para los próximos ~30 días de
> desarrollo de ULTRON. Cada sprint tiene sus 5 fases (DEV / TEST / QA /
> REV / RESOLVED), criterios de aceptación medibles, prompts listos para
> entregar a sub-agentes, alternativas evaluadas, y registros de decisión.
>
> **Diseñado para ejecución AI-driven**: cada fase incluye prompts y gates
> que un sub-agente puede consumir sin ambigüedad. El humano (USER) sólo
> bloquea/aprueba en gates marcados HUMAN-GATE.

---

## TABLA DE CONTENIDOS

```
PART I — Operating Manual (cómo funcionan las 5 fases)
PART II — Sprint v14.2 "TOKEN HUNTER"
PART III — Sprint v14.3 "META-PROMPTER"
PART IV — Sprint v14.4 "PERFECT MEMORY"
PART V — Sprint v15.0 "ULTRON.io"
PART VI — Global registros (decisión log, risk register, métricas)
PART VII — Anexos (prompts repetibles, plantillas)
```

---

# PART I — OPERATING MANUAL

## 5-Phase Flow

Cada feature/sprint pasa por 5 fases secuenciales:

```
       ┌────────┐    ┌────────┐    ┌────────┐    ┌────────┐    ┌────────────┐
START→ │  DEV   │ →  │  TEST  │ →  │   QA   │ →  │  REV   │ →  │  RESOLVED  │
       └────────┘    └────────┘    └────────┘    └────────┘    └────────────┘
        AI fork       AI fork       AI fork      HUMAN-GATE     AI bookkeep
       (writer)      (test-eng)    (reviewer)   (USER)      (closure)
```

### Phase 1 — DEV (Development)

**Owner:** sub-agent fork (writer / implementor)
**Goal:** producir código + docs que cumple la spec.
**Activities:**
- Lee la spec del sprint (este documento, sección correspondiente)
- Investiga si la spec lo manda (WebSearch, brain_index query)
- Implementa cambios siguiendo convenciones existentes
- Ejecuta smoke local antes de declarar DEV done

**Artifacts:**
- Diff de código (sin commit todavía)
- Notas de implementación (decisiones que se desviaron de la spec)
- Lista de tests pendientes para fase TEST

**Entry gate:**
- Spec del sprint está aprobada (status: PLAN-AUTHORITATIVE en este doc)
- Ramas o entornos previos no contaminan (`git status --short` está limpio
  excepto cambios pre-existentes documentados)

**Exit gate:**
- Smoke del módulo nuevo: corre sin tracebacks
- Diff revisado por el propio fork (self-review checklist)
- `git diff --stat` < 1500 líneas (si más, partir en sub-fases)

**Time budget típico:** 30 min - 4 h por fase DEV
**Falla → se hace:** bug-fix loop con un nuevo fork hasta que pase

### Phase 2 — TEST (Test engineering)

**Owner:** sub-agent fork (test engineer)
**Goal:** cubrir el código con tests automatizados que validen la spec.
**Activities:**
- Lee la spec + el diff de DEV
- Escribe tests pytest siguiendo el patrón `tests/test_*.py` existente
- Cubre: happy path, edge cases, error paths, regresiones conocidas
- Corre `uv run pytest` y confirma 100% verde
- Mide cobertura (opcional pero deseable)

**Artifacts:**
- Archivos `tests/test_<feature>.py` nuevos
- Reporte: # tests añadidos, # casos edge cubiertos, cobertura sobre el diff
- Lista de tests pendientes que QA pueda completar

**Entry gate:**
- DEV exit gate pasó
- Spec lista los acceptance criteria explícitamente

**Exit gate:**
- 100% tests verde (`uv run pytest tests/test_<feature>.py -q`)
- Suite global no regresa
- Cobertura ≥ 80% sobre el diff de DEV (medir si tienes `pytest-cov`;
  si no, justificar)

**Time budget típico:** 30 min - 2 h
**Falla → se hace:** vuelve a DEV con bug report del test que falló

### Phase 3 — QA (Quality audit)

**Owner:** sub-agent fork independiente (`agent-skills:code-reviewer`)
**Goal:** auditoría independiente — buscar bugs, smells, gaps.
**Activities:**
- Sin contexto del fork DEV (independencia)
- Revisa diff completo + tests
- Aplica los 7 dimensiones del review: corrección, robustez,
  seguridad, performance, tests, arquitectura, estilo/docs
- Devuelve findings clasificados: BLOCKING / HIGH / MEDIUM / LOW

**Artifacts:**
- Reporte markdown en `~/.ultron/audits/qa-<sprint>-<feature>-<date>.md`
- Tabla resumen de findings
- Top 3 most-actionable issues

**Entry gate:**
- TEST exit gate pasó

**Exit gate:**
- 0 BLOCKING (si hay → vuelve a DEV)
- HIGH ≤ 3 (si más → triage humano)
- Reporte escrito y persistido

**Time budget típico:** 15-45 min
**Falla → se hace:** los BLOCKING vuelven a DEV; HIGH se loguean en
risk register; MEDIUM/LOW se guardan en backlog

### Phase 4 — REV (Human review)

**Owner:** USER (HUMAN-GATE — único punto humano del flow)
**Goal:** decisión final go/no-go + sign-off.
**Activities (que el orchestrator presenta al usuario):**
- Resumen del sprint en ≤ 200 palabras
- Diff stats + cambios en files críticos
- Reporte de QA con findings restantes
- Métrica de impacto medida (si aplica)
- Decisiones tomadas durante la ejecución (decision log delta)

**Artifacts:**
- Aprobación explícita o lista de cambios solicitados
- Decision log entries firmadas

**Entry gate:**
- QA exit gate pasó

**Exit gate:**
- USER dice "merge" / "ship" / "aprobado"
- O USER lista cambios → vuelve a DEV/TEST/QA según necesario

**Time budget típico:** 5-30 min de USER
**Falla → se hace:** ciclo corto al fase apropiada con feedback

### Phase 5 — RESOLVED (Closure)

**Owner:** sub-agent fork (bookkeeper) o el orchestrator
**Goal:** cerrar el loop limpio + actualizar memoria.
**Activities:**
- Commit con mensaje siguiendo conventional commits
- Actualizar `references/changelog.md`
- Actualizar `MEMORY.md` si el cambio afecta numbers/state
- Actualizar `ULTRON-GENESIS-CAPABILITIES.md` si aplica
- Cerrar tasks en TaskList
- Mover findings a backlog si quedaron MEDIUM/LOW

**Artifacts:**
- Commit hash
- Changelog entry
- Memory entry (si aplica)
- Task closures

**Entry gate:**
- REV exit gate pasó

**Exit gate:**
- `git log --oneline -1` muestra el nuevo commit
- Suite full regression ≥ tests-anteriores + tests-nuevos
- Doctor report no degradado vs baseline pre-sprint

**Time budget típico:** 15-30 min
**Falla → se hace:** improbable; si falla, todo el flow se revisa

## Quality Bar (todas las fases)

| Dimensión | Mínimo aceptable |
|---|---|
| Test coverage | ≥ 80% sobre código nuevo |
| Test execution time | < 2 min para suite completa |
| Doctor BLOCKING tras merge | 0 |
| Doctor WARN tras merge | ≤ baseline + 5 |
| Documentación | Cada función pública con docstring de propósito |
| Comments | Sólo donde el "por qué" no es obvio |
| Type hints | Públicos siempre tipados; internos opcional |
| Atomic writes | Toda escritura a disco usa tmp+os.replace |
| Backups | Toda operación destructiva crea backup primero |

## Anti-laundering Rules

> "Anti-laundering" = el AI NUNCA aplica cambios que el humano no ha
> aprobado explícitamente. Estos guardrails son inalterables.

1. **No auto-merge.** Todo merge requiere REV humano.
2. **No auto-deploy.** No publicar nada (NPM, PyPI, web) sin REV.
3. **No auto-commit en main si afecta producción.** Cambios que afecten
   `~/.ultron/` o ejecutables: branch + revisión.
4. **No auto-disable security checks.** Si un check da false positive,
   se waive con justificación firmada en YAML, no se elimina.
5. **No auto-edit credentials.** Cualquier `.env`, `secrets-loader.ps1`,
   `skill-trust.yaml` requiere REV.
6. **No auto-delete con `--force`.** Toda eliminación destructiva
   genera backup primero (regla establecida en este sprint, ver
   `claude-code-workflows-2026-05-07.zip` como ejemplo).

## Risk Register Format

Cada riesgo identificado en cualquier fase se loggea aquí con esta forma:

```yaml
risk_id: R<NN>
sprint: v14.X
phase: DEV|TEST|QA|REV
title: <one-line>
likelihood: low|medium|high
impact: low|medium|high
mitigation: <how to reduce>
trigger: <what makes this fire>
owner: <fork-name or USER>
status: open|mitigated|accepted|closed
```

## Decision Log Format

```yaml
decision_id: D<NN>
sprint: v14.X
date: 2026-05-XX
question: <what was decided>
options_considered:
  - A: <description>
  - B: <description>
  - C: <description>
chosen: A|B|C
reason: <why>
decided_by: USER|claude|fork-name
reversibility: easy|medium|hard
review_after: <date or condition>
```

## Métricas globales (medir antes de cada sprint)

```python
# Métricas baseline al SessionStart
baseline = {
    "tests_total": 622,
    "tests_passing": 622,
    "doctor_blocking": 0,
    "doctor_warn": 170,
    "doctor_info": 0,
    "deadwood_findings": 26,
    "manifest_quarantine": 0,
    "manifest_block": 0,
    "skills_total_filesystem": 705,  # 553 si plugin removed
    "session_start_tokens": "MEASURE-IN-V14.2-PHASE-0",  # placeholder
    "intent_dispatcher_p95_ms": 0.58,
    "brain_index_query_p50_ms": "MEASURE-IN-V14.4",
}
```

---

# PART II — SPRINT v14.2 "TOKEN HUNTER"

> **Objetivo:** reducir tokens-por-sesión en ≥ 50%. Métrica madre. Todo
> cambio debe demostrar ahorro > 1k tokens o no entra.

## Brainstorming — Alternativas evaluadas

Antes de comprometerse al plan, se consideraron 6 estrategias de
reducción de tokens. Análisis:

### A — Lazy skill listing (CHOSEN)

Idea: El harness de Claude Code lista 552 skills con descripción completa
en cada SessionStart (~88 con descripción, resto truncated). Si lo
modificamos para listar SÓLO nombres, podemos ahorrar ~20-30k tokens
por sesión.

- **Pro:** ahorro masivo y predecible. Contestable: hoy se truncan ya.
- **Pro:** intent-dispatcher de ULTRON tiene su propio routing layer
  (regex + ZTMSI BM25), no depende de las descripciones del harness.
- **Con:** requiere fork del comportamiento del harness (vía
  `skillListingBudgetFraction` o un wrapper).
- **Decisión:** chosen. Es el ahorro de mayor magnitud disponible.

### B — Prompt caching aggressive (CHOSEN, complementa A)

Idea: Anthropic prompt caching da hasta 90% off-token cuando los
primeros bloques son cacheables. Auditar SystemPrompt para mover
bloques estables al inicio.

- **Pro:** ahorro económico (no de tokens al modelo, sino de billing).
- **Pro:** sin cambios funcionales — sólo reordenar bloques.
- **Con:** requiere medición meticulosa del cache hit rate.
- **Decisión:** chosen, paralelo a A.

### C — Context compression con LLMLingua (REJECTED)

Idea: Comprimir context.md / MEMORY.md con LLMLingua-style summarizer
antes de inyectar.

- **Pro:** ratio 3-5x compresión sin pérdida significativa.
- **Con:** introduce dependencia de un modelo extra.
- **Con:** comprime al inicio, pero los bloques son ya pequeños
  (context.md = 188 palabras hoy).
- **Decisión:** rejected. ROI bajo en el tamaño actual del L0.

### D — Tool description trimming (CHOSEN partially)

Idea: Las descripciones de tools (Read, Edit, Bash...) tienen 200-500
tokens cada una. Algunas son obvias y se pueden trimear.

- **Pro:** ahorro 1-3k tokens.
- **Con:** trimear demasiado degrada calidad de uso de la tool.
- **Decisión:** chosen pero conservador. Auditar cada tool, trimear sólo
  donde no impacte calidad.

### E — Skill marketplace surgery (CHOSEN, complementa A)

Idea: Quitar plugins que no usa USER (`claude-code-workflows` ya
auto-restaura, hay otros candidates).

- **Pro:** elimina ruido permanentemente.
- **Con:** algunos plugins pueden ser útiles luego.
- **Decisión:** chosen pero requiere user input por plugin.

### F — Memory tiering inteligente (CHOSEN para v14.4, no v14.2)

Idea: Sólo cargar L0 al SessionStart; L1+L2 on-demand vía retrieval.

- **Pro:** L1 (MEMORY.md) son ~3k tokens que sólo se necesitan parcialmente.
- **Con:** requiere retrieval funcional → depende de v14.4.
- **Decisión:** parking. v14.4 lo desbloquea.

## Investigación — Research phase v14.2.0

Antes de implementar, fork de research debe consultar:

### Research prompts

```
Research-1 (1 hora):
  Topic: Claude Code skillListingBudgetFraction internals + alternatives
  Sources to query:
    - https://docs.anthropic.com/claude-code/skills
    - https://github.com/anthropics/claude-code (changelog + docs/)
    - "claude code lazy skill loading" en HN/Reddit
  Questions to answer:
    - ¿Existe un setting oficial para name-only skill listing?
    - ¿Qué hace exactamente el budget fraction internamente?
    - ¿Hay precedente de wrappers que modifiquen el behavior?
  Output: ~/.ultron/audits/research-skill-listing-2026-05-XX.md

Research-2 (1 hora):
  Topic: Prompt caching state-of-the-art Anthropic 2026
  Sources:
    - https://docs.anthropic.com/claude/docs/prompt-caching
    - Anthropic engineering blog
    - Claude API SDK examples
  Questions:
    - ¿Cómo se mide cache hit rate?
    - ¿Cuál es el TTL real (5 min documentado, ¿hay extensiones?)?
    - ¿Cuántos cache_control blocks soporta el API hoy (era 4)?
  Output: ~/.ultron/audits/research-prompt-cache-2026-05-XX.md

Research-3 (30 min):
  Topic: Token measurement tools
  Sources:
    - tiktoken alternatives para Claude
    - claude-tokenizer (oficial?)
    - bench tools en GitHub
  Questions:
    - ¿Cómo medir tokens de un prompt sin enviarlo al API?
    - ¿Hay parser local oficial de Anthropic?
  Output: ~/.ultron/audits/research-token-measurement-2026-05-XX.md
```

## Phases del sprint v14.2

### Phase 0 — Baseline measurement (1 día)

**DEV:**
- Implementar `scripts/cockpit/token_baseline.py` (nuevo)
- Mide al SessionStart: bytes y tokens estimados de cada bloque
- Outputs: tabla TSV en `~/.ultron/audits/token-baseline-<date>.tsv`

**TEST:**
- 5 casos: vault con 100/500/1000 notas, MEMORY.md con 0/normal/inflated,
  CLAUDE.md presente/ausente, skill catalog 100/500/1000
- Cada caso debe medir reproducible (run x3, varianza < 2%)

**QA:**
- Independent fork verifica que el medidor coincide con tiktoken/anthropic
- Validación cross-tool con ≥3 prompts conocidos

**Acceptance criteria:**
- [ ] Baseline reproducible (run x3 mismo resultado ± 2%)
- [ ] Cubre 5 bloques principales: context.md, MEMORY.md, CLAUDE.md,
      skill listing, tool descriptions
- [ ] Output TSV consumible por scripts downstream
- [ ] Doctor detector D22_TOKEN_BASELINE registra el snapshot

**Métricas a capturar:**
- `session_start_tokens_total`
- `session_start_tokens_by_block` (dict)
- `cache_hit_rate_estimate` (prompt-caching theoretical)

### Phase 1 — Lazy skill listing (3 días)

**DEV (fork prompt):**

```
Sub-agent: implementor
Spec: scripts/cockpit/skill_lazy_loader.py (nuevo)
- Función: build_skill_listing(mode="lazy"|"full") → str
  - mode="lazy": nombre + tier + 1-line de la description (cap 80 chars)
  - mode="full": comportamiento actual
- Hook UserPromptSubmit: intent-dispatcher decide qué descriptions cargar
  basándose en el query; cuando carga, hace inject vía session-state
  (no system-prompt, ya está rendered)
- Fallback: si el lazy pierde una skill que sí debía dispararse, log warn
  para USER

Constraints:
- Backwards compatible: si lazy.json no existe, comportamiento actual
- Atomic writes a la state file
- Tests pytest cubriendo: lazy mode, full mode, mixed, missing config
```

**TEST:**
- Tests unitarios del builder (8 casos: empty, 1, 100, 1000 skills,
  cap budget, fallback)
- Test de integración: SessionStart simulado mide tokens pre/post
- Test regresión: dispatcher sigue identificando skills correctamente

**QA:**
- Reviewer fork audita: ¿hay skills que el dispatcher pierde por
  falta de description?
- A/B con 50 queries doradas pre/post

**Acceptance criteria:**
- [ ] -20k tokens / sesión mínimo (delta vs baseline Phase 0)
- [ ] Dispatcher accuracy: ≥ 95% sobre golden set (50 queries)
- [ ] Fallback a full-listing si lazy.json corrupted
- [ ] Tests > 95% cobertura sobre `skill_lazy_loader.py`
- [ ] Doctor detector D23_LAZY_LISTING_HEALTH

### Phase 2 — Prompt cache audit (2 días)

**DEV:**
- Análisis de los 12 hooks: cuál es cacheable, dónde poner cache_control
- Refactor de `intent-dispatcher.py` y `session-init.ps1` para mover
  bloques estables al inicio
- Implementar `~/.ultron/cockpit/cache-config.yaml` con declarative
  cache breakpoints

**TEST:**
- Mock de la API Anthropic con cache hit/miss tracking
- Verifica que los breakpoints están en posiciones estables
- 6 escenarios: cold start, warm 5min, warm 4h, prompt cambió bloque
  cacheable, prompt cambió bloque volátil, malformed cache_control

**QA:**
- Independent: verifica que el SDK no rompe en edge cases
- Mide: ¿cache hit rate sube en sesiones reales tras 1 día?

**Acceptance criteria:**
- [ ] Cache hit rate ≥ 60% en sesiones reales medidas durante 24h
- [ ] No degradación de latencia inicial (cold start no se ralentiza)
- [ ] Documentación: cada cache_control con justificación inline

### Phase 3 — MEMORY.md compression / dedup (1 día)

**DEV:**
- Tool nuevo: `ultron memory dedupe [--apply|--dry-run]`
- Detecta hechos duplicados entre MEMORY.md, context.md, CLAUDE.md
- Aplica política SSOT: cada hecho vive en exactamente un sitio
- Outputs diff con propuesta antes de apply

**TEST:**
- Fixtures con redundancia conocida (3 casos: duplicado exacto,
  paraphrase, info parcial)
- Verifica que el deduper no pierde info crítica

**QA:**
- Reviewer: ¿hay info que merece duplicarse a propósito? (e.g. paths
  importantes, números clave)

**Acceptance criteria:**
- [ ] -1k tokens / sesión mínimo
- [ ] Cero pérdida de información detectable
- [ ] Tool no destructivo por default (dry-run primero)

### Phase 4 — Tool description trimming (1 día)

**DEV:**
- Auditar `~/.claude/CLAUDE.md` (global) — algunas tools (Bash, Edit)
  tienen descripciones largas que el modelo ya conoce
- Trimmar conservativamente
- Documentar en cada cambio el ahorro

**TEST:**
- Antes/después con 20 tareas estándar (pytest, git commit, file edit, etc.)
- El modelo debe seguir usando las tools correctamente

**QA:**
- A/B blind: presentar 10 outputs pre y 10 post a una review fork.
  Si la review no detecta degradación, pasa.

**Acceptance criteria:**
- [ ] -2k tokens / sesión mínimo
- [ ] Tool calls correctos en ≥ 95% de casos test
- [ ] Sin regresiones de tool-call format

### Phase 5 — Smoke + RESOLVED (medio día)

**DEV:**
- Re-medir baseline (Phase 0 instrumentation)
- Comparar pre/post: tokens totales, cache hit rate
- Generar reporte `~/.ultron/audits/v14.2-token-hunter-results.md`

**TEST:**
- Suite global verde
- Doctor: D22 (baseline), D23 (lazy listing) ambos green
- Smoke en sesión real: usar ULTRON 30 min real, observar comportamiento

**QA:**
- Comparativa final: ¿se cumplió el target -50%?
- Si no: cuáles fases under-delivered, plan correctivo

**REV (HUMAN-GATE):**
- USER lee el reporte
- Decide: merge / iterar / abandonar fases que no convencieron

**RESOLVED:**
- Single commit por phase: `feat(v14.2-pX): <descripción>`
- Changelog entry v14.2.0 "TOKEN HUNTER" con tabla pre/post
- MEMORY.md actualizado con nuevos baselines

## v14.2 Acceptance criteria globales

- [ ] Total tokens / SessionStart: -50% vs baseline (target ambicioso) o
      -30% mínimo (target aceptable)
- [ ] Cache hit rate ≥ 60%
- [ ] Suite tests: 622 → ≥ 622 + nuevos del sprint, todos green
- [ ] Doctor BLOCKING: 0 (no degradación)
- [ ] Dispatcher accuracy: ≥ 95% sobre golden set
- [ ] Documentación: cada decisión registrada en decision log

## v14.2 Risks

| ID | Title | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R01 | Lazy listing rompe dispatcher | medium | high | Golden set + fallback to full |
| R02 | Cache breakpoint mal puesto degrada cache hit | medium | medium | Mock test antes de prod |
| R03 | Trimming agresivo de tools degrada calidad | medium | high | A/B blind + threshold conservador |
| R04 | Research phase no encuentra docs oficiales | low | low | Fallback a engineering empírico |

## v14.2 Time estimate

| Phase | Days |
|---|---|
| 0 Baseline | 1 |
| 1 Lazy listing | 3 |
| 2 Prompt cache | 2 |
| 3 MEMORY dedup | 1 |
| 4 Tool trim | 1 |
| 5 Smoke + RESOLVED | 0.5 |
| **Total** | **~8.5 días** |

---

# PART III — SPRINT v14.3 "META-PROMPTER"

> **Objetivo:** prompts que se auto-mejoran por feedback del usuario y
> outputs reales. SIN training. SIN fine-tuning. Solo prompts-sobre-prompts
> + Claude/Codex/Gemini juzgando la calidad.

## Brainstorming — Alternativas

### A — Meta-prompts con Claude as judge (CHOSEN)

Idea: Anthropic publicó patrones de "meta-prompts" que reciben
(prompt, ejemplos buenos, ejemplos malos) y devuelven prompt mejorado.

- **Pro:** sin training, sólo composición.
- **Pro:** Claude es buen juez de prompts (peer-reviewed claim).
- **Con:** depende de la consistencia del juez.
- **Decisión:** chosen.

### B — Genetic algorithm sobre prompt mutations (REJECTED)

Idea: tener N variantes, evaluar fitness, cruzar las mejores.

- **Pro:** explora más espacio.
- **Con:** caro en API calls.
- **Con:** convergencia incierta.
- **Decisión:** rejected. Meta-prompts dirigidos > exploración random.

### C — User-supervised feedback (CHOSEN, complementa A)

Idea: cada vez que USER edita un output o re-prompta, capturar la
señal y alimentarla al meta-prompter.

- **Pro:** señal de altísima calidad.
- **Con:** privacidad — USER debe consentir.
- **Decisión:** chosen, opt-in.

### D — Claude pair-tournament (CHOSEN para evaluación)

Idea: para 2 versiones de un prompt, generar N outputs cada uno,
comparar pairwise con Claude as judge.

- **Pro:** robusto al sesgo de un single judgment.
- **Con:** requiere N evaluaciones.
- **Decisión:** chosen, sólo para final-selection.

### E — Reinforcement learning con sparse rewards (REJECTED)

Idea: RLHF-lite con reward = user-satisfaction.

- **Pro:** principled.
- **Con:** rewards SUPER sparse, ULTRON no es chatGPT con millones de
  conversaciones.
- **Decisión:** rejected.

## Investigación — Research v14.3.0

```
Research-4:
  Topic: Anthropic prompt-improvement cookbook 2026
  Sources:
    - https://docs.anthropic.com/claude/docs/prompt-engineering
    - https://github.com/anthropics/anthropic-cookbook
    - "constitutional AI" + "self-refine" papers
  Output: ~/.ultron/audits/research-meta-prompts-2026-05-XX.md

Research-5:
  Topic: Pairwise prompt evaluation in production
  Sources:
    - LMSYS chatbot arena methodology
    - "LLM as judge" papers (2024 onwards)
  Output: same audit dir
```

## Phases del sprint v14.3

### Phase 0 — Corpus selection (medio día)

**DEV:**
- Inventariar todos los prompts ULTRON: 9 Kirkardo + 6 skills + 3 newsletters
  + ~5 inline prompts en TUI + autoupdate prompts
- Clasificar: high-traffic, medium, low
- Empezar mejorando los high-traffic primero

**Acceptance:**
- [ ] Lista publicada en `~/.ultron/audits/prompt-corpus-v14.3.md`

### Phase 1 — Meta-prompt template (1 día)

**DEV (fork prompt):**

```
Sub-agent: implementor
Spec: scripts/cockpit/prompt_improver.py (nuevo) + skill prompt-improver
Función:
  improve_prompt(
    current_prompt: str,
    sample_outputs: list[str],
    user_edits: list[tuple[str, str]],  # (was, became)
    failure_modes: list[str],
  ) -> str  # improved prompt

Implementación:
  - Construye un meta-prompt con un patrón fijo (Anthropic cookbook style)
  - Llama a Claude/Codex con temperature 0.3
  - Devuelve el improved prompt SIN aplicarlo

Constraints:
- No auto-apply (anti-laundering)
- Output incluye diff (current_vs_improved) para human review
```

**TEST:**
- 5 prompts de prueba con failure modes conocidos
- Verifica que el improved prompt soluciona ≥ 1 failure mode

**QA:**
- A/B blind: 10 prompts antes/después → reviewer rate calidad

**Acceptance:**
- [ ] Improved prompts ganan A/B en ≥ 70% de casos
- [ ] Diff legible para USER

### Phase 2 — Loop semi-automático (2 días)

**DEV:**
- Hook PostToolUse para Skill: capturar output cuando skill usada
- Detección de "user edited the output" — comparar clipboard pre/post
- Persistir señal en `~/.ultron/.tmp/prompt-feedback.jsonl`

**TEST:**
- Mock signals: 20 entries de feedback simulado
- Loop completa el ciclo: feedback → meta-prompt → diff

**QA:**
- Privacy review: ¿la señal contiene info sensible? Filter PII.

**Acceptance:**
- [ ] Loop end-to-end documentado
- [ ] Anti-laundering: cero auto-apply en cualquier path

### Phase 3 — Versionado de prompts (1 día)

**DEV:**
- Cada `*.md` prompt gana frontmatter `iteration`, `superseded_by`,
  `created_at`, `last_eval_at`
- Tool: `ultron prompts versions <name>` para inspeccionar histórica

**TEST:**
- Crear 3 iteraciones de un prompt, validar tracking

**Acceptance:**
- [ ] Versioning funcional
- [ ] Tool `ultron prompts` con subcommands list/version/diff/eval

### Phase 4 — Self-eval skill (2 días)

**DEV:**
- Skill `prompt-eval`: dado (prompt, output) devuelve scorecard 0-10
  sobre dimensiones (precisión, conciencia, formato, completitud)
- Implementación: meta-prompt al modelo + parsing
- Cache resultados por (prompt_sha1, output_sha1)

**TEST:**
- 30 prompt+output pairs etiquetados manualmente por USER
- Eval skill debe correlacionar > 0.7 con etiquetas

**QA:**
- Bias check: ¿el eval prefiere outputs largos? (common LLM-as-judge bias)

**Acceptance:**
- [ ] Correlación con human ≥ 0.7
- [ ] Bias < 10% en dimensión de longitud

### Phase 5 — TUI integration + RESOLVED

**DEV:**
- Botón "✎ Mejorar este prompt" en cada Kirkardo audit row del TUI
- Botón "📊 Eval este prompt" idem

**TEST + QA + REV + RESOLVED:** estándar.

## v14.3 Acceptance globales

- [ ] ≥ 5 prompts mejorados con A/B verificado
- [ ] Loop feedback funcional (no auto-apply)
- [ ] Eval skill correlaciona con humano
- [ ] TUI integration

## v14.3 Time estimate: ~7 días

---

# PART IV — SPRINT v14.4 "PERFECT MEMORY"

> **Objetivo:** memoria semántica completa sobre el vault. Hybrid search
> FTS5 + vectors. Auto-recall en SessionStart.

## Brainstorming

### A — Qdrant local + sentence-transformers (CHOSEN)

- **Pro:** local, privado, gratis forever, latencia sub-ms.
- **Con:** require Docker.
- **Decisión:** chosen. Default path.

### B — Qdrant Cloud free tier (alternative)

- **Pro:** sin Docker.
- **Con:** datos viajan, free tier limitado a 1GB.
- **Decisión:** alternative si A bloquea.

### C — Chroma local (REJECTED)

- **Con:** menos maduro que Qdrant 2026, Python-only embedding.
- **Decisión:** rejected.

### D — pgvector + Supabase (CONSIDERED)

- **Pro:** Supabase MCP ya conectado.
- **Con:** Supabase free tier no escala bien con embeddings densos.
- **Decisión:** considered, fallback si A y B fallan.

### E — Embedding model choice

| Modelo | Dim | Speed | Cost | Pick? |
|---|---|---|---|---|
| sentence-transformers/all-MiniLM-L6-v2 | 384 | rápido | local free | **CHOSEN** |
| sentence-transformers/all-mpnet-base-v2 | 768 | medio | local free | alternative if quality low |
| OpenAI text-embedding-3-small | 1536 | API | $ | rejected (datos viajan) |
| Cohere embed-multilingual-v3 | 1024 | API | $ | rejected (datos viajan) |

## Investigación — Research v14.4.0

```
Research-6:
  Topic: Vector search benchmarks 2026
  - Qdrant vs Chroma vs pgvector vs Weaviate
  - HNSW vs IVF tuning
  Output: research-vector-stores-2026-05-XX.md

Research-7:
  Topic: Embedding model sentence-transformers vs alternatives
  - MiniLM vs MPNet vs E5 vs BGE
  - Spanish-specific: ¿hay modelos better-tuned to es?
  Output: research-embeddings-2026-05-XX.md

Research-8:
  Topic: Hybrid retrieval (BM25 + vectors)
  - Reciprocal Rank Fusion
  - Score normalization techniques
  Output: research-hybrid-search-2026-05-XX.md
```

## Phases v14.4

### Phase 0 — Qdrant install (depende de pickup-action #2)

**HUMAN-GATE:** USER elige Path A o B y completa install.
Sin esto, sprint bloqueado.

### Phase 1 — Embedding pipeline (3 días)

**DEV:**
- `scripts/cockpit/embed_vault.py` (nuevo)
- Walk vault, calcular embedding por chunk (mismos chunks que FTS5 ya tiene)
- Push a Qdrant collection `ultron_vault`
- Idempotente: re-run actualiza solo cambios

**TEST:**
- Fixtures con 10/100/1000 notas
- Verifica que upsert es idempotente
- Smoke con vault real (538 notas)

**QA:**
- Embedding quality check: 20 queries dorados con respuesta esperada,
  verifica top-3 retrieval

**Acceptance:**
- [ ] 538 notas indexadas en < 5 min
- [ ] Recall@3 ≥ 0.8 sobre golden set

### Phase 2 — Hybrid search tool (2 días)

**DEV:**
- `brain_index hybrid <query>` combina FTS5 (BM25) + Qdrant (cosine)
- Reciprocal Rank Fusion
- Output: top-5 con scores y origen

**TEST + QA + REV + RESOLVED:** estándar.

### Phase 3 — Auto-recall en SessionStart (1 día)

**DEV:**
- Modificar `context_primer.py` para incluir top-3 notas semánticamente
  cercanas a la última query de la sesión anterior
- Cap a 200 tokens extra en context.md

### Phase 4 — Dispatcher con embeddings (3 días)

**DEV:**
- Train k-NN classifier sobre `routing.jsonl` (1000s samples ya hay)
- Embedding de query → vector → k-NN → skill
- Confidence score; fallback a regex si < threshold

### Phase 5 — Tests + RESOLVED

**Acceptance globales:**
- [ ] Recall@3 ≥ 0.8 sobre golden set
- [ ] Hybrid search beats FTS5-only en ≥ 70% de casos
- [ ] Dispatcher: precisión ≥ regex baseline + 5%
- [ ] Auto-recall genera context relevante en ≥ 80% de sesiones (manual eval)

## v14.4 Time: ~9-12 días

---

# PART V — SPRINT v15.0 "ULTRON.io"

> **Objetivo:** web pública en español, profesional, vendible. No es
> el sistema empaquetado en SaaS — es el showcase.

## Brainstorming

### A — Next.js + Tailwind + shadcn (CHOSEN)

- **Pro:** stack que USER maneja, skill `ui-ux-pro-max` lo cubre.
- **Pro:** Vercel MCP ya conectado para deploy.

### B — Astro static site (CONSIDERED)

- **Pro:** más rápido / cero JS si no necesario.
- **Con:** USER ya tiene experiencia Next.js.
- **Decisión:** B postpone, A first.

### C — Pure markdown + GitHub Pages (REJECTED)

- **Con:** poco profesional para sales/showcase.

## Phases v15.0

### Phase 0 — Brief + content audit (1 día)

**Activities:**
- Quién audiencia: developers + recruiters + clientes consulting
- Qué transmitir: showcase de "qué se construye con Claude Code disciplinado"
- Tono: profesional, técnico, sin hype, datos > marketing

### Phase 1 — Stack setup (1 día)

```bash
npx create-next-app@latest ultron-web --typescript --tailwind --eslint --app
cd ultron-web
npx shadcn@latest init
```

### Phase 2 — Core pages (3-5 días)

```
/                  Hero — "ULTRON: tu cockpit personal de IA"
/manifesto         Filosofía — anti-laundering, soberanía, locality
/architecture      Diagrama interactivo: 4 layers, 12 hooks, 18 detectors
/sprints           Cronología: v11→v14.4. Cada commit visible.
/numbers           622 tests · 18 detectors · 552 skills (en vivo)
/personas          Las 18 personas con su voz/dominio
/blog              Sprint write-ups en español
/contact           "¿Quieres que te construya algo así?" → form
```

### Phase 3 — Contenido (3 días)

- Manifesto: 800 palabras
- Architecture: diagrama + 5 párrafos
- 3 blog posts: Genesis, Deadwood, Token Hunter
- Numbers: endpoint que lee `~/.ultron/audits/*.json`

### Phase 4 — Marketing legítimo (1 día)

- HN submit: "Show HN: I built a personal AI ops cockpit"
- LinkedIn: ES + EN
- GitHub: open-source decision (defer to user)

### Phase 5 — RESOLVED

**Acceptance:**
- [ ] Live en domain .io/.com
- [ ] Lighthouse ≥ 90
- [ ] Mobile responsive
- [ ] Plausible analytics (privacy-first)
- [ ] Contact form funcional

## v15.0 Time: ~8-10 días

---

# PART VI — REGISTROS GLOBALES

## Decision Log (vivo, se actualiza por sprint)

```yaml
# v14.2 decisions
- decision_id: D01
  sprint: v14.2
  date: 2026-05-09
  question: "¿Lazy skill listing o budget bump?"
  options_considered:
    - A: Lazy listing (ahorro -20k tokens, complejidad media)
    - B: Bump fraction 1%→2% (+34k tokens/sesión, simple)
    - C: Hybrid
  chosen: A
  reason: "Token efficiency es métrica madre. Bump aumenta el problema."
  decided_by: claude+USER (2026-05-08 23:55 conv)
  reversibility: easy
  review_after: post-Phase 5
```

## Risk Register (vivo)

```yaml
- risk_id: R01
  sprint: v14.2
  phase: DEV (Phase 1)
  title: "Lazy listing rompe intent-dispatcher accuracy"
  likelihood: medium
  impact: high
  mitigation: "Golden set 50 queries + fallback automático a full-listing"
  trigger: "Dispatcher accuracy < 95% sobre golden set"
  owner: implementor-fork
  status: open
```

## Métricas tracking

Tabla a actualizar al inicio de cada sprint:

| Sprint | Tokens/SessionStart | Cache hit % | Tests | Doctor blocking | Notes |
|---|---|---|---|---|---|
| Pre-v14.2 | 50000 (estimado) | unknown | 622 | 0 | Baseline pre-token-hunter |
| Post-v14.2 | TARGET 25000 | TARGET 60% | TBD | 0 | After Token Hunter |
| Post-v14.3 | ≥ post-v14.2 | ≥ post-v14.2 | TBD | 0 | After Meta-Prompter |
| Post-v14.4 | ≥ post-v14.2 | ≥ post-v14.2 | TBD | 0 | After Perfect Memory |
| Post-v15.0 | ≥ post-v14.4 | ≥ post-v14.4 | TBD | 0 | After Web launch |

---

# PART VII — ANEXOS

## Anexo A — Plantilla de prompt para sub-agentes implementores

```
ROLE: You are a sub-agent implementor for ULTRON sprint <X>, phase <DEV>.

CONTEXT:
- Plan: ~/.ultron/plans/2026-05-09-MACRO-roadmap-v14.2-to-v15.0.md
- Section: PART <N> Phase <M>
- Skill repo: ~/.claude/skills/ultron
- Working dir: ~/.claude/skills/ultron

INPUTS:
- Spec from the plan section above
- Existing code patterns (Read+Grep)
- Test fixtures location: tests/fixtures/

INSTRUCTIONS:
1. Read the spec fully BEFORE coding
2. Audit existing patterns: don't reinvent — match conventions
3. Implement the smallest version that satisfies the spec
4. Run smoke before declaring DEV done
5. Document deviations from spec in your final report

OUTPUT:
- Code changes (no commit)
- Brief implementation notes
- Smoke test result
- List of test cases for Phase TEST

CONSTRAINTS:
- Follow PART I anti-laundering rules
- No auto-commit, no auto-deploy
- Backups before destructive ops
- Atomic writes for any file write
```

## Anexo B — Plantilla de prompt para test engineer

```
ROLE: You are a test engineer for ULTRON sprint <X>, phase <TEST>.

INPUTS:
- DEV diff (just landed)
- Spec from the plan
- Acceptance criteria

INSTRUCTIONS:
1. Read the diff and the spec
2. Identify happy path, edge cases, error paths, regressions
3. Write pytest tests in tests/test_<feature>.py
4. Run uv run pytest tests/test_<feature>.py -v
5. Confirm 100% pass + suite global no regresa
6. Cover ≥ 80% of new code

OUTPUT:
- New tests/*.py files
- Coverage report (use coverage.py if available)
- Summary: # tests added, # cases edge, coverage %

CONSTRAINTS:
- Use existing fixtures + patterns
- No flaky tests (deterministic only)
- Fast tests (< 1s per case avg)
```

## Anexo C — Plantilla de prompt para QA reviewer

```
ROLE: You are an independent code reviewer (agent-skills:code-reviewer)
for ULTRON sprint <X>, phase <QA>.

INPUTS:
- Diff from DEV+TEST (commit-ready)
- Spec from the plan
- This is INDEPENDENT — no DEV/TEST fork context

INSTRUCTIONS:
Apply 7 review dimensions:
1. Correctness — bugs, off-by-one, wrong defaults
2. Robustness — error handling, validation
3. Security — injection, traversal, secrets
4. Performance — O(n²), N+1, sync I/O
5. Tests — gaps, false positive risk
6. Architecture — SOLID, coupling
7. Style/docs — comments why-not-what

OUTPUT:
- Markdown report at ~/.ultron/audits/qa-<sprint>-<feature>-<date>.md
- Severity buckets: BLOCKING, HIGH, MEDIUM, LOW
- Top 3 most-actionable

EXIT CRITERIA:
- 0 BLOCKING (else fail)
- HIGH ≤ 3 (else triage)
```

## Anexo D — Comandos canónicos por fase

| Fase | Comando |
|---|---|
| Pre-DEV | `git status --short; git log -1 --oneline` |
| DEV | (sub-agent fork con prompt template) |
| Post-DEV smoke | `uv run pytest tests/ -q` |
| TEST | `uv run pytest tests/test_<feature>.py -v --cov` |
| Post-TEST | `uv run pytest tests/ -q && uv run python scripts/cockpit/doctor.py --quiet --json` |
| QA | (subagent_type=agent-skills:code-reviewer fork) |
| RESOLVED commit | `git add ...; git commit -F ~/.ultron/.tmp/commit-<sprint>.txt` |
| Post-RESOLVED | `git log -1 --oneline; uv run pytest tests/ -q` |

## Anexo E — Smoke checklist post-merge

```
- [ ] git log -1 muestra el commit nuevo
- [ ] uv run pytest tests/ -q → green
- [ ] ultron deadwood --quiet → exit 0 o 1, NO 2
- [ ] ultron doctor --quiet → exit 0 o 1, NO 2
- [ ] ultron sync-all (sin push) → todos los pasos green
- [ ] context.md regenerated y < 400 words
- [ ] MEMORY.md updated si aplica
```

## Anexo F — Cómo retomar mañana sin perder el hilo

1. SessionStart hook regenera context.md → debería surface este plan
2. Lee MEMORY.md para anchor general
3. Lee `~/.ultron/plans/2026-05-09-pickup.md` para acciones inmediatas
4. Lee este macro plan: `~/.ultron/plans/2026-05-09-MACRO-roadmap-v14.2-to-v15.0.md`
5. Decide qué sprint atacar primero (default: v14.2 Phase 0 baseline)
6. Lanza sub-agent con plantilla del Anexo A correspondiente
7. Aplica el flow DEV → TEST → QA → REV → RESOLVED

## Anexo G — Checklist de inicio de sprint

```
- [ ] Pull latest desde main (si trabajas branched)
- [ ] git status --short limpio (excepto pre-existing)
- [ ] uv run pytest tests/ -q → baseline green
- [ ] doctor --quiet → baseline 0 blocking
- [ ] Snapshot baseline metrics (Anexo H)
- [ ] Crear branch: git checkout -b sprint/v14.X-<theme>
- [ ] Anunciar al usuario: "Iniciando sprint v14.X, target N días"
```

## Anexo H — Métricas a snapshot al inicio/final de cada sprint

```python
metrics = {
    "tests_passing": int,
    "tests_total": int,
    "doctor_blocking": int,
    "doctor_warn": int,
    "doctor_info": int,
    "deadwood_blocking": int,
    "deadwood_warn": int,
    "deadwood_info": int,
    "manifest_quarantine": int,
    "manifest_block": int,
    "manifest_warned": int,
    "manifest_allow": int,
    "skills_filesystem_total": int,
    "skills_root": int,
    "skills_plugin": int,
    "skills_bundle": int,
    "session_start_tokens": int,
    "cache_hit_rate_pct": float,
    "intent_dispatcher_p95_ms": float,
    "brain_index_query_p50_ms": float,
}
```

Persist a `~/.ultron/metrics/sprint-<X>-{start,end}.json`.

---

# CIERRE

Este documento es **autoritativo** para el roadmap v14.2 → v15.0. Cualquier
desviación durante ejecución debe loggearse en el Decision Log de PART VI.

Todas las fases son ejecutables AI-driven. El humano (USER) participa
sólo en HUMAN-GATEs marcados (REV de cada sprint + decisiones de infra
como Qdrant Path A/B).

Time total estimado: ~33 días de calendar (8.5 + 7 + 9-12 + 8-10).
Si USER trabaja 5 días/semana → ~6-7 semanas.
Si USER trabaja diario → ~5 semanas.

Próximo paso al despertar: leer `~/.ultron/plans/2026-05-09-pickup.md`,
ejecutar las 2 acciones del usuario (plugin remove + Qdrant decide),
luego arrancar v14.2 Phase 0 con baseline measurement.

— Plan v2.0, ULTRON Macro-Roadmap. Saved 2026-05-08 (madrugada del 9).
