//! Instalar un agente/skill suelto desde GitHub.
//!
//! 2026-09-22: antes esto lanzaba `gh api repos/<owner>/<repo>/contents/<path>`.
//! En esta maquina `gh` no esta instalado, asi que el camino estaba muerto.
//! Ahora baja el contenido por HTTP a traves de `maria::repos::contenido`, que
//! ademas fija la descarga a una referencia concreta.
//!
//! LIMITE DECLARADO (mandamiento 13): esto instala UN fichero. Una skill con
//! scripts al lado se quedaria a medias, y por eso el camino nuevo de
//! "Destacados" no pasa por aqui: usa `repos_aplicar`, que trabaja con el
//! manifiesto completo de la carpeta. Esta funcion sigue viva porque es la que
//! consume el modal de instalacion desde la pestana Agents.

use std::path::PathBuf;

use super::helpers::{atomic_write_bytes, is_kebab, resolve_agent_target, resolve_skill_dir};
use super::types::{LibraryKind, TargetScope};

#[allow(clippy::too_many_arguments)] // fixed tauri command signature — refactor to builder tracked separately
pub async fn install_from_github_inner(
    owner: String,
    repo: String,
    path: String,
    kind: LibraryKind,
    target_scope: TargetScope,
    target_project_id: Option<String>,
    target_name: Option<String>,
    overwrite: bool,
) -> Result<PathBuf, String> {
    // La descarga es bloqueante (reqwest::blocking, como el resto del crate):
    // va al pool de bloqueo para no parar el runtime asincrono.
    let (o, r, p) = (owner.clone(), repo.clone(), path.clone());
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        // `HEAD` es la rama por defecto del repositorio, sea cual sea su nombre.
        crate::maria::repos::contenido(&o, &r, &p, "HEAD")
    })
    .await
    .map_err(|e| format!("spawn join: {e}"))??;

    let body = String::from_utf8(bytes).map_err(|e| format!("not utf-8: {e}"))?;

    // Derive final name + target path.
    let name = target_name.unwrap_or_else(|| {
        path.rsplit('/')
            .next()
            .unwrap_or("")
            .trim_end_matches(".md")
            .trim_end_matches("/SKILL")
            .to_string()
    });
    if !is_kebab(&name) {
        return Err(format!("invalid name (must be kebab-case): {name}"));
    }

    // Skills go under <root>/skills/<name>/SKILL.md; agents under <root>/agents/<name>.md.
    let target = match kind {
        LibraryKind::Agent => {
            resolve_agent_target(&name, target_scope, target_project_id.as_deref())?
        }
        LibraryKind::Skill => {
            resolve_skill_dir(&name, target_scope, target_project_id.as_deref())?.join("SKILL.md")
        }
    };

    if target.exists() && !overwrite {
        return Err(format!("already exists: {}", target.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
    }
    atomic_write_bytes(&target, body.as_bytes())?;
    Ok(target)
}
