// mar.ia — las llamadas internas a un modelo, por la misma via que el chat.
//
// Titular una conversacion, resumir una sesion, ponerle nombre a un hook,
// extraer recuerdos de un transcript: trabajo pequeño que la aplicacion (y el
// sidecar de memoria que lanzan los hooks) le pide a un modelo sin que el
// usuario lo vea.
//
// Hasta el 2026-09-21 eso lo hacia un sistema aparte, el "AI Router": 4.700
// lineas con su catalogo de proveedores, nueve zonas, claves de API, metricas y
// reintentos. Medido en esta instalacion antes de retirarlo:
//
//   * ninguna clave de API configurada -> dos de sus cuatro proveedores (gemini
//     y claude por API) no podian contestar nunca;
//   * 4 llamadas ese dia, 0 con exito, 41 % de "fallback";
//   * la interfaz solo usaba 1 de sus comandos.
//
// Y ya existia otra maquinaria que SI funciona con lo que el usuario tiene
// (suscripciones por CLI y un modelo local): el relevo. Esto es el relevo para
// las llamadas internas — mismo orden de proveedores, mismo enfriamiento por
// cuota, mismas CLI — con tres diferencias que no se negocian:
//
//   1. NUNCA con acceso total. Un resumen no necesita escribir en el disco.
//   2. El modelo local va el primero: es trabajo de relleno y es gratis.
//   3. A Claude se le pide su modelo barato: gastar Opus en un titulo es tirar
//      la cuota que luego falta en el chat.
//
// `route(zona, prompt)` conserva la firma del AI Router para que los seis
// sitios que lo llamaban no cambien mas que la ruta del modulo.

use std::time::Duration;

use super::cli::{self, Ajustes, Peticion, Sesion};
use super::relay::{self, Adjuntos};

/// Lo que puede tardar el modelo local en una llamada interna.
const TIMEOUT_LOCAL: Duration = Duration::from_secs(120);
/// Modelo de Claude para trabajo de relleno.
const CLAUDE_BARATO: &str = "haiku";

/// Zonas del AI Router que pedian un modelo serio (revision e instalacion de
/// codigo). El resto es trabajo ligero.
#[must_use]
pub fn es_zona_de_codigo(zona: &str) -> bool {
    zona.starts_with("code-")
}

/// Orden en el que se intenta una llamada interna. Pura.
///
/// Ligero: el local primero y luego el relevo tal cual. Codigo: el relevo tal
/// cual (que ya deja al local el ultimo). Los apagados no entran y quien esta
/// enfriando por cuota pasa al final.
#[must_use]
pub fn orden_para(
    zona: &str,
    relevo: &[String],
    apagados: &[String],
    frios: &[String],
) -> Vec<String> {
    let mut orden: Vec<String> = Vec::new();
    if !es_zona_de_codigo(zona) && relevo.iter().any(|p| p == "local") {
        orden.push("local".into());
    }
    for p in relevo {
        if !orden.contains(p) {
            orden.push(p.clone());
        }
    }
    orden.retain(|p| !apagados.contains(p));
    super::enrutado::ordenar_por_disponibilidad(&orden, frios)
}

fn preguntar_al_local(prompt: &str) -> Result<String, String> {
    // Fuera de mar.ia (el sidecar lo lanzan los hooks de cualquier sesion)
    // nadie ha levantado el servidor: era el fallo de las cuatro llamadas del
    // dia, "Ollama is not running".
    if crate::ollama::toggle::is_installed() {
        let _ = crate::ollama::toggle::ensure_server_running();
    }
    let body = serde_json::json!({
        "model": crate::ollama::toggle::model_name(),
        "stream": false,
        "think": false,
        // Llamada suelta: nadie gana nada con que el modelo se quede en VRAM.
        "keep_alive": 0,
        "messages": [{ "role": "user", "content": prompt }],
        "options": { "num_ctx": 8192 },
    });
    let client = reqwest::blocking::Client::builder()
        .timeout(TIMEOUT_LOCAL)
        .build()
        .map_err(|e| format!("cliente http: {e}"))?;
    let v: serde_json::Value = client
        .post("http://127.0.0.1:11434/api/chat")
        .json(&body)
        .send()
        .map_err(|e| format!("ollama no responde: {e}"))?
        .json()
        .map_err(|e| format!("respuesta de ollama ilegible: {e}"))?;
    if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
        return Err(format!("ollama: {}", relay::recorta(e, 200)));
    }
    let texto = v
        .pointer("/message/content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if texto.is_empty() {
        return Err("el modelo local devolvio una respuesta vacia".into());
    }
    Ok(texto)
}

