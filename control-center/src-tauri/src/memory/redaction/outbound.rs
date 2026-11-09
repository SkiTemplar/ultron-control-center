//! Redacción del texto que sale a un proveedor externo (Groq, Gemini…) desde
//! funciones que no escriben memoria: `/mejorar` de Sessions y el etiquetado
//! automático de sesiones (seguridad MEDIUM de la auditoría 2026-10-17).
//!
//! Dos pasos: los secretos con el mismo detector que el write-path de memoria
//! (`[REDACTED:<tipo>]`) y el perfil del usuario de cada ruta
//! (`C:\Users\<cuenta>`, `/home/<cuenta>`, `/Users/<cuenta>`) cambiado por `~`.
//! A diferencia de `redact_pii`, la ruta no se borra entera: el resto
//! (`~\proyecto\src\a.rs`) sigue siendo útil para el modelo y para la persona
//! que recibe el texto reescrito, pero el nombre de la cuenta no sale.

use std::sync::OnceLock;

use regex::{Captures, Regex};

use super::secrets::redact;

fn user_home_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Las rutas POSIX solo cuentan al principio de un token (inicio de
        // línea, blanco, comilla, paréntesis o `=`): así `https://x.com/home/a`
        // o `api.github.com/users/a` no se tocan.
        Regex::new(
            r#"(?m)(?P<pre>^|[\s"'`(=])(?:/home|/Users)/[^/\s"'`]+|\b(?i:[a-z]:[\\/]+users[\\/]+)[^\\/\s"'`]+"#,
        )
        .expect("regex de perfil de usuario válida")
    })
}

/// Copia de `text` sin secretos y con el perfil del usuario de cada ruta
/// cambiado por `~`.
#[must_use]
pub fn redact_outbound(text: &str) -> String {
    let without_secrets = redact(text);
    user_home_re()
        .replace_all(&without_secrets, |caps: &Captures| {
            format!("{}~", caps.name("pre").map_or("", |m| m.as_str()))
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cambia_el_perfil_de_windows_por_la_tilde() {
        let out = redact_outbound(r"Directorio de trabajo: C:\Users\cuenta\proyecto\src");
        assert_eq!(out, r"Directorio de trabajo: ~\proyecto\src");
        let out = redact_outbound("cwd c:/users/Cuenta/p y D:\\Users\\otra\\x");
        assert_eq!(out, "cwd ~/p y ~\\x");
    }

    #[test]
    fn cambia_el_perfil_posix_al_principio_de_un_token() {
        assert_eq!(redact_outbound("en /home/cuenta/p"), "en ~/p");
        assert_eq!(redact_outbound("\"/Users/cuenta/p\""), "\"~/p\"");
        assert_eq!(redact_outbound("/home/cuenta"), "~");
    }

    #[test]
    fn no_toca_urls_ni_rutas_sin_perfil() {
        let url = "https://api.github.com/users/octocat y https://x.test/home/page";
        assert_eq!(redact_outbound(url), url);
        let neutro = r"C:\proyectos\demo y src/home/mod.rs";
        assert_eq!(redact_outbound(neutro), neutro);
    }

    #[test]
    fn quita_los_secretos() {
        let key = format!("ghp_{}", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
        let out = redact_outbound(&format!("usa {key} en C:\\Users\\cuenta\\proyecto"));
        assert!(!out.contains(&key), "la clave no puede salir: {out}");
        assert!(
            out.contains("[REDACTED:"),
            "debe marcar la redacción: {out}"
        );
        assert!(
            !out.contains("cuenta"),
            "el nombre de la cuenta no puede salir: {out}"
        );
    }
}
