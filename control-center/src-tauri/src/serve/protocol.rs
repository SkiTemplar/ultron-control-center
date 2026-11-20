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
    /// "orchestrate" | "recall" | "route" | "skill_judge" | "lesson_distill" |
    /// "profile_distill" | "ping" | "shutdown". Los campos que ya no existen
    /// (`rerank`, `text`) se ignoran al deserializar.
    pub(super) cmd: String,
    /// Prompt to route / query (orchestrate, recall, route, skill_judge).
    pub(super) prompt: Option<String>,
    /// Project slug for project-scoped recall.
    pub(super) project: Option<String>,
    /// recall: número de entradas del pack (default 8).
    pub(super) top: Option<u32>,
    /// recall: buscar en TODO el cerebro y no solo en el proyecto.
    pub(super) cross: Option<bool>,
    /// recall: medición (doctor, evals, benchmarks) sin telemetría de uso.
    pub(super) diagnostic: Option<bool>,
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
            // Enrutado de skill por LLM sobre el catalogo completo: se le da el
            // catalogo a un flash y se valida la respuesta contra el.
            // Fail-safe: devuelve [] cuando el proveedor no esta.
            let prompt = req.prompt.as_deref().unwrap_or("");
            if prompt.trim().is_empty() {
                return (json!({ "error": "empty prompt" }), false);
            }
            if !crate::orchestrator::skill_llm::merece_consulta(prompt) {
                // `decided: false` -> nadie ha juzgado nada.
                return (
                    json!({ "skills": [], "decided": false, "skipped": "prompt sin cuerpo" }),
                    false,
                );
            }
            // Catalogo completo de skills: el prefiltro denso que lo recortaba
            // se retiro el 2026-11-14. Al juez LLM solo le llega el principio
            // del prompt (`JUEZ_MAX_CHARS`).
            let catalogo = crate::orchestrator::skill_llm::catalogo_desde_disco();
            let prompt = recortar_chars(prompt, JUEZ_MAX_CHARS);
            // `decided` separa "el juez dijo que ninguna encaja" de "no pude
            // preguntarle"; con un solo array vacio eran indistinguibles
            // (2026-09-18).
            let (skills, decided) =
                match crate::orchestrator::skill_llm::elegir_skills_veredicto(prompt, &catalogo) {
                    crate::orchestrator::skill_llm::Veredicto::Decidido(v) => (v, true),
                    crate::orchestrator::skill_llm::Veredicto::NoDisponible => (Vec::new(), false),
                };
            (
                json!({ "skills": skills, "decided": decided, "catalog_size": catalogo.len() }),
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
        "orchestrate" => {
            let prompt = req.prompt.as_deref().unwrap_or("");
            if prompt.trim().is_empty() {
                return (json!({ "error": "empty prompt" }), false);
            }
            // UserPromptSubmit hot path: recall FTS5 + delegación por reglas.
            let ctx = crate::orchestrator::orchestrate(prompt, req.project.as_deref());
            match serde_json::to_value(&ctx) {
                Ok(v) => (v, false),
                Err(e) => (json!({ "error": format!("serialize: {e}") }), false),
            }
        }
        // Recall completo servido por el daemon (2026-08-15); lo piden los
        // clientes de `daemon_client` y el CLI.
        "recall" => {
            let query = req.prompt.as_deref().unwrap_or("");
            if query.trim().is_empty() {
                return (json!({ "error": "empty prompt" }), false);
            }
            let top = req.top.unwrap_or(8) as usize;
            let cross = req.cross.unwrap_or(false);
            let pack = if req.diagnostic.unwrap_or(false) {
                crate::commands::memory::recall_unified::recall_pack_diagnostic
            } else {
                crate::commands::memory::recall_unified::recall_pack
            };
            match pack(query, top, req.project.as_deref(), cross) {
                Ok(pack) => match serde_json::to_value(&pack) {
                    Ok(v) => (v, false),
                    Err(e) => (json!({ "error": format!("serialize: {e}") }), false),
                },
                Err(e) => (json!({ "error": e }), false),
            }
        }
        other => (json!({ "error": format!("unknown cmd '{other}'") }), false),
    }
}

/// Caracteres del prompt que ve el juez LLM de `skill_judge`: el cliente manda
/// el prompt entero y el recorte del texto que va al proveedor se hace aquí.
const JUEZ_MAX_CHARS: usize = 500;

/// Los primeros `max` caracteres (no bytes: nunca parte un carácter UTF-8).
fn recortar_chars(texto: &str, max: usize) -> &str {
    match texto.char_indices().nth(max) {
        Some((corte, _)) => &texto[..corte],
        None => texto,
    }
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
            diagnostic: None,
        }
    }

    #[test]
    fn recortar_chars_corta_por_caracteres_y_no_por_bytes() {
        assert_eq!(recortar_chars("hola", 10), "hola");
        assert_eq!(recortar_chars("hola", 2), "ho");
        // Multibyte: cortar por bytes partiría la ñ y haría pánico.
        assert_eq!(recortar_chars("añoñé", 3), "año");
        assert_eq!(recortar_chars("", 5), "");
        assert_eq!(recortar_chars(&"x".repeat(600), JUEZ_MAX_CHARS).len(), 500);
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
    fn empty_prompt_orchestrate_errors_before_any_work() {
        // prompt is None -> handled before touching the store; hermetic.
        let (resp, shutdown) =
            handle_request(&req(Some("tok"), "orchestrate"), "tok", Instant::now());
        assert_eq!(
            resp.get("error").and_then(Value::as_str),
            Some("empty prompt")
        );
        assert!(!shutdown);
    }

    #[test]
    fn retired_dense_cmds_are_unknown() {
        // La ruta densa se retiró el 2026-11-14: `embed`, `skill_query` y
        // `warm_catalog` ya no existen y un cliente viejo recibe el error, no
        // un vector cero ni una lista vacía silenciosa.
        for cmd in ["embed", "skill_query", "warm_catalog"] {
            let mut r = req(Some("tok"), cmd);
            r.prompt = Some("hola".to_string());
            let (resp, shutdown) = handle_request(&r, "tok", Instant::now());
            assert!(
                resp.get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .contains("unknown cmd"),
                "{cmd} debe ser desconocido"
            );
            assert!(!shutdown);
        }
    }

    #[test]
    fn old_clients_sending_rerank_or_text_still_parse() {
        // Los campos retirados (`rerank`, `text`) se ignoran al deserializar:
        // un hook que aún los mande sigue funcionando.
        let r: Req = serde_json::from_str(
            r#"{"token":"t","cmd":"recall","prompt":"q","rerank":true,"text":"x"}"#,
        )
        .unwrap();
        assert_eq!(r.cmd, "recall");
        assert_eq!(r.prompt.as_deref(), Some("q"));
    }
}
