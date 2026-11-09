//! Backfill de PII en items ACTIVE anteriores al guard del write-path.
//!
//! El guard de PII de `create_candidate` (email, teléfono, ruta con usuario)
//! es de junio de 2026; lo que entró antes sigue en `brain.db` con el texto en
//! claro y sensibilidad `Internal`. La auditoría del 2026-10-23 encontró uno:
//! una decisión ACTIVE con la ruta del home del usuario. El read-path vuelve a
//! redactar PII al montar el pack, pero el dato sigue persistido y no lleva la
//! marca Secret que el write-path pone hoy a cualquier candidato con PII.
//!
//! `pii-backfill` aplica a esos items la misma política que el write-path:
//! redacta credenciales y PII en todos sus campos de texto, los sube a Secret
//! y deja evento. Con `--dry-run` solo los lista. Escritor único: pasa por
//! `MemoryService`.

use rusqlite::Connection;

use super::super::model::{now_millis, Actor, EventType, MemoryEvent, MemoryItem, Status};
use super::super::sqlite_store as store;
use super::super::MemoryError;
use super::{redact_item_in_place, sync_index, MemoryService};

/// Resultado de [`MemoryService::pii_backfill`].
#[derive(Debug, Clone, serde::Serialize)]
pub struct PiiBackfillResult {
    pub dry_run: bool,
    /// Items ACTIVE examinados.
    pub scanned: usize,
    /// Ids redactados y marcados Secret (con `dry_run`, los que se tocarían).
    pub redacted: Vec<String>,
    /// `(id, error)` de los que no se pudieron escribir.
    pub failed: Vec<(String, String)>,
}

impl MemoryService {
    /// Redacta credenciales y PII de los items ACTIVE que aún las llevan y los
    /// marca Secret. Ver el módulo.
    pub fn pii_backfill(dry_run: bool, actor: Actor) -> Result<PiiBackfillResult, MemoryError> {
        let conn = store::open_conn()?;
        let (result, touched) = Self::pii_backfill_on(&conn, dry_run, actor)?;
        for item in &touched {
            sync_index(item);
        }
        Ok(result)
    }

    /// [`Self::pii_backfill`] sobre una conexión dada y sin tocar Qdrant.
    /// Devuelve también los items escritos, para que el llamante sincronice el
    /// índice denso tras el commit.
    pub(crate) fn pii_backfill_on(
        conn: &Connection,
        dry_run: bool,
        actor: Actor,
    ) -> Result<(PiiBackfillResult, Vec<MemoryItem>), MemoryError> {
        let items = store::list_items(conn, Status::Active, 1_000_000)?;
        let mut result = PiiBackfillResult {
            dry_run,
            scanned: items.len(),
            redacted: Vec::new(),
            failed: Vec::new(),
        };
        let mut touched = Vec::new();
        for item in items {
            let mut updated = item.clone();
            if !redact_item_in_place(&mut updated) {
                continue;
            }
            if dry_run {
                result.redacted.push(item.id);
                continue;
            }
            updated.updated_at = now_millis();
            let ev = MemoryEvent::new(EventType::Updated, Some(item.id.clone()), actor)
                .with_reason("pii-backfill: PII o credencial anterior al guard del write-path")
                .with_after(serde_json::to_string(&updated).unwrap_or_default());
            match store::insert_item_with_event(conn, &updated, &ev) {
                Ok(()) => {
                    result.redacted.push(item.id);
                    touched.push(updated);
                }
                Err(e) => result.failed.push((item.id, e.to_string())),
            }
        }
        Ok((result, touched))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::model::{MemoryType, Scope, Sensitivity, Source};

    fn mem_conn() -> Connection {
        let c = Connection::open_in_memory().expect("open");
        store::apply_schema(&c).expect("schema");
        c
    }

    fn active(c: &Connection, id: &str, summary: &str) {
        let mut it = MemoryItem::new(
            MemoryType::Decision,
            Scope::Project,
            Source::AssistantInferred,
            Status::Active,
        );
        it.id = id.to_string();
        it.summary = Some(summary.to_string());
        store::insert_item(c, &it).expect("insert");
    }

    /// Ruta de usuario de Windows construida en tiempo de ejecución (el gate de
    /// datos personales del repo no admite rutas de home literales).
    fn user_path() -> String {
        format!("C:{}Users{}fulano{}proyecto", '/', '/', '/')
    }

    #[test]
    fn redacta_la_ruta_de_usuario_y_marca_secret_con_evento() {
        let c = mem_conn();
        active(&c, "con-ruta", &format!("el repo vive en {}", user_path()));
        active(&c, "limpio", "brain.db es la fuente de verdad");
        let (res, touched) = MemoryService::pii_backfill_on(&c, false, Actor::System).unwrap();
        assert_eq!(res.scanned, 2);
        assert_eq!(res.redacted, vec!["con-ruta".to_string()]);
        assert_eq!(touched.len(), 1);
        let it = store::get_item(&c, "con-ruta").unwrap().unwrap();
        assert!(!it.summary.unwrap_or_default().contains("fulano"));
        assert_eq!(it.sensitivity, Sensitivity::Secret);
        assert_eq!(store::list_events_for(&c, "con-ruta", 10).unwrap().len(), 1);
        let limpio = store::get_item(&c, "limpio").unwrap().unwrap();
        assert_ne!(
            limpio.sensitivity,
            Sensitivity::Secret,
            "lo limpio no se toca"
        );
    }

    // Caso negativo: el dry-run lista pero no escribe nada.
    #[test]
    fn dry_run_no_escribe() {
        let c = mem_conn();
        active(&c, "con-ruta", &format!("ruta {}", user_path()));
        let (res, touched) = MemoryService::pii_backfill_on(&c, true, Actor::System).unwrap();
        assert_eq!(res.redacted, vec!["con-ruta".to_string()]);
        assert!(touched.is_empty());
        let it = store::get_item(&c, "con-ruta").unwrap().unwrap();
        assert!(it.summary.unwrap_or_default().contains("fulano"));
        assert!(store::list_events_for(&c, "con-ruta", 10)
            .unwrap()
            .is_empty());
    }
}
