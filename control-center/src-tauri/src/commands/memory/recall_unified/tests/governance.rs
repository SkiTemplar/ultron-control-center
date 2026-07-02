// tests/governance.rs — assemble_pack governance invariants: ambient items,
// codebase_fact exclusion, status/sensitivity/project gates, cross-project.

use crate::commands::memory::recall_unified::engine::assemble_pack;
use crate::commands::memory::recall_unified::types_model::{FusedHit, PER_CALL_TOKEN_CAP};
use crate::memory::{Scope, Status};

// 1.0 (recall cross-project): items con project_id=NULL son AMBIENTE y se inyectan
// bajo un filtro de proyecto (como Global); las memorias de OTRO proyecto IDENTIFICADO
// NO. Sin el fix, el 82% del corpus (NULL) era invisible -> "memoria muerta fuera de
// ULTRON" (en Oryntics: 76 memorias reales devolvian 0).
#[test]
fn assemble_pack_admits_ambient_null_project_items() {
    use crate::memory::model::MemoryItem;
    use crate::memory::sqlite_store::{apply_schema, insert_item};
    use crate::memory::{MemoryType, Sensitivity, Source};

    let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
    apply_schema(&conn).expect("schema");

    let mk = |project: Option<&str>, sm: &str| {
        let mut it = MemoryItem::new(
            MemoryType::Fact,
            Scope::Project,
            Source::ToolObserved,
            Status::Active,
        );
        it.summary = Some(sm.to_string());
        it.sensitivity = Sensitivity::Internal;
        it.project_id = project.map(str::to_string);
        it.token_estimate = 20;
        insert_item(&conn, &it).expect("insert");
        it.id
    };

    let ambient = mk(None, "Oryntics es una empresa de IA"); // project_id NULL
    let same = mk(Some("ultron"), "ultron internal"); // otro proyecto
    let foreign = mk(Some("otra-cosa"), "foreign project"); // otro proyecto

    let fused: Vec<FusedHit> = [&ambient, &same, &foreign]
        .iter()
        .enumerate()
        .map(|(i, id)| FusedHit {
            canonical_id: (*id).clone(),
            rrf_score: 1.0 - i as f32 * 0.01,
            dense_rank: Some(i),
            sparse_rank: None,
            dense_score: Some(0.5),
        })
        .collect();

    // Recall scoped a "oryntics" (un proyecto SIN memoria propia tagueada).
    let (injected, _d, _t) = assemble_pack(
        &conn,
        &fused,
        8,
        Some("oryntics"),
        false,
        PER_CALL_TOKEN_CAP,
    );
    let inj: Vec<&String> = injected.iter().map(|e| &e.canonical_id).collect();

    assert!(
        inj.contains(&&ambient),
        "item AMBIENTE (project_id=NULL) debe inyectarse bajo filtro de proyecto"
    );
    assert!(
        !inj.contains(&&same) && !inj.contains(&&foreign),
        "memorias de OTRO proyecto IDENTIFICADO NO deben inyectarse"
    );
}

// 1.5 (codebase_fact estructural): los code-locations por símbolo son datos para
// impact-analysis (codegraph MCP + codegraph_summary), NO memoria conversacional. A
// ~478 items saturaban el pack y expulsaban conocimiento real (Kirkardo R5, bulk-deprecate
// 2026-06-07). Aunque un codebase_fact estuviera ACTIVE, NUNCA debe entrar al pack
// conversacional. Guard de regresión: falla si alguien quita la exclusión por kind.
#[test]
fn assemble_pack_excludes_codebase_fact_even_when_active() {
    use crate::memory::model::MemoryItem;
    use crate::memory::sqlite_store::{apply_schema, insert_item};
    use crate::memory::{MemoryType, Sensitivity, Source};

    let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
    apply_schema(&conn).expect("schema");

    let mk = |kind: MemoryType, sm: &str| {
        let mut it = MemoryItem::new(kind, Scope::Project, Source::CodeObserved, Status::Active);
        it.summary = Some(sm.to_string());
        it.sensitivity = Sensitivity::Internal;
        it.project_id = None; // ambiente: saca el filtro de proyecto de la ecuación
        it.token_estimate = 20;
        insert_item(&conn, &it).expect("insert");
        it.id
    };

    // Ambos ACTIVE y ambiente: la ÚNICA diferencia es el kind.
    let structural = mk(MemoryType::CodebaseFact, "fn assemble_pack en engine.rs");
    let conversational = mk(MemoryType::Fact, "el usuario prefiere E5 1024d para recall");

    let fused: Vec<FusedHit> = [&structural, &conversational]
        .iter()
        .enumerate()
        .map(|(i, id)| FusedHit {
            canonical_id: (*id).clone(),
            rrf_score: 1.0 - i as f32 * 0.01,
            dense_rank: Some(i),
            sparse_rank: None,
            dense_score: Some(0.5),
        })
        .collect();

    let (injected, discarded, _t) =
        assemble_pack(&conn, &fused, 8, None, false, PER_CALL_TOKEN_CAP);
    let inj: Vec<&String> = injected.iter().map(|e| &e.canonical_id).collect();

    assert!(
        !inj.contains(&&structural),
        "un codebase_fact ACTIVE NUNCA debe entrar al pack conversacional (es estructural; va por el codegraph MCP)"
    );
    assert!(
        inj.contains(&&conversational),
        "control: un Fact conversacional ACTIVE sí se inyecta (el filtro es por kind, no global)"
    );
    assert!(
        discarded
            .iter()
            .any(|d| d.canonical_id == structural && d.reason.contains("codebase_fact")),
        "el descarte del codebase_fact debe atribuirse explícitamente a su exclusión por kind"
    );
}

