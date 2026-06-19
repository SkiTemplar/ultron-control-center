// orchestrator/ranking.rs — agent/skill re-ranking and prompt plan building.

use crate::memory::catalog;

use super::rules::preferred_skills;
use super::types_model::{AgentChoice, PromptPlan, SkillChoice, StepPlan};

/// ULTRON-internal META agents. They are housekeeping/self-improvement helpers
/// (refresh docs, compose changelog, behaviour-preserving refactor, compress
/// context, etc.), NOT task specialists. The semantic index over-weights them
/// because their descriptions are generic, so the delegate ranking used to put
/// `ultron-docs`/`ultron-changelog`/`ultron-refactor` above real specialists
/// like `debugger` or `code-reviewer`. We demote them unless the prompt is
/// explicitly about that meta task (handled via the intent boost below).
const META_AGENTS: &[&str] = &[
    "ultron-changelog",
    "ultron-context",
    "ultron-docs",
    "ultron-metadata",
    "ultron-news",
    "ultron-refactor",
    "ultron-self-improve",
    "ultron-skill-editor",
    "ultron-test",
];

/// Generic "catch-all" agents whose broad descriptions match almost ANY prompt,
/// so the raw semantic score crowds out the real domain specialist. The
/// independent verifier found code-reviewer/qa-expert/architect-reviewer ranking
/// ~1.0 over postgres-pro/swift-expert/terraform-engineer (~0.84) across mobile,
/// db, ios, android, go, cloud, data, graphql, etc. Demoted like meta agents
/// UNLESS the detected intent explicitly prefers them (e.g. code-reviewer for a
/// review/security/testing prompt, debugger for bug_fix). This scales to ALL ~78
/// agents without enumerating each domain: the specialist the retrieval already
/// surfaced simply stops being buried.
const GENERIC_AGENTS: &[&str] = &[
    "code-reviewer",
    "qa-expert",
    "architect-reviewer",
    "debugger",
    "error-detective",
];

/// Multiplicative penalty applied to META agents during delegate ranking.
const META_PENALTY: f32 = 0.55;
/// Multiplicative penalty for GENERIC agents that the intent does not prefer.
const GENERIC_PENALTY: f32 = 0.60;
/// Additive boost applied to agents the detected intent/workflow prefers.
pub(super) const SPECIALIST_BOOST: f32 = 0.20;
/// Floor score for a preferred specialist that E5 retrieval MISSED entirely
/// (cross-lingual noise). Just above the ~0.78-0.81 noise ceiling so that, once
/// the +SPECIALIST_BOOST is applied, it ranks above irrelevant retrieved agents
/// but below specialists that were genuinely retrieved with a real high score.
pub(super) const PREFERRED_FLOOR: f32 = 0.80;

