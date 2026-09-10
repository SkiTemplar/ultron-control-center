//! Hilos de fondo del daemon: el barrido que suelta los modelos por inactividad
//! y el guard de huérfano que mata al proceso si se configuró una ventana.
//!
//! Son dos relojes distintos y con propósitos distintos: el primero cuida la RAM
//! (los modelos son ~1,5 GB cada uno) y el segundo, la existencia del proceso.
//! Por defecto solo el primero hace algo: el daemon es residente.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::lockfile::{now_ms, remove_lockfile_if_owned};

/// Minutos sin una sola petición tras los que el daemon sale (guard de
/// huérfano). Se lee de `ULTRON_DAEMON_IDLE_MIN`; `0` = no salir nunca, y es el
/// DEFAULT desde 2026-09-10.
///
/// Antes eran 30 minutos fijos y el daemon moría en los huecos de una sesión:
/// tres prompts de una misma sesión entraron SIN memoria el 2026-09-10
/// (hook-errors.jsonl 19:08, 19:20 y 21:05 UTC; el lockfile se reclamó de nuevo
/// a las 21:05:00, es decir, el proceso ya no estaba). El motivo original de
/// salir era la RAM y ya no aplica: los modelos se liberan por su cuenta
/// (`ULTRON_MODEL_IDLE_MIN`, ver `qdrant::release_idle_models`), así que el
/// proceso en reposo cuesta ~40 MB medidos. Quien prefiera el comportamiento
/// viejo pone minutos en la variable.
///
/// Esto NO afecta ni a la salida explícita por `shutdown` ni a la retirada
/// inmediata del perdedor del lockfile (ver `claim_lockfile`).
const DAEMON_IDLE_MIN_DEFAULT: i64 = 0;

/// Ventana de inactividad en milisegundos a partir del valor crudo de la
/// variable; `0` = nunca salir. Un valor no numérico o negativo cae al default
/// (residente) en vez de inventar un plazo. Puro -> testeable sin tocar el
/// entorno del proceso.
fn daemon_idle_ms_from(raw: Option<&str>) -> i64 {
    let min = raw
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(DAEMON_IDLE_MIN_DEFAULT);
    if min <= 0 {
        return 0;
    }
    min * 60_000
}

/// Igual que [`daemon_idle_ms_from`] pero leyendo el entorno del proceso. El
/// `.env` del usuario lo carga `main.rs` con dotenvy al arrancar, así que un
/// cambio de valor exige reiniciar el daemon.
fn daemon_idle_ms() -> i64 {
    daemon_idle_ms_from(std::env::var("ULTRON_DAEMON_IDLE_MIN").ok().as_deref())
}

/// Barrido de inactividad de los modelos (2026-08-15): E5 son ~1,5 GB
/// residentes y el cross-encoder otros ~1,5 GB. El daemon vive toda la sesion,
/// asi que sin esto la RAM se queda tomada aunque no se consulte en horas. Cada
/// minuto se comprueba el reloj de uso y se sueltan los modelos que hayan pasado
/// su ventana (`ULTRON_MODEL_IDLE_MIN`, 0 = nunca soltar). La siguiente peticion
/// los recarga: se cambia RAM por unos segundos de warmup.
pub(super) fn spawn_model_release_sweep() {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(60));
        let soltados = crate::qdrant::release_idle_models();
        if !soltados.is_empty() {
            eprintln!("[serve] modelos liberados por inactividad: {soltados:?}");
        }
    });
}

/// Watchdog de inactividad del PROCESO (guard de huérfano). El bucle sigue
/// corriendo siempre, pero solo mata al proceso si hay ventana configurada: con
/// el default (0) el daemon es residente y el minuto de sueño no hace nada.
pub(super) fn spawn_idle_watchdog(last_activity: Arc<AtomicI64>, own_token: String) {
    let idle_ms = daemon_idle_ms();
    eprintln!(
        "ultron-memory serve: ventana de inactividad = {}",
        if idle_ms == 0 {
            "sin limite (residente)".to_string()
        } else {
            format!("{} min", idle_ms / 60_000)
        }
    );
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(60));
        if idle_ms > 0 && now_ms() - last_activity.load(Ordering::Relaxed) > idle_ms {
            remove_lockfile_if_owned(&own_token);
            std::process::exit(0);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sin_ventana_configurada_el_daemon_es_residente() {
        // El default y todo valor no util (vacio, no numerico, negativo) dejan
        // el watchdog inerte: el daemon no sale por inactividad.
        assert_eq!(daemon_idle_ms_from(None), 0);
        assert_eq!(daemon_idle_ms_from(Some("0")), 0);
        assert_eq!(daemon_idle_ms_from(Some("")), 0);
        assert_eq!(daemon_idle_ms_from(Some("treinta")), 0);
        assert_eq!(daemon_idle_ms_from(Some("-5")), 0);
    }

    #[test]
    fn una_ventana_en_minutos_se_convierte_a_milisegundos() {
        // Caso negativo del test de arriba: con minutos validos el watchdog SI
        // tiene plazo (y tolera espacios alrededor del valor del .env).
        assert_eq!(daemon_idle_ms_from(Some("30")), 30 * 60_000);
        assert_eq!(daemon_idle_ms_from(Some(" 5 ")), 5 * 60_000);
    }
}
