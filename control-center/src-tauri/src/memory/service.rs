// ULTRON Control Center — MemoryService: the single persistent writer (Fase A)
//
// GOVERNANCE INVARIANT: every persistent memory mutation goes through this
// service, and every mutation appends a `MemoryEvent`. Hooks and agents NEVER
// write `memory_items` directly — they propose `MemoryCandidate`s and the human
// (or an auto-approval policy) promotes them here.
//
// The service is stateless: each method opens `brain.db` (WAL) for its unit of
// work. Tauri commands / the CLL / the candidate-extraction hook all call here.

use serde::Serialize;

use super::model::{
    estimate_tokens, now_millis, Actor, CandidateAction, CandidateStatus, EventType,
    MemoryCandidate, MemoryEvent, MemoryItem, MemoryType, Scope, Sensitivity, Source, Status,
};
use super::redaction;
use super::sqlite_store as store;
use super::MemoryError;

/// Stateless facade over the canonical memory store.
pub struct MemoryService;

/// Aggregate counts for dashboards / `memory stats`.
#[derive(Debug, Clone, Serialize)]
pub struct MemoryStats {
    pub active: i64,
    pub pending: i64,
    pub rejected: i64,
    pub deprecated: i64,
    pub stale: i64,
    pub candidates_pending: i64,
}

/// Raise sensitivity to [`Sensitivity::Secret`] when the write-path detected a
/// credential. Monotonic: it never lowers an already-higher classification (H2 /
/// OLA A — see CONTRACTS-2026-06-04.md write-path security + recall Secret-gate).
fn raised_sensitivity(current: Sensitivity, secret_detected: bool) -> Sensitivity {
    if secret_detected {
        Sensitivity::Secret
    } else {
        current
    }
}

/// Best-effort: keep the derived dense index (Qdrant `ultron_memory`) in step
/// with a write to the SoT. ACTIVE items are (re)indexed; non-active items are
/// removed. Errors are swallowed — `brain.db` is the source of truth and any
/// drift is detectable/repairable via `reconcile`. (W4: closes the gap where a
/// newly approved/edited/restored item never reached Qdrant until a manual
/// `reindex_all`, so `in_sync` would drift on the first approval.)
fn sync_index(item: &MemoryItem) {
    if matches!(item.status, Status::Active) {
        let _ = super::qdrant_index::index_item(item);
    } else {
        let _ = super::qdrant_index::remove_item(&item.id);
    }
}

/// Candidate `risk_level` marker set when the write-path detected a credential;
/// read on approve to raise the item to `Sensitivity::Secret` (H2). Single source
/// of the literal so a typo can't silently disable the Secret-gate.
const SECRET_RISK_MARKER: &str = "secret";

/// Redact any credential material found in `tags` (write-path helper, review-fix).
/// Returns `true` if anything was redacted. Tags are short labels but are still
/// user/tool text and are part of `searchable_text()` (hence embedded).
fn redact_tags(tags: &mut [String]) -> bool {
    let mut hit = false;
    for tag in tags.iter_mut() {
        if redaction::contains_secret(tag) {
            *tag = redaction::redact(tag);
            hit = true;
        }
    }
    hit
}

impl MemoryService {
    // -- candidate intake (what hooks/agents call) ---------------------------

