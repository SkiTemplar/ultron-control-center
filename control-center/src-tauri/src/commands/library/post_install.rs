//! Post-install integration — FRENTE 7 (UI/funcionamiento).
//!
//! Closes the "ANALIZADOR DE REPOS AUSENTE" gap: when a repo (or a single
//! skill/agent file) is installed, the new payload must be integrated
//! AUTOMATICALLY into:
//!   (a) the routing catalog — by running `cockpit/skill-lazy/sync-registry.js`
//!       (previously a MANUAL step), which regenerates `skills-registry.json`
//!       from the dispatcher so newly-installed skills/agents become routable;
//!   (b) the governed memory — by proposing a `MemoryCandidate` recording
//!       "instale repo X con skills/agentes Y", landing it in the inbox for
//!       human approval (never auto-promoted; redaction + dedupe run in
//!       `MemoryService::create_candidate`).
//!
//! Everything here is BEST-EFFORT and NON-FATAL: the install itself has already
//! succeeded by the time this runs, so a missing `node`, a dispatcher parse
//! error, or a closed brain.db must NOT turn a successful install into a failed
//! one. Failures are collected into `PostInstallReport.warnings` and surfaced to
//! the UI without erroring the parent command.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::memory::model::{MemoryCandidate, MemoryType, Scope};
use crate::memory::service::MemoryService;
use crate::ultron_root;

/// Outcome of the post-install integration step. Serialized to the frontend so
/// the Library UI can show "catalog synced + 1 memory proposed" feedback.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PostInstallReport {
    /// True when `sync-registry.js` ran and exited 0.
    pub registry_synced: bool,
    /// Stdout line from sync-registry (its `{ok,total,added,updated,detected}` JSON)
    /// when available — handy for the UI log.
    pub registry_summary: Option<String>,
    /// How many new skills/agents were discovered from the filesystem scan and
    /// added to the registry (assets that existed on disk but were not registered).
    /// 0 when sync-registry did not run or reported no new detections.
    pub newly_detected: u32,
    /// Candidate id created in the memory inbox (awaiting approval), if any.
    pub memory_candidate_id: Option<String>,
    /// Non-fatal notes (a missing `node`, dispatcher error, DB closed, …).
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// (a) Routing catalog sync — run sync-registry.js
// ---------------------------------------------------------------------------

/// Absolute path to the bundled `sync-registry.js`.
fn sync_registry_script() -> Result<PathBuf, String> {
    let p = ultron_root()?
        .join("cockpit")
        .join("skill-lazy")
        .join("sync-registry.js");
    if !p.exists() {
        return Err(format!("sync-registry.js not found at {}", p.display()));
    }
    Ok(p)
}

/// Result of running `node sync-registry.js`.
struct SyncRegistryResult {
    /// The raw stdout line (JSON summary) for the UI log.
    summary: String,
    /// Number of new assets discovered from the filesystem scan.
    newly_detected: u32,
}

/// Spawn `node sync-registry.js`. Windows-only `CREATE_NO_WINDOW` (0x0800_0000)
/// keeps the subprocess from flashing a console window (same discipline as the
/// `gh` spawns in `library.rs`). Returns the trimmed stdout summary on success.
fn run_sync_registry() -> Result<SyncRegistryResult, String> {
    let script = sync_registry_script()?;
    // Resolve `node` explicitly so a clearer error surfaces when Node is absent
    // (instead of an opaque "program not found" from Command::spawn).
    let node = which::which("node").map_err(|_| "node not found on PATH".to_string())?;

    let mut cmd = std::process::Command::new(node);
    cmd.arg(&script);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("spawn node sync-registry: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "sync-registry exited {}: {}",
            output.status,
            stderr.trim()
        ));
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let summary = raw.trim().to_string();

    // Parse `detected` from the JSON summary line, e.g.
    // {"ok":true,"total":179,"added":3,"updated":0,"detected":25,"path":"..."}
    let newly_detected = summary
        .as_str()
        .parse::<serde_json::Value>()
        .ok()
        .and_then(|v| v.get("detected").and_then(|d| d.as_u64()))
        .map(|n| n as u32)
        .unwrap_or(0);

    Ok(SyncRegistryResult {
        summary,
        newly_detected,
    })
}

