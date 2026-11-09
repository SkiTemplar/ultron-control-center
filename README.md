<h1 align="center">ULTRON Control Center</h1>

<p align="center">
  <em>Aplicación de escritorio para trabajar con
  <a href="https://claude.com/claude-code">Claude Code</a>, Codex, Gemini y OpenCode:
  sesiones con relevo de motor, memoria gobernada y delegación entre motores.</em>
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-15.8.0-555">
  <img alt="stack" src="https://img.shields.io/badge/Tauri_2-%2B_React_19-555">
  <img alt="backend" src="https://img.shields.io/badge/backend-Rust_2021-555">
  <img alt="memoria" src="https://img.shields.io/badge/memoria-SQLite_FTS5-555">
  <img alt="plataforma" src="https://img.shields.io/badge/plataforma-Windows_11-555">
  <img alt="licencia" src="https://img.shields.io/badge/licencia-MIT-555">
</p>

Cockpit personal de escritorio (Tauri 2 + React 19) construido sobre las CLI de los
motores de IA. Vive bajo `~/.ultron/`. **Su producto principal es ULTRON Sessions**,
un chat multimotor en una ventana propia. Alrededor están la **memoria gobernada**,
la **delegación** de tareas cerradas a otros motores, el **AI Router** de la app, los
**mods** de Claude Code y **Pupus**, la mascota de escritorio. No reemplaza a las CLI:
las envuelve con estado persistente, inspeccionable y versionable.

> Repositorio MIT de un solo mantenedor, pensado para publicarse (hoy la
> visibilidad la decide el mantenedor: si puedes leer esto en GitHub, ya es
> publico). No es un producto comercial ni un SaaS. Esta documentacion
> describe el sistema tal y como esta en el disco; no contiene secretos ni
> datos personales (la informacion personal vive solo en ficheros locales
> fuera de control de versiones).

- **Versión**: 15.8.0 (`control-center/package.json`, `Cargo.toml`, `tauri.conf.json`;
  la consistencia la comprueba el job `version-drift` del CI)
- **Plataforma**: Windows 11 (objetivo principal); Linux x86_64 compila pero el
  flujo end-to-end no esta verificado por el autor.
- **Licencia**: MIT (ver [`LICENSE`](LICENSE)).

---

## Quickstart

**Sistema completo** (app + skills + hooks + memoria semantica) — el camino
recomendado; es idempotente y pregunta antes de tocar nada:

```powershell
git clone https://github.com/SkiTemplar/ultron-control-center.git $env:USERPROFILE\.ultron
cd $env:USERPROFILE\.ultron
powershell -ExecutionPolicy Bypass -File .\install.ps1   # Linux: ./install.sh
```

**Instalacion por componentes** (sin wizard, determinista; `-DryRun` lista el
plan sin tocar nada):

```powershell
.\install.ps1 -Core            # app + memoria + hooks (el set por defecto)
.\install.ps1 -All             # core + skills + tones + agents
.\install.ps1 -Skills -Tones   # a la carta
.\install.ps1 -Core -DryRun    # solo listar que haria
# Linux: ./install.sh --core | --all | --skills | --tones | --agents | --dry-run
```

**Solo la app de escritorio** (sin skills/hooks/sidecar de memoria):

```bash
git clone https://github.com/SkiTemplar/ultron-control-center.git ~/.ultron && cd ~/.ultron/control-center
cp ../.env.example ../.env   # opcional: claves de proveedores LLM (todas vacias por defecto)
npm install
npm run build:app            # = release-locked-exe + tauri build -> ejecutable de escritorio
```

Guia completa (bootstrap one-liner desde release, flags, troubleshooting):
[`INSTALL.md`](INSTALL.md).

Qdrant es opcional (el recall degrada a sparse-only sin el, y `ULTRON_DENSE=0`
lo apaga a proposito); ver la seccion Qdrant de
[`docs/INSTALL-ADVANCED.md`](docs/INSTALL-ADVANCED.md).
Las rutas per-maquina se documentan en
[`config/paths.example.toml`](config/paths.example.toml).

## Caracteristicas

