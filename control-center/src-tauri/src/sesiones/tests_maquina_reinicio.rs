// sesiones/tests_maquina_reinicio.rs — Auditoría 2026-10-17 (tanda 1,
// punto 4): el reinicio olvida el protocolo y la generación del puente del
// proceso anterior, y `bridgeConnected` sale de la máquina (vuelve a false al
// reiniciar o al salir el proceso). Comparte el arnés `H` de
// `tests_maquina.rs`. Cada caso fallaba con el comportamiento anterior o fija
// un caso negativo.

use super::tests::{pantalla, H};
use super::*;
use crate::sesiones::registro;
use crate::sesiones::senales::{EstadoPantalla as P, Senal};
use crate::sesiones::types::SessionStatus as S;

fn hello(generacion: u32) -> Senal {
    Senal::PuenteHello {
        protocolo: 2,
        claude_session_id: None,
        generacion,
        transcript_path: None,
        origen: "start".into(),
    }
}

/// El proceso relanzado no ha dicho `hello`: hasta que lo diga, la máquina
/// no puede contar con su puente (antes conservaba el protocolo 2 del
/// anterior y esperaba evidencia de un puente que quizá no existe).
#[test]
fn el_reinicio_olvida_el_protocolo_y_la_generacion_del_proceso_anterior() {
    let mut h = H::idle(0);
    h.s(hello(3));
    assert_eq!((h.e.protocolo, h.e.generacion), (2, 3));
    h.s(Senal::ReinicioPedido);
    assert_eq!((h.e.protocolo, h.e.generacion), (0, 0));
    assert!(!h.e.con_puente());
    // Sin puente, el arranque llega a idle por el prompt estable.
    h.s(pantalla(P::Prompt)).avanza(300);
    assert_eq!(h.e.status, S::Idle, "{:?}", h.todos);
}

/// Caso negativo: el `hello` del proceso relanzado vuelve a fijarlos.
#[test]
fn el_hello_del_proceso_relanzado_vuelve_a_fijar_el_protocolo() {
    let mut h = H::idle(0);
    h.s(hello(3)).s(Senal::ReinicioPedido).s(hello(4));
    assert_eq!((h.e.protocolo, h.e.generacion), (2, 4));
    assert!(h.e.con_puente());
}

fn conectado(h: &H, info: &mut crate::sesiones::types::SessionInfo) -> bool {
    proyectar(&h.e, info);
    info.bridge_connected
}

/// `bridgeConnected` era pegajoso: una vez a true no volvía a false ni al
/// reiniciar ni al salir el proceso. Ahora es el puente del proceso actual.
#[test]
fn bridge_connected_vuelve_a_false_al_reiniciar_y_al_salir() {
    let id = format!("puente-real-{}", uuid::Uuid::new_v4());
    let mut info = registro::sesion_de_prueba(&id).info;
    let mut h = H::idle(0);
    assert!(!conectado(&h, &mut info), "sin hello no hay puente");
    h.s(hello(1));
    assert!(conectado(&h, &mut info), "tras el hello");
    h.s(Senal::ReinicioPedido);
    assert!(!conectado(&h, &mut info), "el relanzado aún no dijo hello");
    h.s(hello(2));
    assert!(conectado(&h, &mut info), "hello del relanzado");
    h.s(Senal::ProcesoSalio { code: 0 })
        .s(Senal::ProcesoSalio { code: 1 });
    assert_eq!(h.e.status, S::Exited);
    assert!(!conectado(&h, &mut info), "proceso terminado");
}
