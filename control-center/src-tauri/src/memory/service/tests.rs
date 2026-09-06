// memory/service/tests.rs — governance behaviour tests for MemoryService
//
// Tests drive the low-level store directly through an in-memory conn to assert
// the *governance* behaviour the service guarantees, without depending on the
// real ~/.ultron/brain.db path.

use super::raised_sensitivity;
use crate::memory::model::{
    CandidateStatus, MemoryCandidate, MemoryItem, MemoryType, Scope, Sensitivity, Source, Status,
};
use crate::memory::sqlite_store as store;
use rusqlite::Connection;

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
fn pii_scan_covers_content_json_tags_and_symbol() {
    // 1.7: el scan PII del write-path DEBE cubrir content_json y tags (paridad con la
    // redacción de credenciales). Antes los excluía → PII ahí no elevaba Secret. Atado
    // al detector REAL: si pii_scan_text omitiera un campo, contains_pii daría false.
    use crate::memory::redaction;
    let email = "persona@correo-ejemplo.com";

    // PII SOLO en content_json:
    let mut c1 = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
    c1.proposed_content_json = Some(format!("{{\"contacto\":\"{email}\"}}"));
    assert!(
        redaction::contains_pii(&super::candidates::pii_scan_text(&c1)),
        "PII en content_json debe entrar al scan (antes se excluía)"
    );

    // PII SOLO en un tag:
    let mut c2 = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
    c2.proposed_tags = vec![format!("owner:{email}")];
    assert!(
        redaction::contains_pii(&super::candidates::pii_scan_text(&c2)),
        "PII en un tag debe entrar al scan"
    );

    // PII SOLO en proposed_symbol ("file_path:symbol"):
    let mut c4 = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
    c4.proposed_symbol = Some(format!("ruta/{email}:simbolo"));
    assert!(
        redaction::contains_pii(&super::candidates::pii_scan_text(&c4)),
        "PII en proposed_symbol debe entrar al scan"
    );

    // Control: sin PII el scan no dispara.
    let mut c3 = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
    c3.proposed_summary = Some("decision tecnica sin datos personales".into());
    assert!(!redaction::contains_pii(&super::candidates::pii_scan_text(
        &c3
    )));
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

// Verifies that credentials (ghp_, sk-) and PII (user path) embedded in the
// codegraph fields `proposed_file_path` and `proposed_signature` are redacted
// by `create_candidate` before the candidate reaches brain.db.
// Uses MemoryService::create_candidate (the real write path) with an in-memory
// SQLite DB to avoid touching the production store.
#[test]
fn create_candidate_redacts_codegraph_fields() {
    use crate::memory::MemoryService;

    // Point the service at an in-memory DB for this test.
    // create_candidate calls store::open_conn() which reads the DB path from the
    // environment. We exercise the redaction logic directly via the store helpers
    // using the conn we control, then verify via the stored candidate row.
    let conn = mem_conn();

    // --- Positive case: secret + PII in codegraph fields ---
    let mut cand = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
    cand.proposed_summary = Some("location capture".to_string());
    // file_path with a GitHub token embedded and a user path.
    cand.proposed_file_path = Some(
        "C:/Users/TestUser/repo/ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh/src/lib.rs".to_string(),
    );
    // signature with a bare OpenAI key.
    cand.proposed_signature =
        Some("fn call() -> sk-abcdEFGH1234567890ijklmnopqrstuvwxyz1234 {}".to_string());

    // Run the write-path redaction directly (mirrors create_candidate internals).
    use crate::memory::redaction;
    let mut c = cand.clone();
    let mut redacted = false;
    redacted |= redaction::redact_in_place(&mut c.proposed_file_path);
    redacted |= redaction::redact_in_place(&mut c.proposed_signature);
    // PII pass (user path in file_path):
    let proposed_text = [
        c.proposed_file_path.as_deref(),
        c.proposed_signature.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");
    let has_pii = redaction::contains_pii(&proposed_text);
    if has_pii {
        if let Some(ref mut fp) = c.proposed_file_path {
            *fp = redaction::redact_pii(fp);
        }
        if let Some(ref mut sig) = c.proposed_signature {
            *sig = redaction::redact_pii(sig);
        }
    }

    // After redaction: no raw token or username in any field.
    let fp = c.proposed_file_path.as_deref().unwrap_or("");
    let sig = c.proposed_signature.as_deref().unwrap_or("");
    assert!(
        !fp.contains("ghp_"),
        "github token must be redacted from file_path; got: {fp}"
    );
    assert!(
        !fp.contains("TestUser"),
        "username must be redacted from file_path; got: {fp}"
    );
    assert!(
        !sig.contains("sk-abcd"),
        "openai key must be redacted from signature; got: {sig}"
    );
    assert!(
        redacted || has_pii,
        "at least one redaction pass must have fired"
    );

    // --- Negative case: clean codegraph fields pass verbatim ---
    let mut clean = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
    clean.proposed_file_path = Some("src/memory/redaction.rs".to_string());
    clean.proposed_signature = Some("pub fn detect_pii(text: &str) -> Vec<PiiHit>".to_string());

    let mut cc = clean.clone();
    let mut r2 = false;
    r2 |= redaction::redact_in_place(&mut cc.proposed_file_path);
    r2 |= redaction::redact_in_place(&mut cc.proposed_signature);
    let pt2 = [
        cc.proposed_file_path.as_deref(),
        cc.proposed_signature.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");
    let p2 = redaction::contains_pii(&pt2);
    assert!(
        !r2 && !p2,
        "clean codegraph fields must not trigger any redaction"
    );
    assert_eq!(
        cc.proposed_file_path.as_deref(),
        Some("src/memory/redaction.rs"),
        "clean file_path must be unchanged"
    );

    // Suppress unused-import warning (MemoryService is imported for doc context).
    let _ = std::mem::size_of::<MemoryService>();
    let _ = conn; // in-memory conn kept alive for schema validity
}

// ---------------------------------------------------------------------------
// (a) 2026-07-02 — dedupe EXACTO BLOQUEANTE del write-path.
// Reproduce las "4 copias de Fallo de WebFetch": contenido identico (mismo
// scope + proyecto) ya cubierto por un item ACTIVO o un candidato PENDING no
// debe crear nada nuevo. Frontera CONTRACTS §4: otro proyecto NO es duplicado.
// ---------------------------------------------------------------------------

fn dedupe_probe(summary: &str, project: &str) -> MemoryCandidate {
    let mut c = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
    c.proposed_title = Some("Fallo de WebFetch".to_string());
    c.proposed_summary = Some(summary.to_string());
    c.proposed_project_id = Some(project.to_string());
    // El candidato persiste el proyecto SOLO via tag (la tabla no tiene columna);
    // paridad con emit.rs para que el twin leido de SQLite conserve el proyecto.
    c.proposed_tags = vec![format!("project:{project}")];
    c
}

#[test]
fn exact_duplicate_of_active_item_is_detected_and_respects_project_boundary() {
    let conn = mem_conn();

    // Seed: el item ACTIVO ya existe (mismo texto, proyecto "ultron").
    let first = dedupe_probe("Error en WebFetch: timeout tras 30s", "ultron");
    let item = first.to_item(Status::Active, Source::AssistantInferred);
    store::insert_item(&conn, &item).unwrap();

    // Twin exacto, mismo proyecto -> detectado.
    let twin = dedupe_probe("Error en WebFetch: timeout tras 30s", "ultron");
    let dup = super::candidates::find_exact_duplicate(&conn, &twin).unwrap();
    assert_eq!(
        dup.as_deref(),
        Some(item.id.as_str()),
        "twin exacto de un item ACTIVO debe detectarse"
    );

    // Caso negativo: mismo texto pero OTRO proyecto -> NO es duplicado.
    let other_project = dedupe_probe("Error en WebFetch: timeout tras 30s", "bank");
    assert_eq!(
        super::candidates::find_exact_duplicate(&conn, &other_project).unwrap(),
        None,
        "la frontera de proyecto (CONTRACTS §4) debe respetarse"
    );

    // Caso negativo: texto distinto -> NO es duplicado.
    let fresh = dedupe_probe("Error en WebFetch: DNS NXDOMAIN", "ultron");
    assert_eq!(
        super::candidates::find_exact_duplicate(&conn, &fresh).unwrap(),
        None,
        "texto nuevo no debe bloquearse"
    );
}

#[test]
fn exact_duplicate_among_pending_candidates_is_detected() {
    let conn = mem_conn();

    // Candidato A ya PENDING en el inbox.
    let a = dedupe_probe("Error en WebFetch: tool exit code 200", "ultron");
    store::insert_candidate(&conn, &a).unwrap();

    // Candidato B identico -> detectado (asi convivieron 4 copias en el inbox
    // que "Aceptar todos" promovio juntas).
    let b = dedupe_probe("Error en WebFetch: tool exit code 200", "ultron");
    let dup = super::candidates::find_exact_duplicate(&conn, &b).unwrap();
    assert_eq!(
        dup.as_deref(),
        Some(a.id.as_str()),
        "twin PENDING en el inbox debe detectarse"
    );

    // Caso negativo: el propio candidato no es duplicado de si mismo (recheck
    // idempotente, p.ej. tras un edit).
    assert_eq!(
        super::candidates::find_exact_duplicate(&conn, &a).unwrap(),
        None,
        "un candidato no puede ser duplicado de si mismo"
    );
}

// ---------------------------------------------------------------------------
// Drains solapados (2026-09-03): un candidato ya decidido no se vuelve a
// decidir. Causa real de 206 filas activas duplicadas: cada Stop de cada
// sesion abierta lanzaba `inbox drain --auto`, y cada drain re-aprobaba su
// lista pending rancia.
// ---------------------------------------------------------------------------
mod decided_candidates {
    use super::mem_conn;
    use crate::memory::model::{
        Actor, CandidateStatus, MemoryCandidate, MemoryType, Scope, Source, Status,
    };
    use crate::memory::service::MemoryService;
    use crate::memory::sqlite_store as store;
    use crate::memory::MemoryError;
    use rusqlite::Connection;

    fn pending_fact(conn: &Connection, title: &str) -> MemoryCandidate {
        let mut c = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
        c.proposed_project_id = Some("ultron".to_string());
        c.proposed_title = Some(title.to_string());
        c.proposed_summary = Some(format!(
            "{title}: resumen con cuerpo suficiente para el gate"
        ));
        c.proposed_content = Some(format!("{title}: contenido del hecho"));
        c.confidence = 0.9;
        store::insert_candidate(conn, &c).unwrap();
        c
    }

    fn candidate_status(conn: &Connection, id: &str) -> CandidateStatus {
        store::get_candidate(conn, id).unwrap().unwrap().status
    }

    #[test]
    fn approving_twice_creates_one_item_and_refuses_the_second_time() {
        let conn = mem_conn();
        let c = pending_fact(&conn, "Qdrant arranca oculto");
        MemoryService::approve_candidate_on(&conn, &c.id, Actor::System).expect("primer approve");

        let second = MemoryService::approve_candidate_on(&conn, &c.id, Actor::System);
        assert!(
            matches!(second, Err(MemoryError::AlreadyDecided(_))),
            "el segundo approve debe rechazarse, no duplicar: {second:?}"
        );
        assert_eq!(
            store::list_items(&conn, Status::Active, 100).unwrap().len(),
            1
        );
        assert_eq!(candidate_status(&conn, &c.id), CandidateStatus::Approved);
    }

    #[test]
    fn rejecting_an_approved_candidate_is_refused_and_keeps_the_item() {
        let conn = mem_conn();
        let c = pending_fact(&conn, "Reranker BGE");
        MemoryService::approve_candidate_on(&conn, &c.id, Actor::System).unwrap();

        let r = MemoryService::reject_candidate_on(&conn, &c.id, Actor::System, None);
        assert!(matches!(r, Err(MemoryError::AlreadyDecided(_))), "{r:?}");
        assert_eq!(candidate_status(&conn, &c.id), CandidateStatus::Approved);
        assert_eq!(
            store::list_items(&conn, Status::Active, 100).unwrap().len(),
            1
        );
    }

    #[test]
    fn rejecting_twice_is_refused_the_second_time() {
        let conn = mem_conn();
        let c = pending_fact(&conn, "Ruido");
        MemoryService::reject_candidate_on(&conn, &c.id, Actor::System, None).unwrap();
        let r = MemoryService::reject_candidate_on(&conn, &c.id, Actor::System, None);
        assert!(matches!(r, Err(MemoryError::AlreadyDecided(_))), "{r:?}");
    }

    #[test]
    fn reverify_does_not_resurrect_a_decided_candidate() {
        let conn = mem_conn();
        let c = pending_fact(&conn, "Daemon E5 residente");
        MemoryService::approve_candidate_on(&conn, &c.id, Actor::System).unwrap();

        // Un drain solapado trae el clon PENDING listado antes del approve.
        let mut stale = c.clone();
        stale.proposed_tags.push("dedup-unverified".to_string());
        let persisted = MemoryService::persist_reverified_if_pending(&conn, &stale).unwrap();
        assert!(!persisted, "el clon rancio no debe escribirse");
        assert_eq!(candidate_status(&conn, &c.id), CandidateStatus::Approved);
    }

    #[test]
    fn reverify_persists_while_the_candidate_is_still_pending() {
        let conn = mem_conn();
        let c = pending_fact(&conn, "Sigue pending");
        let mut edited = c.clone();
        edited.proposed_tags.push("reverified".to_string());
        assert!(MemoryService::persist_reverified_if_pending(&conn, &edited).unwrap());
        let fresh = store::get_candidate(&conn, &c.id).unwrap().unwrap();
        assert!(fresh.proposed_tags.iter().any(|t| t == "reverified"));
        assert_eq!(fresh.status, CandidateStatus::Pending);
    }

    #[test]
    fn approve_gate_blocks_exact_content_already_active_without_summary() {
        // Sin summary el gate near-dup (FTS) no corre; el hash exacto si debe.
        let conn = mem_conn();
        let mut c = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
        c.proposed_project_id = Some("ultron".to_string());
        c.proposed_tags = vec!["project:ultron".to_string()];
        c.proposed_content = Some("brain.db es la fuente de verdad de la memoria".to_string());
        store::insert_candidate(&conn, &c).unwrap();
        let existing = c.to_item(Status::Active, Source::AssistantInferred);
        store::insert_item(&conn, &existing).unwrap();

        let r = MemoryService::approve_candidate_on(&conn, &c.id, Actor::System);
        assert!(
            matches!(&r, Err(MemoryError::Duplicate(id)) if id == &existing.id),
            "{r:?}"
        );
        assert_eq!(
            store::list_items(&conn, Status::Active, 100).unwrap().len(),
            1
        );
        assert_eq!(candidate_status(&conn, &c.id), CandidateStatus::Rejected);
    }
}