/// Specialist agent names the detected `intent` should prioritise. These are
/// REAL agents in `~/.claude/agents` (verified). The boost lifts them above the
/// meta agents when the prompt clearly belongs to their domain.
pub(super) fn preferred_specialists(intent: &str) -> &'static [&'static str] {
    match intent {
        "security" => &[
            "security-auditor",
            "penetration-tester",
            "ultron-security",
            "code-reviewer",
        ],
        "bug_fix" => &["debugger", "error-detective", "qa-expert"],
        "performance" => &["performance-engineer", "ultron-perf", "debugger"],
        "testing" => &["test-automator", "qa-expert", "code-reviewer"],
        // NOTE: 'ui-designer' is a SKILL, not an agent on disk — it used to sit
        // here as a dead ref (boost impossible). Real UI agents only; the
        // ui-designer/mike-tyson SKILLS now compete via the skill read-path.
        "ui_design" => &[
            "frontend-developer",
            "react-specialist",
            "accessibility-tester",
            "mobile-developer",
        ],
        "devops" => &[
            "devops-engineer",
            "deployment-engineer",
            "kubernetes-specialist",
            "docker-expert",
        ],
        "docs" => &["documentation-engineer", "ultron-docs"],
        "refactor" => &["refactoring-specialist", "ultron-refactor", "code-reviewer"],
        "architecture_review" => &[
            "architect-reviewer",
            "microservices-architect",
            "cloud-architect",
            "ultron-arch",
        ],
        "feature" => &["architect-reviewer", "fullstack-developer", "code-reviewer"],
        "research" => &["ai-engineer", "llm-architect", "architect-reviewer"],
        "game" => &["unreal-engine-engineer", "cpp-pro", "architect-reviewer"],
        // Language / framework / infra domains — verifier found these buried
        // under generic agents. Floor-injected + boosted so they win their domain.
        "database" => &["postgres-pro", "sql-pro", "database-administrator"],
        "mobile" => &["mobile-developer", "react-specialist"],
        "ios" => &["swift-expert", "mobile-developer"],
        "android" => &["kotlin-specialist", "mobile-developer"],
        "golang" => &["golang-pro", "backend-developer"],
        "csharp" => &["csharp-developer", "backend-developer"],
        "rust" => &["rust-engineer", "cpp-pro"],
        "python" => &["python-pro", "backend-developer"],
        "typescript" => &["typescript-pro", "javascript-pro", "frontend-developer"],
        "cloud_infra" => &[
            "terraform-engineer",
            "cloud-architect",
            "kubernetes-specialist",
        ],
        "ml" => &["ml-engineer", "mlops-engineer", "ai-engineer"],
        "data_eng" => &["data-engineer", "database-administrator"],
        "websocket" => &["websocket-engineer", "backend-developer"],
        "electron" => &["electron-pro", "frontend-developer"],
        "nextjs" => &["nextjs-developer", "react-specialist"],
        "api_design" => &[
            "api-designer",
            "backend-developer",
            "microservices-architect",
        ],
        "llm" => &["llm-architect", "ai-engineer", "prompt-engineer"],
        "accessibility" => &["accessibility-tester", "frontend-developer"],
        "docker" => &["docker-expert", "devops-engineer", "kubernetes-specialist"],
        "finance" => &["backend-developer"],
        "business" => &["backend-developer"],
        "writing" => &["documentation-engineer"],
        "learning" => &["llm-architect", "code-reviewer"],
        _ => &["code-reviewer", "qa-expert"],
    }
}

/// Re-rank the raw semantic catalog hits so that real specialists pertinent to
/// the detected `intent` rank above the generic ULTRON-internal meta agents.
///
/// Rules (first-match-wins ordering preserved upstream):
///   - META agents get a multiplicative `META_PENALTY` (demoted)...
///   - ...UNLESS they are also in `preferred_specialists(intent)` (e.g.
///     `ultron-docs` for the `docs` intent), in which case the penalty is
///     waived and they get the boost like any other preferred specialist.
///   - Any preferred specialist gets an additive `SPECIALIST_BOOST`.
///
/// Then sort by adjusted score (desc) and keep the top `keep`.
pub(super) fn rebalance_delegates(
    hits: Vec<catalog::CatalogHit>,
    intent: &str,
    keep: usize,
) -> Vec<AgentChoice> {
    let preferred = preferred_specialists(intent);
    let mut scored: Vec<AgentChoice> = hits
        .into_iter()
        .map(|h| {
            let is_preferred = preferred.iter().any(|p| *p == h.name);
            let is_meta = META_AGENTS.contains(&h.name.as_str());
            let is_generic = GENERIC_AGENTS.contains(&h.name.as_str());
            let mut score = h.score;
            // Demote meta agents that are not pertinent to this intent.
            if is_meta && !is_preferred {
                score *= META_PENALTY;
            }
            // Demote generic catch-all agents the intent doesn't prefer, so the
            // real domain specialist (already retrieved) is no longer buried.
            if is_generic && !is_preferred {
                score *= GENERIC_PENALTY;
            }
            // Boost specialists this intent prefers.
            if is_preferred {
                score += SPECIALIST_BOOST;
            }
            AgentChoice {
                name: h.name,
                description: h.description,
                score,
            }
        })
        .collect();
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored.truncate(keep);
    scored
}

