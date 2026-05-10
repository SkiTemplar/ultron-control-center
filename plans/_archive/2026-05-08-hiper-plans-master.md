---
title: Hiper Plans — meta-planning skill + overlay para ULTRON
date: 2026-05-08
status: BUILT · v14.3.0 shipped via commit fc5c46a · Phase 5 (real-world validation) pending
mode: HIGH
authors: Claude (Opus 4.7) + USER
schema_version: 1
parent_plan: ~/.ultron/plans/2026-05-06-kirkardo-genesis-14-audit.md (Genesis-14 — COMPLETE)
---

# Hiper Plans — Master Plan

> **Trigger (2026-05-08):** Tras cerrar Genesis-14.2 (news reduction + alerts TTL + TUI sweep), USER flaggea que el modo planning de Claude Code es perfectible. Idea: enforzar prompt structures de alta calidad sobre Plan Mode / writing-plans / brainstorming etc. — un meta-skill que upgrade cualquier invocación de planning.

> **Form factor decidido:** **hybrid** — skill nueva (`~/.claude/skills/hiper-plans/SKILL.md`) + overlay activado en `/high` y `/ultra` modes de ULTRON. Hook UserPromptSubmit descartado (riesgo de falsos positivos demasiado alto).

> **Plan target:** este fichero. Genesis-14 cerrado, no mezclar.

---

## A. Goals

1. **Forzar calidad de planning** sin que USER recuerde estructura cada vez.
2. **Unificar fragmentación**: hay 6+ skills relacionadas (writing-plans, brainstorming, plan, planning-and-task-breakdown, spec-driven-development, idea-refine) sin SSOT.
3. **Activación selectiva**: ULTRA → todo, HIGH → overlay+skill, MEDIUM → nada (sin fricción para tareas pequeñas).
4. **Composabilidad**: Hiper Plans debe co-existir con `Plan` agent oficial, `ExitPlanMode`, y skills existentes — no reemplazar, augmentar.

## B. Non-goals

- **No** reescribir Plan Mode oficial — Anthropic gestiona ese tool.
- **No** reemplazar las 6 skills relacionadas — Hiper Plans las **invoca/coordina**, no las elimina.
- **No** auto-trigger por hook (FP risk demasiado alto).
- **No** templates estilo Jira/PRD pesados — el target es < 200 LOC de spec, no procesos formales.

## C. Existing landscape (qué ya está disponible)

### C.1 Anthropic-side (placeholder — Fork A llenará)

- `ExitPlanMode` tool — Plan Mode UI nativo de Claude Code
- `Plan` agent type — research-style planner
- `superpowers:writing-plans` skill — TBD spec
- `agent-skills:plan` skill — TBD spec
- `agent-skills:planning-and-task-breakdown` skill — TBD spec
- `agent-skills:spec-driven-development` skill — TBD spec
- `agent-skills:idea-refine` skill — TBD spec
- `superpowers:brainstorming` skill — TBD spec
- `agent-skills:incremental-implementation` skill — TBD spec

> Fork A (research) traerá specs + URLs + diferencia entre cada una.

### C.2 ULTRON-side

- `/thinking`, `/contrast`, `/contrast --blank`, `/contrast --dual`, `/learn` overlays existentes
- `/high`, `/ultra` modes
- `/dual`, `/maxdual`, `/triple`, `/maxtriple` peer review
- `kirkardo` audit prompts (cockpit/tui/prompts/01-09)
- 6 skill-prompts adicionales en cockpit/tui/prompts/skills-*.md

> Hiper Plans podría ser un **séptimo overlay** invocado con `/hiperplan` o sufijo `--hiperplan` a `/high`/`/ultra`.

## D. Research findings (4 forks paralelos completadas 2026-05-08)

### D.0 Headline — "Hiper Plans" literal no existe