- **ULTRON Sessions** — sesiones de Claude Code, Codex, Gemini y OpenCode en la app,
  con máquina de estados, cola con prioridad, persistencia y recuperación tras un
  cierre, puente local con token y relevo de motor al agotar el uso. Se gobierna
  desde el chat. Contratos en
  [`control-center/docs/sesiones/`](control-center/docs/sesiones/CONTRATO.md).
- **Delegación multimotor** — `scripts/delegate.mjs` ejecuta una tarea cerrada con
  un check medible en otro motor, por una cadena configurable, en una rama aislada
  que luego se revisa ([contrato](docs/delegacion-contrato.md)).
- **Pupus** — mascota de escritorio (solo Windows) con chat por bocadillo, permisos
  de Sessions y avisos de entregas ([`docs/PUPUS.md`](docs/PUPUS.md)).
- **Mods de Claude Code** — plugins con paneles y comandos en `mods/`
  ([`docs/MODS.md`](docs/MODS.md)).
- **Memoria gobernada** — `brain.db` (SQLite) como unica fuente de verdad; todo
  cambio pasa por un unico servicio que anexa un evento de auditoria.
- **Recall hibrido** — denso (E5 1024d / Qdrant) + sparse (FTS5/BM25) fusionados
  con Reciprocal Rank Fusion; degrada a sparse-only sin Qdrant. Con
  `ULTRON_DENSE=0` (y `ULTRON_RERANK=0`) corre solo FTS5, sin cargar E5.
- **Inbox de candidatos** — las capturas automáticas proponen candidatos y, tras
  cada sesión, el hook `Stop` lanza `ultron-memory inbox drain --auto`, que los
  aprueba o rechaza con reglas deterministas y motivo auditable. Solo quedan
  pending lo no verificable y las capturas que el usuario no afirmó (caducan a
  los 7 días). En el propio write-path actúan además `auto_approve` (umbral) y
  `auto_supersede` (sustitución 1:1) de `cockpit/memory-settings.json`: el código
  las deja apagadas si falta el fichero, pero el fichero versionado las enciende.
- **Redaccion + dedupe** en el write-path — secretos/PII fuera, duplicados por
  `content_hash` fuera, antes de persistir o embeber.
- **AI Router** — cadena primario -> fallbacks por zona, deteccion de claves y
  telemetria de uso/ahorro; routing directo en Rust (sin sidecar LiteLLM).
- **Orquestador por reglas** — mapea prompt -> intent -> workflow -> agentes ->
  memorias; reserva el modelo grande solo para la cola ambigua.
- **Tonos / personalidades** — deteccion determinista del tono del chat
  (senales lexicas + peticion explicita) dentro del orchestrate; los tonos se
  editan en Library -> Tones. La config real (`~/.ultron/personality.json`) es
  local y gitignored; el repo publica solo los seeds compilados
  (`orchestrator/personality.rs`). El tono viste unicamente la conversacion:
  nunca commits, docs ni artefactos.

---

## Que es

ULTRON Control Center no reemplaza a las CLI de los motores: las envuelve. Las lanza
desde ULTRON Sessions, les da memoria persistente y gobernada, enruta las llamadas de
la propia app a varios proveedores LLM según coste y disponibilidad, y aplica el tono
de la conversación por prompt (el hook
`memory-orchestrate` va en modo ligero por defecto; con
`ULTRON_ORCHESTRATE=full` vuelve a inyectar recall, skills y agentes sugeridos
en cada prompt). Todo el estado vive en ficheros locales (SQLite +
JSON + markdown) que puedes inspeccionar, versionar y editar a mano.

