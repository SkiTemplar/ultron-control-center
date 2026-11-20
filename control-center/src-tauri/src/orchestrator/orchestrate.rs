// orchestrator/orchestrate.rs — main orchestrate() function.

use crate::agent_orchestration::list_workflows_inner;
use crate::commands::memory::recall_unified::build_trace;
use crate::memory::catalog;

use super::ranking::{inject_preferred_floor, rank_skills, rebalance_delegates};
use super::rules::{classify_intent, detect_cross_project};
use super::types_model::{
    AgentChoice, OrchestrationContext, SkillChoice, WorkflowChoice, FORMAT_OVERHEAD_TOKENS,
    TOKEN_BUDGET,
};

/// Aviso visible para un turno sin delegación fuera de la clase
/// meta/introspectiva: la delegación es por reglas (especialistas preferidos
/// del intent) y este intent no tiene ninguno presente en disco.
pub(super) const NO_DELEGATION_WARNING: &str =
    "sin delegación: el intent no tiene especialistas preferidos (delegación por reglas)";

/// Orquestación completa de un prompt: intent, workflow, especialistas a los
/// que delegar (por reglas), recall FTS5 de memorias y lecciones, plan de
/// prompt y presupuesto de tokens. Callers: the daemon `orchestrate` request
/// (`serve.rs`) and the CLI one-shot (`ultron-memory orchestrate`). The session
/// hook runs in light mode (tone only) and never calls this function.
pub fn orchestrate(prompt: &str, project_id: Option<&str>) -> OrchestrationContext {
    let (rule_intent, wf_id) = classify_intent(prompt);
    let known = catalog::known_agent_names();
    let mut warnings: Vec<String> = Vec::new();

    // Cola ambigua (2026-08-23): las reglas aciertan con encargos técnicos, pero
    // el usuario describe SÍNTOMAS en español coloquial y eso cae en `general`,
    // que no delega nunca. Medido sobre 15 prompts reales: 14/15 eran `general`;
    // con el rescate bajan a 3/15. Solo se paga la llamada en ese caso, y un
    // fallo devuelve el intent de las reglas — nunca empeora lo que ya había.
    let (intent, intent_rescatado) = if super::intent_llm::merece_consulta(rule_intent, prompt) {
        match super::intent_llm::rescatar_intent(prompt) {
            Some(rescatado) => {
                warnings.push(format!(
                    "intent rescatado por modelo: general -> {rescatado} (las reglas no supieron clasificarlo)"
                ));
                (rescatado, true)
            }
            None => (rule_intent, false),
        }
    } else {
        (rule_intent, false)
    };
    // `wf_id` se queda con el de las reglas a propósito: el workflow describe la
    // CEREMONIA del turno (pasos, agentes por paso) y un rescate de intent no es
    // señal suficiente para imponer un flujo multi-paso. El rescate sirve para
    // delegar, no para orquestar un workflow entero.

    // Personalities v1 (2026-08-13): detección determinista del TONO del chat
    // (señales léxicas / petición explícita) — <1ms, sin red. Un
    // personality.json corrupto degrada a seeds con warning (mandamiento 11).
    let (tone, tone_warning) = super::personality::detect_for_prompt(prompt);
    if let Some(w) = tone_warning {
        warnings.push(w);
    }

    // Selected workflow (built-in), with ghost step-agents sanitized.
    let workflow = list_workflows_inner()
        .into_iter()
        .find(|w| w.id == wf_id)
        .map(|w| {
            let mut steps = Vec::new();
            for s in &w.steps {
                if known.is_empty() || known.contains(&s.agent) {
                    steps.push(s.agent.clone());
                } else {
                    warnings.push(format!(
                        "workflow step agent '{}' not found on disk (ghost) — skipped",
                        s.agent
                    ));
                }
            }
            WorkflowChoice {
                id: w.id,
                label: w.label,
                description: w.description,
                steps,
            }
        });

    // Real specialists to DELEGATE to: inject_preferred_floor seeds the
    // intent's preferred specialists by rule (sin búsqueda semántica desde que
    // se retiró la ruta densa) and rebalance keeps the meta ULTRON-internal
    // agents from crowding out the real specialists.
    let pooled = inject_preferred_floor(Vec::new(), intent);
    // [bvaqws] Clase META/INTROSPECTIVA (autoevaluar la sesión, resumir esta
    // conversación...): un subagente NO tiene el transcript, así que emitir
    // delegate_to aquí es ordenar un imposible. Se vacía la lista y se explica
    // el porqué (mandamiento 11: prohibido el no-op silencioso).
    let meta_introspective = super::rules::is_meta_introspective(prompt);
    let delegate_agents: Vec<AgentChoice> = if meta_introspective {
        warnings.push(
            "clase meta/introspectiva: delegación EXCLUIDA — un subagente no tiene el transcript de la sesión"
                .to_string(),
        );
        Vec::new()
    } else {
        rebalance_delegates(pooled, intent, 5)
    };
    if delegate_agents.is_empty() && !meta_introspective {
        warnings.push(NO_DELEGATION_WARNING.to_string());
    }

    // Skills preferidas del intent (rank_skills las inyecta por regla; sin
    // candidatos semánticos desde que se retiró la ruta densa).
    let delegate_skills: Vec<SkillChoice> = rank_skills(intent, 4);

    // CROSS-PROJECT auto-detect: a no-op without a current project (cross-project
    // is meaningless then). When the prompt asks about another / all projects we
    // widen recall to the whole brain — security gates (Secret excluded) untouched.
    let cross_project = project_id.is_some() && detect_cross_project(prompt);
    if cross_project {
        warnings.push(
            "cross-project recall — searching the whole brain (other projects included)"
                .to_string(),
        );
    }

    // Relevant memories: recall FTS5 + the confidence/recency re-ranker.
    // limit=8: alineado con el golden eval (k=8). 12 forzaba a rellenar el
    // pack con cola BM25 irrelevante (context_waste ~0.59); el relevance-floor
    // de assemble_pack + este techo dejan el pack few-and-good.
    let conversational = super::rules::is_conversational(prompt);
    let memories = match build_trace(prompt, 8, project_id, cross_project) {
        Ok(t) => {
            warnings.extend(t.warnings.clone());
            t.injected
        }
        Err(e) => {
            warnings.push(format!("recall unavailable: {e}"));
            Vec::new()
        }
    };

    // ULTRON 4 F1.3 (2026-09-02): lecciones de OTROS proyectos, solo cuando el
    // turno describe un fallo (bug_fix / debug). Segunda pasada de recall con
    // cross_project=true filtrada a `lesson`; en el resto de turnos no cuesta
    // nada. Una charla corta tampoco la paga aunque mencione un "error".
    let lessons = if !conversational && super::lessons::es_sintoma(intent, Some(wf_id), prompt) {
        let (hits, avisos) = super::lessons::recall_lecciones(prompt, project_id, &memories);
        warnings.extend(avisos);
        hits
    } else {
        Vec::new()
    };

    // Clase CONVERSACIONAL (2026-08-13): charla corta sin señal técnica → se
    // recorta la ceremonia (workflow, step_plans, constraints, encuadre). El
    // tono, recall y warnings siguen — son lo único útil en esos turnos.
    // (`conversational` ya calculado arriba.)
    let workflow = if conversational { None } else { workflow };

    let constraints = if conversational {
        Vec::new()
    } else {
        vec![
            "Minimizar tokens: usar el context pack, no memoria cruda".to_string(),
            "Solo el Memory Agent escribe memoria persistente".to_string(),
            "DELEGAR a los agentes reales existentes; no reinventar capacidades".to_string(),
        ]
    };

    // cat13: paso de mejora de prompt (encuadre por intent, modo sugerido,
    // preguntas si el prompt es vago). Una charla corta no lo paga.
    let prompt_plan = if conversational {
        super::types_model::PromptPlan {
            improved_prompt: prompt.to_string(),
            suggested_mode: "low".to_string(),
            clarifying_questions: Vec::new(),
            success_criteria: Vec::new(),
        }
    } else {
        super::ranking::build_prompt_plan(prompt, intent)
    };

    // cat13.4: when the routing proposes a multi-step GROUP (workflow), optimize
    // each step's prompt by the role sub-intent of the agent that runs it. Empty
    // for a single-step / no-workflow turn (build_prompt_plan already covers it).
    // Consumers: the hook in full mode and the Preview panel of the app.
    let step_plans = workflow
        .as_ref()
        .map(|w| super::ranking::build_step_plans(&w.steps))
        .unwrap_or_default();

    // cat16.4: TOKEN_BUDGET es ahora un presupuesto COMPARTIDO entre las 4 capas
    // inyectadas (antes los caps por capa 12/5/4/6 lo ignoraban y el campo
    // token_budget era decorativo). Se reparte por prioridad — memories primero,
    // luego agents/skills/step_plans — reservando ~200 tokens de overhead de
    // formato (ver types_model::TOKEN_BUDGET). Si el presupuesto alcanza para
    // todo lo ya seleccionado, no recorta nada.
    let (memories, delegate_agents, delegate_skills, step_plans) =
        super::ranking::apply_token_budget(
            memories,
            delegate_agents,
            delegate_skills,
            step_plans,
            TOKEN_BUDGET,
            FORMAT_OVERHEAD_TOKENS,
        );

    // Delegación automática (plano chat, 2026-06-23): si el intent es delegable y
    // la tarea no-trivial, emite una directiva imperativa con el especialista top
    // ya rankeado y el prompt optimizado como objetivo. None = sin delegación.
    //
    // Fix 2026-06-25: la DIRECTIVA se ancla al primer especialista canónico
    // de `preferred_specialists(intent)` que esté presente en `delegate_agents`,
    // en lugar de al [0] reordenado por E5 (que puede subir cpp-pro sobre
    // rust-engineer, etc.). La lista visible `delegate_agents` no cambia.
    // Entre los especialistas CANÓNICOS presentes gana el de mayor score, no el
    // primero de la lista (2026-08-23). El anclaje por orden hacía que `feature`
    // acabara SIEMPRE en `architect-reviewer` —primero de su lista— aunque el
    // ranking pusiera `fullstack-developer` por encima: revisar arquitectura no
    // es implementar una feature. Se mantiene intacto lo que arregló el fix de
    // 2026-06-25: solo compiten preferidos canónicos, nunca el ruido de E5
    // (~0.77), y el orden de la lista sigue siendo el desempate.
    let directive_agent = super::ranking::elegir_directive_agent(
        super::ranking::preferred_specialists(intent),
        &delegate_agents,
    );
    let delegation_directive = super::delegation::decide_delegation(
        intent,
        prompt,
        &prompt_plan.improved_prompt,
        directive_agent,
        intent_rescatado,
    );

    OrchestrationContext {
        prompt: prompt.to_string(),
        route: intent.to_string(),
        project_id: project_id.map(str::to_string),
        workflow,
        delegate_agents,
        delegate_skills,
        memories,
        constraints,
        warnings,
        token_budget: TOKEN_BUDGET,
        cross_project,
        prompt_plan,
        step_plans,
        delegation_directive,
        tone,
        lessons,
    }
}
