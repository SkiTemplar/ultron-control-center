// pty/escritor.rs — Escritor serializado por PTY (contrato de estabilidad,
// §3.2).
//
// Cada PTY tiene un hilo escritor que es el único que toca su `Write`. Los
// trabajos llegan por un canal y se ejecutan de uno en uno, así que un pegado
// más su Enter es atómico y ninguna tecla se cuela entre medias
// (`seguridad-robustez:F7`). Ningún lock global se mantiene durante la E/S
// (`SC-08`, `seguridad-robustez:F3`).
//
// Garantías comprobadas aquí, el único punto de paso (`Guardas`):
// - G1: un Esc suelto se rechaza si hubo otro en los 1.500 ms anteriores.
// - G2: Ctrl+C solo con la pantalla `busy` y como mucho uno cada 5 s.
// - G3: con un diálogo o la confianza en pantalla, o con texto en la caja de
//   entrada, no se admiten pegados ni Enter (salvo `TeclaDialogo`).
// - G4: con el proceso salido, todo trabajo es Err.
// - G5: Ctrl+B (segundo plano) solo con la pantalla `busy` y como mucho uno
//   cada 1,5 s: sin una tarea en primer plano, la TUI no lo interpreta como
//   `task:background`.
// `Exento` (respuesta DSR y terminal en superposición) solo pasa por G4.

use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::sesiones::types::ScreenState;

/// Ventana de G1 (Esc doble).
pub const VENTANA_ESC: Duration = Duration::from_millis(1500);
/// Ventana de G2 (Ctrl+C repetido).
pub const VENTANA_CTRL_C: Duration = Duration::from_secs(5);
/// Ventana de G5 (Ctrl+B repetido).
pub const VENTANA_CTRL_B: Duration = Duration::from_millis(1500);
/// Pausa entre el pegado y su Enter para que la TUI cierre el pegado.
pub const PAUSA_ENTER: Duration = Duration::from_millis(40);
/// Tope de espera del resultado de un trabajo: un PTY que no acepta
/// escritura no cuelga al llamador.
pub const ESPERA_MAX: Duration = Duration::from_secs(10);

/// Teclas especiales que conoce el escritor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeclaPty {
    Esc,
    CtrlC,
    Enter,
    Arriba,
    Abajo,
    Tab,
    ShiftTab,
    /// Ctrl+U: vacía la caja de entrada de la TUI (verificado en el spike).
    LimpiarLinea,
    /// Ctrl+B: pasa la tarea en primer plano a segundo plano (G5).
    SegundoPlano,
}

impl TeclaPty {
    pub fn bytes(self) -> &'static [u8] {
        match self {
            Self::Esc => b"\x1b",
            Self::CtrlC => b"\x03",
            Self::Enter => b"\r",
            Self::Arriba => b"\x1b[A",
            Self::Abajo => b"\x1b[B",
            Self::Tab => b"\t",
            Self::ShiftTab => b"\x1b[Z",
            Self::LimpiarLinea => b"\x15",
            Self::SegundoPlano => b"\x02",
        }
    }
}

/// Trabajo del escritor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trabajo {
    /// Pegado (ya envuelto en bracketed paste) y, si `enter`, 40 ms y `\r`.
    Pegado {
        bytes: Vec<u8>,
        enter: bool,
        /// Texto de la caja que G3 no cuenta como ocupada: el reintento tras
        /// un falso positivo de la pantalla (`caja::liberar`: `prompt.read`
        /// la lee vacía y la pantalla muestra un placeholder o una
        /// sugerencia). Solo ese texto exacto; si la caja muestra otro, G3
        /// rechaza como siempre. Un menú abierto se rechaza igualmente.
        tolerada: Option<String>,
    },
    Tecla(TeclaPty),
    /// Navegación de un diálogo que el llamador ha verificado en pantalla
    /// (`dialog_answer`, `trust_answer`, `exitMenu`): exenta de G3.
    TeclaDialogo(TeclaPty),
    /// Respuesta DSR del lector y terminal en superposición: solo G4.
    Exento(Vec<u8>),
}

