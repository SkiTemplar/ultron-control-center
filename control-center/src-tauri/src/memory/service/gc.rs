//! `MemoryService::gc` — mantenimiento a 90 dias de `brain.db` (F1.8, decision
//! del 2026-09-11). El SQL vive en `sqlite_store::gc`; aqui se orquesta.
//!
//! Tres reglas, ninguna destructiva sobre lo vivo:
//!   1. Decaimiento: ACTIVE sin recall ni modificacion en la ventana -> `stale`
//!      via `set_status` (camino probado: FTS5 + Qdrant + evento de auditoria).
//!      Reversible con `set_status(id, Active)`, que emite `Restored`.
//!   2. Poda del log: `memory_events` de items `deprecated`/`rejected` mas
//!      viejos que la ventana. Lo activo y lo stale conservan su historia.
//!   3. Poda del log sin item: eventos fuera de la ventana con `memory_id` NULL
//!      (telemetria de recall/creacion) o apuntando a un id que ya no esta en
//!      `memory_items`. Se añadio tras medir que la regla 2 sola solo alcanzaba
//!      2,9 MB de los 126 del fichero, mientras estas dos familias sumaban el
//!      74 % del log (~45 MB) sin reconstruir ningun item.
//!
//! Compactacion: un DELETE no encoge el fichero, solo llena la freelist. Se
//! ejecuta VACUUM unicamente si esa freelist supera [`VACUUM_MIN_BYTES`], para
//! no pagar una reescritura completa de 126 MB por unos pocos KB.

use super::super::model::{Actor, Status};
use super::super::MemoryError;
use super::super::{model::now_millis, sqlite_store as store};
use super::{GcResult, MemoryService};

/// Ventana por defecto del mantenimiento, en dias.
pub const DEFAULT_GC_DAYS: i64 = 90;

/// Umbral de compactacion: por debajo de 10 MB de freelist, VACUUM no compensa.
pub const VACUUM_MIN_BYTES: i64 = 10 * 1024 * 1024;

impl MemoryService {
    /// Ejecuta el mantenimiento a `days` dias. Con `dry_run` no escribe nada:
    /// cuenta lo que haria y devuelve `bytes_after == bytes_before`.
    ///
    /// Alcance real (mandamiento 13): la señal de "recuperado" es
    /// `last_accessed_at`, que solo existe desde el 2026-08-28 (cuando el recall
    /// unificado empezo a sellar los items inyectados). Un item sin esa marca se
    /// trata como no recuperado, que es lo unico que los datos permiten afirmar.
    pub fn gc(days: i64, dry_run: bool, actor: Actor) -> Result<GcResult, MemoryError> {
        let days = days.max(0);
        let cutoff_ms = now_millis() - days * 86_400_000;
        let conn = store::open_conn()?;
        let bytes_before = store::db_size_bytes(&conn)?;

        let candidatos = store::select_decayed_active_ids(&conn, cutoff_ms)?;

        if dry_run {
            let por_regla = store::prune_events(&conn, cutoff_ms, true)?;
            return Ok(GcResult {
                days,
                stale_marked: candidatos.len(),
                events_deleted: por_regla.total(),
                events_deleted_by_rule: por_regla,
                bytes_before,
                bytes_after: bytes_before,
                freelist_bytes: store::freelist_bytes(&conn)?,
                vacuumed: false,
                vacuum_skipped: Some("dry-run".to_string()),
                dry_run: true,
                failed: Vec::new(),
            });
        }

        // Regla 1. `set_status` abre su propia conexion por item: se acepta el
        // coste por-item a cambio de no duplicar la sincronizacion con FTS5,
        // Qdrant y el log de eventos. Un fallo suelto no aborta el lote.
        let reason = format!("gc: sin recall ni cambios en >{days}d");
        let mut stale_marked = 0usize;
        let mut failed: Vec<(String, String)> = Vec::new();
        for id in candidatos {
            match Self::set_status(&id, Status::Stale, actor, Some(reason.clone())) {
                Ok(_) => stale_marked += 1,
                Err(e) => failed.push((id, e.to_string())),
            }
        }

        // Reglas 2 y 3.
        let por_regla = store::prune_events(&conn, cutoff_ms, false)?;

        // Compactacion condicionada al ahorro real.
        let freelist = store::freelist_bytes(&conn)?;
        let mut vacuumed = false;
        let mut vacuum_skipped = None;
        if freelist >= VACUUM_MIN_BYTES {
            match store::vacuum(&conn) {
                Ok(()) => vacuumed = true,
                // Con el daemon o la GUI usando la base, VACUUM no consigue el
                // lock exclusivo. No es un fallo del GC: se declara y se sigue.
                Err(e) => vacuum_skipped = Some(e.to_string()),
            }
        } else {
            vacuum_skipped = Some(format!(
                "ahorro estimado {freelist} B < umbral {VACUUM_MIN_BYTES} B"
            ));
        }

        Ok(GcResult {
            days,
            stale_marked,
            events_deleted: por_regla.total(),
            events_deleted_by_rule: por_regla,
            bytes_before,
            bytes_after: store::db_size_bytes(&conn)?,
            freelist_bytes: freelist,
            vacuumed,
            vacuum_skipped,
            dry_run: false,
            failed,
        })
    }
}
