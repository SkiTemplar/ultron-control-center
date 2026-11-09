// sesiones/tests_motor_sesion_guardado.rs — Tests de la persistencia de las
// sesiones de motor (ida y vuelta, topes de sesiones y turnos) y de los turnos
// `chat` en el registro de `motor` (fuera de `motores.json` y de `limpiar`,
// poda por sesión). Herméticos: ficheros en directorios temporales.

use crate::sesiones::motor::{self, TaskSpec};
use crate::sesiones::motor_sesion::{
    cargar_de, guardar_en, SesionMotor, Turno, MAX_SESIONES, MAX_TURNOS,
};
use crate::sesiones::types::EngineTask;

fn tarea(id: &str, sesion: &str, inicio: &str, status: &str) -> EngineTask {
    let mut t = motor::nueva_para_prueba(TaskSpec {
        engine: "gemini",
        kind: motor::KIND_CHAT.into(),
        mode: "local".into(),
        cwd: ".".into(),
        prompt: format!("p-{id}"),
        session_id: Some(sesion.into()),
        context_chars: 0,
        model: None,
        group: None,
    });
    t.id = id.into();
    t.started_at = inicio.into();
    t.status = status.into();
    t.summary = Some(format!("r-{id}"));
    t
}

fn sesion(id: &str, open: bool, actividad: &str, turns: Vec<EngineTask>) -> SesionMotor {
    SesionMotor {
        id: id.into(),
        engine: "codex".into(),
        project_id: Some("demo".into()),
        project_name: "Demo".into(),
        cwd: "/tmp/demo".into(),
        title: format!("t-{id}"),
        title_manual: true,
        model: Some("gpt-5.6-sol".into()),
        permission_mode: crate::sesiones::types::PermissionMode::Default,
        started_at: actividad.into(),
        last_activity_at: actividad.into(),
        open,
        thread_id: Some(format!("th-{id}")),
        turns,
        turno: Turno::EnCurso("x".into()),
        working_since: Some(actividad.into()),
    }
}

#[test]
fn la_persistencia_va_y_vuelve() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("sub").join("motor-sesiones.json");
    let cerrada = sesion(
        "pv-c",
        false,
        "2026-11-04T09:00:00Z",
        vec![tarea("pv-t1", "pv-c", "2026-11-04T09:00:01Z", "done")],
    );
    let abierta = sesion("pv-a", true, "2026-11-04T10:00:00Z", Vec::new());
    let viva = tarea("pv-t2", "pv-a", "2026-11-04T10:00:01Z", "running");
    let ajena = tarea("pv-t3", "otra", "2026-11-04T10:00:02Z", "done");
    guardar_en(&path, &[cerrada, abierta], &[viva, ajena]).expect("guardar");
    assert!(
        !path.with_extension("json.tmp").exists(),
        "escritura atómica"
    );
    let mut v = cargar_de(&path);
    v.sort_by(|a, b| a.id.cmp(&b.id));
    let (a, c) = (&v[0], &v[1]);
    assert_eq!((a.id.as_str(), a.open, c.open), ("pv-a", true, false));
    assert_eq!(a.thread_id.as_deref(), Some("th-pv-a"));
    assert_eq!(
        (a.model.as_deref(), a.title_manual),
        (Some("gpt-5.6-sol"), true)
    );
    assert_eq!(
        (a.turno.clone(), a.working_since.clone()),
        (Turno::Libre, None)
    );
    assert_eq!(a.turns.len(), 1, "solo los turnos de su sesión");
    assert_eq!(a.turns[0].status, "error", "un turno en curso no sobrevive");
    assert_eq!(
        (c.turns[0].id.as_str(), c.turns[0].summary.as_deref()),
        ("pv-t1", Some("r-pv-t1"))
    );
    let falta = dir.path().join("no.json");
    assert!(cargar_de(&falta).is_empty());
    std::fs::write(&falta, "{basura").expect("escribir");
    assert!(
        cargar_de(&falta).is_empty(),
        "un fichero roto no tumba el arranque"
    );
}

