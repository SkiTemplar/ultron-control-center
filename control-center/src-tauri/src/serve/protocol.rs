//! Protocolo del daemon: la petición que llega por la línea JSON y el handler
//! puro que la resuelve.
//!
//! `handle_request` está separado del socket a propósito: no toca red ni
//! ficheros de transporte, así que los casos de borde (token inválido, comando
//! desconocido, prompt vacío) se prueban sin levantar nada.

use std::time::Instant;

use serde::Deserialize;
use serde_json::{json, Value};

/// One request line from a hook client.
#[derive(Debug, Deserialize)]
pub(super) struct Req {
    /// Per-launch shared token (must match the lockfile's). Anti-accident only.
    pub(super) token: Option<String>,
    /// "orchestrate" | "skill_query" | "skill_judge" | "embed" | "ping" | "shutdown".
    pub(super) cmd: String,
    /// Prompt to route / query (orchestrate + skill_query).
    pub(super) prompt: Option<String>,
    /// Project slug for project-scoped recall (orchestrate only).
    pub(super) project: Option<String>,
    /// Top-N semantic skill hits to return (skill_query only; default 5).
    pub(super) top: Option<u32>,
    /// recall: buscar en TODO el cerebro y no solo en el proyecto.
    pub(super) cross: Option<bool>,
    /// recall: pasar el cross-encoder (calidad) o quedarse en el híbrido.
    pub(super) rerank: Option<bool>,
    /// embed: texto suelto a vectorizar contra el E5 ya residente. Campo propio
    /// (no `prompt`) porque no es una consulta que el daemon vaya a resolver,
    /// sino el material del que se devuelve el vector.
    pub(super) text: Option<String>,
}

