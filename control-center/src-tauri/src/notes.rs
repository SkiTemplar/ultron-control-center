// ULTRON Control Center 2.0 — Global notes domain (v2.6, card-v26-fb-005).
//
// Cross-project markdown notes, file-per-note at
// `~/.ultron/cockpit/notes/<slug>.md`. Atomic writes via tmp + rename to
// match the kanban/projects write discipline. The body is opaque to us: the
// renderer is in the frontend (src/lib/markdown.tsx) — we only sanitise the
// slug (the file name), never the body.
//
// (2026-08-11, decisión del usuario — audit 08-09 #37) Las notas POR-PROYECTO
// (notes.md legacy + notebook multi-nota) se RETIRARON: 0 comandos
// registrados, 0 consumidores — las globales las reemplazaron.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

/// Cap the notes file to a sane size so a runaway editor (or a paste from
/// a giant log) doesn't bloat the cockpit directory. 1 MiB is well above
/// any human-authored notes file we expect.
const MAX_NOTES_BYTES: usize = 1024 * 1024;

fn is_safe_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteEntry {
    pub slug: String,
    pub title: String,
    pub size_bytes: u64,
    pub modified_iso: Option<String>,
    pub preview: String,
}

fn global_notes_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    Ok(home.join(".ultron").join("cockpit").join("notes"))
}

fn global_note_path(slug: &str) -> Result<PathBuf, String> {
    if !is_safe_slug(slug) {
        return Err(format!("invalid note slug '{}'", slug));
    }
    Ok(global_notes_dir()?.join(format!("{}.md", slug)))
}

fn first_line(body: &str) -> &str {
    body.lines()
        .next()
        .unwrap_or("")
        .trim_start_matches('#')
        .trim()
}

fn mtime_iso(meta: &fs::Metadata) -> Option<String> {
    use std::time::UNIX_EPOCH;
    let m = meta.modified().ok()?;
    let secs = m.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some(format!("epoch:{}", secs))
}

pub fn list_global_inner() -> Result<Vec<NoteEntry>, String> {
    let dir = global_notes_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<NoteEntry> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let slug = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let body = fs::read_to_string(&path).unwrap_or_default();
        let title = {
            let line = first_line(&body);
            if line.is_empty() {
                slug.clone()
            } else {
                line.to_string()
            }
        };
        let meta = entry.metadata().ok();
        let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified_iso = meta.as_ref().and_then(mtime_iso);
        let preview: String = body
            .lines()
            .skip(1)
            .filter(|l| !l.trim().is_empty())
            .take(3)
            .collect::<Vec<_>>()
            .join(" ");
        let preview = if preview.chars().count() > 200 {
            let truncated: String = preview.chars().take(200).collect();
            format!("{}…", truncated)
        } else {
            preview
        };
        out.push(NoteEntry {
            slug,
            title,
            size_bytes,
            modified_iso,
            preview,
        });
    }
    out.sort_by(|a, b| b.modified_iso.cmp(&a.modified_iso));
    Ok(out)
}

pub fn load_global_inner(slug: &str) -> Result<String, String> {
    let path = global_note_path(slug)?;
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))
}

pub fn save_global_inner(slug: &str, body: &str) -> Result<(), String> {
    if body.len() > MAX_NOTES_BYTES {
        return Err(format!(
            "notes too large ({} bytes, max {})",
            body.len(),
            MAX_NOTES_BYTES
        ));
    }
    let path = global_note_path(slug)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let tmp = path.with_extension("md.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp: {}", e))?;
        f.write_all(body.as_bytes())
            .map_err(|e| format!("write tmp: {}", e))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

pub fn delete_global_inner(slug: &str) -> Result<(), String> {
    let path = global_note_path(slug)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("remove {}: {}", path.display(), e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_slug() {
        // Mismo caso negativo que protegía notes_path (retirada): el slug es
        // el nombre de fichero y no puede escapar del directorio de notas.
        assert!(global_note_path("../escape").is_err());
        assert!(global_note_path("foo/bar").is_err());
        assert!(global_note_path("").is_err());
        assert!(global_note_path("ok-id_1.2").is_ok());
    }

    #[test]
    fn rejects_oversize_body() {
        let big = "x".repeat(MAX_NOTES_BYTES + 1);
        let res = save_global_inner("nope", &big);
        assert!(res.is_err());
    }
}