/// Pide `prompt` a quien pueda contestarlo. Devuelve el texto, o por que nadie
/// pudo.
pub fn route(zona: &str, prompt: &str) -> Result<String, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("llamada interna sin texto".into());
    }
    let cfg = relay::load_config();
    let estado = relay::load_state();
    let ahora = chrono::Utc::now();
    let frios: Vec<String> = cfg
        .order
        .iter()
        .filter(|p| p.as_str() != "local")
        .filter(|p| {
            estado
                .get(p.as_str())
                .is_some_and(|e| super::enrutado::enfriando(&e.cooldown_until, ahora))
        })
        .cloned()
        .collect();

    let ajustes = Ajustes {
        ligero: true,
        acceso_total: false,
        mcp_config: None,
    };
    let sin_adjuntos = Adjuntos::default();
    let clave = format!("interno#{zona}");
    let mut motivos: Vec<String> = Vec::new();

    for provider in orden_para(zona, &cfg.order, &cfg.disabled, &frios) {
        let r = if provider == "local" {
            preguntar_al_local(prompt)
        } else {
            let modelo = if provider == "claude" {
                CLAUDE_BARATO.to_string()
            } else {
                crate::maria::models::modelo_por_defecto(&provider)
            };
            cli::ejecutar(&Peticion {
                clave: &clave,
                provider: &provider,
                prompt,
                model: &modelo,
                effort: "bajo",
                ajustes: &ajustes,
                adjuntos: &sin_adjuntos,
                sesion: Sesion::Ninguna,
                cwd: None,
            })
            .map(|r| r.texto)
            .map_err(|(motivo, cuota)| {
                if cuota {
                    relay::enfriar_proveedor(&provider, &motivo);
                }
                motivo
            })
        };
        match r {
            Ok(texto) => {
                tracing::debug!(zona, proveedor = %provider, "llamada interna contestada");
                return Ok(texto);
            }
            Err(motivo) => motivos.push(format!("{provider}: {motivo}")),
        }
    }
    Err(format!(
        "ningun proveedor pudo con la llamada interna ({zona}): {}",
        motivos.join(" · ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn lo_ligero_empieza_por_el_local_y_el_codigo_no() {
        let relevo = v(&["claude", "codex", "antigravity", "local"]);
        assert_eq!(
            orden_para("summarize", &relevo, &[], &[]),
            v(&["local", "claude", "codex", "antigravity"])
        );
        assert_eq!(orden_para("code-review", &relevo, &[], &[]), relevo);
    }

    #[test]
    fn los_apagados_no_entran_y_los_frios_van_al_final() {
        let relevo = v(&["claude", "codex", "local"]);
        assert_eq!(
            orden_para("utility", &relevo, &v(&["codex"]), &v(&["claude"])),
            v(&["local", "claude"])
        );
        // Sin local en el relevo no se inventa uno.
        assert_eq!(
            orden_para("light", &v(&["claude"]), &[], &[]),
            v(&["claude"])
        );
    }

    #[test]
    fn una_llamada_vacia_no_molesta_a_nadie() {
        assert!(route("summarize", "   ").is_err());
    }

    /// Prueba REAL (carga el modelo local o gasta una peticion minima).
    /// `cargo test -- --ignored interna_real --nocapture`.
    #[test]
    #[ignore = "toca proveedores reales"]
    fn interna_real_contesta_lo_ligero_y_lo_de_codigo() {
        for zona in ["summarize", "code-review"] {
            let t = std::time::Instant::now();
            let r = route(zona, "Responde solo con la palabra: listo");
            println!(
                "[{zona}] {} ms -> {:?}",
                t.elapsed().as_millis(),
                r.as_ref().map(|x| x.chars().take(30).collect::<String>())
            );
            assert!(r.is_ok(), "{zona}: {r:?}");
        }
    }
}
