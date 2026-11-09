// sesiones/tests_registro_cierre.rs — Tests del cierre de sesión en el
// cableado de estados (`registro_estado.rs`): una señal tardía, un primer
// token o una terminal enganchada después de `gestor::kill` no pueden dejar
// entradas huérfanas en los mapas de estados. Submódulo de tests de
// `registro_estado.rs`.

use super::*;
use crate::sesiones::registro;
use crate::sesiones::types::{QueueItemInput, QueueItemKind, QueueState};

fn id_nuevo(prefijo: &str) -> String {
    format!("{prefijo}-{}", uuid::Uuid::new_v4())
}

/// Mapas de estados que todavía guardan algo de la sesión.
fn huerfanos(id: &str) -> Vec<&'static str> {
    let g = estados().lock().expect("estados");
    let mapas = [
        ("maquinas", g.maquinas.contains_key(id)),
        ("ultima_emision", g.ultima_emision.contains_key(id)),
        ("latencias", g.latencias.contains_key(id)),
        ("terminales", g.terminales.contains(id)),
        ("ultimo_tick", g.ultimo_tick.contains_key(id)),
    ];
    mapas
        .into_iter()
        .filter(|(_, hay)| *hay)
        .map(|(m, _)| m)
        .collect()
}

/// Sesión registrada con estado, latencia y tick, como una sesión viva.
fn sesion_viva(prefijo: &str) -> String {
    let id = id_nuevo(prefijo);
    registro::insert(registro::sesion_de_prueba(&id)).expect("alta");
    manejar_senal(&id, Senal::Tick);
    manejar_senal(&id, Senal::Progreso);
    assert!(!huerfanos(&id).is_empty(), "la sesión viva tiene estado");
    id
}

/// M1: una señal que llega en mitad del cierre no deja huérfanos. Con el
/// orden antiguo (olvidar → remove) el `update` de esa señal aún encontraba
/// la sesión y volvía a insertar `maquinas` y `ultimo_tick`.
#[test]
fn una_senal_en_mitad_del_cierre_no_deja_huerfanos() {
    let id = sesion_viva("cierre-carrera");
    cerrar_estado_con(&id, || manejar_senal(&id, Senal::Tick));
    assert!(!registro::exists(&id), "la sesión sale del registro");
    assert_eq!(huerfanos(&id), Vec::<&str>::new());
}

/// M1: una señal tardía tras el cierre cae en la rama de error de `update`
/// y purga también el `ultimo_tick` que `rebasar_si_salto` ya había anotado.
#[test]
fn una_senal_tras_el_cierre_no_deja_huerfanos() {
    let id = sesion_viva("cierre-tardia");
    cerrar_estado(&id);
    manejar_senal(&id, Senal::Tick);
    manejar_senal(&id, Senal::Progreso);
    assert_eq!(huerfanos(&id), Vec::<&str>::new());
}

/// M1: `primer_token` tardío no resucita la latencia de una sesión cerrada.
#[test]
fn primer_token_tras_el_cierre_no_crea_latencia() {
    let id = sesion_viva("cierre-token");
    cerrar_estado(&id);
    primer_token(&id);
    assert_eq!(huerfanos(&id), Vec::<&str>::new());
}

/// Caso positivo: con la sesión viva y un envío en curso, `primer_token`
/// sigue anotando la latencia.
#[test]
fn primer_token_anota_la_latencia_de_una_sesion_viva() {
    let id = id_nuevo("token-vivo");
    {
        let mut g = estados().lock().expect("estados");
        g.latencias.insert(
            id.clone(),
            Latencia {
                envio: Some(1),
                ..Latencia::default()
            },
        );
    }
    primer_token(&id);
    let anotado = estados()
        .lock()
        .ok()
        .and_then(|g| g.latencias.get(&id).and_then(|l| l.primer_token));
    assert!(anotado.is_some(), "primer token anotado");
    olvidar_sesion(&id);
}

/// M1 (riesgo 3): enganchar la terminal de una sesión que ya no existe no
/// deja `terminales` huérfano ni pausa una cola que nadie va a soltar.
#[test]
fn enganchar_la_terminal_de_una_sesion_cerrada_no_hace_nada() {
    let id = sesion_viva("cierre-terminal");
    crate::sesiones::gestor::kill(&id).expect("kill");
    terminal_adjunta(&id, true);
    assert_eq!(huerfanos(&id), Vec::<&str>::new());
    assert!(!terminales_adjuntas().contains(&id));
}

/// M1 (riesgo 2): un drenaje que llega tras el cierre no escribe en la cola
/// de una sesión que ya no está en el registro.
#[test]
fn el_drenaje_de_una_sesion_cerrada_no_escribe() {
    let id = id_nuevo("cierre-drenaje");
    {
        let mut e = EstadoSesion::nuevo(0);
        e.status = SessionStatus::Idle;
        e.pantalla = ScreenState::Prompt;
        estados()
            .lock()
            .expect("estados")
            .maquinas
            .insert(id.clone(), e);
    }
    let input = QueueItemInput {
        client_id: "c1".into(),
        text: "hola".into(),
        attachments: Vec::new(),
        delegate: false,
        kind: QueueItemKind::Prompt,
    };
    cola::global()
        .encolar(&id, input, ahora_ms())
        .expect("encolar");
    drenaje::drenar(&id);
    let estados_cola: Vec<QueueState> = cola::global()
        .lista(&id, ahora_ms())
        .iter()
        .map(|i| i.state)
        .collect();
    assert_eq!(estados_cola, vec![QueueState::Queued], "nada escrito");
    olvidar_sesion(&id);
}

#[test]
fn soltar_la_terminal_no_reanuda_una_cola_en_pausa() {
    let mut e = EstadoSesion::nuevo(0);
    assert!(soltar_reanuda_cola(Some(&e)));
    assert!(soltar_reanuda_cola(None));
    e.pausa_drenaje = true;
    assert!(!soltar_reanuda_cola(Some(&e)), "turno interrumpido");
    e.pausa_drenaje = false;
    e.pausa_plazo = Some(5);
    assert!(!soltar_reanuda_cola(Some(&e)), "cierre por plazo");
}
