// sesiones/seguidor.rs — Seguidor de transcripts JSONL de las sesiones vivas
// (contrato de estabilidad, §1.4, §5.1-§5.3).
//
// Un único hilo sondea el transcript principal y los de subagentes de cada
// sesión (cada 100 ms la que está en working; cada 500 ms las demás, también
// en waiting: un ask o un menú no producen líneas), parsea solo las líneas nuevas completas y emite
// `sesiones://messages` (en lotes) y `sesiones://agents`. De cada línea del
// hilo principal salen las señales `Tx*` y la actividad para la máquina y
// las operaciones de la cola nativa para `cola`; los prompts se emparejan
// con la cola (`clientId`) y el texto del asistente con el stream en vivo
// (`streamKey`). El transcript es el de la sesión (puente o
// `<claudeSessionId>.jsonl`): no se adopta ningún fichero por fecha de
// modificación (`chat-orden:F15`, `EST-10`). La única adopción sin puente es
// la de `seguidor_adopcion.rs`, tras un `/clear` o `/resume` enviado por
// ULTRON. Cada vuelta corre bajo `catch_unwind` (`seguridad-robustez:F11`).
//
// Sesiones largas (CONTRATO-v3 §7): un transcript que ya existía antes de
// empezar a seguir la sesión (`--resume`, `hello` hacia un sid antiguo o
// tras reiniciar el seguidor) se abre en puesta al día: su historia solo
// alimenta el estado de parseo, sin señales, cola ni mensajes (el frontend
// la pide paginando `sesiones_history`). Si el fichero encoge o se
// sustituye, se emite `sesiones://reset` y se reabre igual.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};

use super::registro::{self, FollowTarget};
use super::senales::{self, Senal};
use super::titulo::{self, OrigenTitulo};
use super::transcript::{clases, first_user_text, parse_value};
use super::types::{ev, Block, ChatMessage, MessageKind, SessionStatus};
use super::{agentes, buzon, cola, puente_eventos, workflows};

#[path = "seguidor_adopcion.rs"]
mod adopcion;
#[path = "seguidor_agentes.rs"]
mod agentes_seguidos;
#[path = "seguidor_cursor.rs"]
pub mod cursor;
pub use adopcion::{marcar_cambio_conversacion, CAMBIAN_CONVERSACION};
pub use cursor::Cursor;

const TICK_ACTIVO: Duration = Duration::from_millis(100);
const TICK_REPOSO: Duration = Duration::from_millis(500);
/// Mensajes por evento `sesiones://messages`.
const BATCH: usize = 200;

struct Follow {
    /// Cuándo se empezó a seguir la sesión: lo creado antes es historia.
    desde: SystemTime,
    main: Option<Cursor>,
    agents: agentes_seguidos::Agentes,
    workflows: workflows::seguidor::Workflows,
    /// Última vuelta de esta sesión: en reposo se sigue cada `TICK_REPOSO`.
    ultima_vuelta: Option<Instant>,
}

impl Follow {
    fn nuevo() -> Self {
        Self {
            desde: SystemTime::now(),
            main: None,
            agents: agentes_seguidos::Agentes::default(),
            workflows: workflows::seguidor::Workflows::default(),
            ultima_vuelta: None,
        }
    }
}

/// Cursor de `path`: en puesta al día si el fichero se creó antes de
/// `desde` o si nació con historia copiada (`/branch`, `--fork-session`): su
/// contenido ya es historia.
pub fn abrir_cursor(path: PathBuf, desde: SystemTime) -> Cursor {
    abrir_cursor_de(path, desde, true)
}

/// Como `abrir_cursor`, según cómo se lanzó la sesión. Sin historia esperada
/// (sesión nueva), la CLI crea el fichero al enviar el primer prompt y vuelca
/// antes los `attachment` del arranque con su hora: eso no es historia. Solo
/// cuenta como copia una respuesta del asistente anterior a la creación (un
/// `/branch` dentro de la TUI), que en una sesión nueva no puede existir.
pub fn abrir_cursor_de(path: PathBuf, desde: SystemTime, historia_esperada: bool) -> Cursor {
    let creado = std::fs::metadata(&path).and_then(|m| m.created()).ok();
    let solo_respuestas = !historia_esperada;
    let previo = creado.is_some_and(|c| c < desde || trae_historia(&path, c, solo_respuestas));
    if previo {
        Cursor::al_dia(path)
    } else {
        Cursor::new(path)
    }
}