/// Lo que el escritor necesita saber de la pantalla en el momento de
/// escribir.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Vista {
    pub pantalla: ScreenState,
    /// Texto de la caja de entrada; `None` si está vacía.
    pub entrada: Option<String>,
}

/// Fuente de la vista: la clasificación de la pantalla en ese instante.
pub type FuenteVista = Arc<dyn Fn() -> Vista + Send + Sync>;

/// Motivo de rechazo o fallo de un trabajo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorEscritura {
    EscDoble,
    CtrlCSinTrabajo,
    CtrlCRepetido,
    SegundoPlanoSinTrabajo,
    SegundoPlanoRepetido,
    MenuAbierto,
    EntradaConTexto,
    Terminada,
    /// Venció la espera antes de empezar: el trabajo se cancela y no sale.
    Atascado,
    /// Venció la espera con el trabajo ya empezado: pudo escribirse entero.
    SinConfirmar,
    Io(String),
}

impl std::fmt::Display for ErrorEscritura {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let t = match self {
            Self::EscDoble => {
                "Esc rechazado: ya se pulsó uno hace menos de 1,5 s (abriría el selector de rewind)"
            }
            Self::CtrlCSinTrabajo => {
                "Ctrl+C rechazado: Claude no está trabajando (saldría de la sesión)"
            }
            Self::CtrlCRepetido => {
                "Ctrl+C rechazado: ya se pulsó uno hace menos de 5 s (saldría de la sesión)"
            }
            Self::SegundoPlanoSinTrabajo => {
                "Ctrl+B rechazado: no hay ninguna tarea en primer plano"
            }
            Self::SegundoPlanoRepetido => "Ctrl+B rechazado: ya se pulsó uno hace menos de 1,5 s",
            Self::MenuAbierto => "La TUI tiene un menú abierto: sal del menú antes de enviar",
            Self::EntradaConTexto => "La caja de entrada de la TUI tiene texto",
            Self::Terminada => "la sesión terminó",
            Self::Atascado => "el PTY no acepta escritura (sin respuesta en 10 s)",
            Self::SinConfirmar => "el PTY tardó más de 10 s en escribir: el envío pudo salir",
            Self::Io(e) => return write!(f, "no se pudo escribir en el PTY: {e}"),
        };
        f.write_str(t)
    }
}

impl From<ErrorEscritura> for String {
    fn from(e: ErrorEscritura) -> Self {
        e.to_string()
    }
}

/// Estado de G1, G2 y G5 de un PTY. Función pura sobre el reloj que recibe.
#[derive(Debug, Default)]
pub struct Guardas {
    ultimo_esc: Option<Instant>,
    ultimo_ctrl_c: Option<Instant>,
    ultimo_ctrl_b: Option<Instant>,
}

impl Guardas {
    /// Decide si `t` puede escribirse ahora y, si sí, anota las teclas.
    pub fn admitir(
        &mut self,
        t: &Trabajo,
        vista: &Vista,
        salido: bool,
        ahora: Instant,
    ) -> Result<(), ErrorEscritura> {
        if salido {
            return Err(ErrorEscritura::Terminada);
        }
        match t {
            Trabajo::Exento(b) => {
                if b.as_slice() == TeclaPty::Esc.bytes() {
                    self.ultimo_esc = Some(ahora);
                }
                Ok(())
            }
            Trabajo::Tecla(k) => self.tecla(*k, vista, ahora, true),
            Trabajo::TeclaDialogo(k) => self.tecla(*k, vista, ahora, false),
            Trabajo::Pegado { tolerada, .. } => g3_tolerando(vista, tolerada.as_deref()),
        }
    }

