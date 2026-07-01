<h1 align="center">ULTRON Control Center</h1>

<p align="center">
  <em>Una capa de memoria gobernada, enrutado multi-LLM y orquestacion de
  skills/agentes para <a href="https://claude.com/claude-code">Claude Code</a>.</em>
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-2.7.1-555">
  <img alt="stack" src="https://img.shields.io/badge/Tauri_2-%2B_React_19-555">
  <img alt="backend" src="https://img.shields.io/badge/backend-Rust_2021-555">
  <img alt="memoria" src="https://img.shields.io/badge/memoria-SQLite_%2B_Qdrant-555">
  <img alt="plataforma" src="https://img.shields.io/badge/plataforma-Windows_11-555">
  <img alt="licencia" src="https://img.shields.io/badge/licencia-MIT-555">
</p>

Cockpit personal de escritorio (Tauri 2 + React 19) construido sobre la CLI de
Claude Code. Vive bajo `~/.ultron/` y reune tres piezas: **memoria gobernada**,
**AI Router** y un **orquestador de skills/agentes**. No reemplaza a Claude
Code: lo envuelve con estado persistente, inspeccionable y versionable.

> Repositorio **publico** (MIT), de un solo mantenedor. No es un producto
> comercial ni un SaaS. Esta documentacion describe el sistema tal y como esta
> en el disco; no contiene secretos ni datos personales (la informacion personal
> vive solo en ficheros locales fuera de control de versiones).

- **Version**: 2.7.1 (`control-center/package.json`, `Cargo.toml`, `tauri.conf.json`)
- **Plataforma**: Windows 11 (objetivo principal); Linux x86_64 compila pero el
  flujo end-to-end no esta verificado por el autor.
- **Licencia**: MIT (ver [`LICENSE`](LICENSE)).

---

## Quickstart

```bash
git clone https://github.com/SkiTemplar/ultron.git ~/.ultron && cd ~/.ultron/control-center
cp ../.env.example ../.env   # opcional: claves de proveedores LLM (todas vacias por defecto)
npm install
npm run build:app            # = kill-app + tauri build -> ejecutable de escritorio
```

Qdrant es opcional (el recall degrada a sparse-only sin el); ver la seccion
Qdrant de [`docs/INSTALL-ADVANCED.md`](docs/INSTALL-ADVANCED.md).
Las rutas per-maquina se documentan en
[`config/paths.example.toml`](config/paths.example.toml).

## Caracteristicas

- **Memoria gobernada** — `brain.db` (SQLite) como unica fuente de verdad; todo
  cambio pasa por un unico servicio que anexa un evento de auditoria.
- **Recall hibrido** — denso (E5 1024d / Qdrant) + sparse (FTS5/BM25) fusionados
  con Reciprocal Rank Fusion; degrada a sparse-only sin Qdrant.
- **Inbox de candidatos** — las capturas automaticas proponen, el humano aprueba;
  nunca se auto-escribe memoria activa.
- **Redaccion + dedupe** en el write-path — secretos/PII fuera, duplicados por
  `content_hash` fuera, antes de persistir o embeber.
- **AI Router** — cadena primario -> fallbacks por zona, deteccion de claves y
  telemetria de uso/ahorro; routing directo en Rust (sin sidecar LiteLLM).
- **Orquestador por reglas** — mapea prompt -> intent -> workflow -> agentes ->
  memorias; reserva el modelo grande solo para la cola ambigua.

---

## Que es

ULTRON Control Center no reemplaza a Claude Code: lo envuelve. Le da memoria
persistente y gobernada, enruta peticiones a varios proveedores LLM segun coste
y disponibilidad, y detecta automaticamente que skill/agente especialista
conviene para un prompt. Todo el estado vive en ficheros locales (SQLite +
JSON + markdown) que puedes inspeccionar, versionar y editar a mano.

