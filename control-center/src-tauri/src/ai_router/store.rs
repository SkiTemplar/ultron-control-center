// File I/O — read on demand; write atomically (unique tmp + rename) on save;
// metrics updates under a cross-process file lock.
// Also: provider/zone/metrics load helpers and the key-status utilities.

use std::collections::HashSet;
#[cfg(not(target_os = "windows"))]
use std::process::Stdio;

use once_cell::sync::Lazy;
use std::sync::Mutex;

use super::key_source::resolve_key;
use super::seed::seed_zones;
use super::types::{
    metrics_path, zones_path, ApiKeyStatus, Provider, ProviderKind, RouterMetrics, Zone,
};

// ---------------------------------------------------------------------------
// Generic JSON helpers (store/json_io.rs) and zone migrations
// (store/zone_migrations.rs)
// ---------------------------------------------------------------------------

mod json_io;
mod provider_migrations;
mod provider_overlay;
mod zone_migrations;

pub(crate) use json_io::{read_json, update_json_locked, write_json};
// En producción las migraciones del catálogo entran por `load_providers`.
#[cfg(test)]
pub(crate) use provider_migrations::{
    merge_missing_seed_providers, migrate_ollama_loopback, migrate_stale_provider_models,
};
pub(crate) use provider_overlay::{load_providers, update_providers};
pub(crate) use zone_migrations::normalize_zones;
// Las migraciones sueltas solo las llaman los tests; en producción entran por
// `normalize_zones`.
#[cfg(test)]
pub(crate) use zone_migrations::{
    migrate_gemini_flash_model, repair_zones_against_catalog, restore_missing_seed_fallbacks,
    retire_gemini_cli, retire_seed_ollama_fallback, retire_unused_zones, RETIRED_ZONE_IDS,
};

// ---------------------------------------------------------------------------
// CLI presence cache
// ---------------------------------------------------------------------------

/// Process-lifetime cache of CLI binary detection results.
/// `pub` so `mod.rs` can re-export it for tests that need to evict entries.
pub static CLI_CACHE: Lazy<Mutex<std::collections::HashMap<String, bool>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

/// Returns `true` when `command` resolves on the current PATH.
///
/// Uses `where` on Windows and `which` on all other platforms. The result
/// is cached for the process lifetime — safe because CLI tools are not
/// installed/uninstalled mid-session.
pub fn detect_cli(command: &str) -> bool {
    if let Ok(cache) = CLI_CACHE.lock() {
        if let Some(&result) = cache.get(command) {
            return result;
        }
    }

    #[cfg(target_os = "windows")]
    let found = crate::ai_router::exec::where_finds(command);

    #[cfg(not(target_os = "windows"))]
    let found = std::process::Command::new("which")
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if let Ok(mut cache) = CLI_CACHE.lock() {
        cache.insert(command.to_string(), found);
    }
    found
}

// ---------------------------------------------------------------------------
// Key-status helpers
// ---------------------------------------------------------------------------

/// Estado de la key de un proveedor. Un proveedor local sin variable de key
/// (Ollama, un servidor en localhost sin auth) está siempre configurado; uno
/// local que SÍ declara variable (un proxy personalizado en loopback con
/// auth) se mira en el entorno como uno cloud, para que `route()` lo salte
/// si falta la key en vez de fallar en cada llamada.
pub fn compute_key_status(p: &Provider) -> ApiKeyStatus {
    if p.kind == ProviderKind::Cli {
        let cmd = p.cli_command.as_deref().unwrap_or("");
        return if !cmd.is_empty() && detect_cli(cmd) {
            ApiKeyStatus::Configured
        } else {
            ApiKeyStatus::Missing
        };
    }
    if p.key_env_var.is_empty() {
        return ApiKeyStatus::Configured;
    }
    match resolve_key(&p.key_env_var) {
        Some(v) if !v.trim().is_empty() && !looks_like_placeholder(&v) => ApiKeyStatus::Configured,
        Some(_) => ApiKeyStatus::Placeholder,
        None => ApiKeyStatus::Missing,
    }
}

pub(crate) fn looks_like_placeholder(v: &str) -> bool {
    let lower = v.to_ascii_lowercase();
    lower.contains("your-key")
        || lower.contains("replace")
        || lower.starts_with("xxx")
        || lower == "sk-..."
}

/// Compute the set of provider IDs that should be skipped by `route()`.
pub(crate) fn disabled_providers_set() -> HashSet<String> {
    load_providers()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| {
            matches!(
                compute_key_status(p),
                ApiKeyStatus::Missing | ApiKeyStatus::Placeholder
            )
        })
        .map(|p| p.id)
        .collect()
}

// ---------------------------------------------------------------------------
// Load/save helpers
// ---------------------------------------------------------------------------

