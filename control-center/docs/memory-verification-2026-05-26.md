# Memory System Verification — 2026-05-26

Scope: backend modules `mem0.rs`, `ecc_memory.rs`, `kg.rs`, `memory_status.rs` + `Memory.tsx`.
Build: `cargo test -p control-center --no-run` finishes OK in 57s (1 dead_code warning on `CmdResult`). No `#[test]` blocks exist in the four memory modules — **zero unit-test coverage**.

## 1. Estado actual (qué funciona)

- **mem0.rs** (REST client, R/W): API key resolution chain works (`mem0.apiKey` → `mcpServers.mem0.headers.Authorization` → env). Key present in `settings.json:186` (`m0-m47e…jCB`). Endpoints: `/v1/ping/`, `/v1/memories/`, `/v1/memories/search/`. Log file `~/.ultron/logs/mem0.jsonl` exists, 149 lines / 46KB — proof of live traffic. Async-`add` PENDING response handled via optional `id`/`memory` (mem0.rs:96-113).
- **ecc_memory.rs** (read-only snapshot): probes 4 paths in priority order. `~/.claude/memory.jsonl` exists (1 line: the ULTRON seed entity from `bootstrap_ecc_memory_inner`). NPM `server-memory` dist dir present but **no `memory.jsonl` inside it** (only `index.js`).
- **kg.rs** (local R/W graph): atomic temp-file rename, dedupe-on-write, cascade-delete on entity removal. Schema matches MCP `server-memory` exactly. **File missing** (`~/.ultron/cockpit/kg.jsonl`) — first call returns empty graph as designed.
- **memory_status.rs**: aggregates 4 status cards. All probes return `available=false` cleanly on missing deps, no panics. Windows `.cmd` shim fallback for `graphify` is correct.
- **Tauri wiring**: 15 commands registered in `lib.rs:263-289`, all match `Memory.tsx` invocations.

## 2. Bugs / issues encontrados

| Sev | File:Line | Issue |
|-----|-----------|-------|
| HIGH | `settings.json:186` | **Mem0 API token committed in plaintext** in user-global settings. Also leaks via `ecc:cost-audit` if log files are shared. Rotate + move to env / secret manager. |
| HIGH | `mem0.rs:347, 478` | Default `user_id` falls back to literal `"global"`. Both search and add silently target a fake user when project_id is empty — no warning surfaced. Workdays writer (`workdays.rs:187`) uses `"workdays"` instead → fragmented user-id namespace with no central enum. |
| MED | `memory_status.rs:69` | `healthy = api_key_present && diag.last_error.is_none() && count_err.is_none()` — `last_error` is *any* error in the last 200 log entries, so one stale failure poisons the card forever. Should be "no error since `last_success.timestamp`". |
| MED | `ecc_memory.rs:128` | Malformed JSONL lines are skipped silently (`continue`). No counter, no log. Corrupt files appear empty. |
| MED | `kg.rs:131-161` | Whole-file rewrite on every mutation has no fsync/lock. Two concurrent `kg_create_entities` from different windows can clobber each other (write_graph reads → writes via rename — last writer wins, no CAS). |
| MED | `mem0-sync.js` hook | Writes to mem0 cloud at session-stop, but **never writes to `kg.jsonl` or `memory.jsonl`** — there is **no cross-module sync**. Adding a Mem0 memory does NOT update the local KG or the ECC snapshot. |
| LOW | `memory_status.rs:57` | `list_all_inner(None, Some(100))` hard-codes 100; the card claims "memory_count" but caps at 100 silently. |
| LOW | `ecc_memory.rs:49-88` | `MEMORY_FILE_PATH` env var is read at every call — the MCP server process may have a different value than the Tauri process. Possible split-brain. |
| LOW | `Memory.tsx` (whole file) | No tests, type duplication of 7 Rust structs (drift risk vs. `tauri-specta`). |

## 3. Plugin coverage

MCP servers de memoria (de `settings.json:182-188` y `plugins/marketplaces/ecc/mcp-configs/mcp-servers.json`):
- `mem0` (HTTP, `mcp.mem0.ai`) — global, configurado.
- `memory` (stdio, `@modelcontextprotocol/server-memory`) — definido en ECC plugin, NO en `settings.json` global.
- `omega-memory` (uvx) — referenciado pero no instalado.

