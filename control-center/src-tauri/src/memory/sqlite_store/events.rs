// sqlite_store/events.rs — Append-only memory_events table operations.

use rusqlite::{named_params, params, Connection};

use crate::memory::model::{Actor, EventType, MemoryEvent};
use crate::memory::MemoryError;

pub fn insert_event(conn: &Connection, ev: &MemoryEvent) -> Result<(), MemoryError> {
    conn.execute(
        "INSERT INTO memory_events
            (id,event_type,memory_id,before_json,after_json,actor,source_session_id,
             source_turn_id,reason,confidence,created_at)
         VALUES (:id,:event_type,:memory_id,:before_json,:after_json,:actor,:source_session_id,
             :source_turn_id,:reason,:confidence,:created_at)",
        named_params! {
            ":id": ev.id, ":event_type": ev.event_type.as_str(), ":memory_id": ev.memory_id,
            ":before_json": ev.before_json, ":after_json": ev.after_json, ":actor": ev.actor.as_str(),
            ":source_session_id": ev.source_session_id, ":source_turn_id": ev.source_turn_id,
            ":reason": ev.reason, ":confidence": ev.confidence.map(f64::from),
            ":created_at": ev.created_at,
        },
    )
    .map_err(|e| MemoryError::RemoteUnavailable(format!("insert_event: {e}")))?;
    Ok(())
}

pub fn list_events_for(
    conn: &Connection,
    memory_id: &str,
    limit: usize,
) -> Result<Vec<MemoryEvent>, MemoryError> {
    let mut stmt = conn
        .prepare(
            "SELECT id,event_type,memory_id,before_json,after_json,actor,source_session_id,
                    source_turn_id,reason,confidence,created_at
             FROM memory_events WHERE memory_id = ?1 ORDER BY created_at DESC LIMIT ?2",
        )
        .map_err(|e| MemoryError::RemoteUnavailable(format!("list_events prepare: {e}")))?;
    let rows = stmt
        .query_map(params![memory_id, limit as i64], |row| {
            let et: String = row.get("event_type")?;
            let ac: String = row.get("actor")?;
            Ok(MemoryEvent {
                id: row.get("id")?,
                event_type: EventType::parse(&et).unwrap_or(EventType::Updated),
                memory_id: row.get("memory_id")?,
                before_json: row.get("before_json")?,
                after_json: row.get("after_json")?,
                actor: Actor::parse(&ac).unwrap_or(Actor::System),
                source_session_id: row.get("source_session_id")?,
                source_turn_id: row.get("source_turn_id")?,
                reason: row.get("reason")?,
                confidence: row.get::<_, Option<f64>>("confidence")?.map(|c| c as f32),
                created_at: row.get("created_at")?,
            })
        })
        .map_err(|e| MemoryError::RemoteUnavailable(format!("list_events query: {e}")))?;
    Ok(rows.flatten().collect())
}
