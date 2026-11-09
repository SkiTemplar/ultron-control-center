// sesiones/opencode_modelos.rs — Modelos que se ofrecen para OpenCode.
//
// Solo de los proveedores con key (`opencode_entorno::claves`): por cada uno,
// `opencode models <proveedor>` (una línea `proveedor/modelo`), con las keys
// inyectadas, en paralelo y con el tope de 10 s de `modelos::LIST_TIMEOUT`.
// DeepSeek no se pregunta a la CLI: sus dos modelos van fijos
// (`deepseek-flash` y `deepseek-v4-pro`, comprobados en GET /models el
// 2026-10-26). Cada proveedor se cachea aparte con la misma política que
// Codex y agy: aciertos mientras dure la app, fallos 60 s.

use super::modelos::{self, EngineModel};
use super::motores;
use super::opencode_entorno::{self as entorno, Proveedor};

/// Modelos fijos de DeepSeek.
pub const DEEPSEEK_FIJOS: [(&str, &str); 2] = [
    ("deepseek/deepseek-flash", "DeepSeek V4.1 Flash"),
    ("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro"),
];
const MODEL_MAX: usize = 120;

/// Un modelo de OpenCode es `proveedor/modelo` (el modelo puede llevar más
/// `/` y `:free`). Va como argumento: nada que parezca un flag.
pub fn validate_model(model: &str) -> Result<(), String> {
    let ok = model.len() <= MODEL_MAX
        && model.split_once('/').is_some_and(|(p, m)| {
            !p.is_empty() && !m.is_empty() && !p.starts_with('-') && !m.starts_with('/')
        })
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '/'));
    if ok {
        Ok(())
    } else {
        Err(format!("modelo de OpenCode no válido: '{model}'"))
    }
}

/// Líneas `proveedor/modelo` de `opencode models <proveedor>`; el resto se
/// ignora. La etiqueta es el modelo sin el prefijo del proveedor.
pub fn parse_models(text: &str, proveedor: &str) -> Vec<EngineModel> {
    let prefijo = format!("{proveedor}/");
    text.lines()
        .map(str::trim)
        .filter(|l| l.starts_with(&prefijo) && validate_model(l).is_ok())
        .map(|l| EngineModel {
            id: l.to_string(),
            label: l[prefijo.len()..].to_string(),
            efforts: Vec::new(),
        })
        .collect()
}

fn deepseek(con_key: bool) -> Vec<EngineModel> {
    let aviso = if con_key {
        ""
    } else {
        " (sin DEEPSEEK_API_KEY)"
    };
    DEEPSEEK_FIJOS
        .iter()
        .map(|(id, label)| EngineModel {
            id: id.to_string(),
            label: format!("{label}{aviso}"),
            efforts: Vec::new(),
        })
        .collect()
}

