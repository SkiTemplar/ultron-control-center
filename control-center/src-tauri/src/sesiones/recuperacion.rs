// sesiones/recuperacion.rs — Interrumpir, salir del menú, responder diálogos
// de la TUI y cambiar el modo de permisos (contrato de estabilidad, §3.3,
// §4.6 y §2.5; `comandos:SC-07`, `SC-17`, `chat-orden:F18`).
//
// Los algoritmos trabajan contra el trait `Entorno` (pantalla, escritor,
// buzón y reloj) para probarlos sin PTY. Todo Esc y Ctrl+C sale por el
// escritor, que aplica G1 y G2: nunca dos Esc en 1,5 s ni dos Ctrl+C en 5 s.
//
// Propiedad: WP-PTY.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::lanzamiento::{self, Arranque};
use super::pantalla::Clasificacion;
use super::registro;
use super::senales::{self, EstadoPantalla, MotivoFallo, Senal};
use super::types::{
    OpResult, PermissionMode, RecoverAction, RecoverOptions, RecoverOutcome, SessionStatus,
};
use crate::pty::escritor::{ErrorEscritura, TeclaPty, Trabajo, VENTANA_ESC};
use crate::pty::types::bloquear;

#[path = "recuperacion_interrumpir.rs"]
mod interrupcion;
pub use interrupcion::interrumpir;

/// Paso de sondeo de las esperas.
pub const PASO: Duration = Duration::from_millis(50);
/// Antirrebote entre dos recuperaciones de la misma sesión.
pub const ANTIRREBOTE: Duration = Duration::from_millis(1500);
pub(super) const ESPERA_TURNO: Duration = Duration::from_secs(2);
const ESPERA_MENU: Duration = Duration::from_secs(1);
const ESPERA_MODO: Duration = Duration::from_millis(700);
const ESPERA_CURSOR: Duration = Duration::from_millis(500);
const MAX_SHIFT_TAB: usize = 5;

/// Lo que la recuperación necesita de una sesión.
pub trait Entorno {
    fn pantalla(&self) -> Clasificacion;
    fn escribir(&self, t: Trabajo) -> Result<(), ErrorEscritura>;
    /// `turnId` abierto si la sesión tiene puente v2.
    fn turno_v2(&self) -> Option<String>;
    /// `turn.abort` por el buzón; true si el mod respondió ok a tiempo.
    fn abortar_turno(&self, turn_id: &str) -> bool;
    /// `prompt.clear` por el buzón; `None` sin puente v2.
    fn limpiar_caja_v2(&self) -> Option<bool>;
    /// true si no hay turno principal abierto.
    fn turno_cerrado(&self) -> bool;
    fn senal(&self, s: Senal);
    /// Devuelve a la cola el texto que había en la caja de la TUI.
    fn recuperar(&self, texto: String);
    fn dormir(&self, d: Duration);
    /// true si, desde que empezó la recuperación, la CLI retomó el turno con
    /// la notificación de una tarea en segundo plano (Bash o subagente).
    fn retomado_por_tarea(&self) -> bool {
        false
    }
    /// true si, desde que empezó la recuperación, el puente abrió o cerró
    /// algún turno principal: la CLI respondió, aunque siga ocupada.
    fn actividad_puente(&self) -> bool {
        false
    }
    /// true si la cola nativa de la CLI tiene mensajes (`cliQueued`).
    fn cola_nativa(&self) -> bool {
        false
    }
}

type Marcas = Mutex<HashMap<String, Instant>>;

/// Última `<task-notification>` del hilo principal de cada sesión (la anotan
/// el puente en tiempo real y, de respaldo, el seguidor del transcript).
fn tareas() -> &'static Marcas {
    static M: OnceLock<Marcas> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Último `turnStart` o `turnEnd` del hilo principal por el puente.
fn turnos() -> &'static Marcas {
    static M: OnceLock<Marcas> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// La CLI abre (o va a abrir) un turno con una `<task-notification>` aunque
/// se acabe de interrumpir.
pub fn anotar_tarea(id: &str) {
    bloquear(tareas()).insert(id.to_string(), Instant::now());
}

