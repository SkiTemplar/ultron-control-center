// Migraciones de `zones.json` y la canalización que las aplica en cada carga.
//
// Todas son puras (sin E/S) y por zona: `normalize_zones` las aplica en orden
// y devuelve el motivo de cada una que haya cambiado algo. `load_zones` lo usa
// para saber si tiene que reescribir el fichero y `save_zone` para rechazar,
// con el motivo, una edición que la carga siguiente revertiría (antes el
// editor respondía «Guardado» y la carga deshacía el cambio en silencio).

use std::collections::HashSet;

use crate::ai_router::seed::seed_zones;
use crate::ai_router::types::{Zone, ZoneAssignment};

/// Una migración de zonas: devuelve `true` si ha mutado algo.
type ZoneMigration = fn(&mut Vec<Zone>) -> bool;

/// Migraciones en el orden en que se aplican, con el motivo que se enseña al
/// operador cuando una edición suya choca con ellas. Primero cada migración
/// puntual deja su zona como quiere; después se comprueba que no falte ningún
/// eslabón del seed. La reparación contra el catálogo va aparte (necesita el
/// catálogo) y siempre la última.
const ZONE_MIGRATIONS: &[(&str, ZoneMigration)] = &[
    (
        "gemini-cli está retirado (Google cortó el free tier OAuth el 2026-06-19); \
         la carga lo cambia por el proveedor gemini",
        |z| retire_gemini_cli(z),
    ),
    (
        "gemini-3.8-flash está retirado (55 s de latencia medidos el 2026-09-16); \
         la carga lo cambia por gemini-2.5-flash",
        |z| migrate_gemini_flash_model(z),
    ),
    (
        "la zona está retirada por no tener llamante en el código",
        retire_unused_zones,
    ),
    (
        "ollama solo se usa para programar (decisión del 2026-10-19); \
         la carga lo quita de la zona light",
        |z| retire_seed_ollama_fallback(z),
    ),
    (
        "la cadena tiene que conservar los fallbacks del seed (la carga \
         reinserta los que faltan)",
        |z| restore_missing_seed_fallbacks(z),
    ),
];

const CATALOG_REASON: &str = "un proveedor de la cadena no está en el catálogo (providers.json)";

/// Aplica todas las migraciones y devuelve el motivo de las que han mutado
/// algo (vacío = las zonas ya estaban normalizadas). Con un catálogo vacío
/// no se repara contra él: un `providers.json` ilegible no debe vaciar zonas.
pub(crate) fn normalize_zones(zones: &mut Vec<Zone>, catalog: &[String]) -> Vec<&'static str> {
    let mut reasons: Vec<&'static str> = ZONE_MIGRATIONS
        .iter()
        .filter_map(|(reason, migrate)| migrate(zones).then_some(*reason))
        .collect();
    if !catalog.is_empty() && repair_zones_against_catalog(zones, catalog) {
        reasons.push(CATALOG_REASON);
    }
    reasons
}

