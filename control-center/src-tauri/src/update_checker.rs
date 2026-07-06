// ULTRON Control Center — lightweight GitHub-release update checker.
//
// Background: the Tauri-native auto-updater plugin is wired but inactive
// (no Ed25519 signing infra yet — see tauri.conf.json `plugins.updater`).
// This module sidesteps the chicken-and-egg by hitting the public GitHub
// releases API directly and surfacing a banner on the frontend. The user
// confirms an update from the banner; rebuild runs through
// `run_app_lifecycle("update")` which is the same path Settings → App
// lifecycle uses today, so we don't add a second install surface.
//
// VERSION SCHEMES (2026-07-06): the release TAG uses the monorepo line
// (v15.x, pyproject SSOT) while the app itself is versioned on its own
// decoupled 2.x line (CC_TARGETS). Comparing CARGO_PKG_VERSION against the
// tag is comparing apples to oranges — the first published release
// (v15.6.0, app 2.7.1) made the banner scream "15.6.0 is out, you have
// 2.7.1" at an app NEWER than the release. We now extract the app version
// from the installer ASSET name (`ULTRON.Control.Center_<ver>_x64-setup.exe`)
// and compare same-scheme.
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
    /// Control Center version of the latest release, extracted from the
    /// installer asset name (same 2.x scheme as `current_version`; NOT the
    /// monorepo release tag). `None` when the request fails or the release
    /// has no parseable installer — keep the banner silent either way.
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
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
}

/// Extract the Control Center version from the Windows installer asset name
/// (`ULTRON.Control.Center_2.7.1_x64-setup.exe` / `..._x64_en-US.msi`).
/// GitHub replaces spaces with dots in asset names; the version is always the
/// `_`-delimited segment right after the product name.
fn cc_version_from_assets(assets: &[GitHubAsset]) -> Option<String> {
    for asset in assets {
        if !(asset.name.ends_with("-setup.exe") || asset.name.ends_with(".msi")) {
            continue;
        }
        for seg in asset.name.split('_') {
            let looks_semver = {
                let mut dots = 0;
                seg.chars().all(|c| {
                    if c == '.' {
                        dots += 1;
                        true
                    } else {
                        c.is_ascii_digit()
                    }
                }) && dots == 2
            };
            if looks_semver && !seg.is_empty() {
                return Some(seg.to_string());
            }
        }
    }
    None
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
            // Ignore drafts and prereleases — the maintainer's release flow goes
            // straight to stable, but if that ever changes we still won't
            // notify on a draft tag.
            if rel.draft || rel.prerelease {
                return info;
            }
            // Same-scheme comparison: app 2.x vs the installer asset's 2.x.
            // The tag (monorepo 15.x) is NOT comparable to the app version.
            match cc_version_from_assets(&rel.assets) {
                Some(latest_cc) => {
                    info.has_update = semver_gt(&current, &latest_cc);
                    info.latest_version = Some(latest_cc);
                }
                None => {
                    // No parseable installer asset: stay silent rather than
                    // lie. Surface why in `error` (tooltip, never a banner).
                    info.error = Some(format!(
                        "release {} has no parseable Control Center installer asset",
                        rel.tag_name
                    ));
                }
            }
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
    fn semver_gt_handles_suffix() {
        assert!(semver_gt("15.4.0", "15.4.1-rc1"));
        assert!(!semver_gt("15.4.1", "15.4.1-rc1"));
    }

    fn asset(name: &str) -> GitHubAsset {
        GitHubAsset { name: name.into() }
    }

    #[test]
    fn cc_version_extracted_from_real_v15_6_0_assets() {
        // Exact asset names published in release v15.6.0 (2026-07-06).
        let assets = vec![
            asset("ultron-memory-windows-x64.exe"),
            asset("ultron-system-v15.6.0.zip"),
            asset("ULTRON.Control.Center_2.7.1_x64-setup.exe"),
            asset("ULTRON.Control.Center_2.7.1_x64_en-US.msi"),
        ];
        assert_eq!(cc_version_from_assets(&assets).as_deref(), Some("2.7.1"));
    }

    #[test]
    fn no_installer_asset_means_none_not_a_lie() {
        // Caso negativo: release sin instalador parseable -> None (el
        // checker se queda callado en vez de inventarse un update).
        let assets = vec![
            asset("ultron-system-v15.6.0.zip"),
            asset("ultron-memory-linux-x64"),
        ];
        assert_eq!(cc_version_from_assets(&assets), None);
        assert_eq!(cc_version_from_assets(&[]), None);
    }

    #[test]
    fn same_cc_version_is_not_an_update() {
        // El bug real del 2026-07-06: app 2.7.1 vs tag v15.6.0 gritaba
        // update. Mismo esquema: 2.7.1 vs 2.7.1 -> silencio.
        assert!(!semver_gt("2.7.1", "2.7.1"));
        // Y un bump real del CC si dispara:
        assert!(semver_gt("2.7.1", "2.7.2"));
    }
}
