// pty/tests_escritor.rs — G1-G4 y serialización del escritor por PTY.

use std::io::{self, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::*;

fn vista(p: ScreenState) -> Vista {
    Vista {
        pantalla: p,
        entrada: None,
    }
}

fn pegado(t: &str) -> Trabajo {
    Trabajo::Pegado {
        bytes: t.as_bytes().to_vec(),
        enter: true,
        tolerada: None,
    }
}

#[test]
fn g1_esc_doble_se_rechaza_y_pasada_la_ventana_se_admite() {
    let mut g = Guardas::default();
    let t0 = Instant::now();
    let v = vista(ScreenState::Busy);
    let esc = Trabajo::Tecla(TeclaPty::Esc);
    assert_eq!(g.admitir(&esc, &v, false, t0), Ok(()));
    assert_eq!(
        g.admitir(&esc, &v, false, t0 + Duration::from_millis(1000)),
        Err(ErrorEscritura::EscDoble)
    );
    assert_eq!(
        g.admitir(&esc, &v, false, t0 + Duration::from_millis(1600)),
        Ok(())
    );
    // `exitMenu` también pasa por G1.
    let esc_menu = Trabajo::TeclaDialogo(TeclaPty::Esc);
    assert_eq!(
        g.admitir(&esc_menu, &v, false, t0 + Duration::from_millis(2000)),
        Err(ErrorEscritura::EscDoble)
    );
}

#[test]
fn g2_ctrl_c_solo_trabajando_y_uno_cada_cinco_segundos() {
    let mut g = Guardas::default();
    let t0 = Instant::now();
    let c = Trabajo::Tecla(TeclaPty::CtrlC);
    assert_eq!(
        g.admitir(&c, &vista(ScreenState::Prompt), false, t0),
        Err(ErrorEscritura::CtrlCSinTrabajo)
    );
    assert_eq!(g.admitir(&c, &vista(ScreenState::Busy), false, t0), Ok(()));
    assert_eq!(
        g.admitir(
            &c,
            &vista(ScreenState::Busy),
            false,
            t0 + Duration::from_secs(4)
        ),
        Err(ErrorEscritura::CtrlCRepetido)
    );
    assert_eq!(
        g.admitir(
            &c,
            &vista(ScreenState::Busy),
            false,
            t0 + Duration::from_millis(5100)
        ),
        Ok(())
    );
}

#[test]
fn g3_menu_o_entrada_con_texto_bloquean_pegado_y_enter() {
    let mut g = Guardas::default();
    let ahora = Instant::now();
    for p in [ScreenState::Dialog, ScreenState::Trust] {
        assert_eq!(
            g.admitir(&pegado("hola"), &vista(p), false, ahora),
            Err(ErrorEscritura::MenuAbierto)
        );
        assert_eq!(
            g.admitir(&Trabajo::Tecla(TeclaPty::Enter), &vista(p), false, ahora),
            Err(ErrorEscritura::MenuAbierto)
        );
        // Navegar y confirmar un diálogo verificado sí se admite.
        assert_eq!(
            g.admitir(
                &Trabajo::TeclaDialogo(TeclaPty::Enter),
                &vista(p),
                false,
                ahora
            ),
            Ok(())
        );
        assert_eq!(
            g.admitir(&Trabajo::Tecla(TeclaPty::Abajo), &vista(p), false, ahora),
            Ok(())
        );
    }
    let con_texto = Vista {
        pantalla: ScreenState::Prompt,
        entrada: Some("hola".into()),
    };
    assert_eq!(
        g.admitir(&pegado("otra"), &con_texto, false, ahora),
        Err(ErrorEscritura::EntradaConTexto)
    );
    // Caso negativo: prompt vacío, se admite.
    assert_eq!(
        g.admitir(&pegado("otra"), &vista(ScreenState::Prompt), false, ahora),
        Ok(())
    );
}

/// Reintento tras un falso positivo de la pantalla (`prompt.read` leyó la
/// caja vacía): G3 no cuenta el texto tolerado, pero sí otro distinto (el
/// usuario escribió entre medias) y sigue rechazando un menú abierto.
#[test]
fn g3_tolerando_un_texto_solo_admite_ese_y_nunca_con_menu() {
    let mut g = Guardas::default();
    let ahora = Instant::now();
    let tolerado = |t: &str| Trabajo::Pegado {
        bytes: b"x".to_vec(),
        enter: true,
        tolerada: Some(t.into()),
    };
    let con = |p: ScreenState, e: Option<&str>| Vista {
        pantalla: p,
        entrada: e.map(str::to_string),
    };
    let pista = Some("Try \"fix lint errors\"");
    assert_eq!(
        g.admitir(
            &tolerado("Try \"fix lint errors\""),
            &con(ScreenState::Prompt, pista),
            false,
            ahora
        ),
        Ok(())
    );
    assert_eq!(
        g.admitir(
            &tolerado("x"),
            &con(ScreenState::Prompt, None),
            false,
            ahora
        ),
        Ok(())
    );
    // Casos negativos: otro texto en la caja, o un menú abierto.
    assert_eq!(
        g.admitir(
            &tolerado("Try \"fix lint errors\""),
            &con(ScreenState::Prompt, Some("borrador")),
            false,
            ahora
        ),
        Err(ErrorEscritura::EntradaConTexto)
    );
    // Comparación estricta: un carácter más, otro espacio o un salto de
    // línea distinto (el usuario tecleó tras la lectura de G3) cancelan la
    // tolerancia; un tolerado en blanco no tolera nada.
    for otra in [
        "Try \"fix lint errors\"x",
        "Try  \"fix lint errors\"",
        "Try\n\"fix lint errors\"",
        "try \"fix lint errors\"",
    ] {
        assert_eq!(
            g.admitir(
                &tolerado("Try \"fix lint errors\""),
                &con(ScreenState::Prompt, Some(otra)),
                false,
                ahora
            ),
            Err(ErrorEscritura::EntradaConTexto),
            "{otra:?}"
        );
    }
    for blanco in ["", " ", "\n"] {
        assert_eq!(
            g.admitir(
                &tolerado(blanco),
                &con(ScreenState::Prompt, Some(blanco)),
                false,
                ahora
            ),
            Err(ErrorEscritura::EntradaConTexto),
            "{blanco:?}"
        );
    }
    for p in [ScreenState::Dialog, ScreenState::Trust] {
        assert_eq!(
            g.admitir(
                &tolerado("Try \"fix lint errors\""),
                &con(p, pista),
                false,
                ahora
            ),
            Err(ErrorEscritura::MenuAbierto)
        );
        assert_eq!(
            g.admitir(&tolerado("x"), &con(p, None), false, ahora),
            Err(ErrorEscritura::MenuAbierto)
        );
    }
}

#[test]
fn g5_ctrl_b_solo_trabajando_y_uno_cada_segundo_y_medio() {
    let mut g = Guardas::default();
    let t0 = Instant::now();
    let b = Trabajo::Tecla(TeclaPty::SegundoPlano);
    assert_eq!(TeclaPty::SegundoPlano.bytes(), b"\x02");
    // Casos negativos: sin tarea en primer plano no sale (ni como tecla de
    // diálogo, que solo se salta G3).
    for p in [
        ScreenState::Prompt,
        ScreenState::Dialog,
        ScreenState::Trust,
        ScreenState::Unknown,
    ] {
        assert_eq!(
            g.admitir(&b, &vista(p), false, t0),
            Err(ErrorEscritura::SegundoPlanoSinTrabajo)
        );
    }
    assert_eq!(
        g.admitir(
            &Trabajo::TeclaDialogo(TeclaPty::SegundoPlano),
            &vista(ScreenState::Prompt),
            false,
            t0
        ),
        Err(ErrorEscritura::SegundoPlanoSinTrabajo)
    );
    assert_eq!(g.admitir(&b, &vista(ScreenState::Busy), false, t0), Ok(()));
    assert_eq!(
        g.admitir(
            &b,
            &vista(ScreenState::Busy),
            false,
            t0 + Duration::from_millis(500)
        ),
        Err(ErrorEscritura::SegundoPlanoRepetido)
    );
    assert_eq!(
        g.admitir(
            &b,
            &vista(ScreenState::Busy),
            false,
            t0 + Duration::from_millis(1600)
        ),
        Ok(())
    );
    // G5 no consume la ventana de G2: un Ctrl+C justo después se admite.
    assert_eq!(
        g.admitir(
            &Trabajo::Tecla(TeclaPty::CtrlC),
            &vista(ScreenState::Busy),
            false,
            t0 + Duration::from_millis(1700)
        ),
        Ok(())
    );
}

#[test]
fn g4_con_el_proceso_salido_todo_es_err() {
    let mut g = Guardas::default();
    let ahora = Instant::now();
    for t in [
        pegado("x"),
        Trabajo::Tecla(TeclaPty::Arriba),
        Trabajo::Exento(b"\x1b[1;1R".to_vec()),
    ] {
        assert_eq!(
            g.admitir(&t, &vista(ScreenState::Prompt), true, ahora),
            Err(ErrorEscritura::Terminada)
        );
    }
}

#[test]
fn exento_admite_esc_seguidos_pero_cuenta_para_g1() {
    let mut g = Guardas::default();
    let t0 = Instant::now();
    let v = vista(ScreenState::Dialog);
    let esc = Trabajo::Exento(b"\x1b".to_vec());
    assert_eq!(g.admitir(&esc, &v, false, t0), Ok(()));
    assert_eq!(
        g.admitir(&esc, &v, false, t0 + Duration::from_millis(10)),
        Ok(())
    );
    // Un Esc de recuperación justo después sería el segundo: rechazado.
    assert_eq!(
        g.admitir(
            &Trabajo::Tecla(TeclaPty::Esc),
            &v,
            false,
            t0 + Duration::from_millis(500)
        ),
        Err(ErrorEscritura::EscDoble)
    );
}

/// `Write` que guarda los bytes y, opcionalmente, tarda en cada escritura.
#[derive(Clone, Default)]
struct Espia {
    bytes: Arc<Mutex<Vec<u8>>>,
    retardo: Duration,
}

impl Write for Espia {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        std::thread::sleep(self.retardo);
        self.bytes.lock().expect("espía").extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn escritor_espia(retardo: Duration) -> (Escritor, Espia) {
    let espia = Espia {
        bytes: Arc::default(),
        retardo,
    };
    let fuente: FuenteVista = Arc::new(|| vista(ScreenState::Prompt));
    let e = Escritor::lanzar("test", Box::new(espia.clone()), fuente).expect("escritor");
    (e, espia)
}

#[test]
fn dos_envios_concurrentes_no_se_intercalan() {
    let (e, espia) = escritor_espia(Duration::from_millis(5));
    let e2 = e.clone();
    let h = std::thread::spawn(move || e2.enviar(pegado("P2")));
    let r1 = e.enviar(pegado("P1"));
    let r2 = h.join().expect("hilo");
    assert_eq!((r1, r2), (Ok(()), Ok(())));
    let out = String::from_utf8(espia.bytes.lock().expect("espía").clone()).expect("utf8");
    assert!(
        out == "P1\rP2\r" || out == "P2\rP1\r",
        "pegados intercalados: {out:?}"
    );
}

#[test]
fn una_tecla_durante_un_pegado_queda_detras_del_enter() {
    let (e, espia) = escritor_espia(Duration::ZERO);
    let e2 = e.clone();
    let h = std::thread::spawn(move || e2.enviar(pegado("P1")));
    // El pegado ya está dentro de su pausa de 40 ms antes del Enter.
    std::thread::sleep(Duration::from_millis(15));
    assert_eq!(e.enviar(Trabajo::Tecla(TeclaPty::Arriba)), Ok(()));
    assert_eq!(h.join().expect("hilo"), Ok(()));
    let out = espia.bytes.lock().expect("espía").clone();
    assert_eq!(out, b"P1\r\x1b[A".to_vec());
}

#[test]
fn tras_marcar_salido_el_envio_falla_sin_escribir() {
    let (e, espia) = escritor_espia(Duration::ZERO);
    e.marcar_salido();
    assert_eq!(e.enviar(pegado("x")), Err(ErrorEscritura::Terminada));
    e.cerrar();
    assert!(espia.bytes.lock().expect("espía").is_empty());
}

#[test]
fn el_rechazo_no_escribe_nada() {
    let espia = Espia::default();
    let fuente: FuenteVista = Arc::new(|| vista(ScreenState::Dialog));
    let e = Escritor::lanzar("test-g3", Box::new(espia.clone()), fuente).expect("escritor");
    assert_eq!(e.enviar(pegado("hola")), Err(ErrorEscritura::MenuAbierto));
    assert!(espia.bytes.lock().expect("espía").is_empty());
    // La respuesta DSR (exenta) sí se escribe aunque haya un menú.
    e.encargar(Trabajo::Exento(b"\x1b[1;1R".to_vec()));
    assert_eq!(e.enviar(Trabajo::Tecla(TeclaPty::Arriba)), Ok(()));
    assert_eq!(
        espia.bytes.lock().expect("espía").clone(),
        b"\x1b[1;1R\x1b[A".to_vec()
    );
}
