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

/// `dense_enabled` controls whether the semantic (E5) paths run. Since the
/// quality-first policy (2026-06-19) EVERY caller of the hot path passes `true`
/// — both the CLI one-shot (`main.rs`) and the resident daemon (`serve.rs`) —
/// so the UserPromptSubmit hook runs the FULL hybrid recall (dense E5 + sparse
/// FTS5). Honest cost (kirkardo cat9, medido 2026-07-03): p50 ~130-180 ms e2e
/// vía daemon con E5 residente (incluye el spawn de node); el one-shot del CLI
/// paga la carga E5 in-proc (~1.4-3.3 s) y el primer hit con daemon frío
/// ~2.7-11 s. NO es el diseño histórico "<300 ms sparse-only": `false` queda
/// como modo degradación (E5/Qdrant caídos) o para trade-offs explícitos.
pub fn orchestrate(
    prompt: &str,
    project_id: Option<&str>,
    dense_enabled: bool,
) -> OrchestrationContext {
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
    // (señales léxicas / petición explícita) — <1ms, sin red ni E5. Un
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

    // Real specialists to DELEGATE to. With dense_enabled we semantic-match over
    // the agent catalog (E5) and over-fetch; on the sparse-first hot path we skip
    // the E5 embed entirely and let inject_preferred_floor seed the intent's
    // preferred specialists by rule. Either way rebalance keeps the meta
    // ULTRON-internal agents from crowding out the real specialists.
    let raw_hits = if dense_enabled {
        catalog::search_catalog(prompt, Some("agent"), 16)
    } else {
        Vec::new()
    };
    let raw_hits_empty = raw_hits.is_empty();
    // Floor-inject the intent's preferred specialists so the boost isn't
    // decorative when cross-lingual retrieval missed them (UI/testing 0/3 fix).
    let pooled = inject_preferred_floor(raw_hits, intent);
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
        if !dense_enabled {
            // Camino sparse (respaldo `--sparse` del hook, 2026-09-07): no se
            // ha consultado el catálogo, así que "sin hits" no dice nada de
            // Qdrant. Sin este guard cada respaldo lanzaba un reindex de
            // fondo por un diagnóstico falso.
            warnings.push(
                "sparse: sin búsqueda semántica de agentes (solo reglas por intent)".to_string(),
            );
        } else if raw_hits_empty {
            // Auto-reparación (2026-08-23, decidido por el usuario): el catálogo
            // solo vive en Qdrant — a diferencia de las memorias, no tiene fuente
            // de verdad que reconstruirlo — y NADIE lo repuebla salvo a mano. Si
            // Qdrant pierde la colección, la delegación se apaga en silencio y
            // para siempre: así estuvo el 2026-08-22, con 0 candidatos en todas
            // las sesiones. Se dispara el reindex en segundo plano; este turno ya
            // sale sin delegación, pero el siguiente la recupera solo.
            let lanzado = catalog::spawn_reindex_si_vacio();
            warnings.push(if lanzado {
                "agent catalog vacío — reindexando en segundo plano; la delegación vuelve en el próximo turno"
                    .to_string()
            } else {
                "agent catalog empty/unavailable — run `catalog_reindex`".to_string()
            });
        } else {
            // Abstencion (2026-08-12): habia hits pero ninguno supero el floor
            // — senal semantica debil (prompt conversacional / sin dominio).
            // Mejor sin sugerencia que un especialista al azar a 0.78.
            warnings.push(
                "delegacion abstenida: senal semantica debil (ningun agente supera el floor)"
                    .to_string(),
            );
        }
    }

    // SKILLS now compete in routing (previously the agent-only filter left the
    // ~119 indexed skills — personas + technical — dead). Separate read-path so
    // the assistant sees pertinent skills (e.g. tio-gilito for finance) too.
    let skill_hits = if dense_enabled {
        catalog::search_catalog(prompt, Some("skill"), 10)
    } else {
        Vec::new()
    };
    let delegate_skills: Vec<SkillChoice> = rank_skills(skill_hits, intent, 4);

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

    // Relevant memories. On the hot path (dense_enabled=false) recall is SPARSE-
    // first: an E5-large query embed (~1.1s on CPU even with the daemon warm)
    // blows the latency budget, so FTS5 sparse + the confidence/recency re-ranker
    // carry it. Quality callers (dense_enabled=true) and the manual Memory Browser
    // (recall_unified command) keep full hybrid recall.
    // limit=8: alineado con DEFAULT_LIMIT y el golden eval (k=8). 12 forzaba a
    // rellenar el pack con cola BM25 irrelevante (context_waste ~0.59); el
    // relevance-floor de assemble_pack + este techo dejan el pack few-and-good.
    // RERANK SELECTIVO (2026-08-13, decidido por el usuario tras medir): el
    // cross-encoder sube el recall@8 medido de 0.491 (hot path pelado) a 0.810
    // (golden con rerank), pero cuesta 2-2.4 s/llamada frente a un p50 de ~134
    // ms. Encenderlo SIEMPRE castigaría cada turno de charla; apagado siempre
    // condenaba los turnos técnicos —donde la memoria es la que decide— a la
    // mitad del recall del que el sistema es capaz. Se paga solo donde importa:
    // prompts NO conversacionales. `ULTRON_RERANK_HOT=1` sigue forzándolo en
    // todos (opt-in explícito). El hook lleva su presupuesto de timeout alineado.
    let conversational = super::rules::is_conversational(prompt);
    // (2026-08-16, decidido por el usuario) NUNCA se carga el cross-encoder
    // dentro del turno. Medido: con E5 ya caliente, la primera llamada tras
    // soltarlo por inactividad cuesta 8762 ms — más que el presupuesto entero
    // del hook (6000 ms) — así que el prompt no llegaba con recall PEOR, sino
    // con recall NINGUNO: 12 turnos ciegos entre el 14 y el 16 de agosto, y su
    // ventana de idle son 2,5 min, o sea que bastaba una pausa de café. Si está
    // frío se responde ya sin rerank (recall@8 0.491) y se carga de fondo; del
    // siguiente prompt en adelante vuelve la calidad plena (0.810).
    // (2026-08-23, decidido por el usuario tras volver a medir) El rerank SALE
    // del hot path. El coste real no eran los 2-2.4 s de la nota de arriba: con
    // el daemon caliente y los modelos residentes (ULTRON_MODEL_IDLE_MIN=0) un
    // prompt tecnico costaba 7,7-8,3 s de punta a punta (3/3) y el `trace` del
    // path de calidad 13,0 s, contra 257-605 ms de un prompt de charla. El
    // presupuesto del hook con pack cacheado son 6.000 ms, asi que el turno
    // tecnico vencia el plazo SIEMPRE y el hook servia el pack CACHEADO de otro
    // prompt: no "recall peor", sino recall de OTRA pregunta, y en silencio. El
    // 11% de los turnos de un dia acabo en esa banda (7 de 61 clavados en
    // ~6,9 s, que es el tope del presupuesto, no trabajo real).
    //
    // Sin rerank el recall@8 del hot path baja al 0.491 medido, pero es 0.491
    // DE ESTE prompt y en menos de un segundo, lo que bate a un 0.810 que no
    // llegaba nunca a tiempo. El cross-encoder sigue sirviendo a los callers de
    // calidad (Memory Browser, `trace`, evals) y se sigue calentando de fondo
    // para ellos; `ULTRON_RERANK_HOT=1` lo devuelve al hot path el dia que su
    // coste baje del presupuesto.
    // 2026-09-06 (decisión sobre el golden v2): re-rank por ruta — todo
    // intent salvo `general`; `ULTRON_RERANK_HOT=1/0` fuerza siempre/nunca.
    let rerank = crate::qdrant::rerank_hot_for_intent(intent);
    if rerank && !crate::qdrant::reranker_is_warm() {
        // Opt-in explicito con el modelo frio: cargarlo DENTRO del turno cuesta
        // mas que el presupuesto entero del hook, asi que este turno va sin el
        // igualmente y el modelo queda listo para el siguiente.
        if crate::qdrant::spawn_reranker_warmup() {
            warnings.push(
                "cross-encoder frio: este turno va sin re-rank; cargandolo en background"
                    .to_string(),
            );
        }
    }
    // Telemetría honesta: `true` solo si el cross-encoder estaba caliente y el
    // pack pasó por él; decidido-pero-frío se ve en el warning, no aquí.
    let rerank_applied = rerank && crate::qdrant::reranker_is_warm();
    let memories = match build_trace(prompt, 8, project_id, cross_project, dense_enabled, rerank) {
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
        let (hits, avisos) =
            super::lessons::recall_lecciones(prompt, project_id, dense_enabled, rerank, &memories);
        warnings.extend(avisos);
        hits
    } else {
        Vec::new()
    };

    // Clase CONVERSACIONAL (2026-08-13): charla corta sin señal técnica → se
    // recorta la ceremonia (workflow, step_plans, constraints, encuadre). El
    // tono, recall y warnings siguen — son lo único útil en esos turnos.
    // (`conversational` ya calculado arriba: gobierna también el rerank.)
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

    // cat13.2: optimize_prompt is the canonical optimizer (alias of
    // build_prompt_plan) — the routing optimizes the prompt before building the plan.
    let prompt_plan = if conversational {
        super::types_model::PromptPlan {
            improved_prompt: prompt.to_string(),
            suggested_mode: "low".to_string(),
            clarifying_questions: Vec::new(),
            success_criteria: Vec::new(),
        }
    } else {
        super::ranking::optimize_prompt(prompt, intent)
    };

    // cat13.4: when the routing proposes a multi-step GROUP (workflow), optimize
    // each step's prompt by the role sub-intent of the agent that runs it. Empty
    // for a single-step / no-workflow turn (optimize_prompt already covers that).
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
        rerank_hot: rerank_applied,
        token_budget: TOKEN_BUDGET,
        cross_project,
        prompt_plan,
        step_plans,
        delegation_directive,
        tone,
        lessons,
    }
}
