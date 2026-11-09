// Resultado real del último run de weekly-backup.{ps1,sh}.
//
// El script escribe `~/.ultron/.tmp/backup-last-run.json` (con BOM en
// PowerShell 5.1) con el código de robocopy/rsync de cada fuente y el
// resultado del snapshot de brain.db. Antes nadie lo leía y la tarjeta se
// deducía solo del mtime de las carpetas: el run del 2026-10-11 falló en 6 de
// 8 fuentes y en el snapshot y la tarjeta lo pintaba «ok».

use std::path::PathBuf;

use serde::Serialize;

/// Resultado de una fuente en el último run.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct SourceResult {
    /// Fuente tal como está configurada (`.ultron`, `Documents`, `D:\TFG`).
    pub source: String,
    /// Nombre de la carpeta espejo bajo la raíz del backup.
    pub dest_name: String,
    /// Código de salida de robocopy/rsync (`None` si el JSON no lo trae).
    pub code: Option<i64>,
    /// La fuente no existía en disco.
    pub skipped: bool,
    /// Fallo real: fuente inexistente o código de error.
    pub failed: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct BackupLastRun {
    pub last_run: Option<String>,
    pub dry_run: bool,
    pub backup_root: Option<String>,
    pub sources: Vec<SourceResult>,
    pub failed_sources: Vec<String>,
    /// `Some(false)` = el snapshot de brain.db falló; `None` = no se intentó.
    pub brain_snapshot: Option<bool>,
    /// Algún fallo: fuente, snapshot, aborto o la marca `any_failed` del script.
    pub failed: bool,
    /// El script abortó antes de copiar (exit 2): sin destino, unidad
    /// desmontada o destino en el mismo volumen que las fuentes.
    pub aborted: bool,
    /// `no_destination` | `drive_missing` | `same_volume` (solo si `aborted`).
    pub error_code: Option<String>,
    /// Detalle del aborto tal como lo escribe el script (en inglés, ASCII).
    pub error: Option<String>,
    pub log: Option<String>,
    pub robocopy_log: Option<String>,
    /// Resumen legible para la tarjeta.
    pub summary: String,
}

pub fn last_run_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron").join(".tmp").join("backup-last-run.json"))
}

/// Lee el último run. `Ok(None)` si el script no ha corrido nunca; `Err` si
/// el fichero existe pero no se puede leer o no es JSON válido.
pub fn read_last_run() -> Result<Option<BackupLastRun>, String> {
    let Some(path) = last_run_path() else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("leer {}: {}", path.display(), e))?;
    parse_last_run(&raw).map(Some)
}

fn is_absolute_source(src: &str) -> bool {
    let b = src.as_bytes();
    let drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
    drive || src.starts_with('\\') || src.starts_with('/')
}

/// Nombre de la carpeta espejo de una fuente. Mismo criterio que
/// `Resolve-BackupTarget` en weekly-backup.ps1.
pub fn dest_name_for(source: &str) -> String {
    if is_absolute_source(source) {
        let mut slug = String::with_capacity(source.len());
        for ch in source.chars() {
            if matches!(ch, ':' | '\\' | '/') {
                if !slug.ends_with('-') {
                    slug.push('-');
                }
            } else {
                slug.push(ch);
            }
        }
        return format!("abs-{}", slug.trim_matches('-'));
    }
    if source.starts_with('.') {
        return format!("dot-{}", source.trim_start_matches('.'));
    }
    source.trim_start_matches('\\').to_string()
}

fn dest_name_from_path(dest: &str) -> Option<String> {
    dest.rsplit(['\\', '/'])
        .find(|s| !s.is_empty())
        .map(str::to_string)
}

