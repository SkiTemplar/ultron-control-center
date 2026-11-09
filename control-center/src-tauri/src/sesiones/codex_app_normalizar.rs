//! Traducción pura de avisos Codex y acumulación mínima del uso del turno.
use super::motor_eventos::{EventoMotor, OpcionPermiso};
use super::types::Usage;
use serde_json::{json, Value};
use std::collections::HashSet;

fn texto(valor: &Value, campo: &str) -> String {
    valor[campo].as_str().unwrap_or_default().to_string()
}

/// No conserva estado ni realiza E/S. FlujoCodex elimina ecos de textos completos.
/// La salida de herramientas se publica completa al terminar, sin duplicar deltas.
pub fn normalizar(metodo: &str, parametros: &Value) -> Vec<EventoMotor> {
    match metodo {
        "item/agentMessage/delta" => vec![EventoMotor::MensajeDelta {
            texto: texto(parametros, "delta"),
        }],
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
            vec![EventoMotor::PensamientoDelta {
                texto: texto(parametros, "delta"),
            }]
        }
        "item/started" => inicio(&parametros["item"]),
        "item/completed" => fin(&parametros["item"]),
        "turn/completed" => vec![EventoMotor::FinTurno {
            motivo: texto(&parametros["turn"], "status"),
            uso: None,
        }],
        "thread/tokenUsage/updated"
        | "thread/status/changed"
        | "thread/started"
        | "turn/started"
        | "serverRequest/resolved"
        | "item/commandExecution/outputDelta" => Vec::new(),
        _ => {
            tracing::debug!(metodo, "Notificación Codex desconocida");
            Vec::new()
        }
    }
}

fn inicio(item: &Value) -> Vec<EventoMotor> {
    let (titulo, tipo, entrada) = match item["type"].as_str().unwrap_or_default() {
        "commandExecution" => (
            "Bash".to_string(),
            "execute",
            json!({"command":comando_legible(&texto(item,"command"))}),
        ),
        "fileChange" => {
            let cambios: Vec<_> = item["changes"].as_array().into_iter().flatten().collect();
            let rutas: Vec<_> = cambios.iter().filter_map(|c| c["path"].as_str()).collect();
            let crear = !cambios.is_empty() && cambios.iter().all(|c| c["kind"]["type"] == "add");
            (
                if crear { "Write" } else { "Edit" }.into(),
                "edit",
                json!({"file_path":rutas.first(),"paths":rutas,"changes":item["changes"]}),
            )
        }
        "mcpToolCall" => (
            format!("{}:{}", texto(item, "server"), texto(item, "tool")),
            "other",
            item["arguments"].clone(),
        ),
        _ => return Vec::new(),
    };
    vec![EventoMotor::HerramientaInicio {
        id: texto(item, "id"),
        titulo,
        tipo: tipo.into(),
        entrada,
    }]
}

fn fin(item: &Value) -> Vec<EventoMotor> {
    if let Some(evento) = texto_completo(item) {
        return vec![evento];
    }
    resultado_herramienta(item)
}

fn texto_completo(item: &Value) -> Option<EventoMotor> {
    if item["type"] == "agentMessage" {
        return Some(EventoMotor::MensajeDelta {
            texto: texto(item, "text"),
        });
    }
    if item["type"] == "reasoning" {
        let campo = if item["summary"].as_array().is_some_and(|a| !a.is_empty()) {
            "summary"
        } else {
            "content"
        };
        let resumen = item[campo]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        return Some(EventoMotor::PensamientoDelta { texto: resumen });
    }
    None
}

fn resultado_herramienta(item: &Value) -> Vec<EventoMotor> {
    if !matches!(
        item["type"].as_str(),
        Some("commandExecution" | "fileChange" | "mcpToolCall")
    ) {
        return Vec::new();
    }
    let estado = texto(item, "status");
    let error = matches!(estado.as_str(), "declined" | "failed" | "cancelled")
        || item["exitCode"].as_i64().is_some_and(|n| n != 0)
        || !item["error"].is_null();
    let salida = item
        .get("aggregatedOutput")
        .filter(|v| !v.is_null())
        .or_else(|| item.get("error").filter(|v| !v.is_null()))
        .or_else(|| item.get("result").filter(|v| !v.is_null()))
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .unwrap_or_else(|| v.to_string())
        })
        .unwrap_or_else(|| {
            if estado == "declined" {
                "Ejecución rechazada por permisos".into()
            } else {
                estado
            }
        });
    vec![EventoMotor::HerramientaFin {
        id: texto(item, "id"),
        error,
        salida,
    }]
}

