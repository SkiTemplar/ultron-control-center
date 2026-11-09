// sesiones/tests_registro_salto.rs — Tests de la reanudación tras una
// suspensión del PC (salto de reloj) en el cableado de estados.
// Submódulo de tests de `registro_estado.rs`.

use super::*;
use crate::sesiones::maquina::ResumenTickets;
use crate::sesiones::registro;
use crate::sesiones::senales::EstadoPantalla;

fn pantalla_senal(estado: EstadoPantalla) -> Senal {
    Senal::Pantalla {
        estado,
        modo: None,
        entrada: None,
        pista: false,
    }
}

/// Turno `t1` abierto por el puente con el prompt a la vista, construido
/// con la tabla pura una hora antes de `ahora`.
fn turno_de_hace_una_hora(antes: Ms) -> EstadoSesion {
    let t = ResumenTickets::default();
    let mut e = EstadoSesion::nuevo(antes - 2_000);
    e.protocolo = 2;
    let pasos = [
        (pantalla_senal(EstadoPantalla::Prompt), antes - 2_000),
        (Senal::Tick, antes - 1_500),
        (
            Senal::TurnoInicio {
                turn_id: "t1".into(),
            },
            antes - 1_000,
        ),
        (Senal::Tick, antes),
    ];
    for (s, t_ms) in pasos {
        e = maquina::transicion(&e, &s, t_ms, &t).0;
    }
    assert_eq!(e.status, SessionStatus::Working, "turno abierto");
    e
}

/// Suspensión del PC (hallazgo nocturno 5): el primer tick tras una hora
/// de hueco no da el turno por perdido ni marca colgado; sin el rebase,
/// `turno_perdido` lo cerraba y `noEvents` vencía a la vez.
#[test]
fn un_salto_de_reloj_no_cierra_el_turno_ni_marca_colgado() {
    let id = format!("salto-reloj-{}", uuid::Uuid::new_v4());
    registro::insert(registro::sesion_de_prueba(&id)).expect("alta");
    let antes = ahora_ms() - 3_600_000;
    {
        let mut g = estados().lock().expect("estados");
        g.maquinas.insert(id.clone(), turno_de_hace_una_hora(antes));
        g.ultimo_tick.insert(id.clone(), antes);
    }
    manejar_senal(&id, Senal::Tick);
    let e = estado(&id).expect("estado");
    assert_eq!(e.status, SessionStatus::Working, "el turno sigue abierto");
    assert_eq!(e.stalled, None, "ningún colgado por el hueco");
    assert!(e.cerrados.is_empty(), "t1 no se cerró");
    let tick = estados()
        .lock()
        .ok()
        .and_then(|g| g.ultimo_tick.get(&id).copied())
        .expect("tick");
    assert!(tick > antes + 3_000_000, "el último tick se actualiza");
    olvidar_sesion(&id);
    registro::remove(&id);
}

/// Caso negativo: ticks seguidos no rebasan nada.
#[test]
fn sin_hueco_no_se_rebasa() {
    let id = format!("sin-salto-{}", uuid::Uuid::new_v4());
    let mut g = Estados::default();
    let mut e = EstadoSesion::nuevo(1_000);
    g.ultimo_tick.insert(id.clone(), 1_000);
    rebasar_si_salto(&mut g, &id, &Senal::Tick, 2_000, &mut e);
    assert_eq!(e.pantalla_desde, 1_000, "1 s entre ticks no es un salto");
    rebasar_si_salto(&mut g, &id, &Senal::Progreso, 40_000, &mut e);
    assert_eq!(e.pantalla_desde, 40_000, "38 s desde el último tick sí");
}
