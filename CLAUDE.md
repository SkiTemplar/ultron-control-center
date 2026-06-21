# CLAUDE.md — ULTRON Control Center

Instrucciones de proyecto para trabajar en este repo. Se carga automáticamente cada sesión. **Mantener conciso y veraz** (cuesta contexto en cada sesión).

## Qué es

ULTRON Control Center: app **Tauri 2 + React 19 + Rust** (`control-center/`, v2.7.1) — orquestador multi-IA + memoria gobernada + routing de skills/agentes + kanban/RunBatch. Monorepo único en `~/.ultron/` (un solo `.git`, sin submódulos). Responder siempre en **Español** (con tildes/ñ).

## Build y ejecución — GOTCHAS (causan la mayoría de líos)

- **`npm run build:local`** (desde `control-center/`) = build de esta máquina: incluye la pestaña **Finance** (`VITE_FINANCE=1`) + `--features finance`; `qdrant` ya es feature por defecto. **Úsalo para el binario de escritorio.**
- **`npm run build:app`** = build público (SIN Finance). No usar para el escritorio local.
- **EL .EXE SE BLOQUEA SI ULTRON ESTÁ ABIERTO**: si la app corre, el `build` construye el frontend pero **NO relinka el binario Rust** → los cambios de Rust no entran. **Cerrar ULTRON antes de buildear.** ("Stale binary" = parece que no se aplicó pero es el .exe viejo: verificar HEAD + rebuild antes de re-implementar.)
- Sidecar de memoria: tras tocar Rust de `memory/`, rebuild `cargo build --release --features qdrant --bin ultron-memory` y copiar a `~/.ultron/bin/ultron-memory.exe` (lo que usan los hooks). Verificar con `bin/ultron-memory.exe doctor`.
- Scripts `.ps1`: **ASCII puro** (sin em-dash) — PowerShell 5.1 rompe el parser si no.

## Memoria (sistema propio — NO Mem0)

- `brain.db` (SQLite + FTS5) = fuente de verdad, **escritor único** vía `MemoryService` (regla de oro: solo él escribe memoria persistente).
- **Qdrant nativo** (auto-launch, E5-large 1024d) para recall denso. Recall **híbrido RRF** (sparse FTS5 + denso E5) + re-ranker.
- Sidecar `ultron-memory.exe` (subcomandos: recall/stats/doctor/eval/reindex/candidate/edge…).
- Auto-recall estilo Hermes: `SessionStart` (resume) + `UserPromptSubmit` (prefetch/orchestrate) vía hooks en `~/.ultron/hooks`.
- Protecciones en el write-path: redaction de secretos + gates de sensibilidad + token budget por sesión.
- **Mem0 está MUERTO** — no reintroducir. Verificar `bin/ultron-memory.exe eval` (recall) y `doctor` tras cambios de memoria.

## Routing de skills/agentes

- **Lazy por defecto**: las skills viven `.disabled` y el dispatcher (`cockpit/skill-lazy/routing-dispatcher.v2.js` determinista + `v3.js` semántico) las **inyecta on-demand** según el prompt. Núcleo mínimo activo (ultron, skill-creator…). **No activar skills en masa.**
- Harnesses: `node cockpit/skill-lazy/_verify_final.js` y `_accuracy_at3.js` deben quedar verdes tras tocar routing.
- Antes de delegar a un agente, verificar que existe en `~/.claude/agents/` (si no, no-op silencioso).

## AI Router

- `ai_router/` (modulo; `route()` en `ai_router/providers/routing.rs`, re-exportada por `mod.rs`): `route(zone, prompt)` real con cadena primary→fallback. **Política CLI-first (2026-06-08): las zonas de código arrancan por CLI** (codex-cli); el resto usa **groq como primary + gemini cloud como fallback** (gemini-cli se retiró el 2026-06-19: Google cortó el free-tier OAuth). `code-fast-local` se queda en ollama por ser offline. Editar en `seed_zones()` + `cockpit/ai-router/zones.json`. Keys desde Settings → API Keys o `~/.ultron/.env` (dotenvy). Métrica honesta = `real_fallback_rate` (NO `attempt_failure_rate`). **OJO: el router NO rutea el Claude Code CLI** (esta sesión habla directo con Anthropic); solo afecta a las llamadas que hace la app Tauri.

## Cómo trabajar aquí (los 13 mandamientos Kirkardo)

1. **El feedback literal del usuario ES el entregable** — ejecutar su lista, no una proxy.
2. **Verificar en runtime** (eval **de cero**, no métricas viejas; doctor/cargo/tsc/abrir la app), no claims.
3. **Binario fresco** = aplicado (rebuild + redeploy; **cerrar la app** antes de buildear).
4. **Nada sin cablear** (comando en lib.rs + UI que lo consume; `git add` de archivos nuevos).
5. **Build verde de verdad** (cargo 0 warnings + tsc 0 + build completa).
6. **Docs que no mienten** (coherentes con el código).
7. **Tests herméticos + caso negativo** (probar que falla cuando debe fallar).
8. **UI** necesita verificación visual del usuario (un agente no "ve" la GUI).
9. Repo **público**: 0 datos personales, 0 secretos en código/commits/recall.
10. **Detectar lo no detectado** — lo que nadie miró todavía.
11. **Prohibido el no-op silencioso** — un botón que no hace nada es peor que no tenerlo: o actúa, o explica por qué no puede.
12. **Tener el dato ≠ usar el dato** — una feature sin punto de consumo no existe (ej.: codegraph con datos que no se inyectan al contexto).
13. **Declara el alcance real** — no vender que algo afecta a X cuando solo afecta a Y; límite explícito siempre.

> Memoria de trabajo, decisiones y planes viven en el sistema de memoria de ULTRON (no en este archivo). Para detalle operativo ver `docs/` (README, INTEGRATION, COMMANDS) y `docs/web/index.html`.
