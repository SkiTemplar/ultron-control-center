// Normalización pura del protocolo ACP v1 a los eventos comunes de motor.
use serde_json::Value;

use super::motor_eventos::{ComandoMotor, EventoMotor, ModeloMotor, ModoMotor, OpcionPermiso};
use super::types::Usage;

fn texto(valor: &Value, campo: &str) -> String {
    valor[campo].as_str().unwrap_or_default().to_string()
}

fn lista<'a>(valor: &'a Value, campo: &str) -> impl Iterator<Item = &'a Value> {
    valor[campo].as_array().into_iter().flatten()
}

/// Recibe los parámetros de `session/update`; no conserva estado del agente.
pub fn normalizar(parametros: &Value) -> Vec<EventoMotor> {
    let actualizacion = &parametros["update"];
    let tipo = texto(actualizacion, "sessionUpdate");
    match tipo.as_str() {
        "agent_message_chunk" => delta(actualizacion, false),
        "agent_thought_chunk" => delta(actualizacion, true),
        // El usuario ya figura en el turno local; ACP devuelve su eco.
        "user_message_chunk" => Vec::new(),
        "tool_call" => inicio(actualizacion),
        "tool_call_update" => resultado(actualizacion),
        "available_commands_update" => vec![comandos(actualizacion)],
        "config_option_update" => configuracion(&configuracion_compatible(actualizacion.clone())),
        "session_info_update" => actualizacion["title"]
            .as_str()
            .map(|t| vec![EventoMotor::Titulo(t.to_string())])
            .unwrap_or_default(),
        "current_mode_update" => vec![EventoMotor::Modo {
            actual: texto(actualizacion, "currentModeId"),
            disponibles: Vec::new(),
        }],
        "plan" => plan(actualizacion),
        _ => {
            tracing::debug!(tipo, "actualización ACP desconocida");
            Vec::new()
        }
    }
}

/// OpenCode publica modelos y modos mediante configOptions (ACP reciente).
pub(super) fn configuracion_compatible(mut r: Value) -> Value {
    let opciones = r["configOptions"].as_array().cloned().unwrap_or_default();
    for opcion in opciones {
        let valores = opciones_planas(&opcion["options"]);
        match opcion["category"].as_str().or(opcion["id"].as_str()) {
            Some("mode") if r.get("modes").is_none() => {
                let modos: Vec<_> = valores
                    .iter()
                    .map(|v| {
                        serde_json::json!({
                    "id":v["value"],"name":v["name"],"description":v["description"]})
                    })
                    .collect();
                r["modes"] = serde_json::json!({"currentModeId":opcion["currentValue"],"availableModes":modos});
            }
            Some("model") if r.get("models").is_none() => {
                let modelos: Vec<_> = valores
                    .iter()
                    .map(|v| {
                        serde_json::json!({
                    "modelId":v["value"],"name":v["name"]})
                    })
                    .collect();
                r["models"] = serde_json::json!({"currentModelId":opcion["currentValue"],"availableModels":modelos});
            }
            _ => {}
        }
    }
    r
}

fn opciones_planas(valor: &Value) -> Vec<&Value> {
    valor
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|v| {
            if v["value"].is_string() {
                vec![v]
            } else {
                opciones_planas(&v["options"])
            }
        })
        .collect()
}

fn delta(actualizacion: &Value, pensamiento: bool) -> Vec<EventoMotor> {
    let contenido = &actualizacion["content"];
    if contenido["type"] != "text" {
        return Vec::new();
    }
    let texto = texto(contenido, "text");
    if pensamiento {
        vec![EventoMotor::PensamientoDelta { texto }]
    } else {
        vec![EventoMotor::MensajeDelta { texto }]
    }
}

