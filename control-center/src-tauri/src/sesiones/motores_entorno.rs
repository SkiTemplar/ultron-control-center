// sesiones/motores_entorno.rs — Entorno de las tareas de motores (submódulo
// de `motores`).
//
// Una tarea de Codex, Gemini u OpenCode (incluido el relevo, que se lanza
// solo con permisos amplios y texto de la conversación en el prompt) no
// hereda ninguna variable secreta de la app: ni las keys cargadas con dotenvy
// desde `~/.ultron/.env` ni las del entorno de usuario. Misma regla que
// `scrubbedEnv` del delegador (`scripts/lib/delegate/env.mjs`): las keys que
// gestiona la app (`env_keys::ALLOWED_KEYS`, que incluye `ULTRON_KEY_*`) y,
// por patrón, `*_API_KEY`, `*_TOKEN`, `*_PAT`, `*_SECRET*`, `*_PASSWORD*`,
// `AWS_*` y `ULTRON_KEY_*`. Codex y agy se autentican con su propio login;
// OpenCode recibe después solo las keys que le inyecta `opencode_entorno`.
//
// Es el único clasificador de secretos de `sesiones/`: las sesiones de Claude
// (`lanzamiento::claves_excluidas`) lo usan con las excepciones de
// `AUTENTICACION_CLAUDE`, lo que ellas sí necesitan para autenticarse.

use std::process::Command;

/// Variables secretas que la CLI de Claude y sus plugins necesitan para
/// autenticarse: el token OAuth de la suscripción, el de una pasarela propia y
/// el que `.mcp.json` del plugin github expande en su cabecera. `GITHUB_TOKEN` y
/// `GH_TOKEN` son la única autenticación de `gh` si no hay sesión en el keyring,
/// como en esta máquina. Fuera de esta lista a propósito `ANTHROPIC_API_KEY`:
/// Claude Code la tomaría en lugar de la suscripción.
pub const AUTENTICACION_CLAUDE: &[&str] = &[
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
];

/// true si la variable `nombre` se considera secreta.
pub fn es_variable_secreta(nombre: &str) -> bool {
    let up = nombre.to_ascii_uppercase();
    crate::env_keys::is_allowed_key(&up)
        || up.ends_with("_API_KEY")
        || up.ends_with("_TOKEN")
        || up.ends_with("_PAT")
        || up.contains("_SECRET")
        || up.contains("_PASSWORD")
        || up.starts_with("AWS_")
        || up.starts_with("ULTRON_KEY_")
}

/// true si una sesión de Claude no debe heredar la variable.
pub fn se_excluye_de_claude(nombre: &str) -> bool {
    let up = nombre.to_ascii_uppercase();
    es_variable_secreta(&up) && !AUTENTICACION_CLAUDE.contains(&up.as_str())
}

/// Quita del entorno de `cmd` cada variable secreta de `nombres`.
pub fn quitar_secretos(cmd: &mut Command, nombres: impl Iterator<Item = String>) {
    for n in nombres.filter(|n| es_variable_secreta(n)) {
        cmd.env_remove(n);
    }
}

/// Nombres de las variables del entorno de la app (las no UTF-8 se omiten:
/// ninguna key de la lista lo es).
pub fn variables_de_la_app() -> impl Iterator<Item = String> {
    std::env::vars_os().filter_map(|(k, _)| k.into_string().ok())
}