/// Repara las zonas cuyo `primary` o cuyos `fallbacks` apunten a un proveedor
/// que no está en el catálogo.
///
/// Sin esto, una zona con un `primary` inexistente no falla al cargar: falla
/// en tiempo de ejecución, una llamada más tarde, con un "proveedor
/// desconocido" que no dice de dónde viene. Los fallbacks muertos se caen; un
/// primary muerto se sustituye por el primer fallback vigente y, si no queda
/// ninguno, por la cadena del seed para esa zona (filtrada por el catálogo).
/// Ollama ya no es el destino de último recurso: desde el 2026-10-19 solo se
/// usa para programar, y las zonas del seed son todas triviales.
///
/// También quita fallbacks repetidos: al fundir dos proveedores en uno, una
/// zona acababa con el mismo fallback tres veces y la cadena lo intentaba tres
/// veces seguidas.
///
/// La deduplicación es por la pareja (proveedor, modelo), NO por proveedor:
/// la cadena de `chat` repite `groq` a propósito con dos modelos, porque la
/// cuota de Groq es POR MODELO (medido el 2026-09-07: sin el 20b, la captura
/// se quedaba sin proveedor tras 266 llamadas en un día).
///
/// Una zona ajena al seed sin ningún proveedor vigente se deja como está:
/// `route()` fallará con «proveedor desconocido» y el fallo total queda
/// registrado en las métricas y en `route-decisions.jsonl`.
pub(crate) fn repair_zones_against_catalog(zones: &mut [Zone], catalogo: &[String]) -> bool {
    let vigente = |id: &str| catalogo.iter().any(|v| v == id);
    let seed = seed_zones();
    let mut mutated = false;
    for z in zones.iter_mut() {
        let antes = z.fallbacks.len();
        z.fallbacks.retain(|f| vigente(&f.provider_id));
        let mut vistos: HashSet<(String, String)> = HashSet::new();
        z.fallbacks
            .retain(|f| vistos.insert((f.provider_id.clone(), f.model.clone())));
        if z.fallbacks.len() != antes {
            mutated = true;
        }
        if vigente(&z.primary.provider_id) {
            continue;
        }
        if let Some(nuevo) = z.fallbacks.first().cloned() {
            z.primary = nuevo;
            z.fallbacks.remove(0);
            mutated = true;
        } else if let Some(cadena) = seed_chain_in_catalog(&seed, &z.id, &vigente) {
            z.primary = cadena[0].clone();
            z.fallbacks = cadena[1..].to_vec();
            mutated = true;
        }
    }
    mutated
}

/// Cadena del seed de la zona `id` (primary + fallbacks) con solo los
/// proveedores vigentes, o `None` si la zona no está en el seed o no queda
/// ningún eslabón.
fn seed_chain_in_catalog(
    seed: &[Zone],
    id: &str,
    vigente: &dyn Fn(&str) -> bool,
) -> Option<Vec<ZoneAssignment>> {
    let sz = seed.iter().find(|s| s.id == id)?;
    let cadena: Vec<ZoneAssignment> = std::iter::once(&sz.primary)
        .chain(sz.fallbacks.iter())
        .filter(|a| vigente(&a.provider_id))
        .cloned()
        .collect();
    (!cadena.is_empty()).then_some(cadena)
}

/// Devuelve a la cadena los fallbacks del seed que se perdieron por el camino.
///
/// Hasta el 2026-09-16 `retire_gemini_cli` deduplicaba por `provider_id`
/// ignorando el modelo, así que en cada carga borraba el `groq:gpt-oss-20b` de
/// la zona `chat`. Los `zones.json` ya dañados se quedaron sin ese eslabón
/// (verificado el 2026-09-21), y sin él la cadena salta directa a las 20
/// peticiones diarias de Gemini.
///
/// Cada fallback que falta se reinserta en el índice que ocupa en el seed, de
/// modo que el orden de la estrategia se respeta. Lo que el operador haya
/// añadido por su cuenta no se toca ni se reordena.
///
/// Límite declarado: un fallback que el seed define no se puede quitar. Desde
/// el 2026-10-23 `save_zone` rechaza esa edición con este motivo en vez de
/// aceptarla y dejar que la carga siguiente la revierta en silencio.
pub(crate) fn restore_missing_seed_fallbacks(zones: &mut [Zone]) -> bool {
    let seed = seed_zones();
    let mut mutated = false;
    for z in zones.iter_mut() {
        let Some(sz) = seed.iter().find(|s| s.id == z.id) else {
            continue;
        };
        for (idx, sf) in sz.fallbacks.iter().enumerate() {
            let ya_esta = z.primary.provider_id == sf.provider_id && z.primary.model == sf.model
                || z.fallbacks
                    .iter()
                    .any(|f| f.provider_id == sf.provider_id && f.model == sf.model);
            if ya_esta {
                continue;
            }
            let pos = idx.min(z.fallbacks.len());
            z.fallbacks.insert(pos, sf.clone());
            mutated = true;
        }
    }
    mutated
}

