# Workdays rework — spec (workflow audit+design 2026-05-30)

Auditoría (3 exploradores) + diseño. Hallazgo: Workdays ya tiene mucho montado
(timeline 24h H30, goals con add/edit/auto-fill, wipe/clean-start H29). Los gaps
reales vs lo que pidió USER:

## ✅ HECHO — Quitar templates (commit de esta sesión)
USER: "templates no me sirve". Eliminado: lane `templates` en index.tsx,
componente `WorkdayTemplates.tsx`, interface `WorkflowTemplate` (types.ts),
comandos `workday_list_templates` / `workday_start_with_template` (commands +
lib.rs). Quedan como `pub fn`/struct internos en workdays.rs (dead-ish, limpiar
luego — no rompen). Header pasa de 4 lanes a 3: **Day · Today · History**.

## PENDIENTE — Auto-info vía IA (lo otro que pidió: "que fuese automático lo de contexto")
La tubería ya existe a medias (`workday_goals_auto_fill` usa `ai_router::route("utility")`).
Falta el **resumen automático de la jornada**:
- **Modelo:** `Workday.ai_summary: Option<WorkdayAiSummary>` con `#[serde(default)]`
  (`{ text, generated_at, model, source:"auto"|"manual", covers_until }`).
- **Backend nuevo:** `ai_summary_generate_inner(workday_id)` — compone prompt con
  goals + context.notes/decisions/file_changes acumulados desde `covers_until`,
  llama `ai_router::route("utility", prompt)`, guarda el markdown en el workday
  (atomic, bajo WORKDAY_WRITE_LOCK). Fallback: si IA falla, conserva el summary
  anterior (nunca dejar en blanco). Comando `workday_ai_summary_generate(id)`.
- **Frontend:** panel "Resumen IA" en WorkdayDetail (markdown ligero + "actualizado
  hace Xm" + botón "Regenerar"). Reutiliza WorkdayDaySummary como contenedor.
- **Scheduling:** la task `UltronWorkdayAutoUpdate` (cada 15min) ya existe; extender
  `workday-auto-update.js` para que tras volcar la nota auto_update invoque la
  regeneración del resumen del workday activo. `covers_until` evita reprocesar todo
  el día por tick. (Coste: route utility es barato; hook COST CRITICAL es notional.)

## PENDIENTE (nice-to-have, USER no lo pidió explícito)
- **Goals priority + hora:** WorkdayGoal += `priority(P0/P1/P2)`, `planned_hour`,
  `completed_hour` (set al marcar Done). GoalsSection con chip de prioridad + select
  de hora; ordenar por priority. build_hour_blocks asigna goal_ids por slot.
- **Hour labels semánticos:** HourBlock += `label` (etiqueta IA de qué se hizo esa
  hora) + `goal_ids`. El timeline los pinta.
- **Clean-start refuerzo:** checkbox opcional "también limpiar sesiones/links" en
  WorkdayWipeButton (hoy solo borra wd-*.json). Test: el ZIP precede al delete y NO
  incluye secretos (riesgo cazado 2026-05-29 con .credentials.json).

## Orden de build restante (incremental, cada paso cargo/tsc-verde)
1. ai_summary struct + campos `#[serde(default)]` (cargo verde, wd-*.json siguen deserializando).
2. types.ts espejo.
3. `ai_summary_generate_inner` + comando (cargo verde; probar manual sobre un wd activo).
4. Panel "Resumen IA" en WorkdayDetail (tsc verde).
5. Cablear regeneración cada 15min en workday-auto-update.js (probar un tick).
6. (opcional) goals priority/hora + hour labels.
7. (opcional) clean-start checkbox + test de ZIP.

## Riesgos
- Backward-compat serde: TODO campo nuevo `#[serde(default)]`; NO borrar
  `workflow_template`/`template_id` del struct (los wd-*.json en disco los traen).
- Concurrencia: `ai_summary_generate_inner` debe tomar `WORKDAY_WRITE_LOCK` (Mutex).
- PS 5.1 em-dash: si se editan .ps1 del task scheduler, ASCII puro.
