// memory/service/maintenance.rs — mantenimiento por lotes de la memoria
//
// Covers: deprecate_by_type, archive_one, archive_by_type,
//         deprecate_exact_duplicates, sweep_low_confidence, mark_stale_aged.
//
// Separado de `mutations.rs` (escrituras de un item) para que ninguno pase de
// las 800 líneas. Todas las operaciones reutilizan los caminos de un solo item
// (`set_status`, `archive_one`), así que FTS5, Qdrant y el log de eventos
// siguen la misma regla de oro: solo `MemoryService` escribe.

use super::super::model::{
    now_millis, Actor, EventType, MemoryEvent, MemoryItem, MemoryType, Status,
};
use super::super::sqlite_store as store;
use super::super::MemoryError;
use super::{
    BulkDeprecateResult, ConfidenceSweepResult, DedupeResult, MemoryService, StaleSweepResult,
};

impl MemoryService {
    /// Bulk-deprecate every ACTIVE item of `kind` (optionally scoped to one
    /// `project`). Reuses the single-item [`Self::set_status`] path per id, so
    /// FTS5 triggers + Qdrant (`sync_index`) + the append-only event log all stay
    /// consistent — no bespoke sync logic. `dry_run` only counts (mutates nothing).
    /// A per-item failure is collected in `failed` and does NOT abort the batch.
    pub fn deprecate_by_type(
        kind: MemoryType,
        dry_run: bool,
        project: Option<&str>,
        reason: Option<String>,
        actor: Actor,
    ) -> Result<BulkDeprecateResult, MemoryError> {
        let kind_label: &'static str = kind.as_str();
        // 100_000 is an effective "all" bound (the active set is ~1.9k items).
        let items = Self::list_active_of_type(kind, 100_000)?;
        let items: Vec<MemoryItem> = match project {
            Some(p) => items
                .into_iter()
                .filter(|it| it.project_id.as_deref() == Some(p))
                .collect(),
            None => items,
        };
        let matched = items.len();
        let proj_owned = project.map(str::to_string);
        if dry_run {
            return Ok(BulkDeprecateResult {
                kind: kind_label.to_string(),
                matched,
                deprecated: 0,
                dry_run: true,
                project: proj_owned,
                failed: Vec::new(),
            });
        }
        let reason = reason.unwrap_or_else(|| format!("bulk-deprecate type={kind_label}"));
        let mut deprecated = 0usize;
        let mut failed: Vec<(String, String)> = Vec::new();
        for it in items {
            match Self::set_status(&it.id, Status::Deprecated, actor, Some(reason.clone())) {
                Ok(_) => deprecated += 1,
                Err(e) => failed.push((it.id, e.to_string())),
            }
        }
        Ok(BulkDeprecateResult {
            kind: kind_label.to_string(),
            matched,
            deprecated,
            dry_run: false,
            project: proj_owned,
            failed,
        })
    }

    /// Archiva UN item ya cargado: Qdrant primero (si el punto no se puede
    /// quitar, el item se queda — un archivo parcial es peor que uno
    /// pospuesto), luego la fila a `memory_items_archive`, luego el evento de
    /// auditoría. Extraído de `archive_by_type` (F1.7) para que otros
    /// llamadores por-id (p.ej. `apply_deprecation_deadlines`, que recorre
    /// `deprecation_entries` en vez de un `SELECT` por tipo) reutilicen el
    /// mismo orden Qdrant-antes-que-SQL en vez de duplicarlo.
    pub(super) fn archive_one(
        conn: &rusqlite::Connection,
        item: &MemoryItem,
        now: i64,
        reason: &str,
        actor: Actor,
    ) -> Result<(), MemoryError> {
        let before = serde_json::to_string(item).unwrap_or_default();
        super::super::qdrant_index::remove_item(&item.id)
            .map_err(|e| MemoryError::RemoteUnavailable(format!("qdrant: {e}")))?;
        let ev = MemoryEvent::new(EventType::Updated, Some(item.id.clone()), actor)
            .with_reason(reason.to_string())
            .with_before(before);
        store::archive_item(conn, &item.id, now, reason, Some(&ev))
    }

