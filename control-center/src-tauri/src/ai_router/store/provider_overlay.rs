// Catálogo versionado + estado local del usuario.
//
// `providers.json` va versionado (y al espejo público): es el catálogo de
// proveedores del producto, sin nada del usuario. Lo que sí es del usuario
// vive en `providers.local.json`, ignorado por git:
//
// - los proveedores personalizados (`custom: true`), con su `base_url` y el
//   nombre de su variable de key;
// - los modelos descubiertos y el `default_model` que el descubrimiento fije
//   sobre un proveedor del catálogo.
//
// `api_key_status` no se persiste en ninguno de los dos con valor real: se
// calcula del entorno en cada carga y en disco queda neutro (`missing`), para
// que el fichero versionado no revele qué keys tiene configuradas el usuario.
//
// Migración: un `providers.json` antiguo con proveedores personalizados los
// cede a `providers.local.json` (primero se escribe el local, luego se limpia
// el catálogo, para no perder nada si falla la segunda escritura). Los modelos
// descubiertos que ya estuvieran en el catálogo no se distinguen de los del
// producto y se quedan donde están.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::super::custom::retain_valid_customs;
use super::super::seed::seed_providers;
use super::super::types::{providers_path, router_dir, ApiKeyStatus, Provider};
use super::provider_migrations::{
    merge_missing_seed_providers, migrate_ollama_loopback, migrate_stale_provider_models,
};
use super::{compute_key_status, read_json, write_json};

/// Modelos y modelo por defecto que el usuario fijó sobre un proveedor del
/// catálogo (hoy, el descubrimiento de modelos).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct CatalogOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

/// Contenido de `providers.local.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct LocalProviders {
    #[serde(default)]
    pub custom: Vec<Provider>,
    #[serde(default)]
    pub catalog_overrides: BTreeMap<String, CatalogOverride>,
}

struct ProviderState {
    catalog: Vec<Provider>,
    local: LocalProviders,
}

pub(crate) fn providers_local_path() -> Result<PathBuf, String> {
    Ok(router_dir()?.join("providers.local.json"))
}

/// Copia con `api_key_status` neutro: lo que se escribe en disco.
fn neutral(providers: &[Provider]) -> Vec<Provider> {
    providers
        .iter()
        .cloned()
        .map(|p| Provider {
            api_key_status: ApiKeyStatus::Missing,
            ..p
        })
        .collect()
}

fn is_neutral(providers: &[Provider]) -> bool {
    providers
        .iter()
        .all(|p| p.api_key_status == ApiKeyStatus::Missing)
}

/// Separa los personalizados del catálogo. Pura.
pub(crate) fn split_custom(providers: Vec<Provider>) -> (Vec<Provider>, Vec<Provider>) {
    providers.into_iter().partition(|p| !p.custom)
}

/// Añade a `local` los personalizados que traía el catálogo y que no tenga
/// ya (el local es más reciente y manda). Los que no pasan `validate_custom`
/// se descartan (con aviso en el log). Pura salvo el log.
pub(crate) fn adopt_customs(local: LocalProviders, moved: Vec<Provider>) -> LocalProviders {
    let have: HashSet<String> = local.custom.iter().map(|p| p.id.clone()).collect();
    let mut custom = local.custom;
    custom.extend(retain_valid_customs(
        moved
            .into_iter()
            .filter(|p| !have.contains(&p.id))
            .collect(),
    ));
    LocalProviders {
        custom: neutral(&custom),
        ..local
    }
}

fn apply_override(p: Provider, o: Option<&CatalogOverride>) -> Provider {
    let Some(o) = o else { return p };
    Provider {
        models: o.models.clone().unwrap_or(p.models),
        default_model: o.default_model.clone().unwrap_or(p.default_model),
        ..p
    }
}

/// Catálogo con el estado local encima. Un personalizado con el id de un
/// proveedor del catálogo se ignora (el catálogo manda). Pura.
pub(crate) fn merge_local(catalog: &[Provider], local: &LocalProviders) -> Vec<Provider> {
    let ids: HashSet<&str> = catalog.iter().map(|p| p.id.as_str()).collect();
    let mut merged: Vec<Provider> = catalog
        .iter()
        .cloned()
        .map(|p| {
            let o = local.catalog_overrides.get(&p.id);
            apply_override(p, o)
        })
        .collect();
    merged.extend(
        local
            .custom
            .iter()
            .filter(|p| !ids.contains(p.id.as_str()))
            .cloned(),
    );
    merged
}

