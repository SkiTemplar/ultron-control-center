// Migraciones puras del catálogo de proveedores (`providers.json`), movidas
// tal cual desde store.rs. Las aplica `provider_overlay::load_state`.

use std::collections::HashSet;

use super::super::seed::seed_providers;
use super::super::types::Provider;

/// Añade al catálogo persistido los proveedores del seed que le faltan,
/// emparejando por id. Devuelve `true` cuando añadió algo, para que quien
/// llama persista el fichero.
///
/// `migrate_stale_provider_models` repara los MODELOS de un proveedor que ya
/// está en el fichero, pero no puede hacer nada con un proveedor AUSENTE, y un
/// `providers.json` escrito antes de que el seed ganara una entrada no la
/// recibía jamás. Medido en esta máquina el 2026-09-21: el fichero tenía 8
/// proveedores y el seed 9 — faltaba `claude`, que era el primary de
/// `code-edit` y `code-review` desde la decisión del 2026-06-24. Las dos zonas
/// llamaban a un proveedor inexistente, fallaban y caían al fallback en cada
/// petición, y el salto se contabilizaba como `real_fallback_rate`.
///
/// Solo AÑADE: una entrada que el operador ya editó conserva su coste, sus
/// modelos y su `base_url` intactos (de esa deriva se encarga
/// `migrate_stale_provider_models`, acotada a valores conocidos como
/// obsoletos). Respeta el orden y añade al final, así que el catálogo nunca se
/// reordena bajo la UI.
///
/// Pura (sin E/S) para poder probarla.
/// Adaptada de la rama `maria-core` del espejo público (2026-09-21).
pub(crate) fn merge_missing_seed_providers(providers: &mut Vec<Provider>) -> bool {
    let have: HashSet<String> = providers.iter().map(|p| p.id.clone()).collect();
    let mut mutated = false;
    for sp in seed_providers() {
        if !have.contains(&sp.id) {
            providers.push(sp);
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
    // (2026-10-21) Solo familia Claude 5.5: los ids 5, Fable y Haiku 4.5
    // pasan al default y a la lista de seed_providers.
    const TARGETS: &[(&str, &[&str])] = &[
        ("gemini", &["gemini-3.8-flash"]),
        ("codex-cli", &["gpt-5", "gpt-5.5"]),
        (
            "claude",
            &["claude-sonnet-5", "claude-opus-5", "claude-fable-5"],
        ),
        ("claude-haiku", &["claude-haiku-4-5-20251001"]),
        // (2026-10-26) La API de DeepSeek ya no sirve coder ni chat (GET /models).
        ("deepseek", &["deepseek-coder", "deepseek-chat"]),
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

/// Cambia el `localhost` del proveedor `ollama` por `127.0.0.1` en un
/// `providers.json` ya escrito.
///
/// Ollama escucha solo en IPv4 (`TCP 127.0.0.1:11434 LISTENING`), pero
/// `localhost` resuelve antes a `::1`: cada petición paga el rechazo de IPv6
/// hasta que happy-eyeballs reintenta por IPv4. Medido el 2026-09-21: 207 ms
/// frente a 2,5 ms, y el coste se paga DOS VECES por invocación porque
/// `call_ollama` sondea `/api/tags` antes de `/api/generate`. Funcionar,
/// funciona — por eso nadie lo vio.
///
/// Acotada a `ollama` y a un `base_url`/`health_endpoint` que sigan diciendo
/// `localhost`: una URL que el operador haya apuntado a otra máquina no se
/// toca. `migrate_stale_provider_models` no sirve aquí porque solo repara
/// modelos, nunca URLs.
///
/// Pura (sin E/S) para poder probarla.
pub(crate) fn migrate_ollama_loopback(providers: &mut [Provider]) -> bool {
    let mut mutated = false;
    for p in providers.iter_mut().filter(|p| p.id == "ollama") {
        if p.base_url.contains("//localhost:") {
            p.base_url = p.base_url.replace("//localhost:", "//127.0.0.1:");
            mutated = true;
        }
        if let Some(h) = p.health_endpoint.as_mut() {
            if h.contains("//localhost:") {
                *h = h.replace("//localhost:", "//127.0.0.1:");
                mutated = true;
            }
        }
    }
    mutated
}
