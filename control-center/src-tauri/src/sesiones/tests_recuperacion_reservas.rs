// sesiones/tests_recuperacion_reservas.rs — Reservas y antirrebote de las
// recuperaciones, `olvidar` y «Reiniciar sesión». Submódulo de
// tests_recuperacion.rs: reutiliza su TUI falsa (`Falso`, `clas`, `nada`).

use super::*;

#[test]
fn antirrebote_por_sesion_y_accion() {
    let t0 = Instant::now();
    let clave = format!("{}:interrupt", uuid::Uuid::new_v4());
    assert_eq!(reservar(&clave, t0), Reserva::Libre);
    assert_eq!(reservar(&clave, t0), Reserva::EnCurso);
    liberar(&clave, t0);
    // La anterior ya terminó: no es «en curso» (su nota sería falsa).
    assert_eq!(
        reservar(&clave, t0 + Duration::from_millis(500)),
        Reserva::Antirrebote
    );
    assert_eq!(
        reservar(&clave, t0 + Duration::from_millis(1600)),
        Reserva::Libre
    );
    let otra = clave.replace("interrupt", "exitMenu");
    assert_eq!(
        reservar(&otra, t0),
        Reserva::Libre,
        "otra acción no se bloquea"
    );
}

fn hecho(_: &dyn Entorno) -> Resultado {
    Resultado {
        ok: true,
        steps: vec!["hecho".into()],
    }
}

#[test]
fn accion_reservada_ejecuta_y_libera_aunque_entre_en_panico() {
    let f = Falso::nuevo(clas(EstadoPantalla::Busy), nada());
    let clave = clave_reserva(&uuid::Uuid::new_v4().to_string(), RecoverAction::Interrupt);
    let r = accion_reservada(&f, &clave, SiReservada::ComprobarPantalla, hecho);
    assert_eq!(r.steps, vec!["hecho"]);
    assert!(!en_curso(&clave), "liberada al terminar");
    let otra = format!("{clave}-panico");
    let p = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        accion_reservada(&f, &otra, SiReservada::CuentaComoHecha, |_| panic!("x"))
    }));
    assert!(p.is_err());
    assert!(!en_curso(&otra), "un pánico no deja la reserva tomada");
}

#[test]
fn accion_reservada_ocupada_responde_segun_la_semantica_sin_ejecutar() {
    let casos = [
        (
            SiReservada::CuentaComoHecha,
            EstadoPantalla::Busy,
            true,
            true,
        ),
        (
            SiReservada::ComprobarPantalla,
            EstadoPantalla::Prompt,
            true,
            false,
        ),
        (
            SiReservada::CuentaComoHecha,
            EstadoPantalla::Busy,
            false,
            true,
        ),
        (
            SiReservada::ComprobarPantalla,
            EstadoPantalla::Busy,
            false,
            false,
        ),
        (
            SiReservada::ComprobarPantalla,
            EstadoPantalla::Prompt,
            false,
            true,
        ),
    ];
    for (si, pantalla, en_marcha, ok) in casos {
        let f = Falso::nuevo(clas(pantalla), nada());
        let clave = format!("{}:Interrupt", uuid::Uuid::new_v4());
        assert_eq!(reservar(&clave, Instant::now()), Reserva::Libre);
        if !en_marcha {
            liberar(&clave, Instant::now());
        }
        let r = accion_reservada(&f, &clave, si, |_| panic!("no debe ejecutarse"));
        let paso = if en_marcha { "enCurso" } else { "antirrebote" };
        assert_eq!(
            r,
            Resultado {
                ok,
                steps: vec![paso.into()]
            },
            "{si:?} {pantalla:?}"
        );
        assert!(f.escrituras().is_empty());
    }
}

