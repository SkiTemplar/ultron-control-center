// sesiones/tests_recuperacion.rs — Interrumpir, salir del menú, diálogos y
// modo de permisos contra una TUI falsa con reloj virtual (§3.3, §4.6, §2.5).
// Reservas, antirrebote, `olvidar` y «Reiniciar sesión» viven en
// tests_recuperacion_reservas.rs, que reutiliza esta TUI falsa.

use std::cell::{Cell, RefCell};
use std::time::{Duration, Instant};

use super::*;
use crate::pty::escritor::{Guardas, Vista};
use crate::sesiones::types::DialogOption;

type Reaccion = Box<dyn Fn(&Falso, &Trabajo)>;

/// TUI falsa: aplica G1-G2 como el escritor real y reacciona a las teclas.
struct Falso {
    pantalla: RefCell<Clasificacion>,
    eventos: RefCell<Vec<String>>,
    reloj: Cell<Duration>,
    t0: Instant,
    guardas: RefCell<Guardas>,
    v2: RefCell<Option<String>>,
    cerrado: Cell<bool>,
    reaccion: Reaccion,
    recuperado: RefCell<Vec<String>>,
    tarea: Cell<bool>,
    /// `turn.abort` que el mod responde ok sin que el turno cierre (Bash
    /// bloqueando, 2026-10-15).
    abort_ignora: RefCell<Vec<String>>,
    /// El puente abrió o cerró algún turno durante la recuperación.
    actividad: Cell<bool>,
    /// La `<task-notification>` se anota durante la siguiente espera.
    tarea_al_dormir: Cell<bool>,
    /// Turno que abre la CLI durante la siguiente espera (relevo).
    relevo: RefCell<Option<String>>,
    /// Mensajes en la cola nativa de la CLI (`cliQueued`).
    cola_nativa: Cell<bool>,
}

impl Falso {
    fn nuevo(c: Clasificacion, reaccion: Reaccion) -> Self {
        Self {
            pantalla: RefCell::new(c),
            eventos: RefCell::default(),
            reloj: Cell::new(Duration::ZERO),
            t0: Instant::now(),
            guardas: RefCell::default(),
            v2: RefCell::default(),
            cerrado: Cell::new(false),
            reaccion,
            recuperado: RefCell::default(),
            tarea: Cell::new(false),
            abort_ignora: RefCell::default(),
            actividad: Cell::new(false),
            tarea_al_dormir: Cell::new(false),
            relevo: RefCell::default(),
            cola_nativa: Cell::new(false),
        }
    }
    fn ignora_abort(self, turnos: &[&str]) -> Self {
        *self.abort_ignora.borrow_mut() = turnos.iter().map(|t| (*t).to_string()).collect();
        self
    }
    fn con_turno(self, t: &str) -> Self {
        *self.v2.borrow_mut() = Some(t.to_string());
        self
    }
    fn ev(&self, s: impl Into<String>) {
        self.eventos.borrow_mut().push(s.into());
    }
    fn eventos(&self) -> Vec<String> {
        self.eventos.borrow().clone()
    }
    fn escrituras(&self) -> Vec<String> {
        self.eventos()
            .into_iter()
            .filter_map(|e| e.strip_prefix("w:").map(str::to_string))
            .collect()
    }
    fn fijar(&self, estado: EstadoPantalla) {
        self.pantalla.borrow_mut().estado = estado;
    }
}

fn tecla(t: &Trabajo) -> String {
    match t {
        Trabajo::Tecla(k) | Trabajo::TeclaDialogo(k) => format!("{k:?}"),
        Trabajo::Pegado { .. } => "pegado".into(),
        Trabajo::Exento(_) => "exento".into(),
    }
}