/// Margen entre la primera línea de un transcript y la creación del fichero
/// por encima del cual sus líneas son copia de otra conversación.
const MARGEN_HISTORIA: Duration = Duration::from_secs(5);
/// Bytes que se miran para encontrar la primera línea con `timestamp`.
const CABECERA: u64 = 64 * 1024;

/// El fichero nació con líneas anteriores a su creación: una bifurcación
/// copia la conversación entera con sus `timestamp` originales. Con
/// `solo_respuestas`, solo miran las líneas `assistant`.
fn trae_historia(path: &Path, creado: SystemTime, solo_respuestas: bool) -> bool {
    use std::io::{BufRead, BufReader, Read};
    let Ok(f) = std::fs::File::open(path) else {
        return false;
    };
    let primera = BufReader::new(f.take(CABECERA))
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str::<Value>(&l).ok())
        .filter(|v| !solo_respuestas || v.get("type").and_then(Value::as_str) == Some("assistant"))
        .find_map(|v| {
            v.get("timestamp")
                .and_then(Value::as_str)
                .and_then(instante)
        });
    primera.is_some_and(|t| t + MARGEN_HISTORIA < creado)
}

fn instante(iso: &str) -> Option<SystemTime> {
    let d = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
    let ms = u64::try_from(d.timestamp_millis()).ok()?;
    Some(SystemTime::UNIX_EPOCH + Duration::from_millis(ms))
}

pub fn start() {
    std::thread::Builder::new()
        .name("sesiones-seguidor".into())
        .spawn(|| {
            let mut follows: HashMap<String, Follow> = HashMap::new();
            loop {
                let pausa = match catch_unwind(AssertUnwindSafe(|| tick(&mut follows))) {
                    Ok(p) => p,
                    Err(_) => {
                        tracing::error!("pánico en el seguidor de transcripts: se reinicia");
                        follows.clear();
                        TICK_REPOSO
                    }
                };
                std::thread::sleep(pausa);
            }
        })
        .map(|_| ())
        .unwrap_or_else(|e| tracing::error!(error = %e, "no se pudo arrancar el seguidor"));
}

/// Una vuelta: sigue cada sesión, da el `Tick` a la máquina y caduca el
/// buzón. Devuelve la pausa hasta la siguiente.
fn tick(follows: &mut HashMap<String, Follow>) -> Duration {
    let targets = registro::follow_targets();
    follows.retain(|id, _| {
        let sigue = targets.iter().any(|t| &t.id == id);
        if !sigue {
            agentes::olvidar_nodos(id);
            workflows::seguidor::olvidar(id);
        }
        sigue
    });
    let mut activo = false;
    for t in targets {
        let f = follows.entry(t.id.clone()).or_insert_with(Follow::nuevo);
        let ahora = Instant::now();
        let rapida = cadencia_rapida(registro::read(&t.id, |s| s.info.status).ok());
        if !toca_seguir(rapida, f.ultima_vuelta, ahora) {
            continue;
        }
        f.ultima_vuelta = Some(ahora);
        follow_one(&t, f);
        senales::emitir(&t.id, Senal::Tick);
        activo |= cadencia_rapida(registro::read(&t.id, |s| s.info.status).ok());
    }
    buzon::caducar();
    if activo {
        TICK_ACTIVO
    } else {
        TICK_REPOSO
    }
}

/// Cadencia rápida (hallazgo nocturno 4): solo en working, que es cuando el
/// transcript crece. Un ask o un menú (waiting) de madrugada ya no pone todas
/// las sesiones a 10 Hz hasta que alguien conteste.
fn cadencia_rapida(status: Option<SessionStatus>) -> bool {
    status == Some(SessionStatus::Working)
}

