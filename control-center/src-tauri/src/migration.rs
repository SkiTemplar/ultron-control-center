// ULTRON Control Center — data migration / schema versioning (card-data-migration-v213-v214).
//
// v2.14 introduces a breaking-ish data change: sessions-tags entries gain an
// optional `project` field (auto-tag by cwd, card-vis-auto-tag-cwd). The field
// is backward-compatible at the JSON layer (serde `default` + `skip_serializing_if`),
// so a FORWARD read of old data is safe. The real risk is a ROLLBACK
// v2.14 -> v2.13 silently dropping the field on rewrite — which is why we record
// an explicit version in `cockpit/meta.json` and DECLARE v2.14 as a breaking
// change (validator recommendation #5) rather than pretend forward-compat is free.
//
// What this module does at first boot:
//   1. Read cockpit/meta.json (absence => pre-v2.14 install).
//   2. If the stored schema_version < CURRENT, run idempotent migrations:
//        - ensure cockpit/features.json exists (defaults; never overwrite).
//      (kg.jsonl per-line `schema_version` stamping from the card is
//       intentionally NOT done: KgEntity/KgRelation don't read it, serde drops
//       unknown fields, so it would be cosmetic. meta.json is the real record.)
//   3. Write meta.json with the current versions.
//
// `migrate_dry_run()` reports what WOULD happen without writing.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::ultron_root;

pub const CURRENT_SCHEMA_VERSION: u32 = 1;
/// sessions-tags schema: v1 = {session_id, tags, generated_at};
/// v2 = adds optional `project` (card-vis-auto-tag-cwd).
pub const SESSIONS_TAGS_V: u32 = 2;
pub const KG_SCHEMA_V: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetaInfo {
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub last_migrated_from: Option<String>,
    #[serde(default)]
    pub current_schema_version: u32,
    #[serde(default)]
    pub kg_schema_v: u32,
    #[serde(default)]
    pub sessions_tags_v: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationReport {
    /// Schema version found on disk before this run (0 = fresh / pre-v2.14).
    pub from_version: u32,
    /// Schema version after this run.
    pub to_version: u32,
    /// Whether anything needed migrating.
    pub migrated: bool,
    /// Human-readable list of actions taken (or that would be taken in dry-run).
    pub actions: Vec<String>,
    /// True when this was a dry run (no writes performed).
    pub dry_run: bool,
}

fn meta_path(cockpit: &Path) -> PathBuf {
    cockpit.join("meta.json")
}

fn read_meta_at(cockpit: &Path) -> Option<MetaInfo> {
    let raw = std::fs::read_to_string(meta_path(cockpit)).ok()?;
    serde_json::from_str::<MetaInfo>(&raw).ok()
}

fn write_meta_at(cockpit: &Path, meta: &MetaInfo) -> Result<(), String> {
    std::fs::create_dir_all(cockpit).map_err(|e| format!("mkdir cockpit: {e}"))?;
    let json = serde_json::to_string_pretty(meta).map_err(|e| format!("serialize meta: {e}"))?;
    let path = meta_path(cockpit);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| format!("write meta tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename meta: {e}"))?;
    Ok(())
}

/// Core migration runner against an explicit cockpit dir (path-parameterised so
/// tests don't touch the real ~/.ultron). Idempotent: running twice is a no-op.
fn run_migrations_at(cockpit: &Path, app_version: &str, dry: bool) -> MigrationReport {
    let prev = read_meta_at(cockpit);
    let from_version = prev.as_ref().map(|m| m.current_schema_version).unwrap_or(0);
    let mut actions: Vec<String> = Vec::new();
    let migrated = from_version < CURRENT_SCHEMA_VERSION;

    if migrated {
        if from_version == 0 {
            actions.push("Primer arranque v2.14 (sin meta.json previo): declarado breaking change.".to_string());
        } else {
            actions.push(format!("Migrando schema v{from_version} -> v{CURRENT_SCHEMA_VERSION}."));
        }
        // Ensure features.json exists with defaults (never overwrite an existing one).
        let features = cockpit.join("features.json");
        if !features.exists() {
            actions.push("Crear features.json con defaults.".to_string());
            if !dry {
                if let Ok(json) = serde_json::to_string_pretty(&crate::features::Features::default()) {
                    let _ = std::fs::create_dir_all(cockpit);
                    let tmp = features.with_extension("json.tmp");
                    if std::fs::write(&tmp, &json).is_ok() {
                        let _ = std::fs::rename(&tmp, &features);
                    }
                }
            }
        }
        actions.push(format!(
            "sessions-tags schema marcado v{SESSIONS_TAGS_V} (campo project opcional, backward-compatible)."
        ));
    }

    if !dry && migrated {
        let meta = MetaInfo {
            app_version: app_version.to_string(),
            last_migrated_from: prev
                .as_ref()
                .map(|m| m.app_version.clone())
                .filter(|s| !s.is_empty()),
            current_schema_version: CURRENT_SCHEMA_VERSION,
            kg_schema_v: KG_SCHEMA_V,
            sessions_tags_v: SESSIONS_TAGS_V,
        };
        if let Err(e) = write_meta_at(cockpit, &meta) {
            actions.push(format!("WARN: no se pudo escribir meta.json: {e}"));
        }
    } else if !dry && !migrated {
        // Keep app_version fresh even when no schema migration is needed.
        if let Some(mut meta) = prev {
            if meta.app_version != app_version {
                meta.app_version = app_version.to_string();
                let _ = write_meta_at(cockpit, &meta);
            }
        }
    }

    MigrationReport {
        from_version,
        to_version: CURRENT_SCHEMA_VERSION,
        migrated,
        actions,
        dry_run: dry,
    }
}