| Pilar | Que hace |
|---|---|
| **Memoria gobernada** | `~/.ultron/brain.db` (SQLite) es la **unica fuente de verdad**. Toda escritura pasa por un unico servicio que ademas registra un evento de auditoria. Las capturas automaticas nunca escriben memoria activa directamente: proponen candidatos a un inbox que el humano aprueba o rechaza. |
| **Recall hibrido** | Fusion de dos fuentes con Reciprocal Rank Fusion (RRF): **denso** (vectores E5 1024d en Qdrant) + **sparse** (FTS5/BM25 sobre `brain.db`). Degrada a solo-sparse si Qdrant/E5 no estan disponibles. |
| **AI Router** | Catalogo de proveedores + zonas con cadena primario -> fallbacks, deteccion de claves, telemetria de uso/ahorro. Sin sidecar LiteLLM: routing directo en Rust. |
| **Orquestador** | Mapea un prompt (posiblemente vago) a intent -> workflow -> agentes a delegar -> memorias relevantes -> restricciones, mediante reglas (no usa el modelo grande para lo que resuelven reglas/triggers). |

---

## Arquitectura del backend (real)

El backend Rust vive en `control-center/src-tauri/src/`. El modulo central de
memoria esta en `control-center/src-tauri/src/memory/`.

### Memoria: SQLite como fuente de verdad

- **`~/.ultron/brain.db`** (SQLite, modo WAL) es la **SoT canonica**. El esquema
  canonico vive en `memory/schema_v3.rs` (memoria) + `memory/schema_v4.rs`
  (migracion historica v4: tablas `edges` / `unresolved_refs`, hoy inertes — el
  grafo de codigo lo provee el MCP CodeGraph externo) /
  `memory/migrations.rs`, con modelos en `memory/model.rs` (`MemoryItem`,
  `MemoryCandidate`, `MemoryEvent`, y los enums de gobernanza `Status`, `Scope`,
  `Sensitivity`, `Source`, etc.).
- **`MemoryService`** (`memory/service.rs`) es el **unico escritor persistente**.
  Invariante de gobernanza: toda mutacion pasa por aqui y **anexa un
  `MemoryEvent`** de auditoria. Hooks y agentes nunca escriben `memory_items`
  directamente; solo proponen `MemoryCandidate`s que un humano (o una politica
  de auto-aprobacion) promueve.
- En el camino de escritura se aplican guardas: **redaccion de secretos/PII**
  (`memory/redaction.rs`) antes de persistir o embeber, **dedupe** exacto por
  `content_hash` (`memory/texthash.rs`) y dedupe lexico por FTS.

### Qdrant: indice derivado (no fuente de verdad)

- La coleccion **`ultron_memory`** (Qdrant) indexa los items ACTIVE con
  **MultilingualE5Large, 1024 dimensiones** (`memory/qdrant_index.rs`). Es un
  **indice derivado**: se puede reconstruir en cualquier momento con
  `reindex_all` y `brain.db` sigue siendo la verdad.
- Tras cada escritura aprobada/editada/restaurada, `sync_index` mantiene Qdrant
  en paso con la SoT (best-effort; cualquier deriva es detectable/reparable via
  `reconcile`).
- La coleccion antigua `ultron_sessions` (384d BGE) esta retirada; Qdrant aqui
  es siempre un indice, nunca la verdad.

### Recall hibrido denso + sparse con RRF

- El comando unico `recall` (`commands/memory/recall_unified.rs`) fusiona con
  **Reciprocal Rank Fusion** (`RRF_K = 60`):
  - **DENSO**: vectores E5 en `ultron_memory` (Qdrant).
  - **SPARSE**: FTS5/BM25 sobre `memory_items` (solo `status=active`).
- Devuelve un *context pack* compacto de resumenes bajo presupuesto de tokens
  (`TOKEN_BUDGET = 1500`), con trazas de *por que esta memoria* (rangos por
  fuente, scores, descartes) para el Retrieval Inspector.
- Existe ademas un `recall_hybrid` mas antiguo (union de scores constantes,
  multi-store) que sigue registrado pero esta **deprecado** frente al `recall`
  unificado con RRF. Las patas multi-store **ECC**, **KG** y **Mem0** estan
  **retiradas** (Mem0 esta muerto por politica; no reintroducir): hoy las unicas
  fuentes vivas son Qdrant (denso) + SQLite/FTS5 (sparse).

### Captura automatica via Stop hook