fn source_result(source: &str, v: &serde_json::Value) -> SourceResult {
    let skipped = v.get("skipped").and_then(|x| x.as_bool()).unwrap_or(false);
    let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
    // Los runs anteriores a 2026-10-17 no traen `failed` y daban por bueno
    // un `skipped`; aquí una fuente configurada que falta es un fallo.
    let failed = v
        .get("failed")
        .and_then(|x| x.as_bool())
        .unwrap_or(skipped || !ok);
    let dest_name = v
        .get("dest")
        .and_then(|x| x.as_str())
        .and_then(dest_name_from_path)
        .unwrap_or_else(|| dest_name_for(source));
    SourceResult {
        source: source.to_string(),
        dest_name,
        code: v.get("code").and_then(|x| x.as_i64()),
        skipped,
        failed,
    }
}

/// Orden de las fuentes: el de `sources` (si es lista) y luego el resto de
/// claves de `results` en orden alfabético. PowerShell serializa `sources`
/// como cadena suelta cuando solo hay una.
fn ordered_keys(
    v: &serde_json::Value,
    results: &serde_json::Map<String, serde_json::Value>,
) -> Vec<String> {
    let mut keys: Vec<String> = match v.get("sources") {
        Some(serde_json::Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str().map(str::to_string))
            .filter(|k| results.contains_key(k))
            .collect(),
        Some(serde_json::Value::String(s)) if results.contains_key(s) => vec![s.clone()],
        _ => Vec::new(),
    };
    let mut rest: Vec<String> = results
        .keys()
        .filter(|k| !keys.contains(*k))
        .cloned()
        .collect();
    rest.sort();
    keys.extend(rest);
    keys
}

/// Motivo legible de un aborto del script.
fn abort_reason(run: &BackupLastRun) -> String {
    let root = run.backup_root.as_deref().unwrap_or("?");
    match run.error_code.as_deref() {
        Some("no_destination") => "no hay destino de backup configurado; elige una carpeta en otra unidad en Ajustes → Backups".into(),
        Some("drive_missing") => format!("la unidad de destino no está montada ({})", root),
        Some("same_volume") => format!(
            "el destino {} está en el mismo disco que las fuentes, y un espejo en el mismo disco no es un backup",
            root
        ),
        _ => run.error.clone().unwrap_or_else(|| "motivo desconocido".into()),
    }
}

fn summarize(run: &BackupLastRun) -> String {
    let when = run
        .last_run
        .clone()
        .unwrap_or_else(|| "fecha desconocida".into());
    let dry = if run.dry_run { " (simulación)" } else { "" };
    if run.aborted {
        return format!(
            "Último run{} {} abortado: {}. No se copió nada.",
            dry,
            when,
            abort_reason(run)
        );
    }
    let total = run.sources.len();
    let mut parts: Vec<String> = Vec::new();
    if run.failed_sources.is_empty() {
        parts.push(format!("{} de {} fuentes OK", total, total));
    } else {
        let shown: Vec<&str> = run
            .failed_sources
            .iter()
            .take(4)
            .map(String::as_str)
            .collect();
        let more = run.failed_sources.len().saturating_sub(shown.len());
        let tail = if more > 0 {
            format!(" y {} más", more)
        } else {
            String::new()
        };
        parts.push(format!(
            "fallaron {} de {} fuentes ({}{})",
            run.failed_sources.len(),
            total,
            shown.join(", "),
            tail
        ));
    }
    match run.brain_snapshot {
        Some(false) => parts.push("el snapshot de brain.db falló".into()),
        Some(true) => parts.push("snapshot de brain.db OK".into()),
        None => {}
    }
    format!("Último run{} {}: {}.", dry, when, parts.join("; "))
}

