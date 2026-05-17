// ULTRON Control Center — lightweight GitHub-release update checker.
//
// Background: the Tauri-native auto-updater plugin is wired but inactive
// (no Ed25519 signing infra yet — see tauri.conf.json `plugins.updater`).
// This module sidesteps the chicken-and-egg by hitting the public GitHub
// releases API directly, comparing the latest tag to the bundled
// `CARGO_PKG_VERSION`, and surfacing a banner on the frontend. The user
// confirms an update from the banner; rebuild runs through
// `run_app_lifecycle("update")` which is the same path Settings → App
// lifecycle uses today, so we don't add a second install surface.
//
// What this is NOT:
//   - It does not download or install binaries. The actual upgrade goes
//     through `git pull + npm install + npm run tauri build` in a new
//     visible console (so the user can spot failures in real time). For
//     a true silent binary install we need signed releases (see
//     RELEASE-PROCESS.md). This is the safe middle path until we have
//     that.
//   - It does not run on a timer. It fires once on startup (after a
//     short delay so the window paints first) and only on demand
//     thereafter.

use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    /// `true` if `latest_version > current_version` semver-wise.
    pub has_update: bool,
    /// Bundled Cargo `version` of the running app (no leading `v`).
    pub current_version: String,
    /// Release tag from GitHub (no leading `v`). `None` when the request
    /// fails — keep the banner silent on transient network errors.
    pub latest_version: Option<String>,
    /// HTML URL of the release (or repo releases page on fallback).
    pub release_url: String,
    /// ISO-8601 publish timestamp (best-effort, mirrored from GitHub).
    pub published_at: Option<String>,
    /// Short human-readable error when the check failed (only set when
    /// `latest_version` is `None`). The frontend may surface this in a
    /// tooltip but should not show the banner on error.
    pub error: Option<String>,
}

const REPO_OWNER: &str = "SkiTemplar";
const REPO_NAME: &str = "ultron";
const RELEASES_URL: &str = "https://github.com/SkiTemplar/ultron/releases";

fn api_url() -> String {
    format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        REPO_OWNER, REPO_NAME
    )
}

fn strip_v(s: &str) -> &str {
    s.strip_prefix('v').unwrap_or(s)
}

/// Tiny semver comparator. Only handles MAJOR.MINOR.PATCH; ignores any
/// `-pre` / `+build` suffix. Returns `true` when `b > a`.
fn semver_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> (u32, u32, u32) {
        let core = s.split(['-', '+']).next().unwrap_or(s);
        let mut it = core.split('.').map(|x| x.parse::<u32>().unwrap_or(0));
        (
            it.next().unwrap_or(0),
            it.next().unwrap_or(0),
            it.next().unwrap_or(0),
        )
    };
    let (a1, a2, a3) = parse(a);
    let (b1, b2, b3) = parse(b);
    (b1, b2, b3) > (a1, a2, a3)
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: Option<String>,
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// Fire the actual HTTP request. Returns the parsed release on success;
/// callers turn the error into an `UpdateInfo { error: Some(_), .. }`.
fn fetch_latest() -> Result<GitHubRelease, String> {
    let req = ureq::get(&api_url())
        .timeout(Duration::from_secs(8))
        // GitHub returns 403 without a User-Agent. The string is
        // informational, not parsed.
        .set(
            "User-Agent",
            &format!("ultron-control-center/{}", env!("CARGO_PKG_VERSION")),
        )
        .set("Accept", "application/vnd.github+json");
    let resp = req.call().map_err(|e| format!("http: {}", e))?;
    resp.into_json::<GitHubRelease>()
        .map_err(|e| format!("parse: {}", e))
}

pub fn check_for_updates_inner() -> UpdateInfo {
    let current = env!("CARGO_PKG_VERSION").to_string();

    let mut info = UpdateInfo {
        has_update: false,
        current_version: current.clone(),
        latest_version: None,
        release_url: RELEASES_URL.to_string(),
        published_at: None,
        error: None,
    };

    match fetch_latest() {
        Ok(rel) => {
            // Ignore drafts and prereleases — USER's release flow goes
            // straight to stable, but if that ever changes we still won't
            // notify on a draft tag.
            if rel.draft || rel.prerelease {
                return info;
            }
            let latest = strip_v(&rel.tag_name).to_string();
            info.has_update = semver_gt(&current, &latest);
            info.latest_version = Some(latest);
            if let Some(url) = rel.html_url {
                info.release_url = url;
            }
            info.published_at = rel.published_at;
        }
        Err(e) => {
            info.error = Some(e);
        }
    }
    info
}

#[tauri::command]
pub fn check_for_updates() -> UpdateInfo {
    check_for_updates_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_gt_basic() {
        assert!(semver_gt("15.4.0", "15.4.1"));
        assert!(semver_gt("15.3.4", "15.4.0"));
        assert!(semver_gt("14.9.9", "15.0.0"));
        assert!(!semver_gt("15.4.1", "15.4.0"));
        assert!(!semver_gt("15.4.1", "15.4.1"));
    }

    #[test]
    fn semver_gt_handles_prefix_and_suffix() {
        // strip_v is applied at the call site; the comparator itself
        // must still tolerate prerelease suffixes.
        assert!(semver_gt("15.4.0", "15.4.1-rc1"));
        assert!(!semver_gt("15.4.1", "15.4.1-rc1"));
    }

    #[test]
    fn strip_v_works() {
        assert_eq!(strip_v("v15.4.1"), "15.4.1");
        assert_eq!(strip_v("15.4.1"), "15.4.1");
    }
}
