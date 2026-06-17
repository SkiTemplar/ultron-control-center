// kanban/tests.rs — unit tests for kanban module.

use std::sync::atomic::Ordering;

use super::board_io::delete_column_in_memory;
use super::board_io::{
    apply_move, infer_and_migrate_roles, is_done_column, normalize_card_orders, relink_orphan_cards,
};
use super::types_model::{kanban_lock, Card, Column, ColumnRole, KanbanBoard, SCHEMA_VERSION};

// card-test-fixtures-rust-infra: the fixture must deserialise into the real
// KanbanBoard type, so it stays honest if the schema changes.
#[test]
fn fixture_kanban_test_deserialises_into_board() {
    let raw = crate::test_support::load_fixture("kanban", "kanban-test.json");
    let board: KanbanBoard =
        serde_json::from_str(&raw).expect("kanban-test.json must parse into KanbanBoard");
    assert_eq!(board.columns.len(), 2, "fixture has 2 columns");
    assert_eq!(board.cards.len(), 5, "fixture has 5 cards");
    assert_eq!(
        board
            .cards
            .iter()
            .filter(|c| c.column_id == "col-done")
            .count(),
        2,
        "2 cards in the Done column"
    );
    assert!(
        board
            .cards
            .iter()
            .any(|c| c.tags.contains(&"rust".to_string())),
        "card-2 carries tags"
    );
}

// regression (project card showed "-- pending"): a card written by an
// external capture script with a *numeric* epoch-millis timestamp must not
// break the whole board parse. Before the tolerant deserializer this errored
// ("invalid type: integer, expected a string"), `kanban_load` returned Err,
// and `refreshStats` swallowed it -- leaving the card's pending counter "--".
#[test]
fn load_tolerates_numeric_card_timestamps() {
    let json = r#"{
        "project_id": "t",
        "columns": [{ "id": "c1", "name": "Backlog" }],
        "cards": [{
            "id": "k1",
            "column_id": "c1",
            "title": "x",
            "created_at": 1780611795150,
            "updated_at": 1780611795150
        }]
    }"#;
    let board: KanbanBoard = serde_json::from_str(json)
        .expect("a numeric card timestamp must not break the board parse");
    assert_eq!(board.cards.len(), 1);
    assert_eq!(board.cards[0].created_at, "epoch:1780611795");
    assert_eq!(board.cards[0].updated_at, "epoch:1780611795");
}

#[test]
fn kanban_lock_same_static() {
    let a = kanban_lock() as *const std::sync::Mutex<()>;
    let b = kanban_lock() as *const std::sync::Mutex<()>;
    assert_eq!(a, b);
}

#[test]
fn kanban_lock_sequential_under_contention() {
    use std::sync::{Arc, Barrier};
    use std::thread;
    let barrier = Arc::new(Barrier::new(2));
    let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let b2 = Arc::clone(&barrier);
    let c2 = Arc::clone(&counter);
    let h = thread::spawn(move || {
        b2.wait();
        let _g = kanban_lock().lock().unwrap();
        let v = c2.load(Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(5));
        c2.store(v + 1, Ordering::SeqCst);
    });
    barrier.wait();
    {
        let _g = kanban_lock().lock().unwrap();
        let v = counter.load(Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(5));
        counter.store(v + 1, Ordering::SeqCst);
    }
    h.join().unwrap();
    assert_eq!(counter.load(Ordering::SeqCst), 2);
}

// -----------------------------------------------------------------------
// v2.14 -- ColumnRole inference tests
// -----------------------------------------------------------------------

/// Helper: build a minimal board with given column names, all roles Other.
fn board_with_columns(names: &[&str]) -> KanbanBoard {
    KanbanBoard {
        project_id: "test".into(),
        columns: names
            .iter()
            .enumerate()
            .map(|(i, name)| Column {
                id: format!("col-{i}"),
                name: (*name).to_string(),
                order: i as i32,
                role: ColumnRole::Other,
            })
            .collect(),
        cards: vec![],
        default_agent: None,
        default_prompt_template: None,
        schema_version: SCHEMA_VERSION,
    }
}