pub fn parse_last_run(raw: &str) -> Result<BackupLastRun, String> {
    // PowerShell 5.1 escribe UTF-8 con BOM y serde_json no lo acepta.
    let body = raw.trim_start_matches('\u{feff}');
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("backup-last-run.json inválido: {}", e))?;
    let empty = serde_json::Map::new();
    let results = v
        .get("results")
        .and_then(|r| r.as_object())
        .unwrap_or(&empty);
    let sources: Vec<SourceResult> = ordered_keys(&v, results)
        .iter()
        .filter_map(|k| results.get(k).map(|r| source_result(k, r)))
        .collect();
    let failed_sources: Vec<String> = sources
        .iter()
        .filter(|s| s.failed)
        .map(|s| s.source.clone())
        .collect();
    let brain_snapshot = v.get("brain_snapshot").and_then(|x| x.as_bool());
    let any_failed = v
        .get("any_failed")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let text = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let aborted = v.get("aborted").and_then(|x| x.as_bool()).unwrap_or(false);
    let status_failed = text("status").as_deref() == Some("failed");
    let mut run = BackupLastRun {
        last_run: text("last_run"),
        dry_run: v.get("dry_run").and_then(|x| x.as_bool()).unwrap_or(false),
        backup_root: text("backup_root"),
        failed: any_failed
            || aborted
            || status_failed
            || !failed_sources.is_empty()
            || brain_snapshot == Some(false),
        aborted,
        error_code: text("error_code"),
        error: text("error"),
        sources,
        failed_sources,
        brain_snapshot,
        log: text("log"),
        robocopy_log: text("robocopy_log"),
        summary: String::new(),
    };
    run.summary = summarize(&run);
    Ok(run)
}

