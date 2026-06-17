//! AI-driven install (v2.9.5 — P1 Library>Catalog)
//!
//! Flow:
//!   1. Clone repo to temp dir  (~/.ultron/cockpit/temp-install/<sanitized>/)
//!   2. Read README.md + manifests + SKILL.md / plugin.json
//!   3. Build prompt with repo content + current stack context
//!   4. Call ai_router::route("code-review", prompt) -> JSON report
//!   5. Parse report: if compatible=false -> return early with warnings
//!   6. Execute steps + copy files (unless dry_run=true)
//!   7. Cleanup temp dir + return AiInstallResult
//!
//! Fallback: if the AI Router has no usable provider, the command returns
//! `AiInstallResult { ai_available: false, report: None, ... }` and the UI
//! shows the "copy URL" fallback path.

use std::path::{Path, PathBuf};

use super::gh_helpers::clone_repo;
use super::helpers::ultron_root;
use super::types::{AiInstallResult, CopyFile, InstallReport, InstallStep, TargetScope};

// ---------------------------------------------------------------------------
// URL / filesystem utilities (local to this module)
// ---------------------------------------------------------------------------

/// Extract the repo `owner/name` slug from a GitHub URL.
/// Accepts:
///   https://github.com/owner/repo
///   https://github.com/owner/repo.git
///   github.com/owner/repo
fn parse_github_slug(url: &str) -> Option<(String, String)> {
    let stripped = url
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("github.com/");
    let parts: Vec<&str> = stripped.splitn(3, '/').collect();
    if parts.len() < 2 {
        return None;
    }
    let owner = parts[0].to_string();
    let repo = parts[1].trim_end_matches(".git").to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

/// Sanitise a repo name to a filesystem-safe directory component.
fn sanitize_dir_name(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Expand a leading `~` to the user's home directory.
fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

// ---------------------------------------------------------------------------
// Repo context collection
// ---------------------------------------------------------------------------

/// Read a file from disk, capping at `max_bytes` to avoid flooding the prompt.
fn read_capped(path: &Path, max_bytes: usize) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let truncated = if bytes.len() > max_bytes {
        &bytes[..max_bytes]
    } else {
        &bytes[..]
    };
    Some(String::from_utf8_lossy(truncated).into_owned())
}

/// Collect relevant files from the cloned repo into a single context string.
///
/// Reads the usual top-level manifests/READMEs PLUS, for deep skill/agent
/// repos, the nested `.claude/skills/<name>/SKILL.md` and `.claude/agents/*.md`
/// (and a bare top-level `skills/`/`agents/` layout) so the AI analysis sees
/// the actual skill/agent definitions instead of only the README. Without
/// this, a repo whose payload lives entirely under `.claude/skills/*/SKILL.md`
/// looked empty to the analyzer and got mis-classified.
fn collect_repo_context(repo_dir: &Path) -> String {
    let candidates = [
        "README.md",
        "readme.md",
        "SKILL.md",
        "plugin.json",
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
        "setup.py",
        "LICENSE",
        "INSTALL.md",
        "CONTRIBUTING.md",
    ];
    let mut parts: Vec<String> = Vec::new();
    for name in &candidates {
        let p = repo_dir.join(name);
        if let Some(content) = read_capped(&p, 8_000) {
            parts.push(format!("=== {} ===\n{}", name, content));
        }
    }

    // Nested skill definitions: <root>/.claude/skills/<name>/SKILL.md and a
    // bare <root>/skills/<name>/SKILL.md fallback. Cap the number of nested
    // files surfaced so a mega-repo can't blow up the prompt.
    for skills_root in [
        repo_dir.join(".claude").join("skills"),
        repo_dir.join("skills"),
    ] {
        collect_nested_skill_mds(&skills_root, &mut parts);
    }

    // Nested agent definitions: <root>/.claude/agents/*.md and <root>/agents/*.md.
    for agents_root in [
        repo_dir.join(".claude").join("agents"),
        repo_dir.join("agents"),
    ] {
        collect_nested_agent_mds(&agents_root, &mut parts);
    }

    if parts.is_empty() {
        "<no recognisable files found>".to_string()
    } else {
        parts.join("\n\n")
    }
}

/// Max nested skill/agent files surfaced into the analysis prompt. Keeps a
/// huge multi-skill repo from flooding the context window.
const MAX_NESTED_FILES: usize = 12;

/// Read each `<root>/<name>/SKILL.md`, appending up to `MAX_NESTED_FILES`
/// entries to `parts`. No-op when `root` is not a directory.
fn collect_nested_skill_mds(root: &Path, parts: &mut Vec<String>) {
    if !root.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if parts.len() >= MAX_NESTED_FILES {
            break;
        }
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let skill_md = dir.join("SKILL.md");
        if let Some(content) = read_capped(&skill_md, 4_000) {
            let label = dir.file_name().and_then(|s| s.to_str()).unwrap_or("skill");
            parts.push(format!("=== skills/{}/SKILL.md ===\n{}", label, content));
        }
    }
}

