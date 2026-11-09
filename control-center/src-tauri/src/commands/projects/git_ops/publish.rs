// commands/projects/git_ops/publish.rs — Publicar un repositorio o una rama.
//
// `git_push` ejecuta `git push` a secas: en una rama sin upstream git lo
// rechaza, y en un repo sin remoto no hay nada a lo que empujar. Publicar es
// el paso que falta (estilo «Publish branch / Publish repository» de GitHub
// Desktop):
//   * rama nueva con remoto: `git push --set-upstream <remoto> <rama>`;
//   * repo sin remoto: `git remote add origin <url>` y lo anterior.
// La URL viene del usuario: se valida antes de pasarla a git (sin espacios ni
// caracteres de control, y nunca empezando por `-`, que git leería como
// opción).

use super::status::{invalidate_repo_state, work_dir};
use super::{off_main_thread, run_git_with, GIT_LOCAL_TIMEOUT, GIT_NETWORK_TIMEOUT};

/// Remoto al que se publica.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum RemotePlan {
    /// Un remoto que ya existe.
    Existing(String),
    /// Hay que crear `origin` con esta URL.
    AddOrigin(String),
}

/// Valida la URL de un remoto escrita por el usuario.
pub(super) fn validate_remote_url(url: &str) -> Result<&str, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("la URL del remoto está vacía".to_string());
    }
    if url.starts_with('-') {
        return Err("la URL del remoto no puede empezar por «-»".to_string());
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("la URL del remoto no puede tener espacios ni saltos de línea".to_string());
    }
    Ok(url)
}

/// Decide a qué remoto publicar a partir de `git remote` y la URL opcional.
pub(super) fn choose_remote(remotes: &[String], url: Option<&str>) -> Result<RemotePlan, String> {
    let has_origin = remotes.iter().any(|r| r == "origin");
    match (url, has_origin, remotes) {
        (Some(_), true, _) => {
            Err("ya existe el remoto origin: deja la URL vacía para publicar en él".to_string())
        }
        (Some(u), false, _) => Ok(RemotePlan::AddOrigin(u.to_string())),
        (None, true, _) => Ok(RemotePlan::Existing("origin".to_string())),
        (None, false, [only]) => Ok(RemotePlan::Existing(only.clone())),
        (None, false, []) => {
            Err("el repositorio no tiene remoto: indica la URL para crear origin".to_string())
        }
        (None, false, _) => Err(format!(
            "hay varios remotos y ninguno es origin ({}): no se elige uno a ciegas",
            remotes.join(", ")
        )),
    }
}

/// Rama actual; con HEAD separado no hay rama que publicar.
fn current_branch(cwd: &str) -> Result<String, String> {
    run_git_with(
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd,
        GIT_LOCAL_TIMEOUT,
    )
    .map(|b| b.trim().to_string())
    .map_err(|_| "HEAD separado: cambia a una rama antes de publicar".to_string())
}