    /// Record a proposed memory (status pending). Returns the candidate id.
    /// This is the ONLY way non-service code introduces memory.
    pub fn create_candidate(candidate: &MemoryCandidate) -> Result<String, MemoryError> {
        let conn = store::open_conn()?;
        let mut cand = candidate.clone();

        // Write-path secret guard (OLA A): redact any credential material from the
        // proposed text BEFORE it is persisted to brain.db or later embedded into
        // Qdrant. Defensive — only detected secrets are redacted; normal text is
        // left untouched. See memory/redaction.rs and CONTRACTS-2026-06-04.md.
        let mut redacted = false;
        redacted |= redaction::redact_in_place(&mut cand.proposed_title);
        redacted |= redaction::redact_in_place(&mut cand.proposed_summary);
        redacted |= redaction::redact_in_place(&mut cand.proposed_content);
        redacted |= redaction::redact_in_place(&mut cand.proposed_content_json);
        redacted |= redact_tags(&mut cand.proposed_tags);

        // Basic FTS dedupe: flag near-identical ACTIVE items as duplicates so the
        // inbox can merge instead of creating a redundant memory. (Semantic dedupe
        // + contradiction detection via embeddings/AI routing is Fase D — TODO below.)
        if let Some(summary) = cand.proposed_summary.clone() {
            if !summary.trim().is_empty() {
                if let Ok(similar) = store::search_items(&conn, &summary, Status::Active, 3) {
                    let dups: Vec<String> = similar.into_iter().map(|i| i.id).collect();
                    if !dups.is_empty() {
                        cand.duplicate_candidates = dups;
                        cand.recommended_action = CandidateAction::Merge;
                    }
                }
            }
        }

        // L0 exact dedupe (OLA E): if an ACTIVE item already has the same
        // content_hash this candidate would produce on approve, flag it as a Merge
        // candidate. Complements the FTS near-dupe above (exact > lexical-similar).
        let probe = cand.to_item(Status::Active, Source::AssistantInferred);
        let probe_text = probe.searchable_text();
        if !probe_text.trim().is_empty() {
            let probe_hash = super::texthash::content_hash(&probe_text);
            // Scope/project guard (CONTRACTS §4 + review P1): an exact text match in a
            // DIFFERENT project/scope is a near-duplicate, NOT a duplicate — never merge
            // across the project boundary. find_active_by_content_hash filters by
            // (scope, project_id) so cross-project collisions can't trigger a Merge.
            if let Ok(Some(existing)) = store::find_active_by_content_hash(
                &conn,
                &probe_hash,
                probe.scope,
                probe.project_id.as_deref(),
            ) {
                if !cand.duplicate_candidates.contains(&existing.id) {
                    cand.duplicate_candidates.push(existing.id);
                }
                cand.recommended_action = CandidateAction::Merge;
            }
        }

        // Write-path sensitivity (OLA A / H2): a candidate that carried a
        // credential is quarantined (never auto-approved) and tagged so the
        // promoted item is marked Secret on approve. `redacted` reuses the same
        // detector as redaction::classify_sensitivity; takes precedence over Merge.
        if redacted {
            cand.recommended_action = CandidateAction::Quarantine;
            cand.risk_level = SECRET_RISK_MARKER.to_string();
        }
        // Fase D — contradiction detector (now wired). Compare the proposed
        // summary against semantically-near ACTIVE items of the SAME project via
        // memory/contradiction.rs (dense neighbours + a fail-safe LLM judge). On a
        // confirmed conflict we ONLY MARK it: fill `contradiction_candidates` with
        // the conflicting ids and route to Quarantine for human adjudication. We
        // NEVER auto-resolve, deprecate, or discard — and the detector is
        // CONSERVATIVE (judge returns false on any doubt), so this can't flood the
        // inbox with false positives. Secret quarantine (above) takes precedence;
        // we do not downgrade it. Probe `project_id` keeps cross-project memories
        // (which legitimately differ) from being flagged as contradictions.
        if !redacted {
            if let Some(summary) = cand.proposed_summary.as_deref() {
                let findings =
                    super::contradiction::check(&conn, summary, probe.project_id.as_deref());
                if !findings.is_empty() {
                    for f in &findings {
                        if !cand.contradiction_candidates.contains(&f.conflicting_id) {
                            cand.contradiction_candidates.push(f.conflicting_id.clone());
                        }
                    }
                    // Mark for human review; never auto-resolve. Quarantine keeps it
                    // OUT of recall until adjudicated (takes precedence over Merge).
                    cand.recommended_action = CandidateAction::Quarantine;
                }
            }
        }

        store::insert_candidate(&conn, &cand)?;
        let reason = if redacted {
            format!("candidate {} proposed (secrets redacted)", cand.id)
        } else if !cand.contradiction_candidates.is_empty() {
            format!(
                "candidate {} proposed (contradicts {} active item(s) — quarantined)",
                cand.id,
                cand.contradiction_candidates.len()
            )
        } else {
            format!("candidate {} proposed", cand.id)
        };
        let ev = MemoryEvent::new(EventType::Created, None, Actor::System)
            .with_reason(reason)
            .with_after(serde_json::to_string(&cand).unwrap_or_default());
        let _ = store::insert_event(&conn, &ev);

        // Auto-validation 3-band policy (opt-in). When the persisted `auto_approve`
        // setting is ON and this candidate is CLEAN, the confidence-driven band
        // decides its disposition — replacing the old binary "approve all clean":
        //
        //   BAND A (confidence >= threshold): promote straight to ACTIVE, reusing the
        //     exact `approve_candidate` path the human UI uses (redaction / sensitivity
        //     / index-sync all still apply). Approved as Actor::System (policy, not a
        //     human validation, so NOT marked `validated_by_user`).
        //   BAND B (mid confidence, OR kind decision/architecture): leave PENDING in
        //     the inbox (the default — no action; it was inserted as Pending above).
        //   BAND C (confidence < REJECT_THRESHOLD): mark `rejected` so it never enters
        //     recall; a background purge sweeps it later. Noise auto-discard.
        //
        // SECURITY SALVAGUARDA (unchanged): `candidate_is_clean` is FALSE for any
        // candidate carrying the secret marker or a contradiction finding, so those
        // ALWAYS stay in the inbox/quarantine for human review — they never reach band
        // classification. FAIL-SAFE: `auto_approve_threshold` reads as f32::INFINITY on
        // any settings error, so nothing can clear BAND A on a glitch, and
        // `auto_approve_enabled` defaults to false — both gate the promotion. All
        // errors are swallowed: the candidate is already safely in the inbox.
        if super::auto_approve::auto_approve_enabled()
            && super::auto_approve::candidate_is_clean(&cand)
        {
            let threshold = super::auto_approve::auto_approve_threshold();
            match super::auto_approve::classify_band(&cand, threshold) {
                super::auto_approve::AutoBand::Approve => {
                    drop(conn); // approve_candidate opens its own connection.
                    let _ = Self::approve_candidate(&cand.id, Actor::System);
                }
                super::auto_approve::AutoBand::Pending => {
                    // No-op: it is already persisted Pending in the inbox.
                }
                super::auto_approve::AutoBand::Reject => {
                    // Low-confidence noise: flip to `rejected` (out of recall) and
                    // record the policy decision in the audit log. Swallow errors —
                    // worst case it lingers as Pending, which is still safe.
                    let _ = store::set_candidate_status(
                        &conn,
                        &cand.id,
                        CandidateStatus::Rejected,
                    );
                    let ev = MemoryEvent::new(EventType::Rejected, None, Actor::System)
                        .with_reason(format!(
                            "candidate {} auto-rejected (confidence {:.2} < band-C floor)",
                            cand.id, cand.confidence
                        ));
                    let _ = store::insert_event(&conn, &ev);
                }
            }
        }

        Ok(cand.id.clone())
    }

