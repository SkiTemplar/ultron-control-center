// sesiones/tests_segundo_plano.rs — «Segundo plano» (§3.4) contra un entorno
// falso: qué herramienta se elige, cuándo no se escribe nada y cómo se
// verifica el cierre.

use std::cell::{Cell, RefCell};
use std::time::Duration;

use super::*;
use crate::sesiones::maquina::{EstadoSesion, HerramientaAbierta};
use crate::sesiones::senales::EstadoPantalla;

struct Falso {
    abiertas: RefCell<Vec<(String, String, Ms)>>,
    pantalla: Clasificacion,
    escritos: RefCell<Vec<Trabajo>>,
    /// Esperas a partir de las que el puente cierra la herramienta; `None`,
    /// nunca.
    cierra_tras: Option<usize>,
    /// Esperas a partir de las que la TUI pinta la pista de Ctrl+B; `None`,
    /// la de `pantalla` tal cual.
    pista_tras: Option<usize>,
    esperas: Cell<usize>,
    rechazo: Option<ErrorEscritura>,
}

impl Falso {
    fn nuevo(abiertas: &[(&str, &str, Ms)]) -> Self {
        Self {
            abiertas: RefCell::new(
                abiertas
                    .iter()
                    .map(|(i, n, d)| ((*i).to_string(), (*n).to_string(), *d))
                    .collect(),
            ),
            pantalla: Clasificacion {
                estado: EstadoPantalla::Busy,
                pista_segundo_plano: true,
                ..Clasificacion::default()
            },
            escritos: RefCell::new(Vec::new()),
            cierra_tras: Some(2),
            pista_tras: None,
            esperas: Cell::new(0),
            rechazo: None,
        }
    }
}

impl EntornoSp for Falso {
    fn herramientas(&self) -> Vec<(String, String, Ms)> {
        self.abiertas.borrow().clone()
    }
    fn pantalla(&self) -> Clasificacion {
        let mut c = self.pantalla.clone();
        if let Some(k) = self.pista_tras {
            c.pista_segundo_plano = self.esperas.get() >= k;
        }
        c
    }
    fn escribir(&self, t: Trabajo) -> Result<(), ErrorEscritura> {
        if let Some(e) = &self.rechazo {
            return Err(e.clone());
        }
        self.escritos.borrow_mut().push(t);
        Ok(())
    }
    fn dormir(&self, _d: Duration) {
        let n = self.esperas.get() + 1;
        self.esperas.set(n);
        if self.cierra_tras.is_some_and(|k| n >= k) {
            // `HerramientaFin` de la más reciente movible (la que se movió).
            let mut v = self.abiertas.borrow_mut();
            if let Some(i) = v
                .iter()
                .enumerate()
                .filter(|(_, h)| movible(&h.1))
                .max_by_key(|(_, h)| h.2)
                .map(|(i, _)| i)
            {
                v.remove(i);
            }
        }
    }
}

#[test]
fn sin_herramienta_es_err_y_no_escribe_nada() {
    let f = Falso::nuevo(&[]);
    let r = pasar_a_segundo_plano(&f);
    assert_eq!(
        r,
        Err("No hay ninguna herramienta en primer plano".to_string())
    );
    assert!(f.escritos.borrow().is_empty());
}

#[test]
fn una_herramienta_que_no_se_mueve_es_err_y_no_escribe_nada() {
    let f = Falso::nuevo(&[("t1", "Grep", 10), ("t2", "Read", 20)]);
    let r = pasar_a_segundo_plano(&f);
    assert_eq!(r, Err("Read no se puede pasar a segundo plano".to_string()));
    assert!(f.escritos.borrow().is_empty());
}

#[test]
fn en_paralelo_mueve_la_movible_aunque_haya_otra_mas_reciente() {
    let f = Falso::nuevo(&[("t0", "Agent", 5), ("t1", "Bash", 10), ("t2", "Read", 20)]);
    let r = pasar_a_segundo_plano(&f).expect("resultado");
    assert!(r.ok);
    assert_eq!((r.tool_use_id.as_str(), r.tool.as_str()), ("t1", "Bash"));
    assert_eq!(f.escritos.borrow().len(), 1, "un solo Ctrl+B");
}

#[test]
fn bash_con_cierre_del_puente_es_ok_con_evidencia() {
    let f = Falso::nuevo(&[("t1", "Bash", 10)]);
    let r = pasar_a_segundo_plano(&f).expect("resultado");
    assert!(r.ok);
    assert_eq!(r.evidence, BackgroundEvidence::ToolEnd);
    assert_eq!(r.tool_use_id, "t1");
    assert_eq!(r.tool, "Bash");
    assert_eq!(r.reason, None);
    assert_eq!(r.steps, vec!["pista", "ctrlB", "toolEnd"]);
    assert_eq!(
        *f.escritos.borrow(),
        vec![Trabajo::Tecla(TeclaPty::SegundoPlano)],
        "un solo Ctrl+B"
    );
}

