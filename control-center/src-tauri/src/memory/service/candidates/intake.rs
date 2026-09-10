// memory/service/candidates/intake.rs — alta de candidatos (lo que llaman los
// hooks y los agentes): create_candidate, edit_candidate, list_pending_candidates.

use super::super::super::model::{
    Actor, CandidateAction, CandidateStatus, EventType, MemoryCandidate, MemoryEvent, Source,
    Status,
};
use super::super::super::MemoryError;
use super::super::super::{redaction, sqlite_store as store};
use super::super::{redact_tags, MemoryService, SECRET_RISK_MARKER};
use super::{
    discard_log, find_exact_duplicate, jaccard_overlap, mark_unverified, paraphrase, pii_scan_text,
    NEAR_DUP_JACCARD,
};

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

        mark_near_dups(&conn, &mut cand);

        // (a) 2026-07-02 — dedupe EXACTO ahora BLOQUEA (antes: solo marcaba Merge).
        // Un twin identico (item ACTIVO o candidato PENDING, mismo scope+proyecto)
        // hace NO-OP el write: evento auditable + Err(Duplicate) con el id que ya
        // cubre el contenido. El FTS near-dup de arriba sigue SOLO marcando (lo
        // parecido lo juzga un humano; lo identico no aporta nada y no entra).
        // Fail-closed sin bloquear: si el check no corre, inbox + dedup-unverified.
        let probe = cand.to_item(Status::Active, Source::AssistantInferred);
        match find_exact_duplicate(&conn, &cand) {
            Ok(Some(existing_id)) => {
                let ev = MemoryEvent::new(EventType::Rejected, None, Actor::System).with_reason(
                    format!(
                        "candidate {} skipped: exact duplicate of {existing_id} \
                         (write-path dedupe)",
                        cand.id
                    ),
                );
                let _ = store::insert_event(&conn, &ev);
                return Err(MemoryError::Duplicate(existing_id));
            }
            Ok(None) => {} // verificado: sin duplicado exacto.
            Err(e) => {
                // 1.7 fail-closed: dedupe no verificable (Err) -> inbox.
                eprintln!(
                    "[service::create_candidate] exact dedupe failed: {e} — \
                     candidate {} marked dedup-unverified",
                    cand.id
                );
                mark_unverified(&mut cand.proposed_tags, "dedup-unverified");
            }
        }

        // (2026-09-06) Gate ANTI-PARÁFRASIS. El mismo hecho REFORMULADO dentro de
        // las últimas 24 h (mismo proyecto, o mismo scope si no lo hay) tampoco
        // entra: el dedupe exacto solo ve texto idéntico y el near-dup FTS depende
        // de que la query term-OR traiga el twin al top-3, así que la misma
        // decisión entró TRES veces en una sesión (ids 8408e95a / edaa6ece /
        // f821560c). Mismo contrato que el dedupe exacto — evento auditable +
        // Err(Duplicate) con el id del original — más una línea en
        // capture-discards.jsonl para poder revisar falsos positivos.
        match paraphrase::find_paraphrase_dup(&conn, &cand) {
            Ok(Some(original_id)) => {
                discard_log::log_paraphrase_discard(&cand, &original_id);
                let ev = MemoryEvent::new(EventType::Rejected, None, Actor::System).with_reason(
                    format!(
                        "candidate {} skipped: paraphrase_dup of {original_id} \
                         (write-path anti-paraphrase gate)",
                        cand.id
                    ),
                );
                let _ = store::insert_event(&conn, &ev);
                return Err(MemoryError::Duplicate(original_id));
            }
            Ok(None) => {} // verificado: no es una reformulación reciente.
            Err(e) => {
                // Fail-closed igual que el dedupe exacto: no verificable -> inbox.
                eprintln!(
                    "[service::create_candidate] paraphrase gate failed: {e} — \
                     candidate {} marked dedup-unverified",
                    cand.id
                );
                mark_unverified(&mut cand.proposed_tags, "dedup-unverified");
            }
        }

        // Write-path PII guard (defence-in-depth for items AFTER the credential
        // gate): detect email/phone/user-path in the proposed text. If found,
        // also apply PII redaction and elevate the risk marker identically to
        // the credential path — the promoted item will be marked Secret on
        // approve, excluding it from recall (sensitivity gate in assemble_pack).
        // 1.7: el scan PII cubre los MISMOS campos que la redacción de credenciales
        // (que ya incluye content_json + tags). Antes excluía content_json y tags →
        // PII ahí (rutas de agentes/import) no elevaba Secret.
        let proposed_text = pii_scan_text(&cand);
        // NO `!redacted`: credencial y PII son ortogonales — un campo puede llevar
        // un token y OTRO una ruta con username; ambas deben redactarse (audit 2026-06-25).
        if redaction::contains_pii(&proposed_text) {
            redact_pii_in_place(&mut cand);
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

        let supersede_target = if redacted {
            None
        } else {
            judge_contradictions(&mut cand, probe.project_id.as_deref())
        };

        store::insert_candidate(&conn, &cand)?;
        let ev = MemoryEvent::new(EventType::Created, None, Actor::System)
            .with_reason(created_reason(&cand, redacted))
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

        drop(conn); // las ramas de la política abren su propia conexión.
        apply_auto_band(&cand);
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
}

