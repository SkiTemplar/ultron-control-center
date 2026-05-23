// ULTRON Control Center — Button prompts catalog
//
// Every Control Center button that spawns an AI session used to embed its
// prompt as a hardcoded string literal inside the relevant component (e.g.
// Dashboard.tsx, Skills.tsx, Agents.tsx). That made the prompts impossible
// to tune without recompiling the app.
//
// This module centralises every prompt in `~/.ultron/cockpit/button-prompts.json`
// keyed by a stable identifier ("dashboard.pc_diagnose_analyse", ...). The
// frontend reads/writes the catalog through two commands:
//
//   - list_button_prompts() -> ButtonPromptsCatalog
//   - update_button_prompt(key, prompt) -> updated entry
//   - reset_button_prompt(key) -> entry restored to default
//
// On first read we materialise the catalog with the canonical defaults so the
// Settings tab can render them right away. Subsequent reads merge stored
// overrides on top of the live defaults; that way new buttons added in
// future versions show up automatically without forcing the user to delete
// the JSON file.
//
// Writes are atomic (tmp + rename) to avoid leaving a half-written catalog
// on disk if the process crashes mid-save.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ButtonPrompt {
    /// Stable identifier, e.g. "dashboard.pc_diagnose_analyse".
    pub key: String,
    /// Short user-facing label shown in the Settings list.
    pub label: String,
    /// Where in the Control Center the button lives ("Dashboard / PC
    /// diagnostics", "Skills / Detail view", ...).
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
            "Analyse with Claude",
            "Dashboard / PC diagnostics",
            "Opens a Claude session preloaded with the PC diagnostic report and \
             asks for a prioritised list of fixes.",
            &["report_json"],
            "Analiza este reporte de diagnostico PC y dime exactamente que esta mal, por orden de gravedad. Para cada problema, propon un fix concreto (comando o accion). Si todo esta bien, dilo en una linea.\n\nReporte (JSON):\n```json\n{report_json}\n```",
        ),
        default_button(
            "skills.create_with_ai",
            "Skills · AI create",
            "Skills / list header",
            "Spawns a Claude session in the skills GUIDE folder so Claude can \
             walk the user through creating a new SKILL.md.",
            &[],
            "Vamos a crear un nuevo skill para Claude Code. Lee el GUIDE.md de esta carpeta para conocer el schema YAML, allowed-tools, layers (active/vault) y post-creation. Después pregúntame slug, descripción y triggers, y genera el SKILL.md completo en ~/.claude/skills/<slug>/ o ~/.ultron/skill-vault/<slug>/ según indique.",
        ),
        default_button(
            "skills.edit_with_ai",
            "Skills · AI edit",
            "Skills / detail · Preview · AI Edit",
            "Used inside the skill preview to apply a natural-language edit to \
             an existing SKILL.md.",
            &["skill_name", "ai_instruction"],
            "Quiero editar este skill (~/.claude/skills/{skill_name}/SKILL.md).\n\nInstrucción:\n{ai_instruction}\n\nLee primero el SKILL.md actual y los archivos hermanos si son relevantes. Propon el cambio como diff antes de escribir. Mantén el frontmatter YAML válido.",
        ),
        default_button(
            "agents.edit_with_ai",
            "Agents · AI edit",
            "Agents / detail header",
            "Opens a Claude session in ~/.claude/agents to edit the selected agent.",
            &["agent_name"],
            "Quiero editar este agent (~/.claude/agents/{agent_name}.md).\n\nLee primero el archivo y proponme cambios concretos. Mantén el frontmatter YAML válido.",
        ),
        default_button(
            "agents.discover_online",
            "Agents · Discover online",
            "Agents / list header",
            "Asks Claude to scout GitHub for useful Claude Code agents and \
             offer to download them locally.",
            &[],
            "Busca agentes Claude Code útiles publicados en GitHub (anthropics/claude-code-templates, voltagent/awesome-claude-code-subagents, addyosmani/agent-skills, anthropic-cookbook). Lista 8-12 agentes con:\n- nombre (slug kebab-case)\n- una línea de descripción\n- URL del archivo .md raw en GitHub\n- por qué es útil\n\nDespués pregúntame cuáles quiero instalar y los descargas a ~/.claude/agents/<name>.md. Mantén el formato YAML frontmatter intacto.",
        ),
        // ─── v15.2.40 batch — wiring AI Router across every remaining button.
        default_button(
            "memory.new_note_ai",
            "Memory · New note with AI",
            "Memory / list header",
            "Spawns a Claude session in ~/.ultron/instructions/memory so the \
             user can draft a new vault note guided by GUIDE.md.",
            &[],
            "Vamos a escribir una nueva nota para el vault Obsidian (~/.ultron-vault). Lee el GUIDE.md de esta carpeta para conocer la estructura PARA (10_KNOWLEDGE, 20_PROJECTS...), frontmatter requerido y convenciones. Pregúntame el tema, propon ubicación y título, escribe la nota y luego corre brain_index.py update + embed_vault.py index.",
        ),
        default_button(
            "notif.fix_one",
            "Notifications · Fix one alert",
            "Notifications / per-row button",
            "Opens a session preloaded with a single alert's metadata so the \
             user can investigate the root cause and propose a fix.",
            &["alert_block"],
            "I just got a CRITICAL ULTRON notification:\n\n{alert_block}\n\nPlease investigate the root cause and propose a fix. The relevant files are likely under ~/.ultron/scripts/ or ~/.ultron/control-center/. If this is a security scan blocking a skill, check the skill's SKILL.md frontmatter and the security ruleset at ~/.ultron/scripts/cockpit/skill_sync_security.py.",
        ),
        default_button(
            "notif.fix_all",
            "Notifications · Fix all alerts",
            "Notifications / header bulk button",
            "Opens a single session preloaded with every actionable alert \
             (critical + warn) for a coordinated fix.",
            &["bulk_block"],
            "I'm getting multiple ULTRON notifications. Please investigate ALL of them and propose fixes. Group related ones if applicable, prioritize critical over warn.\n\n{bulk_block}\n\nPlease:\n1. Identify the root cause(s) — are these symptoms of one underlying issue?\n2. Propose a coordinated fix sequence.\n3. Start by reading scripts/cockpit/skill_sync_security.py if security warns are involved, and ~/.ultron/alerts.jsonl for the full context.",
        ),
        default_button(
            "plans.sprint_ai",
            "Plans · Sprint AI",
            "Plans / Open column Sprint AI button",
            "Spawns a Claude session preloaded with all open plans and their \
             priorities. Proposes an actionable sprint ordered P0→P3 AND \
             rewrites/sharpens any plan that was hand-written (vague title, \
             thin description, missing DONE criteria).",
            &["open_plans_block"],
            "Eres el orquestador de ULTRON. Tienes dos trabajos sobre los planes open.\n\n## Planes open (ordenados por prioridad)\n{open_plans_block}\n\n### 1. Reescribir los planes puestos a mano\nVarios de estos planes los escribió el usuario a mano y pueden estar flojos: título vago, descripción pobre o ausente, sin criterio de DONE, prioridad o kind dudosos. Para cada plan que lo necesite:\n- Reescribe el título a algo imperativo y concreto (<80 chars)\n- Mejora la descripción: 1-2 párrafos con contexto, alcance y un criterio de DONE verificable\n- Corrige priority (p0-p4) y kind si están mal\n- Aplica el cambio con `update_plan` (id, title, priority, kind, description, tags)\nNo inventes alcance que el usuario no pidió — solo aclara y estructura lo que ya está. Si un plan ya está bien escrito, déjalo.\n\n### 2. Proponer el sprint\nDespués, propón un sprint accionable de máximo 3-4 items. Para cada item:\n- Por qué es prioritario ahora\n- Estimación realista (30min / 1h / 2h / 3h)\n- Criterio de DONE concreto y verificable\n- Qué NO tocar\n\nFormato: lista numerada, sin inflación. Lee ~/.ultron/instructions/plans/GUIDE.md primero para no inventar campos del schema.",
        ),
        default_button(
            "plans.resolve_one",
            "Plans · Open resolution session",
            "Plans / row → resolve",
            "Preloads a Claude session with one plan's metadata so the user \
             can refine the spec or push it to in_progress / resolved.",
            &["plan_id", "plan_title", "plan_status", "plan_priority", "plan_description"],
            "Plan ID: {plan_id}\nTitle: {plan_title}\nStatus: {plan_status}\nPriority: {plan_priority}\n\nDescription:\n{plan_description}\n\nQuiero trabajar en este plan. Lee primero el spec si existe en plans/specs/, después propon el plan de ejecución dividido en tareas pequeñas y empieza por la primera.",
        ),
        default_button(
            "selfimprove.repo_evaluator",
            "SelfImprove · Run repo-evaluator",
            "SelfImprove / RepoEvaluatorCard",
            "Spawns a Claude session that activates the repo-evaluator skill \
             for a strict professor-style review of the ULTRON repo.",
            &[],
            "repo-evaluator, evalua este repo (~/.ultron) al estilo de un profesor estricto: arquitectura, tests, docs, riesgos, dependencias, y dame nota final con justificacion. Empieza por la fase 0 de inventario.",
        ),
        default_button(
            "system.schedule_task_ai",
            "System · New scheduled task with AI",
            "System / scheduled-tasks header",
            "Opens a Claude session in instructions/tasks so the user can \
             register a new Windows scheduled task following the ULTRON convention.",
            &[],
            "Vamos a registrar una nueva scheduled task de Windows. Lee el GUIDE.md de esta carpeta para conocer la convención (prefix ULTRON-, wrapper PowerShell, exit-swallow, log en cockpit/scheduler-logs/). Después pregúntame qué quiero programar y prepara el New-ScheduledTaskAction completo, lo registramos y validamos con Get-ScheduledTaskInfo.",
        ),
        default_button(
            "usage.refresh_with_claude",
            "Usage · Refresh via /usage",
            "Usage / header refresh-with-AI",
            "Spawns a Claude session that runs the `/usage` slash command \
             so the local cache is refreshed against the Anthropic API.",
            &[],
            "/usage",
        ),
        // ─── v15.3.5 batch — migrate the last remaining hardcoded prompts.
        default_button(
            "news.generate_with_ai",
            "News · Generate newsletter (Gemini)",
            "News / generator card",
            "Banner seed shown in the wt.exe Gemini tab opened by the \
             'Open Gemini session' button. The real prompt is built by \
             news_html_generator.py and copied to the clipboard. The seed \
             text reminds Gemini where to save the output HTML, which model \
             to use, and points the user at the personalisation hook \
             (~/.ultron/cockpit/news-topics.json). As of v15.5.18 the prompt \
             no longer enumerates 'titulares ya publicados' — novelty is \
             enforced by date (today/yesterday only) and by the SQLite \
             history filter post-generation.",
            &["today", "model"],
            "[BANNER — no es el prompt real] El prompt real lo genera news_html_generator.py y se copia a tu portapapeles. Pulsa Ctrl+V dentro de Gemini para usarlo. Output HTML → ~/.ultron/cockpit/news/newsletter-{today}.html. Modelo: {model}. Personaliza temas en ~/.ultron/cockpit/news-topics.json (defaults: AI, Claude Code, GitHub Claude tooling). Novedad por fecha (hoy/ayer); duplicados se filtran post-render contra news_history.db (retención 7d).",
        ),
        default_button(
            "mcps.add_with_ai",
            "MCPs · Add server with AI",
            "MCPs / header AI add button",
            "Spawns a Claude session in ~/.ultron/instructions/mcps so the \
             user can register a new MCP server following the GUIDE's \
             allowlist and validation rules.",
            &[],
            "Vamos a añadir un MCP server a ~/.claude/settings.json. Lee el GUIDE.md de esta carpeta para conocer la allowlist de commands, fragmentos prohibidos en args y el shape esperado. Después pregúntame nombre, comando, args y env, valida con la allowlist y registra el MCP (espera mi OK antes de escribir). Tras añadir, ejecuta mcp_health_check.py.",
        ),
        default_button(
            "plans.execute",
            "Plans · Execute open plans",
            "Plans / header Execute button",
            "Opens a Claude session in instructions/plans to walk through \
             every open plan in priority order and run them.",
            &[],
            "Claude, ejecuta lo que tenemos pendiente en PLANS.json. Lee primero el GUIDE.md de esta carpeta y los items con status=open en orden de priority (p0→p4). Para cada uno: márcalo in_progress con patch_plan_status, propon plan de ejecución corto, y si lo terminas, márcalo resolved o revision según corresponda.",
        ),
        default_button(
            "plans.review",
            "Plans · Review revision plans",
            "Plans / header Review button",
            "Opens a Claude session that audits plans in status=revision (or \
             top-priority open ones) for staleness and proposes wontfix moves.",
            &[],
            "Claude, revisa los planes con status=revision (y los open p0/p1 si no hay revision). Verifica que todavía sean accionables, sigan vigentes, y que el spec_path exista. Sugiere mover a wontfix los que dejaron de tener sentido. Resume hallazgos antes de tocar nada.",
        ),
        default_button(
            "plans.add_from_goal",
            "Plans · Add plans from goal",
            "Plans / header Add-from-goal button",
            "Spawns a Claude session that turns a natural-language goal into \
             1-5 actionable plans via add_plan.",
            &[],
            "Claude, voy a darte un goal en lenguaje natural. Crea 1-5 planes accionables vía add_plan siguiendo el GUIDE.md (priority p0-p4, kind apropiado, tags útiles, description 1-2 párrafos). Si necesitas más contexto del repo, lee ~/.ultron/MEMORY.md primero. Goal: <ESCRIBE-AQUÍ>",
        ),
        default_button(
            "plans.resolve_in_progress",
            "Plans · Resolve in-progress plan",
            "Plans / header Resolve button",
            "Opens a Claude session that picks up the current in_progress \
             plan (or the top open p0/p1) and drives it to resolved.",
            &[],
            "Claude, ayúdame a resolver el plan que tenga in_progress (o el primero open p0/p1). Lee su description + spec_path si existe, ejecuta los pasos, y cuando termines márcalo resolved. Si te bloquea algo, márcalo blocked con una nota explicando.",
        ),
        // ─── v15.4 batch — fill remaining empty sections so every tab has at least
        // one AI shortcut. Projects / Sessions had none; Memory, System and MCPs
        // only had a single prompt. (Personal tab dropped in v2.1.)
        default_button(
            "projects.suggest_refactor",
            "Projects · Suggest refactors",
            "Projects / row context menu",
            "Reads the project tree and proposes prioritized refactor opportunities.",
            &["project_path", "project_name"],
            "Estoy en {project_name} ({project_path}). Lee el árbol de archivos a 2 niveles y los top-10 archivos por tamaño. Propón 3-5 refactors prioritizados por impacto: qué cambiar, por qué, y un esbozo del approach. NO toques nada, solo propón.",
        ),
        default_button(
            "projects.generate_readme",
            "Projects · Generate / update README",
            "Projects / row context menu",
            "Claude reads the project and drafts a README from scratch (or updates the existing one).",
            &["project_path", "project_name"],
            "Lee {project_path}. Si existe README.md, propón una versión refrescada que refleje el estado actual del código (no inventes features que no estén). Si no existe, genera uno completo: descripción, install, uso básico, estructura de carpetas, contribución. Diff antes de escribir.",
        ),
        default_button(
            "sessions.summarize",
            "Sessions · Summarize session",
            "Sessions / row context menu",
            "Compress a Claude Code transcript into a 5-line summary + open TODOs.",
            &["session_id"],
            "Lee la sesión {session_id} (TRANSCRIPT.md + memory/* si existe). Devuelve:\n1. Objetivo principal (1 línea)\n2. 3-5 decisiones clave\n3. Problemas encontrados\n4. TODOs pendientes (con ruta del archivo si aplica)\n5. Una métrica de éxito (¿se cumplió el objetivo? sí/parcial/no)\n\nMáximo 200 palabras total.",
        ),
        default_button(
            "sessions.extract_decisions",
            "Sessions · Extract decisions to vault",
            "Sessions / row context menu",
            "Pulls architectural decisions out of a session and writes them as 20_DECISIONS notes.",
            &["session_id"],
            "Lee la sesión {session_id}. Identifica decisiones arquitectónicas o de diseño que merezcan persistirse en ~/.ultron-vault/20_DECISIONS/. Para cada una, propón un fichero con frontmatter ADR-style (title, date, status, context, decision, consequences). Espera mi OK antes de escribir.",
        ),
        default_button(
            "memory.consolidate",
            "Memory · Consolidate duplicates",
            "Memory / list header",
            "Spawns a session that calls the consolidate-memory skill across the vault.",
            &[],
            "Activa la skill consolidate-memory. Recorre ~/.ultron-vault buscando notas duplicadas, fusionables o claramente obsoletas. Propón un plan de consolidación (no mergees nada sin mi OK). Prioriza 10_KNOWLEDGE y 30_PATTERNS.",
        ),
        default_button(
            "memory.refresh_index",
            "Memory · Rebuild brain_index",
            "Memory / list header",
            "Re-runs brain_index.py rebuild for a clean FTS5 index.",
            &[],
            "Ejecuta `uv run python ~/.ultron/scripts/cockpit/brain_index.py rebuild` y luego `embed_vault.py` para re-vectorizar Qdrant. Reporta el conteo antes/después y cualquier nota que fallara al indexar.",
        ),
        default_button(
            "system.hook_review",
            "System · Audit a hook",
            "System / hooks panel",
            "Claude reads a hook file and audits it for safety + side-effects.",
            &["hook_path"],
            "Audita el hook {hook_path}. Reporta: (a) qué eventos consume, (b) qué side-effects tiene, (c) si puede bloquear (exit 2), (d) si tiene timeouts, (e) riesgos de prompt-injection o command-injection. Sugiere fixes concretos solo si encuentras algo.",
        ),
        default_button(
            "system.diagnose_runtime",
            "System · Diagnose runtime issue",
            "System / diagnostics panel",
            "Free-form Claude session preloaded with system context for ad-hoc troubleshooting.",
            &["symptom"],
            "Tengo este síntoma: {symptom}\n\nLee ~/.ultron/SYSTEM-MAP.md primero, después haz `ultron doctor`, y propón hipótesis + verificación. NO toques configuración sin mi OK.",
        ),
        default_button(
            "mcps.debug_connection",
            "MCPs · Debug failing server",
            "MCPs / per-row debug button",
            "Loads a session focused on debugging one MCP server that won't connect.",
            &["mcp_name", "mcp_config"],
            "El MCP `{mcp_name}` no conecta. Config actual:\n```json\n{mcp_config}\n```\n\nEjecuta `claude mcp list`, busca el error en logs si está disponible, y propón hipótesis: (a) binario no encontrado, (b) auth fallida, (c) timeout, (d) args mal formados, (e) capability mismatch. Verifica una hipótesis a la vez antes de cambiar config.",
        ),
        default_button(
            "agents.batch_migrate",
            "Agents · Batch migrate schema",
            "Agents / list header",
            "Walks every agent .md and proposes schema updates (model id, tools list, etc.).",
            &["target_change"],
            "Recorre ~/.claude/agents/*.md. Para cada uno, propón los cambios necesarios para aplicar: {target_change}\n\nDevuelve un plan tabular (agent | cambio sugerido | diff line) ANTES de tocar nada. Espera mi OK por lotes de 5 agents.",
        ),
        default_button(
            "logs.summarize_recent",
            "Logs · Summarize recent log file",
            "Logs / per-row context menu",
            "Compress the tail of a log file into a 5-line summary + flagged issues.",
            &["log_path"],
            "Lee la cola (últimas 500 líneas) de {log_path} y devuelve:\n1. Qué proceso lo escribe\n2. Eventos relevantes (errores, warnings, transiciones)\n3. ¿Hay un patrón anómalo?\n4. Sugerencia de siguiente paso (investigar/silenciar/ignorar)\n\nMáximo 150 palabras.",
        ),
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

