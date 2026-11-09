// sesiones/tests_buzon.rs — Buzón del puente v2: entrega al menos una vez,
// idempotencia por `opId`, generaciones y caducidad con reloj inyectado
// (§6.4, AC-18, AC-24).

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;

use super::*;

const T0: Ms = 1_700_000_000_000;

fn run(cmd: &str) -> InboxOp {
    InboxOp::CommandRun {
        op_id: String::new(),
        command: cmd.into(),
        args: String::new(),
    }
}

fn ok(v: serde_json::Value) -> OpResult {
    OpResult {
        ok: true,
        value: Some(v),
        ..OpResult::default()
    }
}

#[test]
fn operaciones_en_el_cable() {
    let op = InboxOp::TurnAbort {
        op_id: "o1".into(),
        turn_id: "t1".into(),
    };
    assert_eq!(
        serde_json::to_value(&op).expect("serializa"),
        json!({ "op": "turn.abort", "opId": "o1", "turnId": "t1" })
    );
    let set: InboxOp = serde_json::from_value(
        json!({ "op": "config.set", "opId": "o2", "key": "k", "value": true }),
    )
    .expect("config.set");
    assert_eq!(
        set,
        InboxOp::ConfigSet {
            op_id: "o2".into(),
            key: "k".into(),
            value: ConfigValue::Bool(true),
        }
    );
    assert!(serde_json::from_value::<InboxOp>(json!({ "op": "otra", "opId": "x" })).is_err());
}

#[test]
fn sin_puente_v2_encolar_falla_de_forma_explicita() {
    let b = Buzon::default();
    let e = b.encolar("s1", run("cost"), T0).expect_err("sin hello v2");
    assert!(e.contains("puente v2"), "{e}");
    assert!(b.pendientes("s1").is_empty());
}

#[test]
fn habilitar_fuera_de_orden_no_vuelve_a_la_generacion_vieja() {
    let b = Buzon::default();
    b.habilitar("s1", 2);
    b.habilitar("s1", 1);
    assert_eq!(b.generacion("s1"), Some(2), "la generación solo avanza");
    assert!(
        b.esperar_pendientes("s1", 2, Duration::from_millis(10))
            .is_some(),
        "el sondeo de la vigente no es stale"
    );
}

#[test]
fn sin_resultado_se_reentrega_tambien_a_la_generacion_nueva() {
    let b = Buzon::default();
    b.habilitar("s1", 1);
    let id = b.encolar("s1", run("cost"), T0).expect("encolar");
    assert_eq!(b.pendientes("s1")[0].op_id(), id);
    assert_eq!(b.pendientes("s1").len(), 1, "segundo inbox: sigue");
    b.habilitar("s1", 2);
    let ops = b
        .esperar_pendientes("s1", 2, Duration::from_millis(10))
        .expect("generación vigente");
    assert_eq!(ops.len(), 1, "pasa a la generación nueva");
    assert!(
        b.esperar_pendientes("s1", 1, Duration::from_secs(5))
            .is_none(),
        "la vieja es stale al momento"
    );
}

#[test]
fn con_resultado_no_vuelve_y_el_segundo_se_ignora() {
    let b = Buzon::default();
    b.habilitar("s1", 1);
    let id = b.encolar("s1", run("cost"), T0).expect("encolar");
    let r = b.resolver(&id, ok(json!("uno")), T0).expect("primero");
    assert_eq!((r.sesion.as_str(), r.resultado.ok), ("s1", true));
    assert!(b.pendientes("s1").is_empty());
    assert!(
        b.resolver(&id, ok(json!("dos")), T0).is_none(),
        "idempotente"
    );
    let guardado = b
        .esperar_resultado(&id, Duration::from_millis(1))
        .expect("resultado");
    assert_eq!(guardado.value, Some(json!("uno")));
    assert_eq!(guardado.op_id.as_deref(), Some(id.as_str()));
}

#[test]
fn caducidad_a_los_10_min_y_no_a_los_9() {
    let b = Buzon::default();
    b.habilitar("s1", 1);
    let id = b.encolar("s1", run("compact"), T0).expect("encolar");
    assert!(b.caducar(T0 + 9 * 60_000).is_empty());
    assert_eq!(b.pendientes("s1").len(), 1);
    let fuera = b.caducar(T0 + 10 * 60_000);
    assert_eq!(fuera.len(), 1);
    assert_eq!(fuera[0].op_id, id);
    assert!(!fuera[0].resultado.ok);
    assert_eq!(fuera[0].resultado.error.as_deref(), Some(SIN_RESPUESTA));
    assert!(b.pendientes("s1").is_empty());
}