/// Embedding noise floor — multilingual E5 scores for irrelevant catalog entries
/// cluster around 0.78-0.81 (measured). Skills at or below this are dropped so
/// the assistant only sees pertinent ones (an empty skill list is valid).
const NOISE_FLOOR: f32 = 0.80;

/// Guarantee the intent's preferred specialists enter the rebalance pool even
/// when E5 retrieval (cross-lingual ES-prompt vs EN-description noise) failed to
/// surface them in the raw top-k. Without this the +SPECIALIST_BOOST is
/// decorative — it can only lift already-retrieved agents. Any preferred agent
/// that exists on disk but is missing from `hits` is injected at PREFERRED_FLOOR
/// so the downstream boost ranks it. This is the core fix for the UI/testing
/// 0/3 routing failures (the right agent never made the top-12 retrieval).
pub(super) fn inject_preferred_floor(
    mut hits: Vec<catalog::CatalogHit>,
    intent: &str,
) -> Vec<catalog::CatalogHit> {
    let preferred = preferred_specialists(intent);
    let present: std::collections::HashSet<String> = hits.iter().map(|h| h.name.clone()).collect();
    let known = catalog::known_agent_names();
    for name in preferred {
        if !present.contains(*name) && known.contains(*name) {
            hits.push(catalog::CatalogHit {
                entity: "agent".into(),
                name: (*name).to_string(),
                description: catalog::agent_description(name).unwrap_or_default(),
                score: PREFERRED_FLOOR,
                kind: String::new(),
            });
        }
    }
    hits
}

/// Rank skill hits and keep the top `keep` above the noise floor. Skills arrive
/// pre-sorted by semantic score from Qdrant; we drop sub-floor noise so a prompt
/// with no pertinent skill yields an empty list rather than fake suggestions.
pub(super) fn rank_skills(
    hits: Vec<catalog::CatalogHit>,
    intent: &str,
    keep: usize,
) -> Vec<SkillChoice> {
    let preferred = preferred_skills(intent);
    let mut skills: Vec<SkillChoice> = hits
        .into_iter()
        .filter(|h| h.score > NOISE_FLOOR || preferred.contains(&h.name.as_str()))
        .map(|h| {
            let mut score = h.score;
            if preferred.contains(&h.name.as_str()) {
                score += SPECIALIST_BOOST;
            }
            SkillChoice {
                name: h.name,
                description: h.description,
                kind: h.kind,
                score,
            }
        })
        .collect();
    // Floor-inject the intent's preferred persona/domain skills the retrieval
    // missed, so e.g. tio-gilito wins a finance prompt even if E5 buried it.
    let present: std::collections::HashSet<String> =
        skills.iter().map(|s| s.name.clone()).collect();
    for name in preferred {
        if !present.contains(*name) {
            skills.push(SkillChoice {
                name: (*name).to_string(),
                description: String::new(),
                kind: "persona".to_string(),
                score: PREFERRED_FLOOR + SPECIALIST_BOOST,
            });
        }
    }
    skills.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    skills.truncate(keep);
    skills
}

