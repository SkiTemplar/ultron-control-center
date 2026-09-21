// mar.ia — que los cuatro proveedores compartan lo que saben usar.
//
// Las skills y los MCP viven en el mundo de Claude Code (`~/.claude/skills`,
// `mcpServers` de `~/.claude.json`). Codex, Antigravity y el modelo local no los
// ven. Pedido del usuario (2026-09-21): "que todos los agentes tengan todas las
// skills, mcp y demas... molaria si pudieras hacer que compartieran esos mcps y
// skills". Se comparte por el camino que cada cosa admite:
//
//   * MCP -> con el gestor PROPIO de cada CLI (`codex mcp add`, `agy mcp add`).
//     No se escribe su configuracion a mano: cada una sabe su formato. Solo se
//     pueden compartir los servidores locales (`command`); los conectores de
//     claude.ai llevan el inicio de sesion de Claude y no se pueden clonar.
//   * Skills -> una skill es un SKILL.md con instrucciones. A quien no las
//     carga de forma nativa se le da el INDICE de las que casan con la peticion
//     (nombre, para que sirve y ruta): con acceso a ficheros, la abre y la sigue.
//   * El manual -> cuatro lineas que cuentan a cualquier agente donde esta la
//     carpeta de trabajo comun y como encender o apagar skills y MCP el mismo.
//
// LIMITE DECLARADO: el indice de skills es texto en el mensaje, no una carga
// nativa. Un modelo puede ignorarlo; Claude, que las carga de verdad, no lo
// recibe.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

/// Maximo de skills que se ofrecen en un mensaje: es contexto que se paga.
const MAX_SKILLS_EN_MENSAJE: usize = 6;
/// Cada cuanto se vuelve a leer el disco en busca de skills.
const VIGENCIA_INDICE: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Skill {
    pub nombre: String,
    pub para: String,
    pub ruta: String,
    /// Esta en `_disabled/`: Claude Code no la carga hasta que se mueva.
    pub apagada: bool,
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// `name:` y `description:` del frontmatter de un SKILL.md. Pura.
#[must_use]
pub fn leer_frontmatter(texto: &str) -> (String, String) {
    let mut nombre = String::new();
    let mut para = String::new();
    let mut dentro = false;
    for linea in texto.lines().take(40) {
        let l = linea.trim();
        if l == "---" {
            if dentro {
                break;
            }
            dentro = true;
            continue;
        }
        if !dentro {
            continue;
        }
        if let Some(v) = l.strip_prefix("name:") {
            nombre = v.trim().trim_matches(['"', '\'']).to_string();
        } else if let Some(v) = l.strip_prefix("description:") {
            para = v.trim().trim_matches(['"', '\'']).to_string();
        }
    }
    (nombre, para)
}

fn leer_carpeta(dir: &Path, apagada: bool, out: &mut Vec<Skill>) {
    let Ok(entradas) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entradas.flatten() {
        let ruta = e.path().join("SKILL.md");
        let Ok(texto) = std::fs::read_to_string(&ruta) else {
            continue;
        };
        let (nombre, para) = leer_frontmatter(&texto);
        let nombre = if nombre.is_empty() {
            e.file_name().to_string_lossy().into_owned()
        } else {
            nombre
        };
        out.push(Skill {
            nombre,
            para,
            ruta: ruta.to_string_lossy().into_owned(),
            apagada,
        });
    }
}

/// Todas las skills del disco, encendidas y apagadas. Con cache de 5 minutos:
/// son cientos de ficheros y esto corre en cada mensaje.
#[must_use]
pub fn skills() -> Vec<Skill> {
    static CACHE: Mutex<Option<(Instant, Vec<Skill>)>> = Mutex::new(None);
    if let Ok(g) = CACHE.lock() {
        if let Some((cuando, lista)) = g.as_ref() {
            if cuando.elapsed() < VIGENCIA_INDICE {
                return lista.clone();
            }
        }
    }
    let mut out = Vec::new();
    if let Some(base) = home().map(|h| h.join(".claude").join("skills")) {
        leer_carpeta(&base, false, &mut out);
        leer_carpeta(&base.join("_disabled"), true, &mut out);
    }
    out.sort_by(|a, b| a.nombre.cmp(&b.nombre));
    if let Ok(mut g) = CACHE.lock() {
        *g = Some((Instant::now(), out.clone()));
    }
    out
}

/// Las skills que casan con la peticion, de mas a menos coincidencia. Pura.
#[must_use]
pub fn skills_para<'a>(prompt: &str, todas: &'a [Skill]) -> Vec<&'a Skill> {
    let norm = super::enrutado::normaliza(prompt);
    let palabras: Vec<&str> = norm
        .split(|c: char| !c.is_alphanumeric())
        .filter(|p| p.chars().count() >= 4)
        .collect();
    if palabras.is_empty() {
        return Vec::new();
    }
    let mut puntuadas: Vec<(usize, &Skill)> = todas
        .iter()
        .filter_map(|s| {
            let texto = super::enrutado::normaliza(&format!("{} {}", s.nombre, s.para));
            let n = palabras.iter().filter(|p| texto.contains(**p)).count();
            (n > 0).then_some((n, s))
        })
        .collect();
    puntuadas.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.nombre.cmp(&b.1.nombre)));
    puntuadas
        .into_iter()
        .take(MAX_SKILLS_EN_MENSAJE)
        .map(|(_, s)| s)
        .collect()
}

