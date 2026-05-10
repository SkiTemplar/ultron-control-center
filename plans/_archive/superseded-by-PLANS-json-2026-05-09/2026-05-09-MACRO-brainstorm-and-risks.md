---
title: ULTRON Macro Roadmap — Brainstorm + Risk Register
date: 2026-05-09
status: PLAN-AUTHORITATIVE
companion_to: 2026-05-09-MACRO-roadmap-v14.2-to-v15.0.md
---

# Brainstorm + Risk Register — companion file

> Documento companion. Brainstorms expandidos por sprint, risk register
> pre-poblado, decision log inicial. Diseñado para que el AI pueda
> consultar alternativas y riesgos sin re-investigar lo que ya
> evaluamos.

---

## CAPÍTULO 1 — Brainstorm expandido por sprint

### v14.2 TOKEN HUNTER — extended brainstorm

10 aproximaciones evaluadas (no las 6 del macro plan). Las 4 adicionales:

#### G — Compress with vendored TIktoken (REJECTED)

Idea: pre-compress strings en disco usando un tokenizer-aware compressor.

- **Pro:** sub-token-level compression posible.
- **Con:** introduce dependencia, requiere descomprimir antes de cada
  cache lookup, breaks cache_control alignment.
- **Decisión:** rejected. Complejidad > ahorro.

#### H — Hot/cold splitting de skill descriptions (CONSIDERED)

Idea: tiene cada skill un "hot" 1-line y un "cold" full description.
Carga el "hot" siempre, "cold" sólo cuando dispatcher lo decide.

- **Pro:** complementa Lazy Listing (A) con granularidad mayor.
- **Con:** redundancia de almacenamiento por skill.
- **Decisión:** considered. Si Lazy Listing solo no llega a -50%, esto
  es la siguiente palanca.

#### I — Compresión de log para context (REJECTED)

Idea: Los `## SESIONES RECIENTES` en context.md son verbose. Comprimir.

- **Pro:** -50-100 tokens/sesión.
- **Con:** ya están truncados a 4 sesiones × 1 línea. Peca de prematura
  optimización.
- **Decisión:** rejected.

#### J — Tool-description on-demand loading (REJECTED por riesgo)

Idea: solo cargar tool descriptions cuando el modelo las "pida".

- **Pro:** ahorro masivo (-3-5k tokens).
- **Con:** Claude Code harness no soporta esto nativamente. Hack
  requeriría wrapping del API que rompería garantías.
- **Decisión:** rejected. ROI/riesgo malo.

### v14.3 META-PROMPTER — extended brainstorm

5 aproximaciones evaluadas (no 5 del macro plan, sólo 1 adicional):

#### F — Self-reflection with reasoning model (CONSIDERED)

Idea: Usar Claude Opus o GPT-5.5 con extended thinking para el
juicio en lugar de un modelo regular.

- **Pro:** thinking traces > respuesta directa para juicio sutil.
- **Con:** caro en tokens.
- **Con:** ULTRON ya tiene presupuesto ajustado.
- **Decisión:** considered. Aplicar SOLO en pair-tournament final, no
  en eval cotidiano.

### v14.4 PERFECT MEMORY — extended brainstorm

8 aproximaciones evaluadas (no 5 del macro plan, 3 adicionales):

#### F — Custom SQLite con vector extension (REJECTED)

Idea: sqlite-vec o sqlite-vss extensions, todo local, sin Docker.

- **Pro:** sin Docker dependency.
- **Pro:** se integra con FTS5 existente en el mismo .db.
- **Con:** menos maduro que Qdrant 2026.
- **Con:** menos features (no payload filtering avanzado).
- **Decisión:** rejected. Si Docker bloquea totalmente, fallback worth
  re-considering.

#### G — Embeddings cache en Redis (REJECTED)

Idea: usar Redis como vector cache.

- **Con:** Redis no es un vector store nativo.
- **Decisión:** rejected.

#### H — Lance/LanceDB (CONSIDERED)

Idea: LanceDB es nuevo (2024+), embed-and-query con storage columnar.

- **Pro:** sin servidor, embebido en proceso.
- **Pro:** muy rápido lectura.
- **Con:** API menos madura que Qdrant.
- **Con:** Python-only (Qdrant tiene MCP estable).
- **Decisión:** considered. Si Qdrant Path A bloquea Y la community MCP
  no está mantenida, considerar.

