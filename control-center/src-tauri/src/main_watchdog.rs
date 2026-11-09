// Vigilante del hilo principal.
//
// En Tauri 2 los comandos síncronos, los menús de la bandeja y los eventos de
// ventana corren en el hilo principal: si uno se bloquea, se congelan a la
// vez Sessions, el Control Center y Pupus, y el proceso no deja rastro (no
// hay evento de «Application Hang» si se cierra desde el Administrador de
// tareas). Un hilo propio encola un latido en el hilo principal cada segundo
// y, si tarda más de `STALL_MS` en atenderse, lo apunta en
// `~/.ultron/logs/ui-stalls.jsonl`: una línea al detectarlo y otra al
// recuperarse con la duración total.

use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

const BEAT: Duration = Duration::from_secs(1);
const STALL_MS: u64 = 3_000;

/// Eventos emitidos a las webviews (cada uno es un `eval` en el hilo
/// principal). Con él, una línea de bloqueo distingue una inundación de
/// eventos (stream del chat, PTY) de una llamada que se queda colgada.
static EMITS: AtomicU64 = AtomicU64::new(0);

/// Lo llaman los emisores de alto volumen (sink de Sessions, lector de PTY).
pub fn count_emit() {
    EMITS.fetch_add(1, Ordering::Relaxed);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Bloqueo en curso: ms sin atender un latido, o None si va al día.
pub fn stalled_for(last_beat_ms: u64, now: u64) -> Option<u64> {
    let gap = now.saturating_sub(last_beat_ms);
    (gap > STALL_MS).then_some(gap)
}

fn log_line(event: &str, ms: u64, emits_per_s: u64) {
    let Some(path) =
        dirs::home_dir().map(|h| h.join(".ultron").join("logs").join("ui-stalls.jsonl"))
    else {
        return;
    };
    let line = serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "event": event,
        "ms": ms,
        "emits_per_s": emits_per_s,
        "pid": std::process::id(),
    });
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| writeln!(f, "{line}"));
    if let Err(e) = written {
        tracing::warn!(error = %e, "main_watchdog: no se pudo escribir ui-stalls.jsonl");
    }
}

/// Arranca el vigilante en un hilo propio. Best-effort: si el hilo no se
/// puede crear, se registra y la app sigue.
pub fn start(app: AppHandle) {
    let last_beat = Arc::new(AtomicU64::new(now_ms()));
    let spawned = std::thread::Builder::new()
        .name("main-watchdog".into())
        .spawn(move || {
            let mut stall_start: Option<u64> = None;
            let mut emits_before = EMITS.load(Ordering::Relaxed);
            loop {
                let beat = Arc::clone(&last_beat);
                // Si el bucle de eventos ya cerró, la app está saliendo.
                if app
                    .run_on_main_thread(move || beat.store(now_ms(), Ordering::Relaxed))
                    .is_err()
                {
                    return;
                }
                std::thread::sleep(BEAT);
                let last = last_beat.load(Ordering::Relaxed);
                let emits_now = EMITS.load(Ordering::Relaxed);
                let emits_per_s = emits_now.saturating_sub(emits_before);
                emits_before = emits_now;
                match (stalled_for(last, now_ms()), stall_start) {
                    (Some(gap), None) => {
                        stall_start = Some(last);
                        tracing::warn!(ms = gap, emits_per_s, "hilo principal bloqueado");
                        log_line("stall", gap, emits_per_s);
                    }
                    (None, Some(start)) => {
                        stall_start = None;
                        let total = last.saturating_sub(start);
                        tracing::warn!(ms = total, emits_per_s, "hilo principal recuperado");
                        log_line("recovered", total, emits_per_s);
                    }
                    _ => {}
                }
            }
        });
    if let Err(e) = spawned {
        tracing::error!(error = %e, "main_watchdog: no se pudo crear el hilo");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_latido_reciente_no_es_bloqueo() {
        assert_eq!(stalled_for(10_000, 12_000), None);
        assert_eq!(stalled_for(10_000, 10_000 + STALL_MS), None);
    }

    #[test]
    fn un_latido_viejo_si_es_bloqueo() {
        assert_eq!(
            stalled_for(10_000, 10_000 + STALL_MS + 1),
            Some(STALL_MS + 1)
        );
    }

    #[test]
    fn un_reloj_que_retrocede_no_cuenta_como_bloqueo() {
        assert_eq!(stalled_for(20_000, 10_000), None);
    }
}
