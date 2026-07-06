// commands/sessions_sub/session_summary.rs — Resolución de transcripts de sesión.
//
// El comando Tauri `summarize_session_activity` (resumen vía AI Router) se
// retiró 2026-07: ningún componente del frontend lo invocaba (limpieza de
// código muerto). Queda `find_transcript`, que SÍ tiene consumidor: el sidecar
// `ultron-memory provenance` lo usa para resolver la cita episódica de una
// memoria (source_session_id → transcript real en disco).

/// Pub: lo usa el sidecar (`ultron-memory provenance`) para resolver la
/// cita episódica de una memoria (source_session_id → transcript real en disco).
pub fn find_transcript(session_id: &str) -> Option<std::path::PathBuf> {
    // Defensa (input boundary): el session_id es un nombre de fichero (UUID). Rechazar
    // vacío o cualquier separador de ruta / `..` para que no se pueda escapar de
    // ~/.claude/projects/ y leer un .jsonl arbitrario (path traversal).
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return None;
    }
    let base = dirs::home_dir()?.join(".claude").join("projects");
    let filename = format!("{session_id}.jsonl");
    let entries = std::fs::read_dir(&base).ok()?;
    for entry in entries.flatten() {
        let path = entry.path().join(&filename);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Tests unitarios (sin I/O)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_transcript_rejects_path_traversal() {
        // La validación de boundary corta ANTES de tocar el FS, así que estos no
        // dependen de ~/.claude/projects ni leen ningún fichero.
        assert!(find_transcript("../secreto").is_none());
        assert!(find_transcript("a/b").is_none());
        assert!(find_transcript("a\\b").is_none());
        assert!(find_transcript("").is_none());
    }
}