| Pilar | Que hace |
|---|---|
| **ULTRON Sessions** | Ventana propia para sesiones de varios motores. Backend en `control-center/src-tauri/src/sesiones/`, el mayor módulo del repo, y front en `control-center/src/sesiones/`. Con el uso agotado, el relevo cambia de motor y vuelve con un resumen. |
| **Delegación** | Tareas cerradas a Codex, Gemini, `claude -p` y otros motores, cada una en un worktree aislado y con su check. Historial en la pestaña AI Router. |
| **Memoria gobernada** | `~/.ultron/brain.db` (SQLite) es la **unica fuente de verdad**. Toda escritura pasa por un unico servicio que ademas registra un evento de auditoria. Las capturas automáticas proponen candidatos a un inbox que drena solo `inbox drain --auto` (lanzado por el hook `Stop`) con reglas deterministas y motivo auditable. |
| **Recall** | Fusion de dos fuentes con Reciprocal Rank Fusion (RRF): **denso** (vectores E5 1024d en Qdrant) + **sparse** (FTS5/BM25 sobre `brain.db`). Degrada a solo-sparse si Qdrant/E5 no estan disponibles; `ULTRON_DENSE=0` lo deja en solo FTS5 a proposito. |
| **AI Router** | Catalogo de proveedores + zonas con cadena primario -> fallbacks, deteccion de claves, telemetria de uso/ahorro. Sin sidecar LiteLLM: routing directo en Rust. |
| **Orquestador** | Mapea un prompt (posiblemente vago) a intent -> workflow -> agentes a delegar -> memorias relevantes -> restricciones, mediante reglas (no usa el modelo grande para lo que resuelven reglas/triggers). |

---

## Arquitectura del backend (real)

El backend Rust vive en `control-center/src-tauri/src/`. El mapa de módulos, con su
tamaño y los que están apagados, está en [`SYSTEM-MAP.md`](SYSTEM-MAP.md). El mayor es
`sesiones/` (ULTRON Sessions). El kernel de memoria está en
`control-center/src-tauri/src/memory/`.

### Memoria: SQLite como fuente de verdad

- **`~/.ultron/brain.db`** (SQLite, modo WAL) es la **SoT canonica**. El esquema
  canonico vive en `memory/schema_v3.rs` (memoria) + `memory/schema_v4.rs`
  (migracion historica v4: tablas `edges` / `unresolved_refs`, hoy inertes — el
  grafo de codigo lo provee el MCP CodeGraph externo), con modelos en `memory/model.rs` (`MemoryItem`,
  `MemoryCandidate`, `MemoryEvent`, y los enums de gobernanza `Status`, `Scope`,
  `Sensitivity`, `Source`, etc.).
- **`MemoryService`** (`memory/service/`) es el **unico escritor persistente**.
  Invariante de gobernanza: toda mutacion pasa por aqui y **anexa un
  `MemoryEvent`** de auditoria. Hooks y agentes nunca escriben `memory_items`
  directamente; solo proponen `MemoryCandidate`s que la politica de
  auto-aprobacion (`inbox drain --auto`, write-path con `auto_approve`) o un
  humano promueve.
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

- El comando unico `recall` (`commands/memory/recall_unified/`) fusiona con
  **Reciprocal Rank Fusion** (`RRF_K = 60`):
  - **DENSO**: vectores E5 en `ultron_memory` (Qdrant).
  - **SPARSE**: FTS5/BM25 sobre `memory_items` (solo `status=active`).
  - Con `ULTRON_DENSE=0` la pata densa devuelve vacío y el pack sale solo del
    sparse (sin Qdrant ni E5 cargados).
- Devuelve un *context pack* compacto de resumenes con un tope de tokens **por
  llamada** (`PER_CALL_TOKEN_CAP = 1500`, en `commands/memory/recall_unified/types_model.rs`; no
  es un presupuesto acumulado por sesión), con trazas de *por que esta memoria*
  (rangos por fuente, scores, descartes); la traza completa sale por
  `ultron-memory trace`.
- El antiguo `recall_hybrid` (union de scores constantes, multi-store) fue
  **eliminado el 2026-06-28** sin callers vivos: el unico camino de recall es
  el comando unificado `recall` con RRF. Las patas multi-store **ECC**, **KG**
  y **Mem0** estan **retiradas** (Mem0 esta muerto por politica; no
  reintroducir): hoy las unicas fuentes vivas son Qdrant (denso) +
  SQLite/FTS5 (sparse).

### Captura automatica via Stop hook

- En `Stop`, el hook pasa el transcript de la sesion a
  `memory/capture.rs::capture_session`. Este:
  1. pide a un LLM (via `ai_router::route`, zona `chat`) extraer unos pocos
     hechos/decisiones durables;
  2. convierte cada hecho en un `MemoryCandidate` (pasando por redaccion +
     dedupe) y lo deja en el **inbox gobernado** (o lo promueve en el acto si
     `auto_approve` está activado y el candidato es limpio y supera el umbral,
     `memory/auto_approve.rs`);
  3. el hook lanza después `inbox drain --auto`, que resuelve lo pendiente sin
     intervención del usuario (ver «Inbox de candidatos» arriba).