### v15.0 ULTRON.io — extended brainstorm

5 aproximaciones evaluadas (3 adicionales):

#### D — Notion site embed (REJECTED)

Idea: Notion + super.so para sitio público.

- **Pro:** USER ya usa Notion, fast-launch.
- **Con:** poco profesional para showcase técnico.
- **Decisión:** rejected.

#### E — Docusaurus (REJECTED)

Idea: site doc-style, perfecto para technical writeup.

- **Pro:** built-in para docs+blog.
- **Con:** muy técnico, falta el ángulo "marketing/sales".
- **Decisión:** rejected.

#### F — Gatsby + Sanity CMS (REJECTED)

- **Con:** Gatsby moribundo en 2026.
- **Decisión:** rejected.

---

## CAPÍTULO 2 — Risk Register pre-poblado

Risks identificados antes de empezar. Cada uno tiene mitigación
predefinida.

```yaml
- risk_id: R01
  sprint: v14.2
  phase: DEV (Phase 1)
  title: "Lazy listing rompe intent-dispatcher accuracy"
  likelihood: medium
  impact: high
  mitigation: |
    Golden set de 50 queries evaluadas pre-cambio. Post-cambio,
    accuracy debe ser ≥ 95% del baseline. Fallback automático a
    full-listing si lazy.json corrupted.
  trigger: "Dispatcher accuracy < 95% sobre golden set"
  owner: implementor-fork
  status: open
  contingency: "Si accuracy degrade, vuelve a Phase 0 baseline mode."

- risk_id: R02
  sprint: v14.2
  phase: DEV (Phase 2)
  title: "Cache breakpoint mal puesto degrada cache hit rate"
  likelihood: medium
  impact: medium
  mitigation: |
    Mock test antes de prod. Cada cache_control con justificación
    inline. Medición de cache hit rate antes y después.
  trigger: "Cache hit rate ≤ baseline post-cambio"
  owner: implementor-fork
  status: open
  contingency: "Revertir cache_control hasta encontrar configuración stable."

- risk_id: R03
  sprint: v14.2
  phase: DEV (Phase 4)
  title: "Trimming agresivo de tools degrada calidad"
  likelihood: medium
  impact: high
  mitigation: |
    A/B blind con 20 tareas estándar. Threshold conservador: solo
    trimear si ahorro > 100 tokens AND la herramienta es OBVIA
    (Read, Edit, Write — no Bash, no MCP).
  trigger: "Tool call format incorrect en > 5% de casos test"
  owner: implementor-fork
  status: open
  contingency: "Revertir trim, mantener descripción original."

- risk_id: R04
  sprint: v14.2
  phase: research-0
  title: "WebSearch falla / docs Anthropic no clear sobre lazy listing"
  likelihood: low
  impact: low
  mitigation: "Fallback a engineering empírico — observar what works."
  trigger: "Research-1 no encuentra docs sobre skillListingBudgetFraction internals"
  owner: research-fork
  status: open

- risk_id: R05
  sprint: v14.3
  phase: QA
  title: "LLM-as-judge bias ('preferring longer outputs')"
  likelihood: high
  impact: medium
  mitigation: |
    Bias check explícito en tests. 2 outputs same content,
    diferente longitud → score diff ≤ 1. Si falla, ajustar
    el meta-prompt con constraint de length-neutrality.
  trigger: "test_eval_does_not_prefer_longer_outputs falla"
  owner: implementor-fork
  status: open

- risk_id: R06
  sprint: v14.3
  phase: DEV (Phase 2)
  title: "Privacy: feedback loop captura PII en outputs"
  likelihood: medium
  impact: high (compliance/personal)
  mitigation: |
    PII filter explícito antes de persistir feedback signals.
    Filter: emails, PAT-like strings (40+ alpha-num), credit-card
    patterns. Log redactado, no raw.
  trigger: "Cualquier feedback entry contiene secreto"
  owner: implementor-fork + privacy-reviewer
  status: open
  contingency: "Si PII detectada, purgar el log + bug-fix el filter."

- risk_id: R07
  sprint: v14.4
  phase: Phase 0 (install)
  title: "Qdrant install bloquea sprint indefinidamente"
  likelihood: medium
  impact: high
  mitigation: |
    Path A (Docker) y Path B (Cloud) ambos pre-documentados.
    Si USER no decide en X días, default a Path A con install
    semi-automatizado.
  trigger: "v14.4 Phase 0 abierto > 7 días"
  owner: USER
  status: open
  contingency: "Sin Qdrant, el sprint pivota a sqlite-vec (alternative F del brainstorm)."

- risk_id: R08
  sprint: v14.4
  phase: Phase 1
  title: "Embedding model elegido tiene mala calidad para ES"
  likelihood: medium
  impact: medium
  mitigation: |
    Golden set de 50 queries en ES con respuestas esperadas.
    Recall@3 ≥ 0.8 obligatorio. Si falla, swap a all-mpnet-base-v2
    (768 dim) o E5-multilingual.
  trigger: "Recall@3 < 0.8 en golden set ES"
  owner: implementor-fork
  status: open

- risk_id: R09
  sprint: v14.4
  phase: Phase 4
  title: "Dispatcher con embeddings es más lento que regex"
  likelihood: medium
  impact: medium
  mitigation: |
    Cache de embeddings de queries frecuentes. Threshold de p95 ≤
    50ms. Fallback a regex si confidence baja O latencia degrada.
  trigger: "p95 > 50ms"
  owner: implementor-fork
  status: open

- risk_id: R10
  sprint: v15.0
  phase: Phase 0 (brief)
  title: "Scope creep — web se convierte en SaaS"
  likelihood: high
  impact: medium
  mitigation: |
    Timebox 1.5 semanas máximo. Web es SHOWCASE, no producto.
    Si emerge interés genuino de venderlo, es proyecto separado.
  trigger: "Phase 2 (core pages) > 5 días"
  owner: USER + orchestrator
  status: open

- risk_id: R11
  sprint: v15.0
  phase: Phase 4 (marketing)
  title: "Decisión open-source vs privado complica hosting"
  likelihood: medium
  impact: low
  mitigation: |
    Decisión deferida a Phase 4. Default: privado (showcase, no FOSS).
    Si OSS, GitHub repo separado del web.
  trigger: "Phase 4 abierto sin decisión open-source"
  owner: USER
  status: open

- risk_id: R12
  sprint: cross-sprint
  phase: any
  title: "Token reduction NO se mantiene tras añadir features v14.3+v14.4"
  likelihood: high
  impact: medium
  mitigation: |
    Doctor detector D22 monitoriza tokens cada SessionStart.
    Si suben > 5% sobre baseline post-v14.2, warn y require sprint
    de "re-tightening".
  trigger: "session_start_tokens regresa > +5%"
  owner: doctor automated
  status: open

- risk_id: R13
  sprint: cross-sprint
  phase: any
  title: "Sub-agent forks producen output inconsistente"
  likelihood: medium
  impact: medium
  mitigation: |
    Plantillas de prompt detalladas (CAPÍTULO 6 ops manual). Cada
    fork output revisable por el orchestrator. Si > 1 fork del
    mismo sprint produce algo divergente, escalate.
  trigger: "2+ fork outputs en mismo sprint sin convergencia"
  owner: orchestrator
  status: open

- risk_id: R14
  sprint: cross-sprint
  phase: testing
  title: "Tests añadidos son flaky (timing, randomness)"
  likelihood: low
  impact: medium
  mitigation: |
    Determinismo obligatorio en plantilla de test engineer.
    Seeds fijos para randomness. Time mocks (freezegun) para tests
    de fecha.
  trigger: "Tests pasan/fallan inconsistentemente entre runs"
  owner: test-engineer-fork
  status: open

- risk_id: R15
  sprint: cross-sprint
  phase: any
  title: "Branches sprint diverge mucho de main"
  likelihood: medium
  impact: medium
  mitigation: |
    Rebase periódico desde main durante el sprint. RESOLVED merge
    debe ser fast-forward o no-FF; nunca merge commits old branches.
  trigger: "Branch > 30 commits behind main"
  owner: orchestrator
  status: open
```