impl Entorno for Falso {
    fn pantalla(&self) -> Clasificacion {
        self.pantalla.borrow().clone()
    }
    fn escribir(&self, t: Trabajo) -> Result<(), ErrorEscritura> {
        let vista = Vista {
            pantalla: self.pantalla.borrow().estado,
            entrada: self.pantalla.borrow().entrada.clone(),
        };
        let ahora = self.t0 + self.reloj.get();
        self.guardas
            .borrow_mut()
            .admitir(&t, &vista, false, ahora)?;
        self.ev(format!("w:{}", tecla(&t)));
        (self.reaccion)(self, &t);
        Ok(())
    }
    fn turno_v2(&self) -> Option<String> {
        self.v2.borrow().clone()
    }
    fn abortar_turno(&self, turn_id: &str) -> bool {
        self.ev(format!("abort:{turn_id}"));
        if self.abort_ignora.borrow().iter().any(|t| t == turn_id) {
            return true;
        }
        self.cerrado.set(true);
        *self.v2.borrow_mut() = None;
        self.fijar(EstadoPantalla::Prompt);
        true
    }
    fn limpiar_caja_v2(&self) -> Option<bool> {
        None
    }
    fn turno_cerrado(&self) -> bool {
        self.cerrado.get()
    }
    fn senal(&self, s: Senal) {
        self.ev(format!("senal:{s:?}"));
    }
    fn recuperar(&self, texto: String) {
        self.recuperado.borrow_mut().push(texto);
    }
    fn dormir(&self, d: Duration) {
        self.reloj.set(self.reloj.get() + d);
        if self.tarea_al_dormir.get() {
            self.tarea.set(true);
        }
        if let Some(t) = self.relevo.borrow_mut().take() {
            *self.v2.borrow_mut() = Some(t);
        }
    }
    fn retomado_por_tarea(&self) -> bool {
        self.tarea.get()
    }
    fn actividad_puente(&self) -> bool {
        self.actividad.get()
    }
    fn cola_nativa(&self) -> bool {
        self.cola_nativa.get()
    }
}

fn clas(estado: EstadoPantalla) -> Clasificacion {
    Clasificacion {
        estado,
        ..Clasificacion::default()
    }
}

fn nada() -> Reaccion {
    Box::new(|_, _| {})
}

#[test]
fn interrumpir_una_tui_colgada_manda_un_esc_y_un_ctrl_c_y_nada_mas() {
    let f = Falso::nuevo(clas(EstadoPantalla::Busy), nada());
    let r = interrumpir(&f);
    assert!(!r.ok);
    assert_eq!(f.escrituras(), vec!["Esc", "CtrlC"]);
    assert_eq!(f.eventos()[0], "senal:InterrupcionPedida");
    assert!(f.eventos().contains(
        &"senal:RecuperacionTerminada { ok: false, motivo: Some(SinRespuesta) }".to_string()
    ));
}

#[test]
fn con_puente_v2_el_turn_abort_va_antes_y_sin_esc() {
    let f = Falso::nuevo(clas(EstadoPantalla::Busy), nada()).con_turno("t1");
    let r = interrumpir(&f);
    assert!(r.ok, "{r:?}");
    assert_eq!(
        f.eventos(),
        vec![
            "senal:InterrupcionPedida",
            "abort:t1",
            "senal:RecuperacionTerminada { ok: true, motivo: None }"
        ]
    );
    assert!(f.escrituras().is_empty());
}

#[test]
fn un_esc_que_devuelve_el_prompt_no_manda_ctrl_c() {
    let f = Falso::nuevo(
        clas(EstadoPantalla::Busy),
        Box::new(|f, t| {
            if matches!(t, Trabajo::Tecla(TeclaPty::Esc)) {
                f.fijar(EstadoPantalla::Prompt);
            }
        }),
    );
    let r = interrumpir(&f);
    assert!(r.ok);
    assert_eq!(f.escrituras(), vec!["Esc"]);
}

/// `chat-orden:F18`: tras interrumpir, la cola nativa vuelve a la caja; se
/// devuelve a la cola de ULTRON y la caja se limpia (Ctrl+U).
#[test]
fn la_entrada_devuelta_tras_interrumpir_se_recupera_y_se_limpia() {
    let f = Falso::nuevo(
        clas(EstadoPantalla::Busy),
        Box::new(|f, t| match t {
            Trabajo::Tecla(TeclaPty::Esc) => {
                let mut p = f.pantalla.borrow_mut();
                p.estado = EstadoPantalla::Prompt;
                p.entrada = Some("segundo mensaje".into());
            }
            Trabajo::Tecla(TeclaPty::LimpiarLinea) => f.pantalla.borrow_mut().entrada = None,
            _ => {}
        }),
    );
    let r = interrumpir(&f);
    assert!(r.ok);
    assert_eq!(f.escrituras(), vec!["Esc", "LimpiarLinea"]);
    assert_eq!(f.recuperado.borrow().clone(), vec!["segundo mensaje"]);
    assert!(r.steps.contains(&"entradaRecuperada".to_string()));
    assert!(!r.steps.contains(&"entradaSinLimpiar".to_string()));
}