Ninguna de las 4 fuentes (Anthropic oficial · GitHub community · Blogs/X 2025-2026 · ArXiv 2024-2026) usa el término "Hiper Plans" o "Hyper Plans". Lo más cercano:
- **Anthropic "Ultra Plan" cloud product** con modos Simple / Visual / **Deep Plan** (sub-agents para risk assessment) — comercial, no en Claude Code skill ([Geeky Gadgets](https://www.geeky-gadgets.com/ultra-plan-cloud-interface/)).
- **HyperAgents** (Meta, ICLR 2026, github.com/facebookresearch/Hyperagents) — agentes self-referential que reescriben su propia lógica de mejora. Concepto adyacente, no idéntico.
- **HiPER** (arXiv:2602.16165) — Hierarchical Plan-Execute RL, factoriza policy en planner + executor. Sigla, no término.

→ **Espacio terminológico abierto.** Podemos acuñar "Hiper Plans" / "Hyper Plans" sin colisión.

### D.1 Anthropic oficial

**Plan Mode = runtime mode, NO template prompt.** Anthropic deliberadamente NO enforce ROLE/CONTEXT/INPUTS rigid — deja a customización del usuario. Plan Mode bloquea Edit/Write/Bash a nivel tool; tools permitidos: Read/LS/Glob/Grep/Task/TodoRead/TodoWrite/WebFetch.

**Best practices oficiales (`code.claude.com/docs/en/best-practices`):**
- 4-phase loop **Explore → Plan → Implement → Commit** es el SSOT recomendado.
- Threshold para invocar Plan Mode: enfoque incierto, multi-file change, código no familiar. Skip si "podrías describir el diff en una frase".
- Combo recomendado: main session Plan Mode → dispatch **subagents for codebase research** (mantiene main context limpio) → AskUserQuestion para entrevistar usuario → escribir SPEC.md → fresh session implementa → second agent reviews.

**Skills relacionadas (community, NO Anthropic-vendored):**
- `superpowers:writing-plans` (Obra) — header: Goal / Architecture / Tech Stack + tasks con Files / TDD steps / Commit. Escribe a `docs/superpowers/plans/YYYY-MM-DD-<feat>.md`.
- `superpowers:plan-document-reviewer` — **pattern recursive planning de facto:** dispatcha agent separado para verificar completeness/spec-alignment/decomposition/buildability **antes** de implementar.
- `agent-skills:planning-and-task-breakdown` (addy-osmani) — Description / Acceptance / Verification / Dependencies / Files / Scope-size (XS-XL).
- `agent-skills:spec-driven-development` — 6 areas: Objective / Commands / Project Structure / Code Style / Testing / Boundaries (always-do / ask-first / never-do); gated SPECIFY → PLAN → TASKS → IMPLEMENT.
- `agent-skills:idea-refine` — Divergent / Convergent / Sharpen → MVP one-pager.

**Implicación para Hiper Plans:** Plan Mode + plan-document-reviewer es el reference combo oficial-de-facto. Hiper Plans debe **componer encima**, no reemplazar. El meta-prompt es la pieza que Anthropic deliberadamente deja al user → ahí cabe la skill.

**Sources clave:**
- https://code.claude.com/docs/en/best-practices
- https://code.claude.com/docs/en/permission-modes#analyze-before-you-edit-with-plan-mode
- https://lucumr.pocoo.org/2025/12/17/what-is-plan-mode/
- https://claudelog.com/mechanics/plan-mode/
- Local: `~/.claude/plugins/cache/superpowers-marketplace/superpowers/5.0.7/skills/writing-plans/{SKILL.md, plan-document-reviewer-prompt.md}`

### D.2 GitHub community patterns (top 7 vivos en 2026)

| Proyecto | Stars | Pattern principal | URL |
|---|---|---|---|
| **GitHub Spec Kit** | **71K** | Spec-anchored, 20+ agents soportados | github.com/github/spec-kit |
| claude-task-master | top-tier | PRD → MCP `parse_prd` → topological task graph (RPG, 2026) | github.com/eyaltoledano/claude-task-master |
| Cline | muy activo, v2.0 XML rewrite 2026 | **Plan/Act dual mode** + Rules + MCP, ‑40% tokens | github.com/cline/cline |
| Aider | activo, gpt-5 architect 2026 | **Architect/Editor model split** — SOTA 85.7% polyglot benchmark, ‑30-50% coste | github.com/paul-gauthier/aider |
| facebookresearch/HyperAgents | fresh ICLR 2026 | Self-rewriting meta-agent | github.com/facebookresearch/Hyperagents |
| awesome-cursorrules (PatrickJS) | high | .cursorrules templates incl. PRD/Epic | github.com/PatrickJS/awesome-cursorrules |
| spec-compare | nicho | Comparativa Spec-Kit / Kiro / BMad / OpenSpec / Tessl con git worktrees | github.com/cameronsjo/spec-compare |

**Patterns convergentes:**
1. **PRD-driven** (TaskMaster, ChatPRD): plain-text PRD → MCP tool → DAG.
2. **Spec-driven (SDD)** 3 niveles: spec-first / spec-anchored / spec-as-source. Spec Kit, Kiro, Tessl, BMad, OpenSpec.
3. **Architect/Editor split** (Aider): un modelo razona, otro genera diff. SOTA `o3-architect + gpt-4.1-editor`.
4. **Plan/Act dual mode** (Cline): primero outline, luego ejecutar.
5. **EARS syntax** (Kiro): "Easy Approach to Requirements Syntax" formal para reqs deterministas.

**Triggers que dominan:** slash commands (`/ask` `/code` `/architect`), modos discretos (Plan/Act), config files (`.cursorrules`, `.taskmaster/`), MCP tools (`parse_prd`, `expand_task`, `next_task`).

**Failures recurrentes:** PRD parsing data loss (TaskMaster #864), spec drift + hallucination (Thoughtworks 2026 lo flag), "jumbled mess" cuando agent intenta generar codebase entero, over-planning friction → mitigación = activación condicional por modo, no global.

**Recomendación community → Hiper Plans:** combinar **Architect/Editor split (Aider)** + **Plan/Act mode-gating (Cline)** + **Spec Kit-style forced template** + **self-verification step**. Evitar "spec-as-source" (overkill para ULTRON) — quedarse en "spec-anchored". EARS syntax como escape-hatch opcional.

### D.3 Blog/X discourse 2025-2026 — STRONG_CONSENSUS

**Patterns que la comunidad dice que FUNCIONAN (8+ fuentes):**
- **SDD reemplaza vibe-coding** [FRESH 2026] — `Specify → Plan → Implement → Validate`.
- **CLAUDE.md como índice corto** que referencia specs profundas, NO como container.
- **Sub-agents + worktrees + plan-mode en paralelo** — cada subagente su worktree, plans aprobados en paralelo.
- **PLANS.md / persistent markdown planning** (Manus-style — base de la $2B Manus acquisition; OpenAI Codex cookbook lo recomienda).
- **Checkable success criteria** (`npm test passes`, `curl 200`) sobre criterios interpretables ("buen código").
- **"Address all notes, don't implement yet"** — iterar el plan hasta que todas decisiones estén resueltas, ANTES de ejecutar.

**Anti-patterns explícitos:**
- Saltar Plan Mode en cambios >3 ficheros / schema / security.
- Specs vagos sin criteria checkables.
- "Idle tokens" — no paralelizar agents (Karpathy mayo 2026: 20/80 escribir/delegar).
- One-shot prompts.
- CLAUDE.md monolítico.

**Cambio 2025 → 2026:**
- Karpathy framing "vibe prompts → agent workflows" (mayo 2026).
- Context 200K+ permite codebase entera + PRD denso single-pass.
- Bifurcación copilot/autopilot (Cursor vs Devin) → PRD diferente cada uno.
- Skills empaquetadas (`cc-sdd`, `claude-code-spec-workflow`, `planning-with-files`) emergen como dominio.
- GitHub AI team promueve specs como "shared source of truth, living executable artifacts".

**Sources clave:**
- [Karpathy — Vibe Prompts to Agent Workflows](https://aintelligencehub.com/articles/karpathy-vibe-coding-to-agent-workflows-may-2026) [FRESH 2026]
- [Simon Willison — Agentic Engineering Patterns](https://simonw.substack.com/p/agentic-engineering-patterns) [FRESH 2026]
- [Addy Osmani — How to Write a Good Spec for AI Agents (O'Reilly)](https://www.oreilly.com/radar/how-to-write-a-good-spec-for-ai-agents/) [FRESH 2026]
- [Claude Code Plan Mode 2026 Guide](https://www.anyonebuilds.com/guides/claude-code-plan-mode) [FRESH 2026]
- [planning-with-files (Manus pattern)](https://github.com/othmanadi/planning-with-files) [FRESH 2026]
- [OpenAI Codex PLANS.md cookbook](https://developers.openai.com/cookbook/articles/codex_exec_plans) [FRESH 2026]

### D.4 ArXiv papers (7 con findings accionables)

| Title | arXiv | Year/Venue | Finding accionable |
|---|---|---|---|
| ReAct: Synergizing Reasoning and Acting | [2210.03629](https://arxiv.org/abs/2210.03629) | 2023 ICLR | Interleave reasoning + actions; baseline para todo agent planning |
| Plan-and-Solve Prompting | [2305.04091](https://arxiv.org/abs/2305.04091) | 2023 ACL | "Devise plan first, then execute" — el explicit-plan-first prompt structure |
| Reflexion: Verbal RL via Self-Reflection | [2303.11366](https://arxiv.org/abs/2303.11366) | 2023 NeurIPS | Memoria persistente de errores entre trials (+20% AlfWorld, +12% HotpotQA) |
| Chain-of-Verification (CoVe) | [2309.11495](https://arxiv.org/abs/2309.11495) | 2024 ACL Findings | Plan questions to verify draft → answer → revise. Reduce hallucinations |
| CodePlan: Repository-level Coding | [2309.12499](https://arxiv.org/abs/2309.12499) | 2024 ACM-SE | Dependency analysis + adaptive planning; 5/6 repos pasan validity |
| **Chain of Thoughtlessness?** | [2405.04776](https://arxiv.org/abs/2405.04776) | 2024 NeurIPS | **CRÍTICA:** CoT no generaliza OOD; gains exigen prompt examples ≈ query → activación condicional obligatoria |
| **MPO: Meta Plan Optimization** | [2503.02682](https://arxiv.org/abs/2503.02682) | 2025 EMNLP Findings | **Formaliza "meta-plan" como guidance high-level optimizada continuamente con feedback** — plan-of-plans académico |

**Síntesis para skill design:**
- Combina **Plan-and-Solve** (estructura) + **CoVe** (verification questions) + **Reflexion** (error memory cross-session) + **MPO** (meta-plan refinable con telemetría).
- **Activación por mode obligatoria** (ULTRA/HIGH); MEDIUM saltea para evitar overhead Stechly-flagged.
- Pattern Planner / Critic / Judge / Verifier es el dominante 2024-2025.

**Empirical wins:**
- GPT-4.1 cookbook: +4% pass-rate SWE-bench Verified con explicit planning prompt, +~20% en benchmark interno.
- Claude 4 Sonnet: 72.7% SWE-bench con safety-tuned CoT.
- "Intrinsic Self-Critique" (arXiv:2512.24103): 49.8% → 89.3% en su dominio.
- CodePlan: 5/6 repos pasan validity checks vs baselines.

**Crítica clave (decisión-relevante):** Stechly/Kambhampati 2024 demuestra que CoT solo ayuda cuando los ejemplos del prompt ≈ query; accuracy cae drásticamente con goal-stack size. **VALIDA empíricamente la decisión hybrid + mode-gating** (HIGH/ULTRA only, MEDIUM skip).

## E. Hybrid spec — proposal v1 (refinada tras research D.1-D.4)

### E.0 Cambios v0 → v1 (research-driven)

| Cambio | Origen |
|---|---|
| 9 sections → **11 sections** (añade NON-GOALS y VERIFICATION QUESTIONS) | D.4 CoVe + community STRONG_CONSENSUS "checkable success criteria" + ULTRON existing scope rule |
| **Persistent storage en `~/.ultron/plans/YYYY-MM-DD-<slug>.md`** como output canónico | D.3 Manus PLANS.md pattern + OpenAI Codex cookbook + community SDD spec-anchored |
| **Architect/Editor split opcional** vía hand-off al `Plan` agent oficial para architect-pass | D.2 Aider SOTA 85.7% polyglot, ‑30-50% coste |
| **plan-document-reviewer recursive verification** en ULTRA mode | D.1 Anthropic superpowers pattern oficial-de-facto |
| **EARS syntax escape-hatch** opcional para reqs deterministas | D.2 Kiro |
| **Mode-gating empíricamente justificado** (Stechly 2024 NeurIPS) | D.4 |
| Trigger reducido: solo `/hiperplan` + intent en HIGH/ULTRA. **NO hook UserPromptSubmit auto-trigger** | D.2 community failure pattern: over-planning friction |
| Naming: mantener "Hiper Plans" (Spanglish-ULTRON, consistent con tio-gilito/don-claudio/manolo-lama) | D.0 espacio terminológico abierto |

### E.1 Skill side — `~/.claude/skills/hiper-plans/SKILL.md`

```yaml
name: hiper-plans
description: |
  Meta-planning wrapper que upgrade cualquier invocación de planning con
  un template forzado de 11 secciones (Problem · Non-Goals · Constraints ·
  Inputs · MVP · Fail-Fast Order · Success Criteria · Rollback · Token Budget
  · Verification Questions · Open Questions). Activate by name ("hiper
  plans", "/hiperplan"), by intent en mode HIGH/ULTRA, o como hand-off del
  `Plan` agent oficial para architect-pass.

  Composable con: ExitPlanMode (output final), Plan agent (architect role
  via hand-off), plan-document-reviewer (recursive verification en ULTRA),
  superpowers:writing-plans (escritura final), agent-skills:spec-driven-
  development (rule gating).

  NO reemplaza Plan Mode oficial — augmenta el meta-prompt que Anthropic
  deliberadamente deja a customización del usuario.
triggers:
  - "/hiperplan|hiper plan|hyper plan"
  - "planifica.*exhaustiva|plan profundo|deep plan|spec driven"
  - mode:HIGH or mode:ULTRA (auto-invoke if planning intent detected)
priority: process (runs before implementation skills, after brainstorming)
type: rigid (don't adapt 11-section structure away)
```

### E.2 The forced 11-section template

```markdown
# {{title}} — Hiper Plan

## 1. PROBLEM
1-3 frases, sin jerga. Lo que pasa, no lo que harás.

## 2. NON-GOALS
Qué NO está en scope. Borders explícitos para evitar scope creep.

## 3. CONSTRAINTS
Qué no puede cambiar (APIs públicas, contratos, perf budget) · qué sí.

## 4. INPUTS
Files / state / data visible. Paths absolutos. Versiones.

## 5. MVP
La mínima versión útil. Lo que demuestra que el approach funciona.

## 6. FAIL-FAST ORDER
Sub-fases ordenadas para fallar lo antes posible. Lo más arriesgado primero.

## 7. SUCCESS CRITERIA (checkable)
Lista concreta, observable, NO interpretable.
- [ ] `npm test` passes
- [ ] `curl localhost:3000/health` returns 200
- [ ] Cobertura ≥ X%
NUNCA "el código está bien".

## 8. ROLLBACK
Cómo deshacer si va mal. Git ref + manual ops + rollback DB si aplica.

## 9. TOKEN BUDGET
Estimación bruta + mode (`MEDIUM ~3K · HIGH ~8K · ULTRA ~15K`).

## 10. VERIFICATION QUESTIONS (CoVe-derived)
Preguntas para auto-verify antes de claim "plan ready":
- ¿El plan asume algo que no está en INPUTS?
- ¿Cada SUCCESS CRITERIA es realmente checkable?
- ¿El ROLLBACK cubre el peor caso del MVP fallando?
- ¿El FAIL-FAST ORDER ataca el blocker mayor primero?
- ¿Algún paso requiere decisión humana sin estar en OPEN QUESTIONS?

## 11. OPEN QUESTIONS
Decisiones bloqueantes. NO se ejecuta hasta resolverlas.
- HP-X: ...
- HP-Y: ...

---
> *Hiper Plan — generated YYYY-MM-DD HH:MM by ULTRON. Persisted at
> `~/.ultron/plans/YYYY-MM-DD-<slug>.md`. Plan-of-plans: this file IS the
> living artifact for the task; refinable via MPO-style feedback.*
```

### E.3 Internal flow

1. **Detect** invocation: by name (`/hiperplan`), by intent in HIGH/ULTRA, or by `Plan` agent hand-off.
2. **Read context**: user request + current files + memory + previous plans en `~/.ultron/plans/`.
3. **(Optional, ULTRA only)** Hand off to `Plan` agent for architect-pass (research-only, devuelve diagnóstico).
4. **Render template** con las 11 secciones rellenas con primer pase.
5. **Self-verify** vía VERIFICATION QUESTIONS (CoVe). Si alguna falla → revisar el plan, NO publicar.
6. **(Optional, ULTRA only)** Dispatch `plan-document-reviewer` agent para recursive verification (alineado con superpowers oficial-de-facto pattern).
7. **Persist** a `~/.ultron/plans/YYYY-MM-DD-<slug>.md` (Manus pattern).
8. **Surface OPEN QUESTIONS** vía AskUserQuestion antes de declarar plan-ready.
9. **Hand off** via `ExitPlanMode` o pasar a implementación según mode.

### E.4 Overlay side — ULTRON `/high` y `/ultra`

- Modificar `~/.claude/skills/ultron/scripts/cockpit/mode-trigger.py` (UserPromptSubmit hook ya existe).
- Detector de planning intent (regex pragmático, no ML — community failure pattern dice "no over-engineer triggers"):
  ```
  intent_planning = re.compile(
    r"\b(plan|estrategia|diseña|arquitectura|roadmap|spec|"
    r"refactor.*completo|implementa.*\w+(en\s+)?(\d+|varias?)\s*fase)",
    re.IGNORECASE)
  ```
- Solo dispara en mode=HIGH o mode=ULTRA. MEDIUM y LOW NUNCA disparan (Stechly-validated).
- ULTRA añade architect-pass + plan-document-reviewer recursive verification.
- HIGH se queda con la skill sola (sin recursive review) por token-budget.

### E.5 Token budget per mode (re-evaluado)

| Mode | Activación | Architect-pass | Recursive review | Estimated overhead |
|---|---|---|---|---|
| LOW | ❌ forbidden | ❌ | ❌ | 0 tok |
| MEDIUM | ❌ skip | ❌ | ❌ | 0 tok |
| HIGH | by name OR intent | ❌ | ❌ | +1.5K-3K tok |
| ULTRA | by name OR intent (≥30 min tasks) | ✅ Plan agent fork | ✅ plan-document-reviewer fork | +5K-12K tok |

Empirical anchor: GPT-4.1 cookbook reportó +4% SWE-bench con explicit planning. ULTRON acepta el cost en HIGH/ULTRA porque las tasks de esos modes son las que justifican el overhead (Stechly-aligned).

### E.6 Composability matrix

| Tool/Skill | Relación con Hiper Plans |
|---|---|
| `ExitPlanMode` (Anthropic) | Receptor final del plan; Hiper Plans NO lo reemplaza, lo alimenta. |
| `Plan` agent (Anthropic) | Hand-off para architect-pass en ULTRA mode (Aider split). |
| `superpowers:writing-plans` | Hiper Plans extiende su template; comparten persistencia en `~/.ultron/plans/`. |
| `superpowers:plan-document-reviewer` | Invocado en ULTRA mode para recursive verification. |
| `agent-skills:spec-driven-development` | SDD gate (SPECIFY → PLAN → TASKS → IMPLEMENT) puede envolver Hiper Plans. |
| `superpowers:brainstorming` | **Antes** que Hiper Plans (process priority — brainstorm explora, Hiper Plans estructura). |
| `agent-skills:idea-refine` | **Antes** si hay ambigüedad de problem statement. |
| ULTRON `/dual` `/maxdual` `/triple` | **Después** del plan — peer-review de la spec, no del código. |

EARS syntax escape-hatch: documentar pero NO hacer mandatory. User puede invocar `--ears` flag si la spec necesita reqs deterministas tipo aviónica.

## F. Validation criteria

| Check | Acceptance |
|---|---|
| Skill discoverability | Manifest contains `hiper-plans` after registry sync |
| Trigger by name | "hiper plan" / "/hiperplan" loads skill content reliably |
| Trigger by intent | 80%+ recall on test corpus de 20 prompts hand-labeled como "needs planning" |
| Forced structure | Output del skill contains TODOS los 9 sections (PROBLEM..OPEN QUESTIONS) |
| Mode gating | MEDIUM mode never auto-invokes skill (verified via routing.jsonl) |
| Composability | Plan Mode oficial + hiper-plans co-exist sin conflict |
| Token honesty | Real tokens consumed ≤ E.3 budget × 1.3 (30% slack) |

Test corpus: hand-label 20 prompts en `~/.claude/skills/hiper-plans/tests/intent-corpus.md`.

## G. Roadmap (PENDING — set tras research integration)

### Phase R — Research integration ✅ COMPLETE (2026-05-08, ~1h actual)
- [x] Findings fork A integrados en D.1
- [x] Findings fork B integrados en D.2
- [x] Findings fork C integrados en D.3
- [x] Findings fork D integrados en D.4
- [x] Spec E refinada v0 → v1 (8 cambios documentados en E.0)
- [x] Decisions HP-1..HP-8 resueltas en Sección H
- [x] Open questions resueltas en Sección I

### Phase 1 — Spec freeze ✅ COMPLETE (incluido en Phase R)
- [x] E.1 (skill yaml) lockeada
- [x] E.2 (11-section template) lockeado
- [x] E.3 (internal flow) lockeado
- [x] E.4 (overlay regex) lockeado
- [x] E.5 (token budget) lockeado
- [x] E.6 (composability matrix) lockeada

### Phase 2 — Skill build ✅ COMPLETE (commit fc5c46a)
- [x] `~/.claude/skills/hiper-plans/SKILL.md` con frontmatter + 11-section template doc + composability matrix
- [x] `~/.claude/skills/hiper-plans/template.md` — esqueleto canónico de las 11 secciones
- [x] `~/.claude/skills/hiper-plans/tests/intent-corpus.md` — 20 prompts hand-labeled + 3 edge cases
- [x] Registry sync via `ultron skills registry propagate` — propagado a codex + agents
- [x] Manifest sync 392 → 393 entries, drift 0, schema válido

### Phase 3 — Overlay wiring ✅ COMPLETE (commit fc5c46a)
- [x] `_HIPER_PLANS_NAME_RE` + `_HIPER_PLANS_INTENT_RE` en `mode-trigger.py`
- [x] `_detect_hiper_plans_signal()` con LOW hard-forbidden + MEDIUM nunca-por-intent
- [x] `_log_hiper_plans_signal()` JSONL telemetry append-only
- [x] Hook NO inyecta — telemetría solo (Stechly-aligned)
- [x] Unit test 3 casos (by-name / by-intent HIGH / skip): 3/3 correct

### Phase 4 — Compile gate + commit ✅ COMPLETE (commit fc5c46a)
- [x] py_compile mode-trigger.py: OK
- [x] Smoke test unit-level: log writer escribe correctamente
- [x] doctor: 0 blocking, 170 warn pre-existentes (1 menos que v14.2.0 baseline)
- [x] deadwood: 0 blocking, 11 warn pre-existentes
- [x] Commit `feat(hiper-plans): meta-planning skill + HIGH/ULTRA overlay (v14.3.0)`
- [x] `references/changelog.md` v14.3.0 entry

### Phase 5 — Real-world validation (PENDING — 1 sesión natural)
- [ ] Usar la skill en una tarea real (next time USER invoque `/high` o `/ultra`)
- [ ] Auditar `~/.ultron/.tmp/hiper-plans-signals.jsonl` para ver triggering accuracy
- [ ] Medir: ¿ahorra back-and-forth de questions? ¿saca scope creep antes?
- [ ] Tune regex con datos reales del corpus telemetría
- [ ] Considerar Phase 6 (futuro): MPO-style refinement loop sobre los plans persistidos

**Total estimado:** 4-5 h actual ≈ 4 h ejecutadas (Phase R + 1 + 2 + 3 + 4). Phase 5 = sesión natural cuando aparezca el caso.

## H. Decisions log — RESOLVED tras research integration

| ID | Question | Decision | Rationale |
|---|---|---|---|
| **HP-1** | Trigger exacto | `/hiperplan` (full) + intent regex en HIGH/ULTRA. **NO** `/hp` (colisiona con health). **NO** auto-trigger MEDIUM. | D.4 Stechly + D.2 over-planning anti-pattern. |
| **HP-2** | Sections fixed o configurable | **11 fixed**. Tipo `rigid`. EARS syntax es escape-hatch opcional, no reemplaza secciones. | D.2 Spec Kit converge en template forzado; configurabilidad → drift. |
| **HP-3** | Auto-invoke threshold | **Regex pragmático** sobre keywords planning + mode HIGH/ULTRA. NO ML classifier. | D.2 community: "no over-engineer triggers, regex + mode-gate funciona". |
| **HP-4** | Composability con `Plan` agent | **Hand-off architect-pass solo en ULTRA**. HIGH se queda con la skill sola. | D.2 Aider split SOTA + D.4 token cost de architect agent justified solo en ULTRA. |
| **HP-5** | Token budget enforcement | **Soft warning** en E.5 budget table; surface real consumption en logs post-run. NO hard cap (rompería tasks legítimas). | D.4 sin evidencia que hard cap mejore outcomes; soft visibility suficiente. |
| **HP-6** | Persistent storage location | `~/.ultron/plans/YYYY-MM-DD-<slug>.md` siguiendo Manus + writing-plans pattern. | D.3 STRONG_CONSENSUS (8+ fuentes) + alineado con plans dir existente ULTRON. |
| **HP-7** | Naming: rebrand a "Hyper Plans"? | **Mantener "Hiper Plans"** (Spanglish-ULTRON, consistent con tio-gilito/don-claudio/manolo-lama). | D.0 espacio terminológico vacío; branding ULTRON ya hispano-mixto. |
| **HP-8** | Recursive verification (plan-document-reviewer) | **Solo ULTRA mode**. HIGH no recurre (token cost). | D.1 Anthropic pattern de facto + E.5 budget. |

## I. Open questions — RESOLVED tras research

1. **¿Anthropic tiene skill equivalente?** No. Plan Mode oficial es runtime mode (read-only enforcement); meta-prompt deliberadamente dejado al user. `superpowers:writing-plans` y `agent-skills:planning-and-task-breakdown` son **community** (Obra y addy-osmani). Espacio para wrapper-skill confirmed legítimo.

2. **¿SSOT estructura de plan en 2026?** No exact SSOT. **STRONG_CONSENSUS** en: spec-anchored + checkable success criteria + sub-agents + worktrees + persistent markdown. Hiper Plans 11-section template es síntesis de esos consensos.

3. **¿Evidencia empírica structured > CoT plain?** Sí pero con caveat. GPT-4.1 cookbook +4% SWE-bench con explicit planning. Pero Stechly NeurIPS 2024 demuestra que CoT no generaliza OOD → activación condicional obligatoria. **Justifica el mode-gating.**

4. **¿Plan Mode oficial extensible?** No directamente. Plan Mode es runtime mode con tool allowlist enforcement. Hiper Plans extiende **el meta-prompt** (lo que Anthropic deja libre), no el runtime. Composable: Hiper Plans → ExitPlanMode hand-off.

## J. Appendix — fork directives (para reproducibilidad)

> Fork A: Anthropic official planning research
> Fork B: GitHub community planning patterns (TaskMaster, Cline, Stagehand, etc.)
> Fork C: Blog/X discourse 2025-2026 sobre planning prompts
> Fork D: ArXiv papers sobre LLM agent planning + meta-planning

Cada fork devuelve digest ≤300 palabras + 5-8 citas con URLs/arXiv IDs. Flagged: cualquier mención literal de "hiper plans" o "hyper plans" en cualquier fuente.

---

*End of draft. Awaiting fork returns to fill Sección D + refine Sección E. Sección G y H se finalizan en Phase R.*
