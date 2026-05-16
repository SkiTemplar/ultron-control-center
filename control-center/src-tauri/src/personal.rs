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

const DEFAULT_TEMPLATE: &str = r#"# Personal profile

Texto libre que ULTRON usará como contexto persistente. Edita lo que
necesites — todo lo que escribas aquí queda disponible para los skills
que carguen `~/.ultron/personal/profile.md`.

## Estilo de escritura
(Frases que sueles usar, tono, idioma preferido, longitud objetivo...)

## Rutinas
(Bloques horarios, días que sueles trabajar, when not to interrupt...)

## Preferencias técnicas
(Stack favorito, frameworks que evitas, naming conventions...)

## Patrones de prompts
(Cuando dices X normalmente quieres Y. Atajos que usas...)

## Otros datos relevantes
"#;

pub fn read_personal_profile_inner() -> Result<PersonalProfile, String> {
    let path = profile_path().ok_or_else(|| "no HOME".to_string())?;
    if !path.exists() {
        // Seed the file with the default template on first read so the
        // user has somewhere to start typing.
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
        }
        fs::write(&path, DEFAULT_TEMPLATE).map_err(|e| format!("write seed: {}", e))?;
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("read: {}", e))?;
    let meta = fs::metadata(&path).map_err(|e| format!("metadata: {}", e))?;
    Ok(PersonalProfile {
        path: path.to_string_lossy().to_string(),
        content,
        last_modified: meta.modified().ok().and_then(iso_from_systime),
        size_bytes: meta.len(),
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
        "Lee los últimos 30 transcripts en ~/.claude/projects/, los últimos 20 \
commits del repo ~/.ultron, y MEMORY.md. Genera un análisis de mi estilo de \
escritura, temas recurrentes y rutinas. Escribe el resultado en {} con shape: \
{{\"style_fingerprint\": \"...\", \"recent_topics\": [], \"routines\": [], \
\"last_updated\": \"<iso>\", \"source\": \"<descripción>\"}}. Token-eficiente: \
máximo 50 líneas leídas por fuente. style_fingerprint = 1-3 líneas. \
recent_topics: máximo 8 strings cortos. routines: máximo 4 frases tipo \
\"trabaja entre 22:00-02:00\". NO inventes datos: si una fuente no aporta \
nada, déjalo vacío.",
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