/// Basic FTS dedupe: flag near-identical ACTIVE items as duplicates so the inbox
/// can merge instead of creating a redundant memory. Solo MARCA (Merge); lo que
/// bloquea es el dedupe exacto + el gate anti-paráfrasis.
///
/// 1.7 fail-closed: si la búsqueda falla (Err FTS5/SQLite) el candidato queda
/// `dedup-unverified` → NO auto-aprobable, para que un fallo transitorio no
/// regrese el bug 1.2 (las 211 copias).
fn mark_near_dups(conn: &rusqlite::Connection, cand: &mut MemoryCandidate) {
    let Some(summary) = cand.proposed_summary.clone() else {
        return;
    };
    if summary.trim().is_empty() {
        return;
    }
    match store::search_items(conn, &summary, Status::Active, 3) {
        Ok(similar) => {
            // Confirmación Jaccard: search_items es term-OR (recall), así que un
            // hit solo cuenta como near-dup si comparte de verdad la mitad del
            // vocabulario (ver jaccard_overlap).
            let dups: Vec<String> = similar
                .into_iter()
                .filter(|i| {
                    let hay = format!(
                        "{} {}",
                        i.title.as_deref().unwrap_or(""),
                        i.summary.as_deref().unwrap_or("")
                    );
                    jaccard_overlap(&summary, &hay) >= NEAR_DUP_JACCARD
                })
                .map(|i| i.id)
                .collect();
            if !dups.is_empty() {
                cand.duplicate_candidates = dups;
                cand.recommended_action = CandidateAction::Merge;
            }
        }
        Err(e) => {
            eprintln!(
                "[service::create_candidate] dedupe search failed: {e} — \
                 candidate {} marked dedup-unverified",
                cand.id
            );
            mark_unverified(&mut cand.proposed_tags, "dedup-unverified");
        }
    }
}

/// Redacta PII en TODOS los campos propuestos (incluidos los de codegraph: una
/// ruta `C:\Users\name\repo` lleva el username real).
fn redact_pii_in_place(cand: &mut MemoryCandidate) {
    for field in [
        &mut cand.proposed_title,
        &mut cand.proposed_summary,
        &mut cand.proposed_content,
        &mut cand.proposed_file_path,
        &mut cand.proposed_signature,
        // 1.7: symbol y content_json también (paridad scan↔redacción).
        &mut cand.proposed_symbol,
        &mut cand.proposed_content_json,
    ]
    .into_iter()
    .flatten()
    {
        *field = redaction::redact_pii(field);
    }
    for tag in cand.proposed_tags.iter_mut() {
        *tag = redaction::redact_pii(tag);
    }
}