- Fail-safe: si el router no tiene proveedor utilizable, degrada a una
  heuristica local barata para que el Stop hook nunca falle.
- El inbox se gestiona por CLI con el sidecar (`ultron-memory inbox
  <list|drain|approve|reject|approve-clean|auto-approve>`); desde el 2026-10-18
  no hay vista ni comandos Tauri para él.

### AI Router: zonas, proveedores, fallback y telemetria

- Backend en el modulo `ai_router/` (mod.rs + exec.rs + providers/ + seed.rs + store.rs). Estado en tres JSON bajo
  `~/.ultron/cockpit/ai-router/`: `providers.json` (catalogo), `zones.json`
  (zonas con `primary` + `fallbacks`), `metrics.json` (contadores + ahorro).
- `route(zone, prompt)` recorre la cadena **primario -> fallbacks**, salta
  proveedores sin clave API utilizable, registra latencia/tokens/ahorro en la
  telemetria y devuelve `Result<String, String>` (errores verbatim, nunca panic,
  cap de 10s).
- Wrappers por proveedor: **codex-cli** (CLI con la suscripcion ChatGPT),
  **anthropic** (claude-haiku), **codex** (OpenAI-compat), **gemini**, **groq**,
  **ollama** (local, sin clave), **deepseek**. Estar en el catalogo no implica
  estar en una cadena: hoy solo **groq** y **gemini** aparecen en las zonas. Los
  health checks usan sondas baratas y no gastan tokens; las invocaciones de test si.
- Zonas por defecto: `chat`, `summarize`, `utility` y `light`, todas con
  consumidor real en el código (tabla abajo). El test
  `seed_zones_are_exactly_the_zones_with_a_caller` lo comprueba contra el
  código fuente.

#### Para que sirven los LLM secundarios (y para que no)

El router **no toca tu conversacion con Claude Code**: esa sesion habla directa
con Anthropic. Los modelos secundarios son la fontaneria barata de la app —
tareas cortas, de una sola vuelta, donde gastar el modelo grande no aporta nada.
Con una clave gratuita de Groq (y Gemini de relevo) funciona todo lo de abajo;
sin ninguna clave, cada una cae a su camino sin IA o devuelve un error explicito,
y el resto de la app sigue igual.

| Zona | Quien la consume hoy | Para que |
|------|----------------------|----------|
| `summarize` | resumen de sesión, etiquetado de sesiones | comprimir texto a una o pocas frases |
| `chat` | captura de memoria y juez de contradicciones | extraer decisiones de un turno y decidir si contradicen la memoria |
| `utility` | nombrado de hooks | poner nombre legible a un hook a partir de su código |
| `light` | categorías de apps, resumen de novedades de plugins, `/mejorar` de Sessions | respuestas de una palabra o una línea, reescritura de un prompt |

Una zona sin consumidor es configuración que miente sobre lo que hace el
sistema, así que `research-web`, `routing-decision` y `code-fast-local` se
**retiraron el 2026-09-21** (ninguna aparecia en un `route(...)`, ni en un
comando Tauri, ni en la UI) y `code-edit` y `code-review` el **2026-10-23** (su
único llamante, `pick_analysis_zone`, análisis previo a instalar un repo desde
Library, se eliminó el 2026-09-23). La migracion `retire_unused_zones` tambien
las borra del `zones.json` ya escrito.

El enrutado de skills, el destilado de lecciones y el perfil de proyecto usan
una cadena aparte (`orchestrator/skill_llm`), con cuota propia, para no competir
con estas zonas. **Ollama** es opcional y no está en ninguna zona: los modelos
locales quedan para programar (`retire_seed_ollama_fallback` lo quita del
último relevo de `light` en un `zones.json` ya escrito).

### Orquestador: deteccion automatica de skills/agentes

> Alcance real: por defecto el hook `memory-orchestrate` va en **modo ligero** y
> solo usa el detector de tono; el orquestador completo (recall, skills y
> agentes por prompt) solo corre con `ULTRON_ORCHESTRATE=full`.

