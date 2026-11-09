// sesiones/entrada.rs — Vigilante de la pantalla de cada sesión (contrato de
// estabilidad, §1.3, §1.5 y §8.3 paso 4).
//
// Un hilo por sesión, vivo mientras la sesión esté en el registro (sobrevive
// a los reinicios): cuando el lector ha dejado salida sin clasificar y toca
// según el debounce (`pantalla::debe_clasificar`), clasifica la pantalla
// emulada y emite `Senal::Pantalla` si cambió el estado, el modo o la
// entrada; con `busy`, `Senal::Progreso` cuando cambia la línea del spinner
// (como mucho 1/s); y `Senal::Tick` cada segundo. Con la sesión `exited`
// duerme 1 s por vuelta en vez de 50 ms; un pánico reinicia el bucle con el
// mismo `Vigilante` (`supervisor`, reinicios acotados y aviso visible).
//
// El arranque se decide solo por pantalla y nunca escribe en un diálogo
// (`SC-17`, `estado-cola:M4`, `seguridad-robustez:F8`): no hay `GIVE_UP` ni
// cola propia. Si al aparecer el prompt la caja ya trae texto, va a
// `cola::recuperar_entrada`.
//
// Reserva sin máquina de estados (hasta que WP-ESTADO instale el manejador de
// `senales`): idle con el prompt, waiting con un diálogo o la confianza y
// exited al salir, aplicados aquí directamente sobre `registro`.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::pantalla::{self, Clasificacion};
use super::senales::{self, EstadoPantalla, Senal};
use super::supervisor::{self, Fin};
use super::types::{ev, DialogOption, PermissionMode, SessionStatus};
use super::{cola, registro};
use crate::pty::escritor::{TeclaPty, Trabajo};
use crate::pty::types::bloquear;

const POLL: Duration = Duration::from_millis(50);
const TICK: Duration = Duration::from_secs(1);
const PROGRESO_MIN: Duration = Duration::from_secs(1);

/// Lanza el vigilante de una sesión (uno por sesión, también tras reiniciar).
pub fn spawn_watcher(id: String) {
    let name = format!("sesiones-pantalla-{}", &id[..id.len().min(8)]);
    if let Err(e) = std::thread::Builder::new().name(name).spawn(move || {
        vigilar(&id, supervisor::PAUSA_REINICIO, watch);
    }) {
        tracing::warn!(error = %e, "no se pudo lanzar el vigilante de pantalla");
    }
}

/// Estado del vigilante entre dos clasificaciones.
#[derive(Debug, Default)]
pub struct Vigilante {
    ultima: Option<(EstadoPantalla, Option<String>, Option<String>, bool)>,
    actividad: Option<String>,
    ultimo_progreso: Option<Instant>,
    arrancada: bool,
    opciones: Vec<DialogOption>,
}

/// Lo que hay que hacer tras una clasificación.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Efectos {
    pub senales: Vec<Senal>,
    /// Texto que ya estaba en la caja al aparecer el primer prompt.
    pub entrada_previa: Option<String>,
    /// El menú en pantalla cambió (opciones o cursor): se emite
    /// `sesiones://screen`.
    pub menu_cambiado: bool,
}

impl Vigilante {
    /// Decide las señales de una clasificación nueva (función pura salvo el
    /// reloj recibido).
    pub fn procesar(&mut self, c: &Clasificacion, ahora: Instant) -> Efectos {
        let mut out = Efectos::default();
        let clave = (
            c.estado,
            c.modo.clone(),
            c.entrada.clone(),
            c.pista_segundo_plano,
        );
        if self.ultima.as_ref() != Some(&clave) {
            out.senales.push(Senal::Pantalla {
                estado: c.estado,
                modo: c.modo.clone(),
                entrada: c.entrada.clone(),
                pista: c.pista_segundo_plano,
            });
            self.ultima = Some(clave);
        }
        if c.estado == EstadoPantalla::Prompt && !self.arrancada {
            self.arrancada = true;
            out.entrada_previa.clone_from(&c.entrada);
        }
        if c.estado == EstadoPantalla::Busy && c.actividad != self.actividad {
            let toca = self
                .ultimo_progreso
                .is_none_or(|t| ahora.saturating_duration_since(t) >= PROGRESO_MIN);
            if toca && self.actividad.is_some() {
                out.senales.push(Senal::Progreso);
                self.ultimo_progreso = Some(ahora);
            }
            self.actividad.clone_from(&c.actividad);
        }
        let menu = matches!(c.estado, EstadoPantalla::Dialog | EstadoPantalla::Trust);
        if menu && c.opciones != self.opciones {
            out.menu_cambiado = true;
        }
        self.opciones.clone_from(&c.opciones);
        out
    }
}

