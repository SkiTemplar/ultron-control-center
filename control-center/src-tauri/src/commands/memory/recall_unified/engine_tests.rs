use super::*;

fn entry(dense: Option<f32>, sparse: Option<usize>) -> RecallEntry {
    RecallEntry {
        canonical_id: "x".into(),
        title: None,
        summary: Some("s".into()),
        scope: "project".into(),
        project_id: None,
        score: 0.01,
        dense_rank: None,
        sparse_rank: sparse,
        dense_score: dense,
        reason: "test".into(),
        token_estimate: 10,
    }
}

// (floor) 2026-07-02 — el pack abstiene cuando NINGUNA entrada trae señal:
// ni dense >= floor ni sparse fuerte. Casos calibrados con el probe real.
#[test]
fn abstain_gate_needs_dense_floor_or_strong_sparse() {
    // Incontestable real ("paella", probe 2026-07-02): dense max 0.8049 +
    // sparse ranks 11-13 (ruido lexico) -> sin señal -> abstiene.
    let junk = vec![entry(Some(0.8049), None), entry(None, Some(11))];
    assert!(
        !pack_has_confident_signal(&junk, 0.84),
        "relleno sin señal debe abstener"
    );

    // dense sobre el floor (t1 router: 0.8459) -> confianza (caso negativo).
    let dense_ok = vec![entry(Some(0.8459), None)];
    assert!(pack_has_confident_signal(&dense_ok, 0.84));

    // sparse FUERTE (rank <= STRONG_SPARSE_RANK, match lexico exacto tipo
    // identificador) protege las queries sparse-only aunque el dense sea debil.
    let sparse_ok = vec![entry(None, Some(0)), entry(Some(0.70), None)];
    assert!(pack_has_confident_signal(&sparse_ok, 0.84));

    // (2026-08-16) rank 3 SI cuenta: es el caso real de la query `qdrant`,
    // cuyo mejor dense (0.8240) no alcanza el floor y cuyo respaldo lexico
    // BM25 estaba en tercera posicion. Con el corte antiguo en 2 se quedaba
    // sin ninguna señal y el pack se vaciaba entero.
    let sparse_rank3 = vec![entry(Some(0.8240), Some(3))];
    assert!(pack_has_confident_signal(&sparse_rank3, 0.83));
    let sparse_rank5 = vec![entry(None, Some(5))];
    assert!(pack_has_confident_signal(&sparse_rank5, 0.84));

    // CASO NEGATIVO: pasado el umbral se vuelve a ser ruido. Rank 6 y los
    // ranks 11-13 del probe "paella" no compran confianza.
    let sparse_weak = vec![entry(None, Some(6))];
    assert!(!pack_has_confident_signal(&sparse_weak, 0.84));
    let sparse_noise = vec![entry(None, Some(12))];
    assert!(!pack_has_confident_signal(&sparse_noise, 0.84));

    // pack vacio: sin señal (gate no-op sobre vacio).
    assert!(!pack_has_confident_signal(&[], 0.84));
}

#[test]
fn ranking_knobs_env_override_and_fail_safe() {
    // (cat1 ranking) Solo este test toca estas env vars.
    std::env::set_var("ULTRON_FANOUT_K", "50");
    assert_eq!(env_knob_usize("ULTRON_FANOUT_K", 30), 50);
    std::env::set_var("ULTRON_FANOUT_K", "garbage");
    assert_eq!(
        env_knob_usize("ULTRON_FANOUT_K", 30),
        30,
        "basura -> default, no silencio"
    );
    std::env::remove_var("ULTRON_FANOUT_K");
    assert_eq!(env_knob_usize("ULTRON_FANOUT_K", 30), 30);

    std::env::set_var("ULTRON_RRF_K", "20.5");
    assert_eq!(env_knob_f32("ULTRON_RRF_K", 60.0), 20.5);
    std::env::remove_var("ULTRON_RRF_K");
    assert_eq!(env_knob_f32("ULTRON_RRF_K", 60.0), 60.0);
}

#[test]
fn prune_margin_env_override_off_and_garbage() {
    // Mismo contrato que el floor: off desactiva, valor invalido -> default
    // (nunca silencio ni panic en el hot path).
    std::env::set_var("ULTRON_PRUNE_MARGIN", "off");
    assert_eq!(prune_margin(), None, "off desactiva la poda");
    std::env::set_var("ULTRON_PRUNE_MARGIN", "0.07");
    assert_eq!(prune_margin(), Some(0.07));
    std::env::set_var("ULTRON_PRUNE_MARGIN", "basura");
    assert_eq!(
        prune_margin(),
        Some(DEFAULT_PRUNE_MARGIN),
        "valor invalido -> default"
    );
    // Sin env var: OFF por veredicto medido (golden: podar EMPEORA el
    // recall 0.810 -> 0.751). Este assert es el guardian de esa decision.
    std::env::remove_var("ULTRON_PRUNE_MARGIN");
    assert_eq!(
        prune_margin(),
        None,
        "default OFF: la poda por margen quedo refutada por medicion"
    );
}

#[test]
fn recall_floor_env_override_off_and_garbage() {
    // Solo este test toca la env var (secuencial dentro del test -> sin carrera).
    std::env::set_var("ULTRON_RECALL_FLOOR", "off");
    assert_eq!(recall_floor(), None, "off desactiva el gate");
    std::env::set_var("ULTRON_RECALL_FLOOR", "0.9");
    assert_eq!(recall_floor(), Some(0.9));
    std::env::set_var("ULTRON_RECALL_FLOOR", "garbage");
    assert_eq!(
        recall_floor(),
        Some(DEFAULT_RECALL_FLOOR),
        "valor invalido -> default, no silencio"
    );
    // (2026-08-16) Sin env var manda el default, que ahora es 0.81: medido
    // sobre trafico real, 0.83 silenciaba el 24,2% de los prompts y 0.81 baja
    // al 15,8% conservando entero el memory-bench.
    std::env::remove_var("ULTRON_RECALL_FLOOR");
    assert_eq!(recall_floor(), Some(DEFAULT_RECALL_FLOOR));
    assert!(
        (DEFAULT_RECALL_FLOOR - 0.81).abs() < f32::EPSILON,
        "el default es el umbral medido, no un valor cualquiera"
    );
}