- En `Stop`, el hook pasa el transcript de la sesion a
  `memory/capture.rs::capture_session`. Este:
  1. pide a un LLM (via `ai_router::route`, zona `chat`) extraer unos pocos
     hechos/decisiones durables;
  2. convierte cada hecho en un `MemoryCandidate` (pasando por redaccion +
     dedupe) y lo deja en el **inbox gobernado** para aprobacion humana — nunca
     se auto-promueve a activo.
- Fail-safe: si el router no tiene proveedor utilizable, degrada a una
  heuristica local barata para que el Stop hook nunca falle.
- El inbox se gestiona desde `commands/memory/inbox.rs`
  (`memory_inbox_list`, `approve_candidate`, `reject_candidate`).

### AI Router: zonas, proveedores, fallback y telemetria

- Backend en el modulo `ai_router/` (mod.rs + exec.rs + providers/ + seed.rs + store.rs). Estado en tres JSON bajo
  `~/.ultron/cockpit/ai-router/`: `providers.json` (catalogo), `zones.json`
  (zonas con `primary` + `fallbacks`), `metrics.json` (contadores + ahorro).
- `route(zone, prompt)` recorre la cadena **primario -> fallbacks**, salta
  proveedores sin clave API utilizable, registra latencia/tokens/ahorro en la
  telemetria y devuelve `Result<String, String>` (errores verbatim, nunca panic,
  cap de 10s).
- Wrappers por proveedor: **anthropic** (claude-haiku), **codex** (OpenAI-compat),
  **gemini**, **groq**, **ollama** (local, sin clave), **deepseek**. Los health
  checks usan sondas baratas y no gastan tokens; las invocaciones de test si.
- Zonas por defecto incluyen `chat`, `code-edit`, `code-review`, `research-web`,
  `code-fast-local`, entre otras.

### Orquestador: deteccion automatica de skills/agentes

- El modulo `orchestrator/` (rules.rs + ranking.rs + orchestrate.rs) mapea `prompt -> intent -> workflow -> agentes a delegar ->
  memorias -> restricciones`. La clasificacion de intent es **basada en reglas**
  (bilingue es/en); el modelo grande se reserva para la cola ambigua.
- Reutiliza (no duplica): el catalogo de agentes (`memory/catalog.rs`), el recall
  unificado y los workflows integrados (`agent_orchestration.rs`). Nunca escribe
  memoria persistente y delega a agentes reales en `~/.claude/agents`
  (los "ghost agents" inexistentes en disco se sanean).

### Grafo de codigo: MCP CodeGraph (externo)

- El grafo de codigo (que simbolos existen, quien llama a quien, analisis de
  impacto) lo provee **CodeGraph** (`@colbymchenry/codegraph`, MIT), instalado
  como **servidor MCP** y consultado por los agentes via `codegraph_explore` /
  `codegraph_callers` / `codegraph_impact`. Indexa el repo con tree-sitter (AST)
  en `.codegraph/` (SQLite local, incremental) — 20+ lenguajes.
- El casero v4 anterior (regex + tablas `edges`/`unresolved_refs` en brain.db +
  panel System) fue **jubilado** (2026-06-08): aportaba menos y no se inyectaba
  al contexto del agente. La migracion `schema_v4` se conserva como historia
  inerte (las tablas existen vacias; no hay codigo que las consuma).

### Plugin Updates: chequeo de actualizaciones de plugins

- Sub-tab **Updates** dentro de Library (`src/components/library/PluginUpdates.tsx`)
  que consume los comandos de backend `plugin_check_updates_bulk(force)` y
  `plugin_changelog_summary(coordinate, installed_sha?)`.
- Compara el SHA instalado contra el ultimo SHA del marketplace por cada plugin,
  marca cuales tienen actualizacion disponible y muestra el ultimo mensaje de
  commit / resumen de changelog.

---

## Stack