// ---------------------------------------------------------------------------
// (b) Memory capture — propose a governed candidate
// ---------------------------------------------------------------------------

/// Propose a `skill`-typed memory candidate recording the install. Goes through
/// `MemoryService::create_candidate` so redaction + dedupe apply and it lands in
/// the inbox (pending) — never auto-active. Returns the candidate id.
///
/// `asset_names` are the skill/agent slugs the install brought in (may be empty
/// for a single-file install where only `label` is known).
fn capture_install_memory(
    repo_label: &str,
    asset_names: &[String],
    project_id: Option<&str>,
) -> Result<String, String> {
    let scope = if project_id.is_some() {
        Scope::Project
    } else {
        Scope::Global
    };
    let mut c = MemoryCandidate::new(MemoryType::Skill, scope);

    let assets_str = if asset_names.is_empty() {
        "(sin skills/agentes detectados)".to_string()
    } else {
        asset_names.join(", ")
    };

    c.proposed_project_id = project_id.map(str::to_string);
    c.proposed_title = Some(format!("Instalado: {repo_label}"));
    let summary = format!("Instalado repo/asset '{repo_label}' con skills/agentes: {assets_str}.");
    c.proposed_summary = Some(summary.clone());
    c.proposed_content = Some(format!(
        "{summary} Integrado al routing via sync-registry (skills-registry.json regenerado) \
         y registrado en memoria para futuras decisiones de routing."
    ));
    // Tags help recall/filtering; `library-install` marks provenance.
    let mut tags = vec!["library-install".to_string()];
    for a in asset_names {
        tags.push(format!("asset:{a}"));
    }
    if let Some(pid) = project_id {
        tags.push(format!("project:{pid}"));
    }
    c.proposed_tags = tags;
    c.capture_source = Some("library_install".to_string());
    // Installs are concrete, durable facts — rank a touch above the 0.5 default.
    c.importance = 0.62;
    c.confidence = 0.7;

    match MemoryService::create_candidate(&c) {
        Ok(id) => Ok(id),
        // Dedupe bloqueante (2026-07-02): reinstalar el mismo repo produce texto
        // identico -> idempotencia (se devuelve el id existente), no un error.
        Err(crate::memory::MemoryError::Duplicate(existing_id)) => Ok(existing_id),
        Err(e) => Err(format!("create_candidate: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Orchestrator — wired into both install paths
// ---------------------------------------------------------------------------

/// Run BOTH integration steps, collecting non-fatal failures into the report.
/// Callers invoke this AFTER a successful install and ignore the result's error
/// surface (there is none — this never returns `Err`).
#[must_use]
pub fn post_install_integrate(
    repo_label: &str,
    asset_names: &[String],
    project_id: Option<&str>,
) -> PostInstallReport {
    let mut report = PostInstallReport::default();

    match run_sync_registry() {
        Ok(result) => {
            report.registry_synced = true;
            report.newly_detected = result.newly_detected;
            if !result.summary.is_empty() {
                report.registry_summary = Some(result.summary);
            }
        }
        Err(e) => report.warnings.push(format!("sync-registry skipped: {e}")),
    }

    match capture_install_memory(repo_label, asset_names, project_id) {
        Ok(id) => report.memory_candidate_id = Some(id),
        Err(e) => report.warnings.push(format!("memory capture skipped: {e}")),
    }

    report
}

// ---------------------------------------------------------------------------
// Local repo scan — `analyze_local_repo(path)`
// ---------------------------------------------------------------------------

/// Skill/agent slugs discovered in a repo on disk. Mirrors the layouts the
/// installer understands: `.claude/skills/<name>/SKILL.md` (+ bare `skills/`)
/// and `.claude/agents/*.md` (+ bare `agents/`).
fn scan_repo_assets(repo_dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();

    // Skills: directory name that contains a SKILL.md.
    for skills_root in [
        repo_dir.join(".claude").join("skills"),
        repo_dir.join("skills"),
    ] {
        if let Ok(entries) = std::fs::read_dir(&skills_root) {
            for entry in entries.flatten() {
                let dir = entry.path();
                if dir.is_dir() && dir.join("SKILL.md").exists() {
                    if let Some(n) = dir.file_name().and_then(|s| s.to_str()) {
                        names.push(n.to_string());
                    }
                }
            }
        }
    }

    // Agents: <name>.md files (excluding README.md).
    for agents_root in [
        repo_dir.join(".claude").join("agents"),
        repo_dir.join("agents"),
    ] {
        if let Ok(entries) = std::fs::read_dir(&agents_root) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("md") {
                    let fname = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                    if !fname.eq_ignore_ascii_case("README.md") {
                        names.push(fname.trim_end_matches(".md").to_string());
                    }
                }
            }
        }
    }

    names.sort();
    names.dedup();
    names
}

/// Result of `analyze_local_repo`: the assets it found plus the post-install
/// integration report (catalog sync + memory candidate).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzeRepoResult {
    /// Absolute path that was scanned.
    pub repo_path: String,
    /// Skill/agent slugs discovered.
    pub assets: Vec<String>,
    /// Catalog-sync + memory-capture outcome.
    pub integration: PostInstallReport,
}

/// Scan a LOCAL repo for skills/agents and run the SAME post-install integration
/// (sync-registry + memory candidate) as a GitHub install. Use this for repos
/// already on disk (cloned, vendored, or symlinked into `~/.claude`).
///
/// The scan is read-only — it does NOT copy any files. It assumes the assets are
/// already discoverable by the dispatcher (which is what `sync-registry` reads);
/// for repos NOT yet placed under `~/.claude`, install them first.
#[tauri::command]
pub fn analyze_local_repo(path: String) -> Result<AnalyzeRepoResult, String> {
    let repo_dir = PathBuf::from(&path);
    if !repo_dir.exists() {
        return Err(format!("path not found: {path}"));
    }
    if !repo_dir.is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    let assets = scan_repo_assets(&repo_dir);
    let repo_label = repo_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&path)
        .to_string();

    let integration = post_install_integrate(&repo_label, &assets, None);

    Ok(AnalyzeRepoResult {
        repo_path: repo_dir.to_string_lossy().to_string(),
        assets,
        integration,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_repo_assets_finds_nested_skills_and_agents() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();

        let skill_dir = root.join(".claude").join("skills").join("my-skill");
        std::fs::create_dir_all(&skill_dir).expect("mkdir skill");
        std::fs::write(skill_dir.join("SKILL.md"), "---\nname: my-skill\n---\nx")
            .expect("write skill");

        let agents_dir = root.join(".claude").join("agents");
        std::fs::create_dir_all(&agents_dir).expect("mkdir agents");
        std::fs::write(
            agents_dir.join("my-agent.md"),
            "---\nname: my-agent\n---\nx",
        )
        .expect("write agent");
        std::fs::write(agents_dir.join("README.md"), "ignore").expect("write readme");

        let assets = scan_repo_assets(root);
        assert!(
            assets.contains(&"my-skill".to_string()),
            "skill: {assets:?}"
        );
        assert!(
            assets.contains(&"my-agent".to_string()),
            "agent: {assets:?}"
        );
        assert!(
            !assets.contains(&"README".to_string()),
            "README must be skipped: {assets:?}"
        );
    }

    #[test]
    fn scan_repo_assets_empty_repo_returns_empty() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let assets = scan_repo_assets(tmp.path());
        assert!(assets.is_empty());
    }

    #[test]
    fn analyze_local_repo_rejects_missing_path() {
        let res = analyze_local_repo("Z:/definitely/not/here/xyzzy".to_string());
        assert!(res.is_err());
    }

    #[test]
    fn report_default_is_unsynced_no_warnings() {
        let r = PostInstallReport::default();
        assert!(!r.registry_synced);
        assert!(r.memory_candidate_id.is_none());
        assert!(r.warnings.is_empty());
    }
}