/// Build the orchestration context for a prompt. Pure read — writes no memory.
/// Paso de mejora de prompt (cat13). Determinista y rapido: clasifica la
/// vaguedad, sugiere el modo ULTRON y reescribe el prompt con el encuadre de
/// trabajo del intent. El texto original SIEMPRE va incluido literal — el
/// feedback del usuario es el entregable, la mejora solo lo enmarca.
pub fn build_prompt_plan(prompt: &str, intent: &str) -> PromptPlan {
    let p = prompt.trim();
    let lower = p.to_lowercase();
    let words = p.split_whitespace().count();

    // --- Vaguedad: prompt corto con verbo generico y sin referente concreto ---
    let vague_verbs = [
        "arregla",
        "arreglalo",
        "mejora",
        "mejoralo",
        "corrige",
        "corrigelo",
        "revisa",
        "hazlo",
        "fix",
        "improve",
        "optimiza",
    ];
    let has_vague_verb = vague_verbs.iter().any(|v| lower.contains(v));
    let has_concrete_ref = p.contains('/')
        || p.contains('\\')
        || p.contains('.')
        || p.contains('_')
        || p.chars().any(|c| c.is_ascii_digit());
    let mut clarifying_questions = Vec::new();
    if words <= 5 && has_vague_verb && !has_concrete_ref {
        clarifying_questions.push("¿Que archivo, modulo o pantalla exactamente?".to_string());
        clarifying_questions.push("¿Cual es el comportamiento esperado vs el actual?".to_string());
        clarifying_questions.push("¿Hay un error/log concreto que lo evidencie?".to_string());
    }

    // --- Modo sugerido: escalado por alcance, no por longitud bruta ---
    let big_scope = [
        "todo el repo",
        "toda la app",
        "arquitectura",
        "rediseña",
        "rediseñar",
        "migra",
        "migracion",
        "refactor masivo",
        "entire",
        "whole repo",
        "auditoria",
        "audita",
    ]
    .iter()
    .any(|k| lower.contains(k));
    let multi_step = lower.contains(" y luego ")
        || lower.contains(" despues ")
        || lower.contains("1)")
        || lower.contains("1.");
    let suggested_mode = if big_scope && (multi_step || words > 40) {
        "ultra"
    } else if big_scope || multi_step || matches!(intent, "security" | "performance") {
        "high"
    } else if words <= 4 && matches!(intent, "docs" | "learning" | "general") {
        "low"
    } else {
        "medium"
    }
    .to_string();

    // --- Reescritura con el encuadre del intent (familias) ---
    let (frame, criteria) = intent_frame(intent);

    let improved_prompt = format!("{p}\n\n[encuadre {intent}] {frame}");
    let success_criteria = criteria.iter().map(|s| s.to_string()).collect();

    PromptPlan {
        improved_prompt,
        suggested_mode,
        clarifying_questions,
        success_criteria,
    }
}

/// Public canonical name of the prompt optimizer (cat13.2). Rewrites the prompt
/// with the intent frame + suggested mode + success criteria. `build_prompt_plan`
/// is the historical impl; `optimize_prompt` is the symbol the routing calls so
/// the step "optimize the prompt" is literal and self-documenting.
pub fn optimize_prompt(prompt: &str, intent: &str) -> PromptPlan {
    build_prompt_plan(prompt, intent)
}