/// Vigilante supervisado: `cuerpo` corre bajo `catch_unwind` y se relanza
/// tras un pánico con el mismo `Vigilante` (no vuelve a recuperar la entrada
/// previa ni a reemitir lo ya emitido), con aviso en la sesión.
fn vigilar(id: &str, pausa: Duration, mut cuerpo: impl FnMut(&str, &mut Vigilante)) -> Fin {
    let mut v = Vigilante::default();
    let fin = supervisor::con_reinicio(
        "vigilante de pantalla",
        supervisor::MAX_REINICIOS,
        pausa,
        || cuerpo(id, &mut v),
        |n| {
            tracing::error!(
                sesion = id,
                reinicio = n,
                "pánico en el vigilante de pantalla"
            );
            nota(
                id,
                "warn",
                "El vigilante de pantalla falló y se ha reiniciado",
            );
        },
    );
    if fin == Fin::Agotado {
        nota(
            id,
            "error",
            "El vigilante de pantalla se detuvo tras fallos repetidos: reinicia la sesión",
        );
    }
    fin
}

fn nota(id: &str, level: &str, text: &str) {
    registro::emit(
        ev::NOTICE,
        serde_json::json!({ "id": id, "level": level, "text": text }),
    );
}

/// Pausa entre vueltas: con la sesión terminada no hay salida que clasificar
/// y basta el `Tick` de cada segundo (sigue vivo por si se reinicia).
fn pausa_para(status: Option<SessionStatus>) -> Duration {
    if status == Some(SessionStatus::Exited) {
        TICK
    } else {
        POLL
    }
}

fn watch(id: &str, v: &mut Vigilante) {
    let mut ultimo_tick = Instant::now();
    while registro::exists(id) {
        std::thread::sleep(pausa_para(registro::read(id, |s| s.info.status).ok()));
        let ahora = Instant::now();
        if ahora.saturating_duration_since(ultimo_tick) >= TICK {
            ultimo_tick = ahora;
            senales::emitir(id, Senal::Tick);
        }
        let Some(m) = pantalla::monitor(id) else {
            continue;
        };
        if !m.toca_clasificar(ahora) {
            continue;
        }
        let c = m.clasificar();
        let efectos = v.procesar(&c, ahora);
        if let Some(texto) = efectos.entrada_previa {
            recuperar_previa(id, texto);
        }
        if efectos.menu_cambiado {
            registro::emit(pantalla::EV_SCREEN, serde_json::json!({ "id": id }));
        }
        for s in efectos.senales {
            if !senales::hay_manejador() {
                reserva_pantalla(id, &s);
            }
            senales::emitir(id, s);
        }
    }
    tracing::debug!(sesion = id, "vigilante de pantalla terminado");
}

/// Texto que ya estaba en la caja al primer prompt: va a la cola y se limpia.
/// Sin cola en el backend (máquina sin instalar) se deja en la caja: G3
/// bloquea los envíos con un error explícito en vez de perderlo.
fn recuperar_previa(id: &str, texto: String) {
    if !senales::hay_manejador() {
        tracing::warn!(
            sesion = id,
            "la caja de la TUI arrancó con texto: se deja ahí (sin cola)"
        );
        return;
    }
    cola::recuperar_entrada(id, texto);
    let Ok(pty) = registro::pty_id(id) else {
        return;
    };
    if let Err(e) = crate::pty::io::enviar(&pty, Trabajo::Tecla(TeclaPty::LimpiarLinea)) {
        tracing::warn!(sesion = id, error = %e, "no se pudo limpiar la caja de la TUI");
    }
}

// ---------------------------------------------------------------------------
// Reserva sin máquina de estados
// ---------------------------------------------------------------------------

fn espera_propia() -> &'static Mutex<HashSet<String>> {
    static M: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashSet::new()))
}

fn modo_de(m: &str) -> Option<PermissionMode> {
    serde_json::from_value(serde_json::Value::String(m.to_string())).ok()
}

/// Estado mínimo por pantalla: prompt → idle (si arrancaba o esperaba por un
/// diálogo nuestro), diálogo o confianza → waiting. Nunca pisa un waiting
/// del puente (pregunta, permiso o plan).
pub fn reserva_pantalla(id: &str, s: &Senal) {
    let Senal::Pantalla { estado, modo, .. } = s else {
        return;
    };
    let propia = bloquear(espera_propia()).contains(id);
    let nueva_propia = registro::update(id, |x| {
        let antes = (x.info.status, x.info.screen, x.info.permission_mode);
        x.info.screen = *estado;
        if let Some(m) = modo.as_deref().and_then(modo_de) {
            x.info.permission_mode = Some(m);
        }
        let st = x.info.status;
        let mut propia = propia;
        match estado {
            EstadoPantalla::Prompt
                if st == SessionStatus::Starting || (st == SessionStatus::Waiting && propia) =>
            {
                x.info.status = SessionStatus::Idle;
                propia = false;
            }
            EstadoPantalla::Dialog | EstadoPantalla::Trust
                if matches!(
                    st,
                    SessionStatus::Starting | SessionStatus::Idle | SessionStatus::Working
                ) =>
            {
                x.info.status = SessionStatus::Waiting;
                propia = true;
            }
            _ => {}
        }
        let cambio = antes != (x.info.status, x.info.screen, x.info.permission_mode);
        (cambio, propia)
    });
    if let Ok(p) = nueva_propia {
        let mut set = bloquear(espera_propia());
        if p {
            set.insert(id.to_string());
        } else {
            set.remove(id);
        }
    }
}