#[test]
fn abort_y_lectura_de_la_entrada_caducan_a_los_5_s() {
    let b = Buzon::default();
    b.habilitar("s1", 1);
    b.encolar(
        "s1",
        InboxOp::TurnAbort {
            op_id: String::new(),
            turn_id: "t".into(),
        },
        T0,
    )
    .expect("abort");
    assert!(b.caducar(T0 + 4_999).is_empty());
    assert_eq!(b.caducar(T0 + 5_000).len(), 1);
}

/// `prompt.clear` caduca con la espera de G3 y, cancelado al vencerla, ya no
/// se entrega al mod ni admite un resultado tardío.
#[test]
fn limpieza_de_la_caja_caduca_con_la_espera_y_se_cancela() {
    let b = Buzon::default();
    b.habilitar("s1", 1);
    let clear = || InboxOp::PromptClear {
        op_id: String::new(),
    };
    b.encolar("s1", clear(), T0).expect("clear");
    assert!(b.caducar(T0 + ESPERA_CAJA_MS - 1).is_empty());
    assert_eq!(b.caducar(T0 + ESPERA_CAJA_MS).len(), 1);
    let id = b.encolar("s1", clear(), T0).expect("clear");
    let r = b.cancelar(&id, T0 + 1).expect("pendiente");
    assert_eq!(r.resultado.error.as_deref(), Some(CANCELADA));
    assert!(b.pendientes("s1").is_empty(), "el mod ya no la ve");
    assert!(b.resolver_de("s1", &id, ok(json!(null)), T0 + 2).is_none());
    assert!(b.cancelar(&id, T0 + 3).is_none(), "ya resuelta");
}

#[test]
fn inbox_despierta_al_encolar_y_resultado_al_resolver() {
    let b = Arc::new(Buzon::default());
    b.habilitar("s1", 1);
    let b2 = b.clone();
    let h = std::thread::spawn(move || b2.esperar_pendientes("s1", 1, Duration::from_secs(5)));
    std::thread::sleep(Duration::from_millis(30));
    let t = Instant::now();
    let id = b.encolar("s1", run("cost"), T0).expect("encolar");
    let ops = h.join().expect("hilo").expect("vigente");
    assert_eq!(ops.len(), 1);
    assert!(t.elapsed() < Duration::from_secs(1));
    let (b3, id2) = (b.clone(), id.clone());
    let h = std::thread::spawn(move || b3.esperar_resultado(&id2, Duration::from_secs(5)));
    std::thread::sleep(Duration::from_millis(30));
    b.resolver(&id, ok(json!(1)), T0);
    assert!(h.join().expect("hilo").is_some_and(|r| r.ok));
}

#[test]
fn olvidar_la_sesion_falla_sus_operaciones() {
    let b = Buzon::default();
    b.habilitar("s1", 1);
    b.encolar("s1", run("cost"), T0).expect("encolar");
    let fuera = b.olvidar("s1", T0);
    assert_eq!(fuera.len(), 1);
    assert!(!fuera[0].resultado.ok);
    assert!(b.encolar("s1", run("cost"), T0).is_err());
}

/// M2: cada operación viaja con su caducidad absoluta para que el mod no
/// ejecute tarde una que ya nadie espera.
#[test]
fn inbox_lleva_la_caducidad_absoluta_de_cada_operacion() {
    let b = Buzon::default();
    b.habilitar("s1", 1);
    let clear = b
        .encolar(
            "s1",
            InboxOp::PromptClear {
                op_id: String::new(),
            },
            T0,
        )
        .expect("clear");
    b.encolar("s1", run("cost"), T0 + 5).expect("cost");
    let ops = b
        .esperar_pendientes("s1", 1, Duration::from_millis(10))
        .expect("vigente");
    let cable = serde_json::to_value(&ops).expect("serializa");
    assert_eq!(
        cable[0],
        json!({ "op": "prompt.clear", "opId": clear, "expiresAt": T0 + ESPERA_CAJA_MS })
    );
    assert_eq!(cable[1]["expiresAt"], json!(T0 + 5 + 10 * 60_000));
    assert_eq!(cable[1]["command"], "cost");
}

/// Las operaciones internas de G3 se marcan para no pintarse en el chat;
/// las del usuario, no.
#[test]
fn solo_las_operaciones_de_g3_son_internas() {
    let b = Buzon::default();
    b.habilitar("s1", 1);
    let leer = b
        .encolar(
            "s1",
            InboxOp::PromptRead {
                op_id: String::new(),
            },
            T0,
        )
        .expect("read");
    let cost = b.encolar("s1", run("cost"), T0).expect("cost");
    assert!(b.cancelar(&leer, T0 + 1).expect("pendiente").interna);
    assert!(!b.cancelar(&cost, T0 + 1).expect("pendiente").interna);
}