/// Read each `<root>/*.md` agent file, appending up to `MAX_NESTED_FILES`
/// entries to `parts`. No-op when `root` is not a directory.
fn collect_nested_agent_mds(root: &Path, parts: &mut Vec<String>) {
    if !root.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if parts.len() >= MAX_NESTED_FILES {
            break;
        }
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if p.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let fname = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if fname.eq_ignore_ascii_case("README.md") {
            continue;
        }
        if let Some(content) = read_capped(&p, 4_000) {
            parts.push(format!("=== agents/{} ===\n{}", fname, content));
        }
    }
}

// ---------------------------------------------------------------------------
// AI routing helpers
// ---------------------------------------------------------------------------

/// Pick the strongest available zone for the install-compatibility analysis.
///
/// The original code always routed to `code-review`, which seeds to a Light
/// (Haiku) zone — fine for quick lint passes, weak for reasoning about whether
/// an arbitrary repo is safe to install. We prefer a `code-edit` zone when it
/// exists (it seeds to a Medium codex/gpt-5 assignment), falling back to
/// `code-review` and finally to the literal `"code-review"` id when zone
/// listing fails entirely. Selection is by *configured* zones so a user who
/// reconfigured their router still gets a valid id.
fn pick_analysis_zone() -> String {
    // Strongest first. `code-edit` is Medium-class in the seed; `code-review`
    // is the safe Light-class default we keep as a fallback.
    const PREFERRED: [&str; 2] = ["code-edit", "code-review"];
    match crate::ai_router::ai_router_list_zones() {
        Ok(zones) => {
            for id in PREFERRED {
                if zones.iter().any(|z| z.id == id) {
                    return id.to_string();
                }
            }
            // No preferred zone configured — fall back to the first zone in
            // the `code` category if any, else the literal default.
            zones
                .iter()
                .find(|z| z.category == "code")
                .map(|z| z.id.clone())
                .unwrap_or_else(|| "code-review".to_string())
        }
        Err(_) => "code-review".to_string(),
    }
}

/// Read the user's current stack context from CLAUDE.md + detectable manifests.
fn collect_stack_context() -> String {
    let mut parts: Vec<String> = Vec::new();

    // Global CLAUDE.md
    if let Some(home) = dirs::home_dir() {
        let claude_md = home.join(".claude").join("CLAUDE.md");
        if let Some(content) = read_capped(&claude_md, 3_000) {
            parts.push(format!(
                "=== ~/.claude/CLAUDE.md (current stack) ===\n{}",
                content
            ));
        }
    }

    parts.join("\n\n")
}