/// Razón del evento `Created` según lo que detectó el write-path.
fn created_reason(cand: &MemoryCandidate, redacted: bool) -> String {
    if redacted {
        format!("candidate {} proposed (secrets redacted)", cand.id)
    } else if !cand.contradiction_candidates.is_empty() {
        format!(
            "candidate {} proposed (contradicts {} active item(s) — quarantined)",
            cand.id,
            cand.contradiction_candidates.len()
        )
    } else {
        format!("candidate {} proposed", cand.id)
    }
}

/// Budget de pared del juez de contradicción — 4 500 ms, por debajo de
/// CANDIDATE_TIMEOUT_MS (6 000) pero con hueco para el caso REAL medido
/// (2026-07-02): cada spawn del CLI carga E5 in-proc (~1,4-3,3 s aun con page
/// cache caliente), así que con 2 000 ms TODO candidato one-shot quedaba
/// `unjudged` → pending → el inbox autónomo se re-acumulaba estructuralmente.
/// Los hooks que llaman `candidate` son async/detached (posttoolfail 10 s, stop
/// 25 s), de modo que los 2,5 s extra no bloquean nada interactivo.
const CONTRADICTION_BUDGET_MS: u64 = 4_500;

/// Fase D — contradiction detector. Compara la proposición contra los items
/// ACTIVOS semánticamente cercanos del MISMO proyecto (memory/contradiction.rs:
/// vecinos densos + juez LLM fail-safe). Con conflicto confirmado solo MARCA:
/// rellena `contradiction_candidates` y manda a Quarantine para adjudicación
/// humana. NUNCA auto-resuelve ni descarta, y el detector es CONSERVADOR (el
/// juez devuelve false ante cualquier duda), así que no puede inundar el inbox.
///
/// FAIL-OPEN con latencia acotada (fix CRITICAL #1, 2026-06-05): el juez llama a
/// `ai_router::route`, que puede bloquear ~6 s si la cuota free-tier se agotó.
/// Corre en un hilo con presupuesto de pared; si expira, el candidato se marca
/// `unjudged` y el hook nunca se cuelga por un juez lento.
///
/// Devuelve el id a deprecar cuando (1.3b) el candidato es un state-update 1:1
/// CLARO y `auto_supersede` está ON; el llamante lo ejecuta DESPUÉS de insertar.
fn judge_contradictions(cand: &mut MemoryCandidate, project_id: Option<&str>) -> Option<String> {
    // 1.7: usa el MEJOR texto disponible — summary, o content como fallback. Antes
    // solo corría con summary => un candidato sin summary pero con content (p.ej.
    // captura de símbolos) saltaba el detector SIN marca y podía auto-aprobarse sin
    // verificar. Sin NINGÚN texto no hay proposición que pueda contradecir.
    let check_text = cand
        .proposed_summary
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            cand.proposed_content
                .as_deref()
                .filter(|s| !s.trim().is_empty())
        })?;
    let summary_owned = check_text.to_string();
    let project_id_owned = project_id.map(str::to_string);

    // Hilo del SO (sin runtime async) para poder acotar el tiempo. `conn` no es
    // `Send`: el hilo abre la suya (open_conn es barato, WAL, sin migración).
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = store::open_conn().ok().map(|c| {
            super::super::super::contradiction::check(
                &c,
                &summary_owned,
                project_id_owned.as_deref(),
            )
        });
        let _ = tx.send(result); // el receptor puede haber caducado
    });

    match rx.recv_timeout(std::time::Duration::from_millis(CONTRADICTION_BUDGET_MS)) {
        Ok(Some(Some(findings))) if !findings.is_empty() => {
            apply_contradiction_findings(cand, &findings)
        }
        Ok(Some(Some(_no_findings))) => None, // verificado: sin contradicción
        Ok(Some(None)) | Ok(None) => {
            // 1.7 fail-closed END-TO-END: infra de búsqueda caída, o el hilo no
            // pudo abrir conn → NO verificado (antes fail-OPEN: se auto-aprobaba).
            mark_unverified(&mut cand.proposed_tags, "unjudged");
            None
        }
        Err(_timeout_or_disconnect) => {
            eprintln!(
                "[service::create_candidate] contradiction check unresolved \
                 (timeout >{CONTRADICTION_BUDGET_MS}ms or thread panic) — \
                 candidate {} marked unjudged",
                cand.id
            );
            mark_unverified(&mut cand.proposed_tags, "unjudged");
            None
        }
    }
}