/// Retira únicamente el envoltorio PowerShell; conserva las comillas internas.
pub fn comando_legible(comando: &str) -> String {
    let minusculas = comando.to_ascii_lowercase();
    if let Some((indice, _)) = minusculas.match_indices(" -command ").next() {
        let ejecutable = minusculas[..indice].trim().trim_matches('"');
        if ejecutable.ends_with("powershell.exe") || ejecutable.ends_with("pwsh.exe") {
            let interior = comando[indice + " -command ".len()..].trim();
            if interior.len() >= 2
                && ((interior.starts_with('\'') && interior.ends_with('\''))
                    || (interior.starts_with('"') && interior.ends_with('"')))
            {
                return interior[1..interior.len() - 1].to_string();
            }
            return interior.to_string();
        }
    }
    comando.to_string()
}

pub fn es_aprobacion(metodo: &str) -> bool {
    matches!(
        metodo,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
    )
}

pub fn permiso(id: &str, metodo: &str, parametros: &Value) -> EventoMotor {
    let (herramienta, tipo) = match metodo {
        "item/commandExecution/requestApproval" => {
            (comando_legible(&texto(parametros, "command")), "execute")
        }
        "item/fileChange/requestApproval" => ("Edit".into(), "edit"),
        _ => ("Permisos".into(), "permissions"),
    };
    EventoMotor::PeticionPermiso {
        id_peticion: id.into(),
        herramienta: herramienta.clone(),
        tipo: tipo.into(),
        entrada: if tipo == "execute" {
            json!({"command":herramienta})
        } else {
            parametros.clone()
        },
        opciones: [
            ("accept", "Permitir", "allow_once"),
            ("acceptForSession", "Permitir en la sesión", "allow_always"),
            ("decline", "Rechazar", "reject_once"),
        ]
        .into_iter()
        .map(|(id, nombre, tipo)| OpcionPermiso {
            id: id.into(),
            nombre: nombre.into(),
            tipo: tipo.into(),
        })
        .collect(),
    }
}

/// El contrato común publica Usage en FinTurno: se conserva el último last,
/// usando total únicamente cuando el servidor no proporciona last.
#[derive(Default)]
pub struct FlujoCodex {
    uso: Option<Usage>,
    textos_incrementales: HashSet<String>,
}
impl FlujoCodex {
    pub fn aplicar(&mut self, metodo: &str, parametros: &Value) -> Vec<EventoMotor> {
        if metodo == "turn/started" {
            self.uso = None;
            self.textos_incrementales.clear();
        }
        if matches!(
            metodo,
            "item/agentMessage/delta"
                | "item/reasoning/summaryTextDelta"
                | "item/reasoning/textDelta"
        ) {
            self.textos_incrementales
                .insert(texto(parametros, "itemId"));
        }
        if metodo == "item/completed"
            && self
                .textos_incrementales
                .remove(&texto(&parametros["item"], "id"))
        {
            return Vec::new();
        }
        if metodo == "thread/tokenUsage/updated" {
            let datos = &parametros["tokenUsage"];
            self.uso = datos
                .get("last")
                .filter(|v| v.is_object())
                .or_else(|| datos.get("total").filter(|v| v.is_object()))
                .map(uso);
        }
        let mut eventos = normalizar(metodo, parametros);
        for evento in &mut eventos {
            if let EventoMotor::FinTurno { uso, .. } = evento {
                *uso = self.uso.take();
            }
        }
        eventos
    }
}

fn uso(datos: &Value) -> Usage {
    let n = |campo: &str| datos[campo].as_u64().unwrap_or(0);
    Usage {
        input: n("inputTokens"),
        output: n("outputTokens"),
        cache_read: n("cachedInputTokens"),
        cache_write: n("cacheWriteInputTokens"),
        cache_write_5m: 0,
        cache_write_1h: 0,
        speed: None,
        model: None,
    }
}

#[cfg(test)]
#[path = "tests_codex_app_normalizar.rs"]
mod tests;