/// `/config`: el primer Esc solo limpia la búsqueda; el segundo, fuera de la
/// ventana de G1, cierra el menú.
#[test]
fn salir_del_menu_con_dos_esc_respetando_g1() {
    let f = Falso::nuevo(
        clas(EstadoPantalla::Dialog),
        Box::new(|f, t| {
            if matches!(t, Trabajo::Tecla(TeclaPty::Esc))
                && f.escrituras().iter().filter(|e| *e == "Esc").count() == 2
            {
                f.fijar(EstadoPantalla::Prompt);
            }
        }),
    );
    let r = salir_menu(&f);
    assert!(r.ok, "{r:?}");
    assert_eq!(
        r.steps,
        vec!["esc", "esc"],
        "el segundo Esc no debe chocar con G1"
    );
}

#[test]
fn un_menu_que_no_se_cierra_devuelve_error_tras_dos_esc() {
    let f = Falso::nuevo(clas(EstadoPantalla::Dialog), nada());
    let r = salir_menu(&f);
    assert!(!r.ok);
    assert_eq!(f.escrituras(), vec!["Esc", "Esc"]);
    let sin_menu = Falso::nuevo(clas(EstadoPantalla::Prompt), nada());
    assert_eq!(salir_menu(&sin_menu).steps, vec!["sinMenu"]);
    assert!(sin_menu.escrituras().is_empty());
}

fn confianza(sel: usize) -> Clasificacion {
    Clasificacion {
        estado: EstadoPantalla::Trust,
        opciones: ["No, exit", "Yes, I trust this folder"]
            .iter()
            .enumerate()
            .map(|(i, l)| DialogOption {
                index: u32::try_from(i).unwrap_or(0),
                label: (*l).to_string(),
                selected: i == sel,
            })
            .collect(),
        ..Clasificacion::default()
    }
}

fn mueve_cursor() -> Reaccion {
    Box::new(|f, t| {
        let delta: i32 = match t {
            Trabajo::TeclaDialogo(TeclaPty::Abajo) => 1,
            Trabajo::TeclaDialogo(TeclaPty::Arriba) => -1,
            _ => return,
        };
        let mut p = f.pantalla.borrow_mut();
        let n = i32::try_from(p.opciones.len()).unwrap_or(0);
        let sel = p.opciones.iter().position(|o| o.selected).unwrap_or(0);
        let nueva = (i32::try_from(sel).unwrap_or(0) + delta).clamp(0, n - 1);
        for (i, o) in p.opciones.iter_mut().enumerate() {
            o.selected = i32::try_from(i).ok() == Some(nueva);
        }
    })
}

#[test]
fn aceptar_la_confianza_baja_verifica_y_confirma() {
    let f = Falso::nuevo(confianza(0), mueve_cursor());
    responder_confianza(&f, true).expect("confianza");
    assert_eq!(f.escrituras(), vec!["Abajo", "Enter"]);
    let g = Falso::nuevo(confianza(0), mueve_cursor());
    responder_confianza(&g, false).expect("salir");
    assert_eq!(g.escrituras(), vec!["Enter"]);
}

/// Caso negativo: si el cursor no se mueve, no se confirma nada.
#[test]
fn sin_verificar_el_cursor_no_se_manda_enter() {
    let f = Falso::nuevo(confianza(0), nada());
    assert!(responder_dialogo(&f, 1).is_err());
    assert_eq!(f.escrituras(), vec!["Abajo"]);
    let sin_dialogo = Falso::nuevo(clas(EstadoPantalla::Prompt), nada());
    assert!(responder_dialogo(&sin_dialogo, 0).is_err());
    assert!(sin_dialogo.escrituras().is_empty());
}