// Governance invariants of the recall pipeline, unit-tested WITHOUT Qdrant/E5
// (Ola 3 D2): rejected/deprecated/secret/cross-project NEVER reach the pack;
// active in-project AND global-scope items DO. Protects Ola 0 + Ola 1a in CI.
#[test]
fn assemble_pack_enforces_governance_invariants() {
    use crate::memory::model::MemoryItem;
    use crate::memory::sqlite_store::{apply_schema, insert_item};
    use crate::memory::{MemoryType, Sensitivity, Source};

    let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
    apply_schema(&conn).expect("schema");

    let mk = |status: Status, scope: Scope, sens: Sensitivity, project: Option<&str>, sm: &str| {
        let mut it = MemoryItem::new(MemoryType::Fact, scope, Source::ToolObserved, status);
        it.summary = Some(sm.to_string());
        it.sensitivity = sens;
        it.project_id = project.map(str::to_string);
        it.token_estimate = 20;
        insert_item(&conn, &it).expect("insert");
        it.id
    };

    let ok = mk(
        Status::Active,
        Scope::Project,
        Sensitivity::Internal,
        Some("ultron"),
        "ok item",
    );
    let rejected = mk(
        Status::Rejected,
        Scope::Project,
        Sensitivity::Internal,
        Some("ultron"),
        "rejected",
    );
    let deprecated = mk(
        Status::Deprecated,
        Scope::Project,
        Sensitivity::Internal,
        Some("ultron"),
        "deprecated",
    );
    let secret = mk(
        Status::Active,
        Scope::Project,
        Sensitivity::Secret,
        Some("ultron"),
        "secret key",
    );
    let cross = mk(
        Status::Active,
        Scope::Project,
        Sensitivity::Internal,
        Some("otro"),
        "cross proj",
    );
    let global = mk(
        Status::Active,
        Scope::Global,
        Sensitivity::Internal,
        None,
        "global pref",
    );
    let vault = {
        let mut it = MemoryItem::new(
            MemoryType::Fact,
            Scope::Global,
            Source::ImportedVault,
            Status::Active,
        );
        it.summary = Some("vault bulk note".into());
        it.token_estimate = 20;
        insert_item(&conn, &it).expect("insert");
        it.id
    };

    let ids = [
        &ok,
        &rejected,
        &deprecated,
        &secret,
        &cross,
        &global,
        &vault,
    ];
    let fused: Vec<FusedHit> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| FusedHit {
            canonical_id: (*id).clone(),
            rrf_score: 1.0 - i as f32 * 0.01,
            dense_rank: Some(i),
            sparse_rank: None,
            dense_score: Some(0.5),
        })
        .collect();

    let (injected, discarded, _t) =
        assemble_pack(&conn, &fused, 8, Some("ultron"), false, PER_CALL_TOKEN_CAP);
    let inj: Vec<&String> = injected.iter().map(|e| &e.canonical_id).collect();

    assert!(inj.contains(&&ok), "active in-project item must inject");
    assert!(
        inj.contains(&&global),
        "global-scope item must inject under project filter"
    );
    assert!(!inj.contains(&&rejected), "rejected must NOT inject");
    assert!(!inj.contains(&&deprecated), "deprecated must NOT inject");
    assert!(
        !inj.contains(&&secret),
        "secret must NOT inject (audit top-risk #2)"
    );
    assert!(!inj.contains(&&cross), "cross-project must NOT inject");
    assert!(
        !inj.contains(&&vault),
        "vault must be off-by-default under project filter (Ola 1b)"
    );
    assert!(
        discarded
            .iter()
            .any(|d| d.canonical_id == secret && d.reason.contains("secret")),
        "secret exclusion must be traced in discarded"
    );
}

