// Control Center 2.6 — Tauri command wrappers for the local Knowledge Graph
// (`crate::kg`). See module-level doc in `src-tauri/src/kg.rs`.

use crate::kg::{
    add_observations_inner, create_entities_inner, create_relations_inner, delete_entity_inner,
    delete_relation_inner, read_graph_inner, search_nodes_inner, KgEntity, KgGraph, KgRelation,
};

#[tauri::command]
pub fn kg_read_graph() -> Result<KgGraph, String> {
    read_graph_inner()
}

#[tauri::command]
pub fn kg_create_entities(entities: Vec<KgEntity>) -> Result<KgGraph, String> {
    create_entities_inner(entities)
}

#[tauri::command]
pub fn kg_delete_entity(name: String) -> Result<KgGraph, String> {
    delete_entity_inner(name)
}

#[tauri::command]
pub fn kg_add_observations(name: String, observations: Vec<String>) -> Result<KgGraph, String> {
    add_observations_inner(name, observations)
}

#[tauri::command]
pub fn kg_create_relations(relations: Vec<KgRelation>) -> Result<KgGraph, String> {
    create_relations_inner(relations)
}

#[tauri::command]
pub fn kg_delete_relation(
    from: String,
    to: String,
    relation_type: String,
) -> Result<KgGraph, String> {
    delete_relation_inner(from, to, relation_type)
}

#[tauri::command]
pub fn kg_search_nodes(query: String) -> Result<KgGraph, String> {
    search_nodes_inner(query)
}