/// Anota los ids en conflicto y decide disposición: state-update 1:1 claro con
/// el flag ON → supersede (devuelve el id viejo); cualquier otra cosa →
/// Quarantine (fuera del recall hasta que un humano adjudique).
fn apply_contradiction_findings(
    cand: &mut MemoryCandidate,
    findings: &[super::super::super::contradiction::ContradictionFinding],
) -> Option<String> {
    for f in findings {
        if !cand.contradiction_candidates.contains(&f.conflicting_id) {
            cand.contradiction_candidates.push(f.conflicting_id.clone());
        }
    }
    match super::super::super::contradiction::supersede_disposition(
        findings,
        super::super::super::auto_approve::auto_supersede_enabled(),
    ) {
        super::super::super::contradiction::Disposition::Supersede(old_id) => Some(old_id),
        _ => {
            cand.recommended_action = CandidateAction::Quarantine;
            None
        }
    }
}

/// Auto-validation 3-band policy (opt-in). Con el ajuste persistido
/// `auto_approve` ON y el candidato LIMPIO, la banda por confianza decide:
///
///   BANDA A (confianza >= umbral): promoción directa a ACTIVE por el MISMO
///     camino `approve_candidate` que usa la UI humana (redacción / sensibilidad
///     / sync de índice siguen aplicando). Aprobado como Actor::System (política,
///     no validación humana → NO marcado `validated_by_user`).
///   BANDA B (confianza media, o kind decision/architecture): se queda PENDING.
///   BANDA C (confianza < REJECT_THRESHOLD): `rejected`, nunca entra en recall.
///
/// SALVAGUARDA: `candidate_is_clean` es FALSE para cualquier candidato con el
/// marcador de secreto o una contradicción, así que esos SIEMPRE se quedan en el
/// inbox. FAIL-SAFE: `auto_approve_threshold` lee f32::INFINITY ante cualquier
/// error de settings y `auto_approve_enabled` por defecto es false. Todos los
/// errores se tragan: el candidato ya está a salvo en el inbox.
fn apply_auto_band(cand: &MemoryCandidate) {
    use super::super::super::auto_approve;
    if !auto_approve::auto_approve_enabled() || !auto_approve::candidate_is_clean(cand) {
        return;
    }
    let threshold = auto_approve::auto_approve_threshold();
    match auto_approve::classify_band(cand, threshold) {
        auto_approve::AutoBand::Approve => {
            let _ = MemoryService::approve_candidate(&cand.id, Actor::System);
        }
        auto_approve::AutoBand::Pending => {
            // No-op: ya está persistido Pending en el inbox.
        }
        auto_approve::AutoBand::Reject => {
            // Ruido de baja confianza: a `rejected` (fuera del recall) con la
            // decisión de política en el log. Errores tragados — en el peor caso
            // se queda Pending, que sigue siendo seguro.
            let Ok(conn) = store::open_conn() else { return };
            let _ = store::set_candidate_status(&conn, &cand.id, CandidateStatus::Rejected);
            let ev =
                MemoryEvent::new(EventType::Rejected, None, Actor::System).with_reason(format!(
                    "candidate {} auto-rejected (confidence {:.2} < band-C floor)",
                    cand.id, cand.confidence
                ));
            let _ = store::insert_event(&conn, &ev);
        }
    }
}
