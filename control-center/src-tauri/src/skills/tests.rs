// skills/tests.rs — Unit tests for the skills domain.

use super::crud::validate_slug;
use super::hash::{format_ymd_local, sha1_of_file};
use super::origin::skills_bulk_toggle_inner;
use super::types::{RegistryRoot, SkillInfo};

#[test]
fn validate_slug_lower_kebab_only() {
    // Accepted shapes
    assert!(validate_slug("foo").is_ok());
    assert!(validate_slug("foo-bar").is_ok());
    assert!(validate_slug("agent-skills").is_ok());
    assert!(validate_slug("a1").is_ok());

    // Rejected shapes
    assert!(validate_slug("F").is_err(), "single char too short");
    assert!(validate_slug("Foo").is_err(), "uppercase rejected");
    assert!(validate_slug("foo_bar").is_err(), "underscore rejected");
    assert!(validate_slug("foo bar").is_err(), "space rejected");
    assert!(validate_slug("foo/bar").is_err(), "slash rejected");
    // First char must be [a-z0-9] — leading hyphen forbidden
    assert!(validate_slug("-foo").is_err(), "leading hyphen rejected");
}

#[test]
fn sha1_of_file_matches_known_string() {
    // Known: SHA1("abc") = a9993e364706816aba3e25717850c26c9cd0d89d
    let tmp = tempfile::NamedTempFile::new().expect("tempfile");
    std::fs::write(tmp.path(), b"abc").expect("write");
    let hex = sha1_of_file(tmp.path()).expect("sha1 ok");
    assert_eq!(hex, "a9993e364706816aba3e25717850c26c9cd0d89d");
}

#[test]
fn sha1_of_empty_file_matches_known_string() {
    // SHA1("") = da39a3ee5e6b4b0d3255bfef95601890afd80709
    let tmp = tempfile::NamedTempFile::new().expect("tempfile");
    std::fs::write(tmp.path(), b"").expect("write");
    let hex = sha1_of_file(tmp.path()).expect("sha1 ok");
    assert_eq!(hex, "da39a3ee5e6b4b0d3255bfef95601890afd80709");
}

#[test]
fn format_ymd_local_renders_yyyy_mm_dd() {
    // 2026-05-17 00:00:00 UTC = 1778976000 (unix seconds)
    assert_eq!(format_ymd_local(1778976000), "2026-05-17");

    // Epoch
    assert_eq!(format_ymd_local(0), "1970-01-01");

    // 2024-02-29 (leap day) 00:00 UTC = 1709164800
    assert_eq!(format_ymd_local(1709164800), "2024-02-29");
}

// -----------------------------------------------------------------------
// Priority field — KIRKARDO 29
// -----------------------------------------------------------------------

/// Build a minimal registry.json string with the given skills and parse it
/// through `list_skills_inner` logic (using the same types) so we can
/// assert on sort order without touching the filesystem.
fn parse_registry_skills(json: &str) -> Vec<SkillInfo> {
    let root: RegistryRoot = serde_json::from_str(json).expect("parse");
    let mut out = Vec::new();
    for (key, s) in root.skills.into_iter() {
        let name = match s.name {
            Some(n) => n,
            None => key.split("::").nth(1).unwrap_or(&key).to_string(),
        };
        let priority = s.priority.map(|p| p.clamp(1, 10)).unwrap_or(5);
        out.push(SkillInfo {
            name,
            state: s.state.unwrap_or_else(|| "unknown".to_string()),
            source: s.source,
            description: s.description.filter(|d| !d.is_empty()),
            tags: s.tags,
            path: s.path,
            usage_count: s.usage_count,
            priority,
            security: s.security,
        });
    }
    out.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.name.cmp(&b.name)));
    out
}

#[test]
fn priority_sort_descending_on_trigger_collision() {
    // Three UI skills with different priorities — mike-tyson (8) must
    // come first, then ui-ux-pro-max (6), then ui-designer (4).
    let json = r#"{
        "skills": {
            "active::mike-tyson":     {"name":"mike-tyson",    "priority":8},
            "active::ui-ux-pro-max":  {"name":"ui-ux-pro-max", "priority":6},
            "active::ui-designer":    {"name":"ui-designer",   "priority":4}
        }
    }"#;
    let skills = parse_registry_skills(json);
    assert_eq!(skills[0].name, "mike-tyson");
    assert_eq!(skills[0].priority, 8);
    assert_eq!(skills[1].name, "ui-ux-pro-max");
    assert_eq!(skills[1].priority, 6);
    assert_eq!(skills[2].name, "ui-designer");
    assert_eq!(skills[2].priority, 4);
}

#[test]
fn missing_priority_defaults_to_five() {
    // A skill without a `priority` key should resolve to 5.
    let json = r#"{
        "skills": {
            "active::no-priority": {"name":"no-priority"}
        }
    }"#;
    let skills = parse_registry_skills(json);
    assert_eq!(skills[0].priority, 5);
}

#[test]
fn priority_out_of_range_is_clamped() {
    // Values outside 1..=10 are clamped rather than rejected so a corrupt
    // registry.json does not panic the UI.
    let json = r#"{
        "skills": {
            "active::too-high": {"name":"too-high", "priority":99},
            "active::too-low":  {"name":"too-low",  "priority":0}
        }
    }"#;
    let skills = parse_registry_skills(json);
    let high = skills.iter().find(|s| s.name == "too-high").unwrap();
    let low = skills.iter().find(|s| s.name == "too-low").unwrap();
    assert_eq!(high.priority, 10, "values >10 clamped to 10");
    assert_eq!(low.priority, 1, "values <1 clamped to 1");
}

// -----------------------------------------------------------------------
// Bulk toggle
// -----------------------------------------------------------------------

#[test]
fn bulk_toggle_aggregates_per_item_outcomes() {
    // Use slugs that cannot exist as enabled/disabled global skills so
    // every item takes the error path deterministically (no real skill is
    // named like this). The point is to assert the aggregation shape, not
    // to mutate the user's real skills dir.
    let names = vec![
        "zzz-bulk-test-nonexistent-a".to_string(),
        "zzz-bulk-test-nonexistent-b".to_string(),
    ];
    let res = skills_bulk_toggle_inner(names.clone(), true).expect("bulk ok");
    assert_eq!(res.requested, 2);
    assert_eq!(res.outcomes.len(), 2);
    // Both are missing → both fail, none succeed, totals add up.
    assert_eq!(res.succeeded + res.failed, res.requested);
    assert!(res.outcomes.iter().all(|o| !o.ok && o.error.is_some()));
    assert_eq!(res.outcomes[0].name, names[0]);
}

#[test]
fn bulk_toggle_empty_is_noop() {
    let res = skills_bulk_toggle_inner(vec![], false).expect("bulk ok");
    assert_eq!(res.requested, 0);
    assert_eq!(res.succeeded, 0);
    assert_eq!(res.failed, 0);
    assert!(res.outcomes.is_empty());
}

#[test]
fn tie_broken_alphabetically() {
    // Two skills with same priority — alphabetical tiebreak must be stable.
    let json = r#"{
        "skills": {
            "active::zebra": {"name":"zebra", "priority":7},
            "active::alpha": {"name":"alpha", "priority":7}
        }
    }"#;
    let skills = parse_registry_skills(json);
    assert_eq!(skills[0].name, "alpha");
    assert_eq!(skills[1].name, "zebra");
}
