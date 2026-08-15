// orchestrator/mod.rs — Orchestrator "Ultron" (Auto-routing #7)
//
// Maps a (possibly vague) prompt to an ORCHESTRATION CONTEXT:
//   prompt -> intent -> workflow -> delegate agents -> memories -> constraints.
//
// Intent classification is RULES-based on purpose: the master prompt says "no
// usar modelo grande para lo que resuelven reglas/triggers/metadata". The LLM
// (AI Routing #8) is reserved for the ambiguous tail later.
//
// Reuses, does NOT duplicate: agent catalog (memory::catalog), recall
// (commands::memory::recall_unified::build_trace), and the 7 built-in workflows
// (agent_orchestration::list_workflows_inner). The orchestrator NEVER writes
// persistent memory (only the Memory Agent does) and DELEGATES to the real
// agents in ~/.claude/agents (ghost agents are sanitized out).

pub(crate) mod delegation;
pub(crate) mod orchestrate;
pub(crate) mod personality;
pub(crate) mod ranking;
pub(crate) mod rules;
#[cfg(test)]
mod tests;
pub(crate) mod types_model;

pub use orchestrate::orchestrate;
pub use ranking::build_prompt_plan;
pub use rules::{classify_intent, detect_cross_project};
pub use types_model::{AgentChoice, OrchestrationContext, PromptPlan, SkillChoice, WorkflowChoice};

/// Tauri command: run the orchestrator for a prompt (the "Ultron" trigger).
#[tauri::command]
/// Devuelve el `OrchestrationContext` ya serializado. Es `Value` y no el tipo
/// porque la respuesta puede venir tal cual del daemon (que serializa ese mismo
/// tipo): así se evita añadir `Deserialize` en cascada a media docena de
/// structs solo para volver a serializarlos al cruzar a la UI. La forma del
/// JSON es idéntica en los dos caminos.
pub async fn orchestrate_prompt(
    prompt: String,
    project_id: Option<String>,
) -> Result<serde_json::Value, String> {
    // Manual on-demand invocation (UI badge): full semantic catalog (E5) + hybrid
    // recall (dense=true). The automatic per-prompt hot path (hook -> daemon/CLI)
    // uses dense=false to stay E5-free and under the <300ms budget.
    tauri::async_runtime::spawn_blocking(move || {
        // Primero el daemon: tiene E5 caliente y evita que la GUI cargue su
        // propia copia del modelo (~1,5 GB residentes medidos el 2026-08-15).
        // Si no contesta, se resuelve aqui como siempre.
        if let Some(v) = crate::daemon_client::orchestrate(
            &prompt,
            project_id.as_deref(),
            std::time::Duration::from_secs(25),
        ) {
            return Ok(v);
        }
        let ctx = orchestrate(&prompt, project_id.as_deref(), true);
        serde_json::to_value(&ctx).map_err(|e| format!("serialize orchestration: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

// ---------------------------------------------------------------------------
// Personalities v1 (2026-08-13) — Library → Tones + playground de detección.
// ---------------------------------------------------------------------------

/// Carga `~/.ultron/personality.json` (lo siembra si no existe).
#[tauri::command]
pub fn personalities_load() -> Result<personality::PersonalityFile, String> {
    let (file, warning) = personality::load_or_seed();
    if let Some(w) = warning {
        return Err(w);
    }
    Ok(file)
}

/// Guarda el archivo completo tras validar invariantes (ids únicos, default real).
#[tauri::command]
pub fn personalities_save(file: personality::PersonalityFile) -> Result<(), String> {
    personality::save(&file)
}

/// Playground: qué tono detectaría este prompt y POR QUÉ (scores por tono).
#[tauri::command]
pub fn personalities_detect(prompt: String) -> Result<personality::ToneDetection, String> {
    let (file, _) = personality::load_or_seed();
    Ok(personality::detect(&prompt, &file))
}

// ---------------------------------------------------------------------------
// Custom words (2026-08-13, petición del usuario): sección en Library → Tones
// para editar sin tocar JSON a mano (a) los status por tono de la statusline
// (cockpit/tone-status.json) y (b) los verbos del spinner de Claude Code
// (clave spinnerVerbs de ~/.claude/settings.json).
// ---------------------------------------------------------------------------

fn tone_status_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::ultron_root()?
        .join("cockpit")
        .join("tone-status.json"))
}

/// Mapa tono -> palabra o lista de palabras (la statusline rota las listas).
#[tauri::command]
pub fn tone_status_load() -> Result<serde_json::Value, String> {
    let raw = std::fs::read_to_string(tone_status_path()?).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tone_status_save(map: serde_json::Value) -> Result<(), String> {
    let obj = map.as_object().ok_or("tone-status debe ser un objeto")?;
    for (k, v) in obj {
        let valid = v.is_string()
            || v.as_array()
                .is_some_and(|a| !a.is_empty() && a.iter().all(|x| x.is_string()));
        if !valid && !k.starts_with('_') {
            return Err(format!("'{k}' debe ser string o lista de strings no vacía"));
        }
    }
    let json = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    std::fs::write(tone_status_path()?, json + "\n").map_err(|e| e.to_string())
}

fn claude_settings_path() -> Result<std::path::PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".claude").join("settings.json"))
        .ok_or_else(|| "No HOME dir".to_string())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SpinnerVerbsConfig {
    pub mode: String,
    pub verbs: Vec<String>,
}

/// Lee spinnerVerbs de ~/.claude/settings.json (defaults si no existe).
#[tauri::command]
pub fn spinner_verbs_load() -> Result<SpinnerVerbsConfig, String> {
    let raw = std::fs::read_to_string(claude_settings_path()?).map_err(|e| e.to_string())?;
    let doc: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    match doc.get("spinnerVerbs") {
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| e.to_string()),
        None => Ok(SpinnerVerbsConfig {
            mode: "replace".into(),
            verbs: Vec::new(),
        }),
    }
}

/// Escribe SOLO la clave spinnerVerbs preservando el resto del settings.json
/// (round-trip serde_json::Value). El schema real del binario exige objeto
/// {mode, verbs} — un formato inválido hace que Claude Code SALTE el settings
/// ENTERO (visto en vivo 2026-08-13), así que se valida antes de escribir.
#[tauri::command]
pub fn spinner_verbs_save(cfg: SpinnerVerbsConfig) -> Result<(), String> {
    if cfg.mode != "append" && cfg.mode != "replace" {
        return Err("mode debe ser 'append' o 'replace'".into());
    }
    if cfg.mode == "replace" && cfg.verbs.is_empty() {
        return Err("con mode 'replace' hace falta al menos un verbo".into());
    }
    if cfg.verbs.iter().any(|v| v.trim().is_empty()) {
        return Err("verbo vacío en la lista".into());
    }
    let path = claude_settings_path()?;
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut doc: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let obj = doc
        .as_object_mut()
        .ok_or("settings.json no es un objeto JSON")?;
    obj.insert(
        "spinnerVerbs".into(),
        serde_json::to_value(&cfg).map_err(|e| e.to_string())?,
    );
    let json = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, json + "\n").map_err(|e| e.to_string())
}
