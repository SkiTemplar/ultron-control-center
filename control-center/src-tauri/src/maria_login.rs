// mar.ia — acceso a cada proveedor: como se entra y si ya se ha entrado.
//
// El usuario pidio (2026-09-19) "comprobar que el sistema de routing te lleve a
// los sitios correctos de login para cada proveedor, como con gemini siendo
// antigravity". El problema real era que la pantalla de Auth solo conocia
// Claude y Codex, y para Gemini no habia nada — justo el que cambio.
//
// ESTADO VERIFICADO (2026-09-20, comprobado en esta maquina):
//   * Google corto el OAuth de Gemini CLI para cuentas individuales el
//     2026-06-18 ("This client is no longer supported for Gemini Code Assist
//     for individuals").
//   * Antigravity (`agy`) SI esta instalado y responde: `agy models` lista los
//     modelos y `agy -p "..."` contesta.
//   * Gemini sale de la lista el 2026-09-20 por peticion del usuario ("quitar
//     gemini por agy"): tener dos fichas para lo mismo, una de ellas muerta,
//     solo servia para equivocarse.
//
// LIMITE DECLARADO (mandamiento 13): "dentro" significa cosas distintas segun
// el proveedor y cada ficha lo dice. En Claude y Codex se comprueba el fichero
// de credenciales real; en Antigravity, solo que el binario este (su sesion no
// se guarda en ningun fichero legible desde aqui). NO se valida contra el
// servidor: eso gastaria cuota en cada refresco de la pantalla.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AccesoProveedor {
    pub provider: String,
    pub label: String,
    /// La herramienta esta instalada en el PATH.
    pub installed: bool,
    /// Hay credencial/clave utilizable. Ver el limite declarado arriba.
    pub logged_in: bool,
    /// Que significa exactamente `logged_in` para este proveedor.
    pub how_checked: String,
    /// Que hacer para entrar, en una linea.
    pub how_to: String,
    /// Comando que resuelve el acceso (vacio si es solo web).
    pub command: String,
    /// Pagina a la que llevar al usuario.
    pub url: String,
    /// Aviso cuando hay algo que saber (p. ej. un camino que ya no existe).
    pub note: String,
}

pub fn en_path(bin: &str) -> bool {
    crate::proc::oculto(if cfg!(windows) { "where" } else { "which" })
        .arg(bin)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Estado de acceso de los cuatro caminos que usa mar.ia.
#[must_use]
pub fn accesos() -> Vec<AccesoProveedor> {
    let home = dirs::home_dir().unwrap_or_default();

    let claude_cred = home.join(".claude").join(".credentials.json");
    let codex_cred = home.join(".codex").join("auth.json");

    vec![
        AccesoProveedor {
            provider: "claude".into(),
            label: "Claude".into(),
            installed: en_path("claude"),
            logged_in: claude_cred.exists(),
            how_checked: "existe ~/.claude/.credentials.json".into(),
            how_to: "Abre una terminal de Claude y escribe /login.".into(),
            command: "claude".into(),
            url: "https://claude.ai/login".into(),
            note: String::new(),
        },
        AccesoProveedor {
            provider: "codex".into(),
            label: "Codex (ChatGPT)".into(),
            installed: en_path("codex"),
            logged_in: codex_cred.exists(),
            how_checked: "existe ~/.codex/auth.json".into(),
            how_to: "Ejecuta `codex login` y termina el flujo en el navegador.".into(),
            command: "codex login".into(),
            url: "https://chatgpt.com/codex".into(),
            note: String::new(),
        },
        AccesoProveedor {
            provider: "antigravity".into(),
            label: "Antigravity (agy)".into(),
            installed: en_path("agy"),
            logged_in: en_path("agy"),
            how_checked: "el binario `agy` está en el PATH".into(),
            how_to: "Instálalo y entra con tu cuenta de Google; es el sustituto oficial \
                     de Gemini CLI para suscripciones individuales."
                .into(),
            command: "powershell -NoProfile -Command \"irm https://antigravity.google/cli/install.ps1 | iex\""
                .into(),
            url: "https://antigravity.google/docs/cli/install".into(),
            note: String::new(),
        },
    ]
}

#[tauri::command]
pub async fn maria_login_status() -> Result<Vec<AccesoProveedor>, String> {
    tauri::async_runtime::spawn_blocking(accesos)
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))
}

/// Abre la pagina de acceso de un proveedor en el navegador del sistema.
///
/// La URL NO viene del frontend: se busca en el catalogo por el nombre del
/// proveedor. Aceptar una URL cualquiera desde la interfaz seria dejar que
/// abra lo que le pasen.
#[tauri::command]
pub async fn maria_login_open(provider: String) -> Result<String, String> {
    let url = accesos()
        .into_iter()
        .find(|a| a.provider == provider)
        .map(|a| a.url)
        .ok_or_else(|| format!("proveedor desconocido: {provider}"))?;
    if url.is_empty() {
        return Err(format!("{provider} no tiene página de acceso"));
    }
    crate::proc::oculto("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map_err(|e| format!("no pude abrir el navegador: {e}"))?;
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estan_los_cuatro_caminos() {
        let ids: Vec<String> = accesos().into_iter().map(|a| a.provider).collect();
        assert_eq!(ids, vec!["claude", "codex", "antigravity"]);
    }

    #[test]
    fn cada_ficha_dice_como_entrar_y_adonde() {
        for a in accesos() {
            assert!(!a.how_to.trim().is_empty(), "{} sin instrucciones", a.provider);
            assert!(a.url.starts_with("https://"), "{} sin url https", a.provider);
            assert!(
                !a.how_checked.trim().is_empty(),
                "{} no explica que comprueba",
                a.provider
            );
        }
    }

    #[test]
    fn no_queda_ninguna_ficha_de_gemini() {
        // Caso negativo del cambio del 2026-09-20: Gemini sale del programa.
        // Si volviera a aparecer una ficha suya estariamos mandando al usuario
        // a un login que Google cerro el 18/06/2026.
        assert!(accesos().iter().all(|a| a.provider != "gemini"));
        assert!(accesos().iter().all(|a| !a.label.to_lowercase().contains("gemini")));
    }

    #[test]
    fn antigravity_lleva_a_su_instalador() {
        let a = accesos()
            .into_iter()
            .find(|a| a.provider == "antigravity")
            .unwrap();
        assert!(a.url.contains("antigravity.google"));
        assert!(a.command.contains("install.ps1"));
    }
}
