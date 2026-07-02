// orchestrator/delegation.rs — decisión de delegación automática (plano chat).
//
// Convierte (intent, prompt, top_agent) en una DIRECTIVA imperativa SOLO cuando la
// tarea tiene especialista fuerte Y es no-trivial. El hook la renderiza como orden;
// el agente la ejecuta con la herramienta Agent. NO spawnea nada aquí (eso es plano
// App / delegate_task_inner). Lógica pura, sin red, sin LLM — reproducible y barata.

use serde::Serialize;

use super::types_model::AgentChoice;

/// Intents con especialista fuerte donde un subagente aísla trabajo verboso.
/// Subconjunto de los intents de `ranking::preferred_specialists`; excluye el
/// default `general` (cajón genérico) y los conversacionales (writing/learning/
/// business/finance/ui_design no entran: no amortizan un subagente).
pub const DELEGABLE_INTENTS: &[&str] = &[
    "security",
    "bug_fix",
    "performance",
    "testing",
    "refactor",
    "architecture_review",
    "feature",
    "research",
    "api_design",
    "ml",
    "llm",
    "database",
    "rust",
    "python",
    "typescript",
    "golang",
    "csharp",
    "devops",
    "docker",
    "cloud_infra",
    "data_eng",
];

/// Verbos de acción (es/en) que señalan trabajo real sobre código/sistema. Un
/// prompt sin ninguno casi siempre es pregunta/charla -> no se delega.
const ACTION_VERBS: &[&str] = &[
    "implementa",
    "implement",
    "arregla",
    "fix",
    "refactor",
    "refactoriza",
    "revisa",
    "review",
    "audita",
    "audit",
    "añade",
    "agrega",
    "add",
    "optimiza",
    "optimize",
    "testea",
    "test",
    "migra",
    "migrate",
    "diseña",
    "design",
    "crea",
    "build",
    "depura",
    "debug",
    "analiza",
    "analyze",
    "integra",
    "integrate",
    "cablea",
    "wire",
    "soluciona",
    "resuelve",
];

/// Mínimo de palabras para considerar una tarea no-trivial. Calibrable.
const MIN_WORDS: usize = 6;

/// Formato de retorno exigido al subagente — lo que hace REAL el ahorro de
/// contexto: resumen compacto, nunca volcado de archivos.
const RETURN_FORMAT: &str = "Resumen <=400 tokens: hallazgos / decision / archivos tocados. \
NO vuelques archivos completos, diffs largos ni logs.";

/// La directiva imperativa de delegación inyectada al contexto del chat.
#[derive(Debug, Clone, Serialize)]
pub struct DelegationDirective {
    /// Especialista real (top de `delegate_agents`).
    pub agent: String,
    /// Tarea reformulada para el subagente (el `improved_prompt` ya optimizado).
    pub objective: String,
    /// Formato de salida exigido (resumen compacto).
    pub return_format: String,
    /// Modelo sugerido para la llamada `Agent` del especialista (sonnet/opus,
    /// política calidad>tokens). Ver `model_for_intent`.
    pub model_hint: Option<String>,
    /// Por qué se delegó (trazabilidad / telemetría).
    pub reason: String,
}

/// Heurística barata de "no-trivial": longitud mínima + un verbo de acción.
pub fn is_nontrivial(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    if p.split_whitespace().count() < MIN_WORDS {
        return false;
    }
    ACTION_VERBS.iter().any(|v| p.contains(v))
}

/// Modelo sugerido para el especialista delegado. Política calidad>tokens
/// (feedback literal del usuario 2026-06-24): el trabajo delegado a un agente
/// real SIEMPRE es Sonnet u Opus, NUNCA haiku. Razonamiento profundo
/// (arquitectura, auditoría de seguridad, performance, investigación) -> opus;
/// implementación y resto -> sonnet como default de calidad.
pub fn model_for_intent(intent: &str) -> Option<String> {
    let model = match intent {
        "architecture_review" | "security" | "performance" | "research" => "opus",
        _ => "sonnet",
    };
    Some(model.to_string())
}

