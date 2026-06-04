# SPEC FULL — HOOKS (ULTRON ↔ Claude Code)
### Autocontenido para revisión por IA externa · 2026-06-04 · HEAD = `git rev-parse --short HEAD`

> **[RECONCILIADO + LIMPIEZA P0 2026-06-04 — ver `../STATE-RECONCILIATION-2026-06-04.md`, `../NIGHT-RUN-2026-06-04.md`]**
> EJECUTADO (commit `d3a16ff`, hito historico de la limpieza P0; HEAD vivo se obtiene con
> `git rev-parse --short HEAD`, no se hardcodea; linea posterior: `f936a66` → `cda7a99` → `79a962c` →
> `4558554`. Backup en `backups/config-2026-06-04-preP0/`): `mem0-sync.js` y
> `quota-capture.js` RETIRADOS de settings.json; `quota-state.json` borrado; `stop-compress-session.js`
> ya NO escribe a `ultron_sessions` 384d (fuera del SoT). PENDIENTE (P1, supervisado): repoint completo
> de hooks SoT a `~/.ultron/hooks` (config global) y Stop→`ultron-memory candidate`.
>
> **ACLARACION read-path `ultron_sessions`:** se corto el WRITE (hook Stop), pero la coleccion 384d SIGUE
> VIVA en LECTURA via `commands/memory/memory_graph.rs:200` (`memory_unified_search`). Write-dead pero
> read-alive: neutralizada a medias. Cerrar la lectura es Fase F del backend (ver `../specs/01-MEMORIA.md` §7).

## 1. Propósito
Integrar el kernel de memoria con Claude Code vía hooks Node que REUSAN la lógica canónica (sidecar `ultron-memory.exe`), sin duplicar lógica en JS. Capturar contexto (SessionStart), enrutar (UserPromptSubmit) y proponer memoria (Stop).

## 2. Ubicación y SoT (deuda conocida)
- **Hooks vivos**: `~/.claude/settings.json` apunta a `~/.claude/scripts/*.js` (NO versionado — [[memory-hooks-not-versioned]]).
- **Hooks nuevos de memoria**: `~/.ultron/hooks/scripts/*.js` (versionado en git). Los 2 memory-* apuntan aquí.
- Deuda: SoT confusa (dos sitios). El plan es invertir SoT a `~/.ultron/hooks/`.

