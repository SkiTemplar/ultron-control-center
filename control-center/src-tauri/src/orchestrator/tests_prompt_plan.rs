// orchestrator/tests_prompt_plan.rs — vaguedad, multi-paso y modo denso
// efectivo (hallazgos prompting-6 y prompting-7 de la auditoría 2026-10-23).

use super::orchestrate::{
    classify_empty_delegation, effective_dense, honest_recall_warnings, rerank_for_turn,
    EmptyDelegation,
};
use super::ranking::build_prompt_plan;

/// Caso negativo de prompting-6: un punto final anulaba las preguntas.
#[test]
fn trailing_punctuation_does_not_hide_a_vague_prompt() {
    for prompt in [
        "arregla esto",
        "arregla esto.",
        "arregla esto...",
        "¿arregla esto?",
    ] {
        let plan = build_prompt_plan(prompt, "bug_fix");
        assert_eq!(
            plan.clarifying_questions.len(),
            3,
            "«{prompt}» es vago y debe generar preguntas"
        );
    }
}

#[test]
fn real_references_still_count_as_concrete() {
    for prompt in [
        "arregla kanban.rs",
        "arregla src/kanban",
        "corrige run_batch ya",
        "arregla la linea 120",
        "revisa C:\\ruta\\fichero",
    ] {
        let plan = build_prompt_plan(prompt, "bug_fix");
        assert!(
            plan.clarifying_questions.is_empty(),
            "«{prompt}» tiene referencia concreta: {:?}",
            plan.clarifying_questions
        );
    }
}

/// Una versión («2.1.3») no es una lista numerada: no sube el modo.
#[test]
fn a_version_number_is_not_a_multi_step_list() {
    let plan = build_prompt_plan("actualiza la dependencia a la versión 2.1.3", "feature");
    assert_eq!(plan.suggested_mode, "medium");
    let listed = build_prompt_plan(
        "haz esto: 1. renombra la tabla 2. ajusta el seed",
        "feature",
    );
    assert_eq!(listed.suggested_mode, "high");
    let connected = build_prompt_plan("compila y luego despliega", "feature");
    assert_eq!(connected.suggested_mode, "high");
}

#[test]
fn dense_is_only_effective_with_the_global_switch_on() {
    assert!(effective_dense(true, true));
    assert!(!effective_dense(true, false));
    assert!(!effective_dense(false, true));
}

/// Caso negativo: en modo sparse (el `--sparse` del CLI o el denso apagado)
/// no hay re-rank aunque la ruta lo pidiera; antes se lanzaba el calentamiento
/// del cross-encoder.
#[test]
fn sparse_never_reranks_even_if_the_route_asks() {
    assert!(rerank_for_turn(true, true));
    assert!(!rerank_for_turn(false, true));
    assert!(!rerank_for_turn(true, false));
    assert!(!rerank_for_turn(false, false));
}

/// Caso negativo de prompting-7: con ULTRON_DENSE=0 el Preview caía en la rama
/// «catalog vacío», lanzaba un reindex condenado a fallar y recomendaba
/// `ultron-memory.exe catalog`.
#[test]
fn dense_off_is_not_reported_as_an_empty_catalog() {
    assert_eq!(
        classify_empty_delegation(true, false, true),
        EmptyDelegation::DenseOff
    );
    assert_eq!(
        classify_empty_delegation(false, false, true),
        EmptyDelegation::Sparse
    );
    assert_eq!(
        classify_empty_delegation(true, true, true),
        EmptyDelegation::CatalogEmpty
    );
    assert_eq!(
        classify_empty_delegation(true, true, false),
        EmptyDelegation::Abstained
    );
}

#[test]
fn dense_off_replaces_the_e5_unavailable_warning() {
    let raw = vec![
        "dense recall empty — E5/Qdrant unavailable; sparse-only".to_string(),
        "otro aviso".to_string(),
    ];
    let off = honest_recall_warnings(raw.clone(), true, false);
    assert!(
        off.iter().all(|w| !w.contains("E5/Qdrant unavailable")),
        "{off:?}"
    );
    assert!(off.iter().any(|w| w.contains("ULTRON_DENSE=0")), "{off:?}");
    assert!(off.iter().any(|w| w == "otro aviso"));
    // Con el denso activo, un vacío denso sí es una avería y se conserva.
    assert_eq!(honest_recall_warnings(raw.clone(), true, true), raw);
}