/// Pure request handler — separated from socket I/O so it is hermetically
/// testable. Returns `(response_json, should_shutdown)`.
pub(super) fn handle_request(req: &Req, expected_token: &str, started: Instant) -> (Value, bool) {
    if req.token.as_deref() != Some(expected_token) {
        return (json!({ "error": "unauthorized" }), false);
    }
    match req.cmd.as_str() {
        "ping" => (
            json!({
                "ok": true,
                "pid": std::process::id(),
                "uptime_ms": started.elapsed().as_millis() as u64,
            }),
            false,
        ),
        "shutdown" => (json!({ "ok": true, "shutting_down": true }), true),
        "skill_judge" => {
            // Enrutado de skill por LLM sobre el catalogo completo. El denso de
            // `skill_query` acierta 4/10 en top-1 y sus scores caben todos en
            // 0.79-0.84 (medido 2026-08-27), asi que no hay umbral que separe;
            // este camino le da el catalogo entero a un flash y valida la
            // respuesta contra el. Fail-safe: devuelve [] cuando el proveedor
            // no esta, y el llamante se queda con el resultado denso.
            let prompt = req.prompt.as_deref().unwrap_or("");
            if prompt.trim().is_empty() {
                return (json!({ "error": "empty prompt" }), false);
            }
            if !crate::orchestrator::skill_llm::merece_consulta(prompt) {
                return (
                    json!({ "skills": [], "skipped": "prompt sin cuerpo" }),
                    false,
                );
            }
            // El catalogo va prefiltrado por el denso: el completo son ~2.400
            // tokens por consulta y con eso ningun tier gratis aguanta un dia
            // de trabajo (medido 2026-08-28: 0 enrutados desde el despliegue).
            let catalogo = crate::orchestrator::skill_llm::catalogo_para(prompt);
            let skills = crate::orchestrator::skill_llm::elegir_skills(prompt, &catalogo);
            (
                json!({ "skills": skills, "catalog_size": catalogo.len() }),
                false,
            )
        }
        // Destilado de lecciones al cerrar sesion (ULTRON 4 F1.2, Q2b). El hook
        // `lesson-distill` manda el digest ya redactado; aqui se vuelve a
        // redactar, se recorta y se consulta la cadena de `skill_llm` (cuota
        // separada del AI Router). Devuelve 0-3 lecciones validadas; el hook
        // las propone como candidatos por `ultron-memory candidate`. Fail-safe:
        // sin proveedor, lista vacia y `skipped` con el motivo.
        "lesson_distill" => {
            let digest = req.prompt.as_deref().unwrap_or("");
            if digest.trim().is_empty() {
                return (json!({ "error": "empty prompt" }), false);
            }
            if !crate::orchestrator::lesson_llm::merece_destilar(digest) {
                return (
                    json!({ "lessons": [], "skipped": "digest sin cuerpo" }),
                    false,
                );
            }
            let lessons = crate::orchestrator::lesson_llm::destilar(digest);
            (
                json!({ "lessons": lessons, "digest_chars": digest.chars().count() }),
                false,
            )
        }
        // Perfil de proyecto al cerrar sesion (ULTRON 4 F1.4, G9). El hook
        // `project-profile` manda en `prompt` lo que sabe del repositorio (docs,
        // manifiestos, kanban, commits) y aqui se junta con la memoria del
        // proyecto (decisiones, restricciones, arquitectura, lecciones,
        // resumenes) antes de consultar la cadena de `skill_llm`. Devuelve UN
        // perfil validado o `profile: null` con el motivo; el hook decide si
        // lo guarda o conserva el anterior. Fail-safe: sin proveedor, null.
        "profile_distill" => {
            let Some(project) = req
                .project
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
            else {
                return (
                    json!({ "error": "profile_distill requiere project" }),
                    false,
                );
            };
            let repo = req.prompt.as_deref().unwrap_or("");
            let memoria = crate::orchestrator::profile_llm::fuentes_de_memoria(project);
            let fuentes =
                crate::orchestrator::profile_llm::preparar_fuentes(project, repo, &memoria);
            let base = json!({
                "repo_chars": repo.chars().count(),
                "memory_chars": memoria.chars().count(),
            });
            if !crate::orchestrator::profile_llm::merece_destilar(&fuentes) {
                let mut out = base;
                out["profile"] = serde_json::Value::Null;
                out["skipped"] = json!("fuentes sin cuerpo");
                return (out, false);
            }
            let mut out = base;
            match crate::orchestrator::profile_llm::destilar(&fuentes) {
                Some(perfil) => out["profile"] = json!(perfil),
                None => {
                    out["profile"] = serde_json::Value::Null;
                    out["skipped"] = json!("sin proveedor o respuesta sin forma");
                }
            }
            (out, false)
        }
        // Clasificacion de intencion DETERMINISTA (solo reglas, sin LLM ni
        // memoria). Existe para el gate de personas del dispatcher: `orchestrate`
        // ya devuelve `route`, pero cuesta entre 90 y 780 ms porque monta el
        // context pack entero, y el hook solo necesita saber si el turno pide
        // trabajo sobre codigo.
        "route" => {
            let prompt = req.prompt.as_deref().unwrap_or("");
            if prompt.trim().is_empty() {
                return (json!({ "error": "empty prompt" }), false);
            }
            let (intent, workflow) = crate::orchestrator::rules::classify_intent(prompt);
            (json!({ "route": intent, "workflow": workflow }), false)
        }
        "skill_query" => {
            // Semantic skill match over `ultron_skills_lazy` (E5 1024d, incl.
            // `.disabled`). Warm in the daemon → sub-second, vs the ~10 s the
            // standalone embed_skills.py paid per process. This is what lets the
            // v3 dispatcher's semantic fallback run inside the hook budget.
            let prompt = req.prompt.as_deref().unwrap_or("");
            if prompt.trim().is_empty() {
                return (json!({ "error": "empty prompt" }), false);
            }
            let top = req.top.unwrap_or(5);
            let hits = crate::memory::catalog::search_skills_lazy(prompt, top);
            match serde_json::to_value(&hits) {
                Ok(v) => (v, false),
                Err(e) => (json!({ "error": format!("serialize: {e}") }), false),
            }
        }
        "orchestrate" => {
            let prompt = req.prompt.as_deref().unwrap_or("");
            if prompt.trim().is_empty() {
                return (json!({ "error": "empty prompt" }), false);
            }
            // UserPromptSubmit hot path: dense por politica (sparse-first vs
            // hibrido E5 ~1.1s warm) — ver hotpath_dense_enabled().
            let ctx = crate::orchestrator::orchestrate(
                prompt,
                req.project.as_deref(),
                hotpath_dense_enabled(),
            );
            match serde_json::to_value(&ctx) {
                Ok(v) => (v, false),
                Err(e) => (json!({ "error": format!("serialize: {e}") }), false),
            }
        }
        // Calentar el catalogo agente/skill EN EL DAEMON. La GUI lo hacia en su
        // propio proceso al arrancar y ese probe bastaba para cargarle E5:
        // 1.522 MB nada mas abrir la ventana, midiera lo que midiera el daemon
        // (2026-08-15). Aqui el modelo ya esta (o se carga una sola vez).
        "warm_catalog" => match crate::memory::catalog::maybe_warm_catalog() {
            Ok((n, errs)) => (json!({ "ok": true, "entities": n, "errors": errs }), false),
            Err(e) => (json!({ "error": e }), false),
        },
        // Recall completo servido por el daemon (2026-08-15). Existe para que
        // NADIE más tenga que cargar E5: la GUI y los one-shot preguntan aquí,
        // donde el modelo ya está caliente, en vez de levantar su propia copia
        // de 1,5 GB (3,2 GB si además entra el cross-encoder).
        "recall" => {
            let query = req.prompt.as_deref().unwrap_or("");
            if query.trim().is_empty() {
                return (json!({ "error": "empty prompt" }), false);
            }
            let top = req.top.unwrap_or(8) as usize;
            let cross = req.cross.unwrap_or(false);
            let rerank = req.rerank.unwrap_or(true);
            match crate::commands::memory::recall_unified::recall_pack(
                query,
                top,
                req.project.as_deref(),
                cross,
                rerank,
            ) {
                Ok(pack) => match serde_json::to_value(&pack) {
                    Ok(v) => (v, false),
                    Err(e) => (json!({ "error": format!("serialize: {e}") }), false),
                },
                Err(e) => (json!({ "error": e }), false),
            }
        }
        // Embedding suelto contra el E5 RESIDENTE (2026-09-10). Existe por el
        // mismo motivo que `recall`: cualquier otro proceso que quiera un vector
        // se traía su propia copia del modelo (~1,5 GB) para una sola consulta.
        // Normalización idéntica a la de las consultas de `recall`/`orchestrate`
        // (`embed_e5(text, true)` -> prefijo "query: "), así que el vector es
        // directamente comparable con lo indexado en Qdrant. Sin texto no hay
        // nada que vectorizar: error antes de tocar el modelo.
        "embed" => {
            let text = req.text.as_deref().unwrap_or("");
            if text.trim().is_empty() {
                return (json!({ "error": "empty_text" }), false);
            }
            match crate::qdrant::embed_e5(text, true) {
                Ok(vector) => {
                    let dim = vector.len();
                    (json!({ "vector": vector, "dim": dim }), false)
                }
                Err(e) => (json!({ "error": e }), false),
            }
        }
        other => (json!({ "error": format!("unknown cmd '{other}'") }), false),
    }
}