    fn tecla(
        &mut self,
        k: TeclaPty,
        vista: &Vista,
        ahora: Instant,
        con_g3: bool,
    ) -> Result<(), ErrorEscritura> {
        match k {
            TeclaPty::Esc => {
                if dentro(self.ultimo_esc, ahora, VENTANA_ESC) {
                    return Err(ErrorEscritura::EscDoble);
                }
                self.ultimo_esc = Some(ahora);
                Ok(())
            }
            TeclaPty::CtrlC => {
                if vista.pantalla != ScreenState::Busy {
                    return Err(ErrorEscritura::CtrlCSinTrabajo);
                }
                if dentro(self.ultimo_ctrl_c, ahora, VENTANA_CTRL_C) {
                    return Err(ErrorEscritura::CtrlCRepetido);
                }
                self.ultimo_ctrl_c = Some(ahora);
                Ok(())
            }
            TeclaPty::SegundoPlano => {
                if vista.pantalla != ScreenState::Busy {
                    return Err(ErrorEscritura::SegundoPlanoSinTrabajo);
                }
                if dentro(self.ultimo_ctrl_b, ahora, VENTANA_CTRL_B) {
                    return Err(ErrorEscritura::SegundoPlanoRepetido);
                }
                self.ultimo_ctrl_b = Some(ahora);
                Ok(())
            }
            TeclaPty::Enter if con_g3 => g3(vista),
            _ => Ok(()),
        }
    }
}

fn dentro(antes: Option<Instant>, ahora: Instant, ventana: Duration) -> bool {
    antes.is_some_and(|t| ahora.saturating_duration_since(t) < ventana)
}

fn g3(vista: &Vista) -> Result<(), ErrorEscritura> {
    g3_tolerando(vista, None)
}

/// G3 sin contar como ocupada una caja que muestra exactamente `tolerada`.
/// El menú abierto (`Dialog`, `Trust`) se rechaza siempre.
fn g3_tolerando(vista: &Vista, tolerada: Option<&str>) -> Result<(), ErrorEscritura> {
    if matches!(vista.pantalla, ScreenState::Dialog | ScreenState::Trust) {
        return Err(ErrorEscritura::MenuAbierto);
    }
    match vista.entrada.as_deref() {
        Some(e) if !tolera(e, tolerada) => Err(ErrorEscritura::EntradaConTexto),
        _ => Ok(()),
    }
}

/// Comparación estricta del texto de la caja con el tolerado: igualdad byte
/// a byte del mismo texto normalizado (los dos salen de la misma
/// clasificación de pantalla, `Clasificacion::entrada`), sin ignorar espacios
/// ni saltos como `caja::mismo_texto`. Un cambio de un solo carácter entre la
/// lectura de G3 y la escritura (el usuario tecleó) cancela la tolerancia. Un
/// tolerado en blanco no tolera nada.
fn tolera(entrada: &str, tolerada: Option<&str>) -> bool {
    tolerada.is_some_and(|t| !t.trim().is_empty() && t == entrada)
}

type Respuesta = SyncSender<Result<(), ErrorEscritura>>;

/// Estados de un trabajo con espera: el llamador lo cancela si vence la
/// espera antes de que el hilo escritor lo empiece, y así un `Atascado`
/// nunca se escribe después.
const PENDIENTE: u8 = 0;
const EMPEZADO: u8 = 1;
const CANCELADO: u8 = 2;

/// Respuesta de un trabajo esperado y su marca de cancelación.
struct Espera {
    tx: Respuesta,
    marca: Arc<AtomicU8>,
}