#[test]
fn un_error_antes_de_recuperar_no_deja_la_reserva_tomada() {
    // Sesión dada de alta sin PTY todavía (arranque en curso).
    let id = format!("recup-sin-pty-{}", uuid::Uuid::new_v4());
    registro::insert(registro::sesion_de_prueba(&id)).expect("alta");
    let e = interrumpir_o_salir(&id, RecoverAction::Interrupt).expect_err("sin PTY");
    assert!(e.contains("PTY"), "{e}");
    let clave = format!("{id}:{:?}", RecoverAction::Interrupt);
    assert_eq!(
        reservar(&clave, Instant::now()),
        Reserva::Libre,
        "la reserva quedó tomada: las recuperaciones siguientes serían «enCurso»"
    );
    registro::remove(&id);
}

/// `olvidar` quita las marcas y las reservas de la sesión (sus claves y las
/// de prefijo `<id>:`) y deja las de otra sesión, aunque su id empiece igual.
#[test]
fn olvidar_quita_las_marcas_y_reservas_de_la_sesion_y_solo_esas() {
    let id = format!("olvidar-{}", uuid::Uuid::new_v4());
    let vecina = format!("{id}x");
    let t0 = Instant::now();
    for s in [&id, &vecina] {
        anotar_tarea(s);
        anotar_turno(s);
        liberar(&clave_reserva(s, RecoverAction::Interrupt), t0);
        liberar(&format!("{s}:Background"), t0);
    }
    olvidar(&id);
    assert!(!bloquear(tareas()).contains_key(&id));
    assert!(!bloquear(turnos()).contains_key(&id));
    let prefijo = format!("{id}:");
    assert!(!bloquear(marcas()).keys().any(|k| k.starts_with(&prefijo)));
    let clave = clave_reserva(&id, RecoverAction::Interrupt);
    assert_eq!(
        reservar(&clave, t0),
        Reserva::Libre,
        "sin antirrebote heredado"
    );
    assert!(tarea_desde(&vecina, t0) && turno_desde(&vecina, t0));
    assert_eq!(
        reservar(&clave_reserva(&vecina, RecoverAction::Interrupt), t0),
        Reserva::Antirrebote,
        "la otra sesión conserva su reserva"
    );
    olvidar(&id);
    olvidar(&vecina);
}

/// #32: «Reiniciar sesión» tras un arranque que no llegó al prompt. Sin
/// `<sid>.jsonl` en disco, `--resume <sid>` respondería «No conversation
/// found»: el reinicio arranca una conversación nueva con el mismo sid.
#[test]
fn reiniciar_sin_transcript_arranca_nueva_y_con_transcript_reanuda() {
    let dir = tempfile::tempdir().expect("tempdir");
    let sid = uuid::Uuid::new_v4().to_string();
    let id = format!("recup-reinicio-{sid}");
    let mut s = registro::sesion_de_prueba(&id);
    s.info.claude_session_id = Some(sid.clone());
    s.slug_dir = dir.path().to_path_buf();
    s.transcript = Some(dir.path().join(format!("{sid}.jsonl")));
    registro::insert(s).expect("alta");
    let sin = arranque_reinicio(&id).expect("arranque");
    assert_eq!(sin, Arranque::Nueva { sid: sid.clone() }, "sin transcript");
    std::fs::write(dir.path().join(format!("{sid}.jsonl")), "{}\n").expect("jsonl");
    let con = arranque_reinicio(&id).expect("arranque");
    assert_eq!(
        con,
        Arranque::Reanudar { sid: sid.clone() },
        "con transcript"
    );
    registro::remove(&id);
}

