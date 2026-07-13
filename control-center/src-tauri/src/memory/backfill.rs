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
//   3. DENSE VOTE — items NULL ACTIVE restantes, usando su vector YA
//      almacenado en Qdrant: k-NN filtrado a vecinos CON proyecto y voto
//      ponderado por score con umbral doble (mejor vecino del ganador >=
//      min_score Y cuota ponderada >= min_share). Sin señal suficiente el
//      item se QUEDA NULL: mejor ambiente que mal etiquetado (un falso
//      positivo lo escondería del proyecto al que sí pertenece).
//
// Escritura vía get_item -> insert_item (mismo path que el service, FTS en
// sync) + MemoryEvent por item + set_payload en Qdrant (el filtro denso por
// proyecto lee el payload). updated_at NO se toca (cambiarlo regalaría el
// recency-boost del ranking a items viejos). brain.db sigue siendo la SoT.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use super::model::{Actor, EventType, MemoryEvent, Status};
use super::sqlite_store as store;

/// Colección densa canónica (la misma que qdrant_index::COLLECTION).
const COLLECTION: &str = "ultron_memory";

/// Umbrales por defecto del voto denso. E5 comprime los cosenos (~0.75-0.95
/// para texto relacionado). 0.90 calibrado con muestra real (2026-07-13):
/// los items genuinos del proyecto votan a 0.90-0.93; la prosa FORMULAICA de
/// agente ("He verificado en runtime...", resúmenes de sesión) matchea items
/// de OTROS proyectos a 0.85-0.89 — y una etiqueta mal puesta es PEOR que
/// NULL (esconde el item de su proyecto real vía el gate del pack). 0.6 exige
/// además mayoría ponderada clara entre los vecinos etiquetados.
pub const DEFAULT_MIN_SCORE: f32 = 0.90;
pub const DEFAULT_MIN_SHARE: f32 = 0.6;
pub const DEFAULT_KNN: u32 = 8;

#[derive(Debug, Clone)]
pub struct BackfillOpts {
    /// false = dry-run (solo cuenta y muestrea, no escribe nada).
    pub apply: bool,
    pub min_score: f32,
    pub min_share: f32,
    pub knn: u32,
}

