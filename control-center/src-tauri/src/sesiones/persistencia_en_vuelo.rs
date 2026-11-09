// sesiones/persistencia_en_vuelo.rs — Envíos que estaban en `sending` al
// cerrar ULTRON (hallazgo #35).
//
// `sending` significa que los bytes ya se escribieron en el PTY: lo más
// probable es que Claude los recibiera. Al restaurar, antes de reponerlos en
// la cola (que la máquina drena sola en cuanto la sesión reanudada llega a
// idle), se cruzan con el último mensaje del hilo principal del transcript,
// con el mismo criterio que el emparejado de la cola (`normalizar_envio` y
// `parecido`):
//
// - igual o lo contiene entero: ya llegó y no se repone (se evita el prompt
//   duplicado);
// - el último mensaje es otro y solo había un envío en vuelo: no llegó y se
//   repone sin aviso;
// - no se puede comprobar (transcript ilegible, sin prompts en la cola del
//   fichero, comando de barra, varios envíos en vuelo o un último prompt que
//   solo empieza igual, que pudo escribirse a mano): se repone con
//   `AVISO_SIN_COMPROBAR`, que dice que saldrá otra vez sin margen.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use super::{Guardado, AVISO_SENDING};
use crate::sesiones::cola::{contiene, parecido, texto_delegado};
use crate::sesiones::senales::normalizar_envio;
use crate::sesiones::transcript;
use crate::sesiones::types::{Block, ChatMessage, MessageKind, QueueItemKind, QueueState};

/// Bytes del final del transcript que se leen (los de días pesan 50-200 MB).
const COLA_TRANSCRIPT: u64 = 4 << 20;

/// Aviso de un envío en vuelo cuya llegada no se pudo comprobar.
pub const AVISO_SIN_COMPROBAR: &str = "Se estaba enviando cuando se cerró ULTRON y no se ha \
     podido comprobar en el transcript si llegó: saldrá otra vez en cuanto la sesión quede libre.";

/// Prefijo común de `AVISO_SENDING` en todas sus versiones del fichero.
const PREFIJO_EN_VUELO: &str = "Se estaba enviando cuando se cerró ULTRON";

/// Resultado de cruzar un envío en vuelo con el transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Comprobacion {
    Llego,
    NoLlego,
    SinComprobar,
}

/// Cola que se repone y recuento de los envíos en vuelo.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Reparto {
    pub cola: Vec<Guardado>,
    pub llegados: usize,
    pub no_llegados: usize,
    pub sin_comprobar: usize,
}

/// true si el elemento se guardó en `sending` (`cola_guardable`).
pub fn es_en_vuelo(g: &Guardado) -> bool {
    g.state == QueueState::Queued
        && g.error
            .as_deref()
            .is_some_and(|e| e == AVISO_SENDING || e.starts_with(PREFIJO_EN_VUELO))
        && g.error.as_deref() != Some(AVISO_SIN_COMPROBAR)
}

/// Cola que se repone a partir de la guardada y del transcript. Solo lee el
/// transcript si hay algún envío en vuelo.
pub fn resolver(cola: &[Guardado], transcript: &Path) -> Reparto {
    if !cola.iter().any(es_en_vuelo) {
        return Reparto {
            cola: cola.to_vec(),
            ..Reparto::default()
        };
    }
    let ultimo = ultimo_mensaje(transcript).unwrap_or_else(|e| {
        tracing::warn!(error = %e, "no se pudo leer el transcript para comprobar los envíos en vuelo");
        None
    });
    repartir(cola, ultimo.as_ref())
}