Hooks: `mem0-sync.js` (Stop), `memory-persistence/hooks.json` (SessionStart, PreCompact, SessionEnd).
Skills: 1 relacionada (`consolidate-memory`).
**Solapamiento real**: `mem0.rs` y `mem0-sync.js` ambos escriben a mem0 cloud por caminos distintos (REST directo vs JSON-RPC). Pueden duplicar memorias por sesión.

## 4. Sharing entre módulos

Existe parcialmente:
- `memory_status.rs` consume `mem0::*` + `ecc_memory::*` (read).
- `workdays.rs:187` escribe a `mem0::add_inner`.

NO existe (gap crítico):
- `kg.rs` ↔ `ecc_memory.rs`: ambos JSONL con el mismo schema, **sin sincronización**. Cambios manuales en el editor KG no aparecen en el snapshot ECC (paths distintos: `~/.ultron/cockpit/kg.jsonl` vs `~/.claude/memory.jsonl`).
- `mem0` ↔ KG/ECC: añadir a Mem0 nunca propaga a grafo local; no hay índice unificado.
- Sin event bus ni write-through cache.

## 5. Recomendaciones priorizadas

1. **[CRIT] Rotar token mem0** y moverlo a `MEM0_API_KEY` env / Windows Credential Manager.
2. **[HIGH] Crear `kg.jsonl`** vía bootstrap análogo al ECC (Memory tab muestra "0 entities" eternamente).
3. **[HIGH] Unificar user_id**: enum `Mem0Scope { Global, Workdays, Project(String) }` en `mem0.rs`. Eliminar strings mágicos.
4. **[HIGH] Sync KG↔ECC**: hacer que `kg_create_entities` también escriba un append-only mirror a `~/.claude/memory.jsonl` (o tratar ambos como la misma fuente).
5. **[MED] Fix `healthy` calc** en `memory_status.rs:69` (comparar timestamps).
6. **[MED] File lock** en `kg::write_graph` (fs2 crate o lockfile sidecar).
7. **[MED] Unit tests**: `kg::create_entities_inner` dedupe, `mem0::read_api_key` priority chain, `ecc_memory::ecc_memory_read` parse.
8. **[LOW] Generar tipos TS** desde Rust con `tauri-specta` para eliminar la duplicación en `Memory.tsx:25-119`.
9. **[LOW] Log line counter** para JSONL malformado en `ecc_memory.rs:128` y `kg.rs:67`.

## Live verification 2026-05-26

### Tests reales

- `cargo test memory` (workspace `src-tauri/`): **0 passed; 0 failed; 73 filtered out**. Confirmado: cero unit tests de memoria. Compile OK, 1 warning `dead_code` en `CmdResult` (commands/mod.rs:67).
- Archivos:
  - `~/.ultron/logs/mem0.jsonl` — existe, 149 líneas, último write 26-may 19:15. Tráfico real (`op:"status"`, HTTP 200).
  - `~/.claude/memory.jsonl` — existe, 1 línea (sólo el seed ULTRON).
  - `~/.ultron/cockpit/kg.jsonl` — **NO existía**. Creado en esta verificación con la línea bootstrap pedida (1 línea).
  - `~/.claude/logs/mem0-sync.jsonl` — 13 líneas; tres ultimas `mem0_sync_ok status:200`. El hook Stop SÍ está enviando memorias a la nube.

### API check live mem0

- `curl -H "Authorization: m0-…"` → **401** (mem0 NO acepta token desnudo).
- `curl -H "Authorization: Bearer m0-…"` → **401**.
- `curl -H "Authorization: Token m0-…"` → **200**, devuelve memorias reales del `user_id=USER` (la primera entrada es del 2026-05-26 19:37, sesión `6c3fcd19…`, body confirma `source:"claude-code-stop-hook"`).
- `mem0.rs:154,233,355,493,580,723` usa `Token ` prefix correctamente. Auth backend OK. No hay bug aquí.

