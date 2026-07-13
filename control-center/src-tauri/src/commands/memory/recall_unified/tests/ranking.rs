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

use crate::commands::memory::recall_unified::engine::ambient_rank_factor;
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
