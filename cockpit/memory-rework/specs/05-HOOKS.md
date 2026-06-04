# SPEC FULL — HOOKS (ULTRON ↔ Claude Code)
### Autocontenido para revisión por IA externa · 2026-06-04

> **[RECONCILIADO + LIMPIEZA P0 2026-06-04 — ver `../STATE-RECONCILIATION-2026-06-04.md`, `../NIGHT-RUN-2026-06-04.md`]**
> EJECUTADO (commit `d3a16ff`; backup en `backups/config-2026-06-04-preP0/`): `mem0-sync.js` y
> `quota-capture.js` RETIRADOS de settings.json; `quota-state.json` borrado; `stop-compress-session.js`
> ya NO escribe a `ultron_sessions` 384d (fuera del SoT). PENDIENTE (P1, supervisado): repoint completo
> de hooks SoT a `~/.ultron/hooks` (config global) y Stop→`ultron-memory candidate`.

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
| Stop | stop-compress-session.js | ✅ OLA I P0 (`d3a16ff`): upsert a ultron_sessions CORTADO; conserva appendPendingDecisions; falta Stop→candidate |
| Stop | ~~mem0-sync.js~~ | ⚫ RETIRADO de settings.json (OLA I P0; Mem0 fuera del canon) |
| Stop | kanban-update-reminder.js | ✅ |
| Stop | batch-capture.js | ✅ cola Run Batch |
| PostToolUse | ~~quota-capture.js~~ | ⚫ RETIRADO + quota-state.json borrado (huérfano tras cbb2d5c) |

## 4. Sidecar CLI (`ultron-memory.exe`)
Subcomandos: `resume` (SessionStart), `orchestrate <prompt>` (UserPromptSubmit), `recall <query>`, `stats`, `reindex`, **`eval`** (nuevo), `candidate` (stdin JSON). Helper `lib/ultron-memory-cli.js` (FAIL-SAFE: localiza binario env→~/.ultron/bin→target; null si falla → hook no-op).

## 5. STATUS FULL
| Aspecto | Estado |
|---|---|
| Memoria activada (SessionStart+UserPromptSubmit) | ✅ verificado runtime |
| Sidecar único (no duplicar lógica en JS) | ✅ |
| Ruta legacy sin gobernanza cortada | ✅ Ola 0 |
| **Stop → emisor de candidates** | 🟡 upsert ultron_sessions cortado (P0 `d3a16ff`); falta Stop→`ultron-memory candidate` |
| Dedup de hooks | 🟡 2 routers UserPromptSubmit; 3-4 inyectores SessionStart (posible contexto duplicado) |
| SoT versionada (~/.ultron/hooks) | 🔴 hooks vivos en ~/.claude sin git |
| Latencia (cold-start E5 ~4-6s vs timeout 8s) | 🟡 a veces no inyecta orchestration-context |
| Legacy py/ps1 | 🔴 sin matar |

## 6. QUÉ FALTA (priorizado)
1. **Reorientar stop-compress-session.js**: en vez de upsert directo a Qdrant/Mem0, pipear el fact JSON a `ultron-memory candidate` → respeta escritor único; la memoria entra como candidate pending (validación humana).
2. **Dedup**: matar el scoring de routing-dispatcher.js (dejar memory-orchestrate como único router); revisar solape de inyectores SessionStart.
3. **Invertir SoT** a `~/.ultron/hooks/scripts/` (versionado) + extender `install-sidecars.ps1` (build+install binario + registro hooks).
4. **Matar legacy** py/ps1 huérfanos.
5. **Latencia**: reducir cold-start (warm del E5 / cache) o subir timeout del hook orchestrate.

## 7. Preguntas para la IA
- ¿Stop→candidate con extracción LLM (ai_tasks::extract) o reglas? ¿Riesgo de memory-poisoning por auto-captura?
- ¿Cómo dedupe inyectores SessionStart sin perder señal útil?