/// Work frame + success criteria per intent family. Shared by `optimize_prompt`
/// (whole turn) and `build_step_plans` (per workflow step). The `review` and
/// `architecture_review` frames exist for the per-step roles (code-reviewer /
/// architect-reviewer) even though no top-level RULE routes to them.
pub(super) fn intent_frame(intent: &str) -> (&'static str, &'static [&'static str]) {
    match intent {
        "bug_fix" | "debug" => (
            "Diagnostica y corrige. Reproduce el fallo ANTES de tocar codigo; identifica la causa raiz, no el sintoma; añade un test que falle sin el fix (caso negativo); verifica en runtime.",
            &["el fallo reproducido deja de ocurrir", "test de regresion en verde", "0 cambios fuera del alcance del bug"],
        ),
        "feature" => (
            "Implementa la feature. Antes de codear: localiza patrones existentes (codegraph/grep) y reusa; define el corte minimo; tests primero; cablea backend Y consumidor UI (nada sin punto de consumo).",
            &["build verde (cargo/tsc/tests)", "la feature tiene consumidor real, no solo comando registrado", "docs actualizadas si cambia el contrato"],
        ),
        "security" => (
            "Auditoria de seguridad. OWASP, secretos hardcodeados, validacion de input en limites, inyeccion; evidencia archivo:linea + severidad; confirma cada hallazgo en runtime antes de parchear.",
            &["0 CRITICAL sin resolver", "cada hallazgo con evidencia verificable", "secretos expuestos rotados"],
        ),
        "review" => (
            "Revisa el codigo: correctitud, seguridad, legibilidad, manejo de errores y cobertura. Marca severidad (CRITICAL/HIGH/MEDIUM/LOW) con evidencia archivo:linea; no apruebes con CRITICAL/HIGH abiertos.",
            &["0 CRITICAL/HIGH sin resolver", "cada hallazgo con evidencia archivo:linea"],
        ),
        "architecture_review" => (
            "Evalua el diseno: limites de modulo, acoplamiento/cohesion, SOLID, complejidad ciclomatica. Propon el cambio minimo que reduce el acoplamiento sin reescribir; justifica con trade-offs.",
            &["decision con trade-offs explicitos", "sin reescritura masiva injustificada"],
        ),
        "research" => (
            "Investiga. Busca implementaciones existentes primero (GitHub, registries, docs primarias); compara >=3 alternativas con criterios explicitos; cierra con recomendacion y trade-offs.",
            &["fuentes citadas y verificables", "comparativa con criterios, no opiniones", "recomendacion accionable"],
        ),
        "learning" => (
            "Explica a nivel ingeniero, con un ejemplo minimo ejecutable y los gotchas especificos del proyecto si aplican.",
            &["el ejemplo compila/corre", "sin afirmaciones no verificadas"],
        ),
        "testing" => (
            "Escribe tests que cazarian bugs reales (no smoke vacios): caso feliz + bordes + caso negativo; sigue el framework y convenciones del repo.",
            &["tests fallan si se rompe el comportamiento", "suite completa en verde"],
        ),
        "refactor" => (
            "Refactoriza preservando comportamiento: tests verdes antes y despues, diff minimo, sin features nuevas de contrabando.",
            &["mismos tests verdes pre/post", "complejidad/duplicacion reducida medible"],
        ),
        "performance" => (
            "Optimiza con medicion: perfila ANTES, ataca el hot-path evidenciado, mide despues; nada de micro-optimizar sin datos.",
            &["mejora medida con numeros antes/despues", "sin regresion funcional"],
        ),
        "docs" => (
            "Documenta sin mentir: cada afirmacion contrastada con el codigo actual; ejemplos que funcionan; borra lo obsoleto en vez de acumular.",
            &["0 afirmaciones falsas contrastables", "links/comandos verificados"],
        ),
        _ => (
            "Ejecuta con verificacion en runtime: localiza primero (codegraph/grep), cambia lo minimo, verifica el resultado real antes de darlo por hecho.",
            &["resultado verificado en runtime", "build verde"],
        ),
    }
}

/// Map a workflow step's agent to a sub-intent known by `intent_frame`, so each
/// step's prompt is framed for the ROLE that executes it (debugger -> bug_fix,
/// code-reviewer -> review, rust-engineer -> feature, ...).
pub(super) fn agent_sub_intent(agent: &str) -> &'static str {
    match agent {
        "debugger" | "error-detective" => "bug_fix",
        "security-auditor" | "penetration-tester" | "ultron-security" => "security",
        "test-automator" | "qa-expert" => "testing",
        "refactoring-specialist" | "ultron-refactor" => "refactor",
        "performance-engineer" | "ultron-perf" => "performance",
        "documentation-engineer" | "ultron-docs" => "docs",
        "code-reviewer" => "review",
        "architect-reviewer" | "microservices-architect" | "cloud-architect" | "ultron-arch" => {
            "architecture_review"
        }
        a if a.ends_with("-engineer")
            || a.ends_with("-developer")
            || a.ends_with("-pro")
            || a.ends_with("-specialist") =>
        {
            "feature"
        }
        _ => "general",
    }
}

/// cat13.4: build a per-step optimized frame for a multi-step GROUP. Each step
/// (a workflow agent) gets its role's sub-intent frame. Returns empty for fewer
/// than 2 steps — a single step is not a "group", so the turn-level
/// `optimize_prompt` already covers it.
pub(super) fn build_step_plans(steps: &[String]) -> Vec<StepPlan> {
    if steps.len() < 2 {
        return Vec::new();
    }
    steps
        .iter()
        .map(|agent| {
            let sub_intent = agent_sub_intent(agent);
            let (frame, _) = intent_frame(sub_intent);
            StepPlan {
                agent: agent.clone(),
                sub_intent: sub_intent.to_string(),
                frame: frame.to_string(),
            }
        })
        .collect()
}