/// El puente abrió o cerró un turno principal de `id`.
pub fn anotar_turno(id: &str) {
    bloquear(turnos()).insert(id.to_string(), Instant::now());
}

fn marca_desde(m: &Marcas, id: &str, desde: Instant) -> bool {
    bloquear(m).get(id).is_some_and(|t| *t >= desde)
}

pub(crate) fn tarea_desde(id: &str, desde: Instant) -> bool {
    marca_desde(tareas(), id, desde)
}

pub(crate) fn turno_desde(id: &str, desde: Instant) -> bool {
    marca_desde(turnos(), id, desde)
}

/// Sesión cerrada: quita sus marcas de tarea y de turno y las reservas de
/// sus acciones (`<id>:<acción>`, también la de segundo plano), para que los
/// mapas globales no crezcan con cada sesión que se abre y se cierra.
pub fn olvidar(id: &str) {
    bloquear(tareas()).remove(id);
    bloquear(turnos()).remove(id);
    let prefijo = format!("{id}:");
    bloquear(marcas()).retain(|clave, _| !clave.starts_with(&prefijo));
}

/// Resultado de una recuperación.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resultado {
    pub ok: bool,
    pub steps: Vec<String>,
}

pub(super) fn esperar(e: &dyn Entorno, max: Duration, pred: impl Fn(&dyn Entorno) -> bool) -> bool {
    let mut t = Duration::ZERO;
    loop {
        if pred(e) {
            return true;
        }
        if t >= max {
            return false;
        }
        e.dormir(PASO);
        t += PASO;
    }
}

pub(super) fn fuera_de_busy(e: &dyn Entorno) -> bool {
    e.pantalla().estado != EstadoPantalla::Busy
}

fn en_menu(c: &Clasificacion) -> bool {
    matches!(c.estado, EstadoPantalla::Dialog | EstadoPantalla::Trust)
}

/// Devuelve a la cola de ULTRON el texto de la caja de la TUI (la CLI sacó
/// ahí su cola nativa), la limpia y lo verifica.
pub(super) fn devolver_entrada(
    e: &dyn Entorno,
    texto: String,
    paso: &str,
    steps: &mut Vec<String>,
) {
    e.recuperar(texto);
    steps.push(paso.to_string());
    let limpia = match e.limpiar_caja_v2() {
        Some(true) => true,
        _ => e.escribir(Trabajo::Tecla(TeclaPty::LimpiarLinea)).is_ok(),
    };
    if !limpia || !esperar(e, ESPERA_MENU, |e| e.pantalla().entrada.is_none()) {
        steps.push("entradaSinLimpiar".to_string());
    }
}

/// Paso 7: si la caja quedó con texto (la CLI devolvió su cola nativa), se
/// devuelve a la cola de ULTRON y se limpia; después se verifica.
pub(super) fn terminar(e: &dyn Entorno, mut steps: Vec<String>) -> Resultado {
    if let Some(texto) = e.pantalla().entrada {
        devolver_entrada(e, texto, "entradaRecuperada", &mut steps);
    }
    e.senal(Senal::RecuperacionTerminada {
        ok: true,
        motivo: None,
    });
    Resultado { ok: true, steps }
}

/// §3.3 `exitMenu`: un Esc; si el menú sigue (p. ej. el primer Esc de
/// `/config` solo limpia la búsqueda), un segundo Esc fuera de la ventana de
/// G1; si aún sigue, Err y se ofrece reiniciar.
pub fn salir_menu(e: &dyn Entorno) -> Resultado {
    if !en_menu(&e.pantalla()) {
        return Resultado {
            ok: true,
            steps: vec!["sinMenu".to_string()],
        };
    }
    let mut steps = Vec::new();
    for intento in 0..2 {
        if intento == 1 {
            // Fuera de la ventana de G1 contando la espera anterior.
            e.dormir(VENTANA_ESC.saturating_sub(ESPERA_MENU) + Duration::from_millis(100));
        }
        match e.escribir(Trabajo::Tecla(TeclaPty::Esc)) {
            Ok(()) => steps.push("esc".to_string()),
            Err(err) => steps.push(format!("esc: {err}")),
        }
        if esperar(e, ESPERA_MENU, |e| !en_menu(&e.pantalla())) {
            e.senal(Senal::RecuperacionTerminada {
                ok: true,
                motivo: None,
            });
            return Resultado { ok: true, steps };
        }
    }
    steps.push("menuSigueAbierto".to_string());
    e.senal(Senal::RecuperacionTerminada {
        ok: false,
        motivo: Some(MotivoFallo::MenuAbierto),
    });
    Resultado { ok: false, steps }
}

