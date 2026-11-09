//! Eventos independientes del protocolo y construcción pura del turno de motor.

use serde_json::Value;
use uuid::Uuid;

use super::types::{Block, ChatMessage, MessageKind, Usage};

#[derive(Debug, Clone, PartialEq)]
pub struct OpcionPermiso {
    pub id: String,
    pub nombre: String,
    pub tipo: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ComandoMotor {
    pub nombre: String,
    pub descripcion: String,
    pub pista_argumento: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModoMotor {
    pub id: String,
    pub nombre: String,
    pub descripcion: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModeloMotor {
    pub id: String,
    pub nombre: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EventoMotor {
    MensajeDelta {
        texto: String,
    },
    PensamientoDelta {
        texto: String,
    },
    HerramientaInicio {
        id: String,
        titulo: String,
        tipo: String,
        entrada: Value,
    },
    HerramientaFin {
        id: String,
        error: bool,
        salida: String,
    },
    PeticionPermiso {
        id_peticion: String,
        herramienta: String,
        tipo: String,
        entrada: serde_json::Value,
        opciones: Vec<OpcionPermiso>,
    },
    Comandos(Vec<ComandoMotor>),
    Modo {
        actual: String,
        disponibles: Vec<ModoMotor>,
    },
    Modelos {
        actual: Option<String>,
        disponibles: Vec<ModeloMotor>,
    },
    Titulo(String),
    FinTurno {
        motivo: String,
        uso: Option<Usage>,
    },
    Error(String),
}

/// Acumula bloques sin reloj, E/S ni estado global. Los metadatos son externos al chat.
pub struct ConstructorTurno {
    id_turno: String,
    mensajes: Vec<ChatMessage>,
    uso: Option<Usage>,
}

impl ConstructorTurno {
    pub fn nuevo(id_turno: &str) -> Self {
        Self {
            id_turno: id_turno.into(),
            mensajes: Vec::new(),
            uso: None,
        }
    }

    pub fn aplicar(&mut self, evento: EventoMotor) {
        match evento {
            EventoMotor::MensajeDelta { texto } => self.delta(texto, false),
            EventoMotor::PensamientoDelta { texto } => self.delta(texto, true),
            EventoMotor::HerramientaInicio {
                id,
                titulo,
                tipo,
                entrada,
            } => {
                let summary = resumen_herramienta(&titulo, &tipo, &entrada);
                self.bloque(
                    "assistant",
                    Block::ToolUse {
                        id,
                        name: titulo,
                        input: entrada,
                        summary,
                    },
                );
            }
            EventoMotor::HerramientaFin { id, error, salida } => {
                self.bloque(
                    "user",
                    Block::ToolResult {
                        tool_use_id: id,
                        is_error: error,
                        text: salida,
                        images: None,
                    },
                );
            }
            EventoMotor::FinTurno { uso, .. } => self.uso = uso,
            EventoMotor::Error(texto) => self.delta(texto, false),
            _ => {}
        }
    }

    /// Devuelve una instantánea; el consumo se asocia únicamente al último mensaje.
    pub fn mensajes(&self) -> Vec<ChatMessage> {
        let mut mensajes = self.mensajes.clone();
        if let Some(ultimo) = mensajes.last_mut() {
            ultimo.usage = self.uso.clone();
        }
        mensajes
    }

    fn delta(&mut self, texto: String, pensamiento: bool) {
        if texto.is_empty() {
            return;
        }
        if let Some(ultimo) = self.mensajes.last_mut().filter(|m| m.role == "assistant") {
            match (ultimo.blocks.last_mut(), pensamiento) {
                (Some(Block::Text { text }), false) | (Some(Block::Thinking { text }), true) => {
                    text.push_str(&texto);
                    return;
                }
                _ => {}
            }
        }
        let bloque = if pensamiento {
            Block::Thinking { text: texto }
        } else {
            Block::Text { text: texto }
        };
        self.bloque("assistant", bloque);
    }

    fn bloque(&mut self, rol: &str, bloque: Block) {
        if let Some(ultimo) = self.mensajes.last_mut().filter(|m| m.role == rol) {
            ultimo.blocks.push(bloque);
            return;
        }
        self.mensajes.push(ChatMessage {
            uuid: uuid_mensaje(&self.id_turno, self.mensajes.len()),
            role: rol.into(),
            timestamp: String::new(),
            blocks: vec![bloque],
            agent_id: None,
            model: None,
            usage: None,
            kind: if rol == "assistant" {
                MessageKind::Answer
            } else {
                MessageKind::Meta
            },
            queued: false,
            client_id: None,
            stream_key: None,
            command: None,
        });
    }
}

fn resumen_herramienta(titulo: &str, tipo: &str, entrada: &Value) -> String {
    if let Some(comando) = campo_texto(entrada, &["CommandLine", "command", "commandLine"]) {
        return comando.into();
    }
    if let Some(ruta) = campo_texto(entrada, &["Path", "path", "filePath", "file_path"]) {
        let nombre = ruta.rsplit(['/', '\\']).next().unwrap_or(ruta);
        let accion = match tipo {
            "read" | "read_file" => "Leer",
            "edit" | "write" | "write_file" => "Editar",
            "delete" => "Borrar",
            _ => return titulo.into(),
        };
        return format!("{accion} {nombre}");
    }
    titulo.into()
}

fn campo_texto<'a>(entrada: &'a Value, nombres: &[&str]) -> Option<&'a str> {
    nombres
        .iter()
        .find_map(|nombre| entrada.get(nombre)?.as_str().filter(|s| !s.is_empty()))
}

/// FNV-1a con dos semillas y contador de ancho fijo; no depende de RandomState.
pub(super) fn uuid_mensaje(id_turno: &str, contador: usize) -> String {
    let mut semillas = [0xcbf29ce484222325_u64, 0x84222325cbf29ce4_u64];
    let contador = (contador as u64).to_le_bytes();
    for semilla in &mut semillas {
        for byte in id_turno.as_bytes().iter().chain(contador.iter()) {
            *semilla = (*semilla ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
        }
    }
    let mut bytes = [0_u8; 16];
    bytes[..8].copy_from_slice(&semillas[0].to_be_bytes());
    bytes[8..].copy_from_slice(&semillas[1].to_be_bytes());
    // Variante RFC 4122, versión 8 (identificador determinista definido por la aplicación).
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

#[cfg(test)]
#[path = "tests_motor_eventos.rs"]
mod tests;