---

## CAPÍTULO 3 — Decision Log inicial

Decisiones tomadas durante el planeo (2026-05-08/09):

```yaml
- decision_id: D01
  sprint: v14.2
  date: 2026-05-09
  question: "¿Lazy skill listing o budget bump?"
  options_considered:
    - A: "Lazy listing (-20k tokens, complejidad media)"
    - B: "Bump fraction 1%→2% (+34k tokens/sesión)"
    - C: "Hybrid"
  chosen: A
  reason: |
    Token efficiency es la métrica madre del sprint. Bump aumenta el
    problema en lugar de reducirlo. C añade complejidad sin diferencial.
  decided_by: claude+USER
  reversibility: easy
  review_after: post-v14.2 Phase 5

- decision_id: D02
  sprint: v14.2
  date: 2026-05-09
  question: "¿Custom ML training para system management?"
  options_considered:
    - A: "Sí, fine-tune modelos sobre routing data"
    - B: "No, usar SOLO modelos pre-entrenados"
  chosen: B
  reason: |
    Training es trampa de tiempo. Datos sparse, mantenimiento alto,
    reward sparse. Modelos pre-entrenados aplicados quirúrgicamente
    cubren 80% del valor con 5% del esfuerzo.
  decided_by: claude
  reversibility: easy
  review_after: nunca (decisión arquitectónica)

- decision_id: D03
  sprint: v14.4
  date: 2026-05-09
  question: "¿Vector store: Qdrant local, Cloud, o sqlite-vec?"
  options_considered:
    - A: "Qdrant local con Docker"
    - B: "Qdrant Cloud free tier"
    - C: "sqlite-vec (no Docker, embebido)"
  chosen: A (default)
  reason: |
    Privacidad + latencia + free forever. Si Docker bloquea, B es
    fallback. C considered para edge case de sin-internet, pero menos
    maduro.
  decided_by: claude
  reversibility: medium (re-index trabajo)
  review_after: v14.4 Phase 0 (when user decides)

- decision_id: D04
  sprint: v14.4
  date: 2026-05-09
  question: "¿Embedding model: local o API?"
  options_considered:
    - A: "sentence-transformers/all-MiniLM-L6-v2 (local, 384 dim)"
    - B: "all-mpnet-base-v2 (local, 768 dim, mejor calidad)"
    - C: "OpenAI text-embedding-3-small (API, 1536 dim, datos viajan)"
  chosen: A
  reason: |
    Privacidad + speed. Si recall < 0.8 en golden set, swap a B.
    API rejected por consistency con "datos no salen del PC".
  decided_by: claude
  reversibility: medium
  review_after: v14.4 Phase 1 quality check

- decision_id: D05
  sprint: v15.0
  date: 2026-05-09
  question: "¿Stack web: Next.js, Astro o pure markdown?"
  options_considered:
    - A: "Next.js + Tailwind + shadcn"
    - B: "Astro (faster, less JS)"
    - C: "Pure markdown + GitHub Pages"
  chosen: A
  reason: |
    USER ya conoce Next.js, skill ui-ux-pro-max lo cubre,
    Vercel MCP conectado. Velocity > marginal speed gain.
  decided_by: claude
  reversibility: hard (rewrite si change later)
  review_after: v15.0 Phase 1 (post-setup)

- decision_id: D06
  sprint: v15.0
  date: 2026-05-09
  question: "¿Open-source ULTRON?"
  options_considered:
    - A: "Sí, public GitHub"
    - B: "No, web showcase pero código privado"
    - C: "Híbrido: subset OSS"
  chosen: B (default, deferred)
  reason: |
    Decisión postpone hasta Phase 4 v15.0. Privado por defecto.
    Si USER decide OSS, repo separado, post-v15.0 launch.
  decided_by: USER (deferred)
  reversibility: easy
  review_after: v15.0 Phase 4

- decision_id: D07
  sprint: cross-sprint
  date: 2026-05-09
  question: "¿Branching strategy?"
  options_considered:
    - A: "Sprint branches, mergeadas con --no-ff"
    - B: "Trunk-based, commits directos a main"
    - C: "Feature branches granulares por phase"
  chosen: A
  reason: |
    Sprint branches dan rollback granular. C es overkill (5 phases ×
    4 sprints = 20 branches). A balances safety y simplicity.
  decided_by: claude
  reversibility: medium
  review_after: post-v14.2 (validate workflow)
```

