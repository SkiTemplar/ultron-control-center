// Cruce de las carpetas espejo (estado por mtime) con el último run real
// (`backup-last-run.json`). Una fuente fallida marca su carpeta como
// `failed` aunque el mtime sea reciente, y una fuente fallida sin carpeta
// (nunca se llegó a copiar) aparece como fila propia en vez de desaparecer
// de la tarjeta. Un run de simulación o hecho sobre otra raíz no cambia los
// estados.

use std::path::Path;

use super::last_run::{self, BackupLastRun, SourceResult};
use super::BackupEntry;

/// El último run solo cuenta si es real y se hizo sobre la raíz mostrada.
pub(super) fn applicable_run<'a>(
    run: Option<&'a BackupLastRun>,
    root: &Path,
) -> Option<&'a BackupLastRun> {
    run.filter(|r| !r.dry_run && last_run::same_root(r, &root.to_string_lossy()))
}

fn result_for<'a>(run: &'a BackupLastRun, name: &str) -> Option<&'a SourceResult> {
    run.sources.iter().find(|s| s.dest_name == name)
}

/// `run` ya filtrado por `applicable_run`.
pub(super) fn merge_last_run(
    entries: Vec<BackupEntry>,
    run: Option<&BackupLastRun>,
    root: &Path,
) -> Vec<BackupEntry> {
    let Some(run) = run else {
        return entries;
    };
    let mut merged: Vec<BackupEntry> = entries
        .into_iter()
        .map(|e| {
            let Some(s) = result_for(run, &e.name) else {
                return e;
            };
            let failed = s.failed;
            BackupEntry {
                status: if failed { "failed".into() } else { e.status },
                last_result: Some(if failed { "failed" } else { "ok" }.into()),
                ..e
            }
        })
        .collect();
    for s in run.sources.iter().filter(|s| s.failed) {
        if merged.iter().any(|e| e.name == s.dest_name) {
            continue;
        }
        merged.push(BackupEntry {
            name: s.dest_name.clone(),
            path: root.join(&s.dest_name).to_string_lossy().to_string(),
            last_modified: None,
            age_hours: None,
            exists: false,
            status: "failed".into(),
            last_result: Some("failed".into()),
        });
    }
    merged
}

/// `run` ya filtrado por `applicable_run`.
pub(super) fn overall_status_for(entries: &[BackupEntry], run: Option<&BackupLastRun>) -> String {
    let run_failed = run.map(|r| r.failed).unwrap_or(false);
    if run_failed || entries.iter().any(|e| e.status == "failed") {
        "failed"
    } else if entries.is_empty() {
        "empty"
    } else if entries.iter().any(|e| e.status == "cold") {
        "cold"
    } else if entries.iter().any(|e| e.status == "stale") {
        "stale"
    } else {
        "ok"
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup_status::last_run::parse_last_run;

    fn entry(name: &str, status: &str) -> BackupEntry {
        BackupEntry {
            name: name.into(),
            path: format!("/bk/{}", name),
            last_modified: Some("2026-10-11T21:01:38Z".into()),
            age_hours: Some(10.0),
            exists: true,
            status: status.into(),
            last_result: None,
        }
    }

    fn by<'a>(m: &'a [BackupEntry], name: &str) -> &'a BackupEntry {
        m.iter().find(|e| e.name == name).expect("fila")
    }

    fn run(json: &str) -> BackupLastRun {
        parse_last_run(json).expect("JSON de prueba")
    }

    const FAILED_RUN: &str = r#"{"backup_root": "/bk", "brain_snapshot": false,
        "results": {
            ".ultron": {"ok": false, "code": 11, "skipped": false},
            ".claude": {"ok": true, "code": 3, "skipped": false},
            "D:\\TFG": {"ok": false, "code": 16, "skipped": true}
        }}"#;

    #[test]
    fn a_fresh_mtime_does_not_hide_a_failed_source() {
        let r = run(FAILED_RUN);
        let root = Path::new("/bk");
        let applicable = applicable_run(Some(&r), root);
        let merged = merge_last_run(
            vec![entry("dot-ultron", "ok"), entry("dot-claude", "ok")],
            applicable,
            root,
        );
        assert_eq!(by(&merged, "dot-ultron").status, "failed");
        assert_eq!(
            by(&merged, "dot-ultron").last_result.as_deref(),
            Some("failed")
        );
        assert_eq!(by(&merged, "dot-claude").status, "ok");
        assert_eq!(by(&merged, "dot-claude").last_result.as_deref(), Some("ok"));
        // La fuente absoluta que nunca se copió aparece como fila propia.
        let tfg = by(&merged, "abs-D-TFG");
        assert!(!tfg.exists);
        assert_eq!(tfg.status, "failed");
        assert_eq!(overall_status_for(&merged, applicable), "failed");
    }

    #[test]
    fn a_clean_run_keeps_the_age_based_status() {
        let r = run(r#"{"backup_root": "/bk", "brain_snapshot": true,
            "results": {".claude": {"ok": true, "code": 1, "skipped": false}}}"#);
        let root = Path::new("/bk");
        let applicable = applicable_run(Some(&r), root);
        let merged = merge_last_run(vec![entry("dot-claude", "stale")], applicable, root);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].status, "stale");
        assert_eq!(overall_status_for(&merged, applicable), "stale");
    }

    #[test]
    fn a_failed_brain_snapshot_alone_fails_the_card() {
        let r = run(r#"{"backup_root": "/bk", "brain_snapshot": false,
            "results": {".claude": {"ok": true, "code": 1, "skipped": false}}}"#);
        let root = Path::new("/bk");
        let applicable = applicable_run(Some(&r), root);
        let merged = merge_last_run(vec![entry("dot-claude", "ok")], applicable, root);
        assert_eq!(merged[0].status, "ok");
        assert_eq!(overall_status_for(&merged, applicable), "failed");
    }

    #[test]
    fn dry_runs_and_other_roots_do_not_change_states() {
        let root = Path::new("/bk");
        let other = run(&FAILED_RUN.replace("\"/bk\"", "\"/otro\""));
        assert!(applicable_run(Some(&other), root).is_none());
        let dry =
            run(&FAILED_RUN.replace("{\"backup_root\"", "{\"dry_run\": true, \"backup_root\""));
        assert!(dry.dry_run);
        assert!(applicable_run(Some(&dry), root).is_none());
        let merged = merge_last_run(vec![entry("dot-ultron", "ok")], None, root);
        assert_eq!(merged[0].status, "ok");
        assert_eq!(overall_status_for(&merged, None), "ok");
    }
}