/// §4.6: mueve el cursor hasta la opción `index`, verifica que está
/// resaltada y confirma con Enter. Err si no puede verificarlo.
pub fn responder_dialogo(e: &dyn Entorno, index: u32) -> Result<(), String> {
    let c = e.pantalla();
    if !en_menu(&c) {
        return Err("no hay ningún diálogo abierto en la TUI".to_string());
    }
    let opts = c.opciones;
    let objetivo = usize::try_from(index)
        .ok()
        .filter(|i| *i < opts.len())
        .ok_or_else(|| format!("el diálogo no tiene la opción {index}"))?;
    let actual = opts
        .iter()
        .position(|o| o.selected)
        .ok_or_else(|| "no se ve qué opción está resaltada".to_string())?;
    let tecla = if objetivo > actual {
        TeclaPty::Abajo
    } else {
        TeclaPty::Arriba
    };
    let mut pos = actual;
    while pos != objetivo {
        pos = if objetivo > pos { pos + 1 } else { pos - 1 };
        e.escribir(Trabajo::TeclaDialogo(tecla))
            .map_err(String::from)?;
        let esperado = opts[pos].label.clone();
        if !esperar(e, ESPERA_CURSOR, |e| resaltada(e) == Some(esperado.clone())) {
            return Err(format!(
                "no se pudo verificar la opción resaltada (esperaba «{esperado}»)"
            ));
        }
    }
    e.escribir(Trabajo::TeclaDialogo(TeclaPty::Enter))
        .map_err(String::from)
}

fn resaltada(e: &dyn Entorno) -> Option<String> {
    e.pantalla()
        .opciones
        .into_iter()
        .find(|o| o.selected)
        .map(|o| o.label)
}

/// Confianza en la carpeta del arranque: «Yes, I trust…» o «No, exit».
pub fn responder_confianza(e: &dyn Entorno, aceptar: bool) -> Result<(), String> {
    let c = e.pantalla();
    if c.estado != EstadoPantalla::Trust {
        return Err("la TUI no muestra el diálogo de confianza".to_string());
    }
    let prefijo = if aceptar { "yes" } else { "no" };
    let o = c
        .opciones
        .iter()
        .find(|o| o.label.to_lowercase().starts_with(prefijo))
        .ok_or_else(|| "no se encuentra la opción en el diálogo de confianza".to_string())?;
    responder_dialogo(e, o.index)
}

/// §2.5: Shift+Tab en bucle (como mucho 5) hasta que el indicador del pie
/// muestre `objetivo` (nombre de `--permission-mode`).
pub fn cambiar_modo(e: &dyn Entorno, objetivo: &str) -> Result<String, String> {
    let c = e.pantalla();
    if c.modo.as_deref() == Some(objetivo) {
        return Ok(format!("El modo ya era {objetivo}"));
    }
    if !matches!(c.estado, EstadoPantalla::Prompt | EstadoPantalla::Busy) {
        return Err("la TUI no muestra el pie con el modo (¿menú abierto?)".to_string());
    }
    for _ in 0..MAX_SHIFT_TAB {
        let antes = e.pantalla().modo;
        e.escribir(Trabajo::Tecla(TeclaPty::ShiftTab))
            .map_err(String::from)?;
        esperar(e, ESPERA_MODO, |e| e.pantalla().modo != antes);
        if e.pantalla().modo.as_deref() == Some(objetivo) {
            return Ok(format!("Modo de permisos: {objetivo}"));
        }
    }
    Err(format!(
        "El modo {objetivo} no está en el ciclo de esta sesión: reinicia la sesión en ese modo"
    ))
}

// ---------------------------------------------------------------------------
// Antirrebote por sesión
// ---------------------------------------------------------------------------

