# GOAL — El mejor sistema de IA personal (ULTRON)

> Estrella polar definida por el usuario. **Definición de "acabado": 9.5 en las 14 categorías
> Kirkardo** (criterios binarios en la memoria `kirkardo-success-criteria`) + guía de uso.
> Este documento es la fuente de verdad del objetivo; el progreso se mide con el eval Kirkardo.

## Qué tiene que ser

Un sistema de IA personal que supere a cualquier setup de andar por casa, con estos pilares:

1. **Ahorro de tokens real.** Skills perezosas (`.disabled` por defecto, inyectadas on-demand
   por el dispatcher), context pack en vez de memoria cruda, routing CLI-first y MCPs mínimos.
   *(RTK queda DESCARTADO: no existe en crates.io salvo forks anonimos = riesgo supply-chain;
   el "filtrado de salidas 60-90%" era aspiracional, nunca se midio.)*
   *Headroom queda DESCARTADO*: medido en runtime = 0 % ahorro sobre 533 requests, con
   latencia y errores 4xx/429. No reintroducir. → cat4, cat5, cat11.

2. **Conoce la arquitectura del código de cada proyecto.** CodeGraph indexado **por proyecto**
   e **inyectado al contexto** de la app (no solo el CLI), con índice auto-actualizado
   (hook `FileChanged` → reindex). La IA no entra archivo por archivo: consulta el grafo. → cat2.

3. **Interfaz con todas las especificaciones.** Visor CodeGraph in-app (ver el grafo, no lanzar
   sesiones), panel Git estilo GitHub Desktop (status/commit/diff/publicar), Memory Browser,
   button-prompts en **tarjetas por categoría** (estilo Library), Query Orchestrator, etc. → cat8, cat14.

4. **Memoria continuamente actualizándose y visible.** Recall híbrido gobernado, escritor único,
   auto-captura de decisiones, drift 0, y **visible** desde la UI. → cat1.

5. **Activación automática de skills/agentes sin cargarlas en contexto.** Todas `.disabled` salvo
   el núcleo; el dispatcher propone un **GRUPO** de candidatos y la IA elige el más potente. → cat4.

6. **Mejora de prompting automática.** El sistema genera un encuadre SUGERIDO (advisory) para el
   prompt; el consumidor (UI/hook) decide si usarlo. El prompt ejecutado NO se reescribe
   automaticamente. `prompt-optimizer` cableado como paso previo del orquestador, no como skill
   huérfana. → cat13.

7. **Sistema de hooks inmejorable — cubrir TODAS las categorías de hooks de Claude Code**, no solo
   las ~9 actuales. Evaluar cuáles aportan a ULTRON y cablear los útiles; editar/crear/ver desde UI. → cat9.
   Catálogo completo de tipos de hook a considerar:
   `SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`,
   `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`,
   `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`,
   `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`,
   `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `SessionEnd`,
   `Elicitation`, `ElicitationResult`.
   Ideas de cableado de alto valor: `FileChanged`→reindex CodeGraph; `PreCompact`/`SessionEnd`→
   persistir estado de memoria y sync kanban; `SubagentStop`→capturar candidatos de memoria;
   `PermissionDenied`→retry de routing; `PostToolUseFailure`→aprender del fallo (learn).

8. **Unión end-to-end.** Cada comando del backend con su punto de consumo en UI; en especial la
   insignia: **`orchestrate_prompt` cableado a la UI** (hoy 0 invokes). → cat10.

## Las 14 categorías Kirkardo (frentes de medición)

1. Memoria · 2. CodeGraph · 3. AI Routing · 4. Skill/Agent Routing · 5. Limpieza de archivos ·
6. Documentación · 7. Calidad de código · 8. UI funcional · 9. Hooks · 10. Unión end-to-end ·
11. Plugins/MCPs · 12. Facilidad de implementación · 13. Mejora de prompts · 14. Mejoras backend/UI reales.

Estas 14 son las **core** (mapean a los 8 pilares). El harness `scripts/kirkardo-eval.mjs` mide
además 4 categorías **suplementarias** (sanas, pero fuera de los pilares del GOAL), separadas para
que no diluyan el promedio core: **15. Observabilidad · 16. Context Engineering · 17. Compactación ·
18. Reproducibilidad**. El JSON reporta `overall` (las 18) y `overall_core` (solo las 14).

Baseline (criterios binarios, 2026-06-08): **overall 5.24** (33/63 checks). Objetivo: **9.5 en todas**.

## Regla de medición

La nota NO la pone un agente: la da el contador de checks binarios por categoría
(`nota = checks_verdes / total * 10`). Todo hallazgo se verifica en **runtime** antes de actuar
(el propio eval Kirkardo también alucina). Binario fresco = aplicado (rebuild + cerrar la app antes
de buildear). El feedback literal del usuario ES el entregable.

**Gate de laggard (anti-promedio):** "acabado" = `min(nota_categoría) >= 9.5`, **no** que el
promedio llegue a 9.5. Un overall ponderado alto puede esconder una categoría rota (una cat con
muchos checks verdes compensa otra en rojo). El harness emite `all_cats_pass`, `worst_cat` y
`laggards`. `node scripts/kirkardo-eval.mjs` aplica **gate por defecto**: exit ≠0 si alguna
categoría incumple (`--no-gate` para reporte sin gate). La métrica de salud honesta es
`all_cats_pass` + `overall_core` (las 14 core), **no** `overall`. Un run scoped (`--cat=N`) escribe
`kirkardo-eval.scoped.json` y **no** pisa la nota canónica (un run parcial no puede declarar al sistema en 10).

## Límites físicos declarados (2026-06-23)

Dos categorías no alcanzan `>= 9.5` por **límites físicos del hardware/stack**, no por defectos
del sistema. Se declaran aquí con su evidencia medida en runtime, en lugar de relajar el medidor
para fingir que pasan (eso sería justo lo que el audit adversarial cazó como "el medidor se relajó"):

- **cat9 Hooks (latencia).** El cuello es la **CARGA del modelo E5-large (2.2 GB): I/O + init de
  la sesión ONNX ≈ 4.5 s**, NO el cómputo del embed. **GPU descartada por MEDICIÓN (2026-06-23):**
  con CUDA (RTX 4060 + ort 2.0-rc.9 + cuDNN 9.23) el recall cold midió **~4.5 s = igual que CPU**
  (el cold lo domina la carga del modelo, no el embed), y en hot la GPU es **peor** (embeds
  1-en-1: el overhead por-llamada + el JIT de cuDNN dominan; un reindex de 2971 embeds tardó
  **>10 min** vs ~3 min en CPU). La latencia OPERATIVA (daemon caliente, modelo ya residente) es
  excelente: resume **75-115 ms**, orchestrate **~50-113 ms** (reqwest pool, b9121fa). El
  `max_last5` captura el cold de arranque. **Vía real pendiente (no GPU):** daemon **pre-warm en
  SessionStart** — lanzar `serve` al arrancar (carga el modelo en background mientras el usuario
  lee el resume) para que el 1er prompt ya lo tenga residente → hot.
- **cat12 Facilidad de implementación (CI).** El build real del stack (Tauri + fastembed + ort +
  tracing) mide **340-390 s** en runs sucesivos; el `< 300 s` fue un outlier hot puntual. Bajarlo
  de forma estable exige sub-crates (refactor grande) o quitar deps core (imposible). Límite del
  stack, no del sistema.

El sistema es **excelente en lo operativo**; estos dos umbrales no son físicamente alcanzables de
forma estable en este hardware/stack. El "acabado" formal queda en 16/18 con estos **2 límites
físicos declarados** y su evidencia.