    /// Edit a pending candidate's proposed fields before approval. `None` leaves
    /// a field unchanged.
    pub fn edit_candidate(
        id: &str,
        summary: Option<String>,
        content: Option<String>,
        importance: Option<f32>,
        confidence: Option<f32>,
    ) -> Result<MemoryCandidate, MemoryError> {
        let conn = store::open_conn()?;
        let mut c = store::get_candidate(&conn, id)?
            .ok_or_else(|| MemoryError::NotFound(format!("candidate {id}")))?;
        if summary.is_some() {
            c.proposed_summary = summary;
        }
        if content.is_some() {
            c.proposed_content = content;
        }
        if let Some(i) = importance {
            c.importance = i.clamp(0.0, 1.0);
        }
        if let Some(cf) = confidence {
            c.confidence = cf.clamp(0.0, 1.0);
        }
        store::insert_candidate(&conn, &c)?; // INSERT OR REPLACE
        let ev = MemoryEvent::new(EventType::Edited, None, Actor::User)
            .with_reason(format!("candidate {id} edited"))
            .with_after(serde_json::to_string(&c).unwrap_or_default());
        let _ = store::insert_event(&conn, &ev);
        Ok(c)
    }

    /// List candidates awaiting a human (or policy) decision.
    pub fn list_pending_candidates(limit: usize) -> Result<Vec<MemoryCandidate>, MemoryError> {
        let conn = store::open_conn()?;
        store::list_candidates(&conn, CandidateStatus::Pending, limit)
    }

