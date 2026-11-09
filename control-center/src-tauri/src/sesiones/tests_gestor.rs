// sesiones/tests_gestor.rs — Bytes de `sesiones_send`, teclas, arranque de
// `sesiones_create` y G3 con la pantalla emulada.

use std::io::{self, Write};
use std::sync::Mutex;
use std::time::Instant;

use super::*;
use crate::sesiones::caja;

#[test]
fn send_envuelve_en_bracketed_paste() {
    let b = paste_bytes("hola\nmundo", &[]).expect("bytes");
    assert_eq!(b, b"\x1b[200~hola\nmundo\x1b[201~".to_vec());
}

#[test]
fn send_menciona_adjuntos_con_arroba_y_comillas() {
    let atts = vec![r"C:\x\a.png".to_string(), "/tmp/b c.pdf".to_string()];
    let b = paste_bytes("mira", &atts).expect("bytes");
    let expected = "\x1b[200~mira @\"C:\\x\\a.png\" @\"/tmp/b c.pdf\"\x1b[201~";
    assert_eq!(String::from_utf8(b).expect("utf8"), expected);
}

#[test]
fn send_no_deja_cerrar_el_pegado_desde_el_texto() {
    let b = paste_bytes("a\x1b[201~rm -rf\r", &[]).expect("bytes");
    let s = String::from_utf8(b).expect("utf8");
    assert_eq!(s, "\x1b[200~a[201~rm -rf\x1b[201~");
    assert_eq!(s.matches("\x1b[201~").count(), 1);
}

/// `seguridad-robustez:F14`: fuera los caracteres de control salvo `\n`/`\t`.
#[test]
fn send_quita_caracteres_de_control() {
    let b = paste_bytes("a\u{3}b\tc\nd\u{7f}e", &[]).expect("bytes");
    assert!(!b.contains(&0x03));
    assert!(!b.contains(&0x7f));
    assert_eq!(b, b"\x1b[200~ab\tc\nde\x1b[201~".to_vec());
}

#[test]
fn send_rechaza_vacio_y_rutas_con_comillas() {
    assert!(paste_bytes("   ", &[]).is_err());
    assert!(paste_bytes("\u{3}", &[]).is_err());
    assert!(paste_bytes("x", &["a\"b".to_string()]).is_err());
    assert!(paste_bytes("x", &["a\nb".to_string()]).is_err());
    assert!(
        paste_bytes("", &["/a.png".to_string()]).is_ok(),
        "solo adjunto"
    );
}

#[test]
fn teclas_de_navegacion_sin_esc_ni_ctrl_c() {
    assert_eq!(tecla_de(KeyName::ShiftTab).bytes(), b"\x1b[Z");
    assert_eq!(tecla_de(KeyName::Up).bytes(), b"\x1b[A");
    assert_eq!(tecla_de(KeyName::Down).bytes(), b"\x1b[B");
    assert_eq!(tecla_de(KeyName::Enter).bytes(), b"\r");
    assert_eq!(tecla_de(KeyName::Tab).bytes(), b"\t");
    for retirada in ["escape", "ctrlC", "raw"] {
        assert!(
            serde_json::from_value::<KeyName>(serde_json::json!(retirada)).is_err(),
            "{retirada} solo sale por sesiones_recover o terminal_input"
        );
    }
}

#[test]
fn titulo_desde_prompt() {
    assert_eq!(
        title_from("\n  Arregla el login  \nmás"),
        "Arregla el login"
    );
    let largo = "á".repeat(80);
    let t = title_from(&largo);
    assert_eq!(t.chars().count(), 61);
    assert!(t.ends_with('…'));
}

fn req(resume: Option<&str>, fork_from: Option<&str>) -> CreateRequest {
    CreateRequest {
        project_id: None,
        cwd: String::new(),
        resume: resume.map(str::to_string),
        model: None,
        effort: None,
        permission_mode: None,
        fork_from: fork_from.map(str::to_string),
    }
}

/// AC-9: las sesiones nuevas llevan su propio `--session-id`; las
/// reanudadas, el sid pedido; las bifurcadas, uno nuevo.
#[test]
fn arranque_segun_la_peticion() {
    const SID: &str = "0bacfbdb-a455-4982-bada-f1fc39a9d205";
    let Arranque::Nueva { sid: a } = arranque_de(&req(None, None)) else {
        panic!("esperaba sesión nueva");
    };
    let Arranque::Nueva { sid: b } = arranque_de(&req(None, None)) else {
        panic!("esperaba sesión nueva");
    };
    assert_ne!(a, b);
    assert!(uuid::Uuid::parse_str(&a).is_ok());
    assert_eq!(
        arranque_de(&req(Some(SID), None)),
        Arranque::Reanudar { sid: SID.into() }
    );
    match arranque_de(&req(Some("ignorado"), Some(SID))) {
        Arranque::Bifurcar { desde, sid } => {
            assert_eq!(desde, SID);
            assert_ne!(sid, SID);
        }
        otro => panic!("esperaba bifurcación: {otro:?}"),
    }
}