/// Resultado de `reservar`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reserva {
    /// Reservada: la acción puede empezar.
    Libre,
    /// Hay otra igual en curso.
    EnCurso,
    /// La anterior terminó hace menos de 1,5 s (doble clic).
    Antirrebote,
}

#[derive(Debug, Clone, Copy)]
struct Marca {
    en_curso: bool,
    ultima: Instant,
}

fn marcas() -> &'static Mutex<HashMap<String, Marca>> {
    static M: OnceLock<Mutex<HashMap<String, Marca>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Reserva la acción `clave` (sesión y acción). `EnCurso` si hay otra igual
/// en marcha; `Antirrebote` si la última terminó hace menos de 1,5 s (doble
/// clic). Acciones distintas no se bloquean entre sí: «Recuperar» encadena
/// `interrupt` y, si falla, `exitMenu`.
pub fn reservar(clave: &str, ahora: Instant) -> Reserva {
    let mut m = bloquear(marcas());
    if let Some(x) = m.get(clave) {
        if x.en_curso {
            return Reserva::EnCurso;
        }
        if ahora.saturating_duration_since(x.ultima) < ANTIRREBOTE {
            return Reserva::Antirrebote;
        }
    }
    m.insert(
        clave.to_string(),
        Marca {
            en_curso: true,
            ultima: ahora,
        },
    );
    Reserva::Libre
}

/// Si la acción `clave` está reservada ahora mismo (sin reservarla).
pub fn en_curso(clave: &str) -> bool {
    bloquear(marcas()).get(clave).is_some_and(|x| x.en_curso)
}

/// Libera la reserva; la ventana del antirrebote empieza en `ahora`.
pub fn liberar(clave: &str, ahora: Instant) {
    bloquear(marcas()).insert(
        clave.to_string(),
        Marca {
            en_curso: false,
            ultima: ahora,
        },
    );
}

/// Clave de la reserva de una acción de §3.3 sobre la sesión `id`. La usan
/// `sesiones_recover` e «Interrumpir y enviar», así que un Esc del composer
/// y ese botón no interrumpen a la vez.
pub fn clave_reserva(id: &str, action: RecoverAction) -> String {
    format!("{id}:{action:?}")
}

/// Libera la reserva al salir, también si la acción entra en pánico.
pub(super) struct Liberar<'a>(pub(super) &'a str);

impl Drop for Liberar<'_> {
    fn drop(&mut self) {
        liberar(self.0, Instant::now());
    }
}

/// Qué responde `accion_reservada` cuando la acción ya está reservada.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiReservada {
    /// `sesiones_recover`: la otra acción ya informa de su resultado, así
    /// que esta cuenta como hecha (`ok: true`) con el paso `enCurso` o
    /// `antirrebote`.
    CuentaComoHecha,
    /// «Interrumpir y enviar» necesita saber si el turno está parado. Con
    /// otra en curso aún no se sabe (`ok: false`, paso `enCurso`, que el
    /// llamante sabe esperar); en el antirrebote la anterior ya terminó y
    /// vale si la pantalla ya no está ocupada.
    ComprobarPantalla,
}

/// Ejecuta `accion` sobre `env` con la reserva de `clave` tomada y la libera
/// al terminar (también si entra en pánico). Si ya está reservada no llama a
/// `accion` y responde según `si`, con un único paso `enCurso` o
/// `antirrebote`.
pub fn accion_reservada(
    env: &dyn Entorno,
    clave: &str,
    si: SiReservada,
    accion: impl FnOnce(&dyn Entorno) -> Resultado,
) -> Resultado {
    let reserva = reservar(clave, Instant::now());
    if reserva == Reserva::Libre {
        let _liberar = Liberar(clave);
        return accion(env);
    }
    let antirrebote = reserva == Reserva::Antirrebote;
    let ok = match si {
        SiReservada::CuentaComoHecha => true,
        SiReservada::ComprobarPantalla => antirrebote && fuera_de_busy(env),
    };
    let paso = if antirrebote {
        "antirrebote"
    } else {
        "enCurso"
    };
    Resultado {
        ok,
        steps: vec![paso.to_string()],
    }
}

// ---------------------------------------------------------------------------
// Entorno real de una sesión
// ---------------------------------------------------------------------------

