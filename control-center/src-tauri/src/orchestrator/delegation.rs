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

/// Frases (con espacios — los substrings cortos fueron catastróficos en el
/// routing, lección 2026-06-05) que identifican una META-TAREA sobre el propio
/// sistema ULTRON: operar su memoria, sus skills, su kanban o su inbox. Eso lo
/// ejecuta el agente principal con sus herramientas (MemoryService, kanban.mjs,
/// SKILL.md) — un subagente delegado no tiene ese contexto operativo y delegarlo
/// era ordenar un imposible (medido: "consolida la memoria" -> rust-engineer).
const ULTRON_META_PHRASES: &[&str] = &[
    "consolida la memoria",
    "consolidar la memoria",
    "consolida memoria",
    "fusiona las notas",
    "fusiona memorias",
    "limpia el index de memoria",
    "edita la skill",
    "editar la skill",
    "edita el skill",
    "mejora la descripcion de la skill",
    "mueve la card",
    "mueve la tarjeta",
    "mueve la carta",
    "columna del kanban",
    "del kanban a la columna",
    "al kanban",
    "olvida esa decision",
    "olvida la decision",
    "olvida esa memoria",
    "actualiza la memoria",
    "guarda en la memoria",
    "drena el inbox",
    "valida los candidatos",
];

/// `true` si el prompt es una meta-tarea de operación del propio sistema
/// (memoria/skills/kanban/inbox): NUNCA se delega.
pub fn is_ultron_meta_task(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    ULTRON_META_PHRASES.iter().any(|f| p.contains(f))
}

/// Señales de RAZONAMIENTO PROFUNDO en el propio prompt. El intent no basta:
/// "revisa la arquitectura del pipeline" clasifica como `refactor` (el
/// clasificador pesa el verbo), y con solo el intent salía sonnet para un
/// trabajo que es análisis de arquitectura puro (medido, check 22.2). La
/// política calidad>tokens exige opus ahí.
const DEEP_REASONING_HINTS: &[&str] = &[
    "arquitectura",
    "architecture",
    "trade-off",
    "trade off",
    "acoplamiento",
    "coupling",
    "diseño del sistema",
    "system design",
    "threat model",
    "auditoria de seguridad",
    "auditoría de seguridad",
];

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

/// Modelo para la tarea CONCRETA: intent + señales del propio prompt. Un prompt
/// de arquitectura clasificado como `refactor` por su verbo sigue mereciendo
/// opus — el razonamiento profundo lo define el contenido, no solo la etiqueta.
pub fn model_for_task(intent: &str, prompt: &str) -> Option<String> {
    let p = prompt.to_lowercase();
    if DEEP_REASONING_HINTS.iter().any(|h| p.contains(h)) {
        return Some("opus".to_string());
    }
    model_for_intent(intent)
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
    // Meta-tarea del propio sistema (memoria/skills/kanban/inbox): el agente
    // principal la ejecuta con sus herramientas; delegarla es un imposible.
    if is_ultron_meta_task(prompt) {
        return None;
    }
    Some(DelegationDirective {
        agent: agent.name.clone(),
        objective: objective.to_string(),
        return_format: RETURN_FORMAT.to_string(),
        model_hint: model_for_task(intent, prompt),
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
    fn meta_tasks_never_delegate() {
        // Los 4 casos MEDIDOS que se delegaban por error (harness 22.5): operar
        // la memoria/skills/kanban del propio sistema no es delegable.
        for prompt in [
            "consolida la memoria y fusiona las notas duplicadas del index",
            "edita la skill de ultron para mejorar su descripcion de triggers",
            "mueve la card del kanban a la columna done porque ya esta hecha",
            "olvida esa decision y actualiza la memoria con la nueva politica del proyecto",
        ] {
            let d = decide_delegation("refactor", prompt, "obj", Some(&agent("rust-engineer")));
            assert!(d.is_none(), "meta-tarea delegada por error: {prompt}");
        }
        // CASO NEGATIVO: una tarea real que solo MENCIONA memoria de programa
        // no es meta-tarea — sigue delegándose.
        let d = decide_delegation(
            "rust",
            "arregla el leak de memoria del parser y añade un test que lo cubra",
            "obj",
            Some(&agent("rust-engineer")),
        );
        assert!(d.is_some(), "tarea real bloqueada por el filtro meta");
    }

    #[test]
    fn architecture_prompt_gets_opus_even_if_intent_is_refactor() {
        // Medido (22.2): "revisa la arquitectura..." clasifica como `refactor`
        // por el verbo; el contenido es análisis de arquitectura -> opus.
        let d = decide_delegation(
            "refactor",
            "revisa la arquitectura del nuevo pipeline de recall: trade-offs, modulos y su acoplamiento",
            "obj",
            Some(&agent("architect-reviewer")),
        )
        .expect("debe emitir directiva");
        assert_eq!(d.model_hint.as_deref(), Some("opus"));
        // CASO NEGATIVO: un refactor sin señal profunda sigue en sonnet.
        let d2 = decide_delegation(
            "refactor",
            "refactoriza el modulo de recall unificado a async sin romper recall@8",
            "obj",
            Some(&agent("refactoring-specialist")),
        )
        .expect("debe emitir directiva");
        assert_eq!(d2.model_hint.as_deref(), Some("sonnet"));
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