- El modulo `orchestrator/` (rules.rs + ranking.rs + orchestrate.rs) mapea `prompt -> intent -> workflow -> agentes a delegar ->
  memorias -> restricciones`. La clasificacion de intent es **basada en reglas**
  (bilingue es/en); el modelo grande se reserva para la cola ambigua.
- Reutiliza (no duplica): el catalogo de agentes (`memory/catalog.rs`), el recall
  unificado y los workflows integrados (`agent_orchestration/`). Nunca escribe
  memoria persistente y delega a agentes reales en `~/.claude/agents`
  (los "ghost agents" inexistentes en disco se sanean).

### Grafo de codigo: MCP CodeGraph (externo)

- El grafo de codigo (que simbolos existen, quien llama a quien, analisis de
  impacto) lo provee **CodeGraph** (`@colbymchenry/codegraph`, MIT), instalado
  como **servidor MCP** y consultado por los agentes via `codegraph_explore`
  (con la configuracion por defecto de CodeGraph 1.6 es la unica herramienta
  que expone el MCP; el CLI `codegraph` da el resto: `callers`, `impact`...).
  Indexa el repo con tree-sitter (AST) en `.codegraph/` (SQLite local,
  incremental) — 30+ lenguajes.
- En la app, la tarjeta CodeGraph de cada proyecto abre un **visor** de solo
  lectura sobre su `.codegraph/codegraph.db` (busqueda, ficheros y modulos,
  vecindario navegable de un simbolo con fichero:linea).
- El casero v4 anterior (regex + tablas `edges`/`unresolved_refs` en brain.db +
  panel System) fue **jubilado** (2026-06-08): aportaba menos y no se inyectaba
  al contexto del agente. La migracion de `memory/schema_v4.rs` borra esas
  tablas de brain.db y sube `user_version` a 5.

### Plugin Updates: chequeo de actualizaciones de plugins

