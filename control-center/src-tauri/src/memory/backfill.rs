// memory/backfill.rs — backfill de project_id para el corpus AMBIENTE (NULL).
//
// (2026-07-13) El ~80% del corpus (3567/~4400 items) es legado sin project_id
// (anterior al estampado de --project en la captura). La regla ambiente del
// recall (pack.rs) los hace visibles en TODOS los proyectos, y el down-rank
// (ULTRON_AMBIENT_PENALTY) solo los hunde cuando compiten con memoria local:
// el fix de raíz es etiquetarlos. Tres fases, dry-run por defecto (--apply):
//
//   1. NORMALIZE — variantes de casing/espacios de un slug canónico existente
//      se pliegan a él ('Tortunabo' -> 'tortunabo', 'Procedural Terrain' ->
//      'procedural-terrain'). Canónico = subdir de cockpit/projects/ cuyo
//      nombre ya es su propio slug. Ids raros ('src', nombres de usuario, 'wf_*',
//      '__kirkardo_test__') NO se tocan: se reportan.
//   2. PROVENANCE — items NULL cuyo source_session_id vive en
//      cockpit/projects/<p>/sessions/<sid>/ heredan ese proyecto
//      (determinista: la sesión se compactó bajo ese proyecto).
//   3. LLM (solo con --llm) — items NULL ACTIVE restantes, clasificados por
//      lotes con Groq. Sin confianza alta el item se QUEDA NULL: mejor
//      ambiente que mal etiquetado (un falso positivo lo escondería del
//      proyecto al que sí pertenece). (El voto denso por k-NN que había entre
//      PROVENANCE y LLM se retiró el 2026-11-14 con la ruta densa.)
//
// Escritura vía get_item -> insert_item (mismo path que el service, FTS en
// sync) + MemoryEvent por item. updated_at NO se toca (cambiarlo regalaría el
// recency-boost del ranking a items viejos). brain.db sigue siendo la SoT.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use super::model::{Actor, EventType, MemoryEvent};
use super::sqlite_store as store;

/// Umbral de confianza del clasificador LLM (fase 3): una etiqueta mal puesta
/// es peor que NULL, así que solo se aceptan asignaciones que el modelo declara
/// con confianza alta.
pub const DEFAULT_LLM_MIN_CONF: f32 = 0.8;
/// Tamaño de lote para la fase LLM (limita el prompt y respeta el rate limit
/// del free tier de Groq: ~32 lotes para el stock actual de ~639 huérfanos).
const LLM_BATCH_SIZE: usize = 20;

#[derive(Debug, Clone)]
pub struct BackfillOpts {
    /// false = dry-run (solo cuenta y muestrea, no escribe nada).
    pub apply: bool,
    /// Fase 3: clasificador LLM batch para los NULL que las fases 1-2 no
    /// resolvieron (decisión del usuario 2026-08-15; card del kanban 2026-08-11).
    pub llm: bool,
    pub llm_min_conf: f32,
}

impl Default for BackfillOpts {
    fn default() -> Self {
        Self {
            apply: false,
            llm: false,
            llm_min_conf: DEFAULT_LLM_MIN_CONF,
        }
    }
}

/// Slug canónico de un id de proyecto: minúsculas + espacios/underscores a '-'.
/// El mismo criterio que producen los dirs canónicos del cockpit.
#[must_use]
pub fn slugify(s: &str) -> String {
    s.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .replace('_', "-")
}

fn projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron").join("cockpit").join("projects"))
}

/// Slugs canónicos: subdirs de cockpit/projects/ cuyo nombre YA es su slug
/// (así 'Procedural Terrain' — que coexiste con 'procedural-terrain' — no
/// cuenta como canónico y se pliega al slug).
fn canonical_slugs() -> HashSet<String> {
    let Some(dir) = projects_dir() else {
        return HashSet::new();
    };
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return HashSet::new();
    };
    rd.filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| slugify(n) == *n)
        .collect()
}

