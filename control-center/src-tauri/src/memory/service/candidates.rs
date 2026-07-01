// memory/service/candidates.rs — candidate intake (what hooks/agents call)
//
// Covers: create_candidate, edit_candidate, list_pending_candidates,
//         approve_candidate, reject_candidate.

use super::super::model::{
    Actor, CandidateAction, CandidateStatus, EventType, MemoryCandidate, MemoryEvent, MemoryItem,
    Source, Status,
};
use super::super::MemoryError;
use super::super::{redaction, sqlite_store as store};
use super::{raised_sensitivity, redact_tags, sync_index, MemoryService, SECRET_RISK_MARKER};

/// Añade un marcador de verificación-incompleta a `tags` (idempotente). Estos
/// marcadores (`auto_approve::UNVERIFIED_TAGS`) hacen `candidate_is_clean` devolver
/// false → FAIL-CLOSED: lo que el write-path no pudo verificar NO se auto-aprueba.
fn mark_unverified(tags: &mut Vec<String>, marker: &str) {
    if !tags.iter().any(|t| t.eq_ignore_ascii_case(marker)) {
        tags.push(marker.to_string());
    }
}

/// Texto concatenado de TODOS los campos del candidato que deben pasar el scan de
/// PII (paridad con la redacción de credenciales, que ya cubre `content_json` y
/// `tags`). Su omisión pre-1.7 dejaba PII en `content_json`/`tags` sin elevar Secret.
pub(super) fn pii_scan_text(cand: &MemoryCandidate) -> String {
    let tags_joined = cand.proposed_tags.join(" ");
    [
        cand.proposed_title.as_deref(),
        cand.proposed_summary.as_deref(),
        cand.proposed_content.as_deref(),
        cand.proposed_content_json.as_deref(),
        cand.proposed_file_path.as_deref(),
        cand.proposed_signature.as_deref(),
        cand.proposed_symbol.as_deref(),
        Some(tags_joined.as_str()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
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
        // Code-location fields (proposed_file_path, proposed_signature) are also
        // redacted: a tool/hook may embed a token (ghp_, sk-) in a file path or
        // signature line, e.g. `C:/Users/name/ghp_token/repo` or a fn signature
        // containing a hard-coded key. Credential redaction applies to all fields;
        // PII (user-path) redaction in the write-path PII guard below covers them
        // as well via the combined `proposed_text` scan.
        let mut redacted = false;
        redacted |= redaction::redact_in_place(&mut cand.proposed_title);
        redacted |= redaction::redact_in_place(&mut cand.proposed_summary);
        redacted |= redaction::redact_in_place(&mut cand.proposed_content);
        redacted |= redaction::redact_in_place(&mut cand.proposed_content_json);
        redacted |= redact_tags(&mut cand.proposed_tags);
        // Code-location fields — credential redaction (ghp_, sk-, AKIA, Bearer…).
        redacted |= redaction::redact_in_place(&mut cand.proposed_file_path);
        redacted |= redaction::redact_in_place(&mut cand.proposed_signature);
        // 1.7: proposed_symbol ("file_path:symbol") puede llevar una ruta con username.
        redacted |= redaction::redact_in_place(&mut cand.proposed_symbol);

        // Basic FTS dedupe: flag near-identical ACTIVE items as duplicates so the
        // inbox can merge instead of creating a redundant memory. (Semantic dedupe
        // + contradiction detection via embeddings/AI routing is Fase D — TODO below.)
        if let Some(summary) = cand.proposed_summary.clone() {
            if !summary.trim().is_empty() {
                match store::search_items(&conn, &summary, Status::Active, 3) {
                    Ok(similar) => {
                        let dups: Vec<String> = similar.into_iter().map(|i| i.id).collect();
                        if !dups.is_empty() {
                            cand.duplicate_candidates = dups;
                            cand.recommended_action = CandidateAction::Merge;
                        }
                    }
                    Err(e) => {
                        // 1.7 fail-closed: no se pudo comprobar duplicados (Err FTS5/SQLite).
                        // Marcar NO auto-aprobable para que un fallo transitorio no regrese
                        // el bug 1.2 (las 211 copias). Va al inbox.
                        eprintln!(
                            "[service::create_candidate] dedupe search failed: {e} — \
                             candidate {} marked dedup-unverified",
                            cand.id
                        );
                        mark_unverified(&mut cand.proposed_tags, "dedup-unverified");
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
            let probe_hash = super::super::texthash::content_hash(&probe_text);
            // Scope/project guard (CONTRACTS §4 + review P1): an exact text match in a
            // DIFFERENT project/scope is a near-duplicate, NOT a duplicate — never merge
            // across the project boundary. find_active_by_content_hash filters by
            // (scope, project_id) so cross-project collisions can't trigger a Merge.
            match store::find_active_by_content_hash(
                &conn,
                &probe_hash,
                probe.scope,
                probe.project_id.as_deref(),
            ) {
                Ok(Some(existing)) => {
                    if !cand.duplicate_candidates.contains(&existing.id) {
                        cand.duplicate_candidates.push(existing.id);
                    }
                    cand.recommended_action = CandidateAction::Merge;
                }
                Ok(None) => {} // verificado: sin duplicado exacto.
                Err(e) => {
                    // 1.7 fail-closed: hash-dedupe no verificable (Err) -> inbox.
                    eprintln!(
                        "[service::create_candidate] content-hash dedupe failed: {e} — \
                         candidate {} marked dedup-unverified",
                        cand.id
                    );
                    mark_unverified(&mut cand.proposed_tags, "dedup-unverified");
                }
            }
        }

        // Write-path PII guard (defence-in-depth for items AFTER the credential
        // gate): detect email/phone/user-path in the proposed text. If found,
        // also apply PII redaction and elevate the risk marker identically to
        // the credential path — the promoted item will be marked Secret on
        // approve, excluding it from recall (sensitivity gate in assemble_pack).
        // 1.7: el scan PII cubre los MISMOS campos que la redacción de credenciales
        // (que ya incluye content_json en L37 + tags en L38). Antes excluía
        // content_json y tags → PII ahí (rutas de agentes/import) no elevaba Secret.
        let proposed_text = pii_scan_text(&cand);
        // NO `!redacted`: credencial y PII son ortogonales — un campo puede llevar
        // un token y OTRO una ruta con username; ambas deben redactarse (audit 2026-06-25).
        if redaction::contains_pii(&proposed_text) {
            // Redact PII from the candidate fields in place (including codegraph
            // fields: a path like C:\Users\name\repo contains the real username).
            if let Some(ref mut t) = cand.proposed_title {
                *t = redaction::redact_pii(t);
            }
            if let Some(ref mut s) = cand.proposed_summary {
                *s = redaction::redact_pii(s);
            }
            if let Some(ref mut c) = cand.proposed_content {
                *c = redaction::redact_pii(c);
            }
            if let Some(ref mut fp) = cand.proposed_file_path {
                *fp = redaction::redact_pii(fp);
            }
            if let Some(ref mut sig) = cand.proposed_signature {
                *sig = redaction::redact_pii(sig);
            }
            // 1.7: redactar también symbol, content_json y tags (paridad scan↔redacción)
            // — una PII embebida ahí ya no se persiste en claro.
            if let Some(ref mut sym) = cand.proposed_symbol {
                *sym = redaction::redact_pii(sym);
            }
            if let Some(ref mut cj) = cand.proposed_content_json {
                *cj = redaction::redact_pii(cj);
            }
            for tag in cand.proposed_tags.iter_mut() {
                *tag = redaction::redact_pii(tag);
            }
        }

        // Write-path sensitivity (OLA A / H2): a candidate that carried a
        // credential OR PII is quarantined (never auto-approved) and tagged so
        // the promoted item is marked Secret on approve. `redacted` reuses the
        // same detector as redaction::classify_sensitivity; takes precedence
        // over Merge. PII-only items also get Secret so the recall gate fires.
        let has_pii = redaction::contains_pii(&proposed_text);
        if redacted || has_pii {
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
        //
        // FAIL-OPEN with bounded latency (fix CRITICAL #1, 2026-06-05):
        //   The LLM judge calls `ai_router::route`, which may block up to
        //   ~6 s when the free-tier quota is exhausted and the retry/backoff
        //   loop fires.  The ai_router fix (short-circuit on free-tier 429)
        //   eliminates most of that delay, but as a defence-in-depth we run
        //   the contradiction check on a background thread with a hard wall-
        //   clock budget.  If the budget expires before a result arrives, we
        //   tag the candidate "unjudged" and proceed without blocking.
        //   The candidate is still created (ACTIVE or PENDING per band policy)
        //   — the hook never times out because of a slow LLM judge.
        //
        //   Budget: 2 000 ms — comfortably below CANDIDATE_TIMEOUT_MS (6 000)
        //   even after accounting for the Qdrant dense-search step (E5 cold-
        //   start ≤ 3 285 ms in the worst case observed).  When Gemini is
        //   exhausted and the short-circuit fix is active, the judge returns
        //   None in < 50 ms, so the budget is never reached in the happy path.
        const CONTRADICTION_BUDGET_MS: u64 = 2_000;
        // 1.3b: si el candidato resulta ser un state-update 1:1 CLARO y `auto_supersede`
        // está ON, aquí guardamos el id del item viejo a deprecar; se ejecuta DESPUÉS de
        // insertar el candidato (fail-safe: si algo falla, queda Pending en el inbox).
        let mut supersede_target: Option<String> = None;
        if !redacted {
            // 1.7: usa el MEJOR texto disponible — summary, o content como fallback — para
            // el juez de contradicción. Antes solo corría con summary => un candidato sin
            // summary pero con content (p.ej. captura de símbolos) saltaba el detector SIN
            // marca y podía auto-aprobarse sin verificar. Sin NINGÚN texto no hay proposición
            // que pueda contradecir (limpio legítimo, no fail-open).
            let check_text = cand
                .proposed_summary
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| {
                    cand.proposed_content
                        .as_deref()
                        .filter(|s| !s.trim().is_empty())
                });
            if let Some(text) = check_text {
                let summary_owned = text.to_string();
                let project_id_owned = probe.project_id.clone();

                // Spawn the check onto a scoped OS thread so we can time-box it
                // without pulling in any async runtime.
                let (tx, rx) = std::sync::mpsc::channel();
                // `conn` is not `Send`; the thread needs its own connection.
                // `open_conn` is cheap (WAL mode, no schema migration on reopen).
                std::thread::spawn(move || {
                    let result = store::open_conn().ok().map(|c| {
                        super::super::contradiction::check(
                            &c,
                            &summary_owned,
                            project_id_owned.as_deref(),
                        )
                    });
                    // Receiver may have dropped (timeout) — ignore send error.
                    let _ = tx.send(result);
                });

                match rx.recv_timeout(std::time::Duration::from_millis(CONTRADICTION_BUDGET_MS)) {
                    Ok(Some(Some(findings))) if !findings.is_empty() => {
                        for f in &findings {
                            if !cand.contradiction_candidates.contains(&f.conflicting_id) {
                                cand.contradiction_candidates.push(f.conflicting_id.clone());
                            }
                        }
                        // 1.3b: un state-update 1:1 CLARO (opt-in) auto-supersede al item
                        // viejo tras insertar; cualquier otra cosa (conflicto real, >1
                        // finding, o el flag OFF) → Quarantine (OUT de recall hasta que un
                        // humano adjudique; toma precedencia sobre Merge).
                        match super::super::contradiction::supersede_disposition(
                            &findings,
                            super::super::auto_approve::auto_supersede_enabled(),
                        ) {
                            super::super::contradiction::Disposition::Supersede(old_id) => {
                                supersede_target = Some(old_id);
                            }
                            _ => {
                                cand.recommended_action = CandidateAction::Quarantine;
                            }
                        }
                    }
                    Ok(Some(Some(_no_findings))) => {
                        // Verificado: la búsqueda corrió y el juez no halló contradicción.
                    }
                    Ok(Some(None)) => {
                        // 1.7 fail-closed END-TO-END: la infra de búsqueda (Qdrant/E5)
                        // estaba caída → NO se pudo verificar contradicción. Antes `check`
                        // colapsaba esto a "sin contradicción" (fail-OPEN). Marcar unjudged.
                        mark_unverified(&mut cand.proposed_tags, "unjudged");
                    }
                    Ok(None) => {
                        // 1.7 fail-closed: el thread no pudo abrir conn → NO verificado.
                        mark_unverified(&mut cand.proposed_tags, "unjudged");
                    }
                    Err(_timeout_or_disconnect) => {
                        // 1.7 fail-closed: budget expirado o thread panicó → NO verificado
                        // (antes fail-OPEN: se auto-aprobaba sin verdicto). Tag unjudged →
                        // inbox; el hook nunca se cuelga por un juez lento.
                        eprintln!(
                            "[service::create_candidate] contradiction check unresolved \
                             (timeout >{CONTRADICTION_BUDGET_MS}ms or thread panic) — \
                             candidate {} marked unjudged",
                            cand.id
                        );
                        mark_unverified(&mut cand.proposed_tags, "unjudged");
                    }
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

        // 1.3b AUTO-SUPERSEDE (opt-in, default OFF). El candidato es un state-update
        // 1:1 de `old_id` → lo promovemos a ACTIVE deprecando el viejo, reusando el
        // MISMO builder candidate→item que `approve_candidate`. Orden fail-safe: el
        // `supersede` (crea el nuevo item + deprecia el viejo, con redaction/índice) va
        // PRIMERO; solo si tiene éxito marcamos el candidato Approved. Si falla, el
        // candidato ya está Pending en el inbox — no se pierde ni se corrompe nada.
        if let Some(old_id) = supersede_target {
            let new_item = cand.to_item(Status::Active, Source::AssistantInferred);
            drop(conn); // supersede abre su propia conexión.
            match Self::supersede(&old_id, new_item, Actor::System) {
                Ok(_) => {
                    if let Ok(c2) = store::open_conn() {
                        let _ =
                            store::set_candidate_status(&c2, &cand.id, CandidateStatus::Approved);
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[service::create_candidate] auto-supersede de {old_id} falló ({e}); \
                         candidato {} queda Pending en el inbox",
                        cand.id
                    );
                }
            }
            return Ok(cand.id.clone());
        }

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
        if super::super::auto_approve::auto_approve_enabled()
            && super::super::auto_approve::candidate_is_clean(&cand)
        {
            let threshold = super::super::auto_approve::auto_approve_threshold();
            match super::super::auto_approve::classify_band(&cand, threshold) {
                super::super::auto_approve::AutoBand::Approve => {
                    drop(conn); // approve_candidate opens its own connection.
                    let _ = Self::approve_candidate(&cand.id, Actor::System);
                }
                super::super::auto_approve::AutoBand::Pending => {
                    // No-op: it is already persisted Pending in the inbox.
                }
                super::super::auto_approve::AutoBand::Reject => {
                    // Low-confidence noise: flip to `rejected` (out of recall) and
                    // record the policy decision in the audit log. Swallow errors —
                    // worst case it lingers as Pending, which is still safe.
                    let _ = store::set_candidate_status(&conn, &cand.id, CandidateStatus::Rejected);
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
        use super::super::model::now_millis;
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
}
