// orchestrator/tests.rs — unit tests for orchestrator module.

use crate::memory::catalog;

use super::orchestrate::orchestrate;
use super::ranking::{
    agent_sub_intent, build_prompt_plan, build_step_plans, optimize_prompt, rebalance_delegates,
};
use super::rules::{classify_intent, detect_cross_project};

/// cat13 2026-06-10 — el paso de mejora de prompt: vago -> preguntas;
/// concreto -> sin preguntas (caso negativo); el texto original SIEMPRE
/// va literal dentro del prompt mejorado; el modo escala por alcance.
#[test]
fn prompt_plan_improves_vague_and_respects_concrete() {
    // Prompt vago: preguntas de clarificacion + encuadre.
    let vague = build_prompt_plan("arregla esto", "bug_fix");
    assert!(
        !vague.clarifying_questions.is_empty(),
        "prompt vago debe generar preguntas"
    );
    assert!(
        vague.improved_prompt.starts_with("arregla esto"),
        "el texto literal del usuario abre el prompt mejorado"
    );
    assert!(vague.improved_prompt.contains("[encuadre bug_fix]"));
    assert!(!vague.success_criteria.is_empty());

    // Caso negativo: prompt concreto NO genera preguntas.
    let concrete = build_prompt_plan(
        "corrige el parse de kanban.json en kanban.rs linea 120",
        "bug_fix",
    );
    assert!(
        concrete.clarifying_questions.is_empty(),
        "prompt concreto no debe generar preguntas"
    );

    // Escalado de modo por alcance.
    assert_eq!(
        build_prompt_plan(
            "audita la arquitectura de todo el repo y luego propon fases",
            "security"
        )
        .suggested_mode,
        "ultra"
    );
    assert_eq!(
        build_prompt_plan("revisa la seguridad del endpoint de login", "security").suggested_mode,
        "high"
    );
    assert_eq!(
        build_prompt_plan("añade un boton de refresco al panel Git", "feature").suggested_mode,
        "medium"
    );
}

#[test]
fn classifies_vague_prompts_to_workflows() {
    assert_eq!(classify_intent("arregla el bug de login").1, "debug");
    assert_eq!(
        classify_intent("revisa la seguridad del endpoint").1,
        "security"
    );
    assert_eq!(
        classify_intent("implementa una feature de export").1,
        "feature"
    );
    assert_eq!(
        classify_intent("investiga opciones de embeddings").1,
        "research"
    );
    assert_eq!(
        classify_intent("explícame cómo funciona Qdrant").1,
        "learning"
    );
    assert_eq!(classify_intent("sigue con esto").1, "quick");
    assert_eq!(classify_intent("lanza el orquestador").0, "continue");
    assert_eq!(classify_intent("algo totalmente ambiguo xyz").0, "general");
}

#[test]
fn detect_cross_project_fires_only_on_other_project_phrases() {
    // Positive — bilingual phrases referencing another / all projects.
    assert!(detect_cross_project(
        "¿te acuerdas de aquel proyecto del banco?"
    ));
    assert!(detect_cross_project("busca en otro proyecto"));
    assert!(detect_cross_project("mira en todos mis proyectos"));
    assert!(detect_cross_project(
        "what did we decide in the other project?"
    ));
    assert!(detect_cross_project("search across projects please"));
    assert!(detect_cross_project(
        "anything in any project about finanzas"
    ));
    // Negative — in-project work must NOT trigger whole-brain recall.
    assert!(!detect_cross_project("arregla el bug de este proyecto"));
    assert!(!detect_cross_project("sigue con la feature de export"));
    assert!(!detect_cross_project("optimiza esta consulta"));
    assert!(!detect_cross_project("proyecto")); // bare word does not fire
}

#[test]
fn classifies_new_intents_ui_test_perf_docs_refactor() {
    // UI / design -> feature flow
    assert_eq!(
        classify_intent("diseña la interfaz del dashboard"),
        ("ui_design", "feature")
    );
    assert_eq!(
        classify_intent("crea un componente responsive con tailwind"),
        ("ui_design", "feature")
    );
    // Testing -> quick flow
    assert_eq!(
        classify_intent("escribe tests unitarios para el parser"),
        ("testing", "quick")
    );
    assert_eq!(
        classify_intent("falta cobertura en este modulo"),
        ("testing", "quick")
    );
    // Performance -> debug flow
    assert_eq!(
        classify_intent("optimiza esta consulta, va lento"),
        ("performance", "debug")
    );
    assert_eq!(
        classify_intent("hay un cuello de botella en el render"),
        ("performance", "debug")
    );
    // Docs -> quick flow
    assert_eq!(
        classify_intent("documenta esta API en el readme"),
        ("docs", "quick")
    );
    // Refactor -> quick flow
    assert_eq!(
        classify_intent("refactoriza este modulo sin cambiar comportamiento"),
        ("refactor", "quick")
    );
}