    /// Approve a candidate → promote to an ACTIVE `memory_items` row.
    /// When `actor == User` the resulting item is marked validated.
    pub fn approve_candidate(id: &str, actor: Actor) -> Result<MemoryItem, MemoryError> {
        let conn = store::open_conn()?;
        let cand = store::get_candidate(&conn, id)?
            .ok_or_else(|| MemoryError::NotFound(format!("candidate {id}")))?;

        let mut item = cand.to_item(Status::Active, Source::AssistantInferred);
        // H2: carry the write-path secret marker to the item so the recall
        // Secret-gate (recall_unified) excludes it. Monotonic — never downgrades.
        item.sensitivity =
            raised_sensitivity(item.sensitivity, cand.risk_level == SECRET_RISK_MARKER);
        if matches!(actor, Actor::User) {
            item.validated_by_user = true;
            item.validated_at = Some(now_millis());
        }
        store::insert_item(&conn, &item)?;
        sync_index(&item); // W4: keep the dense index in sync with the approval
        store::set_candidate_status(&conn, id, CandidateStatus::Approved)?;

        let ev = MemoryEvent::new(EventType::Approved, Some(item.id.clone()), actor)
            .with_reason(format!("candidate {id} approved"))
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        let _ = store::insert_event(&conn, &ev);
        Ok(item)
    }

    /// Reject a candidate — it never becomes a memory.
    pub fn reject_candidate(
        id: &str,
        actor: Actor,
        reason: Option<String>,
    ) -> Result<(), MemoryError> {
        let conn = store::open_conn()?;
        store::set_candidate_status(&conn, id, CandidateStatus::Rejected)?;
        let mut ev = MemoryEvent::new(EventType::Rejected, None, actor)
            .with_reason(reason.unwrap_or_else(|| format!("candidate {id} rejected")));
        ev.after_json = Some(format!("{{\"candidate_id\":\"{id}\"}}"));
        let _ = store::insert_event(&conn, &ev);
        Ok(())
    }

    // -- direct writes (migration / ETL only) --------------------------------

    /// Insert an already-formed item (used by one-shot ETL imports). Caller sets
    /// `source = Imported*` and the status (active for clear data, pending for
    /// doubtful). Emits an `imported` event.
    pub fn add_imported(item: &MemoryItem) -> Result<(), MemoryError> {
        let conn = store::open_conn()?;
        // Write-path secret guard (OLA A): redact credentials from imported text
        // (external/ETL sources are lower-trust) before persisting/indexing.
        let mut item = item.clone();
        let mut secret = false;
        secret |= redaction::redact_in_place(&mut item.title);
        secret |= redaction::redact_in_place(&mut item.summary);
        secret |= redaction::redact_in_place(&mut item.content);
        secret |= redaction::redact_in_place(&mut item.content_json);
        secret |= redact_tags(&mut item.tags);
        // H2: mark imported item Secret if any credential was detected (never downgrade).
        item.sensitivity = raised_sensitivity(item.sensitivity, secret);
        store::insert_item(&conn, &item)?;
        sync_index(&item); // W4: index active imports (bulk ETL still runs reindex_all)
        let ev = MemoryEvent::new(EventType::Imported, Some(item.id.clone()), Actor::Migration)
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        let _ = store::insert_event(&conn, &ev);
        Ok(())
    }

    // -- reads ---------------------------------------------------------------

    pub fn get(id: &str) -> Result<Option<MemoryItem>, MemoryError> {
        let conn = store::open_conn()?;
        store::get_item(&conn, id)
    }

    /// Recall-eligible search: ACTIVE items only (governance invariant).
    pub fn search_active(query: &str, limit: usize) -> Result<Vec<MemoryItem>, MemoryError> {
        let conn = store::open_conn()?;
        store::search_items(&conn, query, Status::Active, limit)
    }

    pub fn list_by_status(status: Status, limit: usize) -> Result<Vec<MemoryItem>, MemoryError> {
        let conn = store::open_conn()?;
        store::list_items(&conn, status, limit)
    }

    pub fn history(id: &str, limit: usize) -> Result<Vec<MemoryEvent>, MemoryError> {
        let conn = store::open_conn()?;
        store::list_events_for(&conn, id, limit)
    }

    // -- mutations -----------------------------------------------------------