/// Solo la key del proveedor consultado: `opencode models <p>` no necesita las
/// demás.
fn clave_de(
    p: &Proveedor,
    claves: &[(&'static Proveedor, String)],
) -> Vec<(&'static Proveedor, String)> {
    claves
        .iter()
        .filter(|(q, _)| q.id == p.id)
        .cloned()
        .collect()
}

fn fetch(
    p: &Proveedor,
    claves: &[(&'static Proveedor, String)],
) -> Result<Vec<EngineModel>, String> {
    let program = entorno::opencode_program()?;
    let cwd = std::env::temp_dir();
    // `_for_task`: sin las keys que la app cargó en su propio entorno.
    let mut cmd = motores::command_for_task(&program, &cwd.to_string_lossy());
    cmd.args(["models", p.id]);
    entorno::inyectar(&mut cmd, &clave_de(p, claves));
    let out = super::cli_info::run_cli(cmd, modelos::LIST_TIMEOUT, "opencode models")
        .map_err(|e| format!("{}: no se pudo pedir la lista: {e}", p.label))?;
    if !out.status.success() {
        return Err(format!(
            "{}: opencode no devolvió la lista: {}",
            p.label,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let models = parse_models(&String::from_utf8_lossy(&out.stdout), p.id);
    if models.is_empty() {
        return Err(format!("{}: opencode no devolvió ningún modelo", p.label));
    }
    Ok(models)
}

/// Junta DeepSeek y los proveedores consultados. Solo es error si no queda
/// ningún modelo; un proveedor caído no tumba la lista de los demás.
pub fn juntar(
    con_key_deepseek: bool,
    resultados: Vec<Result<Vec<EngineModel>, String>>,
) -> Result<Vec<EngineModel>, String> {
    let mut out = deepseek(con_key_deepseek);
    let mut errores = Vec::new();
    for r in resultados {
        match r {
            Ok(v) => out.extend(v),
            Err(e) => errores.push(e),
        }
    }
    for e in &errores {
        tracing::warn!(error = %e, "lista de modelos de OpenCode incompleta");
    }
    Ok(out)
}

/// Modelos de OpenCode de los proveedores con key, más DeepSeek.
pub fn list() -> Result<Vec<EngineModel>, String> {
    entorno::opencode_program()?;
    let claves = entorno::claves();
    let con_key_deepseek = claves.iter().any(|(p, _)| p.id == "deepseek");
    let consultar: Vec<&'static Proveedor> = claves
        .iter()
        .map(|(p, _)| *p)
        .filter(|p| p.id != "deepseek")
        .collect();
    let claves = &claves;
    let resultados = std::thread::scope(|s| {
        let hilos: Vec<_> = consultar
            .iter()
            .map(|p| {
                s.spawn(move || {
                    let clave = format!("opencode:{}", p.id);
                    modelos::list_cacheada(&clave, |_| fetch(p, claves))
                })
            })
            .collect();
        hilos
            .into_iter()
            .map(|h| {
                h.join()
                    .unwrap_or_else(|_| Err("la consulta falló (panic)".into()))
            })
            .collect()
    });
    juntar(con_key_deepseek, resultados)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acepta_proveedor_barra_modelo_y_rechaza_lo_que_parece_un_flag() {
        assert!(validate_model("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free").is_ok());
        assert!(validate_model("deepseek/deepseek-flash").is_ok());
        assert!(validate_model("deepseek-flash").is_err(), "sin proveedor");
        assert!(validate_model("--auto/x").is_err());
        assert!(validate_model("groq/ x").is_err());
        assert!(validate_model("groq//x").is_err());
        assert!(validate_model("/x").is_err());
    }

    /// Codex #5: la consulta de un proveedor no recibe las keys de los demás.
    #[test]
    fn la_consulta_de_modelos_solo_lleva_la_key_del_proveedor() {
        let todas: Vec<_> = entorno::PROVEEDORES
            .iter()
            .map(|p| (p, format!("key-{}", p.id)))
            .collect();
        let groq = entorno::PROVEEDORES
            .iter()
            .find(|p| p.id == "groq")
            .expect("groq");
        let solo = clave_de(groq, &todas);
        assert_eq!(solo.len(), 1);
        assert_eq!(solo[0].1, "key-groq");
    }

    #[test]
    fn la_lista_solo_toma_lineas_del_proveedor_pedido() {
        let text = "groq/llama-3.3-70b\nopencode/big-pickle-free\nINFO cargando\ngroq/qwen 3\n";
        let m = parse_models(text, "groq");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].id, "groq/llama-3.3-70b");
        assert_eq!(m[0].label, "llama-3.3-70b");
    }

    #[test]
    fn deepseek_va_siempre_y_avisa_si_falta_la_key() {
        let v = juntar(false, Vec::new()).expect("lista");
        assert_eq!(v.len(), 2);
        assert!(v[0].label.contains("sin DEEPSEEK_API_KEY"));
        let v = juntar(true, Vec::new()).expect("lista");
        assert!(!v[0].label.contains("sin"));
    }

    #[test]
    fn un_proveedor_caido_no_tumba_la_lista() {
        let ok = vec![EngineModel {
            id: "groq/a".into(),
            label: "a".into(),
            efforts: Vec::new(),
        }];
        let v = juntar(true, vec![Err("OpenRouter: sin red".into()), Ok(ok)]).expect("lista");
        assert_eq!(v.last().map(|m| m.id.as_str()), Some("groq/a"));
    }

    #[test]
    fn no_se_ofrecen_copilot_ni_el_gratuito_de_zen() {
        assert!(entorno::PROVEEDORES
            .iter()
            .all(|p| p.id != "github-copilot" && p.id != "opencode"));
    }
}
