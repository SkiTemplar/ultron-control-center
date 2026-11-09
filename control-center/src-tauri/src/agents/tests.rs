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

const AGENT_MD: &str =
    "---\nname: foo-agent\ndescription: Agente de prueba\nmodel: claude-sonnet-5-5\nmaxTurns: 60\n---\ncuerpo\n";

fn agent_with(model_line: &str, turns_line: &str) -> String {
    format!("---\nname: foo-agent\ndescription: Agente de prueba\n{model_line}{turns_line}---\ncuerpo\n")
}

#[test]
fn enable_rejects_models_outside_the_5_5_family() {
    for model in [
        "claude-sonnet-5",
        "claude-opus-5",
        "claude-haiku-4-5",
        "claude-sonnet-4-6",
        "haiku",
        "inherit",
    ] {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        let md = agent_with(&format!("model: {model}\n"), "maxTurns: 60\n");
        fs::write(root.join("foo-agent.md.disabled"), &md).unwrap();
        let err = agent_toggle_in(root, "foo-agent".to_string(), true).expect_err(model);
        assert!(err.contains("familia 5.5"), "{model}: {err}");
        assert!(
            root.join("foo-agent.md.disabled").is_file(),
            "{model}: debe seguir desactivado"
        );
        assert!(!root.join("foo-agent.md").exists());
    }
}

#[test]
fn enable_rejects_missing_model_or_max_turns() {
    let cases = [
        (agent_with("", "maxTurns: 60\n"), "model"),
        (agent_with("model: claude-opus-5-5\n", ""), "maxTurns"),
        (
            agent_with("model: claude-opus-5-5\n", "maxTurns: 0\n"),
            "maxTurns",
        ),
        (
            agent_with("model: claude-opus-5-5\n", "maxTurns: muchos\n"),
            "maxTurns",
        ),
    ];
    for (md, expected) in cases {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        fs::write(root.join("foo-agent.md.disabled"), &md).unwrap();
        let err = agent_toggle_in(root, "foo-agent".to_string(), true).expect_err(expected);
        assert!(err.contains(expected), "{expected}: {err}");
        assert!(root.join("foo-agent.md.disabled").is_file());
    }
}

#[test]
fn enable_accepts_every_5_5_model_with_max_turns() {
    for model in [
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "\"claude-opus-5-5[1m]\"",
    ] {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        fs::write(
            root.join("foo-agent.md.disabled"),
            agent_with(&format!("model: {model}\n"), "maxTurns: 120\n"),
        )
        .unwrap();
        let on = agent_toggle_in(root, "foo-agent".to_string(), true).expect(model);
        assert!(on.enabled, "{model}");
    }
}

#[test]
fn update_of_active_agent_rejects_a_forbidden_model_and_keeps_the_file() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().join("agents");
    let backups = tmp.path().join("backups");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("foo-agent.md"), AGENT_MD).unwrap();
    let bad = agent_with("model: claude-sonnet-5\n", "maxTurns: 60\n");
    let err = update_agent_md_in(&dir, &backups, "foo-agent".to_string(), bad)
        .expect_err("modelo prohibido");
    assert!(err.contains("familia 5.5"), "{err}");
    assert_eq!(
        fs::read_to_string(dir.join("foo-agent.md")).unwrap(),
        AGENT_MD
    );
    assert!(!backups.exists(), "sin copia si no se escribe");
    let good = agent_with("model: claude-haiku-5-5\n", "maxTurns: 60\n");
    update_agent_md_in(&dir, &backups, "foo-agent".to_string(), good)
        .expect("modelo de la familia");
}

#[test]
fn agent_stem_strips_both_suffixes() {
    assert_eq!(agent_stem(Path::new("foo.md")), Some(("foo", true)));
    assert_eq!(
        agent_stem(Path::new("foo.md.disabled")),
        Some(("foo", false))
    );
    assert_eq!(
        agent_stem(Path::new("MyAgent.MD.Disabled")),
        Some(("MyAgent", false))
    );
    assert_eq!(agent_stem(Path::new("foo.txt")), None);
}

#[test]
fn disabled_agent_lists_without_md_in_name() {
    // H13: `file_stem("foo-agent.md.disabled")` daba `foo-agent.md`.
    let tmp = tempfile::tempdir().expect("tempdir");
    fs::write(tmp.path().join("foo-agent.md.disabled"), AGENT_MD).unwrap();
    let list = collect_agents_from(tmp.path(), AgentOrigin::Global, false);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "foo-agent");
    assert!(!list[0].enabled);
}

#[test]
fn disable_then_reenable_roundtrip_with_listed_name() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    fs::write(root.join("foo-agent.md"), AGENT_MD).unwrap();

    let off = agent_toggle_in(root, "foo-agent".to_string(), false).expect("disable");
    assert!(!off.enabled);
    assert_eq!(off.name, "foo-agent");
    assert!(root.join("foo-agent.md.disabled").is_file());
    assert!(!root.join("foo-agent.md").exists());

    // El nombre que ve la pestaña es el que se manda de vuelta al reactivar.
    let listed = collect_agents_from(root, AgentOrigin::Global, false);
    let on = agent_toggle_in(root, listed[0].name.clone(), true).expect("re-enable");
    assert!(on.enabled);
    assert!(root.join("foo-agent.md").is_file());
    assert!(!root.join("foo-agent.md.disabled").exists());
}

#[test]
fn toggle_with_md_suffixed_name_is_rejected() {
    // Caso negativo: el nombre antiguo (`foo-agent.md`) no debe encontrar nada
    // ni crear `foo-agent.md.md`.
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    fs::write(root.join("foo-agent.md.disabled"), AGENT_MD).unwrap();
    assert!(agent_toggle_in(root, "foo-agent.md".to_string(), true).is_err());
    assert!(root.join("foo-agent.md.disabled").is_file());
    assert!(!root.join("foo-agent.md.md").exists());
}

#[test]
fn update_edits_disabled_agent_in_place() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().join("agents");
    let backups = tmp.path().join("backups");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("foo-agent.md.disabled"), AGENT_MD).unwrap();

    let res = update_agent_md_in(&dir, &backups, "foo-agent".to_string(), "nuevo".to_string())
        .expect("update disabled");
    assert!(res.path.ends_with("foo-agent.md.disabled"));
    assert_eq!(
        fs::read_to_string(dir.join("foo-agent.md.disabled")).unwrap(),
        "nuevo"
    );
    // No se reactiva al editar.
    assert!(!dir.join("foo-agent.md").exists());
    let backup = res.backup_path.expect("backup");
    assert_eq!(fs::read_to_string(backup).unwrap(), AGENT_MD);
}

#[test]
fn update_missing_agent_fails() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let err = update_agent_md_in(
        tmp.path(),
        &tmp.path().join("b"),
        "nope".to_string(),
        "x".to_string(),
    );
    assert!(err.is_err());
    assert!(!tmp.path().join("b").exists());
}
