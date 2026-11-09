// pty/tests_salida.rs — Registro sin bloqueo, salida del proceso y kill del
// árbol (contrato de estabilidad, §3.2 y §3.4; AC-13, AC-14).

use std::io::{self, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::escritor::{Escritor, FuenteVista, Trabajo, Vista};
use super::registry;
use super::types::{PtySession, PtyStatus, Salida};

#[test]
fn la_bandera_de_saltarse_permisos_nunca_con_permission_mode() {
    use super::ops::anadir_bandera_skip;
    let con_modo = vec![
        "--permission-mode".to_string(),
        "bypassPermissions".to_string(),
    ];
    assert!(!anadir_bandera_skip("claude", &con_modo, false));
    assert!(!anadir_bandera_skip("claude", &con_modo, true));
    // Un llamante sin --permission-mode (el RunBatch, retirado el 2026-10-17).
    assert!(anadir_bandera_skip("claude", &[], false));
    assert!(!anadir_bandera_skip("claude", &[], true));
    assert!(!anadir_bandera_skip("codex", &[], false));
}

/// `Write` que tarda `retardo` en cada escritura (lector lento de ConPTY).
struct Lento(Duration);

impl Write for Lento {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        std::thread::sleep(self.0);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Sesión sin proceso ni pseudoconsola, registrada con `id`.
fn sesion_falsa(id: &str, retardo: Duration) -> Arc<PtySession> {
    let fuente: FuenteVista = Arc::new(Vista::default);
    let escritor = Escritor::lanzar(id, Box::new(Lento(retardo)), fuente).expect("escritor");
    let s = Arc::new(PtySession {
        id: id.to_string(),
        provider: "test".into(),
        estado: Mutex::new(PtyStatus::Running),
        salida: Mutex::new(Salida {
            buffer: b"pantalla".to_vec(),
            subscribed: false,
        }),
        live_event: None,
        escritor,
        master: Mutex::new(None),
        killer: Mutex::new(None),
        arbol: Mutex::new(None),
    });
    registry::insert(s.clone());
    s
}

/// AC-14: con el escritor de una sesión bloqueado 2 s, `snapshot()` de otra
/// responde al momento (con el lock global de antes esperaba a la escritura).
#[test]
fn snapshot_de_otra_sesion_no_espera_a_un_escritor_bloqueado() {
    let lenta = sesion_falsa("pty-test-lenta", Duration::from_secs(2));
    let _rapida = sesion_falsa("pty-test-rapida", Duration::ZERO);
    let h = std::thread::spawn(move || {
        lenta.escritor.enviar(Trabajo::Pegado {
            bytes: b"grande".to_vec(),
            enter: false,
            tolerada: None,
        })
    });
    std::thread::sleep(Duration::from_millis(50));
    let t = Instant::now();
    let snap = super::io::snapshot("pty-test-rapida").expect("snapshot");
    let tardo = t.elapsed();
    assert!(
        tardo < Duration::from_millis(100),
        "snapshot tardó {tardo:?}"
    );
    assert_eq!(snap, b"pantalla".to_vec());
    assert!(h.join().expect("hilo").is_ok());
    for id in ["pty-test-lenta", "pty-test-rapida"] {
        let _ = registry::remove(id);
    }
}

#[test]
fn forget_no_suelta_una_sesion_viva() {
    let _s = sesion_falsa("pty-test-viva", Duration::ZERO);
    super::io::forget("pty-test-viva");
    assert!(registry::get("pty-test-viva").is_ok());
    let _ = registry::remove("pty-test-viva");
}

#[test]
fn marcar_salida_respeta_el_kill_y_cierra_el_escritor() {
    let s = sesion_falsa("pty-test-salida", Duration::ZERO);
    assert_eq!(super::salida::marcar_salida(&s, 3), 3);
    assert_eq!(s.status(), PtyStatus::Exited(3));
    assert!(s.escritor.salido());
    let k = sesion_falsa("pty-test-matada", Duration::ZERO);
    *k.estado.lock().expect("estado") = PtyStatus::Killed;
    assert_eq!(super::salida::marcar_salida(&k, 1), -1);
    assert_eq!(k.status(), PtyStatus::Killed);
    for id in ["pty-test-salida", "pty-test-matada"] {
        let _ = registry::remove(id);
    }
}

#[cfg(windows)]
mod reales {
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::time::Duration;

    use portable_pty::CommandBuilder;

    use super::super::escritor::{ErrorEscritura, Trabajo};
    use super::super::ops::{lanzar, Emisor, Lanzamiento};
    use super::super::{io, registry};

    fn lanzar_cmd(args: &[&str], tx: mpsc::Sender<i32>) -> String {
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.args(args);
        let emisor: Emisor = Arc::new(|_, _| {});
        let l = Lanzamiento {
            id: registry::new_ulid(),
            provider: "test".into(),
            cols: 80,
            rows: 24,
            live_event: None,
            on_exit: Box::new(move |c| {
                let _ = tx.send(c);
            }),
            on_output: None,
            vista: None,
        };
        lanzar(cmd, l, emisor).expect("lanzar")
    }

    /// Tope de espera de los eventos de salida. La detección es un `wait()`
    /// bloqueante sobre el handle (sin sondeo), así que el fallo que se busca
    /// es que el evento no llegue nunca, no que tarde. El tope anterior, 2 s,
    /// incluía el arranque de `cmd.exe` en ConPTY y en windows-latest, con
    /// 2.000 tests en paralelo, se superó (run 39280366423: «sin salida en
    /// 2 s: Timeout»). 10 s sigue separando «llega» de «se cuelga».
    const TOPE_SALIDA: Duration = Duration::from_secs(10);

    /// AC-13 (`comandos:M2`, `seguridad-robustez:F4`): la salida del proceso
    /// se detecta por su handle aunque ConPTY no dé EOF.
    #[test]
    fn la_salida_del_proceso_llega_sin_eof_y_bloquea_la_escritura() {
        let (tx, rx) = mpsc::channel();
        let id = lanzar_cmd(&["/C", "exit", "3"], tx);
        let code = rx
            .recv_timeout(TOPE_SALIDA)
            .expect("sin salida dentro del tope");
        assert_eq!(code, 3);
        let r = io::enviar(
            &id,
            Trabajo::Pegado {
                bytes: b"x".to_vec(),
                enter: true,
                tolerada: None,
            },
        );
        assert_eq!(r, Err(ErrorEscritura::Terminada));
        io::forget(&id);
    }

    /// Caso negativo: un proceso vivo no dispara la salida; al matarlo, sí
    /// (con `-1`, que no genera alerta) y `forget` lo saca del registro.
    #[test]
    fn un_proceso_vivo_no_dispara_la_salida_y_kill_si() {
        let (tx, rx) = mpsc::channel();
        let id = lanzar_cmd(&["/C", "ping", "-n", "30", "127.0.0.1"], tx);
        assert!(rx.recv_timeout(Duration::from_millis(1500)).is_err());
        io::kill(&id).expect("kill");
        let code = rx.recv_timeout(TOPE_SALIDA).expect("sin salida tras kill");
        assert_eq!(code, -1);
        io::forget(&id);
        assert!(registry::get(&id).is_err());
    }
}
