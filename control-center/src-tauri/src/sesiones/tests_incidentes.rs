// Tests del registro de incidentes (incidentes.rs).

use std::collections::HashMap;

use super::*;
use crate::sesiones::maquina::{EstadoSesion, HerramientaAbierta};

fn aviso(id: Option<&str>, texto: &str) -> IncidentReport {
    IncidentReport {
        id: id.map(str::to_string),
        origin: "note".into(),
        level: "error".into(),
        text: texto.into(),
    }
}

#[test]
fn la_misma_clave_dentro_de_la_ventana_se_descarta() {
    let mut v = HashMap::new();
    assert!(debe_registrar(&mut v, "s1|fallo", 1_000));
    assert!(!debe_registrar(
        &mut v,
        "s1|fallo",
        1_000 + VENTANA_DEDUP - 1
    ));
    assert!(
        debe_registrar(&mut v, "s2|fallo", 1_500),
        "otra sesión no es repetición"
    );
}

#[test]
fn pasada_la_ventana_se_vuelve_a_registrar() {
    let mut v = HashMap::new();
    assert!(debe_registrar(&mut v, "s1|fallo", 1_000));
    assert!(debe_registrar(&mut v, "s1|fallo", 1_000 + VENTANA_DEDUP));
}

#[test]
fn las_claves_caducadas_se_purgan_al_pasar_del_tope() {
    let mut v = HashMap::new();
    for i in 0..=MAX_CLAVES {
        debe_registrar(&mut v, &format!("k{i}"), 0);
    }
    debe_registrar(&mut v, "nueva", VENTANA_DEDUP * 2);
    assert_eq!(v.len(), 1, "solo queda la vigente");
}

#[test]
fn la_pantalla_pierde_las_filas_vacias_del_final() {
    let filas = vec!["> hola".into(), "".into(), "  ".into()];
    assert_eq!(recortar_pantalla(filas), vec!["> hola".to_string()]);
}

#[test]
fn la_linea_lleva_aviso_maquina_y_pantalla() {
    let mut e = EstadoSesion::nuevo(0);
    e.herramientas.insert(
        "t1".into(),
        HerramientaAbierta {
            nombre: "Bash".into(),
            desde: 1_000,
            timeout_ms: None,
        },
    );
    let ctx = Contexto {
        info: None,
        maquina: Some(foto_maquina(&e, 121_000)),
        pantalla: vec!["⏺ Bash(git log)".into()],
    };
    let v: serde_json::Value =
        serde_json::from_str(&linea(&aviso(Some("s1"), "No se pudo"), 121_000, &ctx))
            .expect("json");
    assert_eq!(v["sesion"], "s1");
    assert_eq!(v["texto"], "No se pudo");
    assert_eq!(v["maquina"]["herramientas"][0]["nombre"], "Bash");
    assert_eq!(v["maquina"]["herramientas"][0]["segundos"], 120);
    assert_eq!(v["pantalla"][0], "⏺ Bash(git log)");
}

#[test]
fn un_texto_enorme_se_recorta() {
    let largo = "x".repeat(MAX_TEXTO + 50);
    let v: serde_json::Value =
        serde_json::from_str(&linea(&aviso(None, &largo), 0, &Contexto::default())).expect("json");
    assert_eq!(
        v["texto"].as_str().expect("texto").chars().count(),
        MAX_TEXTO + 1
    );
    assert!(v["sesion"].is_null());
}

#[test]
fn anexar_rota_al_pasar_del_tope() {
    let dir = tempfile::tempdir().expect("tmp");
    let ruta = dir.path().join("logs").join(FICHERO);
    anexar(&ruta, "uno", 4).expect("1");
    anexar(&ruta, "dos", 4).expect("2");
    assert_eq!(std::fs::read_to_string(&ruta).expect("actual"), "dos\n");
    let rotado = ruta.with_extension("1.jsonl");
    assert_eq!(std::fs::read_to_string(rotado).expect("rotado"), "uno\n");
}

#[test]
fn anexar_por_debajo_del_tope_no_rota() {
    let dir = tempfile::tempdir().expect("tmp");
    let ruta = dir.path().join(FICHERO);
    anexar(&ruta, "uno", 1024).expect("1");
    anexar(&ruta, "dos", 1024).expect("2");
    assert_eq!(
        std::fs::read_to_string(&ruta).expect("actual"),
        "uno\ndos\n"
    );
    assert!(!ruta.with_extension("1.jsonl").exists());
}
