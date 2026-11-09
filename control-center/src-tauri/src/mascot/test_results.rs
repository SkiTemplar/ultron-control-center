// Mascota — tests en rojo según el hook run-project-tests.
//
// El hook (hooks/scripts/lib/run-project-tests.js) deja por proyecto
// <dir>/<proyecto>.result.json {project, cwd, status, failed_tests,
// failed_total, summary, finished_at, session_id…} y <proyecto>.state.json
// {running, …} en RUN_TESTS_STATE_DIR o ~/.ultron/.tmp/run-tests/.
//
// Un resultado nuevo (finished_at distinto del último visto) con status
// failed o timeout y sin otra ejecución en marcha es un aviso; un passed
// tras un aviso lo retira. La primera lectura de cada proyecto solo fija la
// referencia: nada de avisos de antes de arrancar.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::alerts::RawAlert;
use super::build_detect::{truncate, SUMMARY_MAX};

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RunResult {
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub failed_tests: Vec<String>,
    #[serde(default)]
    pub failed_total: u32,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub finished_at: String,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct Seen {
    finished_at: String,
    alerted: bool,
}

#[derive(Default)]
pub struct TestWatch {
    seen: HashMap<String, Seen>,
}

/// «a y b», «a, b y 3 más» o el resumen del hook.
pub fn failure_detail(r: &RunResult) -> String {
    let names: Vec<&str> = r.failed_tests.iter().take(2).map(String::as_str).collect();
    let text = if names.is_empty() {
        r.summary.clone()
    } else {
        let total = (r.failed_total as usize).max(r.failed_tests.len());
        let rest = total.saturating_sub(names.len());
        let list = names.join(", ");
        if rest > 0 {
            format!("{list} y {rest} más")
        } else {
            list
        }
    };
    truncate(&text, SUMMARY_MAX)
}

fn alert(r: &RunResult, failed: bool) -> RawAlert {
    RawAlert {
        source: "tests",
        failed,
        what: "tests".into(),
        detail: if failed {
            failure_detail(r)
        } else {
            String::new()
        },
        cwd: r.cwd.clone(),
        session_id: r.session_id.clone().filter(|s| !s.is_empty()),
    }
}

impl TestWatch {
    /// Decide si un resultado avisa. `running`: hay otra pasada en marcha.
    pub fn evaluate(&mut self, r: &RunResult, running: bool) -> Option<RawAlert> {
        let key = if r.project.is_empty() {
            r.cwd.clone()
        } else {
            r.project.clone()
        };
        let Some(seen) = self.seen.get_mut(&key) else {
            let first = Seen {
                finished_at: r.finished_at.clone(),
                alerted: false,
            };
            self.seen.insert(key, first);
            return None;
        };
        if running || r.finished_at.is_empty() || r.finished_at == seen.finished_at {
            return None;
        }
        seen.finished_at = r.finished_at.clone();
        match r.status.as_str() {
            "failed" | "timeout" => {
                seen.alerted = true;
                Some(alert(r, true))
            }
            "passed" if seen.alerted => {
                seen.alerted = false;
                Some(alert(r, false))
            }
            _ => None,
        }
    }

    /// Una vuelta sobre el directorio del hook.
    pub fn scan(&mut self, dir: &Path) -> Vec<RawAlert> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for path in entries.flatten().map(|e| e.path()) {
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some(project) = name.strip_suffix(".result.json") else {
                continue;
            };
            let Some(r) = read_json::<RunResult>(&path) else {
                continue;
            };
            let running = is_running(&dir.join(format!("{project}.state.json")));
            out.extend(self.evaluate(&r, running));
        }
        out
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn is_running(state: &Path) -> bool {
    read_json::<serde_json::Value>(state)
        .and_then(|v| v.get("running").cloned())
        .is_some_and(|r| !r.is_null())
}

/// Directorio del hook: RUN_TESTS_STATE_DIR o ~/.ultron/.tmp/run-tests.
pub fn state_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("RUN_TESTS_STATE_DIR") {
        if !d.trim().is_empty() {
            return Some(PathBuf::from(d));
        }
    }
    crate::ultron_root()
        .ok()
        .map(|r| r.join(".tmp").join("run-tests"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(json: &str) -> RunResult {
        serde_json::from_str(json).unwrap()
    }

    const PASSED_T0: &str =
        r#"{"project":"demo","cwd":"C:\\demo","status":"passed","finished_at":"t0"}"#;
    const FAILED_T1: &str = r#"{"project":"demo","cwd":"C:\\demo","status":"failed","failed_tests":["cola::drena","cola::vacia","x"],"failed_total":3,"finished_at":"t1","session_id":"s-9"}"#;

    #[test]
    fn un_fallo_nuevo_avisa_con_los_nombres() {
        let mut w = TestWatch::default();
        assert!(
            w.evaluate(&result(PASSED_T0), false).is_none(),
            "referencia"
        );
        let a = w.evaluate(&result(FAILED_T1), false).expect("aviso");
        assert!(a.failed);
        assert_eq!(a.detail, "cola::drena, cola::vacia y 1 más");
        assert_eq!(a.session_id.as_deref(), Some("s-9"));
    }

    #[test]
    fn el_mismo_resultado_no_se_repite_y_el_primero_no_avisa() {
        let mut w = TestWatch::default();
        // Caso negativo: un fallo de antes de arrancar no avisa.
        assert!(w.evaluate(&result(FAILED_T1), false).is_none());
        assert!(
            w.evaluate(&result(FAILED_T1), false).is_none(),
            "mismo finished_at"
        );
    }

    #[test]
    fn con_una_pasada_en_marcha_espera() {
        let mut w = TestWatch::default();
        w.evaluate(&result(PASSED_T0), false);
        assert!(w.evaluate(&result(FAILED_T1), true).is_none());
        assert!(w.evaluate(&result(FAILED_T1), false).is_some());
    }

    #[test]
    fn un_passed_tras_un_fallo_lo_retira() {
        let mut w = TestWatch::default();
        w.evaluate(&result(PASSED_T0), false);
        w.evaluate(&result(FAILED_T1), false);
        let ok = r#"{"project":"demo","cwd":"C:\\demo","status":"passed","finished_at":"t2"}"#;
        let a = w.evaluate(&result(ok), false).expect("cleared");
        assert!(!a.failed);
        let ok3 = r#"{"project":"demo","cwd":"C:\\demo","status":"passed","finished_at":"t3"}"#;
        assert!(
            w.evaluate(&result(ok3), false).is_none(),
            "sin aviso vigente"
        );
    }

    #[test]
    fn sin_nombres_usa_el_resumen() {
        let r = result(r#"{"status":"timeout","summary":"timeout tras 90 s"}"#);
        assert_eq!(failure_detail(&r), "timeout tras 90 s");
    }

    #[test]
    fn lee_el_directorio_del_hook() {
        let dir = tempfile::tempdir().unwrap();
        let res = dir.path().join("demo.result.json");
        std::fs::write(&res, PASSED_T0).unwrap();
        std::fs::write(dir.path().join("demo.state.json"), r#"{"running":null}"#).unwrap();
        let mut w = TestWatch::default();
        assert!(w.scan(dir.path()).is_empty());
        std::fs::write(&res, FAILED_T1).unwrap();
        assert_eq!(w.scan(dir.path()).len(), 1);
    }
}
