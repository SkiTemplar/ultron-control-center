// memory/curate.rs — curación puntual de UN item (proyecto y/o título).
//
// Nace del diagnóstico per-query del golden (2026-08-17): 13 de 21 misses eran
// items relevantes con project_id NULL (el down-rank de ambiente los hunde) o
// con títulos inútiles ("Subagente X — resultado", vacío) que el retrieval no
// puede matchear. reassign-project mueve proyectos ENTEROS y el backfill decide
// solo — faltaba el bisturí: un item concreto, cambio auditado, dry-run por
// defecto. Mismo path de escritura que el resto (get_item -> insert_item +
// MemoryEvent + Qdrant), respetando el escritor único.

use super::model::{Actor, EventType, MemoryEvent, Status};
use super::sqlite_store as store;

/// Resuelve un prefijo de id a un id único entre los candidatos dados.
/// Pure — testeable sin DB. Err si 0 o >1 matches (nunca adivina).
pub fn resolve_prefix<'a>(prefix: &str, ids: &'a [String]) -> Result<&'a str, String> {
    let p = prefix.trim();
    if p.len() < 6 {
        return Err(format!("prefijo '{p}' demasiado corto (mínimo 6 chars)"));
    }
    let matches: Vec<&String> = ids.iter().filter(|i| i.starts_with(p)).collect();
    match matches.as_slice() {
        [] => Err(format!("ningún item con prefijo '{p}'")),
        [one] => Ok(one.as_str()),
        many => Err(format!("prefijo '{p}' ambiguo: {} matches", many.len())),
    }
}

/// Cura un item: cambia `project_id` y/o `title`. Dry-run salvo `apply`.
/// Si el título cambia, reindexa el punto denso (el embedding incluye el
/// título: dejarlo viejo sería mentirle al recall).
pub fn curate_item(
    id_prefix: &str,
    project: Option<&str>,
    title: Option<&str>,
    apply: bool,
) -> Result<serde_json::Value, String> {
    if project.is_none() && title.is_none() {
        return Err("curate: nada que cambiar (pasa --project y/o --title)".into());
    }
    let conn = store::open_conn().map_err(|e| e.to_string())?;
    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM memory_items")
            .map_err(|e| e.to_string())?;
        let collected = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        collected
    };
    let id = resolve_prefix(id_prefix, &ids)?.to_string();
    let Some(mut item) = store::get_item(&conn, &id).map_err(|e| e.to_string())? else {
        return Err(format!("item {id} no encontrado"));
    };

    let before_project = item.project_id.clone();
    let before_title = item.title.clone();
    let mut changes: Vec<String> = Vec::new();
    if let Some(p) = project {
        changes.push(format!(
            "project: {} -> {p}",
            before_project.as_deref().unwrap_or("null")
        ));
        item.project_id = Some(p.to_string());
    }
    if let Some(t) = title {
        if t.trim().is_empty() {
            return Err("curate: el título nuevo no puede ser vacío".into());
        }
        changes.push(format!(
            "title: '{}' -> '{t}'",
            before_title.as_deref().unwrap_or("")
        ));
        item.title = Some(t.to_string());
    }

    let mut reindexed = false;
    if apply {
        store::insert_item(&conn, &item).map_err(|e| e.to_string())?;
        let ev = MemoryEvent::new(EventType::Edited, Some(id.clone()), Actor::User)
            .with_reason(format!("curate: {}", changes.join(" · ")));
        let _ = store::insert_event(&conn, &ev);
        if item.status == Status::Active {
            if title.is_some() {
                // Título nuevo = texto nuevo = embedding nuevo.
                super::qdrant_index::index_item(&item)?;
                reindexed = true;
            } else if project.is_some() {
                let _ = crate::qdrant::set_payload(
                    "ultron_memory",
                    &id,
                    serde_json::json!({ "project_id": item.project_id }),
                );
            }
        }
    }

    Ok(serde_json::json!({
        "apply": apply,
        "id": id,
        "changes": changes,
        "reindexed_dense": reindexed,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn resolve_exige_unicidad() {
        let pool = ids(&["abcdef-11", "abcdef-22", "zzzzzz-33"]);
        assert_eq!(resolve_prefix("zzzzzz", &pool).unwrap(), "zzzzzz-33");
        // Caso negativo 1: ambiguo -> error, jamás adivina.
        assert!(resolve_prefix("abcdef", &pool).is_err());
        // Caso negativo 2: sin match.
        assert!(resolve_prefix("qqqqqq", &pool).is_err());
        // Caso negativo 3: prefijo corto (riesgo de match accidental).
        assert!(resolve_prefix("ab", &pool).is_err());
    }
}