/// Bloque de texto con las skills utiles para esta peticion, o vacio.
#[must_use]
pub fn indice_skills(prompt: &str) -> String {
    let todas = skills();
    let utiles = skills_para(prompt, &todas);
    if utiles.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "[skills disponibles — si alguna encaja, abre su SKILL.md y sigue lo que dice]\n",
    );
    for s in utiles {
        out.push_str(&format!("- {}: {} ({})\n", s.nombre, s.para, s.ruta));
    }
    out.push('\n');
    out
}

/// Como pide un agente que otro haga parte del trabajo (`relay::encargos_en`).
#[must_use]
pub fn manual_reparto(proveedores: &[String]) -> String {
    format!(
        "- Puedes repartir trabajo: si una parte la puede hacer otro agente EN PARALELO, escribe al \
         final una linea por encargo, exactamente asi: `@delegar <proveedor>: <encargo completo>`. \
         Proveedores: {}. Hazlo solo cuando de verdad ahorre tiempo; lo demas, hazlo tu.\n",
        proveedores.join(", ")
    )
}

/// Lo que cualquier agente necesita saber del entorno que comparte con los
/// demas. Corto a proposito: viaja en el primer mensaje de cada sesion.
#[must_use]
pub fn manual(carpeta_de_trabajo: Option<&Path>, acceso_total: bool) -> String {
    let mut out = String::from("[entorno mar.ia]\n");
    if let Some(dir) = carpeta_de_trabajo {
        out.push_str(&format!(
            "- Carpeta de trabajo compartida con los demas agentes: {}. Deja ahi lo que produzcas; \
             TABLERO.md dice quien esta haciendo que.\n",
            dir.display()
        ));
    }
    if acceso_total {
        out.push_str(
            "- Tienes acceso completo a este equipo (ficheros y terminal). Usalo con criterio: \
             no borres ni sobrescribas nada sin que te lo pidan.\n",
        );
    }
    if let Some(h) = home() {
        let skills = h.join(".claude").join("skills");
        out.push_str(&format!(
            "- Skills: {0}. Una skill apagada esta en {0}{1}_disabled; se enciende moviendo su \
             carpeta un nivel arriba y se apaga devolviendola.\n",
            skills.display(),
            std::path::MAIN_SEPARATOR
        ));
    }
    out.push_str(
        "- MCP: `claude mcp list|add|remove`, `codex mcp list|add|remove`, `agy mcp list|add|remove|enable|disable`.\n\
         - Memoria del usuario: `ultron-memory recall \"<consulta>\"` (en ~/.maria/bin).\n\n",
    );
    out
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct McpLocal {
    pub nombre: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

/// Servidores MCP locales (`command`) de un `~/.claude.json` ya leido. Pura.
#[must_use]
pub fn mcps_locales(claude_json: &serde_json::Value) -> Vec<McpLocal> {
    let Some(m) = claude_json.get("mcpServers").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    m.iter()
        .filter_map(|(nombre, v)| {
            let command = v.get("command")?.as_str()?.to_string();
            let args = v
                .get("args")
                .and_then(|a| a.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let env = v
                .get("env")
                .and_then(|e| e.as_object())
                .map(|e| {
                    e.iter()
                        .filter_map(|(k, x)| x.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
                .unwrap_or_default();
            Some(McpLocal {
                nombre: nombre.clone(),
                command,
                args,
                env,
            })
        })
        .collect()
}

fn leer_claude_json() -> serde_json::Value {
    home()
        .map(|h| h.join(".claude.json"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// Fichero `--mcp-config` con SOLO los MCP elegidos para el chat, o None si no
/// hay ninguno elegido (entonces el modo ligero va sin MCP).
#[must_use]
pub fn fichero_mcp_chat(elegidos: &[String]) -> Option<PathBuf> {
    if elegidos.is_empty() {
        return None;
    }
    let json = leer_claude_json();
    let todos = json.get("mcpServers")?.as_object()?;
    let mut sel = serde_json::Map::new();
    for n in elegidos {
        if let Some(v) = todos.get(n) {
            sel.insert(n.clone(), v.clone());
        }
    }
    if sel.is_empty() {
        return None;
    }
    let ruta = crate::maria::paths::cockpit("maria")
        .ok()?
        .join("claude-mcp-chat.json");
    let cuerpo = serde_json::json!({ "mcpServers": sel });
    std::fs::write(&ruta, serde_json::to_string_pretty(&cuerpo).ok()?).ok()?;
    Some(ruta)
}

#[derive(Debug, Clone, Serialize)]
pub struct ResultadoCompartir {
    pub mcp: String,
    pub destino: String,
    pub ok: bool,
    pub detalle: String,
}

/// Da de alta en Codex y Antigravity los MCP locales de Claude, con el gestor de
/// cada una. Idempotente: `add` actualiza si ya existia.
pub fn compartir_mcps() -> Vec<ResultadoCompartir> {
    let locales = mcps_locales(&leer_claude_json());
    let mut out = Vec::new();
    for m in &locales {
        for (destino, bin) in [("codex", "codex"), ("antigravity", "agy")] {
            let Some(ruta) = super::relay::ruta_de_cli(bin) else {
                out.push(ResultadoCompartir {
                    mcp: m.nombre.clone(),
                    destino: destino.into(),
                    ok: false,
                    detalle: format!("{bin} no esta instalada"),
                });
                continue;
            };
            let mut cmd = if super::relay::necesita_cmd(&ruta) {
                let mut c = crate::proc::oculto("cmd");
                c.arg("/C").arg(&ruta);
                c
            } else {
                crate::proc::oculto(&ruta)
            };
            cmd.args(["mcp", "add"]);
            for (k, v) in &m.env {
                cmd.arg("--env").arg(format!("{k}={v}"));
            }
            cmd.arg(&m.nombre);
            if destino == "codex" {
                cmd.arg("--");
            }
            cmd.arg(&m.command).args(&m.args);
            let (ok, detalle) = match cmd.output() {
                Ok(o) if o.status.success() => (true, "compartido".to_string()),
                Ok(o) => (
                    false,
                    super::relay::recorta(String::from_utf8_lossy(&o.stderr).trim(), 200),
                ),
                Err(e) => (false, format!("no pude lanzar {bin}: {e}")),
            };
            out.push(ResultadoCompartir {
                mcp: m.nombre.clone(),
                destino: destino.into(),
                ok,
                detalle,
            });
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct Capacidades {
    pub skills_encendidas: usize,
    pub skills_apagadas: usize,
    /// MCP locales de Claude: los que se pueden elegir para el chat y compartir.
    pub mcps: Vec<McpLocal>,
}

#[tauri::command]
pub async fn maria_capacidades() -> Result<Capacidades, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let s = skills();
        Capacidades {
            skills_encendidas: s.iter().filter(|x| !x.apagada).count(),
            skills_apagadas: s.iter().filter(|x| x.apagada).count(),
            mcps: mcps_locales(&leer_claude_json())
                .into_iter()
                // Los valores de `env` suelen ser tokens: a la pantalla van los nombres.
                .map(|mut m| {
                    for v in m.env.values_mut() {
                        *v = "•••".into();
                    }
                    m
                })
                .collect(),
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))
}

#[tauri::command]
pub async fn maria_compartir_mcps() -> Result<Vec<ResultadoCompartir>, String> {
    tauri::async_runtime::spawn_blocking(compartir_mcps)
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(nombre: &str, para: &str) -> Skill {
        Skill {
            nombre: nombre.into(),
            para: para.into(),
            ruta: format!("C:/skills/{nombre}/SKILL.md"),
            apagada: false,
        }
    }

    #[test]
    fn el_frontmatter_da_nombre_y_descripcion() {
        let t =
            "---\nname: pdf\ndescription: \"Trabajar con ficheros PDF\"\n---\n# cuerpo\nname: no\n";
        assert_eq!(
            leer_frontmatter(t),
            ("pdf".to_string(), "Trabajar con ficheros PDF".to_string())
        );
        assert_eq!(
            leer_frontmatter("sin frontmatter"),
            (String::new(), String::new())
        );
    }

    #[test]
    fn se_ofrecen_las_skills_que_casan_y_en_orden() {
        let todas = vec![
            skill("pdf", "leer, unir y rellenar ficheros pdf"),
            skill("debugger", "analisis de causa raiz de tests que fallan"),
            skill("xlsx", "hojas de calculo"),
        ];
        let r = skills_para("une estos dos ficheros pdf", &todas);
        assert_eq!(r.first().map(|s| s.nombre.as_str()), Some("pdf"));
        assert!(!r.iter().any(|s| s.nombre == "xlsx"));
        assert!(
            skills_para("hola", &todas).is_empty(),
            "palabras cortas no cuentan"
        );
    }

    #[test]
    fn nunca_se_ofrecen_mas_del_tope() {
        let todas: Vec<Skill> = (0..30)
            .map(|i| skill(&format!("s{i}"), "documentos de trabajo"))
            .collect();
        assert_eq!(
            skills_para("documentos", &todas).len(),
            MAX_SKILLS_EN_MENSAJE
        );
    }

    #[test]
    fn solo_se_comparten_los_mcp_locales() {
        let j = serde_json::json!({ "mcpServers": {
            "unity": { "command": "node", "args": ["server.js"], "env": { "K": "v" } },
            "remoto": { "type": "http", "url": "https://ejemplo.test/mcp" }
        }});
        let m = mcps_locales(&j);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].nombre, "unity");
        assert_eq!(m[0].args, vec!["server.js"]);
        assert_eq!(m[0].env.get("K").map(String::as_str), Some("v"));
        assert!(mcps_locales(&serde_json::Value::Null).is_empty());
    }

    #[test]
    fn el_manual_solo_promete_lo_que_hay() {
        let sin = manual(None, false);
        assert!(!sin.contains("acceso completo"));
        assert!(!sin.contains("TABLERO"));
        let con = manual(Some(Path::new("C:/trabajo")), true);
        assert!(con.contains("acceso completo") && con.contains("TABLERO.md"));
    }
}
