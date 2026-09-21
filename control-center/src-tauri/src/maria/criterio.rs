// mar.ia — el criterio con el que decide a quien pedir cada cosa.
//
// Sustituye a las "zonas" del router viejo en todo lo que el usuario ve. El
// usuario lo pidio asi el 2026-09-19: "la parte de zonas... eso lo debe valorar
// la propia ia, o al menos simplificala, para que sean los parametros generales
// con los que la local se pueda guiar".
//
// Las zonas eran nueve filas de `primary -> fallbacks` con modelo y max_tokens
// por fila: 27 decisiones para contestar "¿quien me contesta?". Aqui hay una
// frase por tipo de tarea y un orden de preferencia. Eso es lo que se le pasa
// al modelo local cuando decide, asi que EDITARLO CAMBIA EL COMPORTAMIENTO —
// no es una pantalla decorativa.
//
// LIMITE DECLARADO (mandamiento 13): esto gobierna a quien manda mar.ia el
// chat, la voz y el movil (`maria_relay`). El `ai_router` antiguo sigue
// existiendo para las llamadas internas de la aplicacion y tiene sus propias
// zonas en `cockpit/ai-router/zones.json`; no se editan desde aqui.

use serde::{Deserialize, Serialize};

/// Una regla: para este tipo de trabajo, tira de este proveedor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Regla {
    /// Como se llama el tipo de tarea, en cristiano.
    pub tarea: String,
    /// Proveedor preferido.
    pub provider: String,
    /// Modelo preferido dentro de ese proveedor. Vacio = el de por defecto.
    #[serde(default)]
    pub model: String,
    /// "bajo" | "medio" | "alto".
    #[serde(default)]
    pub effort: String,
    /// Cuando aplica. Es literalmente lo que lee el modelo local.
    pub cuando: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Criterio {
    /// Si esta en false, no se consulta al modelo local: manda el orden de
    /// relevo y punto. Util cuando Ollama esta caido o para depurar.
    #[serde(default = "si")]
    pub decide_la_local: bool,
    pub reglas: Vec<Regla>,
    /// Una linea libre del usuario. Va tal cual al prompt de decision.
    #[serde(default)]
    pub nota: String,
    /// Claude SIN los hooks ni los MCP de Claude Code en los turnos del chat.
    /// Medido el 2026-09-21 con la misma pregunta: 12,2 s con todo, 4,3-5,0 s
    /// sin ello, misma respuesta y la cache de prompt intacta. La memoria no se
    /// pierde: el relevo ya la inyecta por su cuenta.
    #[serde(default = "si")]
    pub claude_ligero: bool,
    /// Segundos que el modelo local se queda en VRAM tras contestar. 0 = se
    /// suelta al acabar el turno (lo que pidio el usuario el 2026-09-19 y el
    /// valor por defecto). Medido el 2026-09-21: de los 4,2 s de un "hola",
    /// 3,7 s son cargar el modelo; con el modelo ya dentro son 0,4 s.
    #[serde(default)]
    pub local_residente_s: u32,
}

fn si() -> bool {
    true
}

impl Default for Criterio {
    fn default() -> Self {
        Self {
            decide_la_local: true,
            reglas: vec![
                Regla {
                    tarea: "trivial".into(),
                    provider: "local".into(),
                    model: String::new(),
                    effort: "bajo".into(),
                    cuando: "saludos, conversiones, preguntas cortas y órdenes del ordenador"
                        .into(),
                },
                Regla {
                    tarea: "buscar y ver imágenes".into(),
                    // Antigravity, no Gemini: la CLI de Gemini salio el 2026-09-20 y
                    // esta regla seguia mandando a un proveedor que ya no existe
                    // (se filtraba en silencio y la clase se quedaba sin regla).
                    provider: "antigravity".into(),
                    model: String::new(),
                    effort: "medio".into(),
                    cuando: "hace falta internet, documentos largos o mirar una imagen".into(),
                },
                Regla {
                    tarea: "scripts y automatización".into(),
                    provider: "codex".into(),
                    // Sin modelo clavado: con cuenta de ChatGPT, `-m gpt-5-codex`
                    // devuelve 400 y tumba el proveedor entero.
                    model: String::new(),
                    effort: "medio".into(),
                    cuando: "un script suelto, un comando o automatizar algo del sistema".into(),
                },
                Regla {
                    tarea: "programar en un proyecto".into(),
                    provider: "claude".into(),
                    model: "sonnet".into(),
                    effort: "medio".into(),
                    cuando: "tocar código de un repositorio con su contexto".into(),
                },
                Regla {
                    tarea: "arquitectura y textos largos".into(),
                    provider: "claude".into(),
                    model: "opus".into(),
                    effort: "alto".into(),
                    cuando: "diseño de sistemas, decisiones difíciles o escribir mucho".into(),
                },
            ],
            nota: String::new(),
            claude_ligero: true,
            local_residente_s: 0,
        }
    }
}

fn ruta() -> Result<std::path::PathBuf, String> {
    Ok(crate::maria::paths::cockpit("maria")?.join("criterio.json"))
}

