// orchestrator/tests_prompt_plan.rs — vaguedad y multi-paso (hallazgo
// prompting-6 de la auditoría 2026-10-23).

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
