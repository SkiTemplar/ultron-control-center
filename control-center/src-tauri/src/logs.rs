// ULTRON Control Center — Logs tab backend.
//
// Surfaces curated log sources the user actually cares about, with bounded
// tailing so the panel never reads gigabytes. Sources are read-only from
// the UI's perspective; mutation lives in the producer scripts.

use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct LogSource {
    pub id: String,
    pub label: String,
    pub path: String,
    pub exists: bool,
    pub size_bytes: u64,
    pub last_modified: Option<String>,
    /// Mime-like hint so the UI can choose monospace vs. JSON pretty.
    pub kind: String,
    /// One-sentence description so the user knows what the source is for
    /// without opening the file. Renders under the label in the UI.
    pub description: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct LogTail {
    pub source_id: String,
    pub path: String,
    pub total_lines: u64,
    pub tail: Vec<String>,
    pub truncated: bool,
}

fn home_join(rel: &str) -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(rel))
}

/// Curated list of log sources. Each tuple is (id, label, relative-path, kind).
/// Adding a new one is intentionally cheap — the UI just renders whatever
/// comes back from list_logs_inner.
/// Each entry: (id, label, relative-path, kind, description).
/// Notifications shows curated alerts (one per row, deduped, with severity);
/// Logs is the raw fire-hose where you go *when something in Notifications
/// doesn't tell you why*. This catalog leans on background-task logs that
/// Notifications would never surface (doctor stdout, backup robocopy output,
/// etc.).
fn catalog() -> Vec<(&'static str, &'static str, &'static str, &'static str, &'static str)> {
    vec![
        (
            "alerts",
            "Alerts (raw jsonl)",
            ".ultron/alerts.jsonl",
            "jsonl",
            "Mismo archivo que alimenta la pestaña Notifications, pero sin dedupe ni filtros. Útil para ver el orden cronológico exacto.",
        ),
        (
            "doctor",
            "Doctor (weekly task)",
            ".ultron/cockpit/scheduler-logs/doctor.log",
            "text",
            "Stdout del scheduled task UltronDoctor-Weekly. Aquí es donde aparece la causa real cuando el task muestra 0x1 en System.",
        ),
        (
            "backup",
            "Backup weekly",
            ".ultron/cockpit/scheduler-logs/backup-weekly.log",
            "text",
            "Robocopy /MIR output del mirror semanal al backup root (ULTRON_BACKUP_ROOT o ~/BACKUP). Aquí ves qué archivos copia y cuáles se saltan.",
        ),
        (
            "retention",
            "Retention",
            ".ultron/cockpit/scheduler-logs/retention.log",
            "text",
            "Limpieza periódica de archivos antiguos: cuántos puntos de qdrant se purgaron, qué notas vault se rotaron.",
        ),
        (
            "ai-standup",
            "AI standup",
            ".ultron/cockpit/scheduler-logs/ai_standup.log",
            "text",
            "Briefing matinal generado por IA con qué pasó ayer / qué toca hoy. Sólo útil si el standup falla y no recibes el resumen.",
        ),
        (
            "research",
            "Research",
            ".ultron/cockpit/scheduler-logs/research.log",
            "text",
            "Background research jobs (arxiv, papers). Aquí ves errores de fetch o de parsing.",
        ),
        (
            "github-trending",
            "GitHub trending",
            ".ultron/cockpit/scheduler-logs/github_trending.log",
            "text",
            "Snapshot diario del trending de GitHub para el feed de news.",
        ),
        (
            "mcp-audit",
            "MCP audit (jsonl)",
            ".ultron/cockpit/mcp-audit.jsonl",
            "jsonl",
            "Cada enable/disable/edit de un MCP server queda registrado aquí (quién, cuándo, qué cambió).",
        ),
        (
            "auto-updater",
            "Auto-updater (jsonl)",
            ".ultron/cockpit/auto_updater.jsonl",
            "jsonl",
            "Resultado del proceso de auto-update de ULTRON: qué versión se aplicó, qué falló.",
        ),
        (
            "token-usage",
            "Token usage (jsonl)",
            ".ultron/.tmp/token-usage.jsonl",
            "jsonl",
            "Tokens crudos por turno (modelo, input/output/cache). La pestaña Usage agrega esto; aquí ves la entrada bruta.",
        ),
        (
            "prompt-feedback",
            "Prompt feedback (jsonl)",
            ".ultron/.tmp/prompt-feedback.jsonl",
            "jsonl",
            "Telemetría de skill activations + match score por turno. Lo que come la tab Stats.",
        ),
        (
            "mcp-health",
            "MCP health (json)",
            ".ultron/.tmp/mcp-health.json",
            "json",
            "Snapshot del último health-check de los MCP servers. La tab MCPs renderiza una versión bonita; aquí está el JSON crudo.",
        ),
    ]
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
    let mdays: [i64; 12] = [
        31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] {
        days -= mdays[month];
        month += 1;
    }
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month + 1, days + 1, h, m, s
    ))
}