/// Retomar una conversación que ya tiene una sesión abierta (viva o
/// terminada) se rechaza; una nueva o una bifurcación de ella, no.
#[test]
fn retomar_una_conversacion_abierta_se_rechaza() {
    const SID: &str = "7c1e2a90-1b2c-4d5e-8f90-a1b2c3d4e5f6";
    let id = format!("prueba-duplicada-{}", uuid::Uuid::new_v4());
    let mut info = info_inicial(
        &id,
        None,
        "/p",
        "Mi sesión".into(),
        SID,
        PermissionMode::Default,
    );
    let reanudar = Arranque::Reanudar { sid: SID.into() };
    let otra = Arranque::Reanudar {
        sid: "0bacfbdb-a455-4982-bada-f1fc39a9d205".into(),
    };
    assert!(
        comprobar_reanudacion(&reanudar).is_ok(),
        "sin sesión abierta"
    );
    registro::insert(Sesion {
        info: info.clone(),
        pty_id: String::new(),
        spawned_at: SystemTime::now(),
        transcript: None,
        sid_confirmed: true,
        slug_dir: PathBuf::from("/p"),
        titulo: crate::sesiones::titulo::OrigenTitulo::Manual,
        live_agents: HashMap::new(),
        historia_esperada: true,
    })
    .expect("alta");
    let e = comprobar_reanudacion(&reanudar).expect_err("debe rechazarse");
    registro::remove(&id);
    assert!(e.contains("7c1e2a90") && e.contains("«Mi sesión»"), "{e}");
    assert!(e.contains("cámbiate a ella"), "{e}");

    let abiertas = [info.clone()];
    let mayus = Arranque::Reanudar {
        sid: SID.to_uppercase(),
    };
    assert!(conversacion_abierta(&abiertas, &mayus).is_some());
    assert!(conversacion_abierta(&abiertas, &otra).is_none());
    let nueva = Arranque::Nueva { sid: SID.into() };
    assert!(conversacion_abierta(&abiertas, &nueva).is_none());
    let rama = Arranque::Bifurcar {
        desde: SID.into(),
        sid: "5f77529a-9be7-4361-87dc-3ad4ea7ac856".into(),
    };
    assert!(conversacion_abierta(&abiertas, &rama).is_none());
    info.status = SessionStatus::Exited;
    assert!(error_conversacion_abierta(&info).contains("Reiniciar"));
}

/// Tras un reinicio, la salida del proceso viejo no pasa la sesión a exited.
#[test]
fn solo_la_salida_del_pty_actual_cuenta() {
    assert!(salida_vigente("pty-nuevo", Some("pty-nuevo")));
    assert!(!salida_vigente("pty-nuevo", Some("pty-viejo")));
    assert!(
        salida_vigente("", Some("pty-inmediato")),
        "antes de fijar el id"
    );
    assert!(salida_vigente("pty-nuevo", None));
}

#[test]
fn create_acepta_los_campos_nuevos_en_camel_case() {
    let r: CreateRequest = serde_json::from_value(serde_json::json!({
        "projectId": null,
        "permissionMode": "bypassPermissions",
        "forkFrom": "abc"
    }))
    .expect("deserializa");
    assert_eq!(r.permission_mode, Some(PermissionMode::BypassPermissions));
    assert_eq!(r.fork_from.as_deref(), Some("abc"));
}

/// `Write` espía compartido.
#[derive(Clone, Default)]
struct Espia(std::sync::Arc<Mutex<Vec<u8>>>);

