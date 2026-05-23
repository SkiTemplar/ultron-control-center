//! P5 — Agent/Skill library Tauri command wrappers.
//! v2.1 — also surfaces the curated catalog (`cockpit/curated-catalog.json`)
//! that powers the Library -> Catalog sub-tab.

use crate::library;
use crate::ultron_root;

/// Raw JSON payload of `~/.ultron/cockpit/curated-catalog.json`. Returned
/// as a `serde_json::Value` so the schema can evolve in the file without
/// requiring a backend recompile — the frontend tolerates unknown keys.
#[tauri::command]
pub fn read_curated_catalog() -> Result<serde_json::Value, String> {
    let path = ultron_root()?.join("cockpit").join("curated-catalog.json");
    if !path.exists() {
        // Empty schema: frontend renders the "no domains" empty state and
        // a "create a catalog" hint instead of crashing.
        return Ok(serde_json::json!({
            "schema_version": 1,
            "updated_at": null,
            "domains": []
        }));
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("parse curated-catalog.json: {e}"))
}

#[tauri::command]
pub async fn library_search_github(
    query: String,
    kind: library::LibraryKind,
    limit: Option<u32>,
) -> Result<Vec<library::RemoteItem>, String> {
    let lim = limit.unwrap_or(30);
    library::search_github_inner(query, kind, lim).await
}

#[derive(serde::Deserialize)]
pub struct InstallArgs {
    pub owner: String,
    pub repo: String,
    pub path: String,
    pub kind: library::LibraryKind,
    pub target_scope: library::TargetScope,
    pub target_project_id: Option<String>,
    pub target_name: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
}

#[tauri::command]
pub async fn library_install_from_github(args: InstallArgs) -> Result<String, String> {
    let p = library::install_from_github_inner(
        args.owner,
        args.repo,
        args.path,
        args.kind,
        args.target_scope,
        args.target_project_id,
        args.target_name,
        args.overwrite,
    )
    .await?;
    Ok(p.display().to_string())
}

#[derive(serde::Deserialize)]
pub struct AgentCreateArgs {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub tools: Vec<String>,
    pub model: Option<String>,
    pub body: String,
    pub target_scope: library::TargetScope,
    pub target_project_id: Option<String>,
}

#[tauri::command]
pub fn agent_create(args: AgentCreateArgs) -> Result<String, String> {
    let spec = library::AgentCreateSpec {
        name: args.name,
        description: args.description,
        tools: args.tools,
        model: args.model,
        body: args.body,
    };
    let p = library::agent_create_inner(spec, args.target_scope, args.target_project_id)?;
    Ok(p.display().to_string())
}

#[derive(serde::Deserialize)]
pub struct SkillCreateArgs {
    pub name: String,
    pub description: String,
    pub body: String,
    pub target_scope: library::TargetScope,
    pub target_project_id: Option<String>,
}

#[tauri::command]
pub fn skill_create(args: SkillCreateArgs) -> Result<String, String> {
    let spec = library::SkillCreateSpec {
        name: args.name,
        description: args.description,
        body: args.body,
    };
    let p = library::skill_create_inner(spec, args.target_scope, args.target_project_id)?;
    Ok(p.display().to_string())
}

#[tauri::command]
pub fn library_pin_agent(
    project_id: String,
    agent_slug: String,
) -> Result<library::PinnedAgents, String> {
    library::pin_agent_inner(&project_id, &agent_slug)
}

#[tauri::command]
pub fn library_unpin_agent(
    project_id: String,
    agent_slug: String,
) -> Result<library::PinnedAgents, String> {
    library::unpin_agent_inner(&project_id, &agent_slug)
}

#[tauri::command]
pub fn library_list_pinned(project_id: String) -> Result<library::PinnedAgents, String> {
    library::pinned_load(&project_id)
}

