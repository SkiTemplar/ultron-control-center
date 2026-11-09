// mcps/confianza.rs — qué servidores MCP puede lanzar el «Test» y el chequeo
// de salud.
//
// 2026-10-17 (seguridad): el chequeo de salud lanzaba cualquier servidor de un
// `.mcp.json` de proyecto aunque el usuario no lo hubiera aprobado en Claude
// Code; un repositorio clonado y registrado en ULTRON podía ejecutar comandos
// al pulsar «Run health check» o «Test». Ahora:
//
// - Un servidor de `.mcp.json` solo se prueba si está aprobado como lo
//   aprueba Claude Code: nombre en `enabledMcpjsonServers` o
//   `enableAllProjectMcpServers: true`, y nunca si está en
//   `disabledMcpjsonServers` (gana la denegación).
// - Las aprobaciones solo se leen de ficheros que escribe el usuario:
//   `~/.claude/settings.json` (global) y `~/.claude.json` →
//   `projects.<ruta>` (por proyecto). Los `.claude/settings*.json` del propio
//   repositorio no cuentan: los controla quien publica el repositorio.
// - Aun aprobado, un servidor de proyecto no expande `${VAR}` (podría sacar
//   secretos del entorno hacia una URL o un comando) y pasa la allowlist de
//   lanzadores de `mutations_gen`.
//
// Los servidores de `~/.claude.json` (ámbito de usuario y ámbito local por
// proyecto), los del `settings.json` legado y los de plugins instalados y
// habilitados se consideran escritos por el usuario y mantienen el
// comportamiento anterior.

use std::collections::HashMap;
use std::path::Path;

use super::discovery::McpSource;
use super::mutations_gen::validate_mcp_config_with;
use super::ping::{plan_de_ping, PlanPing};
use super::types_io::{McpServerCfg, SettingsRoot};

/// Cómo se trata un servidor antes de lanzarlo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Confianza {
    /// Configuración escrita por el usuario: se prueba tal cual.
    Usuario,
    /// `.mcp.json` aprobado: se prueba sin expandir variables y con allowlist.
    ProyectoAprobado,
    /// `.mcp.json` sin aprobar: no se ejecuta nada.
    ProyectoSinAprobar,
}

/// Una lista de aprobación de Claude Code (global o de un proyecto).
#[derive(Debug, Default, Clone)]
struct ListaAprobacion {
    todos: bool,
    habilitados: Vec<String>,
    deshabilitados: Vec<String>,
}

impl ListaAprobacion {
    fn desde_valor(v: &serde_json::Value) -> Self {
        let nombres = |clave: &str| -> Vec<String> {
            v.get(clave)
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|n| n.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        };
        Self {
            todos: v
                .get("enableAllProjectMcpServers")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            habilitados: nombres("enabledMcpjsonServers"),
            deshabilitados: nombres("disabledMcpjsonServers"),
        }
    }
}

/// Aprobaciones de servidores de `.mcp.json`, globales y por proyecto.
#[derive(Debug, Default, Clone)]
pub(super) struct Aprobaciones {
    global: ListaAprobacion,
    por_proyecto: HashMap<String, ListaAprobacion>,
}

/// Clave de ruta comparable: `~/.claude.json` guarda `C:/Users/...` con barras
/// normales; el registro de proyectos puede traer barras invertidas.
fn clave_ruta(p: &str) -> String {
    let unificada = p.replace('\\', "/");
    let sin_barra = unificada.trim_end_matches('/');
    if cfg!(windows) {
        sin_barra.to_lowercase()
    } else {
        sin_barra.to_string()
    }
}