/// Quita de la zona `light` el `ollama:qwen2.5-coder:32b` que el seed llevaba
/// como último relevo hasta el 2026-10-23.
///
/// Decisión del 2026-10-19: ollama solo para programar; lo trivial va por
/// groq y gemini. Acotada a la pareja exacta que traía el seed: no es una
/// prohibición general de ollama en las zonas del operador. Pura e
/// idempotente.
pub(crate) fn retire_seed_ollama_fallback(zones: &mut [Zone]) -> bool {
    const ZONE: &str = "light";
    const MODEL: &str = "qwen2.5-coder:32b";
    let mut mutated = false;
    for z in zones.iter_mut().filter(|z| z.id == ZONE) {
        let antes = z.fallbacks.len();
        z.fallbacks
            .retain(|f| !(f.provider_id == "ollama" && f.model == MODEL));
        mutated |= z.fallbacks.len() != antes;
    }
    mutated
}

/// Retire the dead `gemini-cli` provider from every zone chain: replace it
/// with the cloud `gemini` provider, then drop any fallback whose
/// (provider, model) pair already appears earlier in the chain (including as
/// the primary). The dedup key is the pair, not the provider: Groq quotas are
/// per model, so a legit chain carries several models of the same provider.
///
/// Pure (no I/O). Returns `true` if any zone was mutated.
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
        mutated |= dedup_chain(z);
    }
    mutated
}

/// Quita los fallbacks cuya pareja (proveedor, modelo) ya aparece antes en la
/// cadena. Devuelve `true` si ha quitado alguno.
fn dedup_chain(z: &mut Zone) -> bool {
    let mut seen: HashSet<(String, String)> = HashSet::new();
    seen.insert((z.primary.provider_id.clone(), z.primary.model.clone()));
    let before = z.fallbacks.len();
    z.fallbacks
        .retain(|f| seen.insert((f.provider_id.clone(), f.model.clone())));
    z.fallbacks.len() != before
}

/// Zonas retiradas por no tener ningún llamante en el código. Una zona
/// configurada que nadie invoca es configuración que miente sobre lo que el
/// sistema hace.
///
/// - 2026-09-21: `research-web`, `routing-decision` y `code-fast-local`.
/// - 2026-10-23: `code-edit` y `code-review`, sin llamante desde el
///   2026-09-23 (se borró `library::ai_install` con `pick_analysis_zone`).
///   Con ellas desaparece la política CLI-first de zonas de código.
pub(crate) const RETIRED_ZONE_IDS: [&str; 5] = [
    "research-web",
    "routing-decision",
    "code-fast-local",
    "code-edit",
    "code-review",
];

/// Borrar del `zones.json` ya escrito las zonas de `RETIRED_ZONE_IDS`.
///
/// Sin esto la poda de `seed_zones` no llegaría a ninguna instalación
/// existente: la semilla solo corre cuando el fichero todavía no existe.
/// Idempotente. Pura (sin E/S).
pub(crate) fn retire_unused_zones(zones: &mut Vec<Zone>) -> bool {
    let before = zones.len();
    zones.retain(|z| !RETIRED_ZONE_IDS.contains(&z.id.as_str()));
    zones.len() != before
}

/// Bump the cloud `gemini` provider's model from the retired
/// `gemini-3.8-flash` back to `gemini-2.5-flash` (2026-09-16: 3.8-flash
/// medido en vivo en 55.497 ms; 2.5-flash en 624 ms). Idempotent; de-dups by
/// (provider, model) afterwards. Pure (no I/O).
pub(crate) fn migrate_gemini_flash_model(zones: &mut [Zone]) -> bool {
    const OLD_MODEL: &str = "gemini-3.8-flash";
    const NEW_MODEL: &str = "gemini-2.5-flash";
    let mut mutated = false;
    for z in zones.iter_mut() {
        let chain = std::iter::once(&mut z.primary).chain(z.fallbacks.iter_mut());
        for a in chain.filter(|a| a.provider_id == "gemini" && a.model == OLD_MODEL) {
            a.model = NEW_MODEL.into();
            mutated = true;
        }
        mutated |= dedup_chain(z);
    }
    mutated
}