#[test]
fn rebalance_demotes_meta_and_boosts_specialists() {
    // Meta agent ranks first by raw semantic score; the pertinent specialist
    // is below it. After rebalancing for the `bug_fix` intent, `debugger`
    // (a preferred specialist) must outrank `ultron-refactor` (a meta agent
    // not pertinent to this intent).
    let hits = vec![
        catalog::CatalogHit {
            entity: "agent".into(),
            name: "ultron-refactor".into(),
            description: "meta refactor".into(),
            score: 0.90,
            kind: String::new(),
        },
        catalog::CatalogHit {
            entity: "agent".into(),
            name: "debugger".into(),
            description: "systematic debugging".into(),
            score: 0.80,
            kind: String::new(),
        },
    ];
    let ranked = rebalance_delegates(hits, "bug_fix", 5);
    assert_eq!(
        ranked[0].name, "debugger",
        "preferred specialist must outrank a non-pertinent meta agent"
    );
    assert_eq!(ranked[1].name, "ultron-refactor");
    // ultron-refactor demoted: 0.90 * META_PENALTY < 0.90
    assert!(ranked[1].score < 0.90);
}

#[test]
fn rebalance_waives_penalty_for_pertinent_meta() {
    // For the `docs` intent, `ultron-docs` IS a preferred specialist, so it
    // must NOT be penalised — it should be boosted instead.
    let hits = vec![catalog::CatalogHit {
        entity: "agent".into(),
        name: "ultron-docs".into(),
        description: "refresh docs".into(),
        score: 0.50,
        kind: String::new(),
    }];
    let ranked = rebalance_delegates(hits, "docs", 5);
    assert_eq!(ranked[0].name, "ultron-docs");
    assert!(
        ranked[0].score > 0.50,
        "pertinent meta agent should be boosted, not penalised"
    );
}

// Real e2e: needs ultron_catalog + ultron_memory indexed (run after the
// catalog + memory e2e). Run: cargo test --lib -- --ignored --nocapture e2e_orchestrate
#[test]
#[ignore = "e2e: real catalog + memory + E5"]
fn e2e_orchestrate_real() {
    let ctx = orchestrate(
        "revisa el código en busca de fallos de seguridad",
        Some("ultron"),
        true, // e2e: exercise the full semantic catalog (E5) + hybrid recall
    );
    eprintln!("\n=== ORCHESTRATE route={} ===", ctx.route);
    eprintln!("workflow: {:?}", ctx.workflow.as_ref().map(|w| &w.id));
    eprintln!("delegate agents:");
    for a in &ctx.delegate_agents {
        eprintln!("  [{:.3}] {}", a.score, a.name);
    }
    eprintln!("memories injected: {}", ctx.memories.len());
    for w in &ctx.warnings {
        eprintln!("  warn: {w}");
    }
    assert_eq!(ctx.route, "security");
    assert!(ctx.workflow.is_some(), "a workflow must be selected");
    assert!(
        !ctx.delegate_agents.is_empty(),
        "agents to delegate must be found"
    );
    assert!(
        ctx.delegate_agents
            .iter()
            .take(5)
            .any(|a| a.name.contains("security")
                || a.name.contains("review")
                || a.name.contains("pentest")),
        "a security/review specialist should be selected"
    );
}

/// cat13.4 — the routing proposes a GROUP and optimizes the prompt of each step
/// by the role sub-intent of the agent that runs it; a single step is not a group
/// (caso negativo); optimize_prompt is the canonical alias (cat13.2).
#[test]
fn step_plans_optimize_each_group_step_by_role() {
    assert_eq!(agent_sub_intent("debugger"), "bug_fix");
    assert_eq!(agent_sub_intent("code-reviewer"), "review");
    assert_eq!(agent_sub_intent("rust-engineer"), "feature");
    assert_eq!(agent_sub_intent("security-auditor"), "security");
    assert_eq!(
        agent_sub_intent("architect-reviewer"),
        "architecture_review"
    );

    let steps = vec![
        "architect-reviewer".to_string(),
        "rust-engineer".to_string(),
        "code-reviewer".to_string(),
    ];
    let plans = build_step_plans(&steps);
    assert_eq!(plans.len(), 3, "one plan per group step");
    assert_eq!(plans[0].sub_intent, "architecture_review");
    assert_eq!(plans[1].sub_intent, "feature");
    assert_eq!(plans[2].sub_intent, "review");
    assert_ne!(
        plans[1].frame, plans[2].frame,
        "each step frame is role-specific, not the global turn frame"
    );
    assert!(plans.iter().all(|p| !p.frame.is_empty()));

    // Caso negativo: a single-step / empty workflow is NOT a group -> no step plans.
    assert!(build_step_plans(&["rust-engineer".to_string()]).is_empty());
    assert!(build_step_plans(&[]).is_empty());

    // optimize_prompt (cat13.2 literal symbol) == build_prompt_plan.
    let a = optimize_prompt("implementa login con tests", "feature");
    let b = build_prompt_plan("implementa login con tests", "feature");
    assert_eq!(a.improved_prompt, b.improved_prompt);
    assert_eq!(a.suggested_mode, b.suggested_mode);
}
