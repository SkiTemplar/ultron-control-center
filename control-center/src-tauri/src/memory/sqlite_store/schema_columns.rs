// sqlite_store/schema_columns.rs — columnas aditivas idempotentes
// (`ALTER TABLE … ADD COLUMN` con sondeo previo).

use rusqlite::Connection;

use crate::memory::MemoryError;

use super::schema::exec;

/// Whether `table` already has a column named `col`. `table` is always a
/// constant code literal (never user input) -> no injection surface. Un error
/// del sondeo se propaga: antes contaba como «presente» y el `ALTER` no se
/// reintentaba nunca.
pub(crate) fn column_present(
    conn: &Connection,
    table: &str,
    col: &str,
) -> Result<bool, MemoryError> {
    let probe_err =
        |e: rusqlite::Error| MemoryError::RemoteUnavailable(format!("table_info({table}): {e}"));
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(probe_err)?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(probe_err)?;
    for name in names {
        if name.map_err(probe_err)? == col {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Idempotent `ALTER TABLE memory_items ADD COLUMN` (the common case).
pub(super) fn add_column_if_missing(
    conn: &Connection,
    col: &str,
    decl: &str,
) -> Result<(), MemoryError> {
    add_column_if_missing_on(conn, "memory_items", col, decl)
}

/// Table-parameterised variant of [`add_column_if_missing`]. SQLite lacks
/// `ADD COLUMN IF NOT EXISTS`, so probe `table_info` first. `table`, `col` and
/// `decl` are ALWAYS constant code literals (never user input) -> no injection
/// surface.
pub(crate) fn add_column_if_missing_on(
    conn: &Connection,
    table: &str,
    col: &str,
    decl: &str,
) -> Result<(), MemoryError> {
    if column_present(conn, table, col)? {
        return Ok(());
    }
    add_probed_column(conn, table, col, decl)
}

/// El `ALTER` que sigue a un sondeo que no vio la columna. Entre el sondeo y el
/// `ALTER` otro proceso puede haberla añadido (primer arranque: GUI, daemon y
/// hooks abren una base nueva a la vez) y SQLite responde "duplicate column
/// name". Tras el error se vuelve a sondear: si la columna ya está, el objetivo
/// se cumplió y no es un fallo; si no está, se propaga el error original, así
/// que ningún otro error del `ALTER` se traga.
pub(super) fn add_probed_column(
    conn: &Connection,
    table: &str,
    col: &str,
    decl: &str,
) -> Result<(), MemoryError> {
    let err = match exec(
        conn,
        &format!("ALTER TABLE {table} ADD COLUMN {col} {decl};"),
        &format!("add column {table}.{col}"),
    ) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    match column_present(conn, table, col) {
        Ok(true) => Ok(()),
        Ok(false) | Err(_) => Err(err),
    }
}
