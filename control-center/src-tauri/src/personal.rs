// ULTRON Control Center — Personal section.
//
// Stores a free-form profile note at ~/.ultron/personal/profile.md that
// ULTRON skills can pull as context. Designed to capture writing patterns,
// preferences, recurring routines — anything the user wants the system to
// learn over time without having to re-prompt manually.
//
// Backups are kept under .../profile.backups/<ts>.md so we never lose
// previous versions; the in-memory representation is just text.

use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
pub struct PersonalProfile {
    pub path: String,
    pub content: String,
    pub last_modified: Option<String>,
    pub size_bytes: u64,
    /// True when the content returned is the in-memory seed template
    /// (file missing, empty, or below the "looks unedited" threshold).
    /// The UI uses this to show a "this is a template" banner.
    pub seeded: bool,
}

/// Structured fingerprint of *how* the user writes — tone, register,
/// code-switching, typos, etc. Intentionally optional so analyses generated
/// before this struct existed still parse: missing fields default to empty
/// strings / empty vecs / 0.
#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct WritingStyle {
    #[serde(default)]
    pub tone: String,
    #[serde(default)]
    pub primary_language: String,
    #[serde(default)]
    pub code_switching: String,
    #[serde(default)]
    pub characteristic_phrases: Vec<String>,
    #[serde(default)]
    pub typo_patterns: Vec<String>,
    #[serde(default)]
    pub formatting_habits: String,
    #[serde(default)]
    pub average_message_length_chars: u32,
    #[serde(default)]
    pub punctuation_quirks: String,
}

/// "What ULTRON knows about you" — the auto-generated mirror that lives
/// next to `profile.md` and is composed by a Claude session reading
/// transcripts, commits and MEMORY.md. The UI shows this read-only on the
/// left side of the Personal tab; the right side is the editable profile.
///
/// The struct is intentionally permissive on deserialize so a partially
/// written `known.json` (e.g. Claude wrote half the fields) doesn't blow
/// up the whole tab.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct PersonalKnown {
    #[serde(default)]
    pub style_fingerprint: String,
    /// New in v15.1.2: detailed style fields. Older `known.json` files that
    /// only have `style_fingerprint` keep working — `writing_style` will
    /// just deserialize as `WritingStyle::default()` until the next
    /// analysis overwrites the file.
    #[serde(default)]
    pub writing_style: WritingStyle,
    #[serde(default)]
    pub recent_topics: Vec<String>,
    #[serde(default)]
    pub routines: Vec<String>,
    #[serde(default)]
    pub last_updated: Option<String>,
    #[serde(default)]
    pub source: String,
}

fn profile_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/personal/profile.md"))
}

fn backups_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/personal/profile.backups"))
}

fn known_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/personal/known.json"))
}

fn personal_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/personal"))
}

fn last_sample_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/personal/last-sample.md"))
}

fn iso_from_systime(t: SystemTime) -> Option<String> {
    let secs = t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    let mut days = (secs / 86_400) as i64;
    let secs_in_day = (secs % 86_400) as u32;
    let h = secs_in_day / 3600;
    let m = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;
    let mut year = 1970i32;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let yd: i64 = if leap { 366 } else { 365 };
        if days < yd { break; }
        days -= yd;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mdays: [i64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] { days -= mdays[month]; month += 1; }
    Some(format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month + 1, days + 1, h, m, s))
}

/// Seed template returned (in memory, NOT written to disk) when
/// `profile.md` is missing or looks unedited. The UI shows a banner so
/// the user knows what they're seeing is a starter — once they hit Save
/// the real file is written and the banner disappears on the next read.
const DEFAULT_TEMPLATE: &str = r#"# Mi perfil

## Quien soy
(rol profesional, intereses principales, dominios donde paso mas tiempo)

## Cómo trabajo
(stack favorito, horario, herramientas, anti-patrones que evito)

## Cómo me gusta que ULTRON me hable
(tono, nivel de detalle por defecto, cuándo prefiero brief vs. expansivo)

## Lo que NO quiero que haga el sistema
(things to never auto-launch, paths off-limits, etc.)

## Notas personales libres
"#;

