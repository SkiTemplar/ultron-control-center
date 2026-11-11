use std::sync::atomic::Ordering;
use std::time::Duration;

use super::*;

#[test]
fn solo_se_desactiva_con_un_valor_explicito() {
    for v in ["0", "false", "OFF", " no "] {
        assert!(desactivado(Some(v)), "{v}");
    }
    for v in [None, Some(""), Some("1"), Some("true"), Some("cualquiera")] {
        assert!(!desactivado(v), "{v:?}");
    }
}

#[test]
fn la_carpeta_por_defecto_es_ultron_y_la_configurada_manda() {
    let home = tempfile::tempdir().expect("tmp");
    let ultron = home.path().join(".ultron");
    std::fs::create_dir(&ultron).expect("mkdir");
    assert_eq!(carpeta(None, Some(home.path())).expect("defecto"), ultron);
    assert_eq!(
        carpeta(Some("  "), Some(home.path())).expect("vacía"),
        ultron
    );

    let otra = home.path().join("proyecto");
    std::fs::create_dir(&otra).expect("mkdir");
    let otra_str = otra.to_string_lossy().into_owned();
    assert_eq!(
        carpeta(Some(&otra_str), Some(home.path())).expect("configurada"),
        otra
    );
}

#[test]
fn la_carpeta_rechaza_el_home_y_las_que_no_existen() {
    let home = tempfile::tempdir().expect("tmp");
    let home_str = home.path().to_string_lossy().into_owned();
    let e = carpeta(Some(&home_str), Some(home.path())).expect_err("home");
    assert!(e.contains("home"), "{e}");

    // Sin `~/.ultron` creada, el valor por defecto tampoco vale.
    let e = carpeta(None, Some(home.path())).expect_err("sin .ultron");
    assert!(e.contains("no existe"), "{e}");
    assert!(carpeta(None, None).is_err());
}

#[test]
fn la_espera_crece_hasta_el_tope_y_vuelve_al_minimo_tras_una_vida_sana() {
    let corta = Duration::from_secs(3);
    let mut e = ESPERA_MIN;
    e = siguiente_espera(e, corta);
    assert_eq!(e, Duration::from_secs(10));
    for _ in 0..10 {
        e = siguiente_espera(e, corta);
    }
    assert_eq!(e, ESPERA_MAX);
    assert_eq!(siguiente_espera(e, VIDA_SANA), ESPERA_MIN);
}

#[test]
fn sin_ansi_quita_csi_y_osc_y_conserva_el_texto() {
    let crudo = "\u{1b}[7A\u{1b}[J·✔︎· Ready · ultron\r\n\u{1b}]8;;https://x\u{7}enlace\u{1b}]8;;\u{1b}\\ fin";
    assert_eq!(sin_ansi(crudo), "·✔︎· Ready · ultron\r\nenlace fin");
}

#[test]
fn recortar_conserva_la_cola_sin_partir_caracteres() {
    let mut s = "ñañaña".to_string();
    recortar(&mut s, 5);
    assert!(s.len() <= 5 && "ñañaña".ends_with(&s), "{s}");
    let mut corto = "abc".to_string();
    recortar(&mut corto, 10);
    assert_eq!(corto, "abc");
}

#[test]
fn extrae_la_url_del_entorno_y_el_ultimo_error() {
    let t = "Code anywhere with the Claude mobile app or https://claude.ai/code?environment=env_01Abc\r\nOr ask";
    assert_eq!(
        url_entorno(t),
        Some("https://claude.ai/code?environment=env_01Abc")
    );
    assert_eq!(url_entorno("Connecting · ultron"), None);

    let t = "Connecting\nError: This folder is already served by a terminal `claude remote-control` on this device. Stop it first.\nExiting in about 60 seconds.\n";
    assert!(ultimo_error(t).is_some_and(|e| e.contains("already served")));
    assert_eq!(ultimo_error("Ready · ultron"), None);
}

#[test]
fn no_precrea_sesion_ni_usa_la_bandera_de_saltarse_permisos() {
    assert_eq!(ARGS[0], "remote-control");
    assert!(ARGS.contains(&"--no-create-session-in-dir"));
    assert!(!ARGS.iter().any(|a| a.contains("dangerously")));
}

#[test]
fn cerrar_sin_servidor_es_inocuo_y_deja_de_estar_activo() {
    cerrar();
    assert!(!bloquear().activo);
    assert!(bloquear().vivo.is_none());
}

/// Espera hasta `max` a que `cond` se cumpla.
fn esperar(max: Duration, cond: impl Fn() -> bool) -> bool {
    let fin = std::time::Instant::now() + max;
    while std::time::Instant::now() < fin {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    cond()
}

fn listo() -> bool {
    bloquear()
        .vivo
        .as_ref()
        .is_some_and(|v| v.listo.load(Ordering::Acquire))
}

/// Extremo a extremo contra el servicio real (cuenta con suscripción, red y
/// una carpeta de confianza en `ULTRON_REMOTE_CONTROL_CWD`):
/// `cargo test --lib remote_control_real -- --ignored --nocapture`.
/// Si el cierre no diera de baja el entorno, el segundo arranque recibiría
/// 409 y no llegaría a estar listo.
#[test]
#[ignore = "lanza claude remote-control contra el servicio real"]
fn remote_control_real_arranca_cierra_ordenado_y_relanza() {
    for vuelta in 1..=2 {
        abrir();
        assert!(
            esperar(Duration::from_secs(45), listo),
            "vuelta {vuelta}: no llegó a estar listo"
        );
        let salido = bloquear()
            .vivo
            .as_ref()
            .map(|v| v.salido.clone())
            .expect("vivo");
        let inicio = std::time::Instant::now();
        cerrar();
        assert!(salido.load(Ordering::Acquire), "vuelta {vuelta}: no salió");
        assert!(
            inicio.elapsed() < Duration::from_secs(3),
            "vuelta {vuelta}: cierre lento ({:?}), probablemente forzado",
            inicio.elapsed()
        );
    }
}