impl Write for Espia {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.lock().expect("espía").extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Sesión con PTY falso y pantalla alimentada con `sesion-a` hasta `corte`.
fn sesion_con_pantalla(corte: &str) -> (String, Espia) {
    let bytes: &[u8] = include_bytes!("fixtures/tui/sesion-a.ans");
    let indice: HashMap<String, usize> =
        serde_json::from_str(include_str!("fixtures/tui/sesion-a.json")).expect("índice");
    let id = format!("gestor-{}", uuid::Uuid::new_v4());
    let pty = format!("pty-{id}");
    let monitor = Arc::new(Monitor::nuevo(ROWS, COLS));
    monitor.alimentar(&bytes[..indice[corte]]);
    pantalla::registrar(&id, monitor.clone());
    let espia = Espia::default();
    crate::pty::registry::insertar_prueba(
        &pty,
        Box::new(espia.clone()),
        Arc::new(move || monitor.vista()),
    );
    let mut s = registro::sesion_de_prueba(&id);
    s.info.status = SessionStatus::Idle;
    s.pty_id = pty;
    registro::insert(s).expect("alta");
    (id, espia)
}

/// G3 sin puente: con «hola mundo» en la caja de la TUI se manda Ctrl+U;
/// como esta pantalla grabada no repinta, la caja sigue llena, el pegado no
/// sale (error explícito) y el texto, que sigue en la caja, no se reencola
/// (M2). El drenaje automático queda en pausa mientras la caja no cambie
/// (M5). Con la caja vacía, se escribe.
#[test]
fn g3_con_texto_en_la_caja_no_escribe_y_vacia_si() {
    let (id, espia) = sesion_con_pantalla("prompt-texto");
    let e = escribir_pegado(&id, paste_bytes("x", &[]).expect("bytes"), None).expect_err("G3");
    assert!(e.contains("no se pudo vaciar"), "{e}");
    assert_eq!(
        espia.0.lock().expect("espía").clone(),
        b"\x15".to_vec(),
        "solo el Ctrl+U, sin pegado"
    );
    let cola = cola::global().lista(&id, crate::sesiones::buzon::ahora_ms());
    assert!(
        cola.is_empty(),
        "la caja no se vació: nada a la cola: {cola:?}"
    );
    let entrada = || pantalla::actual(&id).entrada;
    for _ in 0..5 {
        assert!(caja::pausas().en_pausa(&id, entrada, Instant::now()));
    }
    caja::pausas().levantar(&id);
    kill(&id).expect("kill");

    let (id, espia) = sesion_con_pantalla("prompt-tras-ctrl-u");
    escribir_pegado(&id, paste_bytes("x", &[]).expect("bytes"), None).expect("pegado");
    assert_eq!(
        espia.0.lock().expect("espía").clone(),
        b"\x1b[200~x\x1b[201~\r".to_vec()
    );
    kill(&id).expect("kill");
}

/// Buzón falso del puente v2: `prompt.read` lee siempre la caja vacía.
struct BuzonCajaVacia(Mutex<Vec<String>>);

impl caja::BuzonOps for BuzonCajaVacia {
    fn op(
        &self,
        _id: &str,
        op: crate::sesiones::buzon::InboxOp,
    ) -> Option<crate::sesiones::types::OpResult> {
        self.0.lock().expect("ops").push(format!("{op:?}"));
        Some(crate::sesiones::types::OpResult {
            ok: true,
            value: Some(serde_json::json!({ "text": "", "cursor": 0 })),
            ..Default::default()
        })
    }
}

/// Falso positivo de la pantalla: con «hola mundo» en la caja según la
/// pantalla y el puente v2 leyéndola vacía, ni Ctrl+U ni nada a la cola ni
/// pausa; el pegado se reintenta tolerando ese texto y sale. Sin puente, la
/// misma pantalla sigue fallando (`g3_con_texto_en_la_caja_no_escribe_y_vacia_si`).
#[test]
fn g3_con_el_puente_leyendo_la_caja_vacia_escribe_el_pegado() {
    let (id, espia) = sesion_con_pantalla("prompt-texto");
    registro::update(&id, |s| {
        s.info.bridge_protocol = 2;
        (false, ())
    })
    .expect("v2");
    assert!(
        pantalla::actual(&id).entrada.is_some(),
        "la pantalla ve texto"
    );
    let buzon = BuzonCajaVacia(Mutex::default());
    pegado::escribir_pegado_con(&id, paste_bytes("x", &[]).expect("bytes"), None, &buzon)
        .expect("pegado");
    assert_eq!(buzon.0.lock().expect("ops").len(), 1, "solo prompt.read");
    assert_eq!(
        espia.0.lock().expect("espía").clone(),
        b"\x1b[200~x\x1b[201~\r".to_vec(),
        "el pegado, sin Ctrl+U"
    );
    let cola = cola::global().lista(&id, crate::sesiones::buzon::ahora_ms());
    assert!(cola.is_empty(), "nada a la cola: {cola:?}");
    let entrada = || pantalla::actual(&id).entrada;
    assert!(!caja::pausas().en_pausa(&id, entrada, Instant::now()));
    kill(&id).expect("kill");
}

/// Buzón falso del puente v2 que lee la caja vacía mientras el usuario
/// teclea en la terminal adjunta: durante `prompt.read` la pantalla emulada
/// recibe más texto en la caja.
struct BuzonUsuarioTecleando {
    id: String,
    ops: Mutex<Vec<String>>,
}

impl caja::BuzonOps for BuzonUsuarioTecleando {
    fn op(
        &self,
        _id: &str,
        op: crate::sesiones::buzon::InboxOp,
    ) -> Option<crate::sesiones::types::OpResult> {
        self.ops.lock().expect("ops").push(format!("{op:?}"));
        if let Some(m) = pantalla::monitor(&self.id) {
            m.alimentar(b" y otra cosa");
        }
        Some(crate::sesiones::types::OpResult {
            ok: true,
            value: Some(serde_json::json!({ "text": "", "cursor": 0 })),
            ..Default::default()
        })
    }
}

/// Caso negativo del falso positivo: la pantalla cambia entre la lectura de
/// antes y la de después de `prompt.read` (el usuario escribió entre medias).
/// No se tolera: ni pegado ni Ctrl+U ni nada a la cola; Err `ocupada`, el
/// drenaje en pausa y el texto del usuario sigue en la caja.
#[test]
fn g3_con_la_caja_cambiando_durante_prompt_read_no_escribe() {
    let (id, espia) = sesion_con_pantalla("prompt-texto");
    registro::update(&id, |s| {
        s.info.bridge_protocol = 2;
        (false, ())
    })
    .expect("v2");
    let antes = pantalla::actual(&id).entrada;
    assert!(antes.is_some(), "la pantalla ve texto");
    let buzon = BuzonUsuarioTecleando {
        id: id.clone(),
        ops: Mutex::default(),
    };
    let e = pegado::escribir_pegado_con(&id, paste_bytes("x", &[]).expect("bytes"), None, &buzon)
        .expect_err("G3");
    assert!(e.contains("no se pudo vaciar"), "{e}");
    let despues = pantalla::actual(&id).entrada;
    assert!(
        despues.is_some() && despues != antes,
        "{antes:?} -> {despues:?}"
    );
    assert_eq!(buzon.ops.lock().expect("ops").len(), 1, "solo prompt.read");
    assert!(
        espia.0.lock().expect("espía").is_empty(),
        "ni pegado ni Ctrl+U"
    );
    let cola = cola::global().lista(&id, crate::sesiones::buzon::ahora_ms());
    assert!(cola.is_empty(), "nada a la cola: {cola:?}");
    let entrada = || pantalla::actual(&id).entrada;
    assert!(caja::pausas().en_pausa(&id, entrada, Instant::now()));
    caja::pausas().levantar(&id);
    kill(&id).expect("kill");
}

/// `sesiones_terminal_input`: sin terminal adjunta ni menú, Err; adjunta,
/// dos Esc seguidos se escriben los dos (exento de G1).
#[test]
fn terminal_input_solo_con_la_terminal_adjunta_y_exento_de_g1() {
    let (id, espia) = sesion_con_pantalla("prompt-vacio");
    assert!(terminal_input(&id, "\x1b").is_err());
    assert!(espia.0.lock().expect("espía").is_empty());
    crate::pty::io::attach(&registro::pty_id(&id).expect("pty")).expect("attach");
    terminal_input(&id, "\x1b").expect("primer Esc");
    terminal_input(&id, "\x1b").expect("segundo Esc");
    assert_eq!(espia.0.lock().expect("espía").clone(), b"\x1b\x1b".to_vec());
    assert!(terminal_input(&id, "").is_err(), "vacío");
    kill(&id).expect("kill");
}

/// #17c: cada lanzamiento revoca el token del anterior. Un proceso que
/// sobrevive al PTY viejo recibe 401; el nuevo token sí autentica.
#[test]
fn cada_lanzamiento_rota_el_token_del_puente() {
    use super::super::tests_puente::{bearer, post, server};
    let info = server(false);
    let id = format!("rota-{}", uuid::Uuid::new_v4());
    let viejo = bearer(&id);
    let nuevo = token_relanzamiento(&id).expect("token nuevo");
    assert_ne!(viejo, format!("Bearer {nuevo}"));
    let body = serde_json::json!({ "sesionId": id, "protocol": 2 });
    assert_eq!(post(&info, "/v1/hello", Some(&viejo), &body).0, 401);
    let con_nuevo = post(&info, "/v1/hello", Some(&format!("Bearer {nuevo}")), &body).0;
    assert_ne!(con_nuevo, 401, "el token del lanzamiento vigente autentica");
    puente::revocar_token(&id);
}
