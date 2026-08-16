use super::*;

#[test]
fn parses_well_formed_lines_and_skips_noise() {
    let resp = "decision | usar E5 1024d | se eligio E5 sobre bge-m3 por recall\n\
                    NADA\n\
                    basura sin separadores\n\
                    - preference | sin emojis | el usuario no quiere emojis en la UI";
    let facts = parse_facts(resp);
    assert_eq!(facts.len(), 2);
    assert_eq!(facts[0].kind, MemoryType::Decision);
    assert_eq!(facts[0].title, "usar E5 1024d");
    assert_eq!(facts[1].kind, MemoryType::Preference);
}

#[test]
fn unknown_type_defaults_to_fact() {
    let facts = parse_facts("xyz | algo | un detalle");
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0].kind, MemoryType::Fact);
}

#[test]
fn heuristic_always_yields_one() {
    let f = heuristic_facts(&"x".repeat(500));
    assert_eq!(f.len(), 1);
    assert_eq!(f[0].kind, MemoryType::SessionSummary);
}

#[test]
fn parses_optional_trailing_importance_score() {
    // 4-field form carries an LLM score; 3-field form leaves it None.
    let facts = parse_facts(
        "decision | usar E5 | se eligio E5 sobre bge-m3 | 0.9\n\
             fact | algo | un detalle sin score",
    );
    assert_eq!(facts.len(), 2);
    assert_eq!(facts[0].llm_score, Some(0.9));
    assert!(facts[1].llm_score.is_none());
}

#[test]
fn parse_score_handles_common_formats() {
    assert_eq!(parse_score("0.8"), Some(0.8));
    assert_eq!(parse_score("0,8"), Some(0.8));
    assert_eq!(parse_score("80%"), Some(0.8));
    assert_eq!(parse_score("score=0.7"), Some(0.7));
    assert_eq!(parse_score("alto"), None);
    // Out-of-range bare percentages collapse into 0..1.
    assert_eq!(parse_score("90"), Some(0.9));
}

#[test]
fn importance_varies_by_type_not_constant() {
    // The core bug: every candidate used to be 0.55. Distinct types must now
    // yield clearly DIFFERENT importance values.
    let decision = Fact {
        kind: MemoryType::Decision,
        title: "t".into(),
        body: "se decidio migrar a sqlite como source of truth canonico".into(),
        llm_score: None,
    };
    let summary = Fact {
        kind: MemoryType::SessionSummary,
        title: "t".into(),
        body: "hablamos de cosas".into(),
        llm_score: None,
    };
    let imp_decision = derive_importance(&decision, true);
    let imp_summary = derive_importance(&summary, true);
    assert!(
        imp_decision > imp_summary + 0.2,
        "a decision must score clearly higher than a session summary \
             (got decision={imp_decision}, summary={imp_summary})"
    );
    assert_ne!(imp_decision, 0.55, "importance is no longer hardcoded");
}

#[test]
fn llm_score_shifts_importance() {
    let base = Fact {
        kind: MemoryType::Fact,
        title: "t".into(),
        body: "un hecho concreto del proyecto con detalle suficiente".into(),
        llm_score: None,
    };
    let scored = Fact {
        llm_score: Some(0.95),
        ..clone_fact(&base)
    };
    assert!(
        derive_importance(&scored, true) > derive_importance(&base, true),
        "a high LLM score must raise importance vs no score"
    );
}

#[test]
fn confidence_distinct_from_importance_and_provenance_aware() {
    let f = Fact {
        kind: MemoryType::Decision,
        title: "t".into(),
        body: "se decidio usar e5 1024d para recall semantico".into(),
        llm_score: None,
    };
    let conf_router = derive_confidence(&f, true);
    let conf_heuristic = derive_confidence(&f, false);
    assert!(
        conf_router > conf_heuristic,
        "router-extracted facts must be more confident than the local fallback"
    );
    // Confidence and importance must not be the identical constant pair the
    // UI complained about.
    let imp = derive_importance(&f, true);
    assert_ne!(conf_router, imp, "confidence and importance must differ");
    assert!((0.05..=0.95).contains(&conf_router));
}

