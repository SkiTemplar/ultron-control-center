// sqlite_store/tx.rs — transacción de escritura compartida por el store y el
// MemoryService.
//
// Invariante del ledger (service/mod.rs): toda mutación persistente deja su
// `MemoryEvent`. Para que no quede una mutación sin evento (ni un evento sin
// mutación), las dos sentencias van en la misma transacción y el error de
// cualquiera de ellas hace ROLLBACK de ambas.

use rusqlite::Connection;

use crate::memory::model::{MemoryEvent, MemoryItem};
use crate::memory::MemoryError;

use super::events::insert_event;
use super::items::insert_item;

/// Escribe `item` (INSERT OR REPLACE) y su evento de auditoría en una sola
/// transacción: o quedan los dos o ninguno.
pub(crate) fn insert_item_with_event(
    conn: &Connection,
    item: &MemoryItem,
    ev: &MemoryEvent,
) -> Result<(), MemoryError> {
    in_immediate_tx(conn, || {
        insert_item(conn, item)?;
        insert_event(conn, ev)
    })
}

/// Ejecuta `f` dentro de `BEGIN IMMEDIATE … COMMIT`. `IMMEDIATE` toma el
/// cerrojo de escritura al empezar (con el `busy_timeout` de la conexión), así
/// que dos escritores no se cruzan a mitad de la unidad de trabajo. Si `f`
/// devuelve `Err`, se hace ROLLBACK y se devuelve ese error; si el ROLLBACK
/// también falla, el error devuelto lo dice en vez de tragarse el segundo.
///
/// No anida: `f` no puede abrir otra transacción sobre la misma conexión.
pub(crate) fn in_immediate_tx<T>(
    conn: &Connection,
    f: impl FnOnce() -> Result<T, MemoryError>,
) -> Result<T, MemoryError> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| MemoryError::RemoteUnavailable(format!("begin immediate: {e}")))?;
    match f() {
        Ok(v) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| MemoryError::RemoteUnavailable(format!("commit: {e}")))?;
            Ok(v)
        }
        Err(e) => match conn.execute_batch("ROLLBACK") {
            Ok(()) => Err(e),
            Err(rb) => Err(MemoryError::RemoteUnavailable(format!(
                "{e}; además falló el rollback: {rb}"
            ))),
        },
    }
}