#[test]
fn sin_cierre_en_tres_segundos_es_ok_false_con_motivo() {
    let mut f = Falso::nuevo(&[("t1", "mcp__github__search", 10)]);
    f.cierra_tras = None;
    let r = pasar_a_segundo_plano(&f).expect("resultado");
    assert!(!r.ok);
    assert_eq!(r.evidence, BackgroundEvidence::None);
    assert_eq!(r.steps, vec!["pista", "ctrlB", "sinCierre"]);
    assert_eq!(r.reason.as_deref(), Some(SIN_CONFIRMAR));
    let esperas = u32::try_from(f.esperas.get()).expect("esperas");
    assert_eq!(
        PASO * esperas,
        ESPERA_CIERRE,
        "espera el plazo entero y no más"
    );
}

/// Incidente del 2026-10-21 (2.1.306): un Bash en curso sin la pista; los
/// cuatro Ctrl+B mandados a ciegas no hicieron nada. Sin pista no se escribe.
#[test]
fn sin_pista_no_manda_ctrl_b_y_dice_por_que() {
    let mut f = Falso::nuevo(&[("t1", "Bash", 10)]);
    f.cierra_tras = None;
    f.pantalla.pista_segundo_plano = false;
    let r = pasar_a_segundo_plano(&f).expect("resultado");
    assert!(!r.ok);
    assert_eq!(r.evidence, BackgroundEvidence::None);
    assert_eq!(r.steps, vec!["sinPista"]);
    assert!(f.escritos.borrow().is_empty(), "ningún Ctrl+B a ciegas");
    let motivo = r.reason.expect("motivo");
    assert!(motivo.starts_with(SIN_PISTA), "{motivo}");
    assert!(motivo.contains("Esc para interrumpir"), "{motivo}");
    let esperas = u32::try_from(f.esperas.get()).expect("esperas");
    assert_eq!(PASO * esperas, ESPERA_PISTA, "solo espera la pista");
}

/// Spike del 2026-10-16: un Ctrl+B antes de que la TUI pinte la pista no hace
/// nada. Se espera a la pista y solo entonces se escribe.
#[test]
fn espera_la_pista_antes_de_mandar_ctrl_b() {
    let mut f = Falso::nuevo(&[("t1", "Bash", 10)]);
    f.pista_tras = Some(3);
    f.cierra_tras = Some(5);
    let r = pasar_a_segundo_plano(&f).expect("resultado");
    assert!(r.ok);
    assert_eq!(r.steps, vec!["pista", "ctrlB", "toolEnd"]);
    assert_eq!(f.escritos.borrow().len(), 1);
}

/// Caso negativo: si la herramienta termina sola mientras se espera la
/// pista, no se manda ningún Ctrl+B.
#[test]
fn si_termina_sola_esperando_la_pista_no_escribe_nada() {
    let mut f = Falso::nuevo(&[("t1", "PowerShell", 10)]);
    f.pista_tras = Some(100);
    f.cierra_tras = Some(2);
    let r = pasar_a_segundo_plano(&f).expect("resultado");
    assert!(r.ok);
    assert_eq!(r.evidence, BackgroundEvidence::ToolEnd);
    assert_eq!(r.steps, vec!["terminadaSinCtrlB"]);
    assert!(f.escritos.borrow().is_empty());
}

#[test]
fn un_rechazo_del_escritor_es_err_con_su_motivo() {
    let mut f = Falso::nuevo(&[("t1", "Agent", 10)]);
    f.rechazo = Some(ErrorEscritura::SegundoPlanoSinTrabajo);
    let r = pasar_a_segundo_plano(&f);
    assert_eq!(
        r,
        Err("Ctrl+B rechazado: no hay ninguna tarea en primer plano".to_string())
    );
}

#[test]
fn primer_plano_elige_la_mas_reciente_y_marca_si_se_mueve() {
    let mut e = EstadoSesion::nuevo(0);
    assert_eq!(primer_plano(&e), None, "sin herramientas, nada");
    let h = |nombre: &str, desde: Ms| HerramientaAbierta {
        nombre: nombre.to_string(),
        desde,
        timeout_ms: None,
    };
    e.herramientas.insert("t-bash".into(), h("Bash", 1_000));
    e.herramientas.insert("t-read".into(), h("Read", 2_000));
    let f = primer_plano(&e).expect("herramienta");
    assert_eq!(
        f.tool_use_id, "t-bash",
        "la movible manda sobre un Read posterior"
    );
    assert!(!f.backgroundable, "sin la pista en pantalla no se ofrece");
    e.pista_segundo_plano = true;
    let f = primer_plano(&e).expect("herramienta");
    assert!(f.backgroundable);
    assert_eq!(f.since, iso(1_000));
    e.herramientas.remove("t-bash");
    let f = primer_plano(&e).expect("herramienta");
    assert_eq!(f.name, "Read");
    assert!(!f.backgroundable, "Read no se mueve");
    assert_eq!(f.since, iso(2_000));
}