/// Below this many bytes the file is treated as "still the template" and
/// the seed is returned with `seeded: true` instead. Tuned just above the
/// length of an empty-section template so an actually-filled-in profile
/// (even a terse one) is never flagged.
const PROFILE_SEEDED_THRESHOLD_BYTES: u64 = 50;

pub fn read_personal_profile_inner() -> Result<PersonalProfile, String> {
    let path = profile_path().ok_or_else(|| "no HOME".to_string())?;

    // Missing file → return the template in memory, do NOT write to disk.
    // The user will write the file the first time they hit Save.
    if !path.exists() {
        return Ok(PersonalProfile {
            path: path.to_string_lossy().to_string(),
            content: DEFAULT_TEMPLATE.to_string(),
            last_modified: None,
            size_bytes: 0,
            seeded: true,
        });
    }

    let content = fs::read_to_string(&path).map_err(|e| format!("read: {}", e))?;
    let meta = fs::metadata(&path).map_err(|e| format!("metadata: {}", e))?;
    let size = meta.len();

    // File exists but is suspiciously small → user never really edited it.
    // Show the new template instead so they get a useful starting point.
    if size < PROFILE_SEEDED_THRESHOLD_BYTES {
        return Ok(PersonalProfile {
            path: path.to_string_lossy().to_string(),
            content: DEFAULT_TEMPLATE.to_string(),
            last_modified: meta.modified().ok().and_then(iso_from_systime),
            size_bytes: size,
            seeded: true,
        });
    }

    Ok(PersonalProfile {
        path: path.to_string_lossy().to_string(),
        content,
        last_modified: meta.modified().ok().and_then(iso_from_systime),
        size_bytes: size,
        seeded: false,
    })
}

pub fn save_personal_profile_inner(content: String) -> Result<PersonalProfile, String> {
    let path = profile_path().ok_or_else(|| "no HOME".to_string())?;
    let backups = backups_dir().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    fs::create_dir_all(&backups).map_err(|e| format!("mkdir backups: {}", e))?;

    // Backup current version before overwriting.
    if path.exists() {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup = backups.join(format!("profile-{}.md", now_secs));
        let _ = fs::copy(&path, &backup);
        // Rotate: keep the last 30 backups.
        if let Ok(entries) = fs::read_dir(&backups) {
            let mut files: Vec<(SystemTime, PathBuf)> = entries
                .flatten()
                .filter_map(|e| {
                    let p = e.path();
                    let m = e.metadata().ok()?.modified().ok()?;
                    Some((m, p))
                })
                .collect();
            files.sort_by(|a, b| b.0.cmp(&a.0));
            for (_, p) in files.into_iter().skip(30) {
                let _ = fs::remove_file(p);
            }
        }
    }

    // Atomic write.
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, content.as_bytes()).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;

    read_personal_profile_inner()
}