fn cockpit_dir() -> Result<PathBuf, String> {
    Ok(ultron_root()?.join("cockpit"))
}

/// Run migrations at boot. Best-effort: a failure here must not block startup.
pub fn run_migrations_inner(app_version: &str) -> MigrationReport {
    match cockpit_dir() {
        Ok(dir) => run_migrations_at(&dir, app_version, false),
        Err(e) => MigrationReport {
            from_version: 0,
            to_version: CURRENT_SCHEMA_VERSION,
            migrated: false,
            actions: vec![format!("no cockpit dir: {e}")],
            dry_run: false,
        },
    }
}

/// Tauri command: report what a migration WOULD do, without writing.
#[tauri::command]
pub fn migrate_dry_run() -> MigrationReport {
    migrate_dry_run_inner()
}

pub fn migrate_dry_run_inner() -> MigrationReport {
    match cockpit_dir() {
        Ok(dir) => run_migrations_at(&dir, env!("CARGO_PKG_VERSION"), true),
        Err(e) => MigrationReport {
            from_version: 0,
            to_version: CURRENT_SCHEMA_VERSION,
            migrated: false,
            actions: vec![format!("no cockpit dir: {e}")],
            dry_run: true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_cockpit() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("ultron_mig_test_{}_{}", std::process::id(), n));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn fresh_install_migrates_and_writes_meta() {
        let c = temp_cockpit();
        let r = run_migrations_at(&c, "2.14.0", false);
        assert_eq!(r.from_version, 0);
        assert_eq!(r.to_version, CURRENT_SCHEMA_VERSION);
        assert!(r.migrated);
        let meta = read_meta_at(&c).expect("meta.json written");
        assert_eq!(meta.current_schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(meta.sessions_tags_v, SESSIONS_TAGS_V);
        assert!(c.join("features.json").exists(), "features.json created");
        let _ = std::fs::remove_dir_all(&c);
    }

    #[test]
    fn second_run_is_idempotent_noop() {
        let c = temp_cockpit();
        run_migrations_at(&c, "2.14.0", false);
        let r2 = run_migrations_at(&c, "2.14.0", false);
        assert!(!r2.migrated, "already at current schema -> no migration");
        assert_eq!(r2.from_version, CURRENT_SCHEMA_VERSION);
        let _ = std::fs::remove_dir_all(&c);
    }

    #[test]
    fn dry_run_writes_nothing() {
        let c = temp_cockpit();
        let r = run_migrations_at(&c, "2.14.0", true);
        assert!(r.dry_run);
        assert!(r.migrated, "dry run still reports it WOULD migrate");
        assert!(read_meta_at(&c).is_none(), "dry run must not write meta.json");
        assert!(!c.join("features.json").exists(), "dry run must not write features.json");
        let _ = std::fs::remove_dir_all(&c);
    }

    #[test]
    fn does_not_overwrite_existing_features() {
        let c = temp_cockpit();
        std::fs::write(c.join("features.json"), "{\"memory\":false}").unwrap();
        run_migrations_at(&c, "2.14.0", false);
        let kept = std::fs::read_to_string(c.join("features.json")).unwrap();
        assert!(kept.contains("\"memory\":false"), "existing features.json preserved");
        let _ = std::fs::remove_dir_all(&c);
    }
}
