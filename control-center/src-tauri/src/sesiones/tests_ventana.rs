// sesiones/tests_ventana.rs — Tests de las ventanas de Sessions: preguntas
// que sobreviven al cierre, permiso de micrófono, vistas previas e identidad
// en la barra de tareas.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::*;
use crate::sesiones::preguntas::Broker;
use crate::sesiones::registro::is_sessions_window;
use crate::sesiones::test_sink::MockSink;
use crate::sesiones::types::{AskAnswer, PermissionDecision};
use crate::sesiones::ventana_icono::{
    aumid_para, icono, siguiente_aro, Aspecto, ICON_SIZE, RING_COLORS,
};

#[test]
fn etiquetas_de_ventanas_de_sessions() {
    assert!(is_sessions_window("sesiones"));
    assert!(is_sessions_window("sesiones-1a2b3c4d"));
    assert!(!is_sessions_window("sesiones-"));
    assert!(!is_sessions_window("sesionesx"));
    assert!(!is_sessions_window("main"));
}

#[test]
fn ids_de_proyecto() {
    assert!(valid_project_id("mi-proyecto_1.0"));
    assert!(!valid_project_id("a&b"));
    assert!(!valid_project_id(""));
    assert!(!valid_project_id(".."));
}

#[test]
fn cerrar_la_ultima_ventana_no_cancela_las_preguntas() {
    let _cierre = crate::sesiones::comandos_pty::tests::cierre_global();
    let broker = Broker::global();
    let sink = Arc::new(MockSink::opened());
    let (b2, s2) = (broker.clone(), sink.clone());
    let permiso = json!({ "kind": "permission", "tool": "Bash", "input": {}, "summary": "ls" });
    let hilo = std::thread::spawn(move || b2.ask(&*s2, "ventana-cierre", &permiso));
    let ask_id = loop {
        let found = sink.events.lock().ok().and_then(|e| {
            e.iter()
                .find(|(n, _)| n == ev::ASK)
                .and_then(|(_, p)| p["askId"].as_str().map(str::to_string))
        });
        if let Some(id) = found {
            break id;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    al_cerrar_ventana(false);
    let ans = AskAnswer::Permission {
        decision: PermissionDecision::Allow,
        reason: None,
    };
    broker
        .answer(&*sink, &ask_id, ans.clone())
        .expect("la pregunta sigue pendiente tras cerrar la última ventana");
    assert_eq!(hilo.join().expect("hilo").expect("ok"), Some(ans));
}

#[test]
fn el_microfono_solo_se_concede_al_origen_de_la_app() {
    assert!(allow_permission(
        "http://tauri.localhost/sesiones.html?win=sesiones-1",
        Permiso::Microfono
    ));
    assert!(allow_permission(
        "https://tauri.localhost",
        Permiso::Microfono
    ));
    assert!(!allow_permission("http://tauri.localhost", Permiso::Otro));
    assert!(!allow_permission("http://evil.example", Permiso::Microfono));
    assert!(!allow_permission(
        "http://tauri.localhost.evil.example/",
        Permiso::Microfono
    ));
    assert!(!allow_permission(
        "http://tauri.localhost@evil.example/",
        Permiso::Microfono
    ));
    assert!(!allow_permission(
        "http://preview.localhost/x",
        Permiso::Microfono
    ));
    assert!(!allow_permission("no es una uri", Permiso::Microfono));
}

#[test]
fn una_vista_previa_se_sirve_con_su_csp_y_caduca_al_cerrar() {
    let _cierre = crate::sesiones::comandos_pty::tests::cierre_global();
    let id = preview_put("<p>hola</p>".into()).expect("put");
    assert_eq!(
        preview_response(&format!("/{id}")),
        (200, "<p>hola</p>".to_string())
    );
    assert_eq!(preview_response("/no-existe").0, 404);
    assert!(preview_url(&id).ends_with(&id));
    assert!(PREVIEW_CSP.contains("script-src 'unsafe-inline'"));
    assert!(PREVIEW_CSP.contains("connect-src 'none'"));
    al_cerrar_ventana(true);
    assert_eq!(
        preview_response(&format!("/{id}")).0,
        200,
        "quedan ventanas"
    );
    al_cerrar_ventana(false);
    assert_eq!(preview_response(&format!("/{id}")).0, 404);
}

#[test]
fn una_vista_previa_enorme_se_rechaza() {
    assert!(preview_put("x".repeat(2 * 1024 * 1024 + 1)).is_err());
}

#[test]
fn cada_ventana_tiene_su_aumid() {
    assert_eq!(aumid_para("sesiones"), "ULTRON.Sessions");
    let a = aumid_para("sesiones-1a2b3c4d");
    let b = aumid_para("sesiones-9f8e7d6c");
    assert_eq!(a, "ULTRON.Sessions.1a2b3c4d");
    assert_ne!(a, b);
    assert!(a.len() <= 128 && !a.contains(' '));
}

#[test]
fn el_icono_lleva_la_inicial_y_un_aro_que_rota() {
    let px = icono('A', [10, 20, 30]);
    assert_eq!(px.len(), ICON_SIZE * ICON_SIZE * 4);
    let at = |x: usize, y: usize| &px[(y * ICON_SIZE + x) * 4..(y * ICON_SIZE + x) * 4 + 4];
    assert_eq!(at(0, 0)[3], 0, "fuera del disco, transparente");
    assert_eq!(
        at(ICON_SIZE - 1, 0)[3],
        0,
        "esquina transparente: disco, no cuadrado"
    );
    assert_eq!(
        at(62, 32),
        &[10, 20, 30, 255],
        "aro a sangre a la derecha, con su color"
    );
    assert_eq!(
        at(12, 12),
        &[5, 5, 7, 255],
        "hueco del aro arriba a la izquierda"
    );
    assert_eq!(at(32, 2)[..3], [5, 5, 7], "el hueco abre el aro por arriba");
    let blancos = (16..48)
        .flat_map(|y| (16..48).map(move |x| (x, y)))
        .filter(|&(x, y)| at(x, y) == [0xF2, 0xF3, 0xF5, 255])
        .count();
    assert!(
        blancos > 60,
        "la inicial ocupa el centro: {blancos} px blancos"
    );
    assert_ne!(icono('A', [10, 20, 30]), icono('B', [10, 20, 30]));
    assert_eq!(
        Aspecto::principal().rgba,
        icono('U', RING_COLORS[0]),
        "principal en naranja Claude"
    );
    let s1 = Aspecto::de_sesion("sesiones-1", "Arreglar build", "explored");
    let s2 = Aspecto::de_sesion("sesiones-2", "Repasar TFG", "explored");
    assert_ne!(
        s1.rgba, s2.rgba,
        "dos ventanas seguidas, dos colores de aro"
    );
    assert_ne!(s1.aumid, s2.aumid);
    assert_eq!(s1.titulo, "Arreglar build · explored");
    let ronda: std::collections::HashSet<_> = (0..9).map(|_| siguiente_aro()).collect();
    assert_eq!(
        ronda.len(),
        9,
        "nueve ventanas seguidas recorren los nueve colores secundarios"
    );
    assert!(
        !ronda.contains(&RING_COLORS[0]),
        "el naranja queda para la principal"
    );
}

/// Cerrar la última ventana suelta la terminal del bloque de menú: la cola
/// deja de estar en pausa y la emisión en vivo se apaga (sin vista que la
/// suelte, antes se quedaban así para siempre). Con otras ventanas abiertas
/// no se toca.
#[test]
fn cerrar_la_ultima_ventana_suelta_la_terminal_del_menu() {
    let _cierre = crate::sesiones::comandos_pty::tests::cierre_global();
    let (id, pty, _m) = crate::sesiones::comandos_pty::tests::sesion_enganchada();
    al_cerrar_ventana(true);
    assert!(registro::contexto(&id).terminal, "quedan ventanas");
    al_cerrar_ventana(false);
    assert!(!registro::contexto(&id).terminal, "la cola sigue en pausa");
    assert!(!crate::pty::io::attached(&pty));
    crate::sesiones::gestor::kill(&id).expect("kill");
}

/// Hallazgos nocturnos 1 y 5: solo la caída del renderer de la página
/// recarga; el resto de procesos se anota (caso negativo).
#[test]
fn solo_el_renderer_caido_recarga_la_pagina() {
    assert_eq!(
        accion_por_caida(1),
        AccionCaida::Recargar,
        "RENDER_PROCESS_EXITED"
    );
    for kind in [0, 2, 3, 4, 5, 6, 7, 8, 9] {
        assert_eq!(accion_por_caida(kind), AccionCaida::Anotar, "kind {kind}");
    }
}

/// Un renderer que cae en bucle no recarga sin fin: 3 por cada 10 min.
#[test]
fn las_recargas_estan_acotadas_por_ventana() {
    let mut h = VecDeque::new();
    let t = Instant::now();
    assert!(admitir_recarga(&mut h, t));
    assert!(admitir_recarga(&mut h, t + Duration::from_secs(1)));
    assert!(admitir_recarga(&mut h, t + Duration::from_secs(2)));
    assert!(
        !admitir_recarga(&mut h, t + Duration::from_secs(3)),
        "cuarta en 10 min"
    );
    assert!(
        admitir_recarga(&mut h, t + Duration::from_secs(600)),
        "la primera ya salió de la ventana"
    );
    assert_eq!(h.len(), 3);
}
