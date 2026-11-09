// sqlite_store/id_prefix.rs — prefijos de id del CLI del sidecar
// (`forget|deprecate --id`, `inbox approve|reject --id`).
//
// Antes la búsqueda era `id LIKE '<prefijo>%'` sin escapar: `%` o `_` en el
// prefijo actuaban como comodines, LIKE no distingue mayúsculas en ASCII y el
// llamante aceptaba un prefijo de 1 carácter (el comentario de `forget` pedía
// 4). Ahora la búsqueda compara los primeros caracteres literalmente y un
// prefijo necesita al menos `MIN_ID_PREFIX_CHARS`; un id completo pasa siempre.

use rusqlite::{params, Connection};

use crate::memory::MemoryError;

/// Mínimo de caracteres de un prefijo que no es un id completo.
pub const MIN_ID_PREFIX_CHARS: usize = 4;

/// Tablas con ids resolubles por prefijo.
#[derive(Debug, Clone, Copy)]
pub(crate) enum IdTable {
    Items,
    Candidates,
}

impl IdTable {
    fn sql(self) -> &'static str {
        match self {
            Self::Items => "SELECT id FROM memory_items WHERE substr(id, 1, ?2) = ?1",
            Self::Candidates => "SELECT id FROM memory_candidates WHERE substr(id, 1, ?2) = ?1",
        }
    }
}

/// Ids de `table` cuyos primeros caracteres son exactamente `prefix`
/// (sensible a mayúsculas y sin comodines).
pub(crate) fn ids_starting_with(
    conn: &Connection,
    table: IdTable,
    prefix: &str,
) -> Result<Vec<String>, MemoryError> {
    let len = i64::try_from(prefix.chars().count()).unwrap_or(i64::MAX);
    let fail = |stage: &str, e: rusqlite::Error| {
        MemoryError::RemoteUnavailable(format!("ids_starting_with {table:?} {stage}: {e}"))
    };
    let mut stmt = conn.prepare(table.sql()).map_err(|e| fail("prepare", e))?;
    let rows = stmt
        .query_map(params![prefix, len], |r| r.get::<_, String>(0))
        .map_err(|e| fail("query", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| fail("row", e))
}

/// Elige el único id de `matches` para `prefix`. Un id completo gana aunque
/// otros ids lo contengan como prefijo; si no, el prefijo debe tener al menos
/// `MIN_ID_PREFIX_CHARS` caracteres y casar con exactamente un id. `what`
/// nombra la entidad en los mensajes ("item", "candidate").
pub fn resolve_unique_id(prefix: &str, matches: Vec<String>, what: &str) -> Result<String, String> {
    let prefix = prefix.trim();
    if prefix.is_empty() {
        return Err("--id must not be empty".to_string());
    }
    if matches.iter().any(|id| id == prefix) {
        return Ok(prefix.to_string());
    }
    if prefix.chars().count() < MIN_ID_PREFIX_CHARS {
        return Err(format!(
            "id prefix '{prefix}' is too short: use at least {MIN_ID_PREFIX_CHARS} characters or the full id"
        ));
    }
    let mut matches = matches;
    match matches.len() {
        0 => Err(format!("no {what} found with id prefix '{prefix}'")),
        1 => Ok(matches.remove(0)),
        n => Err(format!(
            "prefix '{prefix}' is ambiguous — matches {n} {what}s; use a longer prefix"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::model::{MemoryItem, MemoryType, Scope, Source, Status};

    fn conn_with(ids: &[&str]) -> Connection {
        let conn = super::super::tests::mem_conn();
        for id in ids {
            let mut item = MemoryItem::new(
                MemoryType::Fact,
                Scope::Global,
                Source::UserExplicit,
                Status::Active,
            );
            item.id = (*id).to_string();
            item.summary = Some(format!("item {id}"));
            super::super::items::insert_item(&conn, &item).expect("insert");
        }
        conn
    }

    fn find(conn: &Connection, prefix: &str) -> Vec<String> {
        let mut ids = ids_starting_with(conn, IdTable::Items, prefix).expect("query");
        ids.sort();
        ids
    }

    #[test]
    fn los_comodines_de_like_no_casan() {
        let conn = conn_with(&["7cd41c41-aaaa", "7cd4_x", "8abc0000"]);
        assert_eq!(find(&conn, "7cd4"), vec!["7cd41c41-aaaa", "7cd4_x"]);
        assert!(find(&conn, "%").is_empty(), "% no es comodín");
        assert!(find(&conn, "7_d4").is_empty(), "_ no es comodín");
        assert_eq!(find(&conn, "7cd4_"), vec!["7cd4_x"], "el _ literal sí casa");
    }

    #[test]
    fn distingue_mayusculas() {
        let conn = conn_with(&["abcdef01"]);
        assert!(find(&conn, "ABCD").is_empty());
        assert_eq!(find(&conn, "abcd"), vec!["abcdef01"]);
    }

    #[test]
    fn un_prefijo_corto_no_se_acepta_aunque_sea_unico() {
        let err = resolve_unique_id("7", vec!["7cd41c41".into()], "item").unwrap_err();
        assert!(err.contains("too short"), "{err}");
        let err = resolve_unique_id("7cd", vec!["7cd41c41".into()], "item").unwrap_err();
        assert!(err.contains("at least 4"), "{err}");
        assert_eq!(
            resolve_unique_id(" 7cd4 ", vec!["7cd41c41".into()], "item").as_deref(),
            Ok("7cd41c41")
        );
    }

    #[test]
    fn el_id_completo_pasa_siempre() {
        assert_eq!(
            resolve_unique_id("ab", vec!["ab".into()], "item").as_deref(),
            Ok("ab")
        );
        let ids = vec!["abcd".to_string(), "abcdef".to_string()];
        assert_eq!(
            resolve_unique_id("abcd", ids, "item").as_deref(),
            Ok("abcd")
        );
    }

    #[test]
    fn vacio_ausente_y_ambiguo_fallan() {
        assert!(resolve_unique_id("  ", vec![], "item").is_err());
        let none = resolve_unique_id("abcd", vec![], "candidate").unwrap_err();
        assert!(none.contains("no candidate found"), "{none}");
        let many = vec!["abcd1".to_string(), "abcd2".to_string()];
        let amb = resolve_unique_id("abcd", many, "item").unwrap_err();
        assert!(
            amb.contains("ambiguous") && amb.contains("2 items"),
            "{amb}"
        );
    }
}
