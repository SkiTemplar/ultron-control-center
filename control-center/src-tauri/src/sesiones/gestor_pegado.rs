// sesiones/gestor_pegado.rs — Escritura de un pegado con su Enter por el
// escritor del PTY (G3: caja de la TUI ocupada), la espera al prompt durante
// el arranque y la vigilancia de que el Enter salió. Submódulo de
// `gestor.rs`; `escribir_pegado` se reexporta allí.

use std::time::{Duration, Instant};

use super::super::types::{ScreenState, SessionStatus};
use super::super::{caja, cola, pantalla, registro, senales};
use crate::pty::escritor::{ErrorEscritura, TeclaPty, Trabajo};

/// Sin máquina de estados, un envío durante el arranque espera al prompt.
const ESPERA_ARRANQUE: Duration = Duration::from_secs(120);
/// Margen tras un envío para comprobar que su Enter salió (`vigilar_enter`).
const ESPERA_ENTER: Duration = Duration::from_secs(3);

/// Escribe un pegado con su Enter. Con la caja de la TUI ocupada (G3), la
/// vacía (`caja::despejar`: puente v2 o Ctrl+U), devuelve a la cola el texto
/// que salió de ella y reintenta una vez con la caja ya vacía en pantalla; si
/// no se vacía, Err y el drenaje automático de la sesión queda en pausa hasta
/// que la caja cambie. Si `prompt.read` lee la caja vacía y la pantalla aún
/// muestra texto (falso positivo del clasificador), el reintento tolera ese
/// texto (`caja.rs`, punto 4). `en_vuelo` es el `clientId` del envío que se
/// escribe: si la caja tenía su mismo texto, no se reencola.
pub fn escribir_pegado(id: &str, bytes: Vec<u8>, en_vuelo: Option<&str>) -> Result<(), String> {
    escribir_pegado_con(id, bytes, en_vuelo, &caja::BuzonReal)
}

/// `escribir_pegado` con el buzón inyectable (los tests no tienen mod).
pub(super) fn escribir_pegado_con(
    id: &str,
    bytes: Vec<u8>,
    en_vuelo: Option<&str>,
    buzon: &dyn caja::BuzonOps,
) -> Result<(), String> {
    if registro::read(id, |s| s.info.status)? == SessionStatus::Exited {
        return Err(ErrorEscritura::Terminada.to_string());
    }
    if !senales::hay_manejador() {
        esperar_arranque(id);
    }
    let pty = registro::pty_id(id)?;
    let pegado = |bytes, tolerada| Trabajo::Pegado {
        bytes,
        enter: true,
        tolerada,
    };
    match crate::pty::io::enviar(&pty, pegado(bytes.clone(), None)) {
        Err(ErrorEscritura::EntradaConTexto) => {
            let v2 = registro::read(id, |s| s.info.bridge_protocol >= 2)?;
            let pantalla = PantallaPty { id, pty: &pty };
            let mut recuperar = |texto: String| match en_vuelo {
                Some(c) => cola::recuperar_entrada_excepto(id, texto, c),
                None => cola::recuperar_entrada(id, texto),
            };
            let tolerada =
                caja::despejar(id, v2, buzon, &pantalla, caja::pausas(), &mut recuperar)?;
            resultado_pegado(id, crate::pty::io::enviar(&pty, pegado(bytes, tolerada)))
        }
        r => resultado_pegado(id, r),
    }
}

/// Pantalla emulada y escritor del PTY de una sesión, para `caja::liberar`.
struct PantallaPty<'a> {
    id: &'a str,
    pty: &'a str,
}

impl caja::Pantalla for PantallaPty<'_> {
    fn entrada(&self) -> Option<String> {
        pantalla::actual(self.id).entrada
    }
    fn limpiar_linea(&self) -> Result<(), ErrorEscritura> {
        crate::pty::io::enviar(self.pty, Trabajo::Tecla(TeclaPty::LimpiarLinea))
    }
    fn dormir(&self, d: Duration) {
        std::thread::sleep(d);
    }
}

/// `SinConfirmar`: el hilo escritor ya había empezado el pegado cuando venció
/// la espera, así que pudo salir entero. Se trata como escrito (el envío queda
/// en `sending` y lo resuelven el emparejado o los huérfanos): darlo por
/// fallido invitaba a reenviarlo y duplicarlo.
fn resultado_pegado(id: &str, r: Result<(), ErrorEscritura>) -> Result<(), String> {
    match r {
        Err(ErrorEscritura::SinConfirmar) => {
            tracing::warn!(
                sesion = id,
                "{}: se da por escrito",
                ErrorEscritura::SinConfirmar
            );
            Ok(())
        }
        r => r.map_err(String::from),
    }
}

/// Tras un envío, si pasado `ESPERA_ENTER` la TUI sigue en el prompt con el
/// texto en la caja, el Enter no salió: solo se registra (id y longitud, sin
/// el contenido); no se reenvía nada.
pub(super) fn vigilar_enter(id: &str, texto: &str) {
    let (sid, texto) = (id.to_string(), texto.to_string());
    let hilo = std::thread::Builder::new()
        .name("sesiones-enter".into())
        .spawn(move || {
            std::thread::sleep(ESPERA_ENTER);
            let c = pantalla::actual(&sid);
            if c.estado == ScreenState::Prompt && caja::enter_sin_salir(c.entrada.as_deref(), &texto)
            {
                tracing::warn!(
                    sesion = %sid,
                    largo = texto.chars().count(),
                    "el Enter del envío no salió: la caja de la TUI sigue con su texto (no se reenvía)"
                );
            }
        });
    if let Err(e) = hilo {
        tracing::debug!(sesion = id, error = %e, "sin vigilancia del Enter");
    }
}

/// Reserva sin cola en el backend: mientras la TUI arranca (pantalla
/// `unknown`), el envío espera al prompt en vez de perderse.
fn esperar_arranque(id: &str) {
    let inicio = Instant::now();
    while pantalla::actual(id).estado == ScreenState::Unknown
        && inicio.elapsed() < ESPERA_ARRANQUE
        && registro::exists(id)
    {
        std::thread::sleep(Duration::from_millis(100));
    }
}