fn inicio(actualizacion: &Value) -> Vec<EventoMotor> {
    let entrada = actualizacion
        .get("rawInput")
        .or_else(|| actualizacion.get("args"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut eventos = vec![EventoMotor::HerramientaInicio {
        id: texto(actualizacion, "toolCallId"),
        titulo: texto(actualizacion, "title"),
        tipo: texto(actualizacion, "kind"),
        entrada,
    }];
    eventos.extend(resultado(actualizacion));
    eventos
}

fn resultado(actualizacion: &Value) -> Vec<EventoMotor> {
    let estado = texto(actualizacion, "status");
    if estado != "completed" && estado != "failed" {
        return Vec::new();
    }
    let textos: Vec<_> = lista(actualizacion, "content")
        .filter_map(|c| c.pointer("/content/text").and_then(Value::as_str))
        .collect();
    let salida = if textos.is_empty() {
        salida_bruta(&actualizacion["rawOutput"])
    } else {
        textos.join("\n")
    };
    vec![EventoMotor::HerramientaFin {
        id: texto(actualizacion, "toolCallId"),
        error: estado == "failed",
        salida,
    }]
}

fn salida_bruta(valor: &Value) -> String {
    match valor {
        Value::Null => String::new(),
        Value::String(t) => t.clone(),
        _ => valor["output"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| valor.to_string()),
    }
}

fn comandos(actualizacion: &Value) -> EventoMotor {
    EventoMotor::Comandos(
        lista(actualizacion, "availableCommands")
            .map(|c| ComandoMotor {
                nombre: texto(c, "name"),
                descripcion: texto(c, "description"),
                pista_argumento: c
                    .pointer("/input/hint")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
            .collect(),
    )
}

fn plan(actualizacion: &Value) -> Vec<EventoMotor> {
    let lineas: Vec<_> = lista(actualizacion, "entries")
        .map(|e| format!("- [{}] {}", texto(e, "status"), texto(e, "content")))
        .collect();
    if lineas.is_empty() {
        return Vec::new();
    }
    vec![EventoMotor::MensajeDelta {
        texto: format!("Plan:\n{}\n", lineas.join("\n")),
    }]
}

/// Metadatos iniciales de `session/new` o `session/load`.
pub fn configuracion(resultado: &Value) -> Vec<EventoMotor> {
    let mut eventos = Vec::new();
    if let Some(modos) = resultado.get("modes") {
        eventos.push(EventoMotor::Modo {
            actual: texto(modos, "currentModeId"),
            disponibles: lista(modos, "availableModes")
                .map(|m| ModoMotor {
                    id: texto(m, "id"),
                    nombre: texto(m, "name"),
                    descripcion: m["description"].as_str().map(str::to_string),
                })
                .collect(),
        });
    }
    if let Some(modelos) = resultado.get("models") {
        eventos.push(EventoMotor::Modelos {
            actual: modelos["currentModelId"].as_str().map(str::to_string),
            disponibles: lista(modelos, "availableModels")
                .map(|m| ModeloMotor {
                    id: texto(m, "modelId"),
                    nombre: texto(m, "name"),
                })
                .collect(),
        });
    }
    eventos
}

/// El uso se publica solo al cerrar el prompt, conservando los tokens ACP.
pub fn fin_turno(resultado: &Value) -> EventoMotor {
    let uso = resultado.get("usage").filter(|u| u.is_object()).map(|u| {
        let n = |campo: &str| u[campo].as_u64().unwrap_or(0);
        Usage {
            input: n("inputTokens"),
            output: n("outputTokens"),
            cache_read: n("cachedReadTokens"),
            cache_write: n("cachedWriteTokens"),
            cache_write_5m: 0,
            cache_write_1h: 0,
            speed: None,
            model: None,
        }
    });
    EventoMotor::FinTurno {
        motivo: texto(resultado, "stopReason"),
        uso,
    }
}

/// Conserva los identificadores ACP de opción; `kind` es su semántica.
pub fn permiso(id_peticion: &str, parametros: &Value) -> EventoMotor {
    let herramienta = &parametros["toolCall"];
    EventoMotor::PeticionPermiso {
        id_peticion: id_peticion.into(),
        herramienta: texto(herramienta, "title"),
        tipo: texto(herramienta, "kind"),
        entrada: herramienta
            .get("rawInput")
            .cloned()
            .unwrap_or_else(|| herramienta.clone()),
        opciones: lista(parametros, "options")
            .map(|o| OpcionPermiso {
                id: texto(o, "optionId"),
                nombre: texto(o, "name"),
                tipo: texto(o, "kind"),
            })
            .collect(),
    }
}

#[cfg(test)]
#[path = "tests_acp_normalizar.rs"]
mod tests;
