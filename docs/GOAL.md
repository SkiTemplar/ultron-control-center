# GOAL — El mejor sistema de IA personal (ULTRON)

> Estrella polar definida por el usuario. **Definición de "acabado": 9.5 en las 14 categorías
> Kirkardo** (criterios binarios en la memoria `kirkardo-success-criteria`) + guía de uso.
> Este documento es la fuente de verdad del objetivo; el progreso se mide con el eval Kirkardo.

## Qué tiene que ser

Un sistema de IA personal que supere a cualquier setup de andar por casa, con estos pilares:

1. **Ahorro de tokens real.** Skills perezosas (`.disabled` por defecto), filtrado de salidas
   con **RTK** (60-90%), modo justo para cada tarea y MCPs mínimos.
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

6. **Mejora de prompting automática.** El sistema afina el prompt del usuario (clarifica intent,
   añade contexto/constraints, elige modo) ANTES de ejecutar. `prompt-optimizer` cableado como
   paso previo del orquestador, no como skill huérfana. → cat13.

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

Baseline (criterios binarios, 2026-06-08): **overall 5.24** (33/63 checks). Objetivo: **9.5 en todas**.

## Regla de medición

La nota NO la pone un agente: la da el contador de checks binarios por categoría
(`nota = checks_verdes / total * 10`). Todo hallazgo se verifica en **runtime** antes de actuar
(el propio eval Kirkardo también alucina). Binario fresco = aplicado (rebuild + cerrar la app antes
de buildear). El feedback literal del usuario ES el entregable.
