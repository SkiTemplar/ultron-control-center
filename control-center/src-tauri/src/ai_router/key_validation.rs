// Validación de keys por proveedor (comando `ai_router_validate_keys`).
//
// Deriva de `compute_key_status`, la misma función con la que `route()`
// decide qué proveedores saltar: así la pestaña de keys no puede decir "tiene
// key" de un proveedor que el router va a descartar (p. ej. un proxy en
// loopback que declara variable de key y no la tiene definida).

use super::store::{compute_key_status, detect_cli};
use super::types::{ApiKeyStatus, KeyValidation, Provider, ProviderKind};

fn cli_validation(p: &Provider) -> KeyValidation {
    let cmd = p.cli_command.as_deref().unwrap_or("");
    let installed = !cmd.is_empty() && detect_cli(cmd);
    let install_hint = match cmd {
        "codex" => "npm install -g @openai/codex  then  codex auth",
        "gemini" => "npm install -g @google/gemini-cli  then  gemini auth",
        _ => "Install the CLI and run its auth command",
    };
    KeyValidation {
        provider_id: p.id.clone(),
        provider_label: p.name.clone(),
        has_key: installed,
        source: if installed {
            "cli-installed"
        } else {
            "cli-missing"
        }
        .to_string(),
        warning: (!installed).then(|| format!("CLI '{cmd}' not found on PATH. {install_hint}")),
    }
}

/// Resultado de validar la key de `p`, coherente con `compute_key_status`.
pub(crate) fn key_validation(p: &Provider) -> KeyValidation {
    if p.kind == ProviderKind::Cli {
        return cli_validation(p);
    }
    let (has_key, source, warning) = match compute_key_status(p) {
        ApiKeyStatus::Configured if p.key_env_var.is_empty() => (true, "local", None),
        ApiKeyStatus::Configured => (true, "env", None),
        ApiKeyStatus::Placeholder => (
            false,
            "none",
            Some(format!(
                "Provider '{}' has a placeholder value in {}. \
                 Set a real key or configure it in Settings > API Keys.",
                p.id, p.key_env_var
            )),
        ),
        ApiKeyStatus::Missing => (
            false,
            "none",
            Some(format!(
                "Provider '{}' has no API key. \
                 Set {} or configure it in Settings > API Keys.",
                p.id, p.key_env_var
            )),
        ),
    };
    KeyValidation {
        provider_id: p.id.clone(),
        provider_label: p.name.clone(),
        has_key,
        source: source.to_string(),
        warning,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_router::seed::seed_providers;

    fn local(key_env_var: &str) -> Provider {
        let mut p = seed_providers()
            .into_iter()
            .find(|p| p.kind == ProviderKind::Local)
            .expect("un proveedor local en el seed");
        p.id = "proxy-local".into();
        p.key_env_var = key_env_var.into();
        p
    }

    /// Caso negativo: un local que declara variable de key y no la tiene no
    /// "tiene key" (antes todo local devolvía `has_key: true`), igual que
    /// `compute_key_status`, que lo da por `Missing` y `route()` lo salta.
    #[test]
    fn un_local_con_variable_sin_definir_no_tiene_key() {
        let p = local("ULTRON_KEY_TEST_NO_DEFINIDA_VALIDATE");
        assert_eq!(compute_key_status(&p), ApiKeyStatus::Missing);
        let v = key_validation(&p);
        assert!(!v.has_key, "{v:?}");
        assert_eq!(v.source, "none");
        assert!(v
            .warning
            .is_some_and(|w| w.contains("ULTRON_KEY_TEST_NO_DEFINIDA_VALIDATE")));
    }

    #[test]
    fn un_local_sin_variable_tiene_key() {
        let v = key_validation(&local(""));
        assert!(v.has_key);
        assert_eq!(v.source, "local");
        assert!(v.warning.is_none());
    }

    /// Para todo proveedor no CLI del seed, `has_key` coincide con lo que
    /// decide `compute_key_status`.
    #[test]
    fn coincide_con_compute_key_status_en_todo_el_seed() {
        for p in seed_providers()
            .iter()
            .filter(|p| p.kind != ProviderKind::Cli)
        {
            let configured = compute_key_status(p) == ApiKeyStatus::Configured;
            assert_eq!(key_validation(p).has_key, configured, "{}", p.id);
        }
    }
}
