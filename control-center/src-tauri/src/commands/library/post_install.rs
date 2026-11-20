//! Post-install integration — FRENTE 7 (UI/funcionamiento).
//!
//! Closes the "ANALIZADOR DE REPOS AUSENTE" gap: when a local repo is analyzed,
//! the result is recorded in the governed memory by proposing a
//! `MemoryCandidate` ("repo X con skills/agentes Y") that lands in the inbox
//! (redaction + dedupe run in `MemoryService::create_candidate`). The candidate
//! states facts only: it does not claim any routing integration.
//!
//! Hasta el 2026-11-14 había un paso previo que ejecutaba
//! `cockpit/skill-lazy/sync-registry.js` para regenerar `skills-registry.json`;
//! se retiró junto con el dispatcher JS, el único lector de ese registro.
//!
//! Everything here is BEST-EFFORT and NON-FATAL: the scan itself has already
//! succeeded by the time this runs, so a closed brain.db must NOT turn a
//! successful analysis into a failed one. Failures are collected into
//! `PostInstallReport.warnings` and surfaced to the UI without erroring the
//! parent command.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::memory::model::{MemoryCandidate, MemoryType, Scope};
use crate::memory::service::MemoryService;

/// Outcome of the post-install integration step. Serialized to the frontend so
/// the Library UI can show the proposed memory candidate.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PostInstallReport {
    /// Candidate id created in the memory inbox (awaiting approval), if any.
    pub memory_candidate_id: Option<String>,
    /// Non-fatal notes (DB closed, …).
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Memory capture — propose a governed candidate
// ---------------------------------------------------------------------------

/// Texto del candidato de memoria. Solo hechos comprobables: el repo y los
/// assets detectados. Antes afirmaba «Integrado al routing via sync-registry»
/// aunque el sync hubiera fallado y aunque el registro no lo consuma nada
/// vivo (prompting-8 de la auditoría del 2026-10-23).
struct InstallMemoryText {
    title: String,
    summary: String,
    content: String,
}

fn install_memory_text(repo_label: &str, asset_names: &[String]) -> InstallMemoryText {
    let assets_str = if asset_names.is_empty() {
        "(sin skills/agentes detectados)".to_string()
    } else {
        asset_names.join(", ")
    };
    let summary = format!("Repo/asset '{repo_label}' con skills/agentes: {assets_str}.");
    InstallMemoryText {
        title: format!("Repo analizado: {repo_label}"),
        content: format!(
            "{summary} Detectado desde Library (analizar repo local); no se copió ningún fichero."
        ),
        summary,
    }
}

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

    let text = install_memory_text(repo_label, asset_names);
    c.proposed_project_id = project_id.map(str::to_string);
    c.proposed_title = Some(text.title);
    c.proposed_summary = Some(text.summary);
    c.proposed_content = Some(text.content);
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
// Orchestrator — único llamante: `analyze_local_repo` (la instalación desde
// GitHub se retiró el 2026-10-17)
// ---------------------------------------------------------------------------

/// Run the integration step, collecting non-fatal failures into the report.
/// Callers invoke this AFTER a successful scan and ignore the result's error
/// surface (there is none — this never returns `Err`).
#[must_use]
pub fn post_install_integrate(
    repo_label: &str,
    asset_names: &[String],
    project_id: Option<&str>,
) -> PostInstallReport {
    let mut report = PostInstallReport::default();

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
/// integration report (memory candidate).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzeRepoResult {
    /// Absolute path that was scanned.
    pub repo_path: String,
    /// Skill/agent slugs discovered.
    pub assets: Vec<String>,
    /// Memory-capture outcome.
    pub integration: PostInstallReport,
}

/// Scan a LOCAL repo for skills/agents and run the post-install integration
/// (memory candidate). Use this for repos already on disk (cloned, vendored,
/// or symlinked into `~/.claude`).
///
/// The scan is read-only — it does NOT copy any files.
///
/// Recorre el repo y escribe en brain.db: corre en el pool bloqueante, nunca
/// en el hilo principal.
#[tauri::command]
pub async fn analyze_local_repo(path: String) -> Result<AnalyzeRepoResult, String> {
    tauri::async_runtime::spawn_blocking(move || analyze_local_repo_blocking(&path))
        .await
        .map_err(|e| format!("analyze_local_repo: la tarea de fondo falló: {e}"))?
}

fn analyze_local_repo_blocking(path: &str) -> Result<AnalyzeRepoResult, String> {
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
        .unwrap_or(path)
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
        let res = analyze_local_repo_blocking("Z:/definitely/not/here/xyzzy");
        assert!(res.is_err());
    }

    /// Caso negativo de prompting-8: el candidato no puede afirmar una
    /// integración en el routing que no existe.
    #[test]
    fn install_memory_text_does_not_claim_routing_integration() {
        let t = install_memory_text("mi-repo", &["my-skill".to_string()]);
        for field in [&t.title, &t.summary, &t.content] {
            let lower = field.to_lowercase();
            assert!(!lower.contains("routing"), "{field}");
            assert!(!lower.contains("integrado"), "{field}");
        }
        assert!(t.summary.contains("mi-repo") && t.summary.contains("my-skill"));
        let empty = install_memory_text("vacio", &[]);
        assert!(empty.summary.contains("sin skills/agentes detectados"));
    }

    #[test]
    fn report_default_has_no_candidate_nor_warnings() {
        let r = PostInstallReport::default();
        assert!(r.memory_candidate_id.is_none());
        assert!(r.warnings.is_empty());
    }

    /// Caso negativo: el paso de sync-registry se retiró con el dispatcher y
    /// el informe que lee la UI ya no puede anunciar un registro regenerado.
    #[test]
    fn report_json_no_longer_carries_registry_fields() {
        let v = serde_json::to_value(PostInstallReport::default()).expect("json");
        let obj = v.as_object().expect("object");
        for retired in ["registry_synced", "registry_summary", "newly_detected"] {
            assert!(!obj.contains_key(retired), "{retired} sigue en el informe");
        }
        assert!(obj.contains_key("memory_candidate_id") && obj.contains_key("warnings"));
    }
}