/// Mapa session_id -> proyecto canónico, desde cockpit/projects/<p>/sessions/.
/// Los proyectos no-canónicos se pliegan vía slugify si el slug es canónico.
fn session_project_map(canon: &HashSet<String>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(dir) = projects_dir() else {
        return map;
    };
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return map;
    };
    for proj_entry in rd.filter_map(Result::ok) {
        let Ok(proj_name) = proj_entry.file_name().into_string() else {
            continue;
        };
        let slug = slugify(&proj_name);
        if !canon.contains(&slug) {
            continue; // proyecto basura/no canónico: no hereda nada
        }
        let sessions = proj_entry.path().join("sessions");
        let Ok(srd) = std::fs::read_dir(&sessions) else {
            continue;
        };
        for s in srd.filter_map(Result::ok) {
            if let Ok(sid) = s.file_name().into_string() {
                map.insert(sid, slug.clone());
            }
        }
    }
    map
}

/// Reetiqueta un item (SQLite + evento). El
/// updated_at se conserva. Devuelve Err solo si la escritura SQLite falla.
fn set_item_project(
    conn: &rusqlite::Connection,
    id: &str,
    project: &str,
    phase: &str,
) -> Result<(), String> {
    let Some(mut item) = store::get_item(conn, id).map_err(|e| e.to_string())? else {
        return Err(format!("item {id} desapareció durante el backfill"));
    };
    let before = item.project_id.clone().unwrap_or_else(|| "null".into());
    item.project_id = Some(project.to_string());
    let ev = MemoryEvent::new(EventType::Edited, Some(id.to_string()), Actor::System).with_reason(
        format!("backfill-projects ({phase}): {before} -> {project}"),
    );
    store::insert_item_with_event(conn, &item, &ev).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Fase 3 — clasificador LLM batch (Groq, mismo proveedor que el Stop hook)
// ---------------------------------------------------------------------------

/// `GROQ_API_KEY` desde el entorno, con fallback a `~/.ultron/.env` (el sidecar
/// no carga dotenvy; los contextos de hook/cron pueden no heredar la variable).
fn groq_api_key() -> Option<String> {
    if let Ok(k) = std::env::var("GROQ_API_KEY") {
        if !k.trim().is_empty() {
            return Some(k.trim().to_string());
        }
    }
    let env_path = dirs::home_dir()?.join(".ultron").join(".env");
    let body = std::fs::read_to_string(env_path).ok()?;
    body.lines().find_map(|l| {
        let l = l.trim();
        l.strip_prefix("GROQ_API_KEY=")
            .map(|v| v.trim_matches('"').trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

/// Parsea la respuesta del LLM y aplica el gate: solo asignaciones con
/// `project` canónico y `confidence >= min_conf`. Tolera fences de markdown.
/// Pure — unit-testeada sin red.
#[must_use]
pub fn parse_llm_assignments(
    text: &str,
    canon: &HashSet<String>,
    min_conf: f32,
) -> Vec<(String, String)> {
    let start = text.find('{');
    let end = text.rfind('}');
    let (Some(s), Some(e)) = (start, end) else {
        return Vec::new();
    };
    if e < s {
        return Vec::new();
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text[s..=e]) else {
        return Vec::new();
    };
    let Some(rows) = v.get("assignments").and_then(|a| a.as_array()) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|r| {
            let id = r.get("id")?.as_str()?.to_string();
            let proj = slugify(r.get("project")?.as_str()?);
            let conf = r.get("confidence")?.as_f64()? as f32;
            (conf >= min_conf && canon.contains(&proj)).then_some((id, proj))
        })
        .collect()
}

const LLM_CLASSIFY_PROMPT: &str = "You are classifying memory items of a personal dev knowledge base into projects.\n\
Valid project slugs (assign ONLY from this list):\n{PROJECTS}\n\n\
For each item below, decide which project it belongs to. If the text does not \
clearly belong to one project, use null (ambient is better than mislabeled).\n\
Return ONLY valid JSON: {\"assignments\":[{\"id\":\"<id>\",\"project\":\"<slug or null>\",\"confidence\":0.0-1.0}]}\n\n\
Items:\n{ITEMS}";

/// Un lote contra Groq (blocking, ureq). Devuelve el content del choice 0.
/// El free tier limita por TPM (~6k para llama-3.3-70b): un 429 lleva
/// `retry-after`; se respeta con hasta 3 reintentos antes de rendirse.
fn llm_classify_batch(
    items: &[(String, String)],
    canon: &HashSet<String>,
    api_key: &str,
) -> Result<String, String> {
    let mut slugs: Vec<&str> = canon.iter().map(String::as_str).collect();
    slugs.sort_unstable();
    let items_txt = items
        .iter()
        .map(|(id, text)| format!("- id={id}: {text}"))
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = LLM_CLASSIFY_PROMPT
        .replace("{PROJECTS}", &slugs.join(", "))
        .replace("{ITEMS}", &items_txt);
    // Modelo actualizado 2026-08-17: Groq retiró llama-3.3-70b-versatile (404
    // en chat/completions, 33/33 lotes fallidos en el primer run real). El
    // catálogo de producción vigente es gpt-oss; el 120b es el flagship y esta
    // tarea adjudica proyectos (calidad > ahorro). max_tokens 1024 -> 2048:
    // gpt-oss razona antes de responder y el razonamiento consume output.
    let payload = serde_json::json!({
        "model": "openai/gpt-oss-120b",
        "temperature": 0,
        "max_tokens": 2048,
        "messages": [{ "role": "user", "content": prompt }],
    });
    let mut last_err = String::new();
    for _attempt in 0..3 {
        let result = ureq::post("https://api.groq.com/openai/v1/chat/completions")
            .timeout(std::time::Duration::from_secs(30))
            .set("Authorization", &format!("Bearer {api_key}"))
            .send_json(payload.clone());
        match result {
            Ok(resp) => {
                let body: serde_json::Value =
                    resp.into_json().map_err(|e| format!("groq body: {e}"))?;
                return body
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("message"))
                    .and_then(|m| m.get("content"))
                    .and_then(|t| t.as_str())
                    .map(ToString::to_string)
                    .ok_or_else(|| "groq: respuesta sin choices[0].message.content".into());
            }
            Err(ureq::Error::Status(429, resp)) => {
                let wait = resp
                    .header("retry-after")
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(30)
                    .min(120);
                last_err = format!("groq: 429 (retry-after {wait}s)");
                std::thread::sleep(std::time::Duration::from_secs(wait + 1));
            }
            Err(e) => return Err(format!("groq: {e}")),
        }
    }
    Err(last_err)
}

/// Reasigna TODOS los items de un `project_id` a otro. Curación puntual de ids
/// legado que el normalize no puede plegar por slug ('Entorno-Oryntic' ->
/// 'oryntics-entorno'). El destino debe ser un slug canónico del cockpit
/// (no se permite inventar proyectos). Dry-run salvo `apply`.
pub fn reassign_project(from: &str, to: &str, apply: bool) -> Result<serde_json::Value, String> {
    let canon = canonical_slugs();
    if !canon.contains(to) {
        return Err(format!(
            "'{to}' no es un slug canónico de cockpit/projects — destino rechazado"
        ));
    }
    let conn = store::open_conn().map_err(|e| e.to_string())?;
    let ids: Vec<String> = {
        let mut s = conn
            .prepare("SELECT id FROM memory_items WHERE project_id = ?1")
            .map_err(|e| e.to_string())?;
        let collected: Vec<String> = s
            .query_map([from], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        collected
    };
    if apply {
        for id in &ids {
            set_item_project(&conn, id, to, "reassign")?;
        }
    }
    Ok(serde_json::json!({
        "apply": apply, "from": from, "to": to, "reassigned": ids.len(),
    }))
}

/// Ejecuta el backfill completo. Devuelve el informe JSON (contadores + muestras).
pub fn run(opts: &BackfillOpts) -> Result<serde_json::Value, String> {
    let conn = store::open_conn().map_err(|e| e.to_string())?;
    let canon = canonical_slugs();
    if canon.is_empty() {
        return Err("sin slugs canónicos en cockpit/projects — nada que backfillear".into());
    }

    let mut samples: Vec<serde_json::Value> = Vec::new();
    let mut push_sample = |phase: &str, id: &str, to: &str, extra: &str| {
        if samples.len() < 25 {
            samples.push(serde_json::json!({
                "phase": phase, "id": id, "to": to, "note": extra,
            }));
        }
    };

    // ---- Fase 1: NORMALIZE (variantes -> slug canónico) --------------------
    let mut normalized = 0u32;
    let mut skipped_odd_ids: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT project_id, COUNT(*) FROM memory_items \
                 WHERE project_id IS NOT NULL GROUP BY project_id",
            )
            .map_err(|e| e.to_string())?;
        let labeled: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        for (pid, count) in labeled {
            let slug = slugify(&pid);
            if slug == pid {
                continue; // ya canónico (o al menos ya slug)
            }
            if !canon.contains(&slug) {
                skipped_odd_ids.insert(pid, count);
                continue; // variante sin canónico conocido: reportar, no tocar
            }
            let ids: Vec<String> = {
                let mut s = conn
                    .prepare("SELECT id FROM memory_items WHERE project_id = ?1")
                    .map_err(|e| e.to_string())?;
                let collected: Vec<String> = s
                    .query_map([&pid], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .filter_map(Result::ok)
                    .collect();
                collected
            };
            for id in ids {
                push_sample("normalize", &id, &slug, &pid);
                if opts.apply {
                    set_item_project(&conn, &id, &slug, "normalize")?;
                }
                normalized += 1;
            }
        }
    }

    // ---- Fase 2: PROVENANCE (source_session_id -> proyecto del cockpit) ----
    let sid_map = session_project_map(&canon);
    let mut by_provenance = 0u32;
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, source_session_id FROM memory_items \
                 WHERE project_id IS NULL AND source_session_id IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        for (id, sid) in rows {
            if let Some(proj) = sid_map.get(&sid) {
                push_sample("provenance", &id, proj, &sid);
                if opts.apply {
                    set_item_project(&conn, &id, proj, "provenance")?;
                }
                by_provenance += 1;
            }
        }
    }

    // ---- Fase 3: LLM BATCH (solo con --llm) --------------------------------
    // Clasifica con Groq los NULL ACTIVE que las fases 1-2 no resolvieron.
    // Principio conservador: sin confianza alta o con slug fuera del catálogo
    // canónico, el item se QUEDA NULL. (El voto denso por k-NN que iba antes
    // se retiró el 2026-11-14 con la ruta densa.)
    let unresolved: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM memory_items \
                 WHERE project_id IS NULL AND status = 'active'",
            )
            .map_err(|e| e.to_string())?;
        let ids: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        ids
    };
    let (mut by_llm, mut llm_abstained, mut llm_errors) = (0u32, 0u32, 0u32);
    let mut llm_dist: HashMap<String, u32> = HashMap::new();
    // Primer error textual de la fase LLM: sin esto, 33 lotes fallidos son un
    // contador mudo imposible de diagnosticar (mandamiento 11).
    let mut llm_first_error: Option<String> = None;
    if opts.llm && !unresolved.is_empty() {
        let Some(key) = groq_api_key() else {
            return Err(
                "fase LLM pedida (--llm) pero sin GROQ_API_KEY (env ni ~/.ultron/.env)".into(),
            );
        };
        // Texto por item: title + summary (lo que se inyecta en prompts).
        let mut batch: Vec<(String, String)> = Vec::new();
        for id in &unresolved {
            let Ok(Some(item)) = store::get_item(&conn, id) else {
                continue;
            };
            let text: String = [item.title.as_deref(), item.summary.as_deref()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" — ")
                .chars()
                .take(240)
                .collect();
            if text.trim().is_empty() {
                llm_abstained += 1; // sin texto no hay señal: se queda NULL
                continue;
            }
            batch.push((id.clone(), text));
        }
        let mut last_llm_err: Option<String> = None;
        for (i, chunk) in batch.chunks(LLM_BATCH_SIZE).enumerate() {
            if i > 0 {
                // El cuello real del free tier es el TPM (~6k), no el RPM:
                // cada lote consume ~3k tokens (prompt + max_tokens), así que
                // ~2 lotes/min. 30s entre lotes + retry-after en el 429.
                std::thread::sleep(std::time::Duration::from_secs(30));
            }
            let content = match llm_classify_batch(chunk, &canon, &key) {
                Ok(c) => c,
                Err(e) => {
                    llm_errors += 1;
                    // Fail-fast (2026-08-17): un error IDÉNTICO al anterior es
                    // sistémico (modelo retirado -> 404, key inválida -> 401),
                    // no transitorio: seguir machacando repite el mismo fallo
                    // en cada lote con 30s de sleep entre medias (medido: 33
                    // lotes x 404 = ~16 min para no clasificar nada). Dos
                    // seguidos idénticos -> se aborta el resto de la fase; el
                    // JSON de salida ya reporta llm_first_error y el contador.
                    let repeated = last_llm_err.as_deref() == Some(e.as_str());
                    last_llm_err = Some(e.clone());
                    llm_first_error.get_or_insert(e);
                    if repeated {
                        llm_errors += (batch.chunks(LLM_BATCH_SIZE).count() - i - 1) as u32;
                        break;
                    }
                    continue;
                }
            };
            let assigned = parse_llm_assignments(&content, &canon, opts.llm_min_conf);
            let assigned_ids: HashSet<&str> = assigned.iter().map(|(id, _)| id.as_str()).collect();
            llm_abstained += chunk
                .iter()
                .filter(|(id, _)| !assigned_ids.contains(id.as_str()))
                .count() as u32;
            for (id, proj) in assigned {
                // El LLM solo puede etiquetar ids DE ESTE lote (un id inventado
                // o repetido de otro lote no escribe nada).
                if !chunk.iter().any(|(cid, _)| cid == &id) {
                    continue;
                }
                push_sample("llm", &id, &proj, "");
                if opts.apply {
                    set_item_project(&conn, &id, &proj, "llm")?;
                }
                *llm_dist.entry(proj).or_default() += 1;
                by_llm += 1;
            }
        }
    }

    let remaining_null: i64 = if opts.apply {
        conn.query_row(
            "SELECT COUNT(*) FROM memory_items WHERE project_id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap_or(-1)
    } else {
        -1 // dry-run: nada cambió; el conteo real solo tiene sentido tras aplicar
    };

    Ok(serde_json::json!({
        "apply": opts.apply,
        "normalized": normalized,
        "by_provenance": by_provenance,
        "unresolved_after_provenance": unresolved.len(),
        "llm_enabled": opts.llm,
        "by_llm": by_llm,
        "llm_distribution": llm_dist,
        "llm_abstained_kept_null": llm_abstained,
        "llm_batch_errors": llm_errors,
        "llm_first_error": llm_first_error,
        "skipped_odd_project_ids": skipped_odd_ids,
        "remaining_null_after_apply": remaining_null,
        "samples": samples,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_folds_case_and_spaces() {
        assert_eq!(slugify("Tortunabo"), "tortunabo");
        assert_eq!(slugify("Procedural Terrain"), "procedural-terrain");
        assert_eq!(slugify("  ia_template "), "ia-template");
        assert_eq!(slugify("procedural-terrain"), "procedural-terrain");
    }

    fn canon_fixture() -> HashSet<String> {
        ["ultron", "tortunabo"]
            .iter()
            .map(|s| (*s).into())
            .collect()
    }

    #[test]
    fn llm_parse_accepts_confident_canonical() {
        let text = r#"{"assignments":[{"id":"m1","project":"ultron","confidence":0.92}]}"#;
        assert_eq!(
            parse_llm_assignments(text, &canon_fixture(), DEFAULT_LLM_MIN_CONF),
            vec![("m1".to_string(), "ultron".to_string())]
        );
    }

    #[test]
    fn llm_parse_rejects_low_confidence_and_invented_project() {
        // Confianza bajo el gate Y proyecto fuera del catálogo: ambos NULL.
        let text = r#"{"assignments":[
            {"id":"m1","project":"ultron","confidence":0.5},
            {"id":"m2","project":"proyecto-inventado","confidence":0.99}
        ]}"#;
        assert!(parse_llm_assignments(text, &canon_fixture(), DEFAULT_LLM_MIN_CONF).is_empty());
    }

    #[test]
    fn llm_parse_folds_slug_and_tolerates_fences() {
        // El modelo devuelve casing raro y fences de markdown: se pliega y parsea.
        let text = "```json\n{\"assignments\":[{\"id\":\"m3\",\"project\":\"Tortunabo\",\"confidence\":0.9}]}\n```";
        assert_eq!(
            parse_llm_assignments(text, &canon_fixture(), DEFAULT_LLM_MIN_CONF),
            vec![("m3".to_string(), "tortunabo".to_string())]
        );
    }

    #[test]
    fn llm_parse_broken_json_and_null_project_yield_nothing() {
        assert!(parse_llm_assignments("no json here", &canon_fixture(), 0.8).is_empty());
        let nulls = r#"{"assignments":[{"id":"m4","project":null,"confidence":0.9}]}"#;
        assert!(parse_llm_assignments(nulls, &canon_fixture(), 0.8).is_empty());
    }
}