/// Build the analysis prompt sent to the AI router.
fn build_analysis_prompt(repo_context: &str, stack_context: &str) -> String {
    format!(
        r#"You are a developer-tools install assistant. Analyse the repository below and \
decide whether it is compatible with the user's current stack.

Return ONLY a single JSON object — no markdown, no extra text — with this exact shape:
{{
  "compatible": <true|false>,
  "reason": "<one sentence explaining the decision>",
  "install_type": "<agent|skill|rules|mcp|npm|cargo|python|unknown>",
  "steps": [
    {{"cmd": "<shell command to run>", "cwd": "<working directory, may use ~>"}}
  ],
  "copy_files": [
    {{"from": "<path relative to repo root>", "to": "<absolute target path, may use ~>"}}
  ],
  "warnings": ["<optional warning messages>"]
}}

Rules:
- "steps" should only include commands that are safe and reproducible (npm install, cargo add, pip install, cp, etc.)
- "copy_files" should map agent .md files to ~/.claude/agents/, skill files to ~/.claude/skills/<name>/, rules to ~/.claude/rules/, hooks to ~/.claude/hooks/
- If the repo is incompatible (wrong language, missing deps, dangerous code), set compatible=false and explain in "reason"
- Keep "steps" and "copy_files" empty if there is nothing safe to execute
- Do NOT include git clone or cd steps — the repo is already cloned

=== CURRENT USER STACK ===
{stack_context}

=== REPOSITORY TO ANALYSE ===
{repo_context}
"#
    )
}

/// Parse the AI's raw text response into an `InstallReport`, tolerating
/// markdown code fences and leading/trailing noise.
fn parse_ai_report(raw: &str) -> Result<InstallReport, String> {
    // Strip optional ```json ... ``` fences.
    let stripped = {
        let s = raw.trim();
        let s = if let Some(inner) = s.strip_prefix("```json") {
            inner.trim_start()
        } else if let Some(inner) = s.strip_prefix("```") {
            inner.trim_start()
        } else {
            s
        };
        let s = if let Some(inner) = s.strip_suffix("```") {
            inner.trim_end()
        } else {
            s
        };
        s
    };

    // Find the first `{` and last `}` to isolate the JSON object.
    let start = stripped
        .find('{')
        .ok_or_else(|| "no JSON object in AI response".to_string())?;
    let end = stripped
        .rfind('}')
        .ok_or_else(|| "no closing } in AI response".to_string())?;
    let json_slice = &stripped[start..=end];

    serde_json::from_str::<InstallReport>(json_slice).map_err(|e| {
        format!(
            "AI report parse error: {e}\nRaw slice: {}",
            &json_slice[..json_slice.len().min(400)]
        )
    })
}

// ---------------------------------------------------------------------------
// Install execution
// ---------------------------------------------------------------------------

/// Execute the install steps from the report. Returns a list of errors
/// (non-fatal — we proceed with remaining steps and report all failures).
fn execute_steps(steps: &[InstallStep]) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    for step in steps {
        let cwd = expand_tilde(&step.cwd);
        // Shell-split the command naively: first token is the program, rest
        // are args. For complex commands (pipes, &&) we fall back to
        // spawning via `sh -c` on Unix or `cmd /C` on Windows.
        let needs_shell = step.cmd.contains("&&")
            || step.cmd.contains('|')
            || step.cmd.contains(';')
            || step.cmd.contains(">>")
            || step.cmd.contains('>');

        let result = if needs_shell {
            #[cfg(windows)]
            let mut cmd = {
                let mut c = std::process::Command::new("cmd");
                c.args(["/C", &step.cmd]);
                c
            };
            #[cfg(not(windows))]
            let mut cmd = {
                let mut c = std::process::Command::new("sh");
                c.args(["-c", &step.cmd]);
                c
            };
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            cmd.current_dir(&cwd).output()
        } else {
            let tokens: Vec<&str> = step.cmd.split_whitespace().collect();
            if tokens.is_empty() {
                continue;
            }
            let mut cmd = std::process::Command::new(tokens[0]);
            cmd.args(&tokens[1..]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            cmd.current_dir(&cwd).output()
        };

        match result {
            Ok(out) if out.status.success() => {}
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                errors.push(format!(
                    "step `{}` exited {}: {}",
                    step.cmd,
                    out.status,
                    stderr.trim()
                ));
            }
            Err(e) => {
                errors.push(format!("step `{}` spawn error: {e}", step.cmd));
            }
        }
    }
    errors
}

