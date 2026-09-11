use super::*;

#[test]
fn validate_slug_rejects_uppercase() {
    assert!(validate_slug("Foo-bar").is_err());
    assert!(validate_slug("FOO").is_err());
}

#[test]
fn validate_slug_rejects_path_chars() {
    assert!(validate_slug("foo/bar").is_err());
    assert!(validate_slug("foo\\bar").is_err());
    assert!(validate_slug("../etc").is_err());
    assert!(validate_slug("foo.bar").is_err());
}

#[test]
fn validate_slug_accepts_valid() {
    assert!(validate_slug("foo").is_ok());
    assert!(validate_slug("foo-bar").is_ok());
    assert!(validate_slug("agent-123").is_ok());
    assert!(validate_slug("a1").is_ok());
}

#[test]
fn bulk_toggle_aggregates_per_item_outcomes() {
    // Non-existent agent slugs → every item hits the error path. Asserts
    // the aggregation shape without mutating the real agents dir.
    let names = vec![
        "zzz-bulk-test-nonexistent-a".to_string(),
        "zzz-bulk-test-nonexistent-b".to_string(),
    ];
    let res = agents_bulk_toggle_inner(names.clone(), true).expect("bulk ok");
    assert_eq!(res.requested, 2);
    assert_eq!(res.outcomes.len(), 2);
    assert_eq!(res.succeeded + res.failed, res.requested);
    assert!(res.outcomes.iter().all(|o| !o.ok && o.error.is_some()));
    assert_eq!(res.outcomes[0].name, names[0]);
}

#[test]
fn bulk_toggle_empty_is_noop() {
    let res = agents_bulk_toggle_inner(vec![], false).expect("bulk ok");
    assert_eq!(res.requested, 0);
    assert_eq!(res.succeeded, 0);
    assert_eq!(res.failed, 0);
    assert!(res.outcomes.is_empty());
}
