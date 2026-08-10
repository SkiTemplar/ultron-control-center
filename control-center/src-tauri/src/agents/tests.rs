use super::*;

#[test]
fn parses_frontmatter_returns_description_and_model() {
    let md = "---\n\
              name: foo\n\
              description: A test agent for the suite\n\
              model: claude-sonnet-5\n\
              tools: Read, Glob, Grep\n\
              ---\n\
              \n\
              body text\n";
    let (desc, model, tools) = parse_frontmatter(md);
    assert_eq!(desc.as_deref(), Some("A test agent for the suite"));
    assert_eq!(model.as_deref(), Some("claude-sonnet-5"));
    assert_eq!(
        tools,
        vec!["Read".to_string(), "Glob".to_string(), "Grep".to_string()]
    );
}

#[test]
fn parses_frontmatter_returns_none_without_marker() {
    // No leading `---` ⇒ everything None / empty.
    let md = "name: foo\ndescription: nope\n";
    let (desc, model, tools) = parse_frontmatter(md);
    assert!(desc.is_none());
    assert!(model.is_none());
    assert!(tools.is_empty());
}

#[test]
fn list_agents_inner_returns_ok_regardless_of_dir_state() {
    // dirs::home_dir() on Windows resolves via the Win32 known-folder
    // API and ignores USERPROFILE/HOME env overrides, so we can't
    // synthesise a "missing dir" state cleanly. Instead we exercise
    // the public contract: list_agents_inner returns Ok(_) on a real
    // or missing dir — it must never error just because
    // ~/.claude/agents is absent. When the dir is missing, the inner
    // returns Ok(vec![]); when present (dev box), it returns
    // Ok(<entries>). Both shapes satisfy the contract.
    let result = list_agents_inner();
    assert!(
        result.is_ok(),
        "list_agents_inner must return Ok regardless of dir state, got {:?}",
        result.err()
    );
}

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