#[must_use]
pub fn cargar() -> Criterio {
    ruta()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn guardar(c: &Criterio) -> Result<(), String> {
    let p = ruta()?;
    let texto = serde_json::to_string_pretty(c).map_err(|e| format!("serializar: {e}"))?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, texto).map_err(|e| format!("escribir criterio: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("renombrar criterio: {e}"))
}

/// Las reglas, en texto, tal y como las lee el modelo local al decidir.
///
/// Pura: se testea sin ficheros. Es LA razon de que esta pantalla sirva para
/// algo — lo que se escriba aqui acaba en el prompt de decision.
#[must_use]
pub fn como_prompt(c: &Criterio) -> String {
    let mut out = String::new();
    for r in &c.reglas {
        let modelo = if r.model.is_empty() {
            String::new()
        } else {
            format!(" con {}", r.model)
        };
        let esfuerzo = if r.effort.is_empty() {
            String::new()
        } else {
            format!(", esfuerzo {}", r.effort)
        };
        out.push_str(&format!(
            "- {}: usa {}{}{} ({}).\n",
            r.tarea, r.provider, modelo, esfuerzo, r.cuando
        ));
    }
    if !c.nota.trim().is_empty() {
        out.push_str(&format!("- Ademas: {}\n", c.nota.trim()));
    }
    out
}

/// Quita reglas que apunten a un proveedor que ya no existe.
///
/// Sin esto, una regla vieja mandaba a "groq" y el modelo local proponia un
/// destino imposible en cada turno. Pura.
#[must_use]
pub fn solo_proveedores_validos(c: &Criterio, validos: &[String]) -> Criterio {
    Criterio {
        decide_la_local: c.decide_la_local,
        reglas: c
            .reglas
            .iter()
            .filter(|r| validos.iter().any(|v| *v == r.provider))
            .cloned()
            .collect(),
        nota: c.nota.clone(),
        claude_ligero: c.claude_ligero,
        local_residente_s: c.local_residente_s,
    }
}

#[tauri::command]
pub async fn maria_criterio_get() -> Result<Criterio, String> {
    Ok(cargar())
}

#[tauri::command]
pub async fn maria_criterio_set(criterio: Criterio) -> Result<Criterio, String> {
    let validos: Vec<String> = crate::maria::relay::load_config().order;
    let limpio = solo_proveedores_validos(&criterio, &validos);
    guardar(&limpio)?;
    Ok(limpio)
}

/// Vuelve al criterio de fabrica.
#[tauri::command]
pub async fn maria_criterio_reset() -> Result<Criterio, String> {
    let c = Criterio::default();
    guardar(&c)?;
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn regla(tarea: &str, provider: &str) -> Regla {
        Regla {
            tarea: tarea.into(),
            provider: provider.into(),
            model: String::new(),
            effort: "medio".into(),
            cuando: "lo que sea".into(),
        }
    }

    #[test]
    fn el_criterio_de_fabrica_cubre_los_cuatro_proveedores() {
        let c = Criterio::default();
        let ps: Vec<&str> = c.reglas.iter().map(|r| r.provider.as_str()).collect();
        for esperado in ["local", "antigravity", "codex", "claude"] {
            assert!(ps.contains(&esperado), "falta {esperado} en {ps:?}");
        }
        assert!(c.decide_la_local);
    }

    #[test]
    fn el_prompt_lleva_tarea_proveedor_modelo_y_esfuerzo() {
        let c = Criterio::default();
        let p = como_prompt(&c);
        assert!(p.contains("arquitectura y textos largos: usa claude con opus, esfuerzo alto"));
        assert!(p.contains("trivial: usa local"));
        // Una regla por linea: el modelo local lee mal un parrafo.
        assert_eq!(p.lines().count(), c.reglas.len());
    }

    #[test]
    fn la_nota_del_usuario_acaba_en_el_prompt() {
        let mut c = Criterio::default();
        c.nota = "nunca uses gemini de noche".into();
        assert!(como_prompt(&c).contains("Ademas: nunca uses gemini de noche"));
    }

    #[test]
    fn una_nota_en_blanco_no_ensucia_el_prompt() {
        // Caso negativo: una linea "Ademas:" vacia gasta tokens y confunde.
        let mut c = Criterio::default();
        c.nota = "   ".into();
        assert!(!como_prompt(&c).contains("Ademas"));
    }

    #[test]
    fn se_caen_las_reglas_de_proveedores_retirados() {
        // Caso negativo: una regla a "groq" hacia que el modelo local
        // propusiera un destino que ya no existe en cada turno.
        let c = Criterio {
            decide_la_local: true,
            reglas: vec![
                regla("a", "claude"),
                regla("b", "groq"),
                regla("c", "local"),
            ],
            ..Criterio::default()
        };
        let validos = vec!["claude".to_string(), "local".to_string()];
        let limpio = solo_proveedores_validos(&c, &validos);
        assert_eq!(
            limpio
                .reglas
                .iter()
                .map(|r| r.provider.as_str())
                .collect::<Vec<_>>(),
            vec!["claude", "local"]
        );
    }

    #[test]
    fn sin_proveedores_validos_no_queda_ninguna_regla() {
        let c = Criterio::default();
        assert!(solo_proveedores_validos(&c, &[]).reglas.is_empty());
    }
}
