# CLAUDE.md — mar.ia

Instrucciones de proyecto para trabajar en este repo. Se carga automáticamente cada sesión. **Mantener conciso y veraz** (cuesta contexto en cada sesión).

## Qué es

**mar.ia** (fork de ULTRON Control Center): app **Tauri 2 + React 19 + Rust** (`control-center/`) — asistente con orbe JARVIS, relevo de proveedores (claude/codex/antigravity/local), memoria gobernada, routing de skills/agentes, terminales embebidas, mosaico y webapp móvil. Responder siempre en **Español** (con tildes/ñ).

**Carpeta raíz: `~/.maria`** (renombrada desde `~/.ultron` el 2026-09-18). `~/.ultron` sigue existiendo como **enlace de directorio (junction)** a `.maria`: eso es lo que hace que las referencias antiguas —hooks registrados en `~/.claude/settings.json`, scripts, rutas dentro de `brain.db`— sigan funcionando sin tocarlas. El código nuevo NO construye la ruta a mano: pregunta a `maria_paths::home()` (Rust) o `lib/maria-home.js` (hooks), que resuelven `MARIA_HOME` > `~/.maria` > `~/.ultron`. Migración: `scripts/migrar-a-maria.ps1` (idempotente, con `-DryRun`).

## Build y ejecución — GOTCHAS (causan la mayoría de líos)

- **`npm run build:local`** (desde `control-center/`) = el build de escritorio: cierra la app, `tauri build`, despliega el sidecar en `~/.maria/bin/` y deja el lanzador apuntando a este repo. **Es el único camino para el binario.** (`build:app` = lo mismo sin sidecar ni lanzador. Finanzas ya no existe: sus fuentes nunca estuvieron en este fork.)
- **NUNCA `cargo build --release` para el binario de la app.** Observado el 2026-09-19: ese binario abre la ventana contra `http://localhost:1420` y se ve `ERR_CONNECTION_REFUSED` (el frontend embebido solo queda bien cuando compila el CLI de Tauri). Mismo código, `npm run build:local` → funciona. `cargo build` sí vale para `--bin ultron-memory` y para `cargo check`/`cargo test`.
- **El lanzador**: `scripts/instalar-lanzador.ps1` deja UN solo acceso directo («mar.ia», menú de inicio + escritorio) apuntando a este repo, borra los que apunten a otro `control-center.exe` y arregla la entrada de arranque. Se ejecuta solo al final de `build:local`. Antes había un «ULTRON Control Center» en el menú apuntando al repo viejo (`~/.maria/control-center/…`) y abría la versión antigua.
- **EL .EXE SE BLOQUEA SI ULTRON ESTÁ ABIERTO**: si la app corre, el `build` construye el frontend pero **NO relinka el binario Rust** → los cambios de Rust no entran. **Cerrar ULTRON antes de buildear.** ("Stale binary" = parece que no se aplicó pero es el .exe viejo: verificar HEAD + rebuild antes de re-implementar.)
- Sidecar de memoria: tras tocar Rust de `memory/`, rebuild `cargo build --release --features qdrant --bin ultron-memory` y copiar a `~/.ultron/bin/ultron-memory.exe` (lo que usan los hooks). Verificar con `bin/ultron-memory.exe doctor`.
- **Proveedores del relevo (2026-09-20)**: `claude`, `codex`, `antigravity` (binario `agy`) y `local`. Gemini fuera: su OAuth individual murió el 18/06/2026 y Antigravity da los mismos modelos de Google con la suscripción viva. **Modelos por suscripción (2026-09-22)**: el catálogo ya no es una constante; `maria/suscripcion.rs` lee lo que cada CLI deja en disco (Claude: `~/.claude.json` `additionalModelOptionsCache`/`modelAccessCache` y `subscriptionType` de las credenciales, sin tocar tokens; Codex: `~/.codex/models_cache.json` + claim `chatgpt_plan_type`; Antigravity: `agy models`) y `models::fundir` lo cruza con los rechazos reales (`cockpit/maria/modelos-veredictos.json`, caducan a los 7 días o al sondear de nuevo). `default_model` sigue vacío en codex y antigravity (la CLI elige); un id de disco pasa `id_con_forma_de_modelo` antes de llegar a `Command::args`. Claude va con `--effort low|medium|high` (bandera real desde 2.1.x); `/modelos` refresca. Y en `cli_invocation`, la bandera del prompt (`-p`) va SIEMPRE la última: `-p` se come el argumento siguiente, así que `-m modelo` delante la rompe.
- Scripts `.ps1`: **ASCII puro** (sin em-dash) — PowerShell 5.1 rompe el parser si no.
- **Tokens (2026-09-06)**: subagentes y workflows en Sonnet por defecto (`CLAUDE_CODE_SUBAGENT_MODEL` en settings); Fable solo en la sesión principal. Nunca un `Workflow` sin `model` explícito en cada `agent()`: 14 subagentes en Fable fueron el 85 % del gasto de un día. `/clear` por tarea y `/compact` antes de 100 k.
- test: `cd control-center && npx vitest run --silent` (suite que lanza el hook `run-project-tests` tras editar código, ~3 s). `cargo test --lib` (desde `control-center/src-tauri/`) se lanza a mano. `serve::lockfile::…carrera_de_hilos…` falla de forma intermitente bajo carga en Windows; aislado pasa.

## Mapa del código

