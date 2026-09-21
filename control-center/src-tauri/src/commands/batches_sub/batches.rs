// ULTRON Control Center - Batches commands
use crate::batches::{self, BatchCleanupReport, BatchEntry, BatchRunResult};
use crate::batches_queue::{self, BatchQueueEntry};

#[tauri::command]
pub async fn list_batches() -> Result<Vec<BatchEntry>, String> {
    tauri::async_runtime::spawn_blocking(batches::list_batches_inner)
        .await
        .map_err(|e| e.to_string())?
}

/// Execute a batch script by name.
///
/// The execution is bounded by a **5-minute timeout**. If the script has not
/// exited within that window (e.g. an infinite PowerShell loop, a blocking
/// `Read-Host`, or a hung child process) the future is cancelled, an error is
/// returned to the UI, and the failure is recorded in the batch queue so it is
/// never silently dropped.
///
/// Cada ejecución queda registrada en `workflow-runs.db` como
/// `batch:<nombre>` (2026-09-21). El escritor de esa base era la delegación
/// síncrona de `agent_orchestration/delegate.rs`, borrada en f1e44e8f al podar
/// 4 comandos Tauri sin consumidor: se quitó el productor porque su ENTRADA no
/// se usaba, sin ver que su SALIDA la leían tres sitios que sí están cableados
/// (`WorkflowRunsPanel`, `workflow_get_runs` y el `next_action` del resume en
/// `session_resume.rs`). Desde entonces el panel mostraba lista vacía y la
/// rama "continue workflow" del resume era inalcanzable: la tabla tenía 3
/// filas, todas de test, del 5 de junio.
///
/// Un batch es la unidad de ejecución real que le queda a la app, así que es
/// el productor correcto: un paso, tres estados (running al abrir, success o
/// failed al cerrar) y un timeout que ya distingue el fallo.
///
/// El registro es best-effort: un fallo escribiendo en la base NUNCA cambia el
/// resultado del batch, que es lo que el usuario está esperando.
#[tauri::command]
pub async fn execute_batch(name: String) -> Result<BatchRunResult, String> {
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

    // `project_id` va a None a propósito: un batch vive en ~/.ultron/batches y
    // no pertenece a ningún proyecto. El panel lo muestra sin etiqueta.
    let run_id =
        crate::workflow_runs::record_run_inner(format!("batch:{name}"), None, None, 1).ok();

    let task = tauri::async_runtime::spawn_blocking({
        let name = name.clone();
        move || batches::execute_batch_inner(name)
    });

    match tokio::time::timeout(TIMEOUT, task).await {
        Ok(join_result) => {
            let outcome = join_result.map_err(|e| e.to_string())?;
            if let Some(id) = run_id {
                close_batch_run(id, &outcome);
            }
            outcome
        }
        Err(_elapsed) => {
            // The blocking thread is detached (spawn_blocking cannot be
            // cancelled), but from the UI perspective the command timed out.
            // Record the failure in the queue so it is never silently lost.
            let msg = "batch execution timed out after 5 minutes".to_string();
            let path_hint = {
                let dir = batches::batches_dir().unwrap_or_default();
                dir.join(&name).to_string_lossy().to_string()
            };
            if let Err(qe) = crate::batches_queue::record_inner(
                &name,
                &path_hint,
                crate::batches_queue::BatchQueueReason::Failed,
                Some(msg.clone()),
            ) {
                eprintln!("[batches] CRITICAL: could not enqueue timed-out batch '{name}': {qe}");
            }
            if let Some(id) = run_id {
                let _ = crate::workflow_runs::update_run_inner(
                    id,
                    crate::workflow_runs::RunUpdate {
                        status: Some(crate::workflow_runs::RunStatus::Failed),
                        steps_completed: Some(0),
                        steps_total: None,
                        output_summary: None,
                        error: Some(msg.clone()),
                        ended_at: Some(chrono::Utc::now()),
                    },
                );
            }
            Err(msg)
        }
    }
}

/// Cierra el run de un batch que ya terminó. Best-effort: el resultado del
/// batch manda, y un fallo de la base no puede alterarlo ni hacer ruido en la
/// UI. Por eso ignora el error de escritura en vez de propagarlo.
fn close_batch_run(id: i64, outcome: &Result<BatchRunResult, String>) {
    let update = batch_run_update(outcome, chrono::Utc::now());
    let _ = crate::workflow_runs::update_run_inner(id, update);
}