#[test]
fn role_inference_in_progress_maps_to_doing() {
    assert_eq!(
        ColumnRole::infer_from_name("In Progress"),
        Some(ColumnRole::Doing)
    );
}

#[test]
fn role_inference_investigar_maps_to_todo() {
    assert_eq!(
        ColumnRole::infer_from_name("Investigar"),
        Some(ColumnRole::Todo)
    );
}

#[test]
fn role_inference_done_maps_to_done() {
    assert_eq!(ColumnRole::infer_from_name("Done"), Some(ColumnRole::Done));
}

#[test]
fn role_inference_blocked_maps_to_blocked() {
    assert_eq!(
        ColumnRole::infer_from_name("Blocked"),
        Some(ColumnRole::Blocked)
    );
}

#[test]
fn role_inference_backlog_maps_to_todo() {
    assert_eq!(
        ColumnRole::infer_from_name("Backlog"),
        Some(ColumnRole::Todo)
    );
}

#[test]
fn role_inference_unknown_column_returns_none() {
    assert_eq!(ColumnRole::infer_from_name("Sprint 42"), None);
}

/// Migration must assign correct roles from name heuristics and return true.
#[test]
fn migrate_roles_infers_all_defaults() {
    let mut board =
        board_with_columns(&["Backlog", "In Progress", "Investigar", "Blocked", "Done"]);
    let changed = infer_and_migrate_roles(&mut board);
    assert!(changed, "should report that roles were updated");

    let role = |name: &str| {
        board
            .columns
            .iter()
            .find(|c| c.name == name)
            .unwrap()
            .role
            .clone()
    };
    assert_eq!(role("Backlog"), ColumnRole::Todo);
    assert_eq!(role("In Progress"), ColumnRole::Doing);
    assert_eq!(role("Investigar"), ColumnRole::Todo);
    assert_eq!(role("Blocked"), ColumnRole::Blocked);
    assert_eq!(role("Done"), ColumnRole::Done);
}

/// Second call to migrate_roles must not change anything (idempotent).
#[test]
fn migrate_roles_is_idempotent() {
    let mut board = board_with_columns(&["Backlog", "Done"]);
    infer_and_migrate_roles(&mut board);
    // Snapshot roles after first pass.
    let snapshot: Vec<ColumnRole> = board.columns.iter().map(|c| c.role.clone()).collect();
    // Second pass must report no changes.
    let changed = infer_and_migrate_roles(&mut board);
    assert!(!changed, "second migration must be a no-op");
    let after: Vec<ColumnRole> = board.columns.iter().map(|c| c.role.clone()).collect();
    assert_eq!(snapshot, after);
}

/// A board loaded from JSON without the `role` field must deserialise to Other.
#[test]
fn column_without_role_field_deserialises_to_other() {
    let json = r#"{
        "project_id": "p",
        "columns": [{"id": "c1", "name": "Done", "order": 0}],
        "cards": [],
        "schema_version": 1
    }"#;
    let board: KanbanBoard = serde_json::from_str(json).unwrap();
    assert_eq!(board.columns[0].role, ColumnRole::Other);
}

// -----------------------------------------------------------------------
// Order robustness
// -----------------------------------------------------------------------

/// Build a Card with the given column/order; other fields are filler.
fn card(id: &str, column_id: &str, order: i32, created_at: &str) -> Card {
    Card {
        id: id.into(),
        column_id: column_id.into(),
        title: id.to_uppercase(),
        description: String::new(),
        agent: None,
        prompt_template: None,
        cwd: None,
        tags: vec![],
        order,
        created_at: created_at.into(),
        updated_at: created_at.into(),
        runs: vec![],
    }
}

/// Regression: a single negative order used to reject the *entire* board.
#[test]
fn negative_card_orders_deserialise_without_error() {
    let json = r#"{
        "project_id": "p",
        "columns": [{"id": "c1", "name": "Backlog", "order": 0}],
        "cards": [
            {"id":"a","column_id":"c1","title":"A","order":-2,"created_at":"epoch:1","updated_at":"epoch:1"},
            {"id":"b","column_id":"c1","title":"B","order":-1,"created_at":"epoch:2","updated_at":"epoch:2"}
        ],
        "schema_version": 1
    }"#;
    let board: KanbanBoard = serde_json::from_str(json).expect("negatives must parse");
    assert_eq!(board.cards.len(), 2);
}