fn list_remotes(cwd: &str) -> Result<Vec<String>, String> {
    let raw = match run_git_with(&["remote"], cwd, GIT_LOCAL_TIMEOUT)? {
        // `git_outcome` devuelve "OK" cuando la salida está vacía.
        s if s == "OK" => String::new(),
        s => s,
    };
    Ok(raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

pub(super) fn git_publish_blocking(path: &str, remote_url: Option<&str>) -> Result<String, String> {
    invalidate_repo_state(path);
    let cwd = work_dir(path)?;
    let url = remote_url
        .filter(|u| !u.trim().is_empty())
        .map(validate_remote_url)
        .transpose()?;
    let branch = current_branch(&cwd)?;
    let remote = match choose_remote(&list_remotes(&cwd)?, url)? {
        RemotePlan::Existing(name) => name,
        RemotePlan::AddOrigin(u) => {
            run_git_with(&["remote", "add", "origin", &u], &cwd, GIT_LOCAL_TIMEOUT)?;
            "origin".to_string()
        }
    };
    let result = run_git_with(
        &["push", "--set-upstream", &remote, &branch],
        &cwd,
        GIT_NETWORK_TIMEOUT,
    );
    invalidate_repo_state(path);
    let out = result?;
    Ok(format!("Rama {branch} publicada en {remote}.\n{out}"))
}

/// Publica la rama actual: crea `origin` si hace falta (`remote_url`) y
/// empuja con `--set-upstream`. Consumidor: el botón «Publicar rama» del
/// panel Git (RepoModal → PublishBranch), cuando no hay rama de seguimiento.
#[tauri::command]
pub async fn git_publish(path: String, remote_url: Option<String>) -> Result<String, String> {
    off_main_thread(move || git_publish_blocking(&path, remote_url.as_deref())).await
}

#[cfg(test)]
mod tests {
    use super::super::{git_output, GIT_LOCAL_TIMEOUT};
    use super::*;

    fn git(args: &[&str], cwd: &str) -> String {
        let out = git_output(args, cwd, GIT_LOCAL_TIMEOUT).expect("git");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Repo con un commit, sin hooks del usuario (core.hooksPath vacío).
    fn work_repo(dir: &std::path::Path) -> String {
        std::fs::create_dir_all(dir).expect("mkdir");
        let p = dir.to_string_lossy().to_string();
        git(&["init", "-q", "-b", "main"], &p);
        git(&["config", "user.name", "Test"], &p);
        git(&["config", "user.email", "test@example.invalid"], &p);
        git(&["config", "core.hooksPath", ".git/no-hooks"], &p);
        // Sin depender de la config global: push a secas exige upstream.
        git(&["config", "push.default", "simple"], &p);
        git(&["config", "push.autoSetupRemote", "false"], &p);
        std::fs::write(dir.join("a.txt"), "a").expect("write");
        git(&["add", "a.txt"], &p);
        git(&["commit", "-q", "-m", "inicial"], &p);
        p
    }

    fn bare_remote(dir: &std::path::Path) -> String {
        let p = dir.to_string_lossy().to_string();
        std::fs::create_dir_all(dir).expect("mkdir");
        git(&["init", "-q", "--bare"], &p);
        p
    }

    #[test]
    fn publica_un_repo_sin_remoto_creando_origin() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo = work_repo(&tmp.path().join("work"));
        let remote = bare_remote(&tmp.path().join("remote.git"));

        let msg = git_publish_blocking(&repo, Some(&remote)).expect("publicar");
        assert!(msg.contains("main") && msg.contains("origin"), "{msg}");
        assert_eq!(
            git(&["rev-parse", "--abbrev-ref", "main@{upstream}"], &repo),
            "origin/main"
        );
        assert_eq!(
            git(&["rev-parse", "main"], &repo),
            git(&["rev-parse", "main"], &remote)
        );
    }

    #[test]
    fn publica_una_rama_nueva_en_el_origin_existente() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo = work_repo(&tmp.path().join("work"));
        let remote = bare_remote(&tmp.path().join("remote.git"));
        git_publish_blocking(&repo, Some(&remote)).expect("publicar main");

        git(&["checkout", "-q", "-b", "feature/x"], &repo);
        // Caso negativo: `git push` a secas (lo que hace git_push) falla sin upstream.
        let plain = git_output(&["push"], &repo, GIT_LOCAL_TIMEOUT).expect("git push");
        assert!(!plain.status.success(), "push sin upstream debería fallar");

        git_publish_blocking(&repo, None).expect("publicar la rama");
        assert_eq!(
            git(
                &["rev-parse", "--abbrev-ref", "feature/x@{upstream}"],
                &repo
            ),
            "origin/feature/x"
        );
    }

    #[test]
    fn sin_remoto_ni_url_falla_y_lo_explica() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo = work_repo(&tmp.path().join("work"));
        let err = git_publish_blocking(&repo, None).unwrap_err();
        assert!(err.contains("no tiene remoto"), "{err}");
    }

    #[test]
    fn rechaza_urls_que_git_leeria_como_opciones_o_con_espacios() {
        assert!(validate_remote_url("--upload-pack=calc").is_err());
        assert!(validate_remote_url("https://x/y z").is_err());
        assert!(validate_remote_url("https://x/y\nz").is_err());
        assert!(validate_remote_url("   ").is_err());
        assert_eq!(
            validate_remote_url(" git@github.com:u/r.git ").unwrap(),
            "git@github.com:u/r.git"
        );
    }

    #[test]
    fn elige_el_remoto_sin_adivinar() {
        let origin = vec!["origin".to_string()];
        let other = vec!["upstream".to_string()];
        let two = vec!["a".to_string(), "b".to_string()];
        assert_eq!(
            choose_remote(&origin, None),
            Ok(RemotePlan::Existing("origin".into()))
        );
        assert!(choose_remote(&origin, Some("https://x")).is_err());
        assert_eq!(
            choose_remote(&other, None),
            Ok(RemotePlan::Existing("upstream".into()))
        );
        assert_eq!(
            choose_remote(&[], Some("https://x")),
            Ok(RemotePlan::AddOrigin("https://x".into()))
        );
        assert!(choose_remote(&two, None).is_err());
        assert!(choose_remote(&[], None).is_err());
    }
}