#[test]
fn factory_threshold_can_auto_approve_top_confidence_capture() {
    // INVARIANTE 1.1 (conductual, cross-module): la confianza MÁXIMA que el
    // write-path de captura puede emitir —router + `llm_score = 1.0`, cuerpo
    // no trivial, tipo auto-aprobable— DEBE caer en BAND A bajo la config de
    // FÁBRICA. Si el umbral de fábrica supera el techo de `derive_confidence`,
    // el auto-approve es código MUERTO para captura conversacional (todo fact
    // del Stop-hook se queda en el inbox por más limpio y seguro que sea — el
    // bug que cierra 1.1). El test falla con el viejo umbral 0.85 (0.762 < 0.85
    // → Pending) y pasa con el umbral alcanzable.
    use super::super::auto_approve::{classify_band, AutoBand, DEFAULT_AUTO_APPROVE_THRESHOLD};
    let top = Fact {
        kind: MemoryType::Fact,
        title: "t".into(),
        body: "un hecho concreto y verificable del proyecto con detalle suficiente".into(),
        llm_score: Some(1.0),
    };
    // Techo REAL del path de captura (no un número mágico): se ata el test a la
    // función productora, así que subir el umbral por encima de este techo lo rompe.
    let ceiling = derive_confidence(&top, true);
    assert!(
        ceiling < 0.85,
        "premisa del bug: el techo de captura ({ceiling:.3}) queda bajo el viejo umbral 0.85"
    );
    let mut cand = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
    cand.confidence = ceiling;
    assert_eq!(
            classify_band(&cand, DEFAULT_AUTO_APPROVE_THRESHOLD),
            AutoBand::Approve,
            "la config de fábrica DEBE poder auto-aprobar el fact de máxima confianza del \
             path de captura (conf={ceiling:.3} vs umbral de fábrica {DEFAULT_AUTO_APPROVE_THRESHOLD})"
        );
}

#[test]
fn prompt_offers_user_profile_type() {
    // 1.4: el extractor SOLO puede emitir tipos que el prompt le ofrece. Para que
    // `user_profile` deje de ser una categoría vacía-sin-productor, el prompt debe
    // ofrecerla (el parser ya la mapea). ROJO si el prompt no la lista.
    let p = extraction_prompt("una sesion de prueba con suficiente contenido para no truncar");
    assert!(
        p.contains("user_profile"),
        "el extraction_prompt debe ofrecer user_profile como tipo capturable"
    );
    // Regresión 1.4: los tipos retirados NO deben reaparecer ofrecidos en el prompt.
    assert!(
        !p.contains("tool_usage"),
        "tool_usage retirado: el prompt no debe ofrecerlo"
    );
    assert!(
        !p.contains("workflow_state"),
        "workflow_state retirado: el prompt no debe ofrecerlo"
    );
}

#[test]
fn retired_memory_types_no_longer_parse() {
    // 1.4: `tool_usage` y `workflow_state` se retiran (sin productor). El parser de
    // captura ya no debe reconocerlos como MemoryType. ROJO mientras sigan en el enum.
    assert!(
        MemoryType::parse("tool_usage").is_none(),
        "tool_usage retirado"
    );
    assert!(
        MemoryType::parse("workflow_state").is_none(),
        "workflow_state retirado"
    );
    // Sanidad: los tipos CONSERVADOS siguen parseando (skill/architecture tienen productor).
    assert!(MemoryType::parse("user_profile").is_some());
    assert!(MemoryType::parse("skill").is_some());
    assert!(MemoryType::parse("architecture").is_some());
}