/// Copy files from the cloned repo to target paths.
/// Returns (installed_paths, errors).
fn execute_copies(repo_dir: &Path, copies: &[CopyFile]) -> (Vec<String>, Vec<String>) {
    let mut installed: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    for copy in copies {
        let from = repo_dir.join(&copy.from);
        let to = expand_tilde(&copy.to);

        // Security: reject absolute `from` paths that escape the repo dir.
        if copy.from.starts_with('/') || copy.from.starts_with('\\') || copy.from.contains("..") {
            errors.push(format!("rejected unsafe from-path: {}", copy.from));
            continue;
        }

        if !from.exists() {
            errors.push(format!("source not found: {}", from.display()));
            continue;
        }

        if let Some(parent) = to.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                errors.push(format!("mkdir {}: {e}", parent.display()));
                continue;
            }
        }

        let copy_result = if from.is_dir() {
            copy_dir_recursive(&from, &to)
        } else {
            std::fs::copy(&from, &to)
                .map(|_| ())
                .map_err(|e| format!("copy {} -> {}: {e}", from.display(), to.display()))
        };

        match copy_result {
            Ok(()) => installed.push(to.display().to_string()),
            Err(e) => errors.push(e),
        }
    }

    (installed, errors)
}

/// Recursively copy a directory.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("readdir {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let ty = entry.file_type().map_err(|e| format!("filetype: {e}"))?;
        let dest_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), &dest_path).map_err(|e| format!("copy: {e}"))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/// Main entry point for AI-driven install.