/// El resumen viaja al panel y a un `title` del DOM: se recorta por
/// CARACTERES, no por bytes — stdout puede traer UTF-8 multibyte y cortar a
/// mitad de un carácter entraría en pánico.
fn resumen(raw: &str) -> String {
    let limpio = raw.trim();
    if limpio.is_empty() {
        return String::new();
    }
    let mut s: String = limpio.chars().take(200).collect();
    if limpio.chars().count() > 200 {
        s.push('…');
    }
    s
}

/// Traduce el desenlace de un batch al `RunUpdate` que se persiste. El
/// instante se inyecta para que la función sea pura y comprobable.
fn batch_run_update(
    outcome: &Result<BatchRunResult, String>,
    ended_at: chrono::DateTime<chrono::Utc>,
) -> crate::workflow_runs::RunUpdate {
    use crate::workflow_runs::{RunStatus, RunUpdate};

    let ended_at = Some(ended_at);
    match outcome {
        // `success: false` con exit code es un batch que corrió y salió mal:
        // eso es Failed, no Success. El comando devuelve Ok en ambos casos.
        Ok(r) if r.success => RunUpdate {
            status: Some(RunStatus::Success),
            steps_completed: Some(1),
            steps_total: None,
            output_summary: Some(resumen(&r.stdout)),
            error: None,
            ended_at,
        },
        Ok(r) => RunUpdate {
            status: Some(RunStatus::Failed),
            steps_completed: Some(1),
            steps_total: None,
            output_summary: Some(resumen(&r.stdout)),
            error: Some(match r.exit_code {
                Some(code) => format!("exit code {code}: {}", resumen(&r.stderr)),
                None => resumen(&r.stderr),
            }),
            ended_at,
        },
        Err(e) => RunUpdate {
            status: Some(RunStatus::Failed),
            steps_completed: Some(0),
            steps_total: None,
            output_summary: None,
            error: Some(e.clone()),
            ended_at,
        },
    }
}

/// Delete a single batch script by name (user-initiated, no age filter).
/// The name must be a bare filename — path separators and `..` are rejected.
#[tauri::command]
pub async fn delete_batch_single(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || batches::delete_batch_single_inner(name))
        .await
        .map_err(|e| e.to_string())?
}

// Higiene 2026-08-12 (audit 08-09 #41, decidido por el usuario):
// cleanup_old_batches borrado — superseded por clear_all_batches (registrado)
// y sin consumidor desde entonces.

/// Delete ALL batch scripts (user-initiated "Clear all", with confirmation in
/// the UI). card-bug-runbatch-clear.
#[tauri::command]
pub async fn clear_all_batches() -> Result<BatchCleanupReport, String> {
    tauri::async_runtime::spawn_blocking(batches::clear_all_batches_inner)
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Run Batch queue (persistent "rejected / ai_cannot_execute / failed" capture)
// ---------------------------------------------------------------------------

/// List every queued batch (rejected by a sandbox/permission prompt, unrunnable
/// by the AI, or failed at runtime). Drains the Stop-hook pending file first so
/// the UI always reflects the latest captures. Newest first.
#[tauri::command]
pub async fn batches_list_queue() -> Result<Vec<BatchQueueEntry>, String> {
    tauri::async_runtime::spawn_blocking(batches_queue::list_inner)
        .await
        .map_err(|e| e.to_string())?
}

/// Re-queue an entry by id: bumps attempts + refreshes its timestamp so it
/// surfaces as "pending retry". Does NOT auto-run — the actual run is still a
/// human click via `execute_batch` (security: a rejected command must never
/// become 1-click-auto-runnable).
#[tauri::command]
pub async fn batches_requeue(id: String) -> Result<BatchQueueEntry, String> {
    tauri::async_runtime::spawn_blocking(move || batches_queue::requeue_inner(&id))
        .await
        .map_err(|e| e.to_string())?
}

/// Remove an entry from the queue by id (user dismiss, or after a successful
/// manual run).
#[tauri::command]
pub async fn batches_dismiss_queue(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || batches_queue::dismiss_inner(&id))
        .await
        .map_err(|e| e.to_string())?
}