#[test]
fn fact_to_candidate_stamps_source_session_id() {
    // Provenance episódica: el candidate DEBE llevar la sesión de origen para
    // que `provenance --id` pueda resolver el transcript real en disco.
    let f = Fact {
        kind: MemoryType::Decision,
        title: "t".into(),
        body: "se decidio estampar provenance episodica en la captura".into(),
        llm_score: None,
    };
    let c = fact_to_candidate(
        f,
        Scope::Project,
        Some("ultron"),
        true,
        Some("1a333f26-abcd-4e5f"),
    );
    assert_eq!(c.source_session_id.as_deref(), Some("1a333f26-abcd-4e5f"));
    assert!(c.proposed_summary.is_some());
}

#[test]
fn fact_to_candidate_stamps_project_field_and_tag() {
    // Atribucion (fix 2026-08-11): scope=Project DEBE llevar el proyecto en
    // el campo Y en el tag `project:<id>` (unico superviviente del
    // round-trip SQLite del inbox — ver to_item). Antes ambos quedaban
    // vacios y el item promovido salia con project_id=null.
    let f = Fact {
        kind: MemoryType::Decision,
        title: "t".into(),
        body: "se decidio prohibir capturas de proyecto sin project_id".into(),
        llm_score: None,
    };
    let c = fact_to_candidate(f, Scope::Project, Some("ultron"), true, None);
    assert_eq!(c.proposed_project_id.as_deref(), Some("ultron"));
    assert!(
        c.proposed_tags.iter().any(|t| t == "project:ultron"),
        "el tag project:<id> debe sobrevivir el round-trip; tags: {:?}",
        c.proposed_tags
    );
    // Caso negativo: sin proyecto (o en blanco) NO se inventa atribucion.
    let f2 = Fact {
        kind: MemoryType::Fact,
        title: "t".into(),
        body: "hecho sin proyecto conocido".into(),
        llm_score: None,
    };
    let c2 = fact_to_candidate(f2, Scope::Session, Some("  "), false, None);
    assert_eq!(c2.proposed_project_id, None);
    assert!(!c2.proposed_tags.iter().any(|t| t.starts_with("project:")));
}

#[test]
fn scope_for_fact_routes_user_owned_kinds_to_global() {
    // Positivos: lo que es del USUARIO viaja (Global), con o sin proyecto.
    assert_eq!(scope_for_fact(MemoryType::Preference, true), Scope::Global);
    assert_eq!(scope_for_fact(MemoryType::UserProfile, true), Scope::Global);
    assert_eq!(scope_for_fact(MemoryType::Preference, false), Scope::Global);
    // Negativos: lo del proyecto se queda en el proyecto (o Session).
    assert_eq!(scope_for_fact(MemoryType::Decision, true), Scope::Project);
    assert_eq!(scope_for_fact(MemoryType::Constraint, true), Scope::Project);
    assert_eq!(scope_for_fact(MemoryType::Fact, false), Scope::Session);
}

#[test]
fn preference_and_profile_scope_global_without_project() {
    // (decidido 2026-08-12) Las preferencias/perfil del usuario viajan a
    // todos los proyectos: scope Global y SIN project (ni campo ni tag).
    // Caso negativo: una decision del mismo capture sigue atada al proyecto.
    let pref = Fact {
        kind: MemoryType::Preference,
        title: "t".into(),
        body: "el usuario prefiere respuestas concisas sin preambulos".into(),
        llm_score: None,
    };
    let c = fact_to_candidate(pref, Scope::Global, None, true, None);
    assert_eq!(c.proposed_scope, Scope::Global);
    assert_eq!(c.proposed_project_id, None);
    assert!(!c.proposed_tags.iter().any(|t| t.starts_with("project:")));

    let dec = Fact {
        kind: MemoryType::Decision,
        title: "t".into(),
        body: "se decidio usar sqlite con wal en el modulo x".into(),
        llm_score: None,
    };
    let c2 = fact_to_candidate(dec, Scope::Project, Some("ultron"), true, None);
    assert_eq!(c2.proposed_scope, Scope::Project);
    assert_eq!(c2.proposed_project_id.as_deref(), Some("ultron"));
}

