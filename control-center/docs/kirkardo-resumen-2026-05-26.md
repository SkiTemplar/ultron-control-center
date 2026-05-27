# KIRKARDO — Resumen consolidado 5 evaluaciones (2026-05-26)

5 evaluaciones independientes del Control Center. Tono Kirkardo: profesor estricto,
sin paños calientes.

---

## Tabla resumen

| # | Dominio | Nota | Veredicto |
|---|---|---|---|
| A | Frontend React/TS | **4.5/10** | Aprobado raspado — TS bueno, Projects.tsx 3594L, cero tests |
| B | Backend Rust | **5.5/10** | Aprobado raspado — tests 3/10, race conditions sin Mutex |
| C | Memoria multi-capa | **3.5/10** | Suspenso — mem0 único fiable, hooks míos queman tokens |
| D | Workflows/agents/skills | **~2.7/10** | Suspenso fuerte — runtime hueco, hand-off ausente |
| E | AI Router | **3.5/10** | Decorativo — el router no enruta nada |

**Promedio global: 3.9/10 — SUSPENSO BLANDO**

---

## Hallazgos críticos (los 5 que más duelen)

1. **AI Router decorativo** — `grep ai_router_` fuera de `AIRouter/` y `lib.rs` = **cero hits**. Ningún feature usa el router. Fallbacks persistidos pero nunca invocados. `cost_per_mtok` jamás se multiplica.

2. **Workflows sin hand-off real** — `delegate_task_inner` spawna PTY pero **no captura output**. Sin captura no hay comunicación entre agentes. El "sistema de empleados con comms" del objetivo final está en doc, no en código.

3. **Race conditions** — `kg.rs:131-162` y `workdays.rs:182,958` y `ai_router.rs` storage hacen read-modify-write SIN Mutex. Dos comandos Tauri concurrentes pierden entidades.

4. **Memoria fragmentada** — Mem0 es la única pieza fiable. KG y ecc_memory cajas vacías sin escritor. Mi hook `load-cross-project-memory.js` quema 18000 chars de markdowns sin consultar mem0.

5. **Sin tests frontend** — 0 vitest, 0 playwright en `package.json`. `Projects.tsx` 3594L (4.5× el límite). Tokens mem0 + github en plaintext en `settings.json`.

---

## TOP 10 acciones priorizadas (orden de impacto)

| # | Acción | Doc fuente | Prioridad |
|---|---|---|---|
| 1 | Implementar captura de output PTY en `delegate_task_inner` (bloqueador de orquestación) | Kirkardo D | P0 |
| 2 | Crear skill `ultron-orchestrator` con 6 comandos nuevos (`workflow_match`, `workflow_run_step` etc.) | Kirkardo D | P0 |
| 3 | Reemplazar `load-cross-project-memory.js` por search a mem0 (top_k=10, filter cwd+fecha) | Kirkardo C | P0 |
| 4 | Schema fijo `{decisions, files, next_steps, blockers}` en `mem0-sync.js::buildMemoryText` | Kirkardo C | P0 |
| 5 | Implementar `ai_router_request` con fallback chain real + writer metrics | Kirkardo E | P0 |
| 6 | Añadir Mutex/file lock en `kg.rs`, `workdays.rs`, `ai_router.rs` storage | Kirkardo B | P1 |
| 7 | Rotar token mem0 + mover a env `MEM0_API_KEY` | Kirkardo B / Memory verify | P1 |
| 8 | Migrar al menos 1 feature del CC a usar el AI Router (ej. routing-decision) | Kirkardo E | P1 |
| 9 | Refactor `Projects.tsx` (3594L) — split en sub-modules + lazy load | Kirkardo A | P1 |
| 10 | Añadir vitest + RTL + playwright para flujos críticos | Kirkardo A | P1 |

---

## Lo que SÍ está bien (cosas a no romper)

- **TypeScript strict** (Kirkardo A 8/10) — casi cero `any`.
- **Workdays redesign de hoy** — 4/4 tests, cargo + tsc clean.
- **Patrón `spawn_blocking + inner` en commands** (Kirkardo B 7/10 API design).
- **Hooks de memoria nuevos funcionan** (verificados exit 0), aunque hay que afinarlos.
- **Mem0 cloud HTTP 200 con `Token` prefix** — la única pieza fiable de memoria.
- **Mem0-sync hook** se ejecuta en Stop, 13 escrituras al log con status 200.

---

## Recomendación del que escribe esto

Antes de cualquier feature nueva, atacar los puntos 1-5 de la lista TOP 10.
Sin captura PTY no hay orquestación. Sin search mem0 no hay recall útil. Sin
`ai_router_request` el router es UI muerta. Estos 3 desbloqueos transforman
el sistema de "doc bonita + UI bonita" a "sistema funcional".

---

*5 KIRKARDOS — sesión 2026-05-26. Reports individuales en
`docs/kirkardo-{A,B,C,D,E}-*-2026-05-26.md`.*
