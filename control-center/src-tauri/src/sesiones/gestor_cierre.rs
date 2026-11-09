// sesiones/gestor_cierre.rs — Cierre ordenado del PTY de una sesión de Claude.
//
// Matar el árbol del PTY sin más impide que Claude Code dispare `SessionEnd`:
// los hooks de ese evento (bitácora, lecciones, perfil, feedback y GC de
// memoria) no se ejecutaban nunca en las sesiones cerradas desde Sessions
// (auditoría Kirkardo del 2026-11-08). Antes de matar, se interrumpe el turno
// con Esc, se escribe `/exit` y se espera un plazo a que el proceso salga solo.
// Si no sale, se mata el árbol como antes. Corre en un hilo propio para que
// cerrar una sesión no bloquee el comando de la UI.

use std::time::{Duration, Instant};

use crate::pty::escritor::Trabajo;

/// Plazo para que Claude ejecute los hooks de `SessionEnd` y salga.
const PLAZO_SALIDA: Duration = Duration::from_secs(20);
const PAUSA_TECLA: Duration = Duration::from_millis(300);
const SONDEO: Duration = Duration::from_millis(200);

/// Operaciones sobre el PTY que necesita el cierre (inyectables en los tests).
pub(super) struct Pty<'a> {
    pub escribir: &'a dyn Fn(&[u8]) -> bool,
    pub corriendo: &'a dyn Fn() -> bool,
    pub matar: &'a dyn Fn(),
    pub dormir: &'a dyn Fn(Duration),
}

/// Pide la salida a Claude y mata el árbol solo si no sale en `plazo`.
/// Devuelve `true` si el proceso salió por su cuenta.
pub(super) fn cerrar_con(pty: &Pty, plazo: Duration) -> bool {
    if !(pty.corriendo)() {
        return true;
    }
    let pedido = (pty.escribir)(b"\x1b")
        && {
            (pty.dormir)(PAUSA_TECLA);
            (pty.escribir)(b"/exit")
        }
        && {
            (pty.dormir)(PAUSA_TECLA);
            (pty.escribir)(b"\r")
        };
    if pedido {
        let inicio = Instant::now();
        while (pty.corriendo)() && inicio.elapsed() < plazo {
            (pty.dormir)(SONDEO);
        }
    }
    let salio = !(pty.corriendo)();
    if !salio {
        (pty.matar)();
    }
    salio
}

/// Cierra el PTY `pty_id` en segundo plano y lo retira del registro al final.
pub(super) fn cerrar_en_segundo_plano(sesion: &str, pty_id: String) {
    let sesion = sesion.to_string();
    let respaldo = pty_id.clone();
    let hilo = std::thread::Builder::new()
        .name(format!("cierre-{pty_id}"))
        .spawn(move || {
            let pty = Pty {
                escribir: &|b| {
                    crate::pty::io::enviar(&pty_id, Trabajo::Exento(b.to_vec())).is_ok()
                },
                corriendo: &|| crate::pty::io::corriendo(&pty_id),
                matar: &|| {
                    if let Err(e) = crate::pty::io::kill(&pty_id) {
                        tracing::debug!(sesion = %sesion, error = %e, "kill de un PTY ya terminado");
                    }
                },
                dormir: &std::thread::sleep,
            };
            let salio = cerrar_con(&pty, PLAZO_SALIDA);
            tracing::info!(sesion = %sesion, salio_solo = salio, "cierre del PTY de la sesión");
            crate::pty::io::forget(&pty_id);
        });
    if let Err(e) = hilo {
        tracing::warn!(error = %e, "sin hilo de cierre: se mata el PTY sin SessionEnd");
        if let Err(e) = crate::pty::io::kill(&respaldo) {
            tracing::debug!(error = %e, "kill de un PTY ya terminado");
        }
        crate::pty::io::forget(&respaldo);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct Falso {
        escrito: RefCell<Vec<Vec<u8>>>,
        vivo_hasta: Cell<u32>,
        sondeos: Cell<u32>,
        matado: Cell<bool>,
        escribe: bool,
    }

    impl Falso {
        fn nuevo(vivo_hasta: u32, escribe: bool) -> Self {
            Self {
                escrito: RefCell::default(),
                vivo_hasta: Cell::new(vivo_hasta),
                sondeos: Cell::new(0),
                matado: Cell::new(false),
                escribe,
            }
        }
        fn cerrar(&self, plazo: Duration) -> bool {
            let pty = Pty {
                escribir: &|b| {
                    self.escrito.borrow_mut().push(b.to_vec());
                    self.escribe
                },
                corriendo: &|| {
                    self.sondeos.set(self.sondeos.get() + 1);
                    !self.matado.get() && self.sondeos.get() <= self.vivo_hasta.get()
                },
                matar: &|| self.matado.set(true),
                dormir: &|_| {},
            };
            cerrar_con(&pty, plazo)
        }
    }

    #[test]
    fn pide_exit_y_no_mata_si_claude_sale_solo() {
        let f = Falso::nuevo(3, true);
        assert!(f.cerrar(Duration::from_secs(5)));
        assert_eq!(
            *f.escrito.borrow(),
            vec![b"\x1b".to_vec(), b"/exit".to_vec(), b"\r".to_vec()]
        );
        assert!(!f.matado.get());
    }

    #[test]
    fn mata_el_arbol_si_no_sale_en_el_plazo() {
        let f = Falso::nuevo(u32::MAX, true);
        assert!(!f.cerrar(Duration::ZERO));
        assert!(f.matado.get());
    }

    #[test]
    fn si_no_puede_escribir_mata_sin_esperar() {
        let f = Falso::nuevo(u32::MAX, false);
        assert!(!f.cerrar(Duration::from_secs(3600)));
        assert!(f.matado.get());
        assert_eq!(f.escrito.borrow().len(), 1);
    }

    #[test]
    fn un_pty_ya_terminado_no_se_toca() {
        let f = Falso::nuevo(0, true);
        assert!(f.cerrar(Duration::from_secs(5)));
        assert!(f.escrito.borrow().is_empty());
        assert!(!f.matado.get());
    }
}