fn ciclo_de_modos() -> Reaccion {
    const CICLO: [&str; 5] = [
        "bypassPermissions",
        "auto",
        "default",
        "acceptEdits",
        "plan",
    ];
    Box::new(|f, t| {
        if matches!(t, Trabajo::Tecla(TeclaPty::ShiftTab)) {
            let mut p = f.pantalla.borrow_mut();
            let i = CICLO
                .iter()
                .position(|m| Some(*m) == p.modo.as_deref())
                .unwrap_or(0);
            p.modo = Some(CICLO[(i + 1) % CICLO.len()].to_string());
        }
    })
}

#[test]
fn cambiar_el_modo_recorre_el_ciclo_hasta_el_pedido() {
    let mut c = clas(EstadoPantalla::Prompt);
    c.modo = Some("bypassPermissions".into());
    let f = Falso::nuevo(c.clone(), ciclo_de_modos());
    cambiar_modo(&f, "plan").expect("plan");
    assert_eq!(f.escrituras().len(), 4);
    let g = Falso::nuevo(c.clone(), ciclo_de_modos());
    assert!(cambiar_modo(&g, "dontAsk").is_err(), "fuera del ciclo");
    assert_eq!(g.escrituras().len(), 5);
    let mut menu = c;
    menu.estado = EstadoPantalla::Dialog;
    let h = Falso::nuevo(menu, ciclo_de_modos());
    assert!(cambiar_modo(&h, "plan").is_err());
    assert!(h.escrituras().is_empty());
}

/// Con tareas en segundo plano, cada interrupción saca de la cola nativa una
/// `<task-notification>` y la CLI abre otro turno: el resultado dice por qué
/// sigue trabajando en vez de un `sigueTrabajando` sin más, y no es «la CLI
/// no responde».
#[test]
fn interrumpir_con_una_tarea_que_retoma_el_turno_lo_explica() {
    let f = Falso::nuevo(
        clas(EstadoPantalla::Busy),
        Box::new(|f, _| f.tarea.set(true)),
    );
    let r = interrumpir(&f);
    assert!(!r.ok);
    assert_eq!(
        r.steps,
        vec!["esc", "ctrlC", "sigueTrabajando", "retomaPorTarea"]
    );
    assert!(f.eventos().contains(
        &"senal:RecuperacionTerminada { ok: false, motivo: Some(TurnoNuevo) }".to_string()
    ));
}

fn relevo_tras_esc() -> Reaccion {
    Box::new(|f, t| {
        if matches!(t, Trabajo::Tecla(TeclaPty::Esc)) {
            *f.v2.borrow_mut() = Some("t2".into());
        }
    })
}

fn tiene(r: &Resultado, paso: &str) -> bool {
    r.steps.iter().any(|s| s == paso)
}

/// 2026-10-15 22:32:19: el turno pedido cerró y la CLI abrió otro con el
/// aviso de una tarea. Se aborta ese turno por el puente, sin Ctrl+C.
#[test]
fn un_turno_nuevo_tras_el_esc_se_aborta_por_el_puente_sin_ctrl_c() {
    let f = Falso::nuevo(clas(EstadoPantalla::Busy), relevo_tras_esc())
        .con_turno("t1")
        .ignora_abort(&["t1"]);
    let r = interrumpir(&f);
    assert!(r.ok, "{r:?}");
    assert_eq!(
        r.steps,
        vec!["turn.abort", "esc", "turnoNuevo", "turn.abort"]
    );
    assert_eq!(f.escrituras(), vec!["Esc"], "nunca Ctrl+C");
    assert!(f.eventos().contains(&"abort:t2".to_string()));
}

#[test]
fn un_turno_nuevo_con_la_tarea_anotada_tarde_lo_explica() {
    let f = Falso::nuevo(
        clas(EstadoPantalla::Busy),
        Box::new(|f, t| {
            if matches!(t, Trabajo::Tecla(TeclaPty::Esc)) {
                *f.v2.borrow_mut() = Some("t2".into());
                f.tarea_al_dormir.set(true);
            }
        }),
    )
    .con_turno("t1")
    .ignora_abort(&["t1"]);
    let r = interrumpir(&f);
    assert!(r.ok, "{r:?}");
    assert!(
        tiene(&r, "turnoNuevo") && tiene(&r, "retomaPorTarea"),
        "{r:?}"
    );
    assert!(!tiene(&r, "ctrlC"));
}

