//! Barrido de credenciales ya persistidas en `brain.db` (`scrub-secrets`).
//!
//! El 2026-08-22 un hook propuso un candidato con la salida cruda de una
//! herramienta que llevaba un PAT de GitHub y el detector de entonces no lo vio.
//! Rechazar el candidato no purga nada, y `memory_events` copia el contenido
//! completo en `after_json`. Este barrido aplica el detector ACTUAL de
//! credenciales (no el de PII) a todo el texto capturado y reescribe solo las
//! filas que cambian, para que cada mejora del detector limpie lo antiguo.
//!
//! - `memory_items`: por el camino normal (`insert_item_with_event`), que
//!   recalcula `normalized_text`/`content_hash`, mantiene el FTS5 con sus
//!   triggers, sube el item a Secret (la misma política que el write-path) y
//!   deja evento sin copia del contenido.
//! - Resto de tablas ([`store::SCRUB_TARGETS`]): reescritura por columna dentro
//!   de una transacción.
//!
//! Para que el valor no quede en disco, la escritura va con
//! `PRAGMA secure_delete=ON` y el subcomando termina con
//! `wal_checkpoint(TRUNCATE)` + `VACUUM` + `wal_checkpoint(TRUNCATE)`
//! ([`secure_compact`]). Sin `dry_run` se reconstruye además el FTS5
//! ([`rebuild_fts`]). El GC semanal ejecuta el mismo barrido sin compactar.

use std::collections::BTreeMap;

use rusqlite::Connection;

use super::super::model::{Actor, EventType, MemoryEvent, MemoryItem};
use super::super::redaction;
use super::super::sqlite_store::{self as store, TableScrub};
use super::super::MemoryError;
use super::{raised_sensitivity, sync_index, MemoryService};

/// Motivo del evento que deja cada item reescrito. Sin copia del contenido.
const SCRUB_REASON: &str = "scrub-secrets: credencial redactada con el detector actual";

/// Resultado de [`MemoryService::scrub_secrets`]. Solo recuentos: nunca lleva
/// valores.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ScrubSecretsResult {
    pub dry_run: bool,
    /// Filas cambiadas (con `dry_run`, las que cambiarían) por tabla, con el
    /// desglose por columna. Solo aparecen las tablas con algún cambio.
    pub tables: BTreeMap<String, TableScrub>,
    /// Suma de `rows` de todas las tablas.
    pub rows_changed: usize,
    /// `(item_id, error)` de los items que no se pudieron reescribir.
    pub failed: Vec<(String, String)>,
    /// `true` si se reconstruyó el índice FTS5 (siempre que no es `dry_run`).
    pub fts_rebuilt: bool,
    /// `true` si tras escribir se completaron checkpoint y `VACUUM`.
    pub compacted: bool,
}

impl ScrubSecretsResult {
    fn add(&mut self, table: &str, scrub: TableScrub) {
        if scrub.rows == 0 {
            return;
        }
        self.rows_changed += scrub.rows;
        self.tables.insert(table.to_string(), scrub);
    }
}

/// Redactor actual de credenciales. `Some(nuevo)` solo si el texto cambia.
fn rewrite_secret(text: &str) -> Option<String> {
    if !redaction::contains_secret(text) {
        return None;
    }
    let out = redaction::redact(text);
    (out != text).then_some(out)
}

fn scrub_field(field: &mut Option<String>) -> bool {
    match field.as_deref().and_then(rewrite_secret) {
        Some(new_text) => {
            *field = Some(new_text);
            true
        }
        None => false,
    }
}

/// Redacta credenciales en los campos de texto del item y devuelve las
/// columnas que cambiaron.
fn scrub_item(item: &mut MemoryItem) -> Vec<&'static str> {
    let mut cols = Vec::new();
    for (name, field) in [
        ("title", &mut item.title),
        ("summary", &mut item.summary),
        ("content", &mut item.content),
        ("content_json", &mut item.content_json),
        ("symbol", &mut item.symbol),
        ("file_path", &mut item.file_path),
        ("signature", &mut item.signature),
    ] {
        if scrub_field(field) {
            cols.push(name);
        }
    }
    let mut tags_hit = false;
    for tag in &mut item.tags {
        if let Some(new_tag) = rewrite_secret(tag) {
            *tag = new_tag;
            tags_hit = true;
        }
    }
    if tags_hit {
        cols.push("tags");
    }
    cols
}

/// `wal_checkpoint(TRUNCATE)` + `VACUUM` + `wal_checkpoint(TRUNCATE)`: el
/// primero vuelca el WAL al fichero, `VACUUM` reescribe la base sin páginas
/// libres y el último vacía el WAL que deja el propio `VACUUM`. Cualquier fallo
/// (otro proceso con la base abierta) se devuelve, no se traga.
pub fn secure_compact(conn: &Connection) -> Result<(), MemoryError> {
    store::checkpoint_truncate(conn)?;
    store::vacuum(conn)?;
    store::checkpoint_truncate(conn)
}