/// Read the JSON mirror of "what ULTRON knows about you". When the file is
/// missing we return an empty struct with `last_updated: None` so the UI
/// can render the empty-state message — we deliberately do NOT invent any
/// content, that's Claude's job once the user clicks the generate button.
pub fn read_personal_known_inner() -> Result<PersonalKnown, String> {
    let path = known_path().ok_or_else(|| "no HOME".to_string())?;
    if !path.exists() {
        return Ok(PersonalKnown::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read known: {}", e))?;
    let parsed: PersonalKnown = serde_json::from_str(&raw)
        .map_err(|e| format!("parse known.json: {}", e))?;
    Ok(parsed)
}

/// Spawn a Claude session in `~/.ultron/personal/` with a token-efficient
/// prompt that tells Claude to compose `known.json` from transcripts,
/// recent commits and MEMORY.md. We just open the terminal — the user
/// presses Refresh on the UI after Claude finishes writing the file.
pub async fn request_personal_analysis_inner(
    app: &tauri::AppHandle,
) -> Result<String, String> {
    let dir = personal_dir().ok_or_else(|| "no HOME".to_string())?;
    // Ensure the directory exists so Claude's session starts in a valid
    // cwd even on a fresh install.
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir personal: {}", e))?;

    let cwd = dir.to_string_lossy().to_string();
    let known = known_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "~/.ultron/personal/known.json".to_string());

    let prompt = format!(
        "You are analyzing the user's conversations and writing samples to build a \
style fingerprint stored at ~/.ultron/personal/known.json.\n\n\
Read up to 30 most recent JSONL files in ~/.claude/projects/C--Users-<user>--ultron/ \
(skip auto-generated/system messages). Read MEMORY.md. Read ~/.ultron/MEMORY.md. \
Read recent commits via `git log --pretty=format:\"%s%n%b\" -n 30`.\n\n\
Output JSON with this exact shape (no other fields, no fences):\n\n\
{{\n\
  \"style_fingerprint\": \"<a paragraph describing tone, formality, register, code-switching (Spanish/English), common opening/closing phrases, sentence rhythm, how the user expresses frustration vs satisfaction vs urgency>\",\n\
  \"writing_style\": {{\n\
    \"tone\": \"<concise / verbose / blunt / diplomatic — pick one or two>\",\n\
    \"primary_language\": \"<es / en / mixed>\",\n\
    \"code_switching\": \"<how often and when does the user switch ES->EN or EN->ES — name the triggers (tech terms? frustration? quotes?)>\",\n\
    \"characteristic_phrases\": [\"...\", \"...\", \"...\"],\n\
    \"typo_patterns\": [\"...\", \"...\"],\n\
    \"formatting_habits\": \"<uses markdown? bullets? CAPS for emphasis? em-dashes? emojis (explicit count — should be ~0 based on the no-emoji rule)?>\",\n\
    \"average_message_length_chars\": <integer>,\n\
    \"punctuation_quirks\": \"<e.g., uses ... a lot, or commas everywhere, or no question marks>\"\n\
  }},\n\
  \"recent_topics\": [\"...\", \"...\", \"...\"],\n\
  \"routines\": [\"...\", \"...\"],\n\
  \"last_updated\": \"<ISO 8601 timestamp now>\",\n\
  \"source\": \"claude-analysis-v2\"\n\
}}\n\n\
Hard rules:\n\
- Do NOT invent. If you can't extract a field with confidence, set it to \"(unknown — needs more data)\".\n\
- Read at most 50 lines per file to keep token usage bounded.\n\
- Output JSON only, no prose, no fences.\n\
- Total content < 3 KB.\n\n\
When done, write the JSON to {} (overwrite). Then exit.",
        known
    );

    crate::sessions::spawn_session_inner(
        app,
        "claude".to_string(),
        Some(prompt),
        Some(cwd),
        None,
    )
    .await?;
    Ok("Claude session abierta".to_string())
}

// ---------------------------------------------------------------------------
// v15.1.6 Personal redesign — style training + sample generation.
// ---------------------------------------------------------------------------

/// Read the last generated style sample (~300 words mirroring the user's
/// voice) from `~/.ultron/personal/last-sample.md`. Returns an empty string
/// if the file does not exist yet — the UI shows an empty-state message.
#[derive(Debug, Serialize, Clone)]
pub struct PersonalSample {
    pub path: String,
    pub content: String,
    pub last_modified: Option<String>,
    pub exists: bool,
}

pub fn read_personal_sample_inner() -> Result<PersonalSample, String> {
    let path = last_sample_path().ok_or_else(|| "no HOME".to_string())?;
    if !path.exists() {
        return Ok(PersonalSample {
            path: path.to_string_lossy().to_string(),
            content: String::new(),
            last_modified: None,
            exists: false,
        });
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("read sample: {}", e))?;
    let meta = fs::metadata(&path).map_err(|e| format!("metadata sample: {}", e))?;
    Ok(PersonalSample {
        path: path.to_string_lossy().to_string(),
        content,
        last_modified: meta.modified().ok().and_then(iso_from_systime),
        exists: true,
    })
}

/// Spawn a Codex session pre-loaded with the user's writing sample and the
/// current `known.json`, instructing Codex to merge the new evidence into an
/// updated `known.json`. The session opens in `~/.ultron/personal/`; the
/// user reviews Codex's plan and confirms the write. `paste_only: true` so
/// the long prompt arrives via clipboard and is not auto-submitted.
pub async fn train_personal_style_inner(
    app: &tauri::AppHandle,
    sample_text: String,
) -> Result<String, String> {
    let sample = sample_text.trim();
    if sample.is_empty() {
        return Err("sample text is empty".to_string());
    }
    // Hard cap so the prompt never blows the clipboard / argv path. 12 KB of
    // user text is already a very long writing sample.
    let sample = if sample.chars().count() > 12_000 {
        sample.chars().take(12_000).collect::<String>()
    } else {
        sample.to_string()
    };

    let dir = personal_dir().ok_or_else(|| "no HOME".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir personal: {}", e))?;
    let cwd = dir.to_string_lossy().to_string();
    let known = known_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "~/.ultron/personal/known.json".to_string());

    let prompt = format!(
        "You are refining the user's style fingerprint stored at {known}.\n\n\
Step 1. Read the existing {known} (if present). Treat it as your prior.\n\
Step 2. Read the user-provided writing sample below. This is a fresh \
example the user explicitly wants you to learn from — weight it heavily.\n\
Step 3. Produce an UPDATED PersonalKnown JSON merging the prior with the \
new evidence. Keep the exact schema (style_fingerprint, writing_style \
{{tone, primary_language, code_switching, characteristic_phrases, \
typo_patterns, formatting_habits, average_message_length_chars, \
punctuation_quirks}}, recent_topics, routines, last_updated, source).\n\
Step 4. Set `source` to \"codex-train-v1\" and `last_updated` to the \
current ISO 8601 timestamp.\n\
Step 5. Overwrite {known} with the new JSON. Output JSON ONLY (no fences, \
no prose). Total < 3 KB.\n\n\
Hard rules:\n\
- Preserve fields you cannot improve. Do NOT regress fields that were \
already confidently set.\n\
- Do NOT invent. Unknown fields stay \"(unknown — needs more data)\".\n\
- After writing the file, print one line: \"known.json updated\" and exit.\n\n\
========== USER WRITING SAMPLE (verbatim) ==========\n\
{sample}\n\
========== END SAMPLE ==========\n",
        known = known,
        sample = sample,
    );

    let flags = crate::sessions::SpawnFlags {
        paste_only: true,
        ..Default::default()
    };

    crate::sessions::spawn_session_inner(
        app,
        "codex".to_string(),
        Some(prompt),
        Some(cwd),
        Some(flags),
    )
    .await?;
    Ok("Codex session abierta (paste-only)".to_string())
}

/// Spawn a Claude session that writes a ~300-word sample text in the user's
/// voice, drawn from `known.json`, to `~/.ultron/personal/last-sample.md`.
/// The UI reloads the sample file after the user closes the session.
pub async fn generate_style_sample_inner(
    app: &tauri::AppHandle,
) -> Result<String, String> {
    let dir = personal_dir().ok_or_else(|| "no HOME".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir personal: {}", e))?;
    let cwd = dir.to_string_lossy().to_string();
    let known = known_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "~/.ultron/personal/known.json".to_string());
    let out = last_sample_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "~/.ultron/personal/last-sample.md".to_string());

    let prompt = format!(
        "Write a ~300-word piece in the user's exact voice and style, based \
on the fingerprint at {known}.\n\n\
Process:\n\
1. Read {known}. Internalize tone, language, code-switching pattern, \
characteristic phrases, typo habits, formatting habits, punctuation quirks.\n\
2. Pick a random technical topic the user actually cares about (UE5 / \
gameplay programming / AI/ML / Tauri / Windows tooling / shaders / netcode \
— rotate so it's not always the same one).\n\
3. Write ~300 words ON THAT TOPIC as if the user themselves wrote it. \
Match register, sentence rhythm, opening/closing habits. If the user mixes \
ES/EN, mix them where they would. Do NOT use emojis.\n\
4. Overwrite {out} with: a single H1 line `# Sample — <topic>`, a blank \
line, then the 300-word piece. No fences, no commentary.\n\
5. Print one line `last-sample.md written` and exit.\n\n\
Hard rules:\n\
- Do NOT meta-comment about the style. Write the piece itself.\n\
- 280-330 words inclusive. Count before saving.\n\
- If {known} is empty/missing, write a short note instead: `# Sample` then \
`(known.json is empty — generate analysis first)`.\n",
        known = known,
        out = out,
    );

    crate::sessions::spawn_session_inner(
        app,
        "claude".to_string(),
        Some(prompt),
        Some(cwd),
        None,
    )
    .await?;
    Ok("Claude session abierta".to_string())
}