/// El relevo llega durante la espera del `turn.abort` (como en el log): ni
/// siquiera hace falta una tecla.
#[test]
fn un_relevo_durante_la_espera_del_abort_no_escribe_teclas() {
    let f = Falso::nuevo(clas(EstadoPantalla::Busy), nada())
        .con_turno("t1")
        .ignora_abort(&["t1"]);
    *f.relevo.borrow_mut() = Some("t2".into());
    let r = interrumpir(&f);
    assert!(r.ok, "{r:?}");
    assert_eq!(r.steps, vec!["turn.abort", "turnoNuevo", "turn.abort"]);
    assert!(f.escrituras().is_empty());
}

/// Si el turno nuevo tampoco cierra: un solo reintento, sin teclas, y el
/// motivo es «turno nuevo» (aviso ámbar), no «la CLI no responde».
#[test]
fn un_turno_nuevo_que_no_cierra_falla_sin_teclas_y_con_su_motivo() {
    let f = Falso::nuevo(clas(EstadoPantalla::Busy), nada())
        .con_turno("t1")
        .ignora_abort(&["t1", "t2"]);
    *f.relevo.borrow_mut() = Some("t2".into());
    let r = interrumpir(&f);
    assert!(!r.ok);
    assert_eq!(
        r.steps,
        vec!["turn.abort", "turnoNuevo", "turn.abort", "sigueTrabajando"]
    );
    assert!(f.escrituras().is_empty());
    assert!(f.eventos().contains(
        &"senal:RecuperacionTerminada { ok: false, motivo: Some(TurnoNuevo) }".to_string()
    ));
}

/// Caso negativo: el mismo turno sigue abierto y ocupado; no hay relevo que
/// inventar y sí se escala hasta Ctrl+C.
#[test]
fn el_mismo_turno_ocupado_no_es_un_turno_nuevo() {
    let f = Falso::nuevo(clas(EstadoPantalla::Busy), nada())
        .con_turno("t1")
        .ignora_abort(&["t1"]);
    let r = interrumpir(&f);
    assert!(!r.ok);
    assert!(
        tiene(&r, "sigueTrabajando") && !tiene(&r, "turnoNuevo"),
        "{r:?}"
    );
    assert_eq!(f.escrituras(), vec!["Esc", "CtrlC"]);
}

/// Con actividad del puente durante la recuperación, la CLI respondió: el
/// fallo no lleva motivo y la máquina no avisa en rojo.
#[test]
fn con_actividad_del_puente_el_fallo_no_es_sin_respuesta() {
    let f = Falso::nuevo(clas(EstadoPantalla::Busy), nada());
    f.actividad.set(true);
    let r = interrumpir(&f);
    assert!(!r.ok);
    assert!(f
        .eventos()
        .contains(&"senal:RecuperacionTerminada { ok: false, motivo: None }".to_string()));
}

/// 22:32:15: el Esc no interrumpió, sacó a la caja el mensaje que esperaba
/// en la cola nativa (popAll) y Bash seguía. Se devuelve a la cola, se
/// limpia la caja y otro Esc; nunca Ctrl+C con texto en la caja.
#[test]
fn un_esc_que_saca_la_cola_nativa_devuelve_el_texto_y_repite_esc() {
    let f = Falso::nuevo(
        clas(EstadoPantalla::Busy),
        Box::new(|f, t| match t {
            Trabajo::Tecla(TeclaPty::Esc) if f.recuperado.borrow().is_empty() => {
                f.pantalla.borrow_mut().entrada = Some("Estas ahí?".into());
            }
            Trabajo::Tecla(TeclaPty::Esc) => f.fijar(EstadoPantalla::Prompt),
            Trabajo::Tecla(TeclaPty::LimpiarLinea) => f.pantalla.borrow_mut().entrada = None,
            _ => {}
        }),
    );
    let r = interrumpir(&f);
    assert!(r.ok, "{r:?}");
    assert_eq!(r.steps, vec!["esc", "colaDevuelta", "esc2"]);
    assert_eq!(f.escrituras(), vec!["Esc", "LimpiarLinea", "Esc"]);
    assert_eq!(f.recuperado.borrow().clone(), vec!["Estas ahí?"]);
}