#[test]
fn el_tope_poda_las_cerradas_mas_antiguas_y_los_turnos_viejos() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("motor-sesiones.json");
    let mut v: Vec<SesionMotor> = (0..52)
        .map(|i| {
            sesion(
                &format!("tope-c{i:02}"),
                false,
                &format!("2026-11-04T10:{i:02}:00Z"),
                Vec::new(),
            )
        })
        .collect();
    let muchos: Vec<EngineTask> = (0..210)
        .map(|i| {
            tarea(
                &format!("tope-t{i:03}"),
                "tope-a0",
                &format!("2026-11-04T11:00:00.{i:03}Z"),
                "done",
            )
        })
        .collect();
    v.extend((0..3).map(|i| {
        sesion(
            &format!("tope-a{i}"),
            true,
            "2026-01-01T00:00:00Z",
            Vec::new(),
        )
    }));
    guardar_en(&path, &v, &muchos).expect("guardar");
    let cargadas = cargar_de(&path);
    assert_eq!(cargadas.len(), MAX_SESIONES);
    assert_eq!(
        cargadas.iter().filter(|s| s.open).count(),
        3,
        "las abiertas no se podan"
    );
    let ids: Vec<&str> = cargadas.iter().map(|s| s.id.as_str()).collect();
    for podada in ["tope-c00", "tope-c01", "tope-c02", "tope-c03", "tope-c04"] {
        assert!(!ids.contains(&podada), "{podada} es de las más antiguas");
    }
    assert!(ids.contains(&"tope-c05") && ids.contains(&"tope-c51"));
    let a0 = cargadas.iter().find(|s| s.id == "tope-a0").expect("a0");
    assert_eq!(a0.turns.len(), MAX_TURNOS);
    assert_eq!(a0.turns[0].id, "tope-t010", "se van los más antiguos");
    assert_eq!(a0.turns[MAX_TURNOS - 1].id, "tope-t209");
}

#[test]
fn los_turnos_chat_no_van_a_motores_json_ni_los_borra_limpiar() {
    let sid = format!("chat-fuera-{}", uuid::Uuid::new_v4());
    let chat = tarea("chat-fuera-1", &sid, "2026-11-04T10:00:00Z", "done");
    let mut normal = tarea("chat-fuera-2", &sid, "2026-11-04T10:00:01Z", "done");
    normal.kind = "task".into();
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("motores.json");
    motor::guardar_en(&path, &[chat.clone(), normal.clone()]).expect("guardar");
    let ids: Vec<String> = motor::cargar_de(&path).into_iter().map(|t| t.id).collect();
    assert_eq!(ids, vec!["chat-fuera-2".to_string()]);
    motor::insertar_turnos(vec![chat, normal]);
    assert_eq!(
        motor::limpiar(&sid).expect("limpiar"),
        1,
        "solo la tarea normal"
    );
    assert!(motor::get("chat-fuera-1").is_ok(), "el turno chat sigue");
    assert!(motor::get("chat-fuera-2").is_err());
    motor::retirar_turnos(&sid);
}

#[test]
fn podar_turnos_conserva_los_mas_recientes_de_la_sesion() {
    let sid = format!("podar-chat-{}", uuid::Uuid::new_v4());
    let turnos: Vec<EngineTask> = (0..5)
        .map(|i| {
            tarea(
                &format!("{sid}-{i}"),
                &sid,
                &format!("2026-11-04T10:00:0{i}Z"),
                "done",
            )
        })
        .collect();
    motor::insertar_turnos(turnos);
    motor::podar_turnos(&sid, 2);
    let quedan: Vec<String> = motor::turnos_de_sesion(&sid)
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(quedan, vec![format!("{sid}-3"), format!("{sid}-4")]);
    motor::retirar_turnos(&sid);
}