#[test]
fn normalize_compacts_negative_and_duplicate_orders() {
    let mut board = KanbanBoard {
        project_id: "p".into(),
        columns: vec![Column {
            id: "c1".into(),
            name: "Backlog".into(),
            order: 0,
            role: ColumnRole::Todo,
        }],
        // a:-3, then b and c both 0 (duplicate) -- disambiguated by created_at.
        cards: vec![
            card("a", "c1", -3, "epoch:1"),
            card("b", "c1", 0, "epoch:2"),
            card("c", "c1", 0, "epoch:3"),
        ],
        default_agent: None,
        default_prompt_template: None,
        schema_version: SCHEMA_VERSION,
    };
    assert!(normalize_card_orders(&mut board));
    let by = |id: &str| board.cards.iter().find(|c| c.id == id).unwrap().order;
    assert_eq!(
        (by("a"), by("b"), by("c")),
        (0, 1, 2),
        "gap-free, order preserved"
    );
    assert!(!normalize_card_orders(&mut board), "must be idempotent");
}

#[test]
fn relink_orphan_card_by_column_name() {
    let mut board = KanbanBoard {
        project_id: "p".into(),
        columns: vec![Column {
            id: "col-done".into(),
            name: "Done".into(),
            order: 0,
            role: ColumnRole::Done,
        }],
        // column_id is the column NAME, not its id -- the orphan bug.
        cards: vec![card("a", "Done", 0, "epoch:1")],
        default_agent: None,
        default_prompt_template: None,
        schema_version: SCHEMA_VERSION,
    };
    assert!(relink_orphan_cards(&mut board));
    assert_eq!(board.cards[0].column_id, "col-done");
    assert!(!relink_orphan_cards(&mut board), "must be idempotent");
}

#[test]
fn apply_move_recompacts_destination_and_source() {
    let mut board = KanbanBoard {
        project_id: "p".into(),
        columns: vec![
            Column {
                id: "c1".into(),
                name: "A".into(),
                order: 0,
                role: ColumnRole::Other,
            },
            Column {
                id: "c2".into(),
                name: "B".into(),
                order: 1,
                role: ColumnRole::Other,
            },
        ],
        cards: vec![
            card("x", "c1", 0, "epoch:1"),
            card("y", "c1", 1, "epoch:2"),
            card("z", "c1", 2, "epoch:3"),
        ],
        default_agent: None,
        default_prompt_template: None,
        schema_version: SCHEMA_VERSION,
    };
    // Move z to the top of column c2.
    apply_move(&mut board, "z", "c2", 0).unwrap();
    let get = |id: &str| board.cards.iter().find(|c| c.id == id).unwrap();
    assert_eq!((get("z").column_id.as_str(), get("z").order), ("c2", 0));
    // Source column re-compacted to 0,1 with no gap left by z.
    assert_eq!((get("x").order, get("y").order), (0, 1));
}

#[test]
fn apply_move_within_column_dedups_orders() {
    let mut board = KanbanBoard {
        project_id: "p".into(),
        columns: vec![Column {
            id: "c1".into(),
            name: "A".into(),
            order: 0,
            role: ColumnRole::Other,
        }],
        cards: vec![
            card("x", "c1", 0, "epoch:1"),
            card("y", "c1", 1, "epoch:2"),
            card("z", "c1", 2, "epoch:3"),
        ],
        default_agent: None,
        default_prompt_template: None,
        schema_version: SCHEMA_VERSION,
    };
    // Move z to index 0 within the same column -> z,x,y with unique 0,1,2.
    apply_move(&mut board, "z", "c1", 0).unwrap();
    let get = |id: &str| board.cards.iter().find(|c| c.id == id).unwrap().order;
    assert_eq!((get("z"), get("x"), get("y")), (0, 1, 2));
    let mut all: Vec<i32> = board.cards.iter().map(|c| c.order).collect();
    all.sort();
    assert_eq!(all, vec![0, 1, 2], "no duplicate orders after move");
}