impl Espera {
    /// true si el trabajo se puede empezar (no se canceló).
    fn empezar(&self) -> bool {
        self.marca
            .compare_exchange(PENDIENTE, EMPEZADO, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

enum Peticion {
    Trabajo(Trabajo, Option<Espera>),
    Cerrar,
}

/// Asa clonable del escritor de un PTY.
#[derive(Clone)]
pub struct Escritor {
    tx: Sender<Peticion>,
    salido: Arc<AtomicBool>,
}

impl Escritor {
    /// Lanza el hilo escritor dueño de `w`.
    pub fn lanzar(
        nombre: &str,
        w: Box<dyn Write + Send>,
        fuente: FuenteVista,
    ) -> std::io::Result<Self> {
        let (tx, rx) = mpsc::channel();
        let salido = Arc::new(AtomicBool::new(false));
        let s2 = salido.clone();
        std::thread::Builder::new()
            .name(format!("pty-escritor-{nombre}"))
            .spawn(move || bucle(w, &rx, &fuente, &s2))?;
        Ok(Self { tx, salido })
    }

    /// Ejecuta `t` y espera su resultado (como mucho `ESPERA_MAX`).
    pub fn enviar(&self, t: Trabajo) -> Result<(), ErrorEscritura> {
        self.enviar_con(t, ESPERA_MAX)
    }

    /// Si vence `espera` antes de que el hilo empiece el trabajo, se cancela
    /// (`Atascado`, no se escribirá); si ya había empezado, se espera otro
    /// tanto y, si tampoco acaba, `SinConfirmar`.
    fn enviar_con(&self, t: Trabajo, espera: Duration) -> Result<(), ErrorEscritura> {
        if self.salido.load(Ordering::SeqCst) {
            return Err(ErrorEscritura::Terminada);
        }
        let (rtx, rrx) = mpsc::sync_channel(1);
        let marca = Arc::new(AtomicU8::new(PENDIENTE));
        let e = Espera {
            tx: rtx,
            marca: marca.clone(),
        };
        self.tx
            .send(Peticion::Trabajo(t, Some(e)))
            .map_err(|_| ErrorEscritura::Terminada)?;

        match rrx.recv_timeout(espera) {
            Ok(r) => r,
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(ErrorEscritura::Terminada),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let cancelado = marca
                    .compare_exchange(PENDIENTE, CANCELADO, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok();
                if cancelado {
                    return Err(ErrorEscritura::Atascado);
                }
                match rrx.recv_timeout(espera) {
                    Ok(r) => r,
                    Err(mpsc::RecvTimeoutError::Timeout) => Err(ErrorEscritura::SinConfirmar),
                    Err(mpsc::RecvTimeoutError::Disconnected) => Err(ErrorEscritura::Terminada),
                }
            }
        }
    }

    /// Encarga `t` sin esperar (respuesta DSR del lector). Un fallo queda en
    /// el log del hilo escritor.
    pub fn encargar(&self, t: Trabajo) {
        if self.tx.send(Peticion::Trabajo(t, None)).is_err() {
            tracing::debug!("escritor cerrado: trabajo sin esperar descartado");
        }
    }

    /// G4: a partir de aquí todo trabajo es Err.
    pub fn marcar_salido(&self) {
        self.salido.store(true, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub fn salido(&self) -> bool {
        self.salido.load(Ordering::SeqCst)
    }

    /// Termina el hilo escritor y suelta el `Write` (cierra la entrada).
    pub fn cerrar(&self) {
        self.marcar_salido();
        let _ = self.tx.send(Peticion::Cerrar);
    }
}

fn bucle(
    mut w: Box<dyn Write + Send>,
    rx: &Receiver<Peticion>,
    fuente: &FuenteVista,
    salido: &AtomicBool,
) {
    let mut guardas = Guardas::default();
    for p in rx {
        let (t, resp) = match p {
            Peticion::Cerrar => break,
            Peticion::Trabajo(t, resp) => (t, resp),
        };
        let vista = if matches!(t, Trabajo::Exento(_)) {
            Vista::default()
        } else {
            fuente()
        };
        if resp.as_ref().is_some_and(|e| !e.empezar()) {
            tracing::warn!("trabajo del escritor cancelado: venció su espera antes de empezar");
            continue;
        }
        let r = guardas
            .admitir(&t, &vista, salido.load(Ordering::SeqCst), Instant::now())
            .and_then(|()| ejecutar(&mut *w, &t));
        match resp {
            Some(e) => {
                entregar(&e.tx, r);
            }
            None => {
                if let Err(e) = r {
                    tracing::warn!(error = %e, "trabajo sin esperar del escritor fallido");
                }
            }
        }
    }
}

/// Entrega el resultado al llamador. Si ya se fue (venció su espera y lo dio
/// por `SinConfirmar`) y la escritura falló, el error real queda en el log:
/// sin esto el envío seguía en `sending` y al depurar solo se veía «La CLI no
/// confirmó el envío», sin la causa. true si el error no llegó al llamador.
fn entregar(tx: &Respuesta, r: Result<(), ErrorEscritura>) -> bool {
    match tx.send(r) {
        Err(mpsc::SendError(Err(e))) => {
            tracing::warn!(error = %e, "escritura fallida tras vencer la espera");
            true
        }
        Ok(()) | Err(mpsc::SendError(Ok(()))) => false,
    }
}

fn escribir(w: &mut dyn Write, b: &[u8]) -> Result<(), ErrorEscritura> {
    w.write_all(b)
        .and_then(|()| w.flush())
        .map_err(|e| ErrorEscritura::Io(e.to_string()))
}

/// Escribe un trabajo ya admitido. El pegado y su Enter van seguidos.
pub fn ejecutar(w: &mut dyn Write, t: &Trabajo) -> Result<(), ErrorEscritura> {
    match t {
        Trabajo::Pegado { bytes, enter, .. } => {
            escribir(w, bytes)?;
            if *enter {
                std::thread::sleep(PAUSA_ENTER);
                escribir(w, b"\r")?;
            }
            Ok(())
        }
        Trabajo::Tecla(k) | Trabajo::TeclaDialogo(k) => escribir(w, k.bytes()),
        Trabajo::Exento(b) => escribir(w, b),
    }
}

#[cfg(test)]
#[path = "tests_escritor.rs"]
mod tests;

/// Cancelación por espera vencida (un `Atascado` no se escribe después).
#[cfg(test)]
mod tests_espera {
    use super::*;
    use std::sync::Mutex;

    #[derive(Clone, Default)]
    struct Lento {
        bytes: Arc<Mutex<Vec<u8>>>,
        retardo: Duration,
    }

    impl Write for Lento {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            std::thread::sleep(self.retardo);
            self.bytes.lock().expect("lento").extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn lanzar(w: Lento, pausa_vista: Duration) -> Escritor {
        let fuente: FuenteVista = Arc::new(move || {
            std::thread::sleep(pausa_vista);
            Vista {
                pantalla: ScreenState::Prompt,
                entrada: None,
            }
        });
        Escritor::lanzar("test-espera", Box::new(w), fuente).expect("escritor")
    }

    fn pegado() -> Trabajo {
        Trabajo::Pegado {
            bytes: b"hola".to_vec(),
            enter: false,
            tolerada: None,
        }
    }

    /// El llamador se fue (espera vencida): un error de E/S posterior no se
    /// descarta en silencio; un éxito tardío no es un error (caso negativo).
    #[test]
    fn un_error_tras_vencer_la_espera_se_registra() {
        let (tx, rx) = mpsc::sync_channel(1);
        drop(rx);
        assert!(entregar(
            &tx,
            Err(ErrorEscritura::Io("tubería rota".into()))
        ));
        assert!(!entregar(&tx, Ok(())));
        let (tx, rx) = mpsc::sync_channel(1);
        assert!(
            !entregar(&tx, Err(ErrorEscritura::Io("x".into()))),
            "con llamador"
        );
        assert!(rx.recv().expect("resultado").is_err());
    }

    #[test]
    fn un_trabajo_atascado_antes_de_empezar_no_se_escribe_despues() {
        let w = Lento::default();
        let e = lanzar(w.clone(), Duration::from_millis(300));
        let r = e.enviar_con(pegado(), Duration::from_millis(50));
        assert_eq!(r, Err(ErrorEscritura::Atascado));
        std::thread::sleep(Duration::from_millis(600));
        assert!(
            w.bytes.lock().expect("lento").is_empty(),
            "el pegado cancelado no sale"
        );
        e.cerrar();
    }

    #[test]
    fn un_trabajo_ya_empezado_cuando_vence_la_espera_queda_sin_confirmar() {
        let w = Lento {
            retardo: Duration::from_millis(300),
            ..Lento::default()
        };
        let e = lanzar(w.clone(), Duration::ZERO);
        let r = e.enviar_con(pegado(), Duration::from_millis(50));
        assert_eq!(r, Err(ErrorEscritura::SinConfirmar));
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(*w.bytes.lock().expect("lento"), b"hola".to_vec());
        e.cerrar();
    }
}
