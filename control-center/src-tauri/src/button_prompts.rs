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
// ("plans.sprint_ai", "notif.fix_one", ...). Defaults live in
// `button_prompts/defaults.rs` and are merged on read, so adding a new
// default in code makes it show up automatically for every user without
// forcing them to delete the JSON file.
//
// Un override guardado de una clave retirada (los 18 prompts sin botón que
// se quitaron el 2026-10-17, ver `defaults.rs`) se ignora al leer.
//
// Writes are atomic (tmp + rename) to avoid leaving a half-written catalog
// on disk if the process crashes mid-save.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

// Process-wide write lock: serialises the read-modify-write in
// `update_button_prompt_inner` / `list_button_prompts_inner` so concurrent Settings
// saves can't clobber each other's overrides (pure reads are excluded).
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
    /// Resolve button", "Notifications / per-row button", ...).
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

// Defaults — the single source of truth for every AI button prompt — live in
// `button_prompts/defaults.rs`.
mod defaults;
use defaults::build_defaults;

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

#[cfg(test)]
mod tests;
