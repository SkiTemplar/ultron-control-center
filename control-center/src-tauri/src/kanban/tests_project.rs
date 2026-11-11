// kanban/tests_project.rs — vínculo tarjeta → proyecto registrado (`Card.project`)
// y semántica de tres estados de los campos anulables de `CardPatch`.
// En memoria: no tocan `~/.ultron/cockpit`.

use super::board_io::apply_patch;
use super::types_model::{Card, CardPartial, CardPatch, KanbanBoard};

fn card_json(extra: &str) -> String {
    format!(
        r#"{{"id":"a","column_id":"c1","title":"A","order":0,"created_at":"epoch:1","updated_at":"epoch:1"{extra}}}"#
    )
}

fn parse_card(extra: &str) -> Card {
    serde_json::from_str(&card_json(extra)).expect("la tarjeta deserializa")
}

fn patch(json: &str) -> CardPatch {
    serde_json::from_str(json).expect("el parche deserializa")
}

#[test]
fn project_sobrevive_al_round_trip() {
    let card = parse_card(r#","project":"arcadia""#);
    assert_eq!(card.project.as_deref(), Some("arcadia"));
    let json = serde_json::to_string(&card).unwrap();
    let back: Card = serde_json::from_str(&json).unwrap();
    assert_eq!(back.project.as_deref(), Some("arcadia"));
}

#[test]
fn tarjeta_sin_project_no_escribe_el_campo() {
    let card = parse_card("");
    assert!(card.project.is_none());
    let json = serde_json::to_string(&card).unwrap();
    assert!(
        !json.contains("\"project\""),
        "no debe serializar project: {json}"
    );
}

#[test]
fn tablero_sin_project_sigue_cargando() {
    let json = r#"{
        "project_id": "p",
        "columns": [{"id": "c1", "name": "Backlog", "order": 0, "role": "todo"}],
        "cards": [{"id":"a","column_id":"c1","title":"A","order":0,"created_at":"epoch:1","updated_at":"epoch:1"}]
    }"#;
    let board: KanbanBoard = serde_json::from_str(json).expect("el tablero antiguo carga");
    assert!(board.cards[0].project.is_none());
}

#[test]
fn card_partial_acepta_project_y_lo_omite_por_defecto() {
    let with: CardPartial = serde_json::from_str(r#"{"title":"T","project":"x"}"#).unwrap();
    assert_eq!(with.project.as_deref(), Some("x"));
    let without: CardPartial = serde_json::from_str(r#"{"title":"T"}"#).unwrap();
    assert!(without.project.is_none());
}

#[test]
fn patch_fija_el_project() {
    let mut card = parse_card("");
    apply_patch(&mut card, patch(r#"{"project":"arcadia"}"#));
    assert_eq!(card.project.as_deref(), Some("arcadia"));
}

#[test]
fn patch_con_null_quita_el_project() {
    let mut card = parse_card(r#","project":"arcadia""#);
    apply_patch(&mut card, patch(r#"{"project":null}"#));
    assert!(card.project.is_none());
}

#[test]
fn patch_sin_project_no_lo_toca() {
    let mut card = parse_card(r#","project":"arcadia""#);
    apply_patch(&mut card, patch(r#"{"title":"Nuevo"}"#));
    assert_eq!(card.title, "Nuevo");
    assert_eq!(card.project.as_deref(), Some("arcadia"));
}

/// Caso negativo del arreglo de `de_patch_field`: antes `null` se leía como
/// «ausente» y el editor no podía vaciar el directorio de trabajo.
#[test]
fn patch_con_null_vacia_cwd_y_agente() {
    let mut card = parse_card(r#","cwd":"C:/x","agent":"debugger""#);
    apply_patch(&mut card, patch(r#"{"cwd":null,"agent":null}"#));
    assert!(card.cwd.is_none());
    assert!(card.agent.is_none());
}
