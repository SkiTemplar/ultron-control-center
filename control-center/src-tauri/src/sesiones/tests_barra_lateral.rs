// sesiones/tests_barra_lateral.rs — Validación, almacén y conversión a px
// físicos de los informes de la columna de Sessions.

use super::*;

fn rect(x: f64, y: f64, w: f64, h: f64) -> CssRect {
    CssRect { x, y, w, h }
}

fn item(id: &str) -> RailItem {
    RailItem {
        id: id.into(),
        rect: rect(0.0, 40.0, 260.0, 44.0),
        clip: Clip::Full,
    }
}

fn report(items: Vec<RailItem>) -> RailReport {
    RailReport {
        dpr: 1.5,
        rail: Some(rect(0.0, 0.0, 280.0, 800.0)),
        items,
        composer: None,
    }
}

#[test]
fn un_informe_normal_es_valido() {
    assert_eq!(validar(&report(vec![item("s-1_a"), item("f3a9")])), Ok(()));
    let vacio = RailReport {
        dpr: 1.0,
        rail: None,
        items: vec![],
        composer: Some(rect(300.0, 700.0, 600.0, 80.0)),
    };
    assert_eq!(validar(&vacio), Ok(()));
}

#[test]
fn rechaza_dpr_cero_o_nan() {
    for dpr in [0.0, f64::NAN, f64::INFINITY, -1.0, 9.0] {
        let r = RailReport {
            dpr,
            ..report(vec![])
        };
        assert!(validar(&r).is_err(), "dpr {dpr} debería rechazarse");
    }
}

#[test]
fn rechaza_201_filas_e_ids_raros() {
    let muchas: Vec<RailItem> = (0..201).map(|i| item(&format!("s{i}"))).collect();
    assert!(validar(&report(muchas)).is_err());
    for id in ["a/b", "", "a b", "..", &"x".repeat(65)] {
        assert!(validar(&report(vec![item(id)])).is_err(), "id '{id}'");
    }
}

#[test]
fn rechaza_numeros_no_finitos_o_enormes() {
    let mut it = item("s1");
    it.rect.y = f64::NAN;
    assert!(validar(&report(vec![it])).is_err());
    let mut it = item("s1");
    it.rect.w = 200_000.0;
    assert!(validar(&report(vec![it])).is_err());
    let sin_columna = RailReport {
        rail: None,
        ..report(vec![item("s1")])
    };
    assert!(validar(&sin_columna).is_err(), "filas sin columna");
}

#[test]
fn conversion_a_fisico_con_escala_150() {
    let r = a_fisico((100, 200), 1.5, &rect(10.0, 20.0, 40.0, 30.0));
    assert_eq!(
        r,
        PhysRect {
            left: 115,
            top: 230,
            right: 175,
            bottom: 275
        }
    );
}

#[test]
fn guardar_y_olvidar() {
    let label = "sesiones-test-barra";
    assert_eq!(informe(label), None);
    guardar(label, report(vec![item("s1")]));
    assert_eq!(informe(label).map(|r| r.items.len()), Some(1));
    olvidar(label);
    assert_eq!(informe(label), None);
}

#[test]
fn el_json_del_frontend_se_deserializa() {
    let raw = r#"{"dpr":1.25,"rail":{"x":0,"y":0,"w":280,"h":700},
        "items":[{"id":"abc","rect":{"x":4,"y":60,"w":270,"h":40},"clip":"partial"}]}"#;
    let r: RailReport = serde_json::from_str(raw).expect("informe");
    assert_eq!(r.items[0].clip, Clip::Partial);
    assert!(serde_json::from_str::<RailReport>(r#"{"dpr":1,"rail":null}"#).is_err());
    let raro = r#"{"dpr":1,"rail":null,"items":[{"id":"a","rect":{"x":0,"y":0,"w":1,"h":1},"clip":"lejos"}]}"#;
    assert!(serde_json::from_str::<RailReport>(raro).is_err());
}

#[test]
fn rechaza_un_composer_raro() {
    for c in [
        rect(f64::NAN, 0.0, 10.0, 10.0),
        rect(0.0, 0.0, 200_000.0, 10.0),
        rect(0.0, 0.0, 0.0, 10.0),
        rect(0.0, 0.0, 10.0, -1.0),
    ] {
        let r = RailReport {
            composer: Some(c),
            ..report(vec![])
        };
        assert!(validar(&r).is_err(), "composer {c:?} debería rechazarse");
    }
}

#[test]
fn el_composer_es_opcional_en_el_json() {
    let sin = r#"{"dpr":1,"rail":null,"items":[]}"#;
    assert_eq!(
        serde_json::from_str::<RailReport>(sin)
            .expect("informe")
            .composer,
        None
    );
    let con = r#"{"dpr":1,"rail":null,"items":[],"composer":{"x":10,"y":600,"w":500,"h":70}}"#;
    let r: RailReport = serde_json::from_str(con).expect("informe");
    assert_eq!(r.composer, Some(rect(10.0, 600.0, 500.0, 70.0)));
}
