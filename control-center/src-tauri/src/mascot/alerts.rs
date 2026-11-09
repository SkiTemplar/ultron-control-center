// Mascota — avisos de builds y tests en rojo (cero tokens).
//
// Un hilo («pupus-alerts») cada 3 s, mientras el ajuste `build_alerts` esté
// activo, mira:
//   * los transcripts de Claude Code (transcripts.rs): comandos de build
//     con salida distinta de 0, asentados al cerrar el turno;
//   * los resultados del hook run-project-tests (test_results.rs).
// Lo que encuentra va a un anillo de 50 avisos con número de secuencia; la
// webview pregunta `mascot_desk_alerts(after)` y recibe solo los nuevos.
//
// Alcance real: solo Claude Code (Sessions y la CLI suelta), no Codex.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::test_results::{self, TestWatch};
use super::transcripts::Tailer;

const TICK: Duration = Duration::from_secs(3);
const RING: usize = 50;

static WATCHING: AtomicBool = AtomicBool::new(false);
static ALERTS: Mutex<Ring> = Mutex::new(Ring {
    items: VecDeque::new(),
    seq: 0,
});

/// Lo que detectan transcripts.rs y test_results.rs.
#[derive(Debug, Clone, PartialEq)]
pub struct RawAlert {
    /// "tests" (hook) o "build" (transcript).
    pub source: &'static str,
    /// false = un éxito que retira el aviso anterior.
    pub failed: bool,
    pub what: String,
    pub detail: String,
    pub cwd: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeskAlert {
    pub seq: u64,
    pub source: &'static str,
    /// "failed" o "cleared".
    pub state: &'static str,
    /// «cargo check», «tsc», «tests»…
    pub what: String,
    pub detail: String,
    pub cwd: String,
    /// Nombre de la carpeta del proyecto (para el bocadillo y el editor).
    pub project_hint: String,
    pub claude_session_id: Option<String>,
    pub at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeskAlertsBatch {
    pub alerts: Vec<DeskAlert>,
    pub last_seq: u64,
}

struct Ring {
    items: VecDeque<DeskAlert>,
    seq: u64,
}

impl Ring {
    fn push(&mut self, raw: RawAlert, at: String) {
        self.seq += 1;
        if self.items.len() >= RING {
            self.items.pop_front();
        }
        self.items.push_back(DeskAlert {
            seq: self.seq,
            source: raw.source,
            state: if raw.failed { "failed" } else { "cleared" },
            project_hint: project_hint(&raw.cwd),
            what: raw.what,
            detail: raw.detail,
            cwd: raw.cwd,
            claude_session_id: raw.session_id,
            at,
        });
    }

    fn after(&self, after: u64) -> DeskAlertsBatch {
        DeskAlertsBatch {
            alerts: self
                .items
                .iter()
                .filter(|a| a.seq > after)
                .cloned()
                .collect(),
            last_seq: self.seq,
        }
    }
}

/// «C:\Users\x\Arcadia» → «Arcadia».
pub fn project_hint(cwd: &str) -> String {
    cwd.trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn publish(found: Vec<RawAlert>) {
    if found.is_empty() {
        return;
    }
    let at = chrono::Utc::now().to_rfc3339();
    let mut ring = ALERTS.lock().unwrap_or_else(|p| p.into_inner());
    for raw in found {
        ring.push(raw, at.clone());
    }
}

/// Estado del vigilante: se rehace al encender el ajuste (empieza al final
/// de cada fichero, sin avisos de lo que pasó con él apagado).
#[derive(Default)]
struct Watch {
    tailer: Tailer,
    tests: TestWatch,
}

fn tick(w: &mut Watch, projects: Option<&Path>) {
    let mut found = Vec::new();
    if let Some(dir) = projects {
        found.extend(w.tailer.scan(dir, now_ms()));
    }
    if let Some(dir) = test_results::state_dir() {
        found.extend(w.tests.scan(&dir));
    }
    publish(found);
}

/// ¿Vigila esta vuelta? Mascota activada, con ventana y el ajuste de
/// avisos encendido. Pura, para los tests.
pub fn alerts_active(s: &super::MascotSettings, has_window: bool) -> bool {
    super::watchers_active(s, has_window) && s.build_alerts
}

pub fn start_watch(app: AppHandle) {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let projects = dirs::home_dir().map(|h| h.join(".claude").join("projects"));
    let spawned = std::thread::Builder::new()
        .name("pupus-alerts".into())
        .spawn(move || {
            let mut watch: Option<Watch> = None;
            loop {
                std::thread::sleep(TICK);
                let has_window = app.get_webview_window(super::LABEL).is_some();
                if !alerts_active(&super::load_settings(), has_window) {
                    // Al volver, el Tailer nuevo empieza al final de cada fichero.
                    watch = None;
                    continue;
                }
                let w = watch.get_or_insert_with(Watch::default);
                tick(w, projects.as_deref());
            }
        });
    if let Err(e) = spawned {
        tracing::error!(error = %e, "mascota: no arrancó el vigilante de builds");
    }
}

/// Avisos con secuencia mayor que `after` (0 = todos los del anillo).
#[tauri::command]
pub fn mascot_desk_alerts(after: u64) -> DeskAlertsBatch {
    ALERTS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .after(after)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(failed: bool) -> RawAlert {
        RawAlert {
            source: "build",
            failed,
            what: "cargo check".into(),
            detail: "error[E0308]".into(),
            cwd: "C:\\demo\\Arcadia\\".into(),
            session_id: None,
        }
    }

    #[test]
    fn el_anillo_numera_y_devuelve_solo_lo_nuevo() {
        let mut r = Ring {
            items: VecDeque::new(),
            seq: 0,
        };
        r.push(raw(true), "t".into());
        r.push(raw(false), "t".into());
        let b = r.after(1);
        assert_eq!(b.last_seq, 2);
        assert_eq!(b.alerts.len(), 1);
        assert_eq!(b.alerts[0].state, "cleared");
        assert_eq!(b.alerts[0].project_hint, "Arcadia");
        assert!(r.after(2).alerts.is_empty(), "nada nuevo");
    }

    #[test]
    fn sin_mascota_o_sin_ventana_no_se_vigila() {
        let on = super::super::MascotSettings {
            build_alerts: true,
            ..Default::default()
        };
        assert!(alerts_active(&on, true));
        // Casos negativos: mascota apagada, sin ventana o ajuste apagado.
        let off = super::super::MascotSettings {
            enabled: false,
            ..on.clone()
        };
        assert!(!alerts_active(&off, true), "mascota apagada");
        assert!(!alerts_active(&on, false), "sin ventana");
        let no_alerts = super::super::MascotSettings {
            build_alerts: false,
            ..on
        };
        assert!(!alerts_active(&no_alerts, true));
    }

    #[test]
    fn el_anillo_no_pasa_de_su_tope() {
        let mut r = Ring {
            items: VecDeque::new(),
            seq: 0,
        };
        for _ in 0..(RING + 7) {
            r.push(raw(true), "t".into());
        }
        assert_eq!(r.items.len(), RING);
        assert_eq!(r.after(0).alerts[0].seq, 8);
    }

    #[test]
    fn se_serializa_en_camel_case() {
        let mut r = Ring {
            items: VecDeque::new(),
            seq: 0,
        };
        r.push(raw(true), "t".into());
        let v = serde_json::to_value(r.after(0)).unwrap();
        assert!(v["alerts"][0].get("projectHint").is_some());
        assert!(v["alerts"][0].get("claudeSessionId").is_some());
        assert!(v.get("lastSeq").is_some());
    }
}