#[test]
fn movibles_son_shell_agentes_y_mcp() {
    for n in [
        "Bash",
        "PowerShell",
        "Agent",
        "Task",
        "mcp__ultron-desktop__screenshot",
    ] {
        assert!(movible(n), "{n}");
    }
    for n in ["Read", "Edit", "Grep", "WebFetch", "mcp", ""] {
        assert!(!movible(n), "{n}");
    }
}

/// La herramienta en primer plano viaja en `SessionInfo` y su llegada o su
/// cierre emiten `sesiones://sessions` aunque no cambie nada más.
#[test]
fn proyectar_lleva_la_herramienta_y_su_cambio_se_emite() {
    use crate::sesiones::maquina::{proyectar, transicion, Efecto, ResumenTickets};
    use crate::sesiones::senales::Senal;
    use crate::sesiones::types::{PermissionMode, SessionInfo};
    let t = ResumenTickets::default();
    let e0 = EstadoSesion::nuevo(0);
    let inicio = Senal::HerramientaInicio {
        tool_use_id: "t1".into(),
        nombre: "Bash".into(),
        timeout_ms: None,
    };
    let (e1, ef) = transicion(&e0, &inicio, 5_000, &t);
    assert!(ef.contains(&Efecto::EmitirSesiones));
    let mut info = SessionInfo::nueva("s", "/p", PermissionMode::Default);
    proyectar(&e1, &mut info);
    let f = info.foreground_tool.clone().expect("foregroundTool");
    assert_eq!((f.tool_use_id.as_str(), f.backgroundable), ("t1", false));
    // La pista en pantalla vuelve movible la herramienta y el cambio se emite.
    let pista = Senal::Pantalla {
        estado: EstadoPantalla::Busy,
        modo: None,
        entrada: None,
        pista: true,
    };
    let (e1, ef) = transicion(&e1, &pista, 5_500, &t);
    assert!(ef.contains(&Efecto::EmitirSesiones));
    proyectar(&e1, &mut info);
    let f = info.foreground_tool.clone().expect("foregroundTool");
    assert_eq!((f.tool_use_id.as_str(), f.backgroundable), ("t1", true));
    let json = serde_json::to_value(&info).expect("json");
    assert_eq!(json["foregroundTool"]["toolUseId"], "t1");
    let (e2, ef) = transicion(
        &e1,
        &Senal::HerramientaFin {
            tool_use_id: "t1".into(),
        },
        6_000,
        &t,
    );
    assert!(ef.contains(&Efecto::EmitirSesiones));
    proyectar(&e2, &mut info);
    assert_eq!(info.foreground_tool, None);
    // Caso negativo: sin herramienta, el campo no viaja.
    let json = serde_json::to_value(&info).expect("json");
    assert!(json.get("foregroundTool").is_none());
}

#[test]
fn dos_llamadas_a_la_vez_escriben_un_solo_ctrl_b_y_la_segunda_es_en_curso() {
    let f = Falso::nuevo(&[("t1", "Bash", 1)]);
    let id = "test-sp-reserva-concurrente";
    let mut segunda = None;
    let primera = con_reserva(id, || {
        // La segunda llega con la primera aún en vuelo (tecla mantenida,
        // botón y atajo a la vez).
        segunda = Some(con_reserva(id, || pasar_a_segundo_plano(&f)));
        pasar_a_segundo_plano(&f)
    })
    .expect("primera");
    assert!(primera.ok, "la primera lo mueve");
    let segunda = segunda.expect("se llamó").expect("ok sin error");
    assert!(!segunda.ok);
    assert_eq!(segunda.steps, vec![EN_CURSO]);
    assert!(segunda.reason.is_none(), "sin motivo de error");
    assert_eq!(
        f.escritos.borrow().len(),
        1,
        "un solo Ctrl+B: {:?}",
        f.escritos.borrow()
    );
}

#[test]
fn recien_terminado_es_antirrebote_y_libre_tras_la_ventana() {
    let id = "test-sp-reserva-antirrebote";
    let llamadas = Cell::new(0);
    let llamar = || {
        con_reserva(id, || {
            llamadas.set(llamadas.get() + 1);
            Err("sin herramienta".to_string())
        })
    };
    assert!(llamar().is_err(), "la primera se ejecuta");
    let r = llamar().expect("antirrebote sin error");
    assert_eq!(r.steps, vec![ANTIRREBOTE]);
    assert_eq!(llamadas.get(), 1);
    // Caso negativo: otra sesión no queda bloqueada por esta.
    let otra = con_reserva("test-sp-reserva-otra", || Err("x".to_string()));
    assert!(otra.is_err(), "otra sesión sí se ejecuta");
}