impl MemoryService {
    /// Barre credenciales de todo el texto persistido y compacta la base para
    /// que el valor antiguo no quede en páginas libres ni en el WAL. Con
    /// `dry_run` solo cuenta. La ruta de la base es la de `open_conn`
    /// (respeta `ULTRON_BRAIN_DB`).
    pub fn scrub_secrets(dry_run: bool, actor: Actor) -> Result<ScrubSecretsResult, MemoryError> {
        let conn = store::open_conn()?;
        if !dry_run {
            store::enable_secure_delete(&conn)?;
        }
        let (mut result, touched) = Self::scrub_secrets_on(&conn, dry_run, actor)?;
        for item in &touched {
            sync_index(item);
        }
        if dry_run {
            return Ok(result);
        }
        secure_compact(&conn).map_err(|e| {
            MemoryError::RemoteUnavailable(format!(
                "scrub-secrets: {} filas reescritas, pero la compactación falló ({e}); \
                 el valor antiguo puede seguir en páginas libres o en el WAL. \
                 Repite con la base libre: el barrido es idempotente",
                result.rows_changed
            ))
        })?;
        result.compacted = true;
        Ok(result)
    }

    /// [`Self::scrub_secrets`] sobre una conexión dada, sin Qdrant ni
    /// compactación. Devuelve también los items reescritos para que el
    /// llamante sincronice el índice denso. `secure_delete` lo pone el llamante.
    pub(crate) fn scrub_secrets_on(
        conn: &Connection,
        dry_run: bool,
        actor: Actor,
    ) -> Result<(ScrubSecretsResult, Vec<MemoryItem>), MemoryError> {
        let mut result = ScrubSecretsResult {
            dry_run,
            ..ScrubSecretsResult::default()
        };
        let touched = scrub_items(conn, dry_run, actor, &mut result)?;
        let scrub_all = || -> Result<Vec<(&str, TableScrub)>, MemoryError> {
            let mut out = Vec::new();
            for (table, cols) in store::SCRUB_TARGETS {
                let scrub = store::scrub_table(conn, table, cols, &rewrite_secret, dry_run)?;
                out.push((*table, scrub));
            }
            Ok(out)
        };
        let scrubs = if dry_run {
            scrub_all()?
        } else {
            store::in_immediate_tx(conn, scrub_all)?
        };
        for (table, scrub) in scrubs {
            result.add(table, scrub);
        }
        if !dry_run {
            rebuild_fts(conn)?;
            result.fts_rebuilt = true;
        }
        Ok((result, touched))
    }
}

/// Reconstruye el FTS5 de `memory_items`. El índice guarda los términos
/// tokenizados (el valor del token en minúsculas) y un `delete` de los
/// triggers solo añade una lápida en un segmento nuevo: el término viejo sigue
/// en `memory_items_fts_data` hasta una fusión. Medido en el test del fichero:
/// sin esto el valor sobrevivía al `VACUUM`. `rebuild` vacía el índice y lo
/// regenera desde la tabla ya redactada; también limpia términos de items
/// borrados antes (archivados u olvidados).
fn rebuild_fts(conn: &Connection) -> Result<(), MemoryError> {
    let after = store::fts_rebuild(conn)?;
    if after.in_sync() {
        return Ok(());
    }
    Err(MemoryError::RemoteUnavailable(format!(
        "scrub-secrets: el FTS5 no quedó en sync tras reconstruirlo          ({} filas en el índice, {} items)",
        after.fts_rows, after.item_rows
    )))
}

/// Paso de `memory_items`, en cualquier estado. Un fallo de escritura de un
/// item no aborta el lote: queda en `result.failed`.
fn scrub_items(
    conn: &Connection,
    dry_run: bool,
    actor: Actor,
    result: &mut ScrubSecretsResult,
) -> Result<Vec<MemoryItem>, MemoryError> {
    let mut stats = TableScrub::default();
    let mut touched = Vec::new();
    for id in store::all_item_ids(conn)? {
        let Some(item) = store::get_item(conn, &id)? else {
            continue;
        };
        let mut updated = item.clone();
        let cols = scrub_item(&mut updated);
        if cols.is_empty() {
            continue;
        }
        if !dry_run {
            updated.sensitivity = raised_sensitivity(updated.sensitivity, true);
            let ev = MemoryEvent::new(EventType::Updated, Some(id.clone()), actor)
                .with_reason(SCRUB_REASON);
            if let Err(e) = store::insert_item_with_event(conn, &updated, &ev) {
                result.failed.push((id, e.to_string()));
                continue;
            }
            touched.push(updated);
        }
        stats.rows += 1;
        for col in cols {
            *stats.columns.entry(col.to_string()).or_insert(0) += 1;
        }
    }
    result.add("memory_items", stats);
    Ok(touched)
}

#[cfg(test)]
#[path = "scrub_secrets_tests.rs"]
mod tests;