impl Aprobaciones {
    /// Núcleo puro: `settings` (`~/.claude/settings.json`) y el valor ya
    /// parseado de `~/.claude.json`, si existe.
    pub(super) fn desde(settings: &SettingsRoot, claude_json: Option<&serde_json::Value>) -> Self {
        let global = ListaAprobacion {
            todos: settings.enable_all_project_mcp_servers,
            habilitados: settings.enabled_mcpjson_servers.clone(),
            deshabilitados: settings.disabled_mcpjson_servers.clone(),
        };
        let por_proyecto = claude_json
            .and_then(|v| v.get("projects"))
            .and_then(|v| v.as_object())
            .map(|proyectos| {
                proyectos
                    .iter()
                    .map(|(ruta, v)| (clave_ruta(ruta), ListaAprobacion::desde_valor(v)))
                    .collect()
            })
            .unwrap_or_default();
        Self {
            global,
            por_proyecto,
        }
    }

    /// Lee `~/.claude.json` (ausente o ilegible = sin aprobaciones por
    /// proyecto, nunca aprobación implícita).
    pub(super) fn cargar(settings: &SettingsRoot) -> Self {
        let claude_json = dirs::home_dir()
            .and_then(|h| std::fs::read_to_string(h.join(".claude.json")).ok())
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
        Self::desde(settings, claude_json.as_ref())
    }

    /// ¿Claude Code arrancaría `name` del `.mcp.json` de `proyecto`?
    pub(super) fn aprobado(&self, proyecto: Option<&Path>, name: &str) -> bool {
        let local = proyecto.and_then(|p| self.por_proyecto.get(&clave_ruta(&p.to_string_lossy())));
        let listas: Vec<&ListaAprobacion> = std::iter::once(&self.global).chain(local).collect();
        if listas
            .iter()
            .any(|l| l.deshabilitados.iter().any(|d| d == name))
        {
            return false;
        }
        listas
            .iter()
            .any(|l| l.todos || l.habilitados.iter().any(|h| h == name))
    }

    pub(super) fn confianza(&self, src: &McpSource) -> Confianza {
        if !src.requiere_aprobacion {
            return Confianza::Usuario;
        }
        if self.aprobado(src.cwd.as_deref(), &src.name) {
            Confianza::ProyectoAprobado
        } else {
            Confianza::ProyectoSinAprobar
        }
    }
}