fn override_for(p: &Provider, base: &Provider) -> Option<CatalogOverride> {
    let o = CatalogOverride {
        models: (p.models != base.models).then(|| p.models.clone()),
        default_model: (p.default_model != base.default_model).then(|| p.default_model.clone()),
    };
    (o != CatalogOverride::default()).then_some(o)
}

/// Inversa de `merge_local`: lo que difiere del catálogo pasa al estado
/// local. Pura.
pub(crate) fn extract_local(merged: &[Provider], catalog: &[Provider]) -> LocalProviders {
    let custom: Vec<Provider> = merged.iter().filter(|p| p.custom).cloned().collect();
    let catalog_overrides = merged
        .iter()
        .filter(|p| !p.custom)
        .filter_map(|p| {
            let base = catalog.iter().find(|c| c.id == p.id)?;
            override_for(p, base).map(|o| (p.id.clone(), o))
        })
        .collect();
    LocalProviders {
        custom: neutral(&custom),
        catalog_overrides,
    }
}

/// Lee `providers.local.json`. Un personalizado que no pasa
/// `validate_custom` (editado a mano o de una versión anterior) no se usa.
fn read_local() -> Result<LocalProviders, String> {
    let path = providers_local_path()?;
    if !path.exists() {
        return Ok(LocalProviders::default());
    }
    let local: LocalProviders = read_json(&path)?;
    Ok(LocalProviders {
        custom: retain_valid_customs(local.custom),
        ..local
    })
}

fn migrate_catalog(loaded: &mut Vec<Provider>) -> bool {
    let bumped = migrate_stale_provider_models(loaded);
    let merged = merge_missing_seed_providers(loaded);
    let loopback = migrate_ollama_loopback(loaded);
    bumped || merged || loopback
}

/// Lee el catálogo (sembrándolo si falta), aplica sus migraciones, cede los
/// personalizados al fichero local y deja el catálogo en disco neutro.
fn load_state() -> Result<ProviderState, String> {
    let path = providers_path()?;
    if !path.exists() {
        let seeded = seed_providers();
        write_json(&path, &neutral(&seeded))?;
        return Ok(ProviderState {
            catalog: seeded,
            local: read_local()?,
        });
    }
    let mut loaded: Vec<Provider> = read_json(&path)?;
    let migrated = migrate_catalog(&mut loaded);
    let was_neutral = is_neutral(&loaded);
    let (catalog, moved) = split_custom(loaded);
    let mut local = read_local()?;
    if !moved.is_empty() {
        local = adopt_customs(local, moved.clone());
        write_json(&providers_local_path()?, &local)?;
    }
    if migrated || !moved.is_empty() || !was_neutral {
        if let Err(e) = write_json(&path, &neutral(&catalog)) {
            // El catálogo migrado se usa igual en esta llamada.
            tracing::warn!(error = %e, "no se ha podido reescribir providers.json migrado");
        }
    }
    Ok(ProviderState { catalog, local })
}

fn with_status(providers: Vec<Provider>) -> Vec<Provider> {
    providers
        .into_iter()
        .map(|p| Provider {
            api_key_status: compute_key_status(&p),
            ..p
        })
        .collect()
}

/// Catálogo + estado local, con `api_key_status` calculado del entorno.
pub(crate) fn load_providers() -> Result<Vec<Provider>, String> {
    let state = load_state()?;
    Ok(with_status(merge_local(&state.catalog, &state.local)))
}

/// Serializa, dentro del proceso, los leer-modificar-escribir del estado de
/// proveedores (descubrimiento de modelos y alta de proveedores).
static PROVIDERS_WRITE: Mutex<()> = Mutex::new(());

/// Carga catálogo + estado local, aplica `mutate` y, si devuelve `Ok`,
/// escribe SOLO `providers.local.json`: el catálogo versionado no cambia.
/// Un `Err` de `mutate` no toca ningún fichero.
pub(crate) fn update_providers<R>(
    mutate: impl FnOnce(&mut Vec<Provider>) -> Result<R, String>,
) -> Result<R, String> {
    let _guard = PROVIDERS_WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let state = load_state()?;
    let mut merged = with_status(merge_local(&state.catalog, &state.local));
    let out = mutate(&mut merged)?;
    let local = extract_local(&merged, &state.catalog);
    write_json(&providers_local_path()?, &local)?;
    Ok(out)
}

#[cfg(test)]
#[path = "provider_overlay_tests.rs"]
mod tests;