| Capa | Tecnologia |
|---|---|
| Frontend (Control Center) | Tauri 2 + React 19 + TypeScript (`control-center/src/`) |
| Backend (Control Center) | Rust estable (`control-center/src-tauri/src/`) |
| Memoria (SoT) | SQLite (FTS5) en `~/.ultron/brain.db` |
| Indice denso | Qdrant nativo (`~/.ultron/qdrant-native/`), coleccion `ultron_memory`, E5 1024d |
| Embeddings | E5 (denso) via `crate::qdrant::embed_e5` dentro de `ultron-memory` |
| Sidecar CLI hooks | `ultron-memory` (logica canonica reusada por los hooks Node) |
| Scripting OS | PowerShell 5.1+ / scripts en `cockpit/` |
| Runtimes LLM | Claude Code (principal); Codex CLI opcional. Gemini CLI retirado 2026-06-19 (Google corto el free-tier OAuth); Gemini queda solo como fallback cloud del AI Router |

Binarios sidecar declarados en `control-center/src-tauri/Cargo.toml`:
`ultron-memory` (requiere la feature `qdrant`).

---

## Build

```bash
# desde control-center/
npm install
npm run build:app   # = kill-app + tauri build (genera el ejecutable de escritorio)
```

Otros scripts utiles (en `control-center/package.json`):

```bash
npm run dev    # vite dev server (frontend)
npm run tauri  # CLI de Tauri
npm test       # vitest (frontend)
```

> Nota Windows: `build:app` ejecuta primero `kill-app` para cerrar cualquier
> instancia en marcha; un binario obsoleto es la causa habitual de "no se ha
> aplicado el cambio". Verifica HEAD y rebuild antes de re-implementar.

---

## Estructura de carpetas

```
~/.ultron/
├── brain.db                  # SQLite — fuente de verdad de la memoria
├── qdrant-native/            # binario nativo de Qdrant (indice denso derivado)
├── qdrant_storage/           # datos persistidos por Qdrant
├── control-center/           # la app Tauri 2 + React 19
│   ├── src/                  # frontend React/TS (componentes, tabs)
│   │   └── components/       # Dashboard, AIRouter, Library, Projects, ...
│   └── src-tauri/
│       └── src/
│           ├── memory/       # kernel de memoria (service, sqlite_store,
│           │                 # qdrant_index, capture, redaction, texthash, ...)
│           ├── commands/     # comandos Tauri por dominio (memory, ai_router,
│           │                 # projects, system_ops, ...)
│           ├── ai_router/    # AI Router (mod/exec/health/providers/seed/store/types)
│           ├── orchestrator/ # mod/orchestrate/ranking/rules/types_model
│           └── bin/          # sidecar ultron-memory
├── cockpit/                  # config + estado en JSON/markdown
│   └── ai-router/            # providers.json, zones.json, metrics.json
├── hooks/                    # hooks de ciclo de vida
├── skills/                   # skills core (SKILL.md; catalogo curado no se publica)
├── plans/  projects/         # planes y proyectos
├── sessions/                 # logs de sesion / telemetria de routing
└── docs/                     # documentacion ampliada
```

---

## Estado actual

- **Memoria**: kernel canonico activo. SoT = `brain.db`; indice denso `ultron_memory`
  (E5 1024d) sincronizado en escritura; recall unificado denso+sparse con RRF
  operativo (degrada a sparse-only sin Qdrant). Write-path con redaccion de
  secretos y dedupe por content_hash cableados y testeados.
- **Captura automatica**: Stop hook -> `capture_session` -> candidatos al inbox
  gobernado; aprobacion/rechazo humano via comandos de inbox.
- **AI Router**: routing real con cadena primario/fallback, deteccion de claves
  y telemetria de uso/ahorro; sin sidecar LiteLLM.
- **UI (Control Center, v2.7.1)**: barra lateral con Dashboard, Usage, AI Router,
  System (con sub-tabs de Hooks/Schedules), MCPs,
  Library (sub-tabs Skills/Agents/Rules/**Updates**), **Memory**, Notes,
  Learn, Sessions, Projects, Finance (solo build local con `VITE_FINANCE=1`),
  Settings y Notifications. La pestana **Memory**
  esta **viva** (re-anadida 2026-06-04, `Sidebar.tsx`): expone el inbox de
  candidatos (aprobar/rechazar/editar) y la salud de `brain.db`; el kernel de
  memoria sigue siendo solo-backend, pero su gobierno human-in-the-loop se hace
  desde esta pestana (ademas de los comandos).

---

## Licencia

MIT — ver [`LICENSE`](LICENSE). Copyright (c) 2026 USER SURNAME.
