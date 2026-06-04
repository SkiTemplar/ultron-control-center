// Control Center — Button prompts catalog
//
// Every Control Center button that spawns an AI session reads its prompt from
// this catalog instead of inlining a string literal in the React component.
// That way the prompts can be tuned from the Settings → "Button prompts"
// sub-tab without recompiling the app.
//
// Storage layout:
//
//   ~/.claude/projects/control-center/button-prompts.json
//
// The file only persists user overrides keyed by stable identifier
// ("plans.sprint_ai", "skills.create_with_ai", ...). Defaults live in this
// module and are merged on read, so adding a new default in code makes it
// show up automatically for every user without forcing them to delete the
// JSON file.
//
// Writes are atomic (tmp + rename) to avoid leaving a half-written catalog
// on disk if the process crashes mid-save.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Process-wide write lock
// ---------------------------------------------------------------------------
//
// `update_button_prompt_inner` does a read_stored → mutate → write_stored.
// Without a lock, two concurrent callers (e.g. rapid Settings saves) both read
// the same baseline and the second writer clobbers the first writer's change —
// overrides vanish silently. The lock is held across the entire read-modify-
// write so the operation is atomic from the caller's point of view.
// `list_button_prompts_inner` also acquires the lock for its best-effort
// materialisation write so the initial file creation cannot race.
// Pure reads (`build_catalog`, `get_button_prompt_inner`) are excluded.
// Same pattern as `sessions_tags::SESSIONS_TAGS_WRITE_LOCK`.
static BUTTON_PROMPTS_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn button_prompts_lock() -> &'static Mutex<()> {
    BUTTON_PROMPTS_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ButtonPrompt {
    /// Stable identifier, e.g. "plans.sprint_ai".
    pub key: String,
    /// Short user-facing label shown in the Settings list.
    pub label: String,
    /// Where in the Control Center the button lives ("Plans / header
    /// Resolve button", "Skills / detail Preview AI Edit", ...).
    pub location: String,
    /// Optional description of what the prompt does.
    pub description: String,
    /// Effective prompt text — default merged with the user override (if any).
    pub prompt: String,
    /// Canonical default. Lets the UI offer a "Reset to default" button.
    pub default_prompt: String,
    /// Whether the entry currently differs from `default_prompt`.
    pub overridden: bool,
    /// Names of variables interpolated by the consumer when materialising
    /// the prompt (e.g. ["report_json"]). Informational so the Settings UI
    /// can warn the user "this prompt expects {report_json}".
    pub vars: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ButtonPromptsCatalog {
    pub schema_version: u32,
    pub buttons: Vec<ButtonPrompt>,
}

// ---------------------------------------------------------------------------
// Defaults — the single source of truth for every AI button prompt.
//
// Adding a new button: insert a `default_button(...)` line below and migrate
// the component to read from `get_button_prompt(key, vars)` in the TS helper.
//
// Style guide for prompts:
//   - Atemporal: no version numbers, no dates, no "v1.x".
//   - Self-contained: give the LLM enough context to act without referencing
//     internal docs the model cannot see.
//   - Keep `{var}` placeholders intact and document them in the `vars` arg.
//   - Avoid product-specific jargon — assume the model only knows it is
//     running inside a Claude Code session.
// ---------------------------------------------------------------------------

fn default_button(
    key: &str,
    label: &str,
    location: &str,
    description: &str,
    vars: &[&str],
    prompt: &str,
) -> ButtonPrompt {
    ButtonPrompt {
        key: key.to_string(),
        label: label.to_string(),
        location: location.to_string(),
        description: description.to_string(),
        prompt: prompt.to_string(),
        default_prompt: prompt.to_string(),
        overridden: false,
        vars: vars.iter().map(|s| s.to_string()).collect(),
    }
}

/// Canonical button catalog. Edit this list (or extend it) whenever a new
/// AI button is added to the Control Center.
fn build_defaults() -> Vec<ButtonPrompt> {
    vec![
        default_button(
            "dashboard.pc_diagnose_analyse",
            "Analyse PC diagnostic report",
            "Dashboard / PC diagnostics",
            "Opens a Claude session preloaded with the PC diagnostic report and \
             asks for a prioritised list of fixes.",
            &["report_json"],
            "Analiza este reporte de diagnóstico de PC y dime exactamente qué está mal, ordenado por gravedad (crítico → bajo). Para cada problema:\n- Qué está mal y por qué importa\n- Fix concreto (comando, ajuste de configuración o acción manual)\n- Riesgo de aplicar el fix (bajo/medio/alto)\n\nSi todo está bien, responde con una sola línea de OK.\n\nReporte (JSON):\n```json\n{report_json}\n```",
        ),
        default_button(
            "skills.create_with_ai",
            "Skills · Create new skill",
            "Skills / list header",
            "Spawns a Claude session that walks the user through creating a new \
             SKILL.md following the Claude Code skill schema.",
            &[],
            "Vamos a crear un nuevo skill para Claude Code en `~/.claude/skills/<slug>/SKILL.md`.\n\nEl skill debe seguir el schema estándar:\n- Frontmatter YAML válido con `name`, `description`, `allowed-tools` (lista) y opcional `triggers`.\n- Cuerpo Markdown con instrucciones claras: cuándo activarse, qué hacer paso a paso, qué NO hacer.\n- `description` debe describir cuándo activar el skill (no qué hace), porque es lo que el orquestador ve.\n\nPregúntame:\n1. Slug en kebab-case.\n2. Una descripción de uso (1-2 frases sobre cuándo activarse).\n3. Triggers de activación (palabras clave, patrones).\n4. Allowed tools (qué herramientas necesita).\n\nDespués genera el archivo completo y muéstrame el diff antes de escribir.",
        ),
        default_button(
            "skills.edit_with_ai",
            "Skills · Edit with AI",
            "Skills / detail Preview · AI Edit",
            "Used inside the skill preview to apply a natural-language edit to \
             an existing SKILL.md.",
            &["skill_name", "ai_instruction"],
            "Quiero editar el skill en `~/.claude/skills/{skill_name}/SKILL.md`.\n\nInstrucción del usuario:\n{ai_instruction}\n\nPasos:\n1. Lee primero el SKILL.md actual y los archivos hermanos si son relevantes para el cambio.\n2. Propón el cambio como diff unificado antes de escribir.\n3. Mantén el frontmatter YAML válido (campos `name`, `description`, `allowed-tools` intactos salvo que se pidan modificar).\n4. Espera mi confirmación antes de aplicar.",
        ),
        default_button(
            "agents.edit_with_ai",
            "Agents · Edit with AI",
            "Agents / detail header",
            "Opens a Claude session in ~/.claude/agents to edit the selected agent.",
            &["agent_name"],
            "Quiero editar el agent en `~/.claude/agents/{agent_name}.md`.\n\nPasos:\n1. Lee el archivo actual completo.\n2. Resume en 2 líneas qué hace el agent hoy.\n3. Pregúntame qué quiero cambiar y propón el cambio como diff.\n4. Mantén el frontmatter YAML válido (campos `name`, `description`, `tools`, `model` si existen).\n5. Espera mi confirmación antes de escribir.",
        ),
        default_button(
            "agents.discover_online",
            "Agents · Discover online",
            "Agents / list header",
            "Asks Claude to scout GitHub for useful Claude Code agents and \
             offer to download them locally.",
            &[],
            "Busca agents de Claude Code útiles publicados en GitHub. Fuentes recomendadas: `anthropics/claude-code-templates`, `voltagent/awesome-claude-code-subagents`, `addyosmani/agent-skills`, y cualquier repo con tag `claude-code-agents`.\n\nDevuelve una tabla de 8-12 agents con:\n- nombre (slug kebab-case)\n- una línea de descripción\n- URL del archivo .md raw en GitHub\n- por qué es útil\n\nDespués pregúntame cuáles quiero instalar y descárgalos a `~/.claude/agents/<name>.md`. Mantén el frontmatter YAML intacto.",
        ),
        default_button(
            "memory.new_note_ai",
            "Memory · New note with AI",
            "Memory / list header",
            "Spawns a Claude session so the user can draft a new memory/vault note.",
            &[],
            "Vamos a escribir una nueva nota de memoria persistente.\n\nUbicación sugerida: `~/.claude/memory/` o el vault que el usuario tenga configurado.\n\nLa nota debe tener:\n- Frontmatter YAML con `title`, `date`, `tags`.\n- Cuerpo Markdown breve y autocontenido.\n- Sin información temporal (versiones de software, fechas relativas).\n\nPregúntame el tema, propón ubicación y título, escribe el contenido y espera confirmación antes de guardar.",
        ),
        default_button(
            "notif.fix_one",
            "Notifications · Fix one alert",
            "Notifications / per-row button",
            "Opens a session preloaded with a single alert's metadata so the \
             user can investigate the root cause and propose a fix.",
            &["alert_block"],
            "Acabo de recibir una notificación crítica en el Control Center:\n\n{alert_block}\n\nInvestiga la causa raíz y propón un fix. Si el origen no está claro:\n1. Identifica qué proceso o script emitió la alerta (busca el mensaje exacto en el repo).\n2. Lee los archivos implicados.\n3. Propón hipótesis ordenadas por probabilidad.\n4. Verifica una hipótesis a la vez antes de tocar nada.\n\nResume el plan antes de aplicar cambios.",
        ),
        default_button(
            "notif.fix_all",
            "Notifications · Fix all alerts",
            "Notifications / header bulk button",
            "Opens a single session preloaded with every actionable alert \
             (critical + warn) for a coordinated fix.",
            &["bulk_block"],
            "Tengo varias notificaciones pendientes en el Control Center. Investígalas todas y propón fixes coordinados.\n\n{bulk_block}\n\nPasos:\n1. Identifica la causa raíz — ¿son síntomas del mismo problema?\n2. Agrupa alertas relacionadas.\n3. Propón una secuencia de fixes priorizada (critical antes que warn).\n4. Para cada fix: qué cambiar, archivo afectado y riesgo.\n\nEspera mi OK antes de aplicar cambios.",
        ),
        default_button(
            "plans.sprint_ai",
            "Plans · Sprint AI",
            "Plans / Open column Sprint AI button",
            "Spawns a Claude session preloaded with all open plans. Cleans up \
             hand-written plans and proposes an actionable sprint ordered by priority.",
            &["open_plans_block"],
            "Tienes dos trabajos sobre los planes abiertos.\n\n## Planes abiertos (ordenados por prioridad)\n{open_plans_block}\n\n### 1. Reescribir los planes flojos\nVarios de estos planes los escribió el usuario a mano y pueden estar incompletos: título vago, descripción pobre o ausente, sin criterio de DONE, prioridad o kind dudosos. Para cada plan que lo necesite:\n- Reescribe el título a algo imperativo y concreto (<80 chars).\n- Mejora la descripción: 1-2 párrafos con contexto, alcance y un criterio de DONE verificable.\n- Corrige `priority` (p0-p4) y `kind` si están mal.\n- Aplica el cambio con `update_plan` (id, title, priority, kind, description, tags).\n\nNo inventes alcance que el usuario no pidió — solo aclara y estructura lo que ya está. Si un plan ya está bien escrito, déjalo.\n\n### 2. Proponer el sprint\nDespués, propón un sprint accionable de máximo 3-4 items. Para cada item:\n- Por qué es prioritario ahora.\n- Estimación realista (30min / 1h / 2h / 3h).\n- Criterio de DONE concreto y verificable.\n- Qué NO tocar.\n\nFormato: lista numerada, sin inflación.",
        ),
        default_button(
            "plans.resolve_one",
            "Plans · Open resolution session",
            "Plans / row → resolve",
            "Preloads a Claude session with one plan's metadata so the user \
             can refine the spec or push it to in_progress / resolved.",
            &["plan_id", "plan_title", "plan_status", "plan_priority", "plan_description"],
            "Plan ID: {plan_id}\nTitle: {plan_title}\nStatus: {plan_status}\nPriority: {plan_priority}\n\nDescription:\n{plan_description}\n\nQuiero trabajar en este plan ahora.\n\nPasos:\n1. Si existe un spec asociado, léelo primero.\n2. Propón un plan de ejecución dividido en tareas pequeñas (<1h cada una).\n3. Empieza por la primera tarea.\n4. Cuando termines, marca el plan como resolved (o blocked con nota si te atascas).",
        ),
        // v2.5.2 (fb-031): `selfimprove.repo_evaluator` removed — SelfImprove
        // tab no longer exists and repo evaluation now lives in Library/Catalog.
        default_button(
            "system.schedule_task_ai",
            "System · New scheduled task with AI",
            "System / scheduled-tasks header",
            "Opens a Claude session so the user can register a new OS-level scheduled task.",
            &[],
            "Vamos a registrar una nueva tarea programada del sistema operativo.\n\nDetalles a definir:\n1. Nombre claro (prefijo identificable + acción, p.ej. `cc-news-daily`).\n2. Trigger (diario, semanal, al login, cron expression).\n3. Acción (comando o script a ejecutar).\n4. Working directory.\n5. Tratamiento de errores (capturar exit code, log).\n\nEn Windows usa `Register-ScheduledTask` (PowerShell), en macOS/Linux usa `launchd`/`systemd-timer`/`cron` según corresponda.\n\nPregúntame qué quiero programar, prepara el comando completo, y espera mi OK antes de ejecutarlo. Verifica el registro después con la utilidad correspondiente.",
        ),
        default_button(
            "usage.refresh_with_claude",
            "Usage · Refresh via /usage",
            "Usage / header refresh-with-AI",
            "Spawns a Claude session that runs the `/usage` slash command \
             so the local usage cache is refreshed against the Anthropic API.",
            &[],
            "/usage",
        ),
        // v2.5.1: news.generate_with_ai removed — News pipeline was dropped
        // in v2.0 and the prompt referenced surfaces that no longer exist.
        default_button(
            "mcps.add_with_ai",
            "MCPs · Add server with AI",
            "MCPs / header AI add button",
            "Spawns a Claude session so the user can register a new MCP server \
             in `~/.claude/settings.json`.",
            &[],
            "Vamos a añadir un MCP server a `~/.claude/settings.json` (sección `mcpServers`).\n\nFormato esperado por entrada:\n```json\n\"<name>\": {\n  \"command\": \"<exe>\",\n  \"args\": [\"...\"],\n  \"env\": { \"KEY\": \"VALUE\" }\n}\n```\n\nReglas:\n- `command` debe estar en una allowlist conocida (`npx`, `uvx`, `python`, `node`, binarios de servidores MCP oficiales).\n- Evita fragmentos peligrosos en `args` (`--exec`, redirecciones de shell, paths absolutos a binarios desconocidos).\n- Las variables sensibles van en `env`, nunca hardcoded en `args`.\n\nPregúntame nombre, comando, args y env. Valida el shape, propón el JSON a insertar, y espera mi OK antes de modificar el archivo. Tras añadir, sugiere correr `claude mcp list` para verificar que conecta.",
        ),
        default_button(
            "plans.execute",
            "Plans · Execute open plans",
            "Plans / header Execute button",
            "Opens a Claude session to walk through every open plan in priority \
             order and run them.",
            &[],
            "Ejecuta los planes pendientes en orden de prioridad (p0 → p4).\n\nPara cada plan con `status=open`:\n1. Márcalo `in_progress`.\n2. Lee su descripción y spec si existe.\n3. Propón un plan de ejecución corto.\n4. Ejecútalo.\n5. Al terminar, márcalo `resolved` (o `revision` si necesita más diseño, o `blocked` con nota si te atascas).\n\nNo trabajes más de un plan a la vez. Si vas a tocar archivos compartidos, avisa antes.",
        ),
        default_button(
            "plans.review",
            "Plans · Review revision plans",
            "Plans / header Review button",
            "Opens a Claude session that audits plans in status=revision (or \
             top-priority open ones) for staleness and proposes wontfix moves.",
            &[],
            "Revisa los planes con `status=revision` (y los `open` con prioridad p0/p1 si no hay ninguno en revisión).\n\nPara cada uno verifica:\n- ¿Sigue siendo accionable hoy?\n- ¿El alcance sigue vigente o ha quedado obsoleto?\n- ¿El spec referenciado existe y es coherente?\n- ¿Hay solapamiento con otros planes (deberían fusionarse)?\n\nSugiere mover a `wontfix` los que dejaron de tener sentido y resume los hallazgos antes de tocar nada.",
        ),
        default_button(
            "plans.add_from_goal",
            "Plans · Add plans from goal",
            "Plans / header Add-from-goal button",
            "Spawns a Claude session that turns a natural-language goal into \
             1-5 actionable plans via add_plan.",
            &[],
            "Voy a darte un objetivo en lenguaje natural. Conviértelo en 1-5 planes accionables vía `add_plan`.\n\nPara cada plan:\n- `title`: imperativo, <80 chars.\n- `priority`: p0-p4 según urgencia/impacto.\n- `kind`: `feature`, `bug`, `refactor`, `chore`, `research`, etc.\n- `description`: 1-2 párrafos con contexto, alcance y criterio de DONE.\n- `tags`: útiles para filtrar (área del repo, dominio).\n\nSi necesitas más contexto del repo, lee primero el README o la documentación principal.\n\nObjetivo: <ESCRIBE-AQUÍ>",
        ),
        default_button(
            "plans.resolve_in_progress",
            "Plans · Resolve in-progress plan",
            "Plans / header Resolve button",
            "Opens a Claude session that picks up the current in_progress \
             plan (or the top open p0/p1) and drives it to resolved.",
            &[],
            "Ayúdame a resolver el plan que tenga `status=in_progress` (o el primero `open` con prioridad p0/p1 si no hay ninguno en curso).\n\nPasos:\n1. Lee su `description` y el `spec_path` si existe.\n2. Resume en 3 líneas qué hay que hacer.\n3. Ejecuta los pasos.\n4. Cuando termines, márcalo `resolved`.\n5. Si te bloquea algo, márcalo `blocked` con una nota explicando qué falta.",
        ),
        default_button(
            "projects.suggest_refactor",
            "Projects · Suggest refactors",
            "Projects / row context menu",
            "Reads the project tree and proposes prioritized refactor opportunities.",
            &["project_path", "project_name"],
            "Estoy en el proyecto `{project_name}` (`{project_path}`).\n\nPasos:\n1. Lee el árbol de archivos hasta 2 niveles de profundidad.\n2. Identifica los 10 archivos más grandes.\n3. Detecta patrones de smell: funciones gigantes, archivos con responsabilidades mezcladas, duplicación obvia, acoplamientos rotos.\n4. Propón 3-5 refactors priorizados por impacto: qué cambiar, por qué, y un esbozo del approach.\n\nNO toques nada — sólo propón.",
        ),
        default_button(
            "projects.generate_readme",
            "Projects · Generate / update README",
            "Projects / row context menu",
            "Claude reads the project and drafts a README from scratch (or updates the existing one).",
            &["project_path", "project_name"],
            "Proyecto: `{project_name}` en `{project_path}`.\n\nSi existe `README.md`:\n- Léelo y compáralo con el estado actual del código.\n- Propón una versión refrescada que refleje lo que el repo hace HOY (no inventes features que no existan).\n\nSi no existe:\n- Genera un README completo: descripción, requisitos, instalación, uso básico, estructura de carpetas, guía de contribución.\n\nEn ambos casos: muéstrame el diff antes de escribir.",
        ),
        default_button(
            "sessions.summarize",
            "Sessions · Summarize session",
            "Sessions / row context menu",
            "Compress a Claude Code transcript into a 5-line summary + open TODOs.",
            &["session_id"],
            "Lee la sesión `{session_id}` (transcripción + archivos de memoria si existen) y devuelve:\n\n1. Objetivo principal (1 línea).\n2. 3-5 decisiones clave tomadas.\n3. Problemas encontrados.\n4. TODOs pendientes (con ruta del archivo si aplica).\n5. Métrica de éxito (¿se cumplió el objetivo? sí / parcial / no).\n\nMáximo 200 palabras en total.",
        ),
        default_button(
            "sessions.extract_decisions",
            "Sessions · Extract decisions to vault",
            "Sessions / row context menu",
            "Pulls architectural decisions out of a session and writes them as ADR-style notes.",
            &["session_id"],
            "Lee la sesión `{session_id}`. Identifica decisiones arquitectónicas o de diseño que merezcan persistirse como ADR (Architecture Decision Record).\n\nPara cada decisión, propón un fichero Markdown con frontmatter ADR-style:\n```\n---\ntitle: <Decision title>\ndate: <YYYY-MM-DD>\nstatus: proposed | accepted | superseded\n---\n\n## Context\n## Decision\n## Consequences\n```\n\nSugiere la ruta destino (carpeta de decisiones del proyecto o vault de memoria). Espera mi OK antes de escribir.",
        ),
        default_button(
            "memory.consolidate",
            "Memory · Consolidate duplicates",
            "Memory / list header",
            "Spawns a session that scans the memory store for duplicates and obsolete notes.",
            &[],
            "Activa la skill `consolidate-memory` si está disponible. En otro caso, hazlo manualmente:\n\n1. Recorre la carpeta de memoria persistente (`~/.claude/memory/` o el vault configurado).\n2. Busca notas duplicadas, fusionables o claramente obsoletas.\n3. Propón un plan de consolidación: qué fusionar con qué, qué archivar, qué eliminar.\n4. NO mergees nada sin mi OK.\n\nPrioriza la carpeta de conocimiento general antes que la de patrones o decisiones.",
        ),
        default_button(
            "memory.refresh_index",
            "Memory · Rebuild memory index",
            "Memory / list header",
            "Re-runs the memory index rebuild so search reflects the current vault state.",
            &[],
            "Reconstruye el índice de búsqueda de la memoria persistente.\n\nPasos:\n1. Identifica qué backend de indexado está configurado (FTS5, vectorial, o ambos).\n2. Ejecuta el rebuild correspondiente.\n3. Si hay un componente vectorial (p.ej. Qdrant), re-genera los embeddings de la colección.\n4. Reporta el conteo antes/después y cualquier nota que fallara al indexar.\n\nSi no encuentras el script de rebuild, pregúntame antes de inventar uno.",
        ),
        default_button(
            "system.hook_review",
            "System · Audit a hook",
            "System / hooks panel",
            "Claude reads a hook file and audits it for safety and side-effects.",
            &["hook_path"],
            "Audita el hook en `{hook_path}`.\n\nReporta:\n1. Qué eventos consume (PreToolUse, PostToolUse, Stop, etc.).\n2. Qué side-effects tiene (escribe archivos, lanza procesos, llama a red).\n3. Si puede bloquear ejecuciones (exit code 2 u otros mecanismos).\n4. Si tiene timeouts y manejo de errores.\n5. Riesgos de prompt-injection, command-injection o filtrado de datos sensibles.\n\nSugiere fixes concretos sólo si encuentras algo. No reescribas el hook sin pedir permiso.",
        ),
        default_button(
            "system.diagnose_runtime",
            "System · Diagnose runtime issue",
            "System / diagnostics panel",
            "Free-form Claude session preloaded with system context for ad-hoc troubleshooting.",
            &["symptom"],
            "Tengo este síntoma en el sistema:\n\n{symptom}\n\nPasos:\n1. Recopila contexto relevante (logs recientes, estado de procesos, configuración del componente sospechoso).\n2. Propón hipótesis ordenadas por probabilidad.\n3. Verifica una hipótesis a la vez con una prueba mínima antes de cambiar configuración.\n4. NO toques configuración sin mi OK explícito.",
        ),
        default_button(
            "mcps.debug_connection",
            "MCPs · Debug failing server",
            "MCPs / per-row debug button",
            "Loads a session focused on debugging one MCP server that won't connect.",
            &["mcp_name", "mcp_config"],
            "El MCP `{mcp_name}` no conecta. Config actual:\n\n```json\n{mcp_config}\n```\n\nPasos:\n1. Ejecuta `claude mcp list` y captura la línea correspondiente al server.\n2. Busca logs específicos si la herramienta los expone.\n3. Propón hipótesis ordenadas por probabilidad:\n   - Binario no encontrado en PATH.\n   - Autenticación fallida (token/env var ausente o caducado).\n   - Timeout de arranque.\n   - Args mal formados.\n   - Capability mismatch con el cliente.\n4. Verifica una hipótesis a la vez antes de modificar la config.",
        ),
        default_button(
            "agents.batch_migrate",
            "Agents · Batch migrate schema",
            "Agents / list header",
            "Walks every agent .md and proposes schema updates (model id, tools list, etc.).",
            &["target_change"],
            "Recorre `~/.claude/agents/*.md`. Para cada agent, propón los cambios necesarios para aplicar el siguiente migration target:\n\n{target_change}\n\nDevuelve un plan tabular con columnas: `agent | cambio sugerido | diff line`.\n\nEspera mi OK por lotes de 5 agents antes de tocar nada.",
        ),
        // v2.5.2 (fb-031): `logs.summarize_recent` removed — no Logs tab
        // exists; system.diagnose_runtime covers the use case.
    ]
}

// ---------------------------------------------------------------------------
// Storage layer — on-disk JSON shape.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StoredCatalog {
    #[serde(default = "default_schema_version")]
    schema_version: u32,
    /// Map of key -> override prompt. We only persist overrides so future
    /// default tweaks propagate to users without forcing them to reset
    /// every entry by hand.
    #[serde(default)]
    overrides: BTreeMap<String, String>,
}