---

## CAPÍTULO 4 — Métricas baseline pre-v14.2

Snapshot a tomar al iniciar v14.2 Phase 0:

```yaml
# ~/.ultron/metrics/sprint-v14.2-pre.json (TO BE CREATED)
sprint: v14.2
phase: pre
date: 2026-05-XX  # cuando arranque
git_head: <commit-hash-of-main>
metrics:
  tests:
    passing: 622
    total: 642  # 622 + 20 skipped
    duration_seconds: TBD
  doctor:
    blocking: 0
    warn: 170
    info: 0
    total: 170
  deadwood:
    blocking: 0
    warn: 10
    info: 16
    total: 26
  manifest:
    quarantine: 0
    block: 0
    warned: 166
    allow: 226
    total: 392
  skills_filesystem:
    root: 414         # post-claude-code-workflows-resurrect
    plugin: 291
    bundle: 35
    total: 740
    expected_post_user_action: 553   # if plugin removed
  tokens:
    session_start_total: TBD          # MEASURED IN PHASE 0
    by_block:
      context_md: TBD
      memory_md: TBD
      claude_md_global: TBD
      skill_listing: TBD
      tool_descriptions: TBD
  cache:
    hit_rate_pct: unknown
  latency:
    intent_dispatcher_p95_ms: 0.58
    brain_index_query_p50_ms: 111  # subprocess-bound; pure SQL <10ms
```