fn catalog_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/cockpit/button-prompts.json"))
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
            fs::create_dir_all(parent).map_err(|e| format!("mkdir cockpit: {}", e))?;
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
pub fn list_button_prompts_inner() -> Result<ButtonPromptsCatalog, String> {
    let stored = read_stored();
    let path = catalog_path();
    if let Some(p) = &path {
        if !p.exists() {
            // Best-effort materialisation. We swallow the error so a missing
            // HOME or read-only filesystem never blocks the UI.
            let _ = write_stored(&stored);
        }
    }
    Ok(build_catalog())
}

/// Persist (or unset) an override for a single button. Empty/whitespace-only
/// prompts are treated as "reset to default".
pub fn update_button_prompt_inner(
    key: String,
    prompt: String,
) -> Result<ButtonPrompt, String> {
    let defaults = build_defaults();
    let default_entry = defaults
        .iter()
        .find(|b| b.key == key)
        .ok_or_else(|| format!("unknown button key: {}", key))?;
    let mut stored = read_stored();
    let trimmed = prompt.trim();
    if trimmed.is_empty() || trimmed == default_entry.default_prompt.trim() {
        stored.overrides.remove(&key);
    } else {
        stored.overrides.insert(key.clone(), prompt.clone());
    }
    write_stored(&stored)?;
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
        let template = "Quiero editar este skill (~/.claude/skills/{skill_name}/SKILL.md).\n\
                        Instrucción:\n{ai_instruction}";
        let rendered = interpolate(
            template,
            &[("skill_name", "agents"), ("ai_instruction", "rename FooBar to foo_bar")],
        );
        assert!(rendered.contains("~/.claude/skills/agents/SKILL.md"));
        assert!(rendered.contains("rename FooBar to foo_bar"));
        assert!(!rendered.contains("{skill_name}"));
        assert!(!rendered.contains("{ai_instruction}"));
    }

    #[test]
    fn default_catalog_has_seed_entries() {
        let defaults = build_defaults();
        // Spot-check known seed keys.
        let keys: std::collections::HashSet<&str> =
            defaults.iter().map(|b| b.key.as_str()).collect();
        assert!(keys.contains("dashboard.pc_diagnose_analyse"));
        assert!(keys.contains("skills.create_with_ai"));
        assert!(keys.contains("agents.edit_with_ai"));
        // Sanity: at least the minimum the v15.2.40 batch added.
        assert!(defaults.len() >= 10, "expected ≥10 default buttons, got {}", defaults.len());

        // Every entry: non-empty prompt, default_prompt == prompt, overridden=false.
        for b in &defaults {
            assert!(!b.prompt.is_empty(), "{} has empty prompt", b.key);
            assert_eq!(b.prompt, b.default_prompt, "{} default mismatch", b.key);
            assert!(!b.overridden, "{} should not be marked overridden by default", b.key);
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

        // Manually simulate the merge step (avoiding disk I/O via
        // build_catalog → read_stored which would read a real file).
        let mut overrides: BTreeMap<String, String> = BTreeMap::new();
        overrides.insert(sample_key.to_string(), "CUSTOM PROMPT".to_string());

        // Mimic build_catalog's merge loop:
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

        // A non-overridden sibling stays clean.
        let sibling = merged
            .iter()
            .find(|b| b.key == "dashboard.pc_diagnose_analyse")
            .expect("sibling entry");
        assert!(!sibling.overridden);
        assert_eq!(sibling.prompt, sibling.default_prompt);
    }
}