/// Espera de las operaciones del buzón que tienen reserva por PTY.
const ESPERA_BUZON: Duration = Duration::from_secs(1);

/// `Entorno` sobre la sesión viva: pantalla emulada, escritor del PTY,
/// buzón del puente v2 y cola del backend.
pub struct EntornoSesion {
    id: String,
    pty: String,
    inicio: Instant,
}

impl EntornoSesion {
    pub fn nuevo(id: &str) -> Result<Self, String> {
        let pty = super::registro::pty_id(id)?;
        if pty.is_empty() {
            return Err("la sesión aún no tiene PTY".to_string());
        }
        Ok(Self {
            id: id.to_string(),
            pty,
            inicio: Instant::now(),
        })
    }

    fn v2(&self) -> bool {
        super::registro::read(&self.id, |s| s.info.bridge_protocol >= 2).unwrap_or(false)
    }

    fn op(&self, op: super::buzon::InboxOp) -> bool {
        match super::buzon::encolar_op(&self.id, op) {
            Ok(op_id) => {
                super::buzon::esperar_resultado(&op_id, ESPERA_BUZON).is_some_and(|r| r.ok)
            }
            Err(e) => {
                tracing::debug!(sesion = %self.id, error = %e, "buzón no disponible: reserva por PTY");
                false
            }
        }
    }
}

impl Entorno for EntornoSesion {
    fn pantalla(&self) -> Clasificacion {
        super::pantalla::actual(&self.id)
    }
    fn escribir(&self, t: Trabajo) -> Result<(), ErrorEscritura> {
        crate::pty::io::enviar(&self.pty, t)
    }
    fn turno_v2(&self) -> Option<String> {
        super::registro::read(&self.id, |s| {
            (s.info.bridge_protocol >= 2)
                .then(|| s.info.turn_id.clone())
                .flatten()
        })
        .ok()
        .flatten()
    }
    fn abortar_turno(&self, turn_id: &str) -> bool {
        self.op(super::buzon::InboxOp::TurnAbort {
            op_id: String::new(),
            turn_id: turn_id.to_string(),
        })
    }
    fn limpiar_caja_v2(&self) -> Option<bool> {
        self.v2().then(|| {
            self.op(super::buzon::InboxOp::PromptClear {
                op_id: String::new(),
            })
        })
    }
    fn turno_cerrado(&self) -> bool {
        use super::types::SessionStatus;
        super::registro::read(&self.id, |s| {
            s.info.turn_id.is_none()
                && !matches!(
                    s.info.status,
                    SessionStatus::Working | SessionStatus::Waiting
                )
        })
        .unwrap_or(true)
    }
    fn senal(&self, s: Senal) {
        super::senales::emitir(&self.id, s);
    }
    fn recuperar(&self, texto: String) {
        super::cola::recuperar_entrada(&self.id, texto);
    }
    fn dormir(&self, d: Duration) {
        std::thread::sleep(d);
    }
    fn retomado_por_tarea(&self) -> bool {
        tarea_desde(&self.id, self.inicio)
    }
    fn actividad_puente(&self) -> bool {
        turno_desde(&self.id, self.inicio)
    }
    fn cola_nativa(&self) -> bool {
        super::cola::global().resumen(&self.id).en_cola_cli > 0
    }
}

// ---------------------------------------------------------------------------
// Comandos de recuperación de una sesión (los envuelve `comandos_pty`)
// ---------------------------------------------------------------------------

/// Espera a que el proceso viejo salga en un reinicio.
const ESPERA_REINICIO: Duration = Duration::from_secs(3);

/// Interrumpir, salir del menú o reiniciar (§3.3).
pub fn recover(
    app: AppHandle,
    id: &str,
    action: RecoverAction,
    opts: Option<RecoverOptions>,
) -> Result<RecoverOutcome, String> {
    if !registro::exists(id) {
        return Err(format!("no existe la sesión '{id}'"));
    }
    if action == RecoverAction::Restart {
        let modo = opts.and_then(|o| o.permission_mode);
        return reiniciar(app, id, modo);
    }
    if opts.is_some_and(|o| o.permission_mode.is_some()) {
        return Err("permissionMode solo se admite con restart".to_string());
    }
    let r = interrumpir_o_salir(id, action)?;
    tracing::info!(sesion = id, ?action, ok = r.ok, steps = ?r.steps, "recuperación");
    Ok(RecoverOutcome {
        ok: r.ok,
        action,
        steps: r.steps,
        status: registro::read(id, |s| s.info.status)?,
    })
}

