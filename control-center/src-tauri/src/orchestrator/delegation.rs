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
    /// Modelo barato sugerido para la llamada `Agent` del agente (haiku/sonnet).
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

/// Modelo sugerido por rol: review/exploración -> haiku; implementación -> sonnet.
pub fn model_for_intent(intent: &str) -> Option<String> {
    let model = match intent {
        "security"
        | "testing"
        | "bug_fix"
        | "refactor"
        | "research"
        | "performance"
        | "architecture_review" => "haiku",
        "feature" | "api_design" | "rust" | "python" | "typescript" | "golang" | "csharp"
        | "database" | "ml" | "llm" | "devops" | "docker" | "cloud_infra" | "data_eng" => "sonnet",
        _ => "haiku",
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
        assert_eq!(d.model_hint.as_deref(), Some("haiku"));
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
    fn feature_intent_uses_sonnet() {
        assert_eq!(model_for_intent("feature").as_deref(), Some("sonnet"));
        assert_eq!(model_for_intent("security").as_deref(), Some("haiku"));
    }
}