// CROSS-PROJECT gate (whole-brain recall): under a project filter (`ultron`),
//   - cross_project=false  -> a scope=project item from `otro` is EXCLUDED.
//   - cross_project=true   -> that same item is INCLUDED (project filter
//     relaxed) BUT a Secret item from `otro` is STILL excluded (security is
//     NOT relaxed). Unit-tested without Qdrant/E5 — guards the invariant that
//     cross-project relaxes ONLY the project filter.
#[test]
fn assemble_pack_cross_project_relaxes_only_project_filter() {
    use crate::memory::model::MemoryItem;
    use crate::memory::sqlite_store::{apply_schema, insert_item};
    use crate::memory::{MemoryType, Sensitivity, Source};

    let conn = rusqlite::Connection::open_in_memory().expect("in-memory");
    apply_schema(&conn).expect("schema");

    let mk = |scope: Scope, sens: Sensitivity, project: Option<&str>, sm: &str| {
        let mut it = MemoryItem::new(
            MemoryType::Fact,
            scope,
            Source::ToolObserved,
            Status::Active,
        );
        it.summary = Some(sm.to_string());
        it.sensitivity = sens;
        it.project_id = project.map(str::to_string);
        it.token_estimate = 20;
        insert_item(&conn, &it).expect("insert");
        it.id
    };

    let in_project = mk(
        Scope::Project,
        Sensitivity::Internal,
        Some("ultron"),
        "ultron item",
    );
    let other_project = mk(
        Scope::Project,
        Sensitivity::Internal,
        Some("otro"),
        "bank item",
    );
    let other_secret = mk(
        Scope::Project,
        Sensitivity::Secret,
        Some("otro"),
        "bank api key",
    );
    let global = mk(Scope::Global, Sensitivity::Internal, None, "global pref");

    let ids = [&in_project, &other_project, &other_secret, &global];
    let fused: Vec<FusedHit> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| FusedHit {
            canonical_id: (*id).clone(),
            rrf_score: 1.0 - i as f32 * 0.01,
            dense_rank: Some(i),
            sparse_rank: None,
            dense_score: Some(0.5),
        })
        .collect();

    // cross_project = FALSE: other-project item is filtered out.
    let (inj_off, _d, _t) =
        assemble_pack(&conn, &fused, 8, Some("ultron"), false, PER_CALL_TOKEN_CAP);
    let off: Vec<&String> = inj_off.iter().map(|e| &e.canonical_id).collect();
    assert!(
        off.contains(&&in_project),
        "in-project item must inject (cross=off)"
    );
    assert!(
        off.contains(&&global),
        "global item must inject (cross=off)"
    );
    assert!(
        !off.contains(&&other_project),
        "other-project item must NOT inject when cross=off"
    );

    // cross_project = TRUE: other-project item is admitted; Secret stays out.
    let (inj_on, disc_on, _t) =
        assemble_pack(&conn, &fused, 8, Some("ultron"), true, PER_CALL_TOKEN_CAP);
    let on: Vec<&String> = inj_on.iter().map(|e| &e.canonical_id).collect();
    assert!(
        on.contains(&&in_project),
        "in-project item must still inject (cross=on)"
    );
    assert!(
        on.contains(&&global),
        "global item must still inject (cross=on)"
    );
    assert!(
        on.contains(&&other_project),
        "other-project item MUST inject when cross=on (project filter relaxed)"
    );
    assert!(
        !on.contains(&&other_secret),
        "Secret from another project must NEVER inject — cross relaxes project, not security"
    );
    assert!(
        disc_on
            .iter()
            .any(|d| d.canonical_id == other_secret && d.reason.contains("secret")),
        "cross-project Secret exclusion must be traced in discarded"
    );
}
