// tests/ranking.rs — down-rank de items AMBIENTE (project_id=NULL) bajo filtro
// de proyecto.
//
// Fallo detectado 2026-07-13 (sesión Tortunabo): 3567/~4400 items del corpus
// tienen project_id=NULL (legado anterior al estampado de --project en la
// captura). La regla AMBIENTE (1.0, pack.rs) los hace visibles en TODOS los
// proyectos; sin contrapeso de ranking, memorias específicas de otro proyecto
// mal etiquetadas (p.ej. terreno procedural) llenan el pack de una sesión de
// Tortunabo. El down-rank NO los filtra (la regla ambiente sigue en pie): solo
// los hunde por debajo de las memorias del proyecto activo cuando compiten.

use crate::commands::memory::recall_unified::engine::{
    ambient_rank_factor, is_orphan_project_item,
};
use crate::memory::Scope;

const PENALTY: f32 = 0.5;

#[test]
fn ambient_null_project_item_is_penalized_under_project_filter() {
    let f = ambient_rank_factor(Some("tortunabo"), false, None, Scope::Project, PENALTY);
    assert_eq!(
        f, PENALTY,
        "item NULL bajo filtro de proyecto debe penalizarse"
    );
}

#[test]
fn global_scope_item_keeps_full_weight() {
    // Global es deliberadamente universal (preferencias del usuario, feedback):
    // nunca se penaliza, aunque su project_id sea NULL.
    let f = ambient_rank_factor(Some("tortunabo"), false, None, Scope::Global, PENALTY);
    assert_eq!(f, 1.0, "scope Global no se penaliza");
}

#[test]
fn same_project_item_keeps_full_weight() {
    let f = ambient_rank_factor(
        Some("tortunabo"),
        false,
        Some("tortunabo"),
        Scope::Project,
        PENALTY,
    );
    assert_eq!(f, 1.0, "item del proyecto activo no se penaliza");
}

#[test]
fn no_project_context_keeps_full_weight() {
    // Recall sin proyecto (recall_hybrid / project-less): el corpus NULL es la
    // fuente primaria; penalizarlo ahí silenciaría la memoria entera.
    let f = ambient_rank_factor(None, false, None, Scope::Project, PENALTY);
    assert_eq!(f, 1.0, "sin contexto de proyecto no hay penalización");
}

#[test]
fn cross_project_mode_disables_the_penalty() {
    // cross_project = el usuario pidió explícitamente el cerebro entero; el
    // ranking vuelve al comportamiento clásico (solo relevancia + calidad).
    let f = ambient_rank_factor(Some("tortunabo"), true, None, Scope::Project, PENALTY);
    assert_eq!(f, 1.0, "cross_project desactiva la penalización");
}

// ---------------------------------------------------------------------------
// (2026-08-11) Exclusión de huérfanos scope=Project sin project_id — decidido
// por el usuario, activada tras backfill-projects --apply. A diferencia del
// down-rank ambiente (arriba), esto los saca del pack bajo filtro de proyecto.
// ---------------------------------------------------------------------------

#[test]
fn orphan_project_item_is_excluded_under_project_filter() {
    assert!(
        is_orphan_project_item(Some("ultron"), false, None, Scope::Project),
        "scope=Project sin project_id bajo filtro de proyecto se excluye"
    );
}

#[test]
fn orphan_exclusion_does_not_apply_cross_project() {
    // Caso negativo: el cerebro entero pedido explícitamente los sigue viendo.
    assert!(!is_orphan_project_item(
        Some("ultron"),
        true,
        None,
        Scope::Project
    ));
}

#[test]
fn orphan_exclusion_does_not_apply_to_session_ambient() {
    // Caso negativo: el ambiente Session/Agent con NULL mantiene SOLO el
    // down-rank del 07-13 — no se excluye.
    assert!(!is_orphan_project_item(
        Some("ultron"),
        false,
        None,
        Scope::Session
    ));
}

#[test]
fn orphan_exclusion_requires_a_project_filter_and_spares_attributed_items() {
    // Casos negativos: sin filtro de proyecto no hay exclusión; un item con
    // proyecto propio (aunque sea otro) tampoco pasa por este gate — su
    // visibilidad la gobierna la regla de proyecto normal del pack.
    assert!(!is_orphan_project_item(None, false, None, Scope::Project));
    assert!(!is_orphan_project_item(
        Some("ultron"),
        false,
        Some("tortunabo"),
        Scope::Project
    ));
}