/// Reparte la cola guardada según `ultimo`, el último prompt o `!comando`
/// del hilo principal. Un mismo mensaje solo da por llegado un envío.
pub fn repartir(cola: &[Guardado], ultimo: Option<&ChatMessage>) -> Reparto {
    let varios = cola.iter().filter(|g| es_en_vuelo(g)).count() > 1;
    let mut r = Reparto::default();
    let mut consumido = false;
    for g in cola {
        if !es_en_vuelo(g) {
            r.cola.push(g.clone());
            continue;
        }
        let c = match comprobar(g, ultimo.filter(|_| !consumido)) {
            Comprobacion::NoLlego if varios => Comprobacion::SinComprobar,
            c => c,
        };
        match c {
            Comprobacion::Llego => {
                consumido = true;
                r.llegados += 1;
            }
            Comprobacion::NoLlego => {
                r.no_llegados += 1;
                r.cola.push(Guardado {
                    error: None,
                    ..g.clone()
                });
            }
            Comprobacion::SinComprobar => {
                r.sin_comprobar += 1;
                r.cola.push(Guardado {
                    error: Some(AVISO_SIN_COMPROBAR.to_string()),
                    ..g.clone()
                });
            }
        }
    }
    r
}

/// Cruza un envío con el último mensaje del hilo principal.
pub fn comprobar(g: &Guardado, ultimo: Option<&ChatMessage>) -> Comprobacion {
    let Some(m) = ultimo else {
        return Comprobacion::SinComprobar;
    };
    let (envio, recibido) = match g.kind {
        // La CLI guarda un comando de barra con otra forma: no se compara.
        QueueItemKind::Command => return Comprobacion::SinComprobar,
        QueueItemKind::Prompt => (texto_comparable(g), texto_prompt(m)),
        QueueItemKind::Bash => (
            normalizar_envio(g.text.trim_start().trim_start_matches('!')),
            texto_bash(m),
        ),
    };
    // Igualdad o contención: evidencia de entrega. Un prefijo común no basta
    // (como en la cola en vivo): pudo escribirse a mano con la misma plantilla,
    // y darlo por llegado perdería el mensaje.
    match recibido {
        Some(r) if r == envio || contiene(&r, &envio) => Comprobacion::Llego,
        Some(r) if parecido(&r, &envio) => Comprobacion::SinComprobar,
        _ => Comprobacion::NoLlego,
    }
}

fn texto_comparable(g: &Guardado) -> String {
    if g.delegate {
        normalizar_envio(&texto_delegado(&g.text))
    } else {
        normalizar_envio(&g.text)
    }
}

fn texto_prompt(m: &ChatMessage) -> Option<String> {
    if m.role != "user" || m.kind != MessageKind::Prompt {
        return None;
    }
    m.blocks.iter().find_map(|b| match b {
        Block::Text { text } => Some(normalizar_envio(text)),
        _ => None,
    })
}

fn texto_bash(m: &ChatMessage) -> Option<String> {
    (m.kind == MessageKind::Bash)
        .then(|| m.command.as_ref().map(|c| normalizar_envio(&c.args)))
        .flatten()
}

/// Último prompt o `!comando` del hilo principal en los últimos
/// `COLA_TRANSCRIPT` bytes del transcript. `None` si no hay ninguno.
pub fn ultimo_mensaje(path: &Path) -> Result<Option<ChatMessage>, String> {
    let texto = leer_cola(path, COLA_TRANSCRIPT)
        .map_err(|e| format!("no se pudo leer {}: {e}", path.display()))?;
    Ok(transcript::parse_all(&texto, None)
        .into_iter()
        .rev()
        .find(|m| {
            m.agent_id.is_none()
                && (m.kind == MessageKind::Bash
                    || (m.role == "user" && m.kind == MessageKind::Prompt))
        }))
}

/// Los últimos `max` bytes del fichero, sin la primera línea si quedó
/// cortada. Los bytes no UTF-8 se sustituyen.
pub(super) fn leer_cola(path: &Path, max: u64) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let largo = f.metadata()?.len();
    let desde = largo.saturating_sub(max);
    f.seek(SeekFrom::Start(desde))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    let texto = String::from_utf8_lossy(&buf).into_owned();
    if desde == 0 {
        return Ok(texto);
    }
    Ok(texto
        .split_once('\n')
        .map(|(_, resto)| resto.to_string())
        .unwrap_or_default())
}

#[cfg(test)]
#[path = "tests_persistencia_en_vuelo.rs"]
mod tests;