---

## CAPÍTULO 5 — Quality bars matrices

### Matrix A: Sprint phase quality bar

| Phase | Min coverage | Min tests | Doctor regression | Time budget |
|---|---|---|---|---|
| DEV | n/a (no tests yet) | n/a | 0 BLOCKING | 30 min - 4 h |
| TEST | ≥ 80% on diff | ≥ 5 cases | 0 BLOCKING | 30 min - 2 h |
| QA | n/a (review only) | n/a | 0 BLOCKING + ≤3 HIGH | 15-45 min |
| REV | n/a | n/a | 0 BLOCKING | 5-30 min user |
| RESOLVED | n/a | n/a | ≤ baseline | 15-30 min |

### Matrix B: AI vs Human responsibility

| Activity | AI | Human |
|---|---|---|
| Read spec | ✓ | ✓ (REV only) |
| Implement code | ✓ | — |
| Write tests | ✓ | — |
| Run tests | ✓ | — |
| Independent review (QA) | ✓ (different fork) | — |
| Approve sprint | — | ✓ (REV) |
| Decide infra (Docker/Cloud) | — | ✓ |
| Decide content (web/manifesto) | propose | ✓ (final voice) |
| Commit | ✓ | — |
| Tag + push to remote | ✓ | ✓ (gate before push) |
| Plugin install/remove | — | ✓ |
| API key handling | — | ✓ |

### Matrix C: Trigger thresholds (cuando AI debe pausar)

| Trigger | Threshold | Action |
|---|---|---|
| Test regression | any | Stop, fix, escalate after 3 attempts |
| Doctor BLOCKING | any | Stop, fix, escalate immediately |
| Token regression | > 5% | Warn, continue, but flag for review |
| Coverage drop | > 5% absolute | Warn, add tests |
| Sprint over-time | > 150% estimate | Stop, replan |
| Fork crash | 3 attempts same prompt | Escalate |
| Decision required | n/a | Stop, ask user |

---

## CAPÍTULO 6 — Future roadmap (post-v15.0)

Ideas para sprints futuros, sin compromiso:

1. **v15.1 — RECEPTION**: integrar feedback de la web. Si HN/LinkedIn
   genera attention, capturar requests reales.
2. **v15.2 — CONSULTING-READY**: empaquetar el conocimiento como
   playbook entregable a clientes (developers que quieran montar
   su propio cockpit).
3. **v15.3 — MULTI-LANGUAGE**: i18n del sistema. Hoy ULTRON está en
   español-mezcla-inglés. Decidir si vale la pena pure-ES o pure-EN.
4. **v15.4 — TEAM MODE**: ULTRON multi-user con permission isolation.
   Único caso si USER decide fundar una consultora.

Ninguno de estos está en el roadmap autoritativo. Re-evaluar
post-v15.0.

---

## CAPÍTULO 7 — Cuando este plan se vuelve obsoleto

Este plan vale para ~1 mes. Después:

- Si los sprints v14.2-v15.0 cierran exitosos → plan v16.0 emerge orgánicamente.
- Si v14.2 falla en su target ambicioso → plan se ajusta antes de v14.3.
- Si USER cambia prioridades → plan se replan en una sesión dedicada.

Indicadores de que el plan necesita refresh:
- Más de 3 risks materializaron simultáneamente
- Más de 5 decisiones del decision log se revierten
- Sprint v14.X tomó > 200% de su budget

---

— Brainstorm + Risk Register companion. Saved 2026-05-09 (madrugada).
