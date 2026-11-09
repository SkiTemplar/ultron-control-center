// recall_unified/usage.rs — telemetría de uso del recall y recalls de diagnóstico.
//
// Un recall real deja dos huellas en brain.db: un evento `Retrieved` y el
// `touch_injected` (access_count, last_injected_at, last_accessed_at) de lo que
// entró en el pack. `last_accessed_at` es la señal con la que el GC decide qué
// item ACTIVE decae a stale (`select_decayed_active_ids`). Auditoría 2026-10-23:
// el doctor (smoke + golden), los evals, el trace y la detección de hubs
// recorrían el mismo camino y dejaban esas huellas; en modo ligero ningún prompt
// real hace recall, así que casi toda la telemetría la generaba el medidor y los
// items de las queries sintéticas no decaían nunca. Los recalls de diagnóstico
// van por aquí y no escriben nada.

use rusqlite::Connection;

use crate::memory::sqlite_store as store;
use crate::memory::MemoryEvent;

use super::engine::{build_trace_with, pack_from_trace};
use super::types_model::{RecallPack, RecallTrace};

/// Quién pide el recall y, por tanto, si deja telemetría de uso.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecallUse {
    /// Recall real (hook, CLI `recall`, daemon): evento Retrieved + touch.
    Live,
    /// Doctor, evals, trace, hubs: lectura pura, sin evento ni touch.
    Diagnostic,
}

/// Registra el uso de un recall `Live` (evento + touch de `injected_ids`). En
/// `Diagnostic` no escribe nada. El fallo del evento no tumba el recall, pero
/// tampoco se traga: vuelve como aviso para la traza.
pub(super) fn record_recall_usage(
    conn: &Connection,
    usage: RecallUse,
    ev: &MemoryEvent,
    injected_ids: &[String],
) -> Option<String> {
    if usage == RecallUse::Diagnostic {
        return None;
    }
    let warning = store::insert_event(conn, ev)
        .err()
        .map(|e| format!("telemetría de recall no registrada: {e}"));
    store::touch_injected(conn, injected_ids);
    warning
}

/// [`super::build_trace`] sin telemetría de uso: para el doctor, los evals, el
/// subcomando `trace` y la detección de hubs.
pub fn build_trace_diagnostic(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
    dense_enabled: bool,
    rerank: bool,
) -> Result<RecallTrace, String> {
    build_trace_with(
        query,
        limit,
        project_id,
        cross_project,
        dense_enabled,
        rerank,
        None,
        RecallUse::Diagnostic,
    )
}

/// [`super::recall_pack`] sin telemetría de uso (mismo pipeline: denso según
/// disponibilidad, `rerank` del llamante).
pub fn recall_pack_diagnostic(
    query: &str,
    limit: usize,
    project_id: Option<&str>,
    cross_project: bool,
    rerank: bool,
) -> Result<RecallPack, String> {
    build_trace_diagnostic(query, limit, project_id, cross_project, true, rerank)
        .map(pack_from_trace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::model::{Actor, EventType, MemoryItem, MemoryType, Scope, Source, Status};

    fn conn_con_item() -> Connection {
        let c = Connection::open_in_memory().expect("open");
        store::apply_schema(&c).expect("schema");
        let mut it = MemoryItem::new(
            MemoryType::Fact,
            Scope::Project,
            Source::AssistantInferred,
            Status::Active,
        );
        it.id = "inyectado".into();
        store::insert_item(&c, &it).expect("insert");
        c
    }

    fn huellas(c: &Connection) -> (i64, i64, Option<i64>) {
        let eventos: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM memory_events WHERE event_type = 'retrieved'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let (accesos, ultimo): (i64, Option<i64>) = c
            .query_row(
                "SELECT COALESCE(access_count, 0), last_accessed_at FROM memory_items WHERE id = 'inyectado'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        (eventos, accesos, ultimo)
    }

    fn evento() -> MemoryEvent {
        MemoryEvent::new(EventType::Retrieved, None, Actor::System).with_reason("recall 'x'")
    }

    #[test]
    fn recall_real_deja_evento_y_touch() {
        let c = conn_con_item();
        let w = record_recall_usage(&c, RecallUse::Live, &evento(), &["inyectado".into()]);
        assert_eq!(w, None);
        let (eventos, accesos, ultimo) = huellas(&c);
        assert_eq!((eventos, accesos), (1, 1));
        assert!(ultimo.is_some());
    }

    // Caso negativo: el recall de diagnóstico no puede tocar access_count ni
    // last_accessed_at (falsearía el decaimiento del GC) ni dejar eventos.
    #[test]
    fn recall_de_diagnostico_no_escribe_nada() {
        let c = conn_con_item();
        let antes = huellas(&c);
        let w = record_recall_usage(&c, RecallUse::Diagnostic, &evento(), &["inyectado".into()]);
        assert_eq!(w, None);
        assert_eq!(huellas(&c), antes);
        assert_eq!(antes.0, 0);
    }

    #[test]
    fn el_fallo_del_evento_vuelve_como_aviso() {
        let c = conn_con_item();
        c.execute_batch(
            "CREATE TRIGGER boom BEFORE INSERT ON memory_events BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();
        let w = record_recall_usage(&c, RecallUse::Live, &evento(), &["inyectado".into()]);
        assert!(w.is_some_and(|m| m.contains("boom")));
    }
}