    /// F1.7 (Q8b, decidido 2026-08-29): mover a `memory_items_archive` los
    /// ACTIVE de `kind` creados hace más de `older_than_days`. Salen del
    /// retriever, de FTS5 (trigger `memory_items_ad`), de Qdrant
    /// (`qdrant_index::remove_item`) y de reconcile; la fila entera queda en el
    /// archivo y el evento en `memory_events`. Medido 2026-09-06: 1.654
    /// `agent_note` activas, 0 inyectadas jamás (excluidas por policy) y aun
    /// así en FTS5 y en Qdrant. `dry_run` solo cuenta; un fallo por item no
    /// aborta el lote. Qdrant primero: si el punto no se puede quitar, el item
    /// se queda (un archivo parcial es peor que uno pospuesto).
    pub fn archive_by_type(
        kind: MemoryType,
        older_than_days: u64,
        dry_run: bool,
        actor: Actor,
        reason: Option<String>,
    ) -> Result<super::ArchiveResult, MemoryError> {
        let kind_label: &'static str = kind.as_str();
        let now = now_millis();
        let cutoff = now - (older_than_days as i64) * 24 * 3_600 * 1_000;
        let items: Vec<MemoryItem> = Self::list_active_of_type(kind, 100_000)?
            .into_iter()
            .filter(|it| it.created_at < cutoff)
            .collect();
        let matched = items.len();
        let reason = reason.unwrap_or_else(|| {
            format!("archive: type={kind_label} older_than_days={older_than_days} (F1.7 Q8b)")
        });
        let mut res = super::ArchiveResult {
            kind: kind_label.to_string(),
            older_than_days,
            matched,
            archived: 0,
            dry_run,
            archived_total: 0,
            failed: Vec::new(),
        };
        let conn = store::open_conn()?;
        if dry_run {
            res.archived_total = store::count_archived(&conn, Some(kind_label));
            return Ok(res);
        }
        for it in items {
            match Self::archive_one(&conn, &it, now, &reason, actor) {
                Ok(()) => res.archived += 1,
                Err(e) => res.failed.push((it.id.clone(), e.to_string())),
            }
        }
        res.archived_total = store::count_archived(&conn, Some(kind_label));
        Ok(res)
    }

    /// Deprecar las copias exactas (2026-09-03): en cada grupo de ACTIVE con el
    /// mismo `content_hash` + scope + proyecto sobrevive UNA fila (pinned,
    /// luego validada por el usuario, luego la más antigua) y el resto pasa a
    /// Deprecated vía `set_status` (FTS5 + Qdrant + ledger en sync; reversible).
    /// Origen medido: 206 sobrantes creadas por drains `--auto` solapados.
    pub fn deprecate_exact_duplicates(
        dry_run: bool,
        actor: Actor,
        reason: Option<String>,
    ) -> Result<DedupeResult, MemoryError> {
        let groups = {
            let conn = store::open_conn()?;
            store::list_active_duplicate_groups(&conn)?
        };
        let reason =
            reason.unwrap_or_else(|| "dedupe: copia exacta de un ACTIVE (drains solapados)".into());
        let mut result = DedupeResult {
            groups: groups.len(),
            surplus: 0,
            deprecated: 0,
            dry_run,
            by_type: std::collections::BTreeMap::new(),
            failed: Vec::new(),
        };
        for group in &groups {
            for extra in group.iter().skip(1) {
                result.surplus += 1;
                *result
                    .by_type
                    .entry(extra.kind.as_str().to_string())
                    .or_insert(0) += 1;
                if dry_run {
                    continue;
                }
                let why = format!("{reason}; sobrevive {}", group[0].id);
                match Self::set_status(&extra.id, Status::Deprecated, actor, Some(why)) {
                    Ok(_) => result.deprecated += 1,
                    Err(e) => result.failed.push((extra.id.clone(), e.to_string())),
                }
            }
        }
        Ok(result)
    }

