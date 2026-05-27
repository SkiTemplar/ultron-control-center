# Kirkardo — Evaluación arquitectura de memoria ULTRON (2026-05-26)

**Profesor**: Kirkardo. **Sujeto**: USER. **Modo**: estricto, sin alfombra roja.

## Resumen 3 líneas

El sistema tiene cuatro backends sin sincronización real y dos hooks nuevos que mitigan a medias el problema, pero el cross-session recall sigue dependiendo de leer markdowns crudos. Mem0 cloud funciona y es lo único fiable hoy; KG e ECC son cajas vacías sin escritor automatizado. Para "qué hicimos la última vez" sin quemar 200 archivos hace falta UN solo índice consultable (Mem0 search) y un resumen estructurado por sesión, no más backends.

## Notas (1-10, sin compasión)

| Eje | Nota | Justificación brutal |
|-----|------|----------------------|
| Confiabilidad | **5** | Mem0 cloud OK (200 verificado). KG: race en `write_graph` sin lock, last-writer-wins. `ecc_memory` swallowea JSONL malformado sin contador. `mem0-sync.js` exit(0) on error: tu sesión puede perderse en silencio y el log es la única evidencia. Cero unit tests en los 4 módulos Rust. |
| Sync cross-backend | **2** | No existe sync. mem0 ↔ KG ↔ ECC son tres islas. `mem0-sync.js` solo escribe cloud, nunca toca `kg.jsonl` ni `memory.jsonl`. Tres user_ids distintos sin enum (`USER`, `global`, `workdays`). El "aggregator" `memory_status.rs` solo lee, no propaga. |
| Recuperación cross-session | **4** | El nuevo `load-cross-project-memory.js` inyecta MEMORY.md de hasta 30 proyectos en SessionStart — útil pero ciego: solo mira `~/.claude/projects/*/memory/MEMORY.md`, NO consulta mem0 cloud (donde está el 95% de la historia real). Resultado: abres sesión nueva y ves snippets viejos manuales, no la última sesión. |
| Discoverabilidad | **3** | Memory.tsx muestra 4 cards desconectadas. No hay timeline unificada, no hay "última sesión en X proyecto", no hay búsqueda. El user no sabe qué backend tiene qué. El inbox de `save-user-prompt.js` se acumula en `~/.claude/memory/inbox/YYYY-MM-DD.md` sin pipeline de promoción real (la skill `consolidate-memory` existe pero es manual). |
| Eficiencia tokens | **3** | `load-cross-project-memory.js` quema hasta 18000 chars en CADA SessionStart, esté o no relacionado con tu cwd. `MAX_BODY_CHARS=2500` × 3 proyectos = ~7500 chars de contexto que casi siempre es ruido. Mem0 search devuelve top-k filtrado por embedding: usaría 10× menos tokens. Estás pagando carga eager por falta de recall semántico. |
| Roadmap claridad | **4** | El doc previo (`memory-verification-2026-05-26.md`) lista 9 recomendaciones pero mezcla seguridad, sync, tests y UX sin priorizar por impacto a "memoria fiable". Falta una sola línea: ¿cuál es la source of truth? Hoy son cuatro a la vez. |

**Media: 3.5/10**. Suspenso. Funciona como demo, no como sistema.

## Viabilidad de añadidos

### Graphiti (Zep)
**Pros**: grafo temporal bi-temporal real, edges con validez time-windowed, ideal para "qué dijo USER del proyecto X el mes pasado". Reemplazaría `kg.rs` con algo serio.
**Contras**: requiere **Neo4j** corriendo (Docker, RAM ~1GB en idle), Python service, dependencia externa con superficie de ataque. En este stack Windows + Tauri Rust **NO encaja**: añade un daemon más a mantener. Además duplica función con Mem0 cloud (que ya hace recall semántico). **Veredicto: NO ahora.** Solo tiene sentido si abandonas Mem0 y quieres todo on-prem.

### Ralph agentic loop (Huntley wiretap)
**Pros**: patrón de "deja un agente corriendo en loop tirando del backlog" — muy útil para procesar el `inbox/` y promover a MEMORY.md sin intervención manual.
**Contras**: no es un sistema de memoria, es un patrón de ejecución. Mezclarlo aquí es scope creep.
**Veredicto: relevante como ejecutor del consolidador, NO como reemplazo de la capa de almacenamiento.** Usa Ralph para correr `consolidate-memory` cada N horas; ese sí es buen fit.

### claude-mem (GitHub)
**Pros**: hooks ya escritos, formato compatible Claude Code, comunidad. Puede ahorrarte el work de `save-user-prompt.js` y `mem0-sync.js`.
**Contras**: sobrepone con lo que ya tienes; los hooks tuyos están más adaptados a tu setup (Windows, paths absolutos, Mem0 Token auth). Migrar = romper lo que funciona.
**Veredicto: revísalo para robar ideas (rotación de logs, dedupe), no lo adoptes wholesale.**

## ¿Es fiable hoy?

**No.** Mem0 cloud es la única pieza que sobrevive una auditoría. El resto es cosmético. Si USER abre nueva sesión en otro proyecto y pregunta "qué hicimos ayer en ultron", lo que pasa hoy:

1. `load-cross-project-memory.js` inyecta MEMORY.md viejos (probablemente ni mencionan ayer).
2. No hay query a Mem0 cloud al arrancar — el conocimiento real está allí pero nadie lo pide.
3. Claude responde con el contexto inyectado o pide al user que cuente. **Fail.**

## 3 acciones priorizadas para memoria fiable cross-session

### 1. [CRIT] Reemplazar `load-cross-project-memory.js` con un Mem0 search en SessionStart
En vez de leer 30 markdowns, hacer un POST a `/v1/memories/search/` con query = `cwd + last 7 days + project=basename(cwd)`, top_k=10, y inyectar SOLO esos resúmenes. Quema ~1500 chars en vez de 18000, y devuelve la sesión REAL más reciente. Auth: ya sabes que es `Token <key>`, no `Bearer`.

### 2. [HIGH] Forzar resumen estructurado al final de cada sesión
`mem0-sync.js` ya escribe a cloud, pero el `text` actual es "últimos 5 prompts + archivos tocados". Cámbialo a un schema fijo: `{project, session_id, decisions: [...], files: [...], next_steps: [...], blockers: [...]}` serializado como markdown. Así el search del punto 1 devuelve algo accionable, no transcript crudo. Coste: editar `buildMemoryText()` en `mem0-sync.js` para pedir a Claude el resumen estructurado vía un tool_use antes del exit (o post-procesar el transcript con regex sobre headings).

### 3. [HIGH] Eliminar KG local o convertirlo en cache read-only de Mem0
`kg.rs` y `ecc_memory.rs` son source-of-truth fantasma: nadie escribe ahí salvo manualmente. Decisión: o (a) el hook Stop también escribe entities al KG (sync real), o (b) borras los módulos y `Memory.tsx` consulta solo Mem0. **Recomendación: (b)**. Menos código, menos race conditions, menos confusión. El KG vuelve cuando integres Graphiti/Neo4j en el futuro (no ahora).

## Cierre

Tienes piezas correctas (Mem0 funciona, hooks enganchados, módulos Rust compilan) pero falta el cableado. No añadas Graphiti ni claude-mem todavía. **Consolida lo que tienes alrededor de Mem0 como única source of truth**, mata los backends huérfanos, y haz que SessionStart pregunte a la nube en vez de leer markdowns. Hasta entonces, suspenso.