// Higiene 2026-08-12 (audit 08-09 #41, decidido por el usuario):
// batches_enqueue_command borrado — la via de encolar comandos ad-hoc nunca
// se expuso en la UI; la captura real llega por el Stop hook (pending file).

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow_runs::RunStatus;

    fn instante() -> chrono::DateTime<chrono::Utc> {
        use chrono::TimeZone;
        chrono::Utc
            .timestamp_opt(1_790_000_000, 0)
            .single()
            .unwrap()
    }

    fn resultado(
        success: bool,
        exit_code: Option<i32>,
        stdout: &str,
        stderr: &str,
    ) -> BatchRunResult {
        BatchRunResult {
            success,
            exit_code,
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    #[test]
    fn un_batch_correcto_cierra_el_run_como_success() {
        let u = batch_run_update(&Ok(resultado(true, Some(0), "todo bien", "")), instante());
        assert!(matches!(u.status, Some(RunStatus::Success)));
        assert_eq!(u.steps_completed, Some(1));
        assert_eq!(u.output_summary.as_deref(), Some("todo bien"));
        assert!(u.error.is_none());
        assert_eq!(u.ended_at, Some(instante()));
    }

    /// El comando devuelve Ok aunque el script salga con codigo != 0: un batch
    /// que corrio y fallo NO puede quedar registrado como exito.
    #[test]
    fn un_batch_con_exit_code_distinto_de_cero_es_failed() {
        let u = batch_run_update(
            &Ok(resultado(false, Some(3), "salida", "algo peto")),
            instante(),
        );
        assert!(matches!(u.status, Some(RunStatus::Failed)));
        assert_eq!(
            u.steps_completed,
            Some(1),
            "el paso se ejecuto, aunque fallara"
        );
        let err = u.error.expect("error");
        assert!(err.contains("exit code 3"), "{err}");
        assert!(err.contains("algo peto"), "{err}");
    }

    #[test]
    fn un_batch_sin_exit_code_deja_solo_el_stderr() {
        let u = batch_run_update(&Ok(resultado(false, None, "", "sin codigo")), instante());
        assert_eq!(u.error.as_deref(), Some("sin codigo"));
    }

    /// Un fallo del propio comando (timeout, spawn roto) no ejecuto ningun paso.
    #[test]
    fn un_error_del_comando_no_cuenta_pasos_completados() {
        let u = batch_run_update(&Err("batch execution timed out".into()), instante());
        assert!(matches!(u.status, Some(RunStatus::Failed)));
        assert_eq!(u.steps_completed, Some(0));
        assert_eq!(u.error.as_deref(), Some("batch execution timed out"));
        assert!(u.output_summary.is_none());
    }

    #[test]
    fn el_resumen_recorta_sin_romper_caracteres_multibyte() {
        let largo = "ñ".repeat(500);
        let s = resumen(&largo);
        assert!(s.chars().count() <= 201, "{}", s.chars().count());
        assert!(s.ends_with('…'));
    }

    #[test]
    fn el_resumen_de_una_salida_vacia_es_vacio() {
        assert_eq!(resumen("   \n\t "), "");
        assert_eq!(resumen(""), "");
    }

    #[test]
    fn el_resumen_recorta_la_salida_larga_y_conserva_la_corta() {
        assert_eq!(resumen("  hola  "), "hola");
        let s = resumen(&"a".repeat(300));
        assert_eq!(s.chars().count(), 201);
    }
}

/// Verificacion en runtime del camino completo (escribe en workflow-runs.db de
/// esta maquina, por eso esta fuera de la suite). Ejecutar a mano con:
/// `cargo test --features qdrant escribe_un_run_real -- --ignored --nocapture`
#[cfg(test)]
mod runtime_check {
    use super::*;
    use crate::workflow_runs::{list_runs_inner, record_run_inner};

    #[test]
    #[ignore]
    fn escribe_un_run_real_y_lo_cierra() {
        let antes = list_runs_inner(None, None, 50).expect("listar").len();

        let id = record_run_inner("batch:selftest-cableado".into(), None, None, 1)
            .expect("abrir el run");
        close_batch_run(
            id,
            &Ok(BatchRunResult {
                success: true,
                exit_code: Some(0),
                stdout: "verificacion del cableado".into(),
                stderr: String::new(),
            }),
        );

        let runs = list_runs_inner(None, None, 50).expect("listar");
        println!("runs: {} -> {}", antes, runs.len());
        let mio = runs
            .iter()
            .find(|r| r.id == id)
            .expect("el run recien escrito aparece en la lectura");
        println!(
            "  id={} workflow_id={} status={:?} pasos={}/{} resumen={}",
            mio.id,
            mio.workflow_id,
            mio.status,
            mio.steps_completed,
            mio.steps_total,
            mio.output_summary
        );
        assert_eq!(mio.workflow_id, "batch:selftest-cableado");
        assert!(mio.ended_at.is_some(), "el run debe quedar cerrado");
        assert_eq!(mio.output_summary, "verificacion del cableado");
    }
}
