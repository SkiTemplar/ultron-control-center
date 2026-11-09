// sesiones/opencode_entorno.rs — Localización de OpenCode, keys de sus
// proveedores y estado del motor (`sesiones_engines`).
//
// OpenCode 1.19 se instala por npm con un shim `.cmd` que solo lanza el
// binario nativo `node_modules/opencode-ai/bin/opencode.exe`: se usa ese
// ejecutable directamente (nunca `cmd.exe`, que interpretaría el prompt).
//
// Las keys se inyectan SOLO al proceso hijo de OpenCode. Se leen del entorno
// de la app o, si no está ahí (un `setx` no refresca el proceso padre), del
// registro de usuario, igual que `env_keys`. Dos variables cambian de nombre:
// OpenCode lee `NVIDIA_API_KEY` y `GOOGLE_GENERATIVE_AI_API_KEY`, y ULTRON
// guarda `NVIDIA_NIM_API_KEY` y `GEMINI_API_KEY`. La política de
// `lanzamiento.rs` (las sesiones de Claude no heredan keys) no cambia.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use super::motores::{self, Program};
use super::types::EngineStatus;

/// Binario nativo junto al shim de npm.
const NATIVO_NPM: &str = "node_modules/opencode-ai/bin/opencode.exe";

/// Proveedor de OpenCode con key de ULTRON.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Proveedor {
    /// Prefijo de los modelos en OpenCode (`deepseek/…`).
    pub id: &'static str,
    pub label: &'static str,
    /// Variable en la que ULTRON guarda la key.
    pub nuestra: &'static str,
    /// Variable que lee OpenCode.
    pub suya: &'static str,
}

const fn prov(
    id: &'static str,
    label: &'static str,
    nuestra: &'static str,
    suya: &'static str,
) -> Proveedor {
    Proveedor {
        id,
        label,
        nuestra,
        suya,
    }
}

/// Proveedores que se ofrecen. Fuera a propósito `github-copilot` (no hay
/// suscripción) y `opencode` (el gratuito de Zen está agotado).
pub const PROVEEDORES: &[Proveedor] = &[
    prov(
        "deepseek",
        "DeepSeek",
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_API_KEY",
    ),
    prov(
        "openrouter",
        "OpenRouter",
        "OPENROUTER_API_KEY",
        "OPENROUTER_API_KEY",
    ),
    prov("groq", "Groq", "GROQ_API_KEY", "GROQ_API_KEY"),
    prov(
        "cerebras",
        "Cerebras",
        "CEREBRAS_API_KEY",
        "CEREBRAS_API_KEY",
    ),
    prov(
        "nvidia",
        "NVIDIA NIM",
        "NVIDIA_NIM_API_KEY",
        "NVIDIA_API_KEY",
    ),
    prov(
        "google",
        "Google",
        "GEMINI_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
    ),
    // Créditos de API del plan. Nunca `ANTHROPIC_API_KEY` en el entorno de
    // usuario: Claude Code la tomaría en lugar de la suscripción.
    prov(
        "anthropic",
        "Anthropic (créditos API)",
        "ULTRON_KEY_ANTHROPIC_CREDITS",
        "ANTHROPIC_API_KEY",
    ),
];

/// Keys presentes, como `(variable de OpenCode, valor)`. Pura: el entorno y
/// el registro llegan como parámetros.
pub fn claves_de(
    entorno: impl Fn(&str) -> Option<String>,
    registro: &HashMap<String, String>,
) -> Vec<(&'static Proveedor, String)> {
    PROVEEDORES
        .iter()
        .filter_map(|p| {
            let valor = entorno(p.nuestra)
                .or_else(|| registro.get(p.nuestra).cloned())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())?;
            Some((p, valor))
        })
        .collect()
}

/// Keys presentes en el entorno de la app o en el registro de usuario.
pub fn claves() -> Vec<(&'static Proveedor, String)> {
    let registro = crate::env_keys::read_user_scope_keys();
    claves_de(|k| std::env::var(k).ok(), &registro)
}