- Sub-tab **Plugins** dentro de Library (`src/components/Settings/PluginsSection.tsx`,
  montado por `Library.tsx`) que consume los comandos de backend `plugin_check_updates_bulk(force)` y
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
| Indice denso (opcional) | Qdrant nativo (`~/.ultron/qdrant-native/`), coleccion `ultron_memory`, E5 1024d; fuera con `ULTRON_DENSE=0` |
| Embeddings | E5 (denso) via `crate::qdrant::embed_e5` dentro de `ultron-memory`; con `ULTRON_DENSE=0` devuelve el vector cero y no carga el modelo |
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
npm run build:app   # = release-locked-exe + tauri build (genera el ejecutable de escritorio)
```

Otros scripts utiles (en `control-center/package.json`):

```bash
npm run dev    # vite dev server (frontend)
npm run tauri  # CLI de Tauri
npm test       # vitest (frontend)
```

> Nota Windows: `build:app` no cierra la instancia en marcha: renombra el
> .exe en uso (`scripts/release-locked-exe.mjs`) y la app sigue abierta con
> el binario anterior hasta que se reinicia; si el renombrado falla, cierra
> la app (`kill-app`, `taskkill /F`). Un binario obsoleto es la causa habitual
> de "no se ha aplicado el cambio": reinicia la app tras el build, y verifica
> HEAD y rebuild antes de re-implementar.

---

## Estructura de carpetas

```
~/.ultron/
├── brain.db                  # SQLite — fuente de verdad de la memoria
├── qdrant-native/            # binario nativo de Qdrant (indice denso derivado)
├── qdrant_storage/           # datos persistidos por Qdrant
├── control-center/           # la app Tauri 2 + React 19
│   ├── src/                  # frontend React/TS (componentes, tabs)
│   │   ├── sesiones/         # ventana ULTRON Sessions
│   │   └── components/       # Dashboard, AIRouter, Library, Projects, mascot, ...
│   └── src-tauri/
│       └── src/
│           ├── sesiones/     # ULTRON Sessions (el mayor modulo)
│           ├── mascot/       # Pupus
│           ├── memory/       # kernel de memoria (service, sqlite_store,
│           │                 # qdrant_index, capture, redaction, texthash, ...)
│           ├── commands/     # comandos Tauri por dominio (memory, ai_router,
│           │                 # projects, system_ops, ...)
│           ├── ai_router/    # AI Router (mod/exec/health/providers/seed/store/types)
│           ├── orchestrator/ # mod/orchestrate/ranking/rules/types_model
│           └── bin/          # sidecar ultron-memory
├── cockpit/                  # config + estado en JSON/markdown
│   └── ai-router/            # providers.json, zones.json, metrics.json
├── personality.json          # tonos del usuario (LOCAL, gitignored; se
│                             # auto-siembra desde los seeds compilados)
├── hooks/                    # hooks de ciclo de vida
├── mods/                     # mods de Claude Code
├── scripts/                  # delegate.mjs, medidor Kirkardo y utilidades
├── skills/                   # skills core (SKILL.md; catalogo curado no se publica)
├── plans/  projects/         # planes y proyectos
├── sessions/                 # logs de sesion / telemetria de routing
└── docs/                     # documentacion ampliada
```

---

## Estado actual

- **ULTRON Sessions**: el producto principal, con sus suites en
  `control-center/src-tauri/src/sesiones/` y `control-center/src/sesiones/`. La pestaña
  Session Monitor es otro sistema, más antiguo, que lanza terminales con `wt.exe`; la
  ventana de Sessions se abre desde el lanzador del pie de la barra lateral. Los
  interruptores de proxy de la pestaña AI Router no afectan a Sessions.
- **Medidor**: `node scripts/kirkardo-eval.mjs` puntúa por áreas de producto y escribe
  `logs/kirkardo-eval.json`, con el código al que corresponde la nota y el efecto de
  los checks retirados; las reglas están en [`docs/GOAL.md`](docs/GOAL.md). La escribe
  el mismo autor que el producto: no es una auditoría independiente.
- **Memoria**: kernel canonico activo. SoT = `brain.db`. El recall unificado
  denso+sparse con RRF es el modo por defecto del código: indice denso
  `ultron_memory` (E5 1024d) sincronizado en escritura y degradación a
  sparse-only sin Qdrant. La máquina de desarrollo corre desde el 2026-09-28 con
  `ULTRON_DENSE=0` y `ULTRON_RERANK=0`: recall solo FTS5, sin Qdrant ni E5
  cargados (el golden recall@8 baja de 0,744 a 0,131, precio aceptado por la
  RAM). Write-path con redaccion de secretos/PII y dedupe por content_hash
  cableados y testeados.
- **Captura automatica**: Stop hook -> `capture_session` -> candidatos al inbox
  gobernado -> `inbox drain --auto`, que los aprueba o rechaza sin
  intervención humana (inbox autónomo desde el 2026-07-13).
- **AI Router**: routing real con cadena primario/fallback, deteccion de claves
  y telemetria de uso/ahorro; sin sidecar LiteLLM.
- **Tonos**: deteccion determinista en el orchestrate (paridad JS/Rust del
  detector verificada con gate 16/16); editor visual en Library -> Tones y
  playground de deteccion. `personality.json` local (gitignored) con seeds
  publicables compilados; limite duro: el tono solo aplica al chat, jamas a
  artefactos.
- **Detector de texto IA** (apoyo TFG): pestana **Lab** con patrones
  deterministas sobre el catalogo de investigacion, mas CLI
  (`scripts/ai-text-scan.js`) y banco de casos. Senala, no reescribe. El hook
  PostToolUse que avisaba al escribir (`ai-text-warn.js`) se retiro el 2026-09-29.
- **UI (Control Center, v15.8.0)**: barra lateral con Dashboard, Usage, AI Router,
  System (sub-tabs Diagnostics/Apps/Tasks/Turn off), MCPs,
  Library (sub-tabs Skills/Agents/Rules/Plugins/Hooks/Catalog/Commands/Tones),
  Notes, Lab, Session Monitor, Projects, Finance (solo build local con `VITE_FINANCE=1`),
  Settings y Notifications. Las pestanas **Memory** y **Learn** y la sub-tab
  **Library -> Routing** se retiraron el 2026-10-18 (codigo borrado): la memoria
  se gobierna por hooks y por el sidecar `ultron-memory`, y el Panel conserva
  la tarjeta "Sistema de memoria" con su salud y contadores.

---

## Licencia

MIT — ver [`LICENSE`](LICENSE). Copyright (c) 2026 Rodrigo Fernandez.
