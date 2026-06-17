//! GitHub code search via `gh search code`.

use serde::Deserialize;

use super::cache::{cache_get, cache_put};
use super::gh_helpers::gh_command;
use super::types::{LibraryKind, RemoteItem};

pub async fn search_github_inner(
    query: String,
    kind: LibraryKind,
    limit: u32,
) -> Result<Vec<RemoteItem>, String> {
    let kind_path = match kind {
        LibraryKind::Agent => ".claude/agents",
        LibraryKind::Skill => ".claude/skills",
    };
    let cache_key = format!("{}:{}", kind_path, query);
    if let Some(cached) = cache_get(&cache_key) {
        return Ok(cached);
    }

    // gh CLI v2.x dropped the `name` field from `gh search code --json`.
    // Available fields are now: path, repository, sha, textMatches, url.
    // We derive the display name from the basename of `path`.
    //
    // GitHub code search treats the FIRST token as the keyword and the
    // rest as qualifiers. Putting `SKILL.md` before `path:` returns 0
    // results because GitHub indexes "SKILL.md" as a filename, not a
    // body token. The user-supplied query MUST come first so the rest
    // of the line works as qualifiers — verified manually via
    //   gh search code "tdd path:.claude/skills" → 5 hits
    //   gh search code "SKILL.md path:.claude/skills tdd" → []
    //
    // Post-filtering happens below (per-kind path/extension assertions),
    // so we don't lose precision by loosening the query.
    let q = match kind {
        LibraryKind::Skill => format!("{} path:{}", query, kind_path),
        LibraryKind::Agent => format!("{} path:{} extension:md", query, kind_path),
    };
    let limit_str = limit.clamp(1, 100).to_string();
    let args: Vec<String> = vec![
        "search".into(),
        "code".into(),
        q,
        "--json".into(),
        "repository,path,url".into(),
        "--limit".into(),
        limit_str,
    ];

    let output = tauri::async_runtime::spawn_blocking(move || gh_command(&args).output())
        .await
        .map_err(|e| format!("spawn join: {e}"))?
        .map_err(|e| format!("gh search code failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh exited {}: {}", output.status, stderr));
    }

    #[derive(Deserialize)]
    struct GhRepo {
        #[serde(rename = "nameWithOwner")]
        name_with_owner: String,
    }
    #[derive(Deserialize)]
    struct GhHit {
        repository: GhRepo,
        path: String,
        url: Option<String>,
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let hits: Vec<GhHit> =
        serde_json::from_str(&stdout).map_err(|e| format!("gh json parse: {e}"))?;

    let items: Vec<RemoteItem> = hits
        .into_iter()
        .filter_map(|h| {
            // Strict filter per kind: skill hits MUST be a SKILL.md file
            // (anything else is a false positive — README.md, docs/, etc.).
            // Agent hits MUST be a .md file directly under an `agents/`
            // segment (not nested README/docs).
            match kind {
                LibraryKind::Skill => {
                    // Accept three shapes (verified on real repos):
                    //   .claude/skills/<name>/SKILL.md   <- canonical
                    //   .claude/skills/<name>.md         <- flat file
                    //   .claude/skills/<name>/README.md  <- occasional
                    let p = &h.path;
                    let is_skill_md = p.ends_with("/SKILL.md") || p == "SKILL.md";
                    let is_readme_under_skills = p.contains(".claude/skills/")
                        && p.to_ascii_lowercase().ends_with("/readme.md");
                    let is_flat_skill = {
                        // .claude/skills/<name>.md (parent dir literally "skills").
                        let parent_is_skills = p
                            .rsplit('/')
                            .nth(1)
                            .map(|seg| seg == "skills")
                            .unwrap_or(false);
                        parent_is_skills && p.ends_with(".md")
                    };
                    if !(is_skill_md || is_readme_under_skills || is_flat_skill) {
                        return None;
                    }
                }
                LibraryKind::Agent => {
                    if !h.path.ends_with(".md") {
                        return None;
                    }
                    // The file's parent dir must literally be `agents`
                    // (i.e. <repo>/.claude/agents/<name>.md). Skips
                    // `.claude/agents/README.md` rejection too — README is
                    // not a kebab-case agent slug downstream anyway.
                    let parent_is_agents = h
                        .path
                        .rsplit('/')
                        .nth(1)
                        .map(|seg| seg == "agents")
                        .unwrap_or(false);
                    if !parent_is_agents {
                        return None;
                    }
                    let bn = h.path.rsplit('/').next().unwrap_or("");
                    if bn.eq_ignore_ascii_case("readme.md") {
                        return None;
                    }
                }
            }

            let (owner, repo) = {
                let mut it = h.repository.name_with_owner.splitn(2, '/');
                let o = it.next()?.to_string();
                let r = it.next()?.to_string();
                (o, r)
            };
            // Derive a human name from the path:
            //   .claude/skills/foo/SKILL.md  -> "foo"
            //   .claude/agents/foo.md        -> "foo"
            let name = match kind {
                LibraryKind::Skill => {
                    let bn = h.path.rsplit('/').next().unwrap_or("");
                    let bn_lc = bn.to_ascii_lowercase();
                    if bn_lc == "skill.md" || bn_lc == "readme.md" {
                        // Folder-style: <name>/SKILL.md -> parent dir is the name.
                        h.path.rsplit('/').nth(1).unwrap_or("").to_string()
                    } else {
                        // Flat file: <name>.md -> stem of the basename.
                        bn.trim_end_matches(".md").to_string()
                    }
                }
                LibraryKind::Agent => h
                    .path
                    .rsplit('/')
                    .next()
                    .unwrap_or("")
                    .trim_end_matches(".md")
                    .to_string(),
            };
            if name.is_empty() {
                return None;
            }
            Some(RemoteItem {
                owner,
                repo,
                path: h.path,
                name,
                html_url: h.url,
                preview: None,
            })
        })
        .collect();

    cache_put(cache_key, items.clone());
    Ok(items)
}