- `control-center/src/components/jarvis/` — orbe, chat, terminales, mosaico.
- `control-center/src-tauri/src/maria/` — lo propio de mar.ia (`relay`, `voice`, `web`, `term`, `threads`, `teclado`, `cuentas`, `perfiles`, `apagado`, `arranque`, `paths`…). Antes eran 19 ficheros `maria_*.rs` sueltos.
- `control-center/src-tauri/src/handlers.rs` — registro de comandos. **Regla: comando que se registra, comando que tiene llamador en la interfaz** (248 a 2026-09-21; el compilador no avisa de los huérfanos porque viven en módulos `pub`).
- `docs/AUDITORIA.md` — qué se retiró en la reestructuración de 2026-09-21, por qué, y la deuda que queda.

## Memoria (sistema propio — NO Mem0)

- `brain.db` (SQLite + FTS5) = fuente de verdad, **escritor único** vía `MemoryService` (regla de oro: solo él escribe memoria persistente).
- **Qdrant nativo** (auto-launch, E5-large 1024d) para recall denso. Recall **híbrido RRF** (sparse FTS5 + denso E5) + re-ranker.
- Sidecar `ultron-memory.exe` (subcomandos: recall/stats/doctor/eval/reindex/candidate/edge…).
- Auto-recall estilo Hermes: `SessionStart` (resume) + `UserPromptSubmit` (prefetch/orchestrate) vía hooks en `~/.ultron/hooks`. **Hooks (2026-09-22)**: 38 entradas en `templates/settings-hooks.json`, todas en **forma exec** (`command:"node", args:[ruta]`, sin shell: 34 ms frente a 50 con bash / 227 con PowerShell); `node hooks/regen-manifest.js --check-template` corre en CI y `--check` en local (settings.json vivo + checksums). `~/.ultron/hooks/scripts` es una COPIA del repo: tras tocar un hook, copiarlo ahí y reinstalar el objeto `hooks` (install.ps1 o `scratchpad/hooks_install.js`). Nada vive en `PostCompact` (en 2.1.278 solo enseña stdout al usuario): lo de después de compactar va en `SessionStart` con `compact`. `memory-orchestrate` tiene presupuesto de 8 s y puerta de Qdrant (`/healthz` 300 ms → sparse directo). `guardrails-pre` entra con las DENY de Bash apagadas (`ULTRON_GUARDRAILS_BASH=1` las enciende).
- Protecciones en el write-path: redaction de secretos + gates de sensibilidad + token budget por sesión.
- **Mem0 está MUERTO** — no reintroducir. Verificar `bin/ultron-memory.exe eval` (recall) y `doctor` tras cambios de memoria.
- **RAM: una sola copia de los modelos** (2026-08-15). E5-large son ~1,5 GB y el cross-encoder otros ~1,5 GB. La GUI y los one-shot **no** los cargan: preguntan al daemon (`daemon_client.rs`; cmds `orchestrate`/`recall`/`warm_catalog` en `serve.rs`) y solo caen al camino local si el daemon no responde. El daemon los **suelta por inactividad** (`ULTRON_MODEL_IDLE_MIN`, default 30 min desde 2026-08-17, el reranker la mitad; `0` = nunca). Medido: app 1522→36 MB, CLI recall 3223→20 MB, daemon 1500 MB caliente y ~40 MB en reposo. Coste: la primera consulta tras un rato parado paga la recarga. El **proceso** del daemon es residente desde 2026-09-10 (`ULTRON_DAEMON_IDLE_MIN`, default 0 = nunca sale; antes salía a los 30 min y el prompt siguiente iba sin memoria): ~40 MB en reposo, sin coste de relanzar.

## Routing de skills/agentes

- **Lazy por defecto**: las skills viven en `~/.claude/skills/_disabled/<name>/` (Claude Code no desciende a subdirectorios, así que no cargan en la sesión; el sufijo `.disabled` es legacy y SÍ carga) y el dispatcher (`cockpit/skill-lazy/routing-dispatcher.v2.js` determinista + `v3.js` semántico) las **inyecta on-demand** según el prompt. Núcleo mínimo activo (ultron, skill-creator…). **No activar skills en masa.**
- Harnesses: `node cockpit/skill-lazy/_verify_final.js` y `_accuracy_at3.js` deben quedar verdes tras tocar routing.
- Antes de delegar a un agente, verificar que existe en `~/.claude/agents/` (si no, no-op silencioso).

## Llamadas internas a un modelo

- El **AI Router se retiró el 2026-09-21** (4,7 mil líneas: zonas, claves de API, métricas). En esta instalación no había ninguna clave, dos de sus cuatro proveedores no podían contestar y llevaba 0 éxitos de 4 llamadas. No reintroducirlo.
- Titular, resumir, nombrar hooks y extraer recuerdos van por `maria/interno.rs::route(zona, prompt)`: mismo orden y enfriamiento que el relevo del chat, con tres reglas propias — **nunca con acceso total**, el **modelo local primero** (levanta `ollama serve` si hace falta y suelta la VRAM al acabar) y, si toca Claude, **`haiku`**. Lo usa también el sidecar `ultron-memory` que lanzan los hooks.
- La capa Python `scripts/cockpit/` **se queda**: 44 de sus 46 scripts tienen llamador vivo y el backend Rust la invoca (proyectos, salud de MCP, sincronía de skills, enrutador de skills). Análisis de alcance en `docs/AUDITORIA.md`.

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