/// El run se hizo sobre la raíz que se está mostrando. Sin `backup_root` en
/// el JSON se asume que sí (runs antiguos).
pub fn same_root(run: &BackupLastRun, root: &str) -> bool {
    let norm = |s: &str| s.trim().trim_end_matches(['\\', '/']).to_lowercase();
    run.backup_root
        .as_deref()
        .map(|r| norm(r) == norm(root))
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Forma real del run del 2026-10-11 (rutas anonimizadas), con el BOM de
    /// PowerShell 5.1 y sin el campo `failed` de los runs nuevos.
    const RUN_2026_10_11: &str = "\u{feff}{
        \"results\": {
            \"CARRERA\": {\"ok\": false, \"code\": 16, \"skipped\": false},
            \"Documents\": {\"ok\": false, \"code\": 16, \"skipped\": false},
            \"Videos\": {\"ok\": false, \"code\": 16, \"skipped\": false},
            \".ultron-vault\": {\"ok\": true, \"code\": 0, \"skipped\": false},
            \"PERSONAL\": {\"ok\": false, \"code\": 11, \"skipped\": false},
            \".ultron\": {\"ok\": false, \"code\": 11, \"skipped\": false},
            \".claude\": {\"ok\": true, \"code\": 3, \"skipped\": false},
            \"Pictures\": {\"ok\": false, \"code\": 16, \"skipped\": false}
        },
        \"backup_root\": \"D:\\\\BACKUP\",
        \"brain_snapshot\": false,
        \"last_run\": \"2026-10-11T23:01:38+02:00\",
        \"sources\": [\".ultron\", \".ultron-vault\", \".claude\", \"PERSONAL\", \"CARRERA\", \"Documents\", \"Videos\", \"Pictures\"],
        \"dry_run\": false,
        \"log\": \"C:\\\\Users\\\\u\\\\.ultron\\\\logs\\\\backup-2026-10-11.log\"
    }";

    #[test]
    fn the_failed_run_of_2026_10_11_is_reported_as_failed() {
        let run = parse_last_run(RUN_2026_10_11).expect("JSON con BOM");
        assert!(run.failed);
        assert_eq!(run.sources.len(), 8);
        assert_eq!(run.failed_sources.len(), 6);
        // Orden de `sources`, no el del hashtable de PowerShell.
        assert_eq!(run.sources[0].source, ".ultron");
        assert_eq!(run.sources[0].dest_name, "dot-ultron");
        assert_eq!(run.brain_snapshot, Some(false));
        assert!(run.summary.contains("fallaron 6 de 8"), "{}", run.summary);
        assert!(run.summary.contains("brain.db falló"), "{}", run.summary);
        assert!(run
            .log
            .as_deref()
            .unwrap()
            .ends_with("backup-2026-10-11.log"));
    }

    #[test]
    fn a_clean_run_is_not_failed() {
        let raw = r#"{"results": {".claude": {"ok": true, "code": 1, "skipped": false, "failed": false}},
                      "sources": ".claude", "brain_snapshot": true, "any_failed": false,
                      "last_run": "2026-10-17T09:00:00+02:00"}"#;
        let run = parse_last_run(raw).unwrap();
        assert!(!run.failed);
        assert!(run.failed_sources.is_empty());
        assert!(run.summary.contains("1 de 1 fuentes OK"), "{}", run.summary);
    }

    #[test]
    fn a_missing_source_counts_as_failed_even_in_old_runs() {
        let raw = r#"{"results": {"D:\\TFG": {"ok": false, "code": 16, "skipped": true}}}"#;
        let run = parse_last_run(raw).unwrap();
        assert!(run.failed);
        assert_eq!(run.failed_sources, vec![r"D:\TFG".to_string()]);
        assert_eq!(run.sources[0].dest_name, "abs-D-TFG");
    }

    #[test]
    fn script_any_failed_flag_wins() {
        let raw = r#"{"results": {}, "any_failed": true}"#;
        assert!(parse_last_run(raw).unwrap().failed);
    }

    /// Lo que escribe `Exit-Aborted` de weekly-backup.ps1 sin destino (N1).
    const ABORTED_NO_DESTINATION: &str = "\u{feff}{
        \"status\": \"failed\", \"aborted\": true, \"error_code\": \"no_destination\",
        \"error\": \"No backup destination configured: ...\", \"results\": {},
        \"sources\": [\".ultron\"], \"backup_root\": null, \"any_failed\": true,
        \"dry_run\": false, \"last_run\": \"2026-10-25T10:00:00+01:00\"
    }";

    #[test]
    fn an_aborted_run_is_failed_and_says_why() {
        let run = parse_last_run(ABORTED_NO_DESTINATION).unwrap();
        assert!(run.failed);
        assert!(run.aborted);
        assert_eq!(run.error_code.as_deref(), Some("no_destination"));
        assert!(run.summary.contains("abortado"), "{}", run.summary);
        assert!(run.summary.contains("no hay destino"), "{}", run.summary);
        // No debe presumir «0 de 0 fuentes OK».
        assert!(!run.summary.contains("fuentes OK"), "{}", run.summary);
    }

    #[test]
    fn same_volume_abort_names_the_destination() {
        let raw = r#"{"status": "failed", "aborted": true, "error_code": "same_volume",
                      "results": {}, "backup_root": "C:\\Users\\u\\BACKUP"}"#;
        let run = parse_last_run(raw).unwrap();
        assert!(run.failed);
        assert!(
            run.summary.contains(r"C:\Users\u\BACKUP"),
            "{}",
            run.summary
        );
        assert!(run.summary.contains("mismo disco"), "{}", run.summary);
    }

    #[test]
    fn status_failed_alone_is_a_failure() {
        let raw = r#"{"results": {}, "status": "failed"}"#;
        assert!(parse_last_run(raw).unwrap().failed);
    }

    #[test]
    fn invalid_json_is_an_error_not_a_silent_ok() {
        assert!(parse_last_run("{ no es json").is_err());
    }

    #[test]
    fn dest_names_match_the_powershell_script() {
        assert_eq!(dest_name_for(".ultron"), "dot-ultron");
        assert_eq!(dest_name_for("Documents"), "Documents");
        assert_eq!(dest_name_for(r"D:\TFG"), "abs-D-TFG");
        assert_eq!(dest_name_for(r"D:\a\b\"), "abs-D-a-b");
        assert_eq!(dest_name_for("/mnt/data"), "abs-mnt-data");
        // El campo `dest` de los runs nuevos manda sobre el cálculo.
        let raw = r#"{"results": {"X": {"ok": true, "code": 0, "skipped": false, "dest": "D:\\BK\\otro"}}}"#;
        assert_eq!(parse_last_run(raw).unwrap().sources[0].dest_name, "otro");
    }

    #[test]
    fn same_root_ignores_case_and_trailing_separator() {
        let run = parse_last_run(r#"{"results": {}, "backup_root": "D:\\BACKUP\\"}"#).unwrap();
        assert!(same_root(&run, r"d:\backup"));
        assert!(!same_root(&run, r"E:\BACKUP"));
    }
}
