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
    /// AI Router zone this button uses (informational only — the consumer
    /// decides whether to honour it). Empty string when unknown.
    pub zone: String,
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
    zone: &str,
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
        zone: zone.to_string(),
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
            "diagnose",
            &["report_json"],
            "Analiza este reporte de diagnostico PC y dime exactamente que esta mal, por orden de gravedad. Para cada problema, propon un fix concreto (comando o accion). Si todo esta bien, dilo en una linea.\n\nReporte (JSON):\n```json\n{report_json}\n```",
        ),
        default_button(
            "skills.create_with_ai",
            "Skills · AI create",
            "Skills / list header",
            "Spawns a Claude session in the skills GUIDE folder so Claude can \
             walk the user through creating a new SKILL.md.",
            "skill_create",
            &[],
            "Vamos a crear un nuevo skill para Claude Code. Lee el GUIDE.md de esta carpeta para conocer el schema YAML, allowed-tools, layers (active/vault) y post-creation. Después pregúntame slug, descripción y triggers, y genera el SKILL.md completo en ~/.claude/skills/<slug>/ o ~/.ultron/skill-vault/<slug>/ según indique.",
        ),
        default_button(
            "skills.edit_with_ai",
            "Skills · AI edit",
            "Skills / detail · Preview · AI Edit",
            "Used inside the skill preview to apply a natural-language edit to \
             an existing SKILL.md.",
            "skill_edit",
            &["skill_name", "ai_instruction"],
            "Quiero editar este skill (~/.claude/skills/{skill_name}/SKILL.md).\n\nInstrucción:\n{ai_instruction}\n\nLee primero el SKILL.md actual y los archivos hermanos si son relevantes. Propon el cambio como diff antes de escribir. Mantén el frontmatter YAML válido.",
        ),
        default_button(
            "agents.edit_with_ai",
            "Agents · AI edit",
            "Agents / detail header",
            "Opens a Claude session in ~/.claude/agents to edit the selected agent.",
            "",
            &["agent_name"],
            "Quiero editar este agent (~/.claude/agents/{agent_name}.md).\n\nLee primero el archivo y proponme cambios concretos. Mantén el frontmatter YAML válido.",
        ),
        default_button(
            "agents.discover_online",
            "Agents · Discover online",
            "Agents / list header",
            "Asks Claude to scout GitHub for useful Claude Code agents and \
             offer to download them locally.",
            "",
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
            "memory_analyse",
            &[],
            "Vamos a escribir una nueva nota para el vault Obsidian (~/.ultron-vault). Lee el GUIDE.md de esta carpeta para conocer la estructura PARA (10_KNOWLEDGE, 20_PROJECTS...), frontmatter requerido y convenciones. Pregúntame el tema, propon ubicación y título, escribe la nota y luego corre brain_index.py update + embed_vault.py index.",
        ),
        default_button(
            "notif.fix_one",
            "Notifications · Fix one alert",
            "Notifications / per-row button",
            "Opens a session preloaded with a single alert's metadata so the \
             user can investigate the root cause and propose a fix.",
            "notif_fix",
            &["alert_block"],
            "I just got a CRITICAL ULTRON notification:\n\n{alert_block}\n\nPlease investigate the root cause and propose a fix. The relevant files are likely under ~/.ultron/scripts/ or ~/.ultron/control-center/. If this is a security scan blocking a skill, check the skill's SKILL.md frontmatter and the security ruleset at ~/.ultron/scripts/cockpit/skill_sync_security.py.",
        ),
        default_button(
            "notif.fix_all",
            "Notifications · Fix all alerts",
            "Notifications / header bulk button",
            "Opens a single session preloaded with every actionable alert \
             (critical + warn) for a coordinated fix.",
            "notif_fix",
            &["bulk_block"],
            "I'm getting multiple ULTRON notifications. Please investigate ALL of them and propose fixes. Group related ones if applicable, prioritize critical over warn.\n\n{bulk_block}\n\nPlease:\n1. Identify the root cause(s) — are these symptoms of one underlying issue?\n2. Propose a coordinated fix sequence.\n3. Start by reading scripts/cockpit/skill_sync_security.py if security warns are involved, and ~/.ultron/alerts.jsonl for the full context.",
        ),
        default_button(
            "plans.brainstorm",
            "Plans · AI brainstorm",
            "Plans / header AI Brainstorm button",
            "Seeds an interactive Claude/Codex session with a brainstorming \
             prompt that converges on a plans JSON ready for `ultron plans add`.",
            "brainstorm_plans",
            &[],
            "Vamos a hacer brainstorming de un nuevo plan para ULTRON.\n\nPregúntame qué quiero conseguir, refina alcance iterando conmigo, propón sub-tareas concretas, y al final genera el JSON de `ultron plans add` listo para ejecutar (o varios bloques si salen varios planes). Esquema:\n\n{\n  \"title\": \"imperativo, <80 chars\",\n  \"priority\": \"p0..p4\",\n  \"kind\": \"task|sprint|patch|bug|research|audit\",\n  \"status\": \"open\",\n  \"description\": \"1-2 párrafos\",\n  \"tags\": [\"...\"]\n}\n\nLee ~/.ultron/instructions/plans/GUIDE.md antes de empezar para no inventar campos.",
        ),
        default_button(
            "plans.resolve_one",
            "Plans · Open resolution session",
            "Plans / row → resolve",
            "Preloads a Claude session with one plan's metadata so the user \
             can refine the spec or push it to in_progress / resolved.",
            "brainstorm_plans",
            &["plan_id", "plan_title", "plan_status", "plan_priority", "plan_description"],
            "Plan ID: {plan_id}\nTitle: {plan_title}\nStatus: {plan_status}\nPriority: {plan_priority}\n\nDescription:\n{plan_description}\n\nQuiero trabajar en este plan. Lee primero el spec si existe en plans/specs/, después propon el plan de ejecución dividido en tareas pequeñas y empieza por la primera.",
        ),
        default_button(
            "selfimprove.repo_evaluator",
            "SelfImprove · Run repo-evaluator",
            "SelfImprove / RepoEvaluatorCard",
            "Spawns a Claude session that activates the repo-evaluator skill \
             for a strict professor-style review of the ULTRON repo.",
            "self_improve",
            &[],
            "repo-evaluator, evalua este repo (~/.ultron) al estilo de un profesor estricto: arquitectura, tests, docs, riesgos, dependencias, y dame nota final con justificacion. Empieza por la fase 0 de inventario.",
        ),
        default_button(
            "system.schedule_task_ai",
            "System · New scheduled task with AI",
            "System / scheduled-tasks header",
            "Opens a Claude session in instructions/tasks so the user can \
             register a new Windows scheduled task following the ULTRON convention.",
            "system_analyse",
            &[],
            "Vamos a registrar una nueva scheduled task de Windows. Lee el GUIDE.md de esta carpeta para conocer la convención (prefix ULTRON-, wrapper PowerShell, exit-swallow, log en cockpit/scheduler-logs/). Después pregúntame qué quiero programar y prepara el New-ScheduledTaskAction completo, lo registramos y validamos con Get-ScheduledTaskInfo.",
        ),
        default_button(
            "usage.refresh_with_claude",
            "Usage · Refresh via /usage",
            "Usage / header refresh-with-AI",
            "Spawns a Claude session that runs the `/usage` slash command \
             so the local cache is refreshed against the Anthropic API.",
            "usage_analyse",
            &[],
            "/usage",
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