/// Politica dense del request 'orchestrate' del daemon (fast-path, check 9.5).
/// dense=true = hibrido completo (E5 query embed ~1.1s warm por request);
/// dense=false = sparse-first (FTS5 + re-ranker, p50 ~134ms) — el presupuesto
/// <300ms del hook solo es alcanzable por este camino. Overrides en runtime:
/// ULTRON_HOTPATH_SPARSE=1 fuerza sparse, ULTRON_HOTPATH_DENSE=1 fuerza dense.
fn hotpath_dense_enabled() -> bool {
    if std::env::var("ULTRON_HOTPATH_DENSE").as_deref() == Ok("1") {
        return true;
    }
    if std::env::var("ULTRON_HOTPATH_SPARSE").as_deref() == Ok("1") {
        return false;
    }
    // Default DENSE, validado contra el oraculo golden (2026-07-22, 29 queries,
    // ambos paths sin rerank como el hook real): sparse-first p@3=0.092 /
    // recall@8=0.164 vs dense p@3=0.414 / recall@8=0.687. La degradacion
    // (-0.32 p@3) multiplica x6 el umbral aceptable (0.05): sparse-first puro
    // es inviable en este corpus; el <300ms del check 9.5 requiere un
    // fast-embedder real (BGE-small), no este atajo.
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(token: Option<&str>, cmd: &str) -> Req {
        Req {
            token: token.map(str::to_string),
            cmd: cmd.to_string(),
            prompt: None,
            project: None,
            top: None,
            cross: None,
            rerank: None,
            text: None,
        }
    }

    #[test]
    fn profile_distill_sin_project_es_error() {
        // Sin proyecto no hay de que hacer perfil: error inmediato, sin tocar
        // ni el store ni la red.
        let mut r = req(Some("t"), "profile_distill");
        r.prompt = Some("README: un proyecto".to_string());
        let started = Instant::now();
        let (resp, shutdown) = handle_request(&r, "t", started);
        assert!(!shutdown);
        assert_eq!(resp["error"], "profile_distill requiere project");
        assert!(started.elapsed().as_millis() < 500);
        let mut vacio = req(Some("t"), "profile_distill");
        vacio.project = Some("   ".to_string());
        let (resp, _) = handle_request(&vacio, "t", Instant::now());
        assert_eq!(resp["error"], "profile_distill requiere project");
    }

    #[test]
    fn lesson_distill_sin_prompt_es_error() {
        let (resp, shutdown) =
            handle_request(&req(Some("t"), "lesson_distill"), "t", Instant::now());
        assert!(!shutdown);
        assert_eq!(resp["error"], "empty prompt");
    }

    #[test]
    fn lesson_distill_con_digest_corto_se_salta_sin_tocar_la_red() {
        // Un digest por debajo del minimo no merece cuota: respuesta inmediata
        // con lista vacia y motivo, sin pasar por la cadena de proveedores.
        let mut r = req(Some("t"), "lesson_distill");
        r.prompt = Some("hola, una pregunta suelta".to_string());
        let started = Instant::now();
        let (resp, _) = handle_request(&r, "t", started);
        assert_eq!(resp["lessons"].as_array().map(|a| a.len()), Some(0));
        assert_eq!(resp["skipped"], "digest sin cuerpo");
        assert!(
            started.elapsed().as_millis() < 500,
            "no debe esperar a ningun proveedor"
        );
    }

    #[test]
    fn ping_with_valid_token_returns_ok() {
        let (resp, shutdown) = handle_request(&req(Some("tok"), "ping"), "tok", Instant::now());
        assert_eq!(resp.get("ok").and_then(Value::as_bool), Some(true));
        assert!(!shutdown);
    }

    #[test]
    fn wrong_token_is_unauthorized() {
        let (resp, shutdown) = handle_request(&req(Some("nope"), "ping"), "tok", Instant::now());
        assert_eq!(
            resp.get("error").and_then(Value::as_str),
            Some("unauthorized")
        );
        assert!(!shutdown);
    }

    #[test]
    fn missing_token_is_unauthorized() {
        let (resp, _) = handle_request(&req(None, "ping"), "tok", Instant::now());
        assert_eq!(
            resp.get("error").and_then(Value::as_str),
            Some("unauthorized")
        );
    }

    #[test]
    fn unknown_cmd_is_rejected() {
        let (resp, shutdown) =
            handle_request(&req(Some("tok"), "frobnicate"), "tok", Instant::now());
        assert!(resp
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("")
            .contains("unknown cmd"));
        assert!(!shutdown);
    }

    #[test]
    fn shutdown_sets_flag() {
        let (resp, shutdown) = handle_request(&req(Some("tok"), "shutdown"), "tok", Instant::now());
        assert_eq!(resp.get("ok").and_then(Value::as_bool), Some(true));
        assert!(shutdown);
    }

    #[test]
    fn empty_prompt_orchestrate_errors_without_touching_e5() {
        // prompt is None -> handled before any embed; hermetic (no Qdrant/E5).
        let (resp, shutdown) =
            handle_request(&req(Some("tok"), "orchestrate"), "tok", Instant::now());
        assert_eq!(
            resp.get("error").and_then(Value::as_str),
            Some("empty prompt")
        );
        assert!(!shutdown);
    }

    #[test]
    fn empty_prompt_skill_query_errors_without_touching_e5() {
        // prompt is None -> handled before any embed; hermetic (no Qdrant/E5).
        let (resp, shutdown) =
            handle_request(&req(Some("tok"), "skill_query"), "tok", Instant::now());
        assert_eq!(
            resp.get("error").and_then(Value::as_str),
            Some("empty prompt")
        );
        assert!(!shutdown);
    }

    #[test]
    fn embed_sin_texto_es_empty_text_sin_tocar_e5() {
        // Campo ausente y campo en blanco toman la MISMA salida temprana: el
        // modelo no se carga ni se consulta, asi que el test es hermetico.
        let started = Instant::now();
        let (resp, shutdown) = handle_request(&req(Some("tok"), "embed"), "tok", started);
        assert_eq!(
            resp.get("error").and_then(Value::as_str),
            Some("empty_text")
        );
        assert!(!shutdown);
        let mut blanco = req(Some("tok"), "embed");
        blanco.text = Some("   \n".to_string());
        let (resp, _) = handle_request(&blanco, "tok", Instant::now());
        assert_eq!(
            resp.get("error").and_then(Value::as_str),
            Some("empty_text")
        );
        assert!(
            started.elapsed().as_millis() < 500,
            "ninguno de los dos debe cargar el modelo"
        );
    }

    #[test]
    fn embed_no_acepta_el_texto_por_el_campo_prompt() {
        // Caso negativo del contrato: `embed` lee SOLO `text`. Un cliente que
        // mande el texto en `prompt` recibe el error, no un vector silencioso
        // de otra cosa.
        let mut r = req(Some("tok"), "embed");
        r.prompt = Some("esto no cuenta".to_string());
        let (resp, _) = handle_request(&r, "tok", Instant::now());
        assert_eq!(
            resp.get("error").and_then(Value::as_str),
            Some("empty_text")
        );
    }

    #[test]
    fn embed_con_token_invalido_no_llega_al_modelo() {
        // El gate de token va ANTES del match: un `embed` no autorizado no
        // puede usarse para forzar la carga de E5.
        let mut r = req(Some("otro"), "embed");
        r.text = Some("texto valido".to_string());
        let started = Instant::now();
        let (resp, _) = handle_request(&r, "tok", started);
        assert_eq!(
            resp.get("error").and_then(Value::as_str),
            Some("unauthorized")
        );
        assert!(started.elapsed().as_millis() < 500);
    }

    #[test]
    fn embed_se_deserializa_del_json_de_la_linea() {
        // Contrato de transporte: el daemon recibe UNA linea JSON. Si el campo
        // `text` no se mapeara, el handler veria None y todo `embed` valido
        // acabaria en "empty_text" — el mismo error que un texto vacio.
        let r: Req =
            serde_json::from_str(r#"{"token":"t","cmd":"embed","text":"hola mundo"}"#).unwrap();
        assert_eq!(r.cmd, "embed");
        assert_eq!(r.text.as_deref(), Some("hola mundo"));
        assert!(r.prompt.is_none(), "`embed` no usa `prompt`");
        // Caso negativo: sin el campo, el Option queda vacio (no falla el parseo).
        let sin: Req = serde_json::from_str(r#"{"token":"t","cmd":"embed"}"#).unwrap();
        assert!(sin.text.is_none());
    }
}