    /// Edit the editable fields of an item. `None` leaves a field unchanged.
    pub fn edit(
        id: &str,
        title: Option<String>,
        summary: Option<String>,
        content: Option<String>,
        importance: Option<f32>,
        confidence: Option<f32>,
        actor: Actor,
    ) -> Result<MemoryItem, MemoryError> {
        let conn = store::open_conn()?;
        let mut item =
            store::get_item(&conn, id)?.ok_or_else(|| MemoryError::NotFound(id.to_string()))?;
        let before = serde_json::to_string(&item).unwrap_or_default();

        if title.is_some() {
            item.title = title;
        }
        if summary.is_some() {
            item.summary = summary;
        }
        if content.is_some() {
            item.content = content;
        }
        if let Some(i) = importance {
            item.importance = i.clamp(0.0, 1.0);
        }
        if let Some(c) = confidence {
            item.confidence = c.clamp(0.0, 1.0);
        }
        // Write-path secret guard (H2 / review P1): an edit can introduce a
        // credential, and W4 now indexes edited items into Qdrant — redact +
        // escalate sensitivity BEFORE persisting/indexing.
        let mut secret = redaction::redact_in_place(&mut item.title);
        secret |= redaction::redact_in_place(&mut item.summary);
        secret |= redaction::redact_in_place(&mut item.content);
        secret |= redaction::redact_in_place(&mut item.content_json);
        secret |= redact_tags(&mut item.tags);
        item.sensitivity = raised_sensitivity(item.sensitivity, secret);
        item.updated_at = now_millis();
        item.token_estimate = estimate_tokens(&item.searchable_text());
        store::insert_item(&conn, &item)?;
        sync_index(&item); // W4: re-embed/refresh the dense index after an edit

        let ev = MemoryEvent::new(EventType::Edited, Some(item.id.clone()), actor)
            .with_before(before)
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        let _ = store::insert_event(&conn, &ev);
        Ok(item)
    }

    /// Transition an item to a new lifecycle status (deprecate / archive / stale…).
    pub fn set_status(
        id: &str,
        status: Status,
        actor: Actor,
        reason: Option<String>,
    ) -> Result<MemoryItem, MemoryError> {
        let conn = store::open_conn()?;
        let mut item =
            store::get_item(&conn, id)?.ok_or_else(|| MemoryError::NotFound(id.to_string()))?;
        let before = serde_json::to_string(&item).unwrap_or_default();
        let event_type = match status {
            Status::Deprecated => EventType::Deprecated,
            Status::Rejected => EventType::Rejected,
            Status::Active => EventType::Restored,
            _ => EventType::Updated,
        };
        item.status = status;
        item.updated_at = now_millis();
        store::insert_item(&conn, &item)?;
        sync_index(&item); // W4: Active -> (re)index ; non-active -> remove from index

        let mut ev = MemoryEvent::new(event_type, Some(item.id.clone()), actor)
            .with_before(before)
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        if let Some(r) = reason {
            ev = ev.with_reason(r);
        }
        let _ = store::insert_event(&conn, &ev);
        Ok(item)
    }

    /// Convenience: deprecate an item (no longer recall-eligible).
    pub fn deprecate(
        id: &str,
        actor: Actor,
        reason: Option<String>,
    ) -> Result<MemoryItem, MemoryError> {
        Self::set_status(id, Status::Deprecated, actor, reason)
    }

    /// Pin / unpin an item (req #17). Pinned items are always surfaced.
    pub fn pin(id: &str, actor: Actor) -> Result<MemoryItem, MemoryError> {
        Self::set_pinned(id, true, actor)
    }
    pub fn unpin(id: &str, actor: Actor) -> Result<MemoryItem, MemoryError> {
        Self::set_pinned(id, false, actor)
    }
    fn set_pinned(id: &str, pinned: bool, actor: Actor) -> Result<MemoryItem, MemoryError> {
        let conn = store::open_conn()?;
        let mut item =
            store::get_item(&conn, id)?.ok_or_else(|| MemoryError::NotFound(id.to_string()))?;
        let before = serde_json::to_string(&item).unwrap_or_default();
        item.pinned = pinned;
        item.updated_at = now_millis();
        store::insert_item(&conn, &item)?;
        let ev = MemoryEvent::new(EventType::Edited, Some(item.id.clone()), actor)
            .with_before(before)
            .with_reason(if pinned { "pinned" } else { "unpinned" })
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        let _ = store::insert_event(&conn, &ev);
        Ok(item)
    }

    /// Active items pinned by the user (Session Resume / always-include).
    pub fn list_pinned(limit: usize) -> Result<Vec<MemoryItem>, MemoryError> {
        let conn = store::open_conn()?;
        store::list_pinned(&conn, limit)
    }

    /// Active items of a given type (e.g. decisions, open tasks).
    pub fn list_active_of_type(
        kind: MemoryType,
        limit: usize,
    ) -> Result<Vec<MemoryItem>, MemoryError> {
        let conn = store::open_conn()?;
        store::list_by_type_status(&conn, kind, Status::Active, limit)
    }

