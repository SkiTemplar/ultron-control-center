// File I/O — read on demand; write atomically (tmp + rename) on save.
// Also: provider/zone/metrics load helpers and the key-status utilities.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;

use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::Mutex;

use super::seed::{seed_providers, seed_zones};
use super::types::{
    metrics_path, providers_path, zones_path, ApiKeyStatus, Provider, ProviderKind, RouterMetrics,
    Zone,
};

// ---------------------------------------------------------------------------
// Generic JSON helpers
// ---------------------------------------------------------------------------

pub(crate) fn read_json<T: serde::de::DeserializeOwned>(path: &PathBuf) -> Result<T, String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {}", path.display(), e))
}

pub(crate) fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create dir {}: {}", parent.display(), e))?;
    }
    let body = serde_json::to_vec_pretty(value)
        .map_err(|e| format!("serialize {}: {}", path.display(), e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &body).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename to {}: {}", path.display(), e))?;
    Ok(())
}

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
    let found = crate::proc::oculto("where")
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    #[cfg(not(target_os = "windows"))]
    let found = crate::proc::oculto("which")
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

pub fn compute_key_status(p: &Provider) -> ApiKeyStatus {
    if p.kind == ProviderKind::Local {
        return ApiKeyStatus::Configured;
    }
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
    match std::env::var(&p.key_env_var) {
        Ok(v) if !v.trim().is_empty() && !looks_like_placeholder(&v) => ApiKeyStatus::Configured,
        Ok(_) => ApiKeyStatus::Placeholder,
        Err(_) => ApiKeyStatus::Missing,
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

/// Returns the providers list, seeding the file on first run. Then patches
/// every entry's `api_key_status` against the current process env.
///
/// Unlike `load_zones()`, this used to read an existing `providers.json`
/// VERBATIM and never resync it against `seed_providers()` — a `providers.json`
/// written before a seed model bump (e.g. `gemini-3.8-flash`, `codex`/`codex-cli`
/// on `gpt-5`/`gpt-5.5`) stayed stale forever. `migrate_stale_provider_models`
/// closes that gap (2026-09-11).
pub fn load_providers() -> Result<Vec<Provider>, String> {
    let path = providers_path()?;
    let mut providers: Vec<Provider> = if path.exists() {
        let mut loaded: Vec<Provider> = read_json(&path)?;
        let mut mutated = migrate_stale_provider_models(&mut loaded);
        // Auto-cure (2026-09-17): a providers.json missing a seed provider left
        // zones pointing at a catalog ghost. Live case: `claude` was absent
        // while zones.json had it as the primary of BOTH code-edit and
        // code-review, so every route() there burned an attempt on
        // Err("unknown provider 'claude'") with nothing in the UI to say why
        // (disabled_providers_set() only iterates providers that EXIST, so the
        // no-key skip never fired). Mirrors the seed-merge load_zones() has had
        // since 2026-06-04.
        if merge_missing_seed_providers(&mut loaded) {
            mutated = true;
        }
        // Y al reves (2026-09-19): el fichero conservaba groq, deepseek y
        // claude-haiku aunque el seed ya no los trae, asi que seguian
        // apareciendo en la lista como si se pudieran usar. mar.ia solo tiene
        // los de suscripcion y el local.
        if drop_retired_providers(&mut loaded) {
            mutated = true;
            // Las zonas que apuntaran a los retirados se reparan a la vez: si
            // no, quedan con un primary que no existe.
            if let Ok(zonas_path) = zones_path() {
                if zonas_path.exists() {
                    if let Ok(mut zonas) = read_json::<Vec<Zone>>(&zonas_path) {
                        let vigentes: Vec<String> = loaded.iter().map(|p| p.id.clone()).collect();
                        if repair_zones_after_drop(&mut zonas, &vigentes) {
                            let _ = write_json(&zonas_path, &zonas);
                        }
                    }
                }
            }
        }
        if mutated {
            let _ = write_json(&path, &loaded);
        }
        loaded
    } else {
        let seeded = seed_providers();
        write_json(&path, &seeded)?;
        seeded
    };
    for p in providers.iter_mut() {
        p.api_key_status = compute_key_status(p);
    }
    Ok(providers)
}

/// Append any `seed_providers()` entry absent from `providers` (matched by id).
/// Returns true when something was added, so the caller persists the file.
///
/// Only ADDS: an operator-edited entry that already exists keeps its cost,
/// models and base_url untouched (that drift is `migrate_stale_provider_models`'
/// job, which is scoped to known-stale values). Order is preserved and new
/// entries are appended, so the catalog never reshuffles under the UI.
///
/// Pure (no I/O) so the merge is unit-testable.
pub(crate) fn merge_missing_seed_providers(providers: &mut Vec<Provider>) -> bool {
    let have: std::collections::HashSet<String> = providers.iter().map(|p| p.id.clone()).collect();
    let mut mutated = false;
    for sp in seed_providers() {
        if !have.contains(&sp.id) {
            providers.push(sp);
            mutated = true;
        }
    }
    mutated
}

/// Quita del catalogo persistido los proveedores que ya no estan en el seed.
///
/// `merge_missing_seed_providers` solo AÑADE, asi que un `providers.json`
/// escrito antes de la limpieza conservaba groq, deepseek y claude-haiku para
/// siempre: el usuario los veia en la lista y los daba por disponibles
/// (comprobado en esta maquina el 2026-09-19 — 9 proveedores en el fichero, 4
/// en el seed). mar.ia se queda solo con los de suscripcion y el local.
///
/// Pura (sin I/O) para poder probarla.
pub(crate) fn drop_retired_providers(providers: &mut Vec<Provider>) -> bool {
    let vigentes: std::collections::HashSet<String> =
        seed_providers().into_iter().map(|p| p.id).collect();
    let antes = providers.len();
    providers.retain(|p| vigentes.contains(&p.id));
    antes != providers.len()
}

/// Repara las zonas que apunten a un proveedor retirado.
///
/// Si no se hace a la vez que la limpieza del catalogo, una zona se queda con
/// un `primary` que no existe y la llamada falla en tiempo de ejecucion con un
/// "proveedor desconocido" que no dice nada. Los fallbacks retirados se caen;
/// un primary retirado se sustituye por el primer fallback vigente y, si no
/// queda ninguno, por el modelo local. Pura.
pub(crate) fn repair_zones_after_drop(zones: &mut [Zone], vigentes: &[String]) -> bool {
    let ok = |id: &str| vigentes.iter().any(|v| v == id);
    let mut mutated = false;
    for z in zones.iter_mut() {
        let antes = z.fallbacks.len();
        z.fallbacks.retain(|f| ok(&f.provider_id));
        // Y sin repetidos: al fundir dos proveedores en uno, la misma zona se
        // quedaba con el mismo fallback tres veces y el relevo lo intentaba
        // tres veces seguidas.
        let mut vistos: std::collections::HashSet<String> = std::collections::HashSet::new();
        z.fallbacks.retain(|f| vistos.insert(f.provider_id.clone()));
        if z.fallbacks.len() != antes {
            mutated = true;
        }
        if !ok(&z.primary.provider_id) {
            match z.fallbacks.first().cloned() {
                Some(nuevo) => {
                    z.primary = nuevo;
                    z.fallbacks.remove(0);
                }
                None => {
                    // Sin nadie vigente, el local: siempre esta y no gasta cuota.
                    z.primary.provider_id = "ollama".to_string();
                    z.primary.model = crate::ollama::toggle::model_name();
                }
            }
            mutated = true;
        }
    }
    mutated
}

/// Bump provider catalog entries (`default_model` + `models`) that predate a
/// seed change, for a `providers.json` written before the update ran. Matches
/// by provider id + a known-stale `default_model`, then copies the CURRENT
/// seed's `default_model`/`models` for that id. An operator-chosen
/// `default_model` outside the stale list is left untouched (this migration
/// only repairs drift, it never overrides an intentional choice).
///
/// Idempotent: a provider already on its seed model triggers no mutation.
///
/// SCOPED TO `codex-cli` (not the cloud `codex` provider): `codex-cli`
/// authenticates via the ChatGPT subscription (terra/sol/astra are valid
/// there), while cloud `codex` hits the real OpenAI HTTP API with
/// `OPENAI_API_KEY` — those subscription aliases are not valid ids there, so
/// it must keep its own API model id untouched by this migration (fixed
/// same day after review; an earlier version bumped both).
///
/// Pure (no I/O) so the migration is unit-testable.
pub(crate) fn migrate_stale_provider_models(providers: &mut [Provider]) -> bool {
    // (provider id, stale default_model values that trigger the bump).
    // gemini-3.8-flash (2026-09-16): medido en vivo, 200 OK pero 55.497 ms de
    // latencia — vuelve a la lista de valores obsoletos que esta migracion
    // repara, apuntando de nuevo al gemini-2.5-flash de seed_providers (624 ms
    // medidos el mismo dia). Ver migrate_gemini_flash_model para el mismo
    // bump aplicado a zones.json.
    const TARGETS: &[(&str, &[&str])] = &[
        ("gemini", &["gemini-3.8-flash"]),
        ("codex-cli", &["gpt-5", "gpt-5.5"]),
        // qwen2.5-coder:32b (2026-09-17): ~20 GB de VRAM, imposible en la
        // 4080 Laptop de 12 GB y ni descargado -> la zona code-fast-local
        // fallaba en cada llamada. Bump al qwen3.5:9b de seed_providers.
        ("ollama", &["qwen2.5-coder:32b"]),
    ];
    let seed = seed_providers();
    let mut mutated = false;
    for p in providers.iter_mut() {
        let Some(&(_, stale)) = TARGETS.iter().find(|(id, _)| *id == p.id) else {
            continue;
        };
        if !stale.contains(&p.default_model.as_str()) {
            continue;
        }
        let Some(seed_p) = seed.iter().find(|sp| sp.id == p.id) else {
            continue;
        };
        if p.default_model != seed_p.default_model {
            p.default_model = seed_p.default_model.clone();
            mutated = true;
        }
        if p.models != seed_p.models {
            p.models = seed_p.models.clone();
            mutated = true;
        }
    }
    mutated
}

pub fn load_zones() -> Result<Vec<Zone>, String> {
    let path = zones_path()?;
    if path.exists() {
        // Auto-cure: a hand-edit of zones.json on 2026-06-04 dropped the
        // 'utility' and 'light' zones — the two MOST invoked from code —
        // so route('utility')/route('light') returned Err('zone not found').
        // We now merge back any seed zone missing by id.
        let mut zones: Vec<Zone> = read_json(&path)?;
        let have: std::collections::HashSet<String> = zones.iter().map(|z| z.id.clone()).collect();
        for z in seed_zones() {
            if !have.contains(&z.id) {
                zones.push(z);
            }
        }
        // CLI-primary migration (2026-06-05): upgrade an existing zones.json
        // 'code-edit' entry that still points to the old cloud-only primary.
        let mut mutated = false;
        for z in &mut zones {
            if z.id == "code-edit" && z.primary.provider_id == "codex" {
                z.primary.provider_id = "codex-cli".into();
                if !z.fallbacks.iter().any(|f| f.provider_id == "codex") {
                    z.fallbacks.insert(
                        0,
                        super::types::ZoneAssignment {
                            provider_id: "codex".into(),
                            model: "gpt-5".into(),
                            max_tokens: z.primary.max_tokens,
                        },
                    );
                }
                mutated = true;
            }
        }
        // gemini-cli retirement migration (2026-06-19): the gemini-cli binary no
        // longer authenticates (Google dropped free-tier OAuth for individuals —
        // runtime IneligibleTierError "migrate to the Antigravity suite"). The
        // migration swaps it for the cloud 'gemini' provider in every chain and
        // de-dups. NOTE: this SUPERSEDES the 2026-06-05 rule that PROMOTED
        // research-web to gemini-cli — that rule was removed, the CLI is dead.
        if retire_gemini_cli(&mut zones) {
            mutated = true;
        }
        // gemini-3.8-flash -> gemini-2.5-flash migration (2026-09-16): 3.8-flash
        // medido en vivo en 55.497 ms (200 OK pero inservible como fallback
        // rapido); 2.5-flash medido el mismo dia en 624 ms. Supersede la
        // migracion inversa del 2026-09-11. Idempotente: un zones.json ya en
        // 2.5-flash no dispara escritura.
        if migrate_gemini_flash_model(&mut zones) {
            mutated = true;
        }
        // codex gpt-5/gpt-5.5 -> modelo de la semilla por zona (2026-09-11):
        // terra/sol/astra verificados vivos vía `codex exec -m <modelo>`.
        // Generalizada para leer el objetivo de seed_zones() en vez de un par
        // OLD/NEW fijo (ver doc de la función). Idempotente.
        if migrate_codex_gpt5_model(&mut zones) {
            mutated = true;
        }
        if mutated {
            let _ = write_json(&path, &zones);
        }
        Ok(zones)
    } else {
        let seeded = seed_zones();
        write_json(&path, &seeded)?;
        Ok(seeded)
    }
}

/// Retire the dead `gemini-cli` provider from every zone chain: replace it with
/// the cloud `gemini` provider (so research-web keeps gemini-2.5-flash via API,
/// and every fallback keeps a working target), then drop any fallback whose
/// provider already appears earlier in the chain (including as the primary).
///
/// Pure (no I/O) so the migration is unit-testable. Returns `true` if any zone
/// was mutated.
pub(crate) fn retire_gemini_cli(zones: &mut [Zone]) -> bool {
    let mut mutated = false;
    for z in zones.iter_mut() {
        if z.primary.provider_id == "gemini-cli" {
            z.primary.provider_id = "gemini".into();
            mutated = true;
        }
        for f in &mut z.fallbacks {
            if f.provider_id == "gemini-cli" {
                f.provider_id = "gemini".into();
                mutated = true;
            }
        }
        // De-dup por (proveedor, modelo), NO por proveedor (2026-09-07): la
        // cuota de Groq es por modelo, así que una cadena legítima lleva
        // varios modelos del mismo proveedor. Con la clave antigua esta
        // migración borraba en cada carga los fallbacks groq de la zona
        // `chat` (verificado: zones.json revertido a los 40 s de editarlo).
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        seen.insert(format!("{}::{}", z.primary.provider_id, z.primary.model));
        let before = z.fallbacks.len();
        z.fallbacks
            .retain(|f| seen.insert(format!("{}::{}", f.provider_id, f.model)));
        if z.fallbacks.len() != before {
            mutated = true;
        }
    }
    mutated
}

/// Bump the cloud `gemini` provider's model from the retired `gemini-3.8-flash`
/// back to `gemini-2.5-flash` (2026-09-16: 3.8-flash medido en vivo — 200 OK
/// pero 55.497 ms de latencia, muy por encima de lo aceptable para un
/// fallback rapido; 2.5-flash medido el mismo dia en 624 ms). Supersedes the
/// 2026-09-11 migration that went the other way. Idempotent: a `zones.json`
/// already on `gemini-2.5-flash` triggers no mutation. After the bump,
/// de-dups by (provider, model) so a chain that happened to carry both the
/// old and new gemini model doesn't end up with a duplicate fallback.
///
/// Pure (no I/O) so the migration is unit-testable.
pub(crate) fn migrate_gemini_flash_model(zones: &mut [Zone]) -> bool {
    const OLD_MODEL: &str = "gemini-3.8-flash";
    const NEW_MODEL: &str = "gemini-2.5-flash";
    let mut mutated = false;
    for z in zones.iter_mut() {
        if z.primary.provider_id == "gemini" && z.primary.model == OLD_MODEL {
            z.primary.model = NEW_MODEL.into();
            mutated = true;
        }
        for f in &mut z.fallbacks {
            if f.provider_id == "gemini" && f.model == OLD_MODEL {
                f.model = NEW_MODEL.into();
                mutated = true;
            }
        }
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        seen.insert(format!("{}::{}", z.primary.provider_id, z.primary.model));
        let before = z.fallbacks.len();
        z.fallbacks
            .retain(|f| seen.insert(format!("{}::{}", f.provider_id, f.model)));
        if z.fallbacks.len() != before {
            mutated = true;
        }
    }
    mutated
}

/// Bump `codex-cli` `ZoneAssignment.model` still on a stale value (`gpt-5` or
/// `gpt-5.5`) to whatever `seed_zones()` assigns that exact (zone id,
/// provider id) pair TODAY, instead of a single hardcoded OLD/NEW pair.
/// Generalized 2026-09-11 (subscription ChatGPT models terra/sol/astra
/// verified live via `codex exec -m <modelo>`; code-edit -> terra,
/// code-review -> sol, see `seed_zones`) so the next codex-cli model bump
/// only touches the seed — this migration keeps reading from it. A zone id
/// or (zone, provider) pair absent from the seed is left untouched (we never
/// guess a target).
///
/// SCOPED TO `codex-cli` ONLY (fixed same day after review): the cloud
/// `codex` provider (`OPENAI_API_KEY`, real OpenAI HTTP API) must keep its
/// own API model id (`gpt-5`) — terra/sol/astra are ChatGPT-subscription
/// aliases, not valid ids on the public OpenAI API, and an earlier version of
/// this migration wrongly bumped it too.
///
/// Idempotent: an assignment already matching its seed target triggers no
/// mutation. After the bump, de-dups by (provider, model) so a chain that
/// happened to carry both the old and new codex-cli model doesn't end up
/// with a duplicate.
///
/// Pure (no I/O) so the migration is unit-testable.
pub(crate) fn migrate_codex_gpt5_model(zones: &mut [Zone]) -> bool {
    const STALE_MODELS: [&str; 2] = ["gpt-5", "gpt-5.5"];

    fn is_codex_cli(provider_id: &str) -> bool {
        provider_id == "codex-cli"
    }

    fn seed_target(seed: &[Zone], zone_id: &str, provider_id: &str) -> Option<String> {
        let sz = seed.iter().find(|z| z.id == zone_id)?;
        if sz.primary.provider_id == provider_id {
            return Some(sz.primary.model.clone());
        }
        sz.fallbacks
            .iter()
            .find(|f| f.provider_id == provider_id)
            .map(|f| f.model.clone())
    }

    let seed = seed_zones();
    let mut mutated = false;
    for z in zones.iter_mut() {
        if is_codex_cli(&z.primary.provider_id) && STALE_MODELS.contains(&z.primary.model.as_str())
        {
            if let Some(target) = seed_target(&seed, &z.id, &z.primary.provider_id) {
                if target != z.primary.model {
                    z.primary.model = target;
                    mutated = true;
                }
            }
        }
        for f in &mut z.fallbacks {
            if is_codex_cli(&f.provider_id) && STALE_MODELS.contains(&f.model.as_str()) {
                if let Some(target) = seed_target(&seed, &z.id, &f.provider_id) {
                    if target != f.model {
                        f.model = target;
                        mutated = true;
                    }
                }
            }
        }
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        seen.insert(format!("{}::{}", z.primary.provider_id, z.primary.model));
        let before = z.fallbacks.len();
        z.fallbacks
            .retain(|f| seen.insert(format!("{}::{}", f.provider_id, f.model)));
        if z.fallbacks.len() != before {
            mutated = true;
        }
    }
    mutated
}

pub(crate) fn load_metrics() -> Result<RouterMetrics, String> {
    let path = metrics_path()?;
    if path.exists() {
        read_json(&path)
    } else {
        let m = RouterMetrics::default();
        write_json(&path, &m)?;
        Ok(m)
    }
}

#[cfg(test)]
mod retire_tests {
    use super::retire_gemini_cli;
    use crate::ai_router::types::{Zone, ZoneAssignment};

    fn asg(provider: &str, model: &str) -> ZoneAssignment {
        ZoneAssignment {
            provider_id: provider.into(),
            model: model.into(),
            max_tokens: 1024,
        }
    }

    #[test]
    fn keeps_several_models_of_the_same_provider_in_a_chain() {
        // Caso del 2026-09-07: la cuota de Groq es por modelo, así que una
        // cadena con varios modelos de Groq es legítima y no debe recortarse.
        // qwen/qwen3.6-27b se retiró del fixture (2026-09-16): devuelve 404
        // model_not_found en Groq, ya no es un modelo real de esta cuenta.
        let mut zones = vec![Zone {
            id: "chat".into(),
            label: "chat".into(),
            category: "chat".into(),
            primary: asg("groq", "openai/gpt-oss-120b"),
            fallbacks: vec![
                asg("groq", "openai/gpt-oss-20b"),
                asg("gemini", "gemini-2.5-flash"),
            ],
            system_prompt: None,
        }];
        assert!(
            !retire_gemini_cli(&mut zones),
            "nada que migrar ni recortar"
        );
        assert_eq!(zones[0].fallbacks.len(), 2);
    }

    #[test]
    fn drops_exact_duplicates_and_retires_gemini_cli() {
        // Caso negativo: el mismo (proveedor, modelo) repetido sí se recorta, y
        // gemini-cli se sustituye por gemini.
        let mut zones = vec![Zone {
            id: "x".into(),
            label: "x".into(),
            category: "chat".into(),
            primary: asg("groq", "openai/gpt-oss-120b"),
            fallbacks: vec![
                asg("groq", "openai/gpt-oss-120b"),
                asg("gemini-cli", "gemini-3.8-flash"),
            ],
            system_prompt: None,
        }];
        assert!(retire_gemini_cli(&mut zones));
        assert_eq!(zones[0].fallbacks.len(), 1);
        assert_eq!(zones[0].fallbacks[0].provider_id, "gemini");
    }
}

#[cfg(test)]
mod gemini_flash_migration_tests {
    use super::migrate_gemini_flash_model;
    use crate::ai_router::types::{Zone, ZoneAssignment};

    fn asg(provider: &str, model: &str) -> ZoneAssignment {
        ZoneAssignment {
            provider_id: provider.into(),
            model: model.into(),
            max_tokens: 1024,
        }
    }

    #[test]
    fn bumps_gemini_3_8_flash_back_to_2_5_flash_in_primary_and_fallbacks() {
        let mut zones = vec![Zone {
            id: "research-web".into(),
            label: "research-web".into(),
            category: "research".into(),
            primary: asg("gemini", "gemini-3.8-flash"),
            fallbacks: vec![
                asg("groq", "openai/gpt-oss-120b"),
                asg("gemini", "gemini-3.8-flash"),
            ],
            system_prompt: None,
        }];
        assert!(migrate_gemini_flash_model(&mut zones));
        assert_eq!(zones[0].primary.model, "gemini-2.5-flash");
        // La entrada duplicada tras el bump se recorta por (proveedor, modelo).
        assert_eq!(zones[0].fallbacks.len(), 1);
        assert_eq!(zones[0].fallbacks[0].provider_id, "groq");
    }

    #[test]
    fn is_idempotent_when_zones_json_already_on_2_5_flash() {
        // Caso del zones.json vivo tras el bump del 2026-09-16. La migracion
        // no debe reescribir nada ni duplicar la zona.
        let mut zones = vec![Zone {
            id: "chat".into(),
            label: "chat".into(),
            category: "chat".into(),
            primary: asg("groq", "openai/gpt-oss-120b"),
            fallbacks: vec![asg("gemini", "gemini-2.5-flash")],
            system_prompt: None,
        }];
        assert!(
            !migrate_gemini_flash_model(&mut zones),
            "zones.json ya en 2.5-flash: nada que migrar"
        );
        assert_eq!(zones[0].fallbacks.len(), 1);
        assert_eq!(zones[0].fallbacks[0].model, "gemini-2.5-flash");
    }

    #[test]
    fn leaves_other_providers_and_models_untouched() {
        let mut zones = vec![Zone {
            id: "code-fast-local".into(),
            label: "code-fast-local".into(),
            category: "code".into(),
            primary: asg("ollama", "qwen2.5-coder:32b"),
            fallbacks: vec![asg("gemini", "gemini-2.5-pro")],
            system_prompt: None,
        }];
        assert!(!migrate_gemini_flash_model(&mut zones));
        assert_eq!(zones[0].primary.model, "qwen2.5-coder:32b");
        assert_eq!(zones[0].fallbacks[0].model, "gemini-2.5-pro");
    }
}

#[cfg(test)]
mod codex_gpt5_migration_tests {
    use super::migrate_codex_gpt5_model;
    use crate::ai_router::types::{Zone, ZoneAssignment};

    fn asg(provider: &str, model: &str) -> ZoneAssignment {
        ZoneAssignment {
            provider_id: provider.into(),
            model: model.into(),
            max_tokens: 1024,
        }
    }

    // Objetivos reales de la semilla (ver seed_zones): code-edit -> terra
    // (tareas basicas) para codex-cli; code-review -> sol (~Opus) para
    // codex-cli. El 'codex' cloud NUNCA se toca (ver
    // leaves_cloud_codex_provider_untouched abajo).

    #[test]
    fn bumps_gpt5_to_the_seed_model_per_zone() {
        let mut zones = vec![
            Zone {
                id: "code-edit".into(),
                label: "code-edit".into(),
                category: "code".into(),
                primary: asg("codex-cli", "gpt-5"),
                fallbacks: vec![asg("codex", "gpt-5"), asg("deepseek", "deepseek-coder")],
                system_prompt: None,
            },
            Zone {
                id: "code-review".into(),
                label: "code-review".into(),
                category: "code".into(),
                primary: asg("claude", "claude-sonnet-5"),
                fallbacks: vec![asg("codex-cli", "gpt-5"), asg("gemini", "gemini-3.8-flash")],
                system_prompt: None,
            },
        ];
        assert!(migrate_codex_gpt5_model(&mut zones));
        let edit = &zones[0];
        assert_eq!(edit.primary.model, "gpt-5.6-terra");
        // El fallback al 'codex' cloud NO se toca: conserva su id de API real.
        assert_eq!(edit.fallbacks[0].provider_id, "codex");
        assert_eq!(edit.fallbacks[0].model, "gpt-5");
        let review = &zones[1];
        assert_eq!(review.fallbacks[0].model, "gpt-5.6-sol");
    }

    #[test]
    fn leaves_cloud_codex_provider_untouched() {
        // Regresion guard: una version anterior de esta migracion tambien
        // bumpeaba el 'codex' cloud (OPENAI_API_KEY) a los alias de
        // suscripcion terra/sol/astra, que no son ids validos en la API
        // publica de OpenAI. Corregido: solo codex-cli migra.
        let mut zones = vec![Zone {
            id: "code-edit".into(),
            label: "code-edit".into(),
            category: "code".into(),
            primary: asg("claude", "claude-sonnet-5"),
            fallbacks: vec![asg("codex", "gpt-5"), asg("codex", "gpt-5.5")],
            system_prompt: None,
        }];
        assert!(!migrate_codex_gpt5_model(&mut zones));
        assert_eq!(zones[0].fallbacks[0].model, "gpt-5");
        assert_eq!(zones[0].fallbacks[1].model, "gpt-5.5");
    }

    #[test]
    fn bumps_gpt5_5_to_the_seed_model_per_zone() {
        // El bump anterior (2026-09-11, primera mitad del día) dejó zones.json
        // en gpt-5.5; esta migración debe seguir subiendo desde ahí.
        let mut zones = vec![Zone {
            id: "code-review".into(),
            label: "code-review".into(),
            category: "code".into(),
            primary: asg("claude", "claude-sonnet-5"),
            fallbacks: vec![
                asg("codex-cli", "gpt-5.5"),
                asg("gemini", "gemini-3.8-flash"),
            ],
            system_prompt: None,
        }];
        assert!(migrate_codex_gpt5_model(&mut zones));
        assert_eq!(zones[0].fallbacks[0].model, "gpt-5.6-sol");
    }

    #[test]
    fn is_idempotent_when_zones_json_already_on_the_seed_model() {
        let mut zones = vec![Zone {
            id: "code-edit".into(),
            label: "code-edit".into(),
            category: "code".into(),
            primary: asg("claude", "claude-sonnet-5"),
            fallbacks: vec![asg("codex-cli", "gpt-5.6-terra"), asg("codex", "gpt-5")],
            system_prompt: None,
        }];
        assert!(
            !migrate_codex_gpt5_model(&mut zones),
            "zones.json ya en el modelo de la semilla: nada que migrar"
        );
        assert_eq!(zones[0].fallbacks.len(), 2);
    }

    #[test]
    fn leaves_other_providers_and_models_untouched() {
        let mut zones = vec![Zone {
            id: "chat".into(),
            label: "chat".into(),
            category: "chat".into(),
            primary: asg("groq", "openai/gpt-oss-120b"),
            fallbacks: vec![asg("gemini", "gemini-3.8-flash")],
            system_prompt: None,
        }];
        assert!(!migrate_codex_gpt5_model(&mut zones));
        assert_eq!(zones[0].primary.model, "openai/gpt-oss-120b");
        assert_eq!(zones[0].fallbacks[0].model, "gemini-3.8-flash");
    }

    #[test]
    fn drops_duplicate_when_bump_collides_with_existing_seed_model_entry() {
        // Si la cadena ya llevaba gpt-5 Y el modelo de la semilla del mismo
        // proveedor, tras el bump el de-dup por (proveedor, modelo) recorta
        // el duplicado.
        let mut zones = vec![Zone {
            id: "code-edit".into(),
            label: "code-edit".into(),
            category: "code".into(),
            primary: asg("claude", "claude-sonnet-5"),
            fallbacks: vec![asg("codex-cli", "gpt-5"), asg("codex-cli", "gpt-5.6-terra")],
            system_prompt: None,
        }];
        assert!(migrate_codex_gpt5_model(&mut zones));
        assert_eq!(zones[0].fallbacks.len(), 1);
        assert_eq!(zones[0].fallbacks[0].model, "gpt-5.6-terra");
    }

    #[test]
    fn leaves_unknown_zone_id_untouched_when_not_in_seed() {
        // Zona custom del usuario sin equivalente en seed_zones(): no debe
        // adivinar un objetivo.
        let mut zones = vec![Zone {
            id: "my-custom-zone".into(),
            label: "custom".into(),
            category: "code".into(),
            primary: asg("codex-cli", "gpt-5"),
            fallbacks: vec![],
            system_prompt: None,
        }];
        assert!(!migrate_codex_gpt5_model(&mut zones));
        assert_eq!(zones[0].primary.model, "gpt-5");
    }
}

#[cfg(test)]
mod provider_seed_merge_tests {
    use super::{
        drop_retired_providers, merge_missing_seed_providers, repair_zones_after_drop,
        seed_providers,
    };
    use crate::ai_router::types::{ApiKeyStatus, Provider, ProviderClass, ProviderKind};

    fn bare(id: &str) -> Provider {
        Provider {
            id: id.into(),
            name: id.into(),
            cost_per_mtok: 42.0,
            supports: vec![ProviderClass::Light],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: None,
            kind: ProviderKind::Cloud,
            key_env_var: String::new(),
            base_url: "operator-chosen".into(),
            default_model: "operator-chosen".into(),
            models: vec!["operator-chosen".into()],
            cli_command: None,
        }
    }

    #[test]
    fn adds_the_missing_claude_provider() {
        // El caso real (2026-09-17): providers.json sin 'claude' mientras
        // zones.json lo tenia como primary de code-edit y code-review.
        let mut providers: Vec<Provider> = seed_providers()
            .into_iter()
            .filter(|p| p.id != "claude")
            .collect();
        assert!(!providers.iter().any(|p| p.id == "claude"));
        assert!(merge_missing_seed_providers(&mut providers));
        assert!(providers.iter().any(|p| p.id == "claude"));
    }

    #[test]
    fn is_a_noop_when_every_seed_provider_is_present() {
        let mut providers = seed_providers();
        let before = providers.len();
        assert!(!merge_missing_seed_providers(&mut providers));
        assert_eq!(providers.len(), before);
    }

    #[test]
    fn never_overwrites_an_existing_entry() {
        // Caso negativo: una entrada editada a mano se conserva TAL CUAL;
        // esta funcion solo anade las ausentes.
        let mut providers = vec![bare("claude")];
        assert!(merge_missing_seed_providers(&mut providers));
        let claude = providers.iter().find(|p| p.id == "claude").unwrap();
        assert_eq!(claude.cost_per_mtok, 42.0);
        assert_eq!(claude.default_model, "operator-chosen");
        assert_eq!(claude.base_url, "operator-chosen");
        // Y el resto del catalogo de seed entra detras, sin reordenar.
        assert_eq!(providers[0].id, "claude");
        assert_eq!(providers.len(), seed_providers().len());
    }

    #[test]
    fn se_van_los_proveedores_retirados() {
        // Caso real: el fichero de esta maquina tenia 9 proveedores y el seed
        // 4. Los tres retirados seguian saliendo en la lista.
        let mut ps = seed_providers();
        let mut fantasma = ps[0].clone();
        fantasma.id = "groq".into();
        ps.push(fantasma);
        assert!(drop_retired_providers(&mut ps));
        assert!(!ps.iter().any(|p| p.id == "groq"));
        assert_eq!(ps.len(), seed_providers().len());
    }

    #[test]
    fn una_zona_no_repite_el_mismo_fallback() {
        use crate::ai_router::types::{Zone, ZoneAssignment};
        let asign = |id: &str| ZoneAssignment {
            provider_id: id.to_string(),
            model: "m".to_string(),
            max_tokens: 1024,
        };
        let mut zonas = vec![Zone {
            id: "code-edit".into(),
            label: "Code edit".into(),
            category: "code".into(),
            primary: asign("claude"),
            fallbacks: vec![asign("codex-cli"), asign("codex-cli"), asign("codex-cli")],
            system_prompt: None,
        }];
        let vigentes = vec!["claude".to_string(), "codex-cli".to_string()];
        assert!(repair_zones_after_drop(&mut zonas, &vigentes));
        assert_eq!(zonas[0].fallbacks.len(), 1);
    }

    #[test]
    fn un_catalogo_ya_limpio_no_se_toca() {
        // Caso negativo: si devolviera true siempre, se reescribiria el
        // fichero en cada arranque sin motivo.
        let mut ps = seed_providers();
        assert!(!drop_retired_providers(&mut ps));
    }

    #[test]
    fn una_zona_que_apunta_a_un_retirado_se_repara() {
        use crate::ai_router::types::{Zone, ZoneAssignment};
        let asign = |id: &str| ZoneAssignment {
            provider_id: id.to_string(),
            model: "m".to_string(),
            max_tokens: 1024,
        };
        let mut zonas = vec![Zone {
            id: "chat".into(),
            label: "Chat".into(),
            category: "general".into(),
            primary: asign("groq"),
            fallbacks: vec![asign("deepseek"), asign("claude")],
            system_prompt: None,
        }];
        let vigentes = vec!["claude".to_string(), "ollama".to_string()];
        assert!(repair_zones_after_drop(&mut zonas, &vigentes));
        assert_eq!(zonas[0].primary.provider_id, "claude");
        assert!(zonas[0].fallbacks.is_empty());
    }

    #[test]
    fn sin_ningun_fallback_vigente_la_zona_cae_al_local() {
        use crate::ai_router::types::{Zone, ZoneAssignment};
        let mut zonas = vec![Zone {
            id: "chat".into(),
            label: "Chat".into(),
            category: "general".into(),
            primary: ZoneAssignment {
                provider_id: "groq".into(),
                model: "m".into(),
                max_tokens: 512,
            },
            fallbacks: vec![],
            system_prompt: None,
        }];
        assert!(repair_zones_after_drop(&mut zonas, &["ollama".to_string()]));
        assert_eq!(zonas[0].primary.provider_id, "ollama");
    }
}

#[cfg(test)]
mod provider_model_migration_tests {
    use super::migrate_stale_provider_models;
    use crate::ai_router::types::{ApiKeyStatus, Provider, ProviderClass, ProviderKind};

    fn provider(id: &str, default_model: &str, models: &[&str]) -> Provider {
        Provider {
            id: id.into(),
            name: id.into(),
            cost_per_mtok: 0.0,
            supports: vec![ProviderClass::Light],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: None,
            kind: ProviderKind::Cloud,
            key_env_var: String::new(),
            base_url: String::new(),
            default_model: default_model.into(),
            models: models.iter().map(|m| m.to_string()).collect(),
            cli_command: None,
        }
    }

    #[test]
    fn bumps_gemini_default_model_and_catalog() {
        let mut providers = vec![provider(
            "gemini",
            "gemini-3.8-flash",
            &["gemini-3.8-flash", "gemini-2.5-pro"],
        )];
        assert!(migrate_stale_provider_models(&mut providers));
        assert_eq!(providers[0].default_model, "gemini-2.5-flash");
        assert!(providers[0]
            .models
            .contains(&"gemini-2.5-flash".to_string()));
    }

    #[test]
    fn bumps_codex_cli_from_gpt5_and_from_gpt5_5() {
        let mut providers = vec![provider("codex-cli", "gpt-5", &["gpt-5"])];
        assert!(migrate_stale_provider_models(&mut providers));
        assert_eq!(providers[0].default_model, "gpt-5.6-terra");
        assert!(providers[0].models.contains(&"gpt-5.6-sol".to_string()));

        let mut providers2 = vec![provider("codex-cli", "gpt-5.5", &["gpt-5.5"])];
        assert!(migrate_stale_provider_models(&mut providers2));
        assert_eq!(providers2[0].default_model, "gpt-5.6-terra");
    }

    #[test]
    fn leaves_cloud_codex_provider_untouched() {
        // Regresion guard: una version anterior de esta migracion tambien
        // bumpeaba el 'codex' cloud (OPENAI_API_KEY, API real de OpenAI) a
        // terra/sol/astra, alias de suscripcion invalidos en esa API.
        // Corregido: solo 'codex-cli' esta en TARGETS.
        let mut providers = vec![provider("codex", "gpt-5.5", &["gpt-5.5", "gpt-4o"])];
        assert!(!migrate_stale_provider_models(&mut providers));
        assert_eq!(providers[0].default_model, "gpt-5.5");
        assert_eq!(providers[0].models, vec!["gpt-5.5", "gpt-4o"]);
    }

    #[test]
    fn is_idempotent_when_already_on_seed_model() {
        let mut providers = vec![provider(
            "gemini",
            "gemini-2.5-flash",
            &["gemini-2.5-flash", "gemini-2.5-pro"],
        )];
        assert!(!migrate_stale_provider_models(&mut providers));
    }

    #[test]
    fn leaves_unknown_provider_and_non_stale_default_model_untouched() {
        let mut providers = vec![
            provider("groq", "openai/gpt-oss-20b", &["openai/gpt-oss-20b"]),
            // default_model elegido por el operador, fuera de la lista de
            // valores obsoletos: no se toca (no es una regresión a migrar).
            provider("gemini", "gemini-2.5-pro", &["gemini-2.5-pro"]),
        ];
        assert!(!migrate_stale_provider_models(&mut providers));
        assert_eq!(providers[0].default_model, "openai/gpt-oss-20b");
        assert_eq!(providers[1].default_model, "gemini-2.5-pro");
    }
}