/// El transcript fijado en el registro manda aunque no se llame `<sid>.jsonl`
/// (p. ej., tras adoptar otro fichero); sin sid no hay reinicio posible.
#[test]
fn reiniciar_mira_el_transcript_del_registro_y_exige_sid() {
    let dir = tempfile::tempdir().expect("tempdir");
    let sid = uuid::Uuid::new_v4().to_string();
    let id = format!("recup-reinicio-reg-{sid}");
    let otro = dir.path().join("otro.jsonl");
    std::fs::write(&otro, "{}\n").expect("jsonl");
    let mut s = registro::sesion_de_prueba(&id);
    s.info.claude_session_id = Some(sid.clone());
    s.slug_dir = dir.path().to_path_buf();
    s.transcript = Some(otro);
    registro::insert(s).expect("alta");
    assert_eq!(
        arranque_reinicio(&id).expect("arranque"),
        Arranque::Reanudar { sid }
    );
    registro::remove(&id);
    let id2 = format!("recup-reinicio-sin-sid-{}", uuid::Uuid::new_v4());
    registro::insert(registro::sesion_de_prueba(&id2)).expect("alta");
    let e = arranque_reinicio(&id2).expect_err("sin sid");
    assert!(e.contains("id de Claude"), "{e}");
    registro::remove(&id2);
}

/// Sesión con sid y configuración de lanzamiento guardada, lista para
/// `reiniciar_con` (sin PTY: `terminar_proceso` no mata nada).
fn sesion_reiniciable(prefijo: &str) -> (String, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let sid = uuid::Uuid::new_v4().to_string();
    let id = format!("{prefijo}-{sid}");
    let mut s = registro::sesion_de_prueba(&id);
    s.info.claude_session_id = Some(sid);
    s.slug_dir = dir.path().to_path_buf();
    registro::insert(s).expect("alta");
    lanzamiento::guardar(
        &id,
        lanzamiento::Config {
            cwd: dir.path().display().to_string(),
            project_id: None,
            model: None,
            effort: None,
            permission_mode: crate::sesiones::types::PermissionMode::Default,
            settings_file: None,
        },
    );
    (id, dir)
}

/// Auditoría 2026-10-17: dos «Reiniciar» seguidos lanzaban dos `claude
/// --resume` sobre el mismo transcript y el primero quedaba huérfano. Con un
/// reinicio en curso, el segundo no mata ni relanza: responde `enCurso`.
#[test]
fn un_reinicio_con_otro_en_curso_no_relanza() {
    let (id, _dir) = sesion_reiniciable("reinicio-reservado");
    let clave = clave_reserva(&id, RecoverAction::Restart);
    assert_eq!(reservar(&clave, Instant::now()), Reserva::Libre);
    let lanzados = Cell::new(0);
    let r = reiniciar_con(&id, None, |_, _| {
        lanzados.set(lanzados.get() + 1);
        Ok(())
    })
    .expect("reinicio");
    assert_eq!(lanzados.get(), 0, "no relanza con otro reinicio en curso");
    assert!(r.ok);
    assert_eq!(r.steps, vec!["enCurso".to_string()]);
    liberar(&clave, Instant::now());
    olvidar(&id);
    lanzamiento::olvidar(&id);
    registro::remove(&id);
}

/// Caso negativo: sin otro en curso, relanza una vez y suelta la reserva
/// (un error al relanzar tampoco la deja tomada).
#[test]
fn un_reinicio_libre_relanza_una_vez_y_suelta_la_reserva() {
    let (id, _dir) = sesion_reiniciable("reinicio-libre");
    let lanzados = Cell::new(0);
    let r = reiniciar_con(&id, None, |_, arranque| {
        lanzados.set(lanzados.get() + 1);
        assert!(matches!(arranque, Arranque::Nueva { .. }), "sin transcript");
        Ok(())
    })
    .expect("reinicio");
    assert_eq!(lanzados.get(), 1);
    assert!(
        r.ok && r.steps.contains(&"reinicioPedido".to_string()),
        "{:?}",
        r.steps
    );
    let clave = clave_reserva(&id, RecoverAction::Restart);
    assert!(!en_curso(&clave), "la reserva queda libre al terminar");
    olvidar(&id);
    let e = reiniciar_con(&id, None, |_, _| Err("relanzar falló".into())).expect_err("error");
    assert_eq!(e, "relanzar falló");
    assert!(!en_curso(&clave), "un error tampoco deja la reserva tomada");
    olvidar(&id);
    lanzamiento::olvidar(&id);
    registro::remove(&id);
}