#[test]
fn discard_reason_drops_echo_and_low_importance_keeps_decisions() {
    // Caso eco: progreso que git/kanban ya registran -> fuera, aunque el
    // kind sea decision e importance alta.
    let echo = Fact {
        kind: MemoryType::Decision,
        title: "Estructura v0.6".into(),
        body: "Se ha implementado la estructura de codigo para la version 0.6".into(),
        llm_score: Some(0.8),
    };
    let imp_echo = derive_importance(&echo, true);
    assert!(
        discard_reason(&echo, imp_echo).is_some_and(|r| r.starts_with("echo:")),
        "el eco de estado debe descartarse"
    );

    // Casos REALES que esquivaron la v1 por frases exactas (e2e 2026-08-11):
    // el LLM parafrasea a pasiva/estado — el regex morfologico los caza.
    let paraphrased = Fact {
        kind: MemoryType::Fact,
        title: "Estructura de código".into(),
        body: "La estructura de código para la versión 0.9 ha sido implementada con éxito".into(),
        llm_score: Some(0.7),
    };
    let imp_p = derive_importance(&paraphrased, true);
    assert!(
        discard_reason(&paraphrased, imp_p).is_some_and(|r| r == "echo:aux_participio"),
        "la pasiva parafraseada debe descartarse"
    );
    let ci_state = Fact {
        kind: MemoryType::Fact,
        title: "Estado de testing".into(),
        body: "Los tests para la versión 0.9 están verdes, indicando éxito en la implementación"
            .into(),
        llm_score: Some(0.7),
    };
    let imp_c = derive_importance(&ci_state, true);
    assert!(
        discard_reason(&ci_state, imp_c).is_some_and(|r| r == "echo:tests_verdes"),
        "el estado de CI parafraseado debe descartarse"
    );

    // Caso legitimo: una decision real con verbo de accion NO es eco
    // ("se ha decidido" no esta en la lista a proposito).
    let real = Fact {
        kind: MemoryType::Decision,
        title: "Umbral capture".into(),
        body: "Se ha decidido implementar el filtro de trivialidad con umbral 0.45".into(),
        llm_score: Some(0.9),
    };
    let imp_real = derive_importance(&real, true);
    assert_eq!(discard_reason(&real, imp_real), None);

    // Caso baja importancia: el summary heuristico (cola de transcript)
    // cae bajo el floor y se descarta con la razon low_importance.
    let noise = heuristic_facts("relleno de sesion sin nada duradero que rescatar aqui");
    let f = &noise[0];
    let imp = derive_importance(f, false);
    assert!(imp < MIN_IMPORTANCE, "sanidad de calibracion: {imp}");
    assert!(
        discard_reason(f, imp).is_some_and(|r| r.starts_with("low_importance:")),
        "bajo el floor debe descartarse"
    );
}

#[test]
fn fact_to_candidate_without_session_leaves_no_origin() {
    // Caso negativo: sin sesión (o en blanco) NO se inventa origen — el item
    // queda honesto como no-episódico (`provenance` reporta episodic=false).
    let mk = |sid: Option<&str>| {
        fact_to_candidate(
            Fact {
                kind: MemoryType::Fact,
                title: "t".into(),
                body: "un hecho sin sesion de origen conocida".into(),
                llm_score: None,
            },
            Scope::Session,
            None,
            false,
            sid,
        )
    };
    assert_eq!(mk(None).source_session_id, None);
    assert_eq!(mk(Some("   ")).source_session_id, None);
}

// Small helper: Fact is a private test-local struct without Clone.
fn clone_fact(f: &Fact) -> Fact {
    Fact {
        kind: f.kind,
        title: f.title.clone(),
        body: f.body.clone(),
        llm_score: f.llm_score,
    }
}