/// `interrupt` o `exitMenu` con antirrebote. El entorno se resuelve antes de
/// reservar: un error (sesión aún sin PTY) no puede dejar la reserva tomada,
/// porque las recuperaciones siguientes devolverían «enCurso» sin actuar.
/// Con otra en marcha o en el antirrebote cuenta como hecha
/// (`SiReservada::CuentaComoHecha`): la otra ya informa de su resultado.
fn interrumpir_o_salir(id: &str, action: RecoverAction) -> Result<Resultado, String> {
    let env = EntornoSesion::nuevo(id)?;
    let clave = clave_reserva(id, action);
    Ok(accion_reservada(
        &env,
        &clave,
        SiReservada::CuentaComoHecha,
        |e| match action {
            RecoverAction::Interrupt => interrumpir(e),
            _ => salir_menu(e),
        },
    ))
}

/// `restart` (§3.3): `ReinicioPedido`, kill del árbol (espera ≤ 3 s) y
/// relanzamiento con `--resume <sid>` y el mismo id de ULTRON. Con `modo`,
/// ese pasa a ser el `launchPermissionMode`; sin él, el del último
/// lanzamiento (no el de las prefs).
fn reiniciar(
    app: AppHandle,
    id: &str,
    modo: Option<PermissionMode>,
) -> Result<RecoverOutcome, String> {
    reiniciar_con(id, modo, |cfg, arranque| {
        super::gestor::lanzar_pty(app, id, cfg, arranque)
    })
}

/// Cuerpo de `reiniciar` con el relanzamiento inyectado (los tests no
/// arrancan un PTY). Lleva la reserva de las demás recuperaciones: dos
/// reinicios a la vez mataban cada uno «su» proceso y relanzaban dos
/// `claude --resume` sobre el mismo transcript, con el primero huérfano. El
/// segundo responde `enCurso` (o `antirrebote`) sin actuar. El arranque y la
/// configuración se resuelven antes de reservar, como en
/// `interrumpir_o_salir`.
pub(super) fn reiniciar_con(
    id: &str,
    modo: Option<PermissionMode>,
    relanzar: impl FnOnce(&lanzamiento::Config, &Arranque) -> Result<(), String>,
) -> Result<RecoverOutcome, String> {
    let arranque = arranque_reinicio(id)?;
    let ultima = lanzamiento::guardada(id)
        .ok_or_else(|| "no hay configuración de lanzamiento de la sesión".to_string())?;
    let cfg = lanzamiento::config_reinicio(&ultima, modo);
    let clave = clave_reserva(id, RecoverAction::Restart);
    if let Some(ocupado) = reinicio_ocupado(id, &clave)? {
        return Ok(ocupado);
    }
    let _liberar = Liberar(&clave);
    bloquear(super::gestor::reiniciando()).insert(id.to_string());
    senales::emitir(id, Senal::ReinicioPedido);
    let mut steps = vec!["reinicioPedido".to_string()];
    if matches!(arranque, Arranque::Nueva { .. }) {
        steps.push("sinTranscriptConversacionNueva".to_string());
    }
    // Un error al terminar el proceso viejo tampoco deja la marca de reinicio.
    let r = terminar_proceso(id, &mut steps).and_then(|()| relanzar(&cfg, &arranque));
    bloquear(super::gestor::reiniciando()).remove(id);
    if r.is_err() {
        // El proceso viejo ya no está y el nuevo no arrancó: sin esto la sesión
        // decía `starting` hasta el aviso de 30 s. La restauración hace lo mismo.
        senales::emitir(id, Senal::ProcesoSalio { code: -1 });
    }
    r?;
    steps.push(format!(
        "relanzada en {}",
        lanzamiento::modo_cli(cfg.permission_mode)
    ));
    super::gestor::guardar_lanzamiento(id, cfg);
    Ok(RecoverOutcome {
        ok: true,
        action: RecoverAction::Restart,
        steps,
        status: registro::read(id, |s| s.info.status)?,
    })
}