/// `is_done_column` must use role when set, not name.
#[test]
fn is_done_column_uses_role_when_set() {
    let col_by_role = Column {
        id: "c1".into(),
        name: "Finished work".into(), // name does NOT contain "done"/"complete"
        order: 0,
        role: ColumnRole::Done,
    };
    assert!(is_done_column(&col_by_role), "role=Done must be detected");

    let col_not_done = Column {
        id: "c2".into(),
        name: "Done".into(), // name contains "done" but role overrides
        order: 1,
        role: ColumnRole::Todo, // explicit non-Done role
    };
    assert!(
        !is_done_column(&col_not_done),
        "role=Todo must NOT be detected as done"
    );
}

/// `is_done_column` falls back to name matching when role is Other.
#[test]
fn is_done_column_falls_back_to_name_when_other() {
    let col = Column {
        id: "c1".into(),
        name: "Done".into(),
        order: 0,
        role: ColumnRole::Other,
    };
    assert!(is_done_column(&col), "name fallback must detect 'Done'");
}

// -----------------------------------------------------------------------
// v2.14 -- delete_column tests (in-memory, no filesystem)
// -----------------------------------------------------------------------

fn make_card(id: &str, column_id: &str) -> Card {
    Card {
        id: id.to_string(),
        column_id: column_id.to_string(),
        title: id.to_string(),
        description: String::new(),
        agent: None,
        prompt_template: None,
        cwd: None,
        tags: vec![],
        order: 0,
        created_at: "epoch:0".into(),
        updated_at: "epoch:0".into(),
        runs: vec![],
    }
}

/// Deleting a column that has cards without a reassign target must return Err.
#[test]
fn delete_column_with_cards_and_no_reassign_returns_err() {
    let col_a = Column {
        id: "col-a".into(),
        name: "Active".into(),
        order: 0,
        role: ColumnRole::Doing,
    };
    let col_b = Column {
        id: "col-b".into(),
        name: "Done".into(),
        order: 1,
        role: ColumnRole::Done,
    };
    let mut board = KanbanBoard {
        project_id: "proj".into(),
        columns: vec![col_a, col_b],
        cards: vec![make_card("card-1", "col-a"), make_card("card-2", "col-a")],
        default_agent: None,
        default_prompt_template: None,
        schema_version: SCHEMA_VERSION,
    };

    let err = delete_column_in_memory(&mut board, "col-a", None).unwrap_err();
    assert!(
        err.contains("2 card(s)"),
        "error must mention card count, got: {err}"
    );
    // Cards must NOT have been removed.
    assert_eq!(board.cards.len(), 2, "no cards must be lost");
}

/// Deleting a column with reassign moves all cards to the target.
#[test]
fn delete_column_with_reassign_moves_cards_and_removes_column() {
    let col_a = Column {
        id: "col-a".into(),
        name: "Active".into(),
        order: 0,
        role: ColumnRole::Doing,
    };
    let col_b = Column {
        id: "col-b".into(),
        name: "Done".into(),
        order: 1,
        role: ColumnRole::Done,
    };
    let mut board = KanbanBoard {
        project_id: "proj".into(),
        columns: vec![col_a, col_b],
        cards: vec![make_card("card-1", "col-a"), make_card("card-2", "col-a")],
        default_agent: None,
        default_prompt_template: None,
        schema_version: SCHEMA_VERSION,
    };

    delete_column_in_memory(&mut board, "col-a", Some("col-b")).unwrap();

    assert_eq!(board.columns.len(), 1, "col-a must be removed");
    assert_eq!(board.columns[0].id, "col-b");
    assert_eq!(board.cards.len(), 2, "no cards must be lost");
    assert!(
        board.cards.iter().all(|c| c.column_id == "col-b"),
        "all cards must be reassigned to col-b"
    );
}