/// Una sesión fuera de working se sigue como mucho cada `TICK_REPOSO`,
/// aunque otra sesión mantenga el hilo a `TICK_ACTIVO`.
fn toca_seguir(rapida: bool, ultima: Option<Instant>, ahora: Instant) -> bool {
    rapida || ultima.is_none_or(|u| ahora.saturating_duration_since(u) >= TICK_REPOSO)
}

/// Transcript de la sesión: el que fijó el puente o `<sid>.jsonl`. Uno
/// provisional (el `hello` lo fijó antes de que existiera) solo cuenta cuando
/// el fichero aparece; hasta entonces se sigue con el anterior.
fn locate(t: &FollowTarget) -> Option<PathBuf> {
    if let Some(p) = &t.transcript {
        if t.sid_confirmed || p.is_file() {
            return Some(p.clone());
        }
    }
    let sid = t.claude_session_id.as_ref()?;
    let p = t.slug_dir.join(format!("{sid}.jsonl"));
    p.is_file().then_some(p)
}

fn follow_one(t: &FollowTarget, f: &mut Follow) {
    adopcion::revisar(t);
    if let Some(p) = locate(t) {
        if f.main.as_ref().map(|c| &c.path) != Some(&p) {
            if f.main.is_some() {
                // Otra conversación: el lote pendiente del transcript anterior
                // se descarta con su cursor y el título automático se reabre.
                let _ = registro::update(&t.id, |s| {
                    s.titulo = s.titulo.tras_cambio_de_conversacion();
                    (false, ())
                });
            }
            let c = abrir_cursor_de(p.clone(), f.desde, registro::historia_esperada(&t.id));
            // La historia de un cursor en puesta al día no sale en vivo: el
            // reset hace que el cliente la pida paginada ya con el cursor
            // abierto (cubre el hueco entre un reset anterior y esta apertura
            // y el reinicio del seguidor tras un pánico).
            if c.en_puesta_al_dia() {
                emitir_reset(&t.id, &p);
            }
            f.main = Some(c);
            f.agents.clear();
            agentes::olvidar_nodos(&t.id);
            f.workflows.clear();
            workflows::seguidor::olvidar(&t.id);
        }
        if t.transcript.as_ref() != Some(&p) || !t.sid_confirmed {
            fijar_transcript(&t.id, &p);
        }
    }
    let mut out: Vec<ChatMessage> = Vec::new();
    if let Some(c) = f.main.as_mut() {
        let lote = leer_principal(c);
        if lote.reiniciado {
            emitir_reset(&t.id, &c.path);
        }
        if let Some(m) = &lote.titulo {
            maybe_title(&t.id, m);
        }
        for (v, m) in lote.vivas {
            linea_principal(&t.id, &v);
            super::relevo::observe(&t.id, &v, &c.path);
            if let Some(m) = m {
                out.push(mensaje_principal(&t.id, m));
            }
        }
        super::relevo::poll_return(&t.id);
        // Después de los prompts del lote: el resumen gana al título del prompt.
        if let Some(ia) = &lote.titulo_ia {
            titulo_de_ia(&t.id, ia);
        }
    }
    let sid = f.main.as_ref().and_then(|c| sid_de(&c.path));
    let agents_changed = sid
        .as_deref()
        .is_some_and(|sid| f.agents.seguir(t, sid, f.desde, &mut out));
    if let Some(sid) = sid.as_deref() {
        seguir_workflows(t, sid, &mut f.workflows);
    }
    for chunk in out.chunks(BATCH) {
        registro::emit(ev::MESSAGES, json!({ "id": t.id, "messages": chunk }));
    }
    if agents_changed {
        super::gestor::emit_agents(&t.id);
    }
}