pub fn list_logs_inner() -> Result<Vec<LogSource>, String> {
    let mut out: Vec<LogSource> = Vec::new();
    for (id, label, rel, kind, desc) in catalog() {
        let path = match home_join(rel) {
            Some(p) => p,
            None => continue,
        };
        let exists = path.exists();
        let (size_bytes, last_modified) = if exists {
            match fs::metadata(&path) {
                Ok(m) => (
                    m.len(),
                    m.modified().ok().and_then(iso_from_systime),
                ),
                Err(_) => (0, None),
            }
        } else {
            (0, None)
        };
        out.push(LogSource {
            id: id.to_string(),
            label: label.to_string(),
            path: path.to_string_lossy().to_string(),
            exists,
            size_bytes,
            last_modified,
            kind: kind.to_string(),
            description: desc.to_string(),
        });
    }
    Ok(out)
}

/// Read the last `lines` lines of a known source. `lines` clamped to [1, 2000]
/// so the UI can't accidentally pull the whole file.
pub fn tail_log_inner(source_id: String, lines: Option<usize>) -> Result<LogTail, String> {
    let cat = catalog();
    let entry = cat
        .iter()
        .find(|(id, _, _, _, _)| *id == source_id.as_str())
        .ok_or_else(|| format!("unknown log source '{}'", source_id))?;
    let path = home_join(entry.2).ok_or_else(|| "no HOME".to_string())?;
    let n = lines.unwrap_or(200).clamp(1, 2000);

    if !path.exists() {
        return Ok(LogTail {
            source_id,
            path: path.to_string_lossy().to_string(),
            total_lines: 0,
            tail: Vec::new(),
            truncated: false,
        });
    }
    // Bound the read: read at most 4 MB from end. Logs we care about are
    // typically <500 KB; this guarantees we never blow memory on a rogue
    // append.
    let meta = fs::metadata(&path).map_err(|e| format!("metadata: {}", e))?;
    const MAX_READ: u64 = 4 * 1024 * 1024;
    let size = meta.len();
    let content = if size <= MAX_READ {
        fs::read_to_string(&path).map_err(|e| format!("read: {}", e))?
    } else {
        // For oversized files, read from a tail offset using std::fs::File
        // + Seek so we don't allocate the whole file.
        use std::io::{Read, Seek, SeekFrom};
        let mut f = fs::File::open(&path).map_err(|e| format!("open: {}", e))?;
        f.seek(SeekFrom::End(-(MAX_READ as i64))).map_err(|e| format!("seek: {}", e))?;
        let mut buf = Vec::with_capacity(MAX_READ as usize);
        f.read_to_end(&mut buf).map_err(|e| format!("read tail: {}", e))?;
        // Drop the first line in case we sliced mid-utf8 or mid-line.
        let s = String::from_utf8_lossy(&buf).to_string();
        if let Some(idx) = s.find('\n') {
            s[idx + 1..].to_string()
        } else {
            s
        }
    };
    let lines_vec: Vec<&str> = content.lines().collect();
    let total = lines_vec.len() as u64;
    let truncated = size > MAX_READ || total > n as u64;
    let start = total.saturating_sub(n as u64) as usize;
    let tail: Vec<String> = lines_vec[start..].iter().map(|s| s.to_string()).collect();

    Ok(LogTail {
        source_id,
        path: path.to_string_lossy().to_string(),
        total_lines: total,
        tail,
        truncated,
    })
}