// ---------------------------------------------------------------------------
// Catalog refresh — fetch the first paragraph of each item's source file
// from GitHub raw and return them keyed by `owner/repo/path`. The frontend
// merges these into the static seed summaries so the cards show fresh
// upstream wording on every Catalog mount. Failures are reported per-item;
// the global call never errors out.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct CatalogPreview {
    pub key: String,
    pub summary: Option<String>,
    pub error: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct CatalogPreviewRequest {
    pub owner: String,
    pub repo: String,
    pub path: String,
    /// Optional branch override; defaults to `main` and falls back to `master`.
    #[serde(default)]
    pub branch: Option<String>,
}

#[tauri::command]
pub async fn catalog_fetch_previews(
    items: Vec<CatalogPreviewRequest>,
) -> Result<Vec<CatalogPreview>, String> {
    let client = reqwest::Client::builder()
        .user_agent("ultron-control-center/2.0 (catalog-preview)")
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?;

    // Sequential fetches keep deps minimal (no `futures` crate). Catalog
    // is small (<50 items) and the per-request timeout caps total runtime.
    let mut out: Vec<CatalogPreview> = Vec::with_capacity(items.len());
    for req in items {
        let key = format!("{}/{}/{}", req.owner, req.repo, req.path);
        let branches: Vec<String> = match req.branch {
            Some(b) if !b.is_empty() => vec![b],
            _ => vec!["main".to_string(), "master".to_string()],
        };
        let mut last_err: Option<String> = None;
        let mut summary: Option<String> = None;
        for branch in &branches {
            let url = format!(
                "https://raw.githubusercontent.com/{}/{}/{}/{}",
                req.owner, req.repo, branch, req.path
            );
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => match resp.text().await {
                    Ok(body) => {
                        summary = Some(extract_summary(&body));
                        last_err = None;
                        break;
                    }
                    Err(e) => last_err = Some(format!("body: {e}")),
                },
                Ok(resp) => last_err = Some(format!("http {}", resp.status())),
                Err(e) => last_err = Some(format!("net: {e}")),
            }
        }
        out.push(CatalogPreview {
            key,
            summary,
            error: last_err,
        });
    }
    Ok(out)
}

/// Pull the first non-trivial paragraph out of a SKILL.md / README.md /
/// agent .md file. Strips YAML frontmatter and the leading `# Title`
/// header. Caps at 240 chars so the catalog cards stay tight.
fn extract_summary(body: &str) -> String {
    let mut text = body.trim_start();
    if text.starts_with("---") {
        // Skip frontmatter block.
        if let Some(end) = text[3..].find("\n---") {
            text = text[3 + end + 4..].trim_start();
        }
    }
    let mut paragraph = String::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        if line.starts_with('#') {
            // Skip heading lines until we find prose.
            continue;
        }
        if line.starts_with("```") || line.starts_with("<!--") {
            continue;
        }
        if !paragraph.is_empty() {
            paragraph.push(' ');
        }
        paragraph.push_str(line);
        if paragraph.len() > 280 {
            break;
        }
    }
    let trimmed = paragraph.trim();
    if trimmed.len() <= 240 {
        return trimmed.to_string();
    }
    let cut = trimmed.char_indices().nth(237).map(|(i, _)| i).unwrap_or(237);
    format!("{}…", &trimmed[..cut])
}

#[cfg(test)]
mod catalog_tests {
    use super::extract_summary;

    #[test]
    fn strips_frontmatter_and_title() {
        let body = "---\nname: foo\ndescription: x\n---\n\n# Foo\n\nFirst real line here.\nSecond line.\n";
        let s = extract_summary(body);
        assert_eq!(s, "First real line here. Second line.");
    }

    #[test]
    fn skips_empty_body() {
        let body = "---\nname: foo\n---\n";
        let s = extract_summary(body);
        assert!(s.is_empty());
    }

    #[test]
    fn truncates_long_paragraph_with_ellipsis() {
        let long = "x".repeat(400);
        let body = format!("# Title\n\n{}\n", long);
        let s = extract_summary(&body);
        assert!(s.ends_with('…'));
        assert!(s.chars().count() <= 238);
    }
}
