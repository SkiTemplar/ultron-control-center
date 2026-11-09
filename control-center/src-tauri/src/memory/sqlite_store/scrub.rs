// sqlite_store/scrub.rs — SQL del barrido de secretos ya persistidos
// (`MemoryService::scrub_secrets`). Aquí solo hay lectura y reescritura de
// columnas de texto y la compactación segura; la política (qué redactor, qué
// tablas) la decide el servicio.
//
// `memory_items` NO pasa por aquí: va por `insert_item` en el servicio, que
// recalcula `normalized_text`/`content_hash` y mantiene el FTS5 con sus
// triggers.

use std::collections::BTreeMap;

use rusqlite::Connection;

use crate::memory::MemoryError;

use super::schema_columns::column_present;

/// Tablas y columnas de texto que guardan contenido capturado (fuera de
/// `memory_items`). Una tabla o columna que no exista en la base se salta: las
/// bases antiguas no tienen todas.
pub const SCRUB_TARGETS: &[(&str, &[&str])] = &[
    (
        "memory_candidates",
        &[
            "proposed_title",
            "proposed_summary",
            "proposed_content",
            "proposed_content_json",
            "proposed_tags",
            "proposed_symbol",
            "proposed_file_path",
            "proposed_signature",
        ],
    ),
    ("memory_events", &["before_json", "after_json", "reason"]),
    (
        "memory_items_archive",
        &[
            "title",
            "summary",
            "content",
            "content_json",
            "tags",
            "normalized_text",
            "symbol",
            "file_path",
            "signature",
            "archive_reason",
        ],
    ),
    ("kg_entities", &["observations"]),
    ("trace_events", &["detail_json"]),
    ("deprecation_entries", &["reason", "evidence_json"]),
    ("deprecation_events", &["detail_json"]),
];

/// Filas cambiadas de una tabla y desglose por columna.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct TableScrub {
    pub rows: usize,
    pub columns: BTreeMap<String, usize>,
}

fn sql_err(ctx: &str) -> impl Fn(rusqlite::Error) -> MemoryError + '_ {
    move |e| MemoryError::RemoteUnavailable(format!("{ctx}: {e}"))
}

/// Columnas de `cols` presentes en `table` (vacío si la tabla no existe).
fn present_columns<'a>(
    conn: &Connection,
    table: &str,
    cols: &[&'a str],
) -> Result<Vec<&'a str>, MemoryError> {
    let mut out = Vec::new();
    for col in cols {
        if column_present(conn, table, col)? {
            out.push(*col);
        }
    }
    Ok(out)
}

/// Fila a reescribir: rowid y `(índice de columna, texto nuevo)`.
type RowPatch = (i64, Vec<(usize, String)>);

/// Lee `table` y devuelve solo las filas en las que `rewrite` cambia alguna
/// columna. `rewrite` devuelve `Some(nuevo)` si el texto cambia.
fn collect_patches(
    conn: &Connection,
    table: &str,
    cols: &[&str],
    rewrite: &dyn Fn(&str) -> Option<String>,
) -> Result<Vec<RowPatch>, MemoryError> {
    let sql = format!("SELECT rowid, {} FROM {table}", cols.join(", "));
    let ctx = format!("scrub select {table}");
    let mut stmt = conn.prepare(&sql).map_err(sql_err(&ctx))?;
    let mut rows = stmt.query([]).map_err(sql_err(&ctx))?;
    let mut patches = Vec::new();
    while let Some(row) = rows.next().map_err(sql_err(&ctx))? {
        let rowid: i64 = row.get(0).map_err(sql_err(&ctx))?;
        let mut changed = Vec::new();
        for i in 0..cols.len() {
            let value = row.get_ref(i + 1).map_err(sql_err(&ctx))?;
            // Solo texto: un NULL, entero o BLOB no lleva credenciales legibles.
            let Ok(text) = value.as_str() else { continue };
            if let Some(new_text) = rewrite(text) {
                changed.push((i, new_text));
            }
        }
        if !changed.is_empty() {
            patches.push((rowid, changed));
        }
    }
    Ok(patches)
}

/// Aplica `rewrite` a las columnas `cols` de `table` y reescribe solo las
/// filas que cambian. Con `dry_run` cuenta sin escribir. `table` y `cols` son
/// siempre literales de [`SCRUB_TARGETS`], nunca entrada del usuario.
///
/// No abre transacción: el llamante decide la unidad de trabajo.
pub fn scrub_table(
    conn: &Connection,
    table: &str,
    cols: &[&str],
    rewrite: &dyn Fn(&str) -> Option<String>,
    dry_run: bool,
) -> Result<TableScrub, MemoryError> {
    let cols = present_columns(conn, table, cols)?;
    let mut out = TableScrub::default();
    if cols.is_empty() {
        return Ok(out);
    }
    let patches = collect_patches(conn, table, &cols, rewrite)?;
    let ctx = format!("scrub update {table}");
    for (rowid, changed) in &patches {
        for (i, new_text) in changed {
            *out.columns.entry(cols[*i].to_string()).or_insert(0) += 1;
            if dry_run {
                continue;
            }
            let sql = format!("UPDATE {table} SET {} = ?1 WHERE rowid = ?2", cols[*i]);
            conn.execute(&sql, rusqlite::params![new_text, rowid])
                .map_err(sql_err(&ctx))?;
        }
    }
    out.rows = patches.len();
    Ok(out)
}

/// Ids de todos los items, en cualquier estado.
pub fn all_item_ids(conn: &Connection) -> Result<Vec<String>, MemoryError> {
    let ctx = "scrub ids memory_items";
    let mut stmt = conn
        .prepare("SELECT id FROM memory_items")
        .map_err(sql_err(ctx))?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql_err(ctx))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err(ctx))?;
    Ok(ids)
}

/// `PRAGMA secure_delete=ON` en esta conexión: SQLite sobrescribe con ceros el
/// contenido borrado o reemplazado en vez de dejarlo en páginas libres.
pub fn enable_secure_delete(conn: &Connection) -> Result<(), MemoryError> {
    conn.execute_batch("PRAGMA secure_delete=ON;")
        .map_err(sql_err("PRAGMA secure_delete"))
}

/// `PRAGMA wal_checkpoint(TRUNCATE)`. Falla si otro proceso impide completar
/// el checkpoint (`busy = 1`): el WAL seguiría guardando frames antiguos.
pub fn checkpoint_truncate(conn: &Connection) -> Result<(), MemoryError> {
    let (busy, log, done): (i64, i64, i64) = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(sql_err("PRAGMA wal_checkpoint(TRUNCATE)"))?;
    if busy != 0 {
        return Err(MemoryError::RemoteUnavailable(format!(
            "wal_checkpoint(TRUNCATE) bloqueado por otro proceso (log={log}, \
             copiados={done}): cierra el daemon y la GUI y repite"
        )));
    }
    Ok(())
}