/// Reserva el reinicio de `clave`. `None` si queda reservado para este;
/// si otro está en curso o acaba de terminar, su resultado sin actuar (la
/// otra llamada ya informa del suyo).
fn reinicio_ocupado(id: &str, clave: &str) -> Result<Option<RecoverOutcome>, String> {
    let paso = match reservar(clave, Instant::now()) {
        Reserva::Libre => return Ok(None),
        Reserva::EnCurso => "enCurso",
        Reserva::Antirrebote => "antirrebote",
    };
    Ok(Some(RecoverOutcome {
        ok: true,
        action: RecoverAction::Restart,
        steps: vec![paso.to_string()],
        status: registro::read(id, |s| s.info.status)?,
    }))
}

/// Arranque del reinicio (#32): `--resume <sid>` solo si la conversación
/// llegó a escribir su transcript. Un arranque que no llegó al prompt no deja
/// `<sid>.jsonl` y `--resume` respondería «No conversation found»: se
/// relanza como sesión nueva con el mismo sid y la misma `Config`.
pub(super) fn arranque_reinicio(id: &str) -> Result<Arranque, String> {
    let (sid, rutas) = registro::read(id, |s| {
        let sid = s.info.claude_session_id.clone();
        let propia = sid
            .as_deref()
            .map(|x| s.slug_dir.join(format!("{x}.jsonl")));
        (sid, [s.transcript.clone(), propia])
    })?;
    let sid =
        sid.ok_or_else(|| "la sesión no tiene id de Claude: no se puede reanudar".to_string())?;
    let hay_transcript = rutas.iter().flatten().any(|p| p.is_file());
    Ok(if hay_transcript {
        Arranque::Reanudar { sid }
    } else {
        Arranque::Nueva { sid }
    })
}

/// Mata el PTY actual de la sesión, espera su salida (≤ 3 s) y lo suelta.
/// Sin máquina de estados, la sesión vuelve a `starting` (también desde
/// exited, que `set_status` no toca).
fn terminar_proceso(id: &str, steps: &mut Vec<String>) -> Result<(), String> {
    let old = registro::pty_id(id)?;
    if !old.is_empty() {
        if let Err(e) = crate::pty::io::kill(&old) {
            steps.push(format!("kill: {e}"));
        }
        steps.push(if esperar_salida(&old) {
            "procesoTerminado".to_string()
        } else {
            "procesoSinSalirEn3s".to_string()
        });
        crate::pty::io::forget(&old);
    }
    if !senales::hay_manejador() {
        registro::update(id, |s| {
            s.info.status = SessionStatus::Starting;
            (true, ())
        })?;
    }
    Ok(())
}

fn esperar_salida(pty: &str) -> bool {
    let inicio = Instant::now();
    while inicio.elapsed() < ESPERA_REINICIO {
        match crate::pty::registry::get(pty) {
            Ok(s) if s.running() => std::thread::sleep(Duration::from_millis(50)),
            _ => return true,
        }
    }
    false
}

/// `sesiones_dialog_answer` (§4.6).
pub fn dialog_answer(id: &str, index: u32) -> Result<(), String> {
    responder_dialogo(&EntornoSesion::nuevo(id)?, index)
}

/// `sesiones_trust_answer` (§4.6).
pub fn trust_answer(id: &str, accept: bool) -> Result<(), String> {
    responder_confianza(&EntornoSesion::nuevo(id)?, accept)
}

/// `sesiones_set_permission_mode` (§2.5): Shift+Tab verificado en pantalla.
pub fn set_permission_mode(id: &str, mode: PermissionMode) -> Result<OpResult, String> {
    let env = EntornoSesion::nuevo(id)?;
    Ok(match cambiar_modo(&env, lanzamiento::modo_cli(mode)) {
        Ok(texto) => OpResult {
            ok: true,
            text: Some(texto),
            ..OpResult::default()
        },
        Err(e) => OpResult {
            ok: false,
            error: Some(e),
            ..OpResult::default()
        },
    })
}

#[cfg(test)]
#[path = "tests_recuperacion.rs"]
mod tests;