    /// Change an item's scope and/or type (inbox "change scope / change type").
    pub fn relabel(
        id: &str,
        scope: Option<Scope>,
        kind: Option<MemoryType>,
        actor: Actor,
    ) -> Result<MemoryItem, MemoryError> {
        let conn = store::open_conn()?;
        let mut item =
            store::get_item(&conn, id)?.ok_or_else(|| MemoryError::NotFound(id.to_string()))?;
        let before = serde_json::to_string(&item).unwrap_or_default();
        if let Some(s) = scope {
            item.scope = s;
        }
        if let Some(k) = kind {
            item.kind = k;
        }
        item.updated_at = now_millis();
        store::insert_item(&conn, &item)?;
        sync_index(&item); // W4: refresh the dense index payload (scope/type) after relabel
        let ev = MemoryEvent::new(EventType::Edited, Some(item.id.clone()), actor)
            .with_before(before)
            .with_after(serde_json::to_string(&item).unwrap_or_default());
        let _ = store::insert_event(&conn, &ev);
        Ok(item)
    }

    /// Replace `old_id` with a new active item, marking the old one deprecated
    /// and linking supersedes/superseded_by both ways.
    pub fn supersede(
        old_id: &str,
        mut new_item: MemoryItem,
        actor: Actor,
    ) -> Result<MemoryItem, MemoryError> {
        let conn = store::open_conn()?;
        let mut old = store::get_item(&conn, old_id)?
            .ok_or_else(|| MemoryError::NotFound(old_id.to_string()))?;

        new_item.status = Status::Active;
        new_item.supersedes = Some(old_id.to_string());
        // Temporal resolver: the new assertion becomes vigente NOW. (valid_to
        // stays None until it is itself superseded.)
        let supersede_at = now_millis();
        if new_item.valid_from.is_none() {
            new_item.valid_from = Some(supersede_at);
        }
        // Write-path secret guard (H2 / review P1): supersede writes a NEW active
        // item that W4 indexes — redact + escalate sensitivity before persisting.
        let mut secret = redaction::redact_in_place(&mut new_item.title);
        secret |= redaction::redact_in_place(&mut new_item.summary);
        secret |= redaction::redact_in_place(&mut new_item.content);
        secret |= redaction::redact_in_place(&mut new_item.content_json);
        secret |= redact_tags(&mut new_item.tags);
        new_item.sensitivity = raised_sensitivity(new_item.sensitivity, secret);
        new_item.updated_at = now_millis();
        store::insert_item(&conn, &new_item)?;
        sync_index(&new_item); // W4: index the new active item

        old.status = Status::Deprecated;
        old.superseded_by = Some(new_item.id.clone());
        // Temporal resolver: the OLD assertion stopped being vigente at the moment
        // it was superseded. Recall prefers items with valid_to NULL/future, so
        // this keeps the historical row queryable but out of "current truth".
        old.valid_to = Some(supersede_at);
        old.updated_at = supersede_at;
        store::insert_item(&conn, &old)?;
        sync_index(&old); // W4: drop the superseded (now deprecated) item from the index

        let ev = MemoryEvent::new(EventType::Deprecated, Some(old_id.to_string()), actor)
            .with_reason(format!("superseded by {}", new_item.id));
        let _ = store::insert_event(&conn, &ev);
        let ev2 = MemoryEvent::new(EventType::Created, Some(new_item.id.clone()), actor)
            .with_reason(format!("supersedes {old_id}"));
        let _ = store::insert_event(&conn, &ev2);
        Ok(new_item)
    }

    // -- hard delete (H4: verifiable forget) ---------------------------------

