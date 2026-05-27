# Kirkardo · Evaluación D — Workflows + Agents + Skills + Orquestación

**Fecha:** 2026-05-26 · **Modo:** profesor estricto · **Sin clemencia**

## Resumen (3 líneas)

El sistema tiene huesos correctos (workdays con `workflow_template`, agents pinned por proyecto, skill `ultron` como router) pero la orquestación es teatro: los 7 workflows son strings hardcoded sin ejecutor, no hay hand-off real entre agentes, y la UI de proyecto duplica una lista DIFERENTE de workflows con pill "Beta". El objetivo de USER ("activa ultron, hazme X, valida con tests, equipo entero ejecuta") está a un 25% — falta el motor: schema declarativo, runtime con shared_context, y una skill orquestadora que dispare `workflow_run`.

---

## Notas por dimensión

### Plantillas workflow (7 templates) — **3/10**
La doc `workflows-best-practices-2026.md` define un schema rico (sección 5): `agents[{slug,role,prompt,model}]`, `hand_off`, `completion_criteria`, `deliverables`, `context_keys`. El código en `agent_orchestration.rs:99-239` reduce esto a `WorkflowStep { agent, note }`. Sin prompt, sin role, sin model, sin criterios. Son etiquetas. Además, `ProjectAgents.tsx:63-92` define OTROS 4 workflows (chief-of-staff/backend-review/frontend-review/code-audit) que no coinciden con los 7 del backend. Dos fuentes de verdad. La pill "Beta" lo confiesa: nada ejecuta.

### Hand-off entre agentes — **2/10**
`delegate_task_inner` spawn-ea **una** sesión Claude con `flags.agent = Some(slug)`. No retorna output programáticamente, no encadena, no pasa contexto al siguiente agente. `workdays.rs` tiene `WorkdayContext { notes, decisions, file_changes, agent_messages }` que sería el bus perfecto — pero ningún agente lo escribe automáticamente. La doc menciona `kanban.on_move → workday.create → agent_orchestration.run` (roadmap P0), pero `run` no existe. Cada agente delegado es una isla.

### Skill dispatch / orquestador — **3/10**
La skill `ultron` (SKILL.md v15.4.20) es un **router** ("Selector de modo · Fast path · Skill alignment"), no un orquestador. Define qué persona usar, no ejecuta workflows con validación. `references/skill-alignments.md` describe las 7 alineaciones en prosa (`terry-davis → kirkardo`), pero es texto para que el modelo lo lea, no una máquina de estados. **Falta crear** `ultron-orchestrator` como skill ejecutora distinta de `ultron` router.

### Validación con tests integrada — **2/10**
`completion_criteria: ["tests_pass", "coverage_gte_80"]` aparece SOLO en la doc. En código `WorkflowDefinition` no tiene ese campo. No hay hook que corra `cargo test` / `npm test` y bloquee finalización. Kirkardo aparece como step pero su "validación" es una nota textual sin contrato. Los `completion_criteria` están especificados, no implementados.

### Reusabilidad (user-defined vs hardcoded) — **2/10**
Los 7 workflows están **hardcoded en Rust** (`list_workflows_inner` con `vec![...]`). La doc recomienda `~/.ultron/cockpit/workflows/*.json` (roadmap P0) — no implementado. USER no puede crear un workflow custom sin recompilar el binario. UI editor (P2 en roadmap) inexistente. La extensibilidad es teórica.

### Diferenciador vs vanilla Claude Code — **4/10**
Lo que ULTRON CC **sí aporta hoy** sobre Task tool puro: (a) workdays con timeline persistente (`workdays.rs`), (b) pinned agents por proyecto (`ProjectAgents.tsx`), (c) "Launch all" multi-terminal con roles, (d) UI de descubrimiento (Blocks/Tree/Grid en `Agents.tsx`). Lo que **NO** aporta: orquestación real, hand-off automático, validación, shared memory entre agentes. Un usuario con Claude Code puro + Task tool en paralelo obtiene lo mismo escribiendo el coordinador en el chat. El diferenciador prometido (sistema de empleados con comunicaciones) **no existe en runtime**.