/// Sesión ef9979bb (2026-10-21): con un mensaje en la cola nativa,
/// `turn.abort` cerraba el turno sin marca de interrupción y la CLI sacaba
/// ese mensaje en el acto, así que Claude seguía. Con cola nativa, Esc: la
/// CLI la devuelve a la caja, vuelve a la cola de ULTRON y otro Esc para.
#[test]
fn con_cola_nativa_no_se_usa_turn_abort_y_el_esc_la_devuelve() {
    let f = Falso::nuevo(
        clas(EstadoPantalla::Busy),
        Box::new(|f, t| match t {
            Trabajo::Tecla(TeclaPty::Esc) if f.recuperado.borrow().is_empty() => {
                f.pantalla.borrow_mut().entrada = Some("Pero porque tarda tanto??????".into());
            }
            Trabajo::Tecla(TeclaPty::Esc) => f.fijar(EstadoPantalla::Prompt),
            Trabajo::Tecla(TeclaPty::LimpiarLinea) => f.pantalla.borrow_mut().entrada = None,
            _ => {}
        }),
    )
    .con_turno("t1");
    f.cola_nativa.set(true);
    let r = interrumpir(&f);
    assert!(r.ok, "{r:?}");
    assert!(
        !f.eventos().iter().any(|e| e.starts_with("abort:")),
        "sin turn.abort: {:?}",
        f.eventos()
    );
    assert_eq!(
        r.steps,
        vec!["colaNativaSinTurnAbort", "esc", "colaDevuelta", "esc2"]
    );
    assert_eq!(
        f.recuperado.borrow().clone(),
        vec!["Pero porque tarda tanto??????"]
    );
}

/// Caso negativo: sin cola nativa se sigue usando `turn.abort`.
#[test]
fn sin_cola_nativa_el_turn_abort_sigue_primero() {
    let f = Falso::nuevo(clas(EstadoPantalla::Busy), nada()).con_turno("t1");
    let r = interrumpir(&f);
    assert!(r.ok, "{r:?}");
    assert_eq!(r.steps, vec!["turn.abort"]);
}

/// Caso negativo de la guarda: si la caja no se limpia, Ctrl+C no sale (la
/// borraría) aunque la pantalla siga ocupada.
#[test]
fn con_texto_en_la_caja_no_se_manda_ctrl_c() {
    let f = Falso::nuevo(
        clas(EstadoPantalla::Busy),
        Box::new(|f, t| {
            if matches!(t, Trabajo::Tecla(TeclaPty::Esc)) {
                f.pantalla.borrow_mut().entrada = Some("pendiente".into());
            }
        }),
    );
    let r = interrumpir(&f);
    assert!(!r.ok);
    assert!(tiene(&r, "ctrlCOmitido"), "{r:?}");
    assert!(!f.escrituras().contains(&"CtrlC".to_string()));
}

#[test]
fn interrumpir_sin_notificacion_de_subagente_no_la_inventa() {
    let f = Falso::nuevo(clas(EstadoPantalla::Busy), nada());
    let r = interrumpir(&f);
    assert_eq!(
        r.steps,
        vec!["esc", "ctrlC", "sigueTrabajando", "sinRespuesta"],
        "sin tarea ni actividad del puente: la CLI no responde"
    );
}

#[test]
fn anotar_tarea_solo_cuenta_desde_el_inicio_de_la_recuperacion() {
    let id = format!("tarea-{}", uuid::Uuid::new_v4());
    let antes = Instant::now();
    anotar_tarea(&id);
    assert!(tarea_desde(&id, antes));
    assert!(!tarea_desde(&id, Instant::now() + Duration::from_millis(5)));
    assert!(!tarea_desde("otra-sesion-sin-tareas", antes));
}

#[path = "tests_recuperacion_reservas.rs"]
mod reservas;