/// Restricciones de un servidor de proyecto aprobado antes de contactarlo:
/// ninguna `${VAR}` en comando, argumentos, `env`, URL ni cabeceras, y
/// comando/URL dentro de la validación de `validate_mcp_config_with`.
pub(super) fn validar_servidor_de_proyecto(cfg: &McpServerCfg) -> Result<(), String> {
    let con_variable = |s: &str| s.contains("${");
    let valores = |m: &std::collections::BTreeMap<String, serde_json::Value>| {
        m.values().any(|v| {
            v.as_str()
                .map_or_else(|| con_variable(&v.to_string()), con_variable)
        })
    };
    let usa_variables = cfg.command.as_deref().is_some_and(con_variable)
        || cfg.url.as_deref().is_some_and(con_variable)
        || cfg.args.iter().any(|a| con_variable(a))
        || valores(&cfg.env)
        || valores(&cfg.headers);
    if usa_variables {
        return Err(
            "servidor de proyecto: no se expanden variables ${VAR} (url, cabeceras, argumentos \
             ni env); no se ejecuta"
                .to_string(),
        );
    }
    let config = match plan_de_ping(cfg) {
        PlanPing::Lanzar(command, args) => serde_json::json!({ "command": command, "args": args }),
        PlanPing::Http => serde_json::json!({ "url": cfg.url.clone().unwrap_or_default() }),
        PlanPing::Deshabilitado | PlanPing::SinComando => return Ok(()),
    };
    validate_mcp_config_with(&config, None)
        .map_err(|e| format!("servidor de proyecto fuera de la allowlist: {e}; no se ejecuta"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const PROYECTO: &str = r"C:\Repos\clonado";

    fn settings(v: serde_json::Value) -> SettingsRoot {
        serde_json::from_value(v).expect("settings")
    }

    fn fuente_mcp_json(name: &str, cfg: serde_json::Value) -> McpSource {
        McpSource {
            origin: "project:clonado".to_string(),
            plugin: Some("clonado".to_string()),
            name: name.to_string(),
            cfg: serde_json::from_value(cfg).expect("cfg"),
            cwd: Some(PathBuf::from(PROYECTO)),
            requiere_aprobacion: true,
        }
    }

    #[test]
    fn mcp_json_sin_aprobar_no_se_ejecuta() {
        let aprob = Aprobaciones::desde(&settings(serde_json::json!({})), None);
        let src = fuente_mcp_json("malo", serde_json::json!({"command": "node"}));
        assert_eq!(aprob.confianza(&src), Confianza::ProyectoSinAprobar);
    }

    #[test]
    fn mcp_json_aprobado_global_o_por_proyecto() {
        let src = fuente_mcp_json("bueno", serde_json::json!({"command": "node"}));
        let global = Aprobaciones::desde(
            &settings(serde_json::json!({"enabledMcpjsonServers": ["bueno"]})),
            None,
        );
        assert_eq!(global.confianza(&src), Confianza::ProyectoAprobado);

        // `~/.claude.json` guarda la ruta con barras normales.
        let claude_json = serde_json::json!({
            "projects": {"C:/Repos/clonado": {"enabledMcpjsonServers": ["bueno"]}}
        });
        let local = Aprobaciones::desde(&settings(serde_json::json!({})), Some(&claude_json));
        assert_eq!(local.confianza(&src), Confianza::ProyectoAprobado);

        // Caso negativo: aprobado en OTRO proyecto no sirve.
        let otro = serde_json::json!({
            "projects": {"C:/Repos/otro": {"enableAllProjectMcpServers": true}}
        });
        let ajeno = Aprobaciones::desde(&settings(serde_json::json!({})), Some(&otro));
        assert_eq!(ajeno.confianza(&src), Confianza::ProyectoSinAprobar);
    }

    #[test]
    fn deshabilitado_gana_a_enable_all() {
        let src = fuente_mcp_json("x", serde_json::json!({"command": "node"}));
        let aprob = Aprobaciones::desde(
            &settings(serde_json::json!({
                "enableAllProjectMcpServers": true,
                "disabledMcpjsonServers": ["x"]
            })),
            None,
        );
        assert_eq!(aprob.confianza(&src), Confianza::ProyectoSinAprobar);
    }

    #[test]
    fn fuentes_de_usuario_no_piden_aprobacion() {
        let mut src = fuente_mcp_json("u", serde_json::json!({"command": "codegraph"}));
        src.requiere_aprobacion = false;
        let aprob = Aprobaciones::desde(&settings(serde_json::json!({})), None);
        assert_eq!(aprob.confianza(&src), Confianza::Usuario);
    }

    #[test]
    fn proyecto_aprobado_no_expande_variables_y_pasa_allowlist() {
        let cfg = |v: serde_json::Value| -> McpServerCfg { serde_json::from_value(v).unwrap() };
        assert!(validar_servidor_de_proyecto(&cfg(serde_json::json!({
            "command": "npx", "args": ["-y", "@scope/server"]
        })))
        .is_ok());
        // Casos negativos: variables en cualquier campo y lanzadores fuera
        // de la allowlist.
        for malo in [
            serde_json::json!({"command": "npx", "args": ["${HOME}"]}),
            serde_json::json!({"command": "npx", "env": {"T": "${GITHUB_TOKEN}"}}),
            serde_json::json!({"url": "https://x.example/${SECRET}"}),
            serde_json::json!({"url": "https://x.example", "headers": {"A": "Bearer ${T}"}}),
            serde_json::json!({"command": "powershell", "args": ["-c", "calc"]}),
            serde_json::json!({"command": r"C:\tmp\evil.exe"}),
            serde_json::json!({"command": "cmd", "args": ["/c", "npx", "&", "calc"]}),
        ] {
            assert!(
                validar_servidor_de_proyecto(&cfg(malo.clone())).is_err(),
                "{malo}"
            );
        }
    }
}