---

## SPEC: skill `ultron-orchestrator` (pseudocódigo ~30 líneas)

```
---
name: ultron-orchestrator
description: >
  Use when USER says "activa módulo ultron", "lanza el equipo para X",
  "hazme X y valida con tests". Ejecuta workflows declarativos con
  hand-off automático, shared context vía workday, y completion gates.
triggers: ["activa ultron", "modo orquestador", "equipo para", "/orchestrate"]
---

PROCEDURE orchestrate(user_goal):
  1. workflow = invoke("workflow_match", { goal: user_goal })
     // backend NLP → devuelve workflow_id + missing_params
     if workflow.confidence < 0.7: ASK USER to pick from list
  2. workday = invoke("workday_open_or_link", { project_cwd, workflow_id })
  3. ctx = WorkdayContext()  // notes, decisions, file_changes, agent_messages
  4. FOR step IN workflow.agents:
       payload = render_prompt(step.prompt, ctx, user_goal)
       result = invoke("workflow_run_step", {
         workflow_id, step_id: step.slug, agent: step.slug,
         model: step.model, prompt: payload, shared_ctx: ctx,
         worktree: workflow.isolation, turn_cap: 20
       })
       ctx.append(step.slug, result.deliverables, result.decisions)
       invoke("workday_append_context", { workday_id, entries: result })
       IF step has completion_check:
         ok = invoke("workflow_check_gate", { criteria: step.gates })
         if not ok: PAUSE → ask USER (continue / fix / abort)
  5. final_gate = invoke("workflow_check_gate", { criteria: workflow.completion_criteria })
     // tests_pass / coverage_gte_80 / no_critical_findings → shell commands
  6. IF final_gate.passed: invoke("workday_complete", { workday_id, deliverables: ctx.deliverables })
     ELSE: report failed gates, leave workday in_progress
  7. invoke("mem0_store", { tags: [workflow_id, project_id, "outcome"] })
  8. RETURN summary(ctx, deliverables, cost, duration)
```

### Comandos backend NUEVOS necesarios

| Comando | Propósito | Archivo |
|---|---|---|
| `workflow_match(goal)` | NLP → workflow_id + confidence | `agent_orchestration.rs` |
| `workflow_run_step(step, ctx)` | Spawn agente, captura output programáticamente (no PTY), devuelve `{deliverables, decisions, files_changed}` | `agent_orchestration.rs` |
| `workflow_check_gate(criteria)` | Corre `tests_pass`/`build_passes`/`coverage_gte_80` via shell hooks | `gates.rs` (nuevo) |
| `workday_append_context(entries)` | Ya existe parcial — extender para que agentes lo llamen automáticamente | `workdays.rs` |
| `workflow_load_userdefined()` | Lee `~/.ultron/cockpit/workflows/*.json` | `agent_orchestration.rs` |
| `mem0_store(tags, payload)` | Persistir outcome a L1.5 mem0 | `memory/mem0.rs` (nuevo) |

### Bloqueadores actuales

1. `delegate_task_inner` no captura output del subagente — solo lanza PTY. Sin captura no hay hand-off.
2. `WorkflowDefinition` necesita expandirse al schema completo de la doc (sección 5).
3. Resolver duplicación: `ProjectAgents.WORKFLOWS` (4 ad-hoc) vs `list_workflows_inner` (7 canónicos). **Eliminar el primero**, usar el endpoint backend.

**Veredicto Kirkardo:** la documentación está al 9/10, el runtime al 3/10. Hasta que `workflow_run_step` exista con captura programática y `workflow_check_gate` corra comandos reales, el sistema de empleados es un PowerPoint con botones bonitos.
