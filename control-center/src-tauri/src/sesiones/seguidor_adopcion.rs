// sesiones/seguidor_adopcion.rs — Cambio de conversación sin puente
// (contrato de estabilidad, §1.4, «Adopción de transcripts ajenos»).
//
// Solo tras un `/clear` o `/resume` enviado por ULTRON: durante 30 s se
// adopta el `.jsonl` **creado** después de ese envío cuyo `sessionId` de la
// primera línea no sea el actual y que ninguna otra sesión reclame. Con
// puente no se adopta nada: el cambio llega por el `hello` (§6.5) y un
// `claude -p` hijo en el mismo cwd (hooks de fin de sesión) crea su propio
// transcript en esa ventana y pisaba el sid del `hello`. Nunca se adopta por
// fecha de modificación.
//
// Propiedad: WP-ESTADO.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

use crate::sesiones::registro::{self, FollowTarget};
use crate::sesiones::types::ev;

const VENTANA: Duration = Duration::from_secs(30);
/// Comandos que cambian de conversación dentro de la TUI.
pub const CAMBIAN_CONVERSACION: &[&str] = &["clear", "new", "reset", "resume", "continue"];

/// Envío del cambio y `claudeSessionId` vigente en ese momento.
type Marca = (SystemTime, Option<String>);

fn marcas() -> &'static Mutex<HashMap<String, Marca>> {
    static M: OnceLock<Mutex<HashMap<String, Marca>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// ULTRON acaba de escribir un comando que cambia de conversación.
pub fn marcar_cambio_conversacion(id: &str) {
    let actual = registro::read(id, |s| s.info.claude_session_id.clone())
        .ok()
        .flatten();
    if let Ok(mut m) = marcas().lock() {
        m.insert(id.to_string(), (SystemTime::now(), actual));
    }
}

/// `sessionId` de la primera línea de un transcript.
fn sid_primera_linea(p: &Path) -> Option<String> {
    let f = std::fs::File::open(p).ok()?;
    let mut linea = String::new();
    BufReader::new(f).read_line(&mut linea).ok()?;
    let v: Value = serde_json::from_str(linea.trim()).ok()?;
    v.get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Transcript creado tras `desde` en `dir` con otro `sessionId`.
pub fn candidato(
    dir: &Path,
    desde: SystemTime,
    actual: Option<&str>,
    reclamados: &[PathBuf],
) -> Option<(PathBuf, String)> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("jsonl"))
        .filter(|p| !reclamados.contains(p))
        .filter_map(|p| {
            let creado = std::fs::metadata(&p).and_then(|m| m.created()).ok()?;
            (creado >= desde).then_some(p)
        })
        .filter_map(|p| sid_primera_linea(&p).map(|sid| (p, sid)))
        .find(|(_, sid)| Some(sid.as_str()) != actual)
}

/// Revisa la sesión si hay un cambio de conversación pendiente.
pub(super) fn revisar(t: &FollowTarget) {
    let marca = marcas().lock().ok().and_then(|m| m.get(&t.id).cloned());
    let Some((desde, actual)) = marca else {
        return;
    };
    let caducada = desde.elapsed().map_or(true, |d| d > VENTANA);
    let con_puente = registro::read(&t.id, |s| s.info.bridge_connected).unwrap_or(false);
    if caducada || con_puente {
        quitar(&t.id);
        return;
    }
    let reclamados = registro::claimed_transcripts(&t.id);
    let Some((p, sid)) = candidato(&t.slug_dir, desde, actual.as_deref(), &reclamados) else {
        return;
    };
    quitar(&t.id);
    let _ = registro::update(&t.id, |s| {
        s.transcript = Some(p.clone());
        s.sid_confirmed = true;
        s.info.claude_session_id = Some(sid.clone());
        s.live_agents.clear();
        (true, ())
    });
    registro::emit(ev::RESET, json!({ "id": t.id, "claudeSessionId": sid }));
}

fn quitar(id: &str) {
    if let Ok(mut m) = marcas().lock() {
        m.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn escribir(dir: &Path, nombre: &str, sid: &str) -> PathBuf {
        let p = dir.join(nombre);
        std::fs::write(&p, format!("{{\"sessionId\":\"{sid}\"}}\n")).expect("escribir");
        p
    }

    #[test]
    fn con_puente_no_adopta_el_transcript_de_un_hijo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let id = format!("adop-{}", uuid::Uuid::new_v4());
        let del_hello = dir.path().join("nuevo.jsonl");
        let mut s = registro::sesion_de_prueba(&id);
        s.slug_dir = dir.path().to_path_buf();
        s.info.bridge_connected = true;
        s.info.claude_session_id = Some("nuevo".into());
        s.transcript = Some(del_hello.clone());
        s.sid_confirmed = true;
        registro::insert(s).expect("alta");
        marcar_cambio_conversacion(&id);
        // La fecha de creación de NTFS va con reloj grueso (~16 ms).
        std::thread::sleep(Duration::from_millis(100));
        escribir(dir.path(), "hijo.jsonl", "hijo");
        let t = FollowTarget {
            id: id.clone(),
            claude_session_id: Some("nuevo".into()),
            slug_dir: dir.path().to_path_buf(),
            transcript: Some(del_hello.clone()),
            sid_confirmed: true,
        };
        revisar(&t);
        let (transcript, sid) = registro::read(&id, |s| {
            (s.transcript.clone(), s.info.claude_session_id.clone())
        })
        .expect("leer");
        assert_eq!(transcript, Some(del_hello), "manda el hello");
        assert_eq!(sid.as_deref(), Some("nuevo"));
    }

    #[test]
    fn adopta_solo_el_creado_tras_el_envio_con_otro_sid() {
        let dir = tempfile::tempdir().expect("tempdir");
        let viejo = escribir(dir.path(), "viejo.jsonl", "otro-viejo");
        let desde = SystemTime::now() + Duration::from_secs(3600);
        assert!(
            candidato(dir.path(), desde, Some("a"), &[]).is_none(),
            "creado antes del envío: no"
        );
        let antes = SystemTime::now() - Duration::from_secs(5);
        escribir(dir.path(), "a.jsonl", "a");
        let r = candidato(dir.path(), antes, Some("a"), std::slice::from_ref(&viejo));
        assert_eq!(r, None, "el propio sid y el reclamado no cuentan");
        let nuevo = escribir(dir.path(), "b.jsonl", "b");
        let r = candidato(dir.path(), antes, Some("a"), &[viejo]);
        assert_eq!(r, Some((nuevo, "b".to_string())));
    }
}