### MCP coverage

`~/.claude/settings.json` mcpServers activos: `context7`, `playwright`, `unity` (sse local), `codex`, `mem0` (HTTP, token plaintext línea 186), `github` (HTTP, PAT plaintext línea 193). `~/.claude/.mcp.json` **NO existe**.

`plugins/marketplaces/ecc/mcp-configs/mcp-servers.json` define 24 servidores plantilla (jira, github, firecrawl, supabase, memory, omega-memory, longhand, sequential-thinking, vercel, railway, cloudflare-*, clickhouse, exa-web-search, context7, magic, filesystem, playwright, fal-ai, browserbase, browser-use, devfleet, token-optimizer, laraplugins, confluence, evalview) **todos con placeholders `YOUR_*_HERE`** — ninguno funcional hasta copiar+rellenar.

Funcionales hoy: `mem0`, `github`, `context7`, `playwright`, `codex`. Brokens potenciales: `unity` (sse local — sólo si Unity Editor abierto).

### Hook coverage

- `~/.claude/hooks/` directorio **NO existe**. Hooks viven en `~/.claude/scripts/`.
- `mem0-sync.js` (Stop event) configurado en `settings.json:80-94`, async, timeout 15s — **enganchado y funcionando** (log mem0-sync.jsonl lo confirma).
- ECC plugin `memory-persistence/hooks.json` define SessionStart/PreCompact/PreToolUse/PostToolUse/SessionEnd → 6 hooks de continuous-learning + session-activity-tracker.
- Sin hook que escriba a `kg.jsonl` ni a `memory.jsonl`. Confirmado el gap del análisis estático.

### Tabla de estado por módulo

| Módulo | Build | Test | Runtime | Estado |
|--------|-------|------|---------|--------|
| `mem0.rs` | OK | 0 tests | Probado live (200) | OK |
| `ecc_memory.rs` | OK | 0 tests | Sólo seed (1 línea) | WARN |
| `kg.rs` | OK | 0 tests | Bootstrap manual hoy | WARN |
| `memory_status.rs` | OK | 0 tests | Sin probar end-to-end | WARN |
| `mem0-sync.js` (hook Stop) | N/A | N/A | 200 OK en últimas 3 sesiones | OK |
| Sync inter-módulo | N/A | N/A | Inexistente | FAIL |
| MCP `memory`/`omega-memory` | N/A | N/A | Definidos pero NO en settings global | FAIL |

### ¿Puedes fiarte? — veredicto USER

Parcialmente. La capa mem0 cloud está sana y registrando: tu última sesión sí está en la nube (lo verifiqué con `Token` auth → 200). El sync local (kg + ecc snapshot) **no existe**: el grafo en `Memory.tsx` muestra 0 entities porque el archivo no se materializa hasta que el usuario crea entidades manualmente desde la UI. No hay tests automáticos de memoria, así que regresiones silenciosas son posibles. El token mem0 sigue en plaintext en `settings.json:186` — riesgo HIGH.

### Top 5 acciones priorizadas (file:line)

1. `settings.json:186` — Rotar `m0-m47e…jCB` y migrar a `MEM0_API_KEY` env; modificar `mem0.rs:158-176` para priorizar env sobre settings.
2. `kg.rs` — añadir `bootstrap_kg_inner()` análogo a `ecc_memory::bootstrap_ecc_memory_inner` y llamarlo en `lib.rs` setup (ahora arrancado a mano).
3. `mem0.rs:347,478` + `workdays.rs:187` — introducir `enum Mem0Scope` y eliminar magic strings (`"global"`, `"workdays"`, `"USER"`).
4. `mem0-sync.js` — extender para también hacer append a `~/.claude/memory.jsonl` (mirror local del cloud sync); cierra el gap kg↔ecc↔mem0.
5. `src-tauri/src/{mem0,kg,ecc_memory,memory_status}.rs` — añadir mínimo 8 `#[test]`: `read_api_key` priority chain, `kg::create_entities_inner` dedupe, `ecc_memory::ecc_memory_read` parse robusto a líneas malformadas, `memory_status::healthy` con timestamps.
