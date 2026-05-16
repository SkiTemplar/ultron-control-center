// ULTRON Control Center — version drift probe.
//
// Detects when key version-stamped files lag behind the canonical version
// in CHANGELOG.md. Surfaced as a Doctor row so the user sees drift in the
// same Dashboard glance they already do for Qdrant / Brain / Hooks / etc.
//
// Canonical version: top-most `## v<semver>` heading in CHANGELOG.md.
//
// Files monitored (whitelisted — adding more is one new VersionCheck row):
//   - control-center/src-tauri/Cargo.toml         (TOML `version = "x.y.z"`)
//   - control-center/src-tauri/tauri.conf.json    (JSON `"version": "x.y.z"`)
//   - control-center/package.json                  (JSON `"version": "x.y.z"`)
//   - ~/.claude/skills/ultron/SKILL.md             (YAML frontmatter `version: vx.y.z`)
//   - SYSTEM-MAP.md                                (line containing `SSOT version: v...`)
//
// Auto-fix: `auto-fixes/refresh-versions.ps1` writes all five files to the
// current version + bumps `last_verified`. Triggered from the Doctor row's
// fix-it button.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;

#[derive(Debug, Clone, Eq, PartialEq, PartialOrd, Ord)]
struct Version {
    major: u32,
    minor: u32,
    patch: u32,
}

