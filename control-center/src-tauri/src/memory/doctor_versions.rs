// memory/doctor_versions.rs — check `versions` de `doctor` (submódulo de
// `doctor.rs`; usa sus constructores de `DoctorCheck`).
//
// Dos maneras de que el binario en uso no sea el que se cree:
//   - stale (k+6): el `bin/ultron-memory.exe` desplegado es más nuevo que el que
//     corre (no se reinició el proceso tras el redeploy).
//   - dirty (K1, 2026-10-23): el binario se compiló con cambios sin commitear en
//     `control-center/`, así que su `git_sha` no describe su código.
// La decisión es pura (`versions_verdict`) y se prueba sin HOME ni binarios.

use super::DoctorCheck;
use crate::build_stamp::{self, BuildStamp};

/// Margen de mtime (s) para no confundir la copia del redeploy con un stale.
const STALE_MARGIN_SECS: u64 = 5;

/// Veredicto del check a partir del sello del binario y los mtimes del binario
/// en uso (`running`) y del desplegado (`deployed`).
pub(super) fn versions_verdict(
    stamp: BuildStamp,
    running: Option<u64>,
    deployed: Option<u64>,
    data: serde_json::Value,
) -> DoctorCheck {
    if stamp.dirty == Some(true) {
        return DoctorCheck::warn(
            "versions",
            format!(
                "binario compilado con cambios sin commitear (git_sha {} + dirty): el SHA no describe el código; commitea y recompila",
                stamp.git_sha
            ),
            data,
        );
    }
    match (running, deployed) {
        (Some(rm), Some(dm)) if dm > rm + STALE_MARGIN_SECS => DoctorCheck::warn(
            "versions",
            "el binario desplegado es mas nuevo que el que corre (posible stale)",
            data,
        ),
        _ => DoctorCheck::ok(
            "versions",
            format!(
                "binario en uso == desplegado (o no aplica) · git_sha {}{}",
                stamp.git_sha,
                if stamp.dirty.is_none() {
                    " (sin git al compilar)"
                } else {
                    ""
                }
            ),
            data,
        ),
    }
}

fn mtime_secs(p: &std::path::Path) -> Option<u64> {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

/// Check `versions`: sello del binario en uso + stale frente al desplegado.
pub(super) fn check_running_binary() -> DoctorCheck {
    let stamp = build_stamp::current();
    let stamp_data = serde_json::json!({ "git_sha": stamp.git_sha, "dirty": stamp.dirty });
    let running = std::env::current_exe().ok();
    let deployed = super::ultron_home().map(|h| h.join("bin").join("ultron-memory.exe"));
    let (Some(running), Some(deployed)) = (running, deployed) else {
        let data = serde_json::json!({ "determinable": false, "build": stamp_data });
        return versions_verdict(stamp, None, None, data);
    };
    let (rm, dm) = (mtime_secs(&running), mtime_secs(&deployed));
    let data = serde_json::json!({
        "running": running.to_string_lossy(),
        "deployed": deployed.to_string_lossy(),
        "running_mtime": rm,
        "deployed_mtime": dm,
        "build": stamp_data,
    });
    versions_verdict(stamp, rm, dm, data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics_native::Severity;

    const LIMPIO: BuildStamp = BuildStamp {
        git_sha: "abc1234",
        dirty: Some(false),
    };

    fn verdict(stamp: BuildStamp, rm: Option<u64>, dm: Option<u64>) -> DoctorCheck {
        versions_verdict(stamp, rm, dm, serde_json::json!({}))
    }

    #[test]
    fn un_binario_limpio_y_al_dia_es_ok() {
        let c = verdict(LIMPIO, Some(100), Some(100));
        assert_eq!(c.severity, Severity::Ok);
        assert!(c.detail.contains("abc1234"), "{}", c.detail);
    }

    #[test]
    fn un_binario_dirty_avisa_aunque_este_al_dia() {
        let sucio = BuildStamp {
            dirty: Some(true),
            ..LIMPIO
        };
        let c = verdict(sucio, Some(100), Some(100));
        assert_eq!(c.severity, Severity::Warn);
        assert!(c.detail.contains("sin commitear"), "{}", c.detail);
        // Sin mtimes (no determinable) sigue avisando.
        assert_eq!(verdict(sucio, None, None).severity, Severity::Warn);
    }

    #[test]
    fn el_stale_sigue_avisando_y_el_margen_no() {
        assert_eq!(
            verdict(LIMPIO, Some(100), Some(200)).severity,
            Severity::Warn
        );
        // Caso negativo: dentro del margen de la copia no es stale.
        assert_eq!(verdict(LIMPIO, Some(100), Some(104)).severity, Severity::Ok);
    }

    #[test]
    fn sin_git_al_compilar_no_avisa_pero_lo_dice() {
        let sin_git = BuildStamp {
            git_sha: "unknown",
            dirty: None,
        };
        let c = verdict(sin_git, Some(100), Some(100));
        assert_eq!(c.severity, Severity::Ok);
        assert!(c.detail.contains("sin git"), "{}", c.detail);
    }
}