fn default_schema_version() -> u32 {
    1
}

/// Returns the active catalog path, falling back to the legacy ULTRON
/// location if an existing override file is still there. The new canonical
/// path lives under `~/.claude/projects/control-center/button-prompts.json`
/// so the Control Center can be used outside the historical ULTRON layout.
fn catalog_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let new_path = home
        .join(".claude")
        .join("projects")
        .join("control-center")
        .join("button-prompts.json");
    if new_path.exists() {
        return Some(new_path);
    }
    let legacy_path = home
        .join(".ultron")
        .join("cockpit")
        .join("button-prompts.json");
    if legacy_path.exists() {
        return Some(legacy_path);
    }
    Some(new_path)
}

fn read_stored() -> StoredCatalog {
    let Some(path) = catalog_path() else {
        return StoredCatalog::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return StoredCatalog::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_stored(stored: &StoredCatalog) -> Result<(), String> {
    let path = catalog_path().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {}", e))?;
        }
    }
    let serialized =
        serde_json::to_string_pretty(stored).map_err(|e| format!("serialize: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &serialized).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Public API — used by lib.rs commands.
// ---------------------------------------------------------------------------

/// Build the merged catalog (defaults + on-disk overrides). Used by both the
/// list command and the helper that resolves a single prompt for a consumer.
pub fn build_catalog() -> ButtonPromptsCatalog {
    let stored = read_stored();
    let defaults = build_defaults();
    let mut buttons = Vec::with_capacity(defaults.len());
    for mut b in defaults {
        if let Some(override_text) = stored.overrides.get(&b.key) {
            if override_text != &b.default_prompt {
                b.prompt = override_text.clone();
                b.overridden = true;
            }
        }
        buttons.push(b);
    }
    ButtonPromptsCatalog {
        schema_version: 1,
        buttons,
    }
}

/// Returns the merged catalog and ensures the on-disk file exists. The first
/// time the user opens the Settings tab we materialise an empty `overrides`
/// object so they can see the file path in the JSON editor if they ever need
/// to share it.
///
/// The lock is acquired only for the best-effort initialisation write so
/// concurrent calls cannot both observe `!p.exists()` and race to create the
/// file. The subsequent `build_catalog()` call is a pure read and needs no lock.
pub fn list_button_prompts_inner() -> Result<ButtonPromptsCatalog, String> {
    let stored = read_stored();
    let path = catalog_path();
    if let Some(p) = &path {
        if !p.exists() {
            // Best-effort materialisation under the write lock so two concurrent
            // callers (e.g. rapid Settings opens) cannot both race through
            // `!p.exists()` and write the file simultaneously. We swallow
            // errors so a missing HOME or read-only filesystem never blocks the UI.
            let _guard = button_prompts_lock()
                .lock()
                .map_err(|e| format!("button-prompts lock poisoned: {}", e))?;
            // Re-check inside the lock: another thread may have created it
            // between the outer check and acquiring the lock.
            if !p.exists() {
                let _ = write_stored(&stored);
            }
        }
    }
    Ok(build_catalog())
}

/// Persist (or unset) an override for a single button. Empty/whitespace-only
/// prompts are treated as "reset to default".
///
/// The `BUTTON_PROMPTS_WRITE_LOCK` is held across the entire read_stored →
/// mutate → write_stored so concurrent callers cannot interleave and lose each
/// other's changes. The final `build_catalog()` is a pure read after the write
/// has landed on disk, so it is intentionally outside the critical section.
pub fn update_button_prompt_inner(key: String, prompt: String) -> Result<ButtonPrompt, String> {
    let defaults = build_defaults();
    let default_entry = defaults
        .iter()
        .find(|b| b.key == key)
        .ok_or_else(|| format!("unknown button key: {}", key))?;

    {
        let _guard = button_prompts_lock()
            .lock()
            .map_err(|e| format!("button-prompts lock poisoned: {}", e))?;

        let mut stored = read_stored();
        let trimmed = prompt.trim();
        if trimmed.is_empty() || trimmed == default_entry.default_prompt.trim() {
            stored.overrides.remove(&key);
        } else {
            stored.overrides.insert(key.clone(), prompt.clone());
        }
        write_stored(&stored)?;
    } // _guard dropped here — lock released before the pure catalog read

    let catalog = build_catalog();
    catalog
        .buttons
        .into_iter()
        .find(|b| b.key == key)
        .ok_or_else(|| format!("button vanished after write: {}", key))
}

/// Drop the override for a single button (back to canonical default).
pub fn reset_button_prompt_inner(key: String) -> Result<ButtonPrompt, String> {
    update_button_prompt_inner(key, String::new())
}

/// Resolve a single key with `{var}`-style substitution. Used by future
/// migrations that move prompt resolution into the backend (today the
/// frontend does it via `src/lib/button-prompts.ts`).
pub fn get_button_prompt_inner(
    key: String,
    vars: BTreeMap<String, String>,
) -> Result<String, String> {
    let catalog = build_catalog();
    let entry = catalog
        .buttons
        .into_iter()
        .find(|b| b.key == key)
        .ok_or_else(|| format!("unknown button key: {}", key))?;
    let mut out = entry.prompt;
    for (k, v) in &vars {
        let placeholder = format!("{{{}}}", k);
        out = out.replace(&placeholder, v);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: minimal interpolation that mirrors what `get_button_prompt_inner`
    /// does, without touching disk or the catalog. Keeps the test isolated.
    fn interpolate(template: &str, vars: &[(&str, &str)]) -> String {
        let mut out = template.to_string();
        for (k, v) in vars {
            let placeholder = format!("{{{}}}", k);
            out = out.replace(&placeholder, v);
        }
        out
    }

    #[test]
    fn interpolation_replaces_vars() {
        let template = "Quiero editar el skill (`~/.claude/skills/{skill_name}/SKILL.md`).\n\
                        Instrucción:\n{ai_instruction}";
        let rendered = interpolate(
            template,
            &[
                ("skill_name", "agents"),
                ("ai_instruction", "rename FooBar to foo_bar"),
            ],
        );
        assert!(rendered.contains("~/.claude/skills/agents/SKILL.md"));
        assert!(rendered.contains("rename FooBar to foo_bar"));
        assert!(!rendered.contains("{skill_name}"));
        assert!(!rendered.contains("{ai_instruction}"));
    }

    #[test]
    fn default_catalog_has_seed_entries() {
        let defaults = build_defaults();
        let keys: std::collections::HashSet<&str> =
            defaults.iter().map(|b| b.key.as_str()).collect();
        assert!(keys.contains("dashboard.pc_diagnose_analyse"));
        assert!(keys.contains("skills.create_with_ai"));
        assert!(keys.contains("agents.edit_with_ai"));
        assert!(
            defaults.len() >= 10,
            "expected >= 10 default buttons, got {}",
            defaults.len()
        );

        for b in &defaults {
            assert!(!b.prompt.is_empty(), "{} has empty prompt", b.key);
            assert_eq!(b.prompt, b.default_prompt, "{} default mismatch", b.key);
            assert!(
                !b.overridden,
                "{} should not be marked overridden by default",
                b.key
            );
        }
    }

    #[test]
    fn defaults_have_no_ultron_specific_refs() {
        // Atemporal / non-ULTRON guard. Catches accidental regressions.
        let defaults = build_defaults();
        let forbidden = [
            "~/.ultron",
            "cockpit/",
            "ULTRON",
            "intent-rules.yaml",
            "AI Router",
            "Brain Index",
            "v15.",
            "v2.0",
        ];
        for b in &defaults {
            for token in &forbidden {
                assert!(
                    !b.prompt.contains(token),
                    "prompt {} contains forbidden token {:?}",
                    b.key,
                    token
                );
                assert!(
                    !b.description.contains(token),
                    "description {} contains forbidden token {:?}",
                    b.key,
                    token
                );
            }
        }
    }

    #[test]
    fn merge_overrides_overlays_default_atomic() {
        let defaults = build_defaults();
        let sample_key = "skills.create_with_ai";
        let default_prompt = defaults
            .iter()
            .find(|b| b.key == sample_key)
            .map(|b| b.default_prompt.clone())
            .expect("seed key present");

        let mut overrides: BTreeMap<String, String> = BTreeMap::new();
        overrides.insert(sample_key.to_string(), "CUSTOM PROMPT".to_string());

        let mut merged = Vec::with_capacity(defaults.len());
        for mut b in defaults {
            if let Some(override_text) = overrides.get(&b.key) {
                if override_text != &b.default_prompt {
                    b.prompt = override_text.clone();
                    b.overridden = true;
                }
            }
            merged.push(b);
        }
        let entry = merged
            .iter()
            .find(|b| b.key == sample_key)
            .expect("merged entry");
        assert_eq!(entry.prompt, "CUSTOM PROMPT");
        assert_eq!(entry.default_prompt, default_prompt);
        assert!(entry.overridden);

        let sibling = merged
            .iter()
            .find(|b| b.key == "dashboard.pc_diagnose_analyse")
            .expect("sibling entry");
        assert!(!sibling.overridden);
        assert_eq!(sibling.prompt, sibling.default_prompt);
    }
}