/// Keys que recibe un turno. Con modelo explícito, solo la de su proveedor (una
/// tarea con `--auto` no necesita las demás y puede leer su entorno). Sin
/// modelo, OpenCode elige el suyo y necesita todas; el relevo, que se lanza
/// solo y con texto de la conversación en el prompt, no recibe ninguna.
pub fn claves_para(
    claves: Vec<(&'static Proveedor, String)>,
    kind: &str,
    model: Option<&str>,
) -> Vec<(&'static Proveedor, String)> {
    let Some(model) = model else {
        return if kind == "relay" { Vec::new() } else { claves };
    };
    let proveedor = model.split_once('/').map(|(p, _)| p);
    claves
        .into_iter()
        .filter(|(p, _)| Some(p.id) == proveedor)
        .collect()
}

/// Inyecta las keys en el `Command` del hijo (no en el proceso de la app).
pub fn inyectar(cmd: &mut Command, claves: &[(&'static Proveedor, String)]) {
    for (p, valor) in claves {
        cmd.env(p.suya, valor);
    }
}

/// Resuelve el binario localizado: un shim de npm (`.cmd` o sin extensión)
/// se cambia por el `opencode.exe` nativo que lanza.
pub fn resolver(found: &Path) -> Result<Program, String> {
    let ext = found
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if matches!(ext.as_deref(), Some("exe")) {
        return Ok(Program {
            exe: found.to_path_buf(),
            pre_args: Vec::new(),
        });
    }
    let dir = found
        .parent()
        .ok_or_else(|| "ruta de opencode sin directorio".to_string())?;
    let nativo = dir.join(NATIVO_NPM);
    if !nativo.is_file() {
        return Err(format!(
            "opencode está instalado como shim y no se encontró {NATIVO_NPM}: no se lanza vía cmd.exe"
        ));
    }
    Ok(Program {
        exe: nativo,
        pre_args: Vec::new(),
    })
}

pub fn opencode_program() -> Result<Program, String> {
    let found = which::which("opencode").map_err(|_| {
        "no se encontró 'opencode' en el PATH: instala OpenCode (npm i -g opencode-ai)".to_string()
    })?;
    resolver(&found)
}

/// Estado del motor: instalado y con al menos una key de proveedor. La nota
/// dice qué proveedores tienen key.
pub fn estado_con(
    located: Result<Program, String>,
    claves: &[(&'static Proveedor, String)],
    version: impl Fn(&Program) -> Option<String>,
) -> EngineStatus {
    let base = motores::status_from("opencode", located, version, Some("opencode"));
    if !base.available {
        return base;
    }
    if claves.is_empty() {
        let vars: Vec<&str> = PROVEEDORES.iter().map(|p| p.nuestra).collect();
        return EngineStatus {
            available: false,
            reason: Some(format!(
                "OpenCode está instalado, pero no hay key de ningún proveedor ({})",
                vars.join(", ")
            )),
            ..base
        };
    }
    let con_key: Vec<&str> = claves.iter().map(|(p, _)| p.label).collect();
    EngineStatus {
        note: Some(format!("Proveedores con key: {}", con_key.join(", "))),
        ..base
    }
}

/// Estado real de OpenCode (lo usa `motores::detect_now`).
pub fn estado(version: impl Fn(&Program) -> Option<String>) -> EngineStatus {
    estado_con(opencode_program(), &claves(), version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn registro(pares: &[(&str, &str)]) -> HashMap<String, String> {
        pares
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn las_keys_salen_del_entorno_o_del_registro_con_el_nombre_de_opencode() {
        let reg = registro(&[("NVIDIA_NIM_API_KEY", "nv"), ("GEMINI_API_KEY", "  ")]);
        let entorno = |k: &str| (k == "GROQ_API_KEY").then(|| "gq".to_string());
        let c = claves_de(entorno, &reg);
        let suyas: Vec<(&str, &str)> = c.iter().map(|(p, v)| (p.suya, v.as_str())).collect();
        assert_eq!(
            suyas,
            vec![("GROQ_API_KEY", "gq"), ("NVIDIA_API_KEY", "nv")]
        );
    }

    #[test]
    fn inyectar_solo_toca_el_comando_del_hijo() {
        let reg = registro(&[("GEMINI_API_KEY", "g")]);
        let c = claves_de(|_| None, &reg);
        let mut cmd = Command::new("opencode");
        inyectar(&mut cmd, &c);
        let envs: Vec<_> = cmd.get_envs().collect();
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].0, "GOOGLE_GENERATIVE_AI_API_KEY");
        assert_ne!(
            std::env::var("GOOGLE_GENERATIVE_AI_API_KEY")
                .ok()
                .as_deref(),
            Some("g"),
            "el proceso de la app no recibe la key"
        );
    }

    #[test]
    fn un_shim_sin_binario_nativo_se_rechaza_y_un_exe_se_usa_tal_cual() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shim = dir.path().join("opencode.cmd");
        std::fs::write(&shim, "@echo off").expect("shim");
        let err = resolver(&shim).expect_err("sin nativo");
        assert!(err.contains("cmd.exe"), "{err}");
        let nativo = dir.path().join(NATIVO_NPM);
        std::fs::create_dir_all(nativo.parent().expect("padre")).expect("dir");
        std::fs::write(&nativo, "").expect("exe");
        assert_eq!(resolver(&shim).expect("nativo").exe, nativo);
        let exe = PathBuf::from("C:/x/opencode.exe");
        assert_eq!(resolver(&exe).expect("exe").exe, exe);
    }

    fn prog() -> Result<Program, String> {
        Ok(Program {
            exe: PathBuf::from("opencode.exe"),
            pre_args: Vec::new(),
        })
    }

    #[test]
    fn sin_ninguna_key_no_esta_disponible_y_dice_que_variables_faltan() {
        let s = estado_con(prog(), &[], |_| Some("1.19.4".into()));
        assert!(!s.available);
        let r = s.reason.unwrap_or_default();
        assert!(
            r.contains("DEEPSEEK_API_KEY") && r.contains("NVIDIA_NIM_API_KEY"),
            "{r}"
        );
    }

    #[test]
    fn con_keys_la_nota_lista_los_proveedores() {
        let c = claves_de(
            |k| (k == "DEEPSEEK_API_KEY").then(|| "d".into()),
            &HashMap::new(),
        );
        let s = estado_con(prog(), &c, |_| Some("1.19.4".into()));
        assert!(s.available);
        assert_eq!(s.version.as_deref(), Some("opencode 1.19.4"));
        assert_eq!(s.note.as_deref(), Some("Proveedores con key: DeepSeek"));
    }

    #[test]
    fn sin_binario_manda_el_motivo_de_la_localizacion() {
        let s = estado_con(Err("no se encontró 'opencode'".into()), &[], |_| None);
        assert!(!s.available);
        assert_eq!(s.reason.as_deref(), Some("no se encontró 'opencode'"));
    }
}
