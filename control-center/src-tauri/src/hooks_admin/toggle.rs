// hooks_admin/toggle.rs — activar y desactivar hooks sin escribir un tipo que
// Claude Code no acepta (ver disabled.rs).
//
// Orden de escritura, para que un fallo a medias no pierda la entrada:
//   - desactivar: primero el almacén, luego se quita de settings.json;
//   - activar: primero se devuelve a settings.json, luego se quita del almacén.
// Si la segunda escritura falla, la entrada queda en los dos sitios y el
// listado da prioridad a settings.json (activo).

use std::path::Path;

use serde_json::Value;

use super::disabled::{
    find_entry, insert_entry, read_store, store_path, write_store, DisabledHook,
};
use super::io::{
    delete_entry_by_id, flatten_hooks, mutate_entry_by_id, mutate_hooks, read_settings_value,
};
use super::types::{Hook, HookMutationResult};

fn result(hook: Hook, backup_path: Option<String>) -> HookMutationResult {
    HookMutationResult {
        success: true,
        hook: Some(hook),
        backup_path,
        manifest_sync: None,
    }
}

fn not_found(id: &str) -> String {
    format!("hook id '{}' not found", id)
}

fn store() -> Result<std::path::PathBuf, String> {
    store_path().ok_or_else(|| "no HOME".to_string())
}

/// Hooks del almacén que no están ya en settings.json (para el listado).
pub(crate) fn stored_hooks(in_settings: &[Hook]) -> Result<Vec<Hook>, String> {
    let items = read_store(&store()?)?;
    Ok(items
        .iter()
        .map(DisabledHook::to_hook)
        .filter(|h| !in_settings.iter().any(|s| s.id == h.id))
        .collect())
}

/// true si el hook `id` está guardado como desactivado fuera de settings.json.
pub(crate) fn is_stored(id: &str) -> Result<bool, String> {
    let in_settings = flatten_hooks(&read_settings_value()?)
        .iter()
        .any(|h| h.id == id);
    Ok(!in_settings && read_store(&store()?)?.iter().any(|d| d.id() == id))
}

fn disable(id: &str, root: &Value, store: &Path) -> Result<HookMutationResult, String> {
    let hooks = root
        .get("hooks")
        .and_then(|v| v.as_object())
        .ok_or_else(|| not_found(id))?;
    let item = find_entry(hooks, id).ok_or_else(|| not_found(id))?;
    let mut items = read_store(store)?;
    items.retain(|d| d.id() != id);
    items.push(item.clone());
    write_store(store, &items)?;
    let (_, backup_path) = mutate_hooks(|h| {
        delete_entry_by_id(h, id)?;
        Ok(Value::Null)
    })?;
    Ok(result(item.to_hook(), backup_path))
}

fn enable(id: &str, store: &Path) -> Result<HookMutationResult, String> {
    let mut items = read_store(store)?;
    let pos = items
        .iter()
        .position(|d| d.id() == id)
        .ok_or_else(|| not_found(id))?;
    let item = items.remove(pos);
    let (_, backup_path) = mutate_hooks(|h| {
        insert_entry(h, &item)?;
        Ok(Value::Null)
    })?;
    write_store(store, &items)?;
    let mut hook = item.to_hook();
    hook.enabled = true;
    Ok(result(hook, backup_path))
}

/// Entrada legada `disabled-command` en settings.json: se reactiva en su sitio.
fn enable_legacy(id: &str) -> Result<HookMutationResult, String> {
    let mut out: Option<Hook> = None;
    let (_, backup_path) = mutate_hooks(|h| {
        let hook = mutate_entry_by_id(h, id, |entry, _| {
            entry.insert("type".into(), Value::String("command".into()));
            Ok(())
        })?;
        out = Some(hook);
        Ok(Value::Null)
    })?;
    let hook = out.ok_or_else(|| not_found(id))?;
    Ok(result(hook, backup_path))
}

/// Deja el hook `id` activado o desactivado. Idempotente.
pub(crate) fn set_enabled_inner(id: &str, enabled: bool) -> Result<HookMutationResult, String> {
    let store = store()?;
    let root = read_settings_value()?;
    let current = flatten_hooks(&root).into_iter().find(|h| h.id == id);
    match (current, enabled) {
        (Some(h), true) if h.enabled => Ok(result(h, None)),
        (Some(_), true) => enable_legacy(id),
        (Some(_), false) => disable(id, &root, &store),
        (None, true) => enable(id, &store),
        (None, false) => read_store(&store)?
            .iter()
            .find(|d| d.id() == id)
            .map(|d| result(d.to_hook(), None))
            .ok_or_else(|| not_found(id)),
    }
}

/// Cambia el estado actual del hook `id`.
pub(crate) fn toggle_inner(id: &str) -> Result<HookMutationResult, String> {
    let current = flatten_hooks(&read_settings_value()?)
        .into_iter()
        .find(|h| h.id == id);
    let enable_it = !current.map(|h| h.enabled).unwrap_or(false);
    set_enabled_inner(id, enable_it)
}