/// Salida del proceso sin máquina: exited con su código, salvo durante un
/// reinicio.
pub fn reserva_salida(id: &str, code: i32, reiniciando: bool) {
    if reiniciando {
        return;
    }
    let _ = registro::update(id, |x| {
        x.info.status = SessionStatus::Exited;
        x.info.exit_code = Some(code);
        (true, ())
    });
    bloquear(espera_propia()).remove(id);
}

/// Envío escrito sin máquina: working, sin pisar waiting ni exited (`EST-04`).
pub fn reserva_envio(id: &str) {
    let _ = registro::update(id, |x| {
        let cambia = matches!(x.info.status, SessionStatus::Idle | SessionStatus::Starting);
        if cambia {
            x.info.status = SessionStatus::Working;
        }
        (cambia, ())
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(estado: EstadoPantalla, entrada: Option<&str>, act: Option<&str>) -> Clasificacion {
        Clasificacion {
            estado,
            entrada: entrada.map(str::to_string),
            actividad: act.map(str::to_string),
            ..Clasificacion::default()
        }
    }

    #[test]
    fn solo_emite_pantalla_cuando_cambia() {
        let mut v = Vigilante::default();
        let t = Instant::now();
        let e1 = v.procesar(&c(EstadoPantalla::Prompt, None, None), t);
        assert_eq!(e1.senales.len(), 1);
        let e2 = v.procesar(&c(EstadoPantalla::Prompt, None, None), t);
        assert!(e2.senales.is_empty());
        let e3 = v.procesar(&c(EstadoPantalla::Prompt, Some("hola"), None), t);
        assert_eq!(
            e3.senales,
            vec![Senal::Pantalla {
                estado: EstadoPantalla::Prompt,
                modo: None,
                entrada: Some("hola".into()),
                pista: false,
            }]
        );
    }

    #[test]
    fn la_entrada_previa_solo_se_recupera_en_el_primer_prompt() {
        let mut v = Vigilante::default();
        let t = Instant::now();
        assert_eq!(
            v.procesar(&c(EstadoPantalla::Trust, None, None), t)
                .entrada_previa,
            None
        );
        let e = v.procesar(&c(EstadoPantalla::Prompt, Some("borrador"), None), t);
        assert_eq!(e.entrada_previa.as_deref(), Some("borrador"));
        let e = v.procesar(&c(EstadoPantalla::Prompt, Some("otra"), None), t);
        assert_eq!(e.entrada_previa, None);
    }

    #[test]
    fn progreso_cuando_cambia_el_spinner_como_mucho_una_vez_por_segundo() {
        let mut v = Vigilante::default();
        let t = Instant::now();
        let b = |a: &str| c(EstadoPantalla::Busy, None, Some(a));
        let progreso = |e: &Efectos| e.senales.contains(&Senal::Progreso);
        assert!(!progreso(&v.procesar(&b("· Redactando…"), t)));
        assert!(progreso(&v.procesar(&b("✢ Redactando…"), t)));
        assert!(!progreso(
            &v.procesar(&b("✳ Redactando…"), t + Duration::from_millis(300))
        ));
        assert!(progreso(
            &v.procesar(&b("✶ Redactando…"), t + Duration::from_millis(1100))
        ));
        // Caso negativo: la misma línea no es progreso.
        assert!(!progreso(
            &v.procesar(&b("✶ Redactando…"), t + Duration::from_secs(5))
        ));
    }

    #[test]
    fn el_menu_cambiado_se_avisa_solo_si_cambian_opciones_o_cursor() {
        let mut v = Vigilante::default();
        let t = Instant::now();
        let menu = |sel: bool| Clasificacion {
            estado: EstadoPantalla::Dialog,
            opciones: vec![DialogOption {
                index: 0,
                label: "Auto-compact".into(),
                selected: sel,
            }],
            ..Clasificacion::default()
        };
        assert!(v.procesar(&menu(true), t).menu_cambiado);
        assert!(!v.procesar(&menu(true), t).menu_cambiado);
        assert!(v.procesar(&menu(false), t).menu_cambiado);
        // Caso negativo: fuera de un menú no se avisa.
        assert!(
            !v.procesar(&c(EstadoPantalla::Prompt, None, None), t)
                .menu_cambiado
        );
    }

    /// `SC-17`, `estado-cola:M4`: con la confianza en pantalla durante más
    /// del antiguo `GIVE_UP`, el vigilante no produce ninguna escritura
    /// (solo señales) y la reserva deja la sesión en waiting.
    #[test]
    fn confianza_permanente_no_escribe_y_queda_en_waiting() {
        let id = format!("entrada-{}", uuid::Uuid::new_v4());
        registro::insert(registro::sesion_de_prueba(&id)).expect("alta");
        let mut v = Vigilante::default();
        let t = Instant::now();
        for s in [0u64, 60, 121, 600] {
            let e = v.procesar(
                &c(EstadoPantalla::Trust, None, None),
                t + Duration::from_secs(s),
            );
            assert_eq!(e.entrada_previa, None);
            for x in &e.senales {
                reserva_pantalla(&id, x);
            }
        }
        let st = registro::read(&id, |x| x.info.status).expect("sesión");
        assert_eq!(st, SessionStatus::Waiting);
        // Al aparecer el prompt (confianza aceptada), idle.
        for x in v
            .procesar(&c(EstadoPantalla::Prompt, None, None), t)
            .senales
        {
            reserva_pantalla(&id, &x);
        }
        let st = registro::read(&id, |x| x.info.status).expect("sesión");
        assert_eq!(st, SessionStatus::Idle);
        registro::remove(&id);
    }

    #[test]
    fn la_reserva_no_pisa_un_waiting_del_puente_ni_el_envio_un_waiting() {
        let id = format!("entrada-{}", uuid::Uuid::new_v4());
        let mut s = registro::sesion_de_prueba(&id);
        s.info.status = SessionStatus::Waiting;
        registro::insert(s).expect("alta");
        let prompt = Senal::Pantalla {
            estado: EstadoPantalla::Prompt,
            modo: Some("bypassPermissions".into()),
            entrada: None,
            pista: false,
        };
        reserva_pantalla(&id, &prompt);
        reserva_envio(&id);
        let (st, modo) =
            registro::read(&id, |x| (x.info.status, x.info.permission_mode)).expect("sesión");
        assert_eq!(st, SessionStatus::Waiting);
        assert_eq!(modo, Some(PermissionMode::BypassPermissions));
        reserva_salida(&id, 3, true);
        assert_eq!(
            registro::read(&id, |x| x.info.status).expect("sesión"),
            SessionStatus::Waiting,
            "un reinicio no pasa a exited"
        );
        reserva_salida(&id, 3, false);
        let (st, code) =
            registro::read(&id, |x| (x.info.status, x.info.exit_code)).expect("sesión");
        assert_eq!((st, code), (SessionStatus::Exited, Some(3)));
        registro::remove(&id);
    }
}

#[cfg(test)]
mod tests_supervision {
    use super::*;

    /// Pánico en el vigilante → reinicio con el mismo estado (la entrada
    /// previa no se recupera dos veces) y aviso; sin supervisión el hilo
    /// moría con la primera.
    #[test]
    fn un_panico_en_el_vigilante_lo_reinicia_con_el_mismo_estado() {
        let id = format!("vigilante-{}", uuid::Uuid::new_v4());
        let mut vueltas = 0;
        let fin = vigilar(&id, Duration::ZERO, |_, v| {
            vueltas += 1;
            if vueltas == 1 {
                v.arrancada = true;
            }
            assert!(vueltas >= 3, "pánico de prueba {vueltas}");
            assert!(v.arrancada, "el estado sobrevive al reinicio");
        });
        assert_eq!(fin, Fin::Normal { reinicios: 2 });
        assert_eq!(vueltas, 3);
    }

    #[test]
    fn el_vigilante_se_rinde_tras_los_reinicios_acotados() {
        let id = format!("vigilante-{}", uuid::Uuid::new_v4());
        let mut vueltas = 0u32;
        let fin = vigilar(&id, Duration::ZERO, |_, _| {
            vueltas += 1;
            panic!("pánico de prueba");
        });
        assert_eq!(fin, Fin::Agotado);
        assert_eq!(vueltas, supervisor::MAX_REINICIOS + 1);
    }

    /// Hallazgo nocturno 4: 20 Hz solo con la sesión viva.
    #[test]
    fn con_la_sesion_terminada_duerme_un_segundo() {
        assert_eq!(pausa_para(Some(SessionStatus::Exited)), TICK);
        assert_eq!(pausa_para(Some(SessionStatus::Working)), POLL);
        assert_eq!(pausa_para(Some(SessionStatus::Idle)), POLL);
        assert_eq!(pausa_para(None), POLL);
    }
}