impl Default for BackfillOpts {
    fn default() -> Self {
        Self {
            apply: false,
            min_score: DEFAULT_MIN_SCORE,
            min_share: DEFAULT_MIN_SHARE,
            knn: DEFAULT_KNN,
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

/// Voto ponderado del dense k-NN. `neighbors` = (project_id, score) de vecinos
/// YA etiquetados. Gana `Some(project)` solo si su mejor vecino alcanza
/// `min_score` Y su cuota ponderada (suma de scores) alcanza `min_share`.
/// Pure — unit-testeada sin Qdrant.
#[must_use]
pub fn vote_project(neighbors: &[(String, f32)], min_score: f32, min_share: f32) -> Option<String> {
    if neighbors.is_empty() {
        return None;
    }
    let mut weight: HashMap<&str, f32> = HashMap::new();
    let mut best: HashMap<&str, f32> = HashMap::new();
    let mut total = 0.0_f32;
    for (proj, score) in neighbors {
        *weight.entry(proj.as_str()).or_default() += score;
        let b = best.entry(proj.as_str()).or_default();
        if *score > *b {
            *b = *score;
        }
        total += score;
    }
    if total <= 0.0 {
        return None;
    }
    let (winner, w) = weight
        .iter()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))?;
    let share = w / total;
    if share >= min_share && best.get(winner).copied().unwrap_or(0.0) >= min_score {
        Some((*winner).to_string())
    } else {
        None
    }
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

/// Reetiqueta un item (SQLite + evento + payload Qdrant best-effort). El
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
    store::insert_item(conn, &item).map_err(|e| e.to_string())?;
    let ev = MemoryEvent::new(EventType::Edited, Some(id.to_string()), Actor::System).with_reason(
        format!("backfill-projects ({phase}): {before} -> {project}"),
    );
    let _ = store::insert_event(conn, &ev);
    // Qdrant: solo los ACTIVE tienen punto; un miss/fallo no aborta el backfill
    // (reindex_all reconstruye payloads de todos modos).
    if item.status == Status::Active {
        let _ = crate::qdrant::set_payload(
            COLLECTION,
            id,
            serde_json::json!({ "project_id": project }),
        );
    }
    Ok(())
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

    // ---- Fase 3: DENSE VOTE (vector almacenado + k-NN etiquetado) ----------
    let (mut by_vote, mut no_vector, mut no_consensus) = (0u32, 0u32, 0u32);
    let mut vote_dist: HashMap<String, u32> = HashMap::new();
    {
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
        // Vecinos = CUALQUIER punto etiquetado (is_empty=false). El plegado a
        // slug canónico se hace cliente-side abajo: si el filtro exigiera solo
        // slugs ya-canónicos, en dry-run (normalize aún sin aplicar) los
        // vecinos 'Procedural Terrain'/'Tortunabo' quedarían fuera del pool y
        // el voto saldría sesgado hacia el proyecto dominante.
        let filter = serde_json::json!({
            "must_not": [{ "is_empty": { "key": "project_id" } }]
        });
        for id in ids {
            let Ok(Some(vector)) = crate::qdrant::get_point_vector(COLLECTION, &id) else {
                no_vector += 1;
                continue;
            };
            let hits = crate::qdrant::search_with_vector(
                COLLECTION,
                vector,
                opts.knn,
                Some(filter.clone()),
            )
            .unwrap_or_default();
            let neighbors: Vec<(String, f32)> = hits
                .into_iter()
                .filter(|h| h.id != id)
                .filter_map(|h| {
                    h.payload
                        .get("project_id")
                        .and_then(|v| v.as_str())
                        .map(|p| (slugify(p), h.score))
                })
                .filter(|(p, _)| canon.contains(p))
                .collect();
            match vote_project(&neighbors, opts.min_score, opts.min_share) {
                Some(proj) => {
                    push_sample("dense-vote", &id, &proj, "");
                    if opts.apply {
                        set_item_project(&conn, &id, &proj, "dense-vote")?;
                    }
                    *vote_dist.entry(proj).or_default() += 1;
                    by_vote += 1;
                }
                None => no_consensus += 1,
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
        "min_score": opts.min_score,
        "min_share": opts.min_share,
        "knn": opts.knn,
        "normalized": normalized,
        "by_provenance": by_provenance,
        "by_dense_vote": by_vote,
        "vote_distribution": vote_dist,
        "no_vector": no_vector,
        "no_consensus_kept_null": no_consensus,
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

    #[test]
    fn vote_assigns_on_clear_majority_with_strong_best() {
        let n = vec![
            ("procedural-terrain".into(), 0.91),
            ("procedural-terrain".into(), 0.89),
            ("ultron".into(), 0.80),
        ];
        assert_eq!(
            vote_project(&n, DEFAULT_MIN_SCORE, DEFAULT_MIN_SHARE).as_deref(),
            Some("procedural-terrain")
        );
    }

    #[test]
    fn vote_keeps_null_when_best_neighbor_is_weak() {
        // Mayoría clara pero vecindad floja (< min_score): tema vago, no
        // contenido compartido -> mejor ambiente que mal etiquetado.
        let n = vec![
            ("ultron".into(), 0.84),
            ("ultron".into(), 0.83),
            ("ultron".into(), 0.82),
        ];
        assert_eq!(vote_project(&n, DEFAULT_MIN_SCORE, DEFAULT_MIN_SHARE), None);
    }

    #[test]
    fn vote_keeps_null_when_projects_split() {
        // Vecinos fuertes pero repartidos: sin cuota ganadora no se etiqueta.
        let n = vec![
            ("ultron".into(), 0.90),
            ("tortunabo".into(), 0.90),
            ("procedural-terrain".into(), 0.89),
        ];
        assert_eq!(vote_project(&n, DEFAULT_MIN_SCORE, DEFAULT_MIN_SHARE), None);
    }

    #[test]
    fn vote_empty_neighbors_is_null() {
        assert_eq!(
            vote_project(&[], DEFAULT_MIN_SCORE, DEFAULT_MIN_SHARE),
            None
        );
    }
}
