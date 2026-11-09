//! Transcript JSONL del chat nativo; solo se anexan mensajes definitivos.
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use super::super::types::{now_iso, Block, ChatMessage, EngineTask, MessageKind};
use super::super::{motor, motor_sesion, pagina};

static ESCRITURA: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();

fn escritura() -> &'static Mutex<HashSet<String>> {
    ESCRITURA.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(super) fn existe(id: &str) -> bool {
    ruta(id).is_ok_and(|p| p.is_file())
}

fn ruta(id: &str) -> Result<PathBuf, String> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("id de sesión de motor no válido".into());
    }
    Ok(directorio()?.join(format!("{id}.jsonl")))
}

#[cfg(not(test))]
fn directorio() -> Result<PathBuf, String> {
    super::super::motor_sesion::directorio_guardado().map(|p| p.join("motor"))
}

#[cfg(test)]
fn directorio() -> Result<PathBuf, String> {
    static DIR: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    if let Some(dir) = DIR.get() {
        return Ok(dir.path().into());
    }
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let _ = DIR.set(dir);
    DIR.get()
        .map(|d| d.path().into())
        .ok_or_else(|| "directorio temporal perdido".into())
}

pub(super) fn anexar(id: &str, mensajes: &[ChatMessage]) -> Result<(), String> {
    let borrados = escritura().lock().map_err(|e| e.to_string())?;
    if borrados.contains(id) {
        return Err("la sesión fue podada; no se restaura su transcript".into());
    }
    let ruta = ruta(id)?;
    if let Some(dir) = ruta.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut fichero = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(ruta)
        .map_err(|e| e.to_string())?;
    for mensaje in mensajes {
        serde_json::to_writer(&mut fichero, mensaje).map_err(|e| e.to_string())?;
        fichero.write_all(b"\n").map_err(|e| e.to_string())?;
    }
    fichero.flush().map_err(|e| e.to_string())
}

pub(super) fn leer(id: &str) -> Result<Option<Vec<ChatMessage>>, String> {
    let _guardia = escritura().lock().map_err(|e| e.to_string())?;
    let fichero = match std::fs::File::open(ruta(id)?) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    BufReader::new(fichero)
        .lines()
        .map(|linea| {
            let linea = linea.map_err(|e| e.to_string())?;
            serde_json::from_str(&linea).map_err(|e| format!("transcript de motor no válido: {e}"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

pub(super) fn borrar(id: &str) {
    if let Ok(mut borrados) = escritura().lock() {
        // Un fin de turno concurrente no puede resucitar el fichero tras la poda.
        borrados.insert(id.into());
        if let Ok(ruta) = ruta(id) {
            if let Err(e) = std::fs::remove_file(ruta) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(error = %e, "no se pudo borrar el transcript de motor");
                }
            }
        }
    }
}

/// Conserva una copia fechada antes de cambiar el historial visible.
pub(super) fn archivar(id: &str) -> Result<(), String> {
    let _guardia = escritura().lock().map_err(|e| e.to_string())?;
    let origen = ruta(id)?;
    if origen.exists() {
        let fecha = chrono::Utc::now().format("%Y%m%dT%H%M%S%.9f");
        let destino = origen.with_extension(format!("{fecha}-{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::rename(origen, destino).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn recortar(id: &str, mensajes: &[ChatMessage], indice: usize) -> Result<(), String> {
    archivar(id)?;
    anexar(id, &mensajes[..indice])
}

pub fn history(
    id: &str,
    antes: Option<&str>,
    limite: Option<usize>,
) -> Result<pagina::HistoryPage, String> {
    let sesion = motor_sesion::get(id)?;
    let tareas = if sesion.open {
        motor::turnos_de_sesion(id)
    } else {
        sesion.turns
    };
    let mensajes = fusionar(leer(id)?.unwrap_or_default(), &tareas);
    pagina::paginar_ref(
        &mensajes,
        antes,
        pagina::limite(limite),
        pagina::PRESUPUESTO_BYTES,
    )
}

/// Transcript de los turnos vivos más los turnos `exec` terminados (los de antes
/// del proceso persistente y los de la caída a `exec`), en orden de fecha. La
/// ordenación es estable: dentro de un turno se conserva el orden del transcript.
pub(super) fn fusionar(transcript: Vec<ChatMessage>, tareas: &[EngineTask]) -> Vec<ChatMessage> {
    let terminadas: Vec<EngineTask> = tareas
        .iter()
        .filter(|t| t.status != "running")
        .cloned()
        .collect();
    let mut mensajes = transcript;
    mensajes.extend(convertir(&terminadas));
    mensajes.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    mensajes
}

pub(super) fn convertir(tareas: &[EngineTask]) -> Vec<ChatMessage> {
    tareas
        .iter()
        .flat_map(|t| {
            let usuario = mensaje(
                "user",
                super::super::motor_eventos::uuid_mensaje(&t.id, 0),
                &t.prompt,
                &t.started_at,
            );
            let respuesta = t.summary.as_ref().map(|texto| {
                mensaje(
                    "assistant",
                    super::super::motor_eventos::uuid_mensaje(&t.id, 1),
                    texto,
                    t.finished_at.as_deref().unwrap_or(&t.started_at),
                )
            });
            std::iter::once(usuario).chain(respuesta)
        })
        .collect()
}

pub(super) fn usuario(texto: &str, adjuntos: &[String]) -> ChatMessage {
    let (imagenes, archivos) = super::super::intervencion::split_attachments("codex", adjuntos);
    let texto = super::super::intervencion::with_attachment_list(texto.trim(), &archivos);
    let mut m = mensaje("user", uuid::Uuid::new_v4().to_string(), &texto, &now_iso());
    m.blocks.extend(imagenes.iter().map(|ruta| {
        Block::Image {
            media_type: super::super::adjuntos::image_mime(ruta)
                .unwrap_or("application/octet-stream")
                .into(),
            data_url: None,
            path: Some(ruta.clone()),
        }
    }));
    m
}

fn mensaje(rol: &str, uuid: String, texto: &str, fecha: &str) -> ChatMessage {
    ChatMessage {
        uuid,
        role: rol.into(),
        timestamp: fecha.into(),
        blocks: vec![Block::Text { text: texto.into() }],
        agent_id: None,
        model: None,
        usage: None,
        kind: if rol == "user" {
            MessageKind::Prompt
        } else {
            MessageKind::Answer
        },
        queued: false,
        client_id: None,
        stream_key: None,
        command: None,
    }
}

#[cfg(test)]
mod tests_archivo {
    use super::*;

    #[test]
    fn recorte_conserva_copia_fechada_completa() {
        let id = uuid::Uuid::new_v4().to_string();
        let mensajes = vec![usuario("uno", &[]), usuario("dos", &[])];
        anexar(&id, &mensajes).unwrap();
        recortar(&id, &mensajes, 1).unwrap();
        assert_eq!(leer(&id).unwrap().unwrap(), mensajes[..1]);
        let ruta = ruta(&id).unwrap();
        let archivos: Vec<_> = std::fs::read_dir(ruta.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|f| {
                f.file_name()
                    .to_string_lossy()
                    .starts_with(&format!("{id}."))
            })
            .filter(|f| f.path() != ruta)
            .collect();
        assert_eq!(archivos.len(), 1);
        let copia = std::fs::read_to_string(archivos[0].path()).unwrap();
        assert_eq!(copia.lines().count(), 2);
        assert!(copia.contains("dos"));
        borrar(&id);
    }
}