    /// Sweep por confianza (audit 2026-08-09): deprecar ACTIVE con
    /// `confidence < below` — el 24.9% del corpus (991/3976) vivía bajo el
    /// umbral de ruido 0.55 lastrando el recall. PROTEGIDOS (se cuentan, no se
    /// tocan): golden positives (`protected_ids` — deprecarlos rompe el
    /// oráculo), pinned y user-validated. Reversible (Deprecated, no forget);
    /// cada transición pasa por `set_status` (FTS5 + Qdrant + ledger en sync).
    pub fn sweep_low_confidence(
        below: f32,
        protected_ids: &std::collections::HashSet<String>,
        dry_run: bool,
        actor: Actor,
        reason: Option<String>,
    ) -> Result<ConfidenceSweepResult, MemoryError> {
        let items = Self::list_by_status(Status::Active, 100_000)?;
        let examined = items.len();
        let reason = reason
            .unwrap_or_else(|| format!("sweep: confidence < {below} (ruido, audit 2026-08-09)"));
        let mut res = ConfidenceSweepResult {
            below,
            examined,
            matched: 0,
            deprecated: 0,
            protected_golden: 0,
            protected_pinned: 0,
            protected_validated: 0,
            dry_run,
            failed: Vec::new(),
        };
        for it in items {
            if it.confidence >= below {
                continue;
            }
            res.matched += 1;
            if protected_ids.contains(&it.id) {
                res.protected_golden += 1;
                continue;
            }
            if it.pinned {
                res.protected_pinned += 1;
                continue;
            }
            if it.validated_by_user {
                res.protected_validated += 1;
                continue;
            }
            if dry_run {
                continue;
            }
            match Self::set_status(&it.id, Status::Deprecated, actor, Some(reason.clone())) {
                Ok(_) => res.deprecated += 1,
                Err(e) => res.failed.push((it.id, e.to_string())),
            }
        }
        Ok(res)
    }

    /// Sweep ACTIVE items not MODIFIED in `older_than_days` and transition them to
    /// [`Status::Stale`] (no longer recall-eligible; `sync_index` drops them from
    /// the dense index). Reuses the proven [`Self::set_status`] path per id so
    /// FTS5 triggers + Qdrant + the append-only event log stay consistent — no
    /// bespoke sync logic.
    ///
    /// Honest scope (mand. 13): "stale" here = "not MODIFIED in N days"
    /// (`updated_at`), NOT "unused / no recall-hit". Quien cruza ambas señales es
    /// [`MemoryService::gc`] (F1.8), que ademas exige `last_accessed_at` fuera de
    /// la ventana. Pinned and user-validated items are
    /// protected (never staled). Reversible: `set_status(id, Active)` emits a
    /// `Restored` event. `dry_run` only counts (mutates nothing).
    pub fn mark_stale_aged(
        older_than_days: i64,
        dry_run: bool,
        actor: Actor,
        reason: Option<String>,
    ) -> Result<StaleSweepResult, MemoryError> {
        let cutoff = now_millis() - older_than_days.max(0) * 86_400_000;
        // 100_000 is an effective "all" bound (the active set is ~1.9k items).
        let (items, _total) =
            Self::query_items(Some(Status::Active), None, None, false, 0, 100_000)?;
        let candidates: Vec<MemoryItem> = items
            .into_iter()
            .filter(|it| it.updated_at < cutoff && !it.pinned && !it.validated_by_user)
            .collect();
        let matched = candidates.len();
        if dry_run {
            return Ok(StaleSweepResult {
                older_than_days,
                matched,
                staled: 0,
                dry_run: true,
                failed: Vec::new(),
            });
        }
        let reason =
            reason.unwrap_or_else(|| format!("stale-sweep: sin modificar en >{older_than_days}d"));
        let mut staled = 0usize;
        let mut failed: Vec<(String, String)> = Vec::new();
        for it in candidates {
            match Self::set_status(&it.id, Status::Stale, actor, Some(reason.clone())) {
                Ok(_) => staled += 1,
                Err(e) => failed.push((it.id, e.to_string())),
            }
        }
        Ok(StaleSweepResult {
            older_than_days,
            matched,
            staled,
            dry_run: false,
            failed,
        })
    }
}