/// Emite los runs de `Workflow` que cambiaron (antes que los mensajes: la
/// tarjeta ya existe cuando llega el resultado de la llamada).
fn seguir_workflows(t: &FollowTarget, sid: &str, w: &mut workflows::seguidor::Workflows) {
    let sub = agentes::subagents_dir(&t.slug_dir, sid);
    let Some(sesion_dir) = sub.parent() else {
        return;
    };
    let proceso = registro::read(&t.id, workflows::seguidor::proceso_de)
        .ok()
        .flatten();
    let cambiados = w.seguir_y_guardar(&t.id, sesion_dir, proceso, Instant::now());
    for run in &cambiados {
        registro::emit(ev::WORKFLOW, json!({ "id": t.id, "run": run }));
    }
}

fn sid_de(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string)
}

/// Lote del hilo principal ya parseado.
#[derive(Default)]
struct LotePrincipal {
    /// Líneas vivas con su mensaje (si lo hay).
    vivas: Vec<(Value, Option<ChatMessage>)>,
    /// Primer prompt de la historia recorrida (para el título automático).
    titulo: Option<ChatMessage>,
    /// Último resumen de Claude Code (`ai-title`) del lote, histórico o vivo.
    titulo_ia: Option<String>,
    reiniciado: bool,
}

/// Lee el transcript principal. Toda línea actualiza el estado de parseo;
/// las históricas no producen señales, cola ni mensajes.
fn leer_principal(c: &mut Cursor) -> LotePrincipal {
    let l = c.leer();
    let mut lote = LotePrincipal {
        reiniciado: l.reiniciado,
        ..LotePrincipal::default()
    };
    for v in l.lineas {
        if let Some(t) = titulo::titulo_ia(&v) {
            lote.titulo_ia = Some(t.to_string());
        }
        let m = parse_value(&v, None, &mut c.state);
        if !l.historicas {
            lote.vivas.push((v, m));
            continue;
        }
        let es_titulo = m
            .as_ref()
            .is_some_and(|m| m.kind == MessageKind::Prompt && first_user_text(m).is_some());
        if lote.titulo.is_none() && es_titulo {
            lote.titulo = m;
        }
    }
    lote
}

/// El transcript encogió o se sustituyó: el frontend recarga su historial.
fn emitir_reset(id: &str, path: &Path) {
    tracing::info!(
        sesion = id,
        "transcript reescrito: se reinicia el historial"
    );
    registro::emit(
        ev::RESET,
        json!({ "id": id, "claudeSessionId": sid_de(path) }),
    );
}

/// Señales y cola nativa de una línea del hilo principal.
fn linea_principal(id: &str, v: &Value) {
    let principal =
        v.get("agentId").is_none() && v.get("isSidechain").and_then(Value::as_bool) != Some(true);
    if !principal {
        return;
    }
    senales::emitir(id, Senal::Actividad { agent_id: None });
    for s in clases::senales(v) {
        senales::emitir(id, s);
    }
    if let Some(op) = clases::op_cola(v) {
        if let Some(aviso) = cola::global().op_cli(id, &op, buzon::ahora_ms()) {
            registro::emit(
                ev::NOTICE,
                json!({ "id": id, "level": "info", "text": aviso }),
            );
        }
        cola::emitir_actual(id);
    }
}

/// Título, `clientId` de la cola y `streamKey` del stream en vivo.
fn mensaje_principal(id: &str, mut m: ChatMessage) -> ChatMessage {
    maybe_title(id, &m);
    if m.kind == MessageKind::TaskNotification {
        // Evidencia para `recuperacion::interrumpir`: la CLI retoma el turno
        // con la notificación de un subagente en segundo plano.
        super::recuperacion::anotar_tarea(id);
    }
    let ahora = buzon::ahora_ms();
    let par = match (m.role.as_str(), m.kind) {
        ("user", MessageKind::Prompt) => {
            cola::global().entregado(id, &texto_de(&m), &m.uuid, m.queued, ahora)
        }
        // Un `!comando` llega como `<bash-input>` (mensaje de sistema): sin
        // esto su envío nunca se emparejaba y acababa en `failed` aunque se
        // hubiera ejecutado.
        (_, MessageKind::Bash) => m
            .command
            .as_ref()
            .and_then(|c| cola::global().bash_entregado(id, &c.args, &m.uuid, m.queued, ahora)),
        _ => None,
    };
    if let Some(p) = par {
        m.client_id = Some(p.client_id);
        cola::emitir_actual(id);
    }
    puente_eventos::stream::emparejar_mensaje(id, &mut m);
    m
}