impl Version {
    fn parse(raw: &str) -> Option<Self> {
        let s = raw.trim().trim_start_matches('v');
        let mut parts = s.split('.');
        Some(Version {
            major: parts.next()?.parse().ok()?,
            minor: parts.next()?.parse().ok()?,
            patch: parts.next()?.parse().ok()?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DriftFinding {
    pub label: String,
    pub path: String,
    pub found: Option<String>,
    pub current: String,
    pub drift: Option<String>,
}

enum VersionFormat {
    Frontmatter,
    TomlKey,
    JsonKey,
    SystemMap,
}

struct VersionCheck {
    label: &'static str,
    path: PathBuf,
    format: VersionFormat,
}

fn parse_changelog_latest(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        // Match "## v15.3.4" or "## [15.3.4]"
        if let Some(rest) = trimmed.strip_prefix("## v") {
            let ver = rest.split_whitespace().next()?.trim_matches('—').trim();
            return Some(format!("v{}", ver));
        }
        if let Some(rest) = trimmed.strip_prefix("## [") {
            let end = rest.find(']')?;
            return Some(format!("v{}", &rest[..end]));
        }
    }
    None
}

fn parse_frontmatter_version(text: &str) -> Option<String> {
    let mut in_fm = false;
    for line in text.lines() {
        let t = line.trim();
        if t == "---" {
            if in_fm { break; }
            in_fm = true;
            continue;
        }
        if in_fm && t.starts_with("version:") {
            return t
                .split_once(':')
                .map(|(_, v)| v.trim().trim_matches('"').trim_matches('\'').to_string());
        }
    }
    None
}

fn parse_toml_version(text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("version") {
            let rest = rest.trim_start_matches(|c: char| c == ' ' || c == '=');
            let cleaned = rest.trim().trim_matches('"').trim_matches('\'');
            if !cleaned.is_empty() {
                return Some(cleaned.to_string());
            }
        }
    }
    None
}

fn parse_json_version(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    v.get("version")?.as_str().map(|s| s.to_string())
}

fn parse_system_map_version(text: &str) -> Option<String> {
    for line in text.lines() {
        if let Some(idx) = line.find("SSOT version:") {
            let rest = &line[idx + "SSOT version:".len()..];
            let ver = rest.split_whitespace().next()?;
            return Some(ver.trim_start_matches('v').to_string());
        }
    }
    None
}

fn drift_label(found: &Version, current: &Version) -> String {
    let dmajor = current.major.saturating_sub(found.major);
    let dminor = current.minor.saturating_sub(found.minor);
    let dpatch = current.patch.saturating_sub(found.patch);
    if dmajor > 0 {
        format!("{} major behind", dmajor)
    } else if dminor > 0 {
        format!("{} minor + {} patch behind", dminor, dpatch)
    } else {
        format!("{} patch behind", dpatch)
    }
}

pub struct DriftReport {
    pub current: String,
    pub findings: Vec<DriftFinding>,
}

pub fn scan_inner() -> Result<DriftReport, String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let ultron = home.join(".ultron");
    let claude = home.join(".claude");

    let changelog = ultron.join("CHANGELOG.md");
    let current_raw = fs::read_to_string(&changelog)
        .ok()
        .and_then(|s| parse_changelog_latest(&s))
        .ok_or_else(|| format!("could not parse CHANGELOG.md at {}", changelog.display()))?;
    let current = Version::parse(&current_raw)
        .ok_or_else(|| format!("malformed canonical version: {}", current_raw))?;

    let checks = vec![
        VersionCheck {
            label: "Cargo.toml",
            path: ultron.join("control-center/src-tauri/Cargo.toml"),
            format: VersionFormat::TomlKey,
        },
        VersionCheck {
            label: "tauri.conf.json",
            path: ultron.join("control-center/src-tauri/tauri.conf.json"),
            format: VersionFormat::JsonKey,
        },
        VersionCheck {
            label: "package.json",
            path: ultron.join("control-center/package.json"),
            format: VersionFormat::JsonKey,
        },
        VersionCheck {
            label: "ULTRON skill",
            path: claude.join("skills/ultron/SKILL.md"),
            format: VersionFormat::Frontmatter,
        },
        VersionCheck {
            label: "SYSTEM-MAP.md",
            path: ultron.join("SYSTEM-MAP.md"),
            format: VersionFormat::SystemMap,
        },
    ];

    let mut findings = Vec::new();
    for check in checks {
        let text = match fs::read_to_string(&check.path) {
            Ok(s) => s,
            Err(_) => {
                findings.push(DriftFinding {
                    label: check.label.into(),
                    path: check.path.display().to_string(),
                    found: None,
                    current: current_raw.clone(),
                    drift: Some("file missing".into()),
                });
                continue;
            }
        };
        let found_raw = match check.format {
            VersionFormat::Frontmatter => parse_frontmatter_version(&text),
            VersionFormat::TomlKey => parse_toml_version(&text),
            VersionFormat::JsonKey => parse_json_version(&text),
            VersionFormat::SystemMap => parse_system_map_version(&text),
        };
        let Some(found_raw) = found_raw else {
            findings.push(DriftFinding {
                label: check.label.into(),
                path: check.path.display().to_string(),
                found: None,
                current: current_raw.clone(),
                drift: Some("no parseable version".into()),
            });
            continue;
        };
        if let Some(found) = Version::parse(&found_raw) {
            if found < current {
                findings.push(DriftFinding {
                    label: check.label.into(),
                    path: check.path.display().to_string(),
                    found: Some(found_raw),
                    current: current_raw.clone(),
                    drift: Some(drift_label(&found, &current)),
                });
            }
        }
    }
    Ok(DriftReport {
        current: current_raw,
        findings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_changelog_v_prefix() {
        let s = "# Changelog\n\n## v15.3.4 — 2026-05-17\n\nstuff";
        assert_eq!(parse_changelog_latest(s), Some("v15.3.4".into()));
    }

    #[test]
    fn parses_changelog_bracket() {
        let s = "## [15.3.4] - 2026-05-17";
        assert_eq!(parse_changelog_latest(s), Some("v15.3.4".into()));
    }

    #[test]
    fn parses_frontmatter() {
        let md = "---\nname: foo\nversion: v15.3.4\n---\nbody";
        assert_eq!(parse_frontmatter_version(md), Some("v15.3.4".into()));
    }

    #[test]
    fn parses_toml() {
        let toml = "[package]\nname = \"foo\"\nversion = \"15.3.4\"\n";
        assert_eq!(parse_toml_version(toml), Some("15.3.4".into()));
    }

    #[test]
    fn version_compare() {
        let a = Version::parse("15.2.39").unwrap();
        let b = Version::parse("15.3.4").unwrap();
        assert!(a < b);
    }
}