/// Carga las zonas, fusiona las del seed que falten y aplica
/// `normalize_zones`; si algo cambió, reescribe `zones.json`.
pub fn load_zones() -> Result<Vec<Zone>, String> {
    let path = zones_path()?;
    if !path.exists() {
        let seeded = seed_zones();
        write_json(&path, &seeded)?;
        return Ok(seeded);
    }
    // Auto-cure: a hand-edit of zones.json on 2026-06-04 dropped the
    // 'utility' and 'light' zones — the two MOST invoked from code —
    // so route('utility')/route('light') returned Err('zone not found').
    // We merge back any seed zone missing by id.
    let mut zones: Vec<Zone> = read_json(&path)?;
    let have: HashSet<String> = zones.iter().map(|z| z.id.clone()).collect();
    let before = zones.len();
    zones.extend(seed_zones().into_iter().filter(|z| !have.contains(&z.id)));
    let merged = zones.len() != before;

    // Red de seguridad incluida (la ÚLTIMA): ninguna zona puede quedar
    // apuntando a un proveedor que no está en el catálogo. Lo de 'claude'
    // vivió tres meses precisamente porque nadie comprobaba esta invariante.
    let catalogo = catalog_ids();
    let applied = normalize_zones(&mut zones, &catalogo);
    if merged || !applied.is_empty() {
        if let Err(e) = write_json(&path, &zones) {
            // Las zonas normalizadas se usan igual en esta llamada; el fallo
            // de escritura se registra para que no pase inadvertido.
            tracing::warn!(error = %e, "no se ha podido reescribir zones.json normalizado");
        }
    }
    Ok(zones)
}

/// Ids del catálogo de proveedores, o vacío si no se puede leer (con un
/// catálogo vacío `normalize_zones` no repara contra él).
fn catalog_ids() -> Vec<String> {
    match load_providers() {
        Ok(ps) => ps.into_iter().map(|p| p.id).collect(),
        Err(e) => {
            tracing::warn!(error = %e, "catálogo de proveedores ilegible: zonas sin reparar");
            Vec::new()
        }
    }
}

/// Comprueba que `zone` sobreviviría tal cual a la carga siguiente: le aplica
/// `normalize_zones` a una copia y, si la copia cambia, devuelve un error con
/// los motivos y la cadena en la que la carga la dejaría.
///
/// Pura salvo por el catálogo, que recibe hecho, para poder probarla.
pub(crate) fn validate_zone_edit(zone: &Zone, catalog: &[String]) -> Result<(), String> {
    let mut copia = vec![zone.clone()];
    let motivos = normalize_zones(&mut copia, catalog);
    if copia.first() == Some(zone) {
        return Ok(());
    }
    let resultado = match copia.first() {
        Some(z) => format!("la carga la dejaría así: {}", describe_chain(z)),
        None => "la carga la borraría".to_string(),
    };
    Err(format!(
        "No se ha guardado la zona '{}': {}. Motivo: {}.",
        zone.id,
        resultado,
        motivos.join("; ")
    ))
}

/// `proveedor:modelo → proveedor:modelo → …` de una zona.
fn describe_chain(z: &Zone) -> String {
    std::iter::once(&z.primary)
        .chain(z.fallbacks.iter())
        .map(|a| format!("{}:{}", a.provider_id, a.model))
        .collect::<Vec<_>>()
        .join(" → ")
}

/// Persiste una zona: sustituye la entrada con el mismo `id` o la añade.
///
/// Rechaza (con el motivo) una edición que `load_zones` revertiría en la carga
/// siguiente: antes se escribía tal cual, el editor marcaba «Guardado» y la
/// carga deshacía el cambio en silencio. Devuelve la zona tal y como queda en
/// disco para que la UI pinte lo persistido, no su borrador.
pub fn save_zone(zone: Zone) -> Result<Zone, String> {
    validate_zone_edit(&zone, &catalog_ids())?;
    let path = zones_path()?;
    let mut zones = load_zones()?;
    match zones.iter_mut().find(|z| z.id == zone.id) {
        Some(existing) => *existing = zone.clone(),
        None => zones.push(zone.clone()),
    }
    write_json(&path, &zones)?;
    Ok(zone)
}

/// Lee `metrics.json` sin escribir nada (un lector no debe crear el fichero:
/// competiría con los escritores). Si no existe, métricas vacías.
pub(crate) fn load_metrics() -> Result<RouterMetrics, String> {
    let path = metrics_path()?;
    if !path.exists() {
        return Ok(RouterMetrics::default());
    }
    let mut m: RouterMetrics = read_json(&path)?;
    m.adopt_legacy_window();
    Ok(m)
}

/// Lee, modifica y escribe `metrics.json` bajo el cerrojo de fichero (varios
/// procesos escriben a la vez: GUI y sidecar `ultron-memory`).
pub(crate) fn update_metrics(mutate: impl FnOnce(&mut RouterMetrics)) -> Result<(), String> {
    update_json_locked(&metrics_path()?, |m: &mut RouterMetrics| {
        m.adopt_legacy_window();
        mutate(m);
    })
}

pub(crate) fn mask_key(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || looks_like_placeholder(trimmed) {
        return None;
    }
    if trimmed.len() <= 8 {
        return Some("*".repeat(trimmed.len()));
    }
    Some(format!(
        "{}{}{}",
        &trimmed[..4],
        "*".repeat(trimmed.len() - 8),
        &trimmed[trimmed.len() - 4..]
    ))
}

#[cfg(test)]
mod save_tests;
#[cfg(test)]
mod tests;