fn texto_de(m: &ChatMessage) -> String {
    m.blocks
        .iter()
        .find_map(|b| match b {
            Block::Text { text } => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

/// Fija el transcript y el id de Claude (sin tocar el estado: lo decide la
/// máquina).
fn fijar_transcript(id: &str, path: &Path) {
    let sid = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string);
    let _ = registro::update(id, |s| {
        s.transcript = Some(path.to_path_buf());
        s.sid_confirmed = true;
        let ch = sid.is_some() && s.info.claude_session_id != sid;
        if ch {
            s.info.claude_session_id = sid.clone();
        }
        (ch, ())
    });
}

fn maybe_title(id: &str, m: &ChatMessage) {
    let Some(text) = first_user_text(m) else {
        return;
    };
    if m.kind != MessageKind::Prompt {
        return;
    }
    let title = super::gestor::title_from(&text);
    if title.is_empty() {
        return;
    }
    let _ = registro::update(id, |s| {
        if s.titulo == OrigenTitulo::Legado {
            s.titulo = OrigenTitulo::resolver_legado(&s.info.title, &title);
            return (false, ());
        }
        if !s.titulo.acepta_prompt() {
            return (false, ());
        }
        s.titulo = OrigenTitulo::Prompt;
        s.info.title = title;
        (true, ())
    });
}

/// El resumen de Claude Code (`ai-title`) como título, salvo que se haya
/// renombrado a mano. Acotado como el del prompt; repetido, no reemite.
fn titulo_de_ia(id: &str, ia: &str) {
    let title = super::gestor::title_from(ia);
    if title.is_empty() {
        return;
    }
    let _ = registro::update(id, |s| {
        if !s.titulo.acepta_ia() || (s.titulo == OrigenTitulo::Ia && s.info.title == title) {
            return (false, ());
        }
        s.titulo = OrigenTitulo::Ia;
        s.info.title = title;
        (true, ())
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Hallazgo nocturno 4: waiting no fuerza los 10 Hz; solo working.
    #[test]
    fn solo_working_fuerza_la_cadencia_rapida() {
        assert!(cadencia_rapida(Some(SessionStatus::Working)));
        for s in [
            SessionStatus::Waiting,
            SessionStatus::Idle,
            SessionStatus::Starting,
            SessionStatus::Exited,
        ] {
            assert!(!cadencia_rapida(Some(s)), "{s:?}");
        }
        assert!(!cadencia_rapida(None));
    }

    /// Fuera de working, una sesión se sigue cada `TICK_REPOSO` aunque el
    /// hilo vaya a 100 ms por otra sesión en working.
    #[test]
    fn en_reposo_se_sigue_cada_tick_de_reposo() {
        let t = Instant::now();
        assert!(toca_seguir(false, None, t), "la primera vuelta siempre");
        assert!(!toca_seguir(false, Some(t), t + TICK_ACTIVO));
        assert!(!toca_seguir(false, Some(t), t + Duration::from_millis(499)));
        assert!(toca_seguir(false, Some(t), t + TICK_REPOSO));
        assert!(
            toca_seguir(true, Some(t), t + TICK_ACTIVO),
            "working: cada vuelta"
        );
    }

    fn prompt(u: &str, texto: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"{u}","timestamp":"t","message":{{"role":"user","content":"{texto}"}}}}"#
        )
    }

    fn respuesta(u: &str, id: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"{u}","timestamp":"t","message":{{"id":"{id}","role":"assistant","content":[{{"type":"text","text":"r"}}],"usage":{{"input_tokens":5,"output_tokens":3}}}}}}"#
        )
    }

    fn escribir(p: &Path, lineas: &[String]) {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
            .expect("abrir");
        for l in lineas {
            writeln!(f, "{l}").expect("escribir");
        }
    }

    fn uuids(lote: &LotePrincipal) -> Vec<String> {
        lote.vivas
            .iter()
            .filter_map(|(_, m)| m.as_ref().map(|m| m.uuid.clone()))
            .collect()
    }

    #[test]
    fn en_puesta_al_dia_solo_lo_nuevo_produce_senales_y_mensajes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("viejo.jsonl");
        let previas: Vec<String> = (0..50)
            .flat_map(|i| {
                [
                    prompt(&format!("u{i}"), "hola"),
                    respuesta(&format!("a{i}"), &format!("m{i}")),
                ]
            })
            .collect();
        escribir(&p, &previas);
        let mut c = abrir_cursor(p.clone(), SystemTime::now() + Duration::from_secs(3_600));
        assert!(c.en_puesta_al_dia(), "creado antes de seguir la sesión");
        let lote = leer_principal(&mut c);
        assert!(lote.vivas.is_empty(), "la historia no se reemite");
        assert_eq!(lote.titulo.map(|m| m.uuid).as_deref(), Some("u0"));
        escribir(&p, &[respuesta("a49b", "m49"), prompt("u50", "nuevo")]);
        let lote = leer_principal(&mut c);
        assert_eq!(uuids(&lote), ["a49b", "u50"]);
        assert_eq!(lote.vivas.len(), 2, "solo las líneas nuevas llevan señales");
        let a = lote.vivas[0].1.as_ref().expect("mensaje");
        assert!(
            a.usage.is_none(),
            "el estado de parseo vio m49 en la historia"
        );
    }

    #[test]
    fn un_transcript_nuevo_se_emite_entero() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("nuevo.jsonl");
        escribir(&p, &[prompt("u0", "hola"), respuesta("a0", "m0")]);
        let mut c = abrir_cursor(p.clone(), SystemTime::UNIX_EPOCH);
        assert!(!c.en_puesta_al_dia(), "creado después de empezar a seguir");
        let lote = leer_principal(&mut c);
        assert_eq!(uuids(&lote), ["u0", "a0"]);
        assert!(lote.titulo.is_none());
    }

    #[test]
    fn si_el_transcript_encoge_se_reinicia_sin_reemitir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("t.jsonl");
        escribir(&p, &[prompt("u0", "hola"), respuesta("a0", "m0")]);
        let mut c = Cursor::new(p.clone());
        assert_eq!(leer_principal(&mut c).vivas.len(), 2);
        std::fs::write(&p, prompt("x0", "otro") + "\n").expect("reescribir");
        let lote = leer_principal(&mut c);
        assert!(lote.reiniciado);
        assert!(lote.vivas.is_empty(), "lo que ya hay se pide paginando");
        escribir(&p, &[respuesta("x1", "n1")]);
        let lote = leer_principal(&mut c);
        assert!(!lote.reiniciado);
        assert_eq!(uuids(&lote), ["x1"]);
    }

    fn objetivo(dir: &Path, sid: Option<&str>) -> FollowTarget {
        FollowTarget {
            id: "s".into(),
            claude_session_id: sid.map(str::to_string),
            slug_dir: dir.to_path_buf(),
            transcript: None,
            sid_confirmed: false,
        }
    }

    #[test]
    fn no_adopta_un_jsonl_ajeno_modificado_tras_el_spawn() {
        let dir = tempfile::tempdir().expect("tempdir");
        let t = objetivo(dir.path(), None);
        std::fs::write(dir.path().join("ajeno.jsonl"), "{}\n").expect("ajeno");
        assert_eq!(locate(&t), None, "sin sid ni puente no se adopta nada");
        let t = objetivo(dir.path(), Some("mio"));
        assert_eq!(locate(&t), None, "su fichero aún no existe");
        std::fs::write(dir.path().join("mio.jsonl"), "{}\n").expect("mio");
        assert_eq!(locate(&t), Some(dir.path().join("mio.jsonl")));
    }

    #[test]
    fn un_transcript_provisional_no_cuenta_hasta_que_existe() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("ruta-del-hello.jsonl");
        let mut t = objetivo(dir.path(), Some("ajeno"));
        t.transcript = Some(p.clone());
        assert_eq!(locate(&t), None, "se sigue con el transcript anterior");
        std::fs::write(&p, "{}\n").expect("crear");
        assert_eq!(locate(&t), Some(p), "al aparecer, se adopta");
    }

    #[test]
    fn una_bifurcacion_con_historia_copiada_se_abre_en_puesta_al_dia() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("rama.jsonl");
        let copia = r#"{"type":"user","uuid":"u0","timestamp":"2020-01-01T00:00:00.000Z","message":{"role":"user","content":"viejo"}}"#;
        escribir(&p, &[copia.to_string(), respuesta("a0", "m0")]);
        let c = abrir_cursor(p, SystemTime::UNIX_EPOCH);
        assert!(c.en_puesta_al_dia(), "la historia copiada no sale en vivo");
        let q = dir.path().join("clear.jsonl");
        let ahora = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let vivo = format!(
            r#"{{"type":"user","uuid":"u1","timestamp":"{ahora}","message":{{"role":"user","content":"nuevo"}}}}"#
        );
        escribir(&q, &[vivo]);
        let c = abrir_cursor(q, SystemTime::UNIX_EPOCH);
        assert!(!c.en_puesta_al_dia(), "un /clear empieza en vivo");
    }

    struct Nulo;

    impl cola::Escritor for Nulo {
        fn escribir(&self, _: &str, _: &cola::Envio) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn un_bash_enviado_se_empareja_con_su_bash_input() {
        use crate::sesiones::types::{QueueItemInput, QueueItemKind, QueueState, ScreenState};
        let id = format!("bash-{}", uuid::Uuid::new_v4());
        let input = QueueItemInput {
            client_id: "b1".into(),
            text: "!echo  hola".into(),
            attachments: Vec::new(),
            delegate: false,
            kind: QueueItemKind::Bash,
        };
        cola::global().encolar(&id, input, 0).expect("encolar");
        let ctx = cola::Contexto {
            status: SessionStatus::Idle,
            screen: ScreenState::Prompt,
            protocolo: 0,
            terminal: false,
            limite: false,
        };
        let enviado = cola::global().drenar(&id, ctx, &Nulo, 0).expect("drenar");
        assert_eq!(enviado.as_deref(), Some("b1"));
        let linea: Value = serde_json::from_str(
            r#"{"type":"user","uuid":"bi","timestamp":"t","message":{"role":"user","content":"<bash-input>echo hola</bash-input>"}}"#,
        )
        .expect("json");
        let m = parse_value(&linea, None, &mut Default::default()).expect("mensaje");
        assert_eq!(m.kind, MessageKind::Bash);
        let m = mensaje_principal(&id, m);
        assert_eq!(m.client_id.as_deref(), Some("b1"));
        let estado = cola::global().lista(&id, 1)[0].state;
        assert_eq!(estado, QueueState::Delivered, "no acaba en failed");
        cola::global().olvidar(&id);
    }

    fn drenar_prompt(id: &str, client_id: &str, texto: &str) {
        use crate::sesiones::types::{QueueItemInput, QueueItemKind, ScreenState};
        let input = QueueItemInput {
            client_id: client_id.into(),
            text: texto.into(),
            attachments: Vec::new(),
            delegate: false,
            kind: QueueItemKind::Prompt,
        };
        cola::global().encolar(id, input, 0).expect("encolar");
        let ctx = cola::Contexto {
            status: SessionStatus::Idle,
            screen: ScreenState::Prompt,
            protocolo: 0,
            terminal: false,
            limite: false,
        };
        let enviado = cola::global().drenar(id, ctx, &Nulo, 0).expect("drenar");
        assert_eq!(enviado.as_deref(), Some(client_id));
    }

    /// Línea con la estructura real de Claude Code 2.1.296 para un pegado
    /// largo: `\n\n<pasted_content id=…>\n…\n</pasted_content id=…>\n`. El
    /// mensaje lleva el `clientId` del envío y la cola no lo deja en sending.
    #[test]
    fn un_pegado_largo_del_transcript_lleva_el_client_id_de_su_envio() {
        use crate::sesiones::types::QueueState;
        let id = format!("pegado-{}", uuid::Uuid::new_v4());
        drenar_prompt(
            &id,
            "p1",
            "revisa esto:\n❯ /mcp\n  ⎿  Failed to reconnect\n\nfin",
        );
        let linea = r#"{"type":"user","uuid":"up","timestamp":"2026-10-13T13:12:52.000Z","message":{"role":"user","content":"\n\n<pasted_content id=\"2218\">\nrevisa esto:\n❯ /mcp\n  ⎿  Failed to reconnect\n\nfin\n</pasted_content id=\"2218\">\n"}}"#;
        let v: Value = serde_json::from_str(linea).expect("json");
        let m = parse_value(&v, None, &mut Default::default()).expect("mensaje");
        assert_eq!(m.kind, MessageKind::Prompt);
        let m = mensaje_principal(&id, m);
        assert_eq!(m.client_id.as_deref(), Some("p1"));
        let estado = cola::global().lista(&id, 1)[0].state;
        assert_eq!(estado, QueueState::Delivered);
        // Caso negativo: otro pegado no lleva el clientId de nadie.
        let ajena = linea
            .replace("revisa esto", "otra cosa")
            .replace("\"up\"", "\"uq\"");
        let v: Value = serde_json::from_str(&ajena).expect("json");
        let m = parse_value(&v, None, &mut Default::default()).expect("mensaje");
        assert_eq!(mensaje_principal(&id, m).client_id, None);
        cola::global().olvidar(&id);
    }

    fn iso_hace(segundos: i64) -> String {
        (chrono::Utc::now() - chrono::Duration::seconds(segundos))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    /// Sesión nueva: la CLI crea el `.jsonl` al enviar el primer prompt y
    /// vuelca antes los `attachment` del arranque con su hora. Antes se abría
    /// en puesta al día y el primer lote no salía en vivo (ni cola ni señales).
    #[test]
    fn una_sesion_nueva_con_el_primer_prompt_tardio_se_sigue_en_vivo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("nueva.jsonl");
        let arranque = iso_hace(30);
        let mut lineas: Vec<String> = (0..4)
            .map(|i| format!(r#"{{"type":"attachment","attachment":{{"type":"hook_success","hookName":"SessionStart:startup"}},"uuid":"h{i}","timestamp":"{arranque}"}}"#))
            .collect();
        let ahora = iso_hace(0);
        lineas.push(format!(r#"{{"type":"user","uuid":"u0","timestamp":"{ahora}","message":{{"role":"user","content":"hola"}}}}"#));
        escribir(&p, &lineas);
        let desde = SystemTime::now() - Duration::from_secs(60);
        let mut c = abrir_cursor_de(p.clone(), desde, false);
        assert!(!c.en_puesta_al_dia(), "el primer prompt no es historia");
        assert!(uuids(&leer_principal(&mut c)).contains(&"u0".to_string()));
        // Caso negativo: lanzada retomando o bifurcando, el mismo fichero sí
        // se trata como historia copiada.
        assert!(abrir_cursor_de(p, desde, true).en_puesta_al_dia());
    }

    /// Un `/branch` dentro de la TUI de una sesión nueva copia respuestas con
    /// su hora original: sigue abriéndose en puesta al día.
    #[test]
    fn un_branch_en_una_sesion_nueva_sigue_siendo_historia() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("rama.jsonl");
        let copia = r#"{"type":"assistant","uuid":"a0","timestamp":"2020-01-01T00:00:00.000Z","message":{"id":"m0","role":"assistant","content":[{"type":"text","text":"r"}]}}"#;
        escribir(&p, &[prompt("u0", "viejo"), copia.to_string()]);
        let desde = SystemTime::now() - Duration::from_secs(60);
        assert!(abrir_cursor_de(p, desde, false).en_puesta_al_dia());
    }
}

#[cfg(test)]
#[path = "tests_seguidor_titulo.rs"]
mod tests_titulo;