## 3. Hooks registrados (settings.json)
| Evento | Hook | Estado |
|---|---|---|
| SessionStart | load-cross-project-memory.js | 🟡 legacy (posible solape) |
| SessionStart | session-start-override.js | 🟡 |
| SessionStart | workday-session-linker.js | ✅ inyecta git log |
| SessionStart | **memory-session-resume.js** | ✅ activado+verificado (resume real del kernel) |
| SessionStart | ~~session-recall-inject.js~~ | ✅ RETIRADO (Ola 0: leía ultron_sessions sin filtro status) |
| UserPromptSubmit | routing-dispatcher.js | 🟡 router #1 (keyword) |
| UserPromptSubmit | save-user-prompt.js | ✅ |
| UserPromptSubmit | **memory-orchestrate.js** | ✅ activado (router #2: orchestration-context) |
| Stop | stop-compress-session.js | ✅ OLA I P0 (`d3a16ff`): upsert a ultron_sessions CORTADO; conserva appendPendingDecisions; falta SOLO el wiring Stop→`ultron-memory candidate` (el subcomando del sidecar ya existe, ver §4) |
| Stop | ~~mem0-sync.js~~ | ⚫ RETIRADO de settings.json (OLA I P0; Mem0 fuera del canon) |
| Stop | kanban-update-reminder.js | ✅ |
| Stop | batch-capture.js | ✅ cola Run Batch |
| PostToolUse | ~~quota-capture.js~~ | ⚫ RETIRADO + quota-state.json borrado (huérfano tras cbb2d5c) |

## 4. Sidecar CLI (`ultron-memory.exe`)
Subcomandos: `resume` (SessionStart), `orchestrate <prompt>` (UserPromptSubmit), `recall <query>`, `stats`, `reindex`, **`eval`** (nuevo), `reconcile` (--check read-only), `candidate` (stdin JSON). Helper `lib/ultron-memory-cli.js` (FAIL-SAFE: localiza binario env→~/.ultron/bin→target; null si falla → hook no-op).

> **El subcomando `candidate` YA EXISTE y esta CABLEADO end-to-end** en `bin/ultron_memory.rs` (match arm
> `"candidate"` → lee JSON de stdin → helper `emit_candidate` → `MemoryService::create_candidate`, el escritor
> unico, que persiste un `MemoryCandidate` pending). NO es scaffolding: parsea `type/scope/title/summary/
> content/importance/session_id` y devuelve `{"candidate_id": ...}`. Lo UNICO que falta es el **wiring del
> hook**: que `stop-compress-session.js` pipe el fact JSON a `ultron-memory candidate` en vez de
> `appendPendingDecisions`. El camino canonico (sidecar) ya esta listo; el trabajo pendiente vive en el .js del hook.

## 5. STATUS FULL
| Aspecto | Estado |
|---|---|
| Memoria activada (SessionStart+UserPromptSubmit) | ✅ verificado runtime |
| Sidecar único (no duplicar lógica en JS) | ✅ |
| Ruta legacy sin gobernanza cortada | ✅ Ola 0 |
| **Stop → emisor de candidates** | 🟡 upsert ultron_sessions cortado (P0 `d3a16ff`); subcomando `candidate` del sidecar YA cableado (`bin/ultron_memory.rs`); falta SOLO el wiring del hook .js (pipe a `ultron-memory candidate`) |
| Dedup de hooks | 🟡 2 routers UserPromptSubmit; 3-4 inyectores SessionStart (posible contexto duplicado) |
| SoT versionada (~/.ultron/hooks) | 🔴 hooks vivos en ~/.claude sin git |
| Latencia (cold-start E5 ~4-6s vs timeout 8s) | 🟡 a veces no inyecta orchestration-context |
| Legacy py/ps1 | 🔴 sin matar |

## 6. QUÉ FALTA (priorizado)
1. **Reorientar stop-compress-session.js**: en vez de upsert directo a Qdrant/Mem0, pipear el fact JSON a `ultron-memory candidate` → respeta escritor único; la memoria entra como candidate pending (validación humana). **NOTA: el subcomando `candidate` ya está implementado y cableado en el sidecar** (`bin/ultron_memory.rs`, ver §4); el único trabajo restante es el wiring en el .js del hook (sustituir `appendPendingDecisions` por el pipe al sidecar). No hay que escribir backend nuevo.
2. **Dedup**: matar el scoring de routing-dispatcher.js (dejar memory-orchestrate como único router); revisar solape de inyectores SessionStart.
3. **Invertir SoT** a `~/.ultron/hooks/scripts/` (versionado) + extender `install-sidecars.ps1` (build+install binario + registro hooks).
4. **Matar legacy** py/ps1 huérfanos.
5. **Latencia**: reducir cold-start (warm del E5 / cache) o subir timeout del hook orchestrate.

## 7. Preguntas para la IA
- ¿Stop→candidate con extracción LLM (ai_tasks::extract) o reglas? ¿Riesgo de memory-poisoning por auto-captura?
- ¿Cómo dedupe inyectores SessionStart sin perder señal útil?

## 8. Aceptación / Tests / Runtime-verification / Rollback

Contrato vinculante (schema de hooks: qué pueden proponer, nunca escribir): ver `../CONTRACTS-2026-06-04.md`.

- **Aceptación (DoD):** los hooks PROPONEN candidates (vía `ultron-memory candidate`), NUNCA escriben memoria directa; `MemoryService` sigue siendo el único escritor; ningún hook reintroduce `ultron_sessions` WRITE ni Mem0; el helper `lib/ultron-memory-cli.js` se mantiene FAIL-SAFE (binario ausente → hook no-op, nunca error de sesión).
- **Tests:** el sidecar se valida con `cargo test --manifest-path control-center/src-tauri/Cargo.toml --no-default-features --lib memory`; el subcomando `candidate` se prueba end-to-end con `echo '{"type":"fact","scope":"session","title":"t","summary":"s"}' | ultron-memory candidate` → debe devolver `{"candidate_id": ...}` y aparecer como pending en `ultron-memory stats` / inbox.
- **Runtime-verification:** `ultron-memory eval` (recall@8 + secret_leak/stale_leak=0) · `ultron-memory reconcile` (in_sync 943=943) · `ultron-memory stats` (conteo de candidates pending) · arrancar una sesión Claude Code y confirmar que SessionStart resume + UserPromptSubmit orchestrate inyectan sin error. Tras editar el backend de memoria: rebuild release del sidecar + copiar a `~/.ultron/bin` para que los hooks vivos usen el binario nuevo.
- **Rollback:** config viva respaldada en `backups/config-2026-06-04-preP0/` (restaurar `settings.json` revierte el repoint/retiro de hooks); los hooks son fail-safe (no-op si el binario falta); `git revert` del commit del hook (un cambio de hook = un commit) restaura el comportamiento previo sin tocar memoria persistida.