/// Decide si emitir una directiva. `Some` SOLO si el intent es delegable Y la
/// tarea es no-trivial Y hay un especialista top. `objective` = improved_prompt.
pub fn decide_delegation(
    intent: &str,
    prompt: &str,
    objective: &str,
    top_agent: Option<&AgentChoice>,
) -> Option<DelegationDirective> {
    let agent = top_agent?;
    if !DELEGABLE_INTENTS.contains(&intent) {
        return None;
    }
    if !is_nontrivial(prompt) {
        return None;
    }
    Some(DelegationDirective {
        agent: agent.name.clone(),
        objective: objective.to_string(),
        return_format: RETURN_FORMAT.to_string(),
        model_hint: model_for_intent(intent),
        reason: format!("intent={intent}; tarea no-trivial"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(name: &str) -> AgentChoice {
        AgentChoice {
            name: name.to_string(),
            description: String::new(),
            score: 1.0,
        }
    }

    #[test]
    fn delegable_intent_nontrivial_emits_directive() {
        let d = decide_delegation(
            "refactor",
            "refactoriza el modulo de recall unificado a async sin romper recall@8",
            "[encuadre refactor] refactoriza el modulo de recall a async",
            Some(&agent("refactoring-specialist")),
        );
        let d = d.expect("debe emitir directiva");
        assert_eq!(d.agent, "refactoring-specialist");
        // calidad>tokens: refactor delegado -> sonnet (jamás haiku).
        assert_eq!(d.model_hint.as_deref(), Some("sonnet"));
        assert!(d.return_format.contains("Resumen"));
    }

    #[test]
    fn general_intent_does_not_delegate() {
        // 'general' es el default genérico -> nunca delega aunque sea largo.
        let d = decide_delegation(
            "general",
            "implementa una funcion que sume dos numeros y devuelva el total ahora",
            "objetivo",
            Some(&agent("code-reviewer")),
        );
        assert!(d.is_none());
    }

    #[test]
    fn trivial_prompt_does_not_delegate() {
        // Caso negativo (mandamiento 7): saludo / pregunta corta -> 0 directiva.
        assert!(
            decide_delegation("research", "hola", "hola", Some(&agent("ai-engineer"))).is_none()
        );
        assert!(decide_delegation(
            "rust",
            "que es RRF",
            "que es RRF",
            Some(&agent("rust-engineer"))
        )
        .is_none());
    }

    #[test]
    fn no_top_agent_does_not_delegate() {
        let d = decide_delegation(
            "feature",
            "implementa la feature completa de delegacion ahora mismo",
            "obj",
            None,
        );
        assert!(d.is_none());
    }

    #[test]
    fn is_nontrivial_requires_length_and_verb() {
        assert!(!is_nontrivial("arregla")); // corto
        assert!(!is_nontrivial("cuantos proyectos tengo en el sistema hoy")); // sin verbo de accion
        assert!(is_nontrivial(
            "implementa el contrato de delegacion en el orquestador rust"
        ));
    }

    #[test]
    fn model_for_intent_honra_calidad_sobre_tokens() {
        // Razonamiento profundo -> opus.
        for deep in ["architecture_review", "security", "performance", "research"] {
            assert_eq!(
                model_for_intent(deep).as_deref(),
                Some("opus"),
                "intent profundo {deep} debe ir a opus"
            );
        }
        // Implementación / resto -> sonnet (default de calidad).
        for impl_intent in [
            "feature",
            "bug_fix",
            "refactor",
            "testing",
            "rust",
            "typescript",
        ] {
            assert_eq!(
                model_for_intent(impl_intent).as_deref(),
                Some("sonnet"),
                "intent de implementacion {impl_intent} debe ir a sonnet"
            );
        }
        // Caso negativo (mandamiento 7): NINGÚN intent delegable cae en haiku.
        for &intent in DELEGABLE_INTENTS.iter() {
            assert_ne!(
                model_for_intent(intent).as_deref(),
                Some("haiku"),
                "intent delegable {intent} NUNCA debe sugerir haiku (calidad>tokens)"
            );
        }
    }

    // --- Tests de selección canónica (fix 2026-06-25) ---
    // Verifican que el ancla de la directiva usa preferred_specialists(intent)
    // y NO simplemente el [0] reordenado por E5.

    /// (a) intent="rust": cpp-pro primero en la lista E5, rust-engineer segundo.
    /// La directiva debe apuntar a rust-engineer (canónico), no a cpp-pro.
    #[test]
    fn canonical_anchor_rust_ignores_e5_order() {
        use crate::orchestrator::ranking::preferred_specialists;

        let agents = [agent("cpp-pro"), agent("rust-engineer")];
        let preferred = preferred_specialists("rust");
        let directive_agent = preferred
            .iter()
            .find_map(|p| agents.iter().find(|a| a.name == *p))
            .or_else(|| agents.first());

        assert_eq!(
            directive_agent.map(|a| a.name.as_str()),
            Some("rust-engineer"),
            "intent=rust: la directiva debe apuntar a rust-engineer aunque cpp-pro sea [0]"
        );
    }

    /// (b) intent="refactor": ultron-refactor primero, refactoring-specialist segundo.
    /// La directiva debe apuntar a refactoring-specialist (primer canónico del intent).
    #[test]
    fn canonical_anchor_refactor_ignores_e5_order() {
        use crate::orchestrator::ranking::preferred_specialists;

        let agents = [agent("ultron-refactor"), agent("refactoring-specialist")];
        let preferred = preferred_specialists("refactor");
        let directive_agent = preferred
            .iter()
            .find_map(|p| agents.iter().find(|a| a.name == *p))
            .or_else(|| agents.first());

        assert_eq!(
            directive_agent.map(|a| a.name.as_str()),
            Some("refactoring-specialist"),
            "intent=refactor: la directiva debe apuntar a refactoring-specialist aunque ultron-refactor sea [0]"
        );
    }
}