    /// Permanently and irreversibly delete an item (H4 — verifiable forget).
    ///
    /// Unlike [`Self::deprecate`] / `set_status(Rejected|Quarantined)` (which keep
    /// the row but make it non-recall-eligible), `forget` removes the row from the
    /// SoT (`brain.db`) entirely. This is an EXPLICIT, INTENTIONAL erasure (right
    /// to be forgotten / leaked-secret purge), never an automatic lifecycle move.
    ///
    /// Order: get_item (NotFound if absent) -> snapshot `before` for audit ->
    /// `store::delete_item` (SQLite SoT) -> `qdrant_index::remove_item` (best-effort,
    /// keeps reconcile clean) -> append a `MemoryEvent` (`Updated` + reason
    /// `forgotten`, `before` = item_json — the only surviving record of the item).
    pub fn forget(id: &str, actor: Actor, reason: Option<String>) -> Result<(), MemoryError> {
        let conn = store::open_conn()?;
        let item =
            store::get_item(&conn, id)?.ok_or_else(|| MemoryError::NotFound(id.to_string()))?;
        let before = serde_json::to_string(&item).unwrap_or_default();
        // Remove from the SoT (SQLite). Propagate any error — the delete MUST land.
        store::delete_item(&conn, id)?;
        // Best-effort: drop the derived dense point so recall can't resurface it.
        let _ = super::qdrant_index::remove_item(id);
        let reason = reason.unwrap_or_else(|| "forgotten".to_string());
        let ev = MemoryEvent::new(EventType::Updated, Some(id.to_string()), actor)
            .with_reason(reason)
            .with_before(before);
        let _ = store::insert_event(&conn, &ev);
        Ok(())
    }

    // -- stats ---------------------------------------------------------------

    pub fn stats() -> Result<MemoryStats, MemoryError> {
        let conn = store::open_conn()?;
        Ok(MemoryStats {
            active: store::count_items_by_status(&conn, Status::Active),
            pending: store::count_items_by_status(&conn, Status::Pending),
            rejected: store::count_items_by_status(&conn, Status::Rejected),
            deprecated: store::count_items_by_status(&conn, Status::Deprecated),
            stale: store::count_items_by_status(&conn, Status::Stale),
            candidates_pending: store::count_candidates_pending(&conn),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::model::{MemoryType, Scope};
    use super::*;
    use rusqlite::Connection;

    // These tests drive the low-level store directly through an in-memory conn
    // to assert the *governance* behaviour the service guarantees, without
    // depending on the real ~/.ultron/brain.db path.

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        store::apply_schema(&conn).expect("schema");
        conn
    }

    #[test]
    fn rejected_candidate_never_becomes_active_memory() {
        let conn = mem_conn();
        let c = MemoryCandidate::new(MemoryType::Preference, Scope::User);
        store::insert_candidate(&conn, &c).unwrap();
        store::set_candidate_status(&conn, &c.id, CandidateStatus::Rejected).unwrap();

        // No active item should exist for a rejected candidate.
        let active = store::list_items(&conn, Status::Active, 100).unwrap();
        assert!(
            active.is_empty(),
            "rejecting a candidate must not create memory"
        );
    }

    #[test]
    fn pending_item_is_not_recall_eligible() {
        let conn = mem_conn();
        let mut pending = MemoryItem::new(
            MemoryType::Fact,
            Scope::Project,
            Source::AssistantInferred,
            Status::Pending,
        );
        pending.summary = Some("tentative fact about routing".into());
        store::insert_item(&conn, &pending).unwrap();

        let hits = store::search_items(&conn, "routing", Status::Active, 10).unwrap();
        assert!(
            hits.is_empty(),
            "pending memory must not be treated as truth"
        );
    }

    #[test]
    fn deprecated_item_drops_out_of_active_recall() {
        let conn = mem_conn();
        let mut item = MemoryItem::new(
            MemoryType::Decision,
            Scope::Project,
            Source::UserExplicit,
            Status::Active,
        );
        item.summary = Some("use sqlite as canonical store".into());
        store::insert_item(&conn, &item).unwrap();
        assert_eq!(
            store::search_items(&conn, "canonical", Status::Active, 10)
                .unwrap()
                .len(),
            1
        );

        // deprecate
        item.status = Status::Deprecated;
        store::insert_item(&conn, &item).unwrap();
        assert!(store::search_items(&conn, "canonical", Status::Active, 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn sensitivity_is_raised_on_secret_and_never_downgraded() {
        use super::super::model::Sensitivity;
        // a detected credential raises to Secret regardless of prior class
        assert_eq!(
            raised_sensitivity(Sensitivity::Internal, true),
            Sensitivity::Secret
        );
        assert_eq!(
            raised_sensitivity(Sensitivity::Public, true),
            Sensitivity::Secret
        );
        // no secret -> preserve current; monotonic, never downgrades
        assert_eq!(
            raised_sensitivity(Sensitivity::Internal, false),
            Sensitivity::Internal
        );
        assert_eq!(
            raised_sensitivity(Sensitivity::Secret, false),
            Sensitivity::Secret
        );
    }
}