pub async fn install_via_ai_inner(
    repo_url: String,
    _target_scope: TargetScope,
    dry_run: bool,
) -> Result<AiInstallResult, String> {
    // --- Step 1: parse GitHub URL ---
    let (owner, repo_name) = parse_github_slug(&repo_url)
        .ok_or_else(|| format!("could not parse GitHub URL: {repo_url}"))?;

    // --- Step 2: prepare temp dir ---
    let temp_base = ultron_root()?.join("cockpit").join("temp-install");
    let dir_name = format!(
        "{}-{}",
        sanitize_dir_name(&owner),
        sanitize_dir_name(&repo_name)
    );
    let temp_dir = temp_base.join(&dir_name);

    // Remove stale temp dir from a previous failed install, if any.
    if temp_dir.exists() {
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("create temp dir: {e}"))?;

    // --- Step 3: clone ---
    if let Err(e) = clone_repo(&owner, &repo_name, &temp_dir) {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(e);
    }

    // --- Step 4: collect context ---
    let repo_context = collect_repo_context(&temp_dir);
    let stack_context = collect_stack_context();
    let prompt = build_analysis_prompt(&repo_context, &stack_context);

    // --- Step 5: call AI router ---
    // Route to the strongest available analysis zone (code-edit > code-review)
    // so the compatibility judgement uses a stronger model when one exists.
    let analysis_zone = pick_analysis_zone();
    let ai_text = match crate::ai_router::route(&analysis_zone, &prompt) {
        Ok(text) => text,
        Err(router_err) => {
            // Fallback: AI not available — return without a report so the
            // UI can offer the clipboard fallback.
            let _ = std::fs::remove_dir_all(&temp_dir);
            return Ok(AiInstallResult {
                ai_available: false,
                report: None,
                executed: false,
                installed_paths: vec![],
                errors: vec![format!("AI Router unavailable: {router_err}")],
            });
        }
    };

    // --- Step 6: parse report ---
    let report = match parse_ai_report(&ai_text) {
        Ok(r) => r,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&temp_dir);
            return Err(format!(
                "AI response could not be parsed as InstallReport: {e}"
            ));
        }
    };

    // --- Step 7: abort if incompatible ---
    if !report.compatible {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Ok(AiInstallResult {
            ai_available: true,
            report: Some(report),
            executed: false,
            installed_paths: vec![],
            errors: vec![],
        });
    }

    // --- Step 8: dry-run returns here with the plan but doesn't execute ---
    if dry_run {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Ok(AiInstallResult {
            ai_available: true,
            report: Some(report),
            executed: false,
            installed_paths: vec![],
            errors: vec![],
        });
    }

    // --- Step 9: execute steps + copies ---
    let step_errors = execute_steps(&report.steps);
    let (installed_paths, copy_errors) = execute_copies(&temp_dir, &report.copy_files);

    let _ = std::fs::remove_dir_all(&temp_dir);

    let mut all_errors: Vec<String> = step_errors;
    all_errors.extend(copy_errors);
    all_errors.extend(report.warnings.clone());

    Ok(AiInstallResult {
        ai_available: true,
        report: Some(report),
        executed: true,
        installed_paths,
        errors: all_errors,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_github_slug_standard_url() {
        let (o, r) = parse_github_slug("https://github.com/foo/bar-baz").unwrap();
        assert_eq!(o, "foo");
        assert_eq!(r, "bar-baz");
    }

    #[test]
    fn parse_github_slug_git_suffix() {
        let (o, r) = parse_github_slug("https://github.com/foo/bar.git").unwrap();
        assert_eq!(o, "foo");
        assert_eq!(r, "bar");
    }

    #[test]
    fn parse_github_slug_rejects_invalid() {
        assert!(parse_github_slug("not-a-url").is_none());
        assert!(parse_github_slug("https://github.com/onlyone").is_none());
    }

    #[test]
    fn sanitize_dir_name_replaces_dots_and_slashes() {
        assert_eq!(sanitize_dir_name("foo.bar/baz"), "foo_bar_baz");
    }

    #[test]
    fn parse_ai_report_valid_json() {
        let raw = r#"{"compatible":true,"reason":"ok","steps":[],"copy_files":[],"warnings":[],"install_type":"agent"}"#;
        let r = parse_ai_report(raw).unwrap();
        assert!(r.compatible);
        assert_eq!(r.install_type, "agent");
    }

    #[test]
    fn parse_ai_report_strips_markdown_fence() {
        let raw =
            "```json\n{\"compatible\":false,\"reason\":\"nope\",\"install_type\":\"unknown\"}\n```";
        let r = parse_ai_report(raw).unwrap();
        assert!(!r.compatible);
    }

    #[test]
    fn parse_ai_report_tolerates_trailing_prose() {
        let raw = "Here is the analysis:\n{\"compatible\":true,\"reason\":\"fine\",\"install_type\":\"skill\"}\nDone.";
        let r = parse_ai_report(raw).unwrap();
        assert!(r.compatible);
    }

    #[test]
    fn expand_tilde_home() {
        let p = expand_tilde("~/foo/bar");
        assert!(p.to_string_lossy().contains("foo"));
        assert!(!p.to_string_lossy().starts_with('~'));
    }

    #[test]
    fn collect_repo_context_reads_nested_skill_and_agent_files() {
        // Build a temp repo whose payload lives ONLY in nested
        // .claude/skills/<name>/SKILL.md and .claude/agents/<name>.md — the
        // exact deep layout the old top-level-only reader missed.
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();

        let skill_dir = root.join(".claude").join("skills").join("my-skill");
        std::fs::create_dir_all(&skill_dir).expect("mkdir skill");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: my-skill\ndescription: nested skill payload\n---\nBODY",
        )
        .expect("write skill md");

        let agents_dir = root.join(".claude").join("agents");
        std::fs::create_dir_all(&agents_dir).expect("mkdir agents");
        std::fs::write(
            agents_dir.join("my-agent.md"),
            "---\nname: my-agent\ndescription: nested agent payload\n---\nROLE",
        )
        .expect("write agent md");
        // README under agents must be skipped.
        std::fs::write(agents_dir.join("README.md"), "ignore me").expect("write readme");

        let ctx = collect_repo_context(root);
        assert!(
            ctx.contains("skills/my-skill/SKILL.md"),
            "nested skill should be surfaced: {ctx}"
        );
        assert!(ctx.contains("nested skill payload"));
        assert!(
            ctx.contains("agents/my-agent.md"),
            "nested agent should be surfaced: {ctx}"
        );
        assert!(ctx.contains("nested agent payload"));
        assert!(
            !ctx.contains("ignore me"),
            "agents/README.md must be skipped"
        );
    }

    #[test]
    fn pick_analysis_zone_returns_nonempty() {
        // Must always return a usable zone id (never empty) even if the
        // router config is missing on the test box.
        let zone = pick_analysis_zone();
        assert!(!zone.is_empty());
    }
}
