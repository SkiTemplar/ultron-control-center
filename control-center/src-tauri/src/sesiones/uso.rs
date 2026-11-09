// sesiones/uso.rs — Ritmo de uso del plan para la pestaña Uso
// (`sesiones_usage_pace`).
//
// No repite el cálculo: llama al mismo puente que el mod `ultron-uso`
// (`mods/ultron-uso/bin/uso.cjs`, que usa `hooks/scripts/lib/usage-pace.js` y
// el horario de `cockpit/usage-schedule.json`), así el panel y el mod dan las
// mismas cifras. Devuelve su JSON tal cual: `{ windows, weekInFiveHourPct }`.
//
// Fuente del uso (`plan_usage`): primero la última muestra de
// `logs/usage-history.jsonl` (el `rate_limits` que Claude Code pasa a
// `cockpit/statusline.js`, la misma que lee el mod) si tiene menos de
// `MAX_EDAD_LOCAL`; si no hay muestra reciente, el endpoint OAuth de
// `plan_limits` con su caché y su espera tras un fallo.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use serde_json::{json, Value};

use super::motores::{self, Program};
use super::types::{PlanUsage, UsageSource, UsageWindow};

const BRIDGE: &str = "mods/ultron-uso/bin/uso.cjs";
/// Tope del puente: lee dos JSON locales y responde en milisegundos.
const TOPE_PUENTE: Duration = Duration::from_secs(10);
const HISTORIAL: &str = "logs/usage-history.jsonl";
/// Una muestra más vieja no vale: sin sesión viva nadie la actualiza.
const MAX_EDAD_LOCAL: chrono::Duration = chrono::Duration::minutes(5);
/// Cola leída del historial: cada línea ocupa unos 250 bytes.
const COLA_HISTORIAL: u64 = 64 * 1024;

/// Ventana de una muestra local: `{ pct, resets_at }` (segundos Unix).
/// `None` si falta el porcentaje o el instante, o si ya se reinició.
fn ventana_local(v: Option<&Value>, now: DateTime<Utc>) -> Result<Option<UsageWindow>, ()> {
    let Some(v) = v.filter(|v| v.is_object()) else {
        return Ok(None);
    };
    let percent = v.get("pct").and_then(Value::as_f64).ok_or(())?;
    let reset = v
        .get("resets_at")
        .and_then(Value::as_i64)
        .and_then(|s| Utc.timestamp_opt(s, 0).single())
        .ok_or(())?;
    if reset <= now {
        return Err(());
    }
    Ok(Some(UsageWindow {
        percent,
        resets_at: Some(reset.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
    }))
}

/// Uso a partir de la última línea válida del historial, si es reciente.
/// Una ventana ya reiniciada o incompleta invalida la muestra (que decida el
/// endpoint): un porcentaje del ciclo anterior es peor que no tener dato.
pub fn uso_local(cola: &str, now: DateTime<Utc>) -> Option<PlanUsage> {
    let linea = cola
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<Value>(l.trim()).ok())?;
    let ts = linea
        .get("ts")
        .and_then(Value::as_str)
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())?
        .with_timezone(&Utc);
    if now - ts > MAX_EDAD_LOCAL {
        return None;
    }
    let limites = linea.get("limites")?;
    let five_hour = ventana_local(limites.get("five_hour"), now).ok()?;
    let seven_day = ventana_local(limites.get("seven_day"), now).ok()?;
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    Some(PlanUsage {
        five_hour,
        seven_day,
        subscription_type: None,
        stale: false,
        source: UsageSource::Local,
        fetched_at_ms: u64::try_from(ts.timestamp_millis()).unwrap_or(0),
        last_error: None,
    })
}

/// Lee la cola del historial de `root` y aplica `uso_local`.
pub fn uso_local_de(root: &Path, now: DateTime<Utc>) -> Option<PlanUsage> {
    let cola = super::ganchos::read_tail(&root.join(HISTORIAL), COLA_HISTORIAL);
    uso_local(&cola, now)
}

/// `PlanLimits` del endpoint (o su caché) en la forma de la ventana Sesiones.
pub fn desde_limites(l: crate::plan_limits::PlanLimits) -> PlanUsage {
    let w = |p: Option<crate::plan_limits::PlanWindow>| {
        p.map(|p| UsageWindow {
            percent: p.utilization,
            resets_at: p.resets_at,
        })
    };
    PlanUsage {
        five_hour: w(l.five_hour),
        seven_day: w(l.seven_day),
        subscription_type: l.subscription_type,
        stale: l.stale,
        source: UsageSource::Oauth,
        fetched_at_ms: l.fetched_at.saturating_mul(1000),
        last_error: l.last_error,
    }
}

/// Uso del plan: la muestra local reciente o, si no la hay, el endpoint.
/// `force` (botón Actualizar) salta la muestra local, la caché y la espera
/// tras un fallo: pide el dato en vivo (ver `plan_limits::plan_limits_inner`).
pub fn plan_usage(force: bool) -> Result<PlanUsage, String> {
    let local = || {
        crate::ultron_root()
            .ok()
            .and_then(|root| uso_local_de(&root, Utc::now()))
    };
    resolver_uso(force, local, crate::plan_limits::plan_limits_inner)
}

/// Elige la fuente con la muestra local y el endpoint inyectados.
fn resolver_uso(
    force: bool,
    local: impl FnOnce() -> Option<PlanUsage>,
    endpoint: impl FnOnce(bool) -> Result<crate::plan_limits::PlanLimits, String>,
) -> Result<PlanUsage, String> {
    if !force {
        if let Some(u) = local() {
            return Ok(u);
        }
    }
    endpoint(force).map(desde_limites)
}

/// Ritmo del puente con los datos de la fuente: `stale`, `source`,
/// `fetchedAtMs` y `lastError`, para que el panel diga de cuándo son.
pub fn con_fuente(pace: Value, usage: &PlanUsage) -> Value {
    let Value::Object(mut map) = pace else {
        return pace;
    };
    map.insert("stale".into(), json!(usage.stale));
    map.insert("source".into(), json!(usage.source));
    map.insert("fetchedAtMs".into(), json!(usage.fetched_at_ms));
    map.insert("lastError".into(), json!(usage.last_error));
    Value::Object(map)
}

/// Entrada del puente: `{ rateLimits: [{ kind, percentUsed, resetsAt }] }`.
pub fn bridge_input(usage: &PlanUsage) -> Value {
    let one = |kind: &str, w: &Option<UsageWindow>| {
        w.as_ref()
            .map(|w| json!({ "kind": kind, "percentUsed": w.percent, "resetsAt": w.resets_at }))
    };
    let limits: Vec<Value> = [
        one("five_hour", &usage.five_hour),
        one("seven_day", &usage.seven_day),
    ]
    .into_iter()
    .flatten()
    .collect();
    json!({ "rateLimits": limits })
}

/// Ejecuta el puente del mod con el uso actual.
pub fn pace(usage: &PlanUsage) -> Result<Value, String> {
    let root = crate::ultron_root()?;
    let script = root.join(BRIDGE);
    if !script.is_file() {
        return Err(format!("no está el puente de uso: {}", script.display()));
    }
    let node = which::which("node").map_err(|_| "no se encontró 'node' en el PATH".to_string())?;
    let program = Program {
        exe: node,
        pre_args: vec![script.to_string_lossy().into_owned()],
    };
    let cmd = motores::command_for(&program, &root.to_string_lossy());
    ejecutar_puente(cmd, usage, TOPE_PUENTE)
}

/// Lanza el puente con el uso por stdin, dentro de un Job Object y con tope:
/// un `node` colgado no deja el hilo bloqueado ni el proceso huérfano.
fn ejecutar_puente(cmd: Command, usage: &PlanUsage, tope: Duration) -> Result<Value, String> {
    let input = bridge_input(usage).to_string().into_bytes();
    let out = super::cli_info::run_cli_input(cmd, Some(input), tope, "el puente de uso")
        .map_err(|e| format!("el puente de uso falló: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "el puente de uso falló: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("respuesta del puente de uso ilegible: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vacio() -> PlanUsage {
        PlanUsage {
            five_hour: None,
            seven_day: None,
            subscription_type: None,
            stale: false,
            source: UsageSource::Oauth,
            fetched_at_ms: 0,
            last_error: None,
        }
    }

    fn ahora() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-13T21:45:30Z")
            .expect("fecha")
            .with_timezone(&Utc)
    }

    /// Dos líneas reales de `usage-history.jsonl` (21:44:39 y 21:45:05).
    const COLA: &str = concat!(
        r#"{"ts":"2026-10-13T21:44:39.410Z","session_id":"a","model":"m","limites":{"five_hour":{"pct":4,"resets_at":1791944400},"seven_day":{"pct":42,"resets_at":1792112400}}}"#,
        "\n",
        r#"{"ts":"2026-10-13T21:45:05.389Z","session_id":"b","model":"m","limites":{"five_hour":{"pct":5,"resets_at":1791944400},"seven_day":{"pct":42,"resets_at":1792112400}}}"#,
        "\n"
    );

    /// Hallazgo 4: la muestra local reciente es la fuente, sin HTTP.
    #[test]
    fn la_muestra_local_reciente_da_el_uso() {
        let u = uso_local(COLA, ahora()).expect("muestra reciente");
        assert_eq!(u.source, UsageSource::Local);
        let five = u.five_hour.expect("5 h");
        assert_eq!(five.percent, 5.0);
        assert_eq!(five.resets_at.as_deref(), Some("2026-10-14T02:20:00Z"));
        assert_eq!(u.seven_day.map(|w| w.percent), Some(42.0));
        assert!(!u.stale);
    }

    #[test]
    fn una_muestra_vieja_o_reiniciada_no_vale() {
        let tarde = ahora() + chrono::Duration::minutes(6);
        assert!(uso_local(COLA, tarde).is_none(), "más de 5 min");
        let reiniciada = r#"{"ts":"2026-10-13T21:45:05Z","limites":{"five_hour":{"pct":5,"resets_at":1791927000},"seven_day":{"pct":42,"resets_at":1792112400}}}"#;
        assert!(
            uso_local(reiniciada, ahora()).is_none(),
            "5 h ya reiniciada"
        );
        let sin_pct =
            r#"{"ts":"2026-10-13T21:45:05Z","limites":{"five_hour":{"resets_at":1791944400}}}"#;
        assert!(uso_local(sin_pct, ahora()).is_none());
        assert!(uso_local("", ahora()).is_none());
        assert!(uso_local("no es json\n", ahora()).is_none());
    }

    fn limites(stale: bool) -> crate::plan_limits::PlanLimits {
        crate::plan_limits::PlanLimits {
            subscription_type: None,
            five_hour: None,
            seven_day: None,
            limits: Vec::new(),
            breakdown: Vec::new(),
            breakdown_as_of: None,
            extra_usage_enabled: false,
            fetched_at: 1,
            stale,
            last_error: None,
        }
    }

    /// Sin `force` manda la muestra local; con `force` (Actualizar) se salta
    /// y el endpoint recibe `force` para no quedarse en la espera.
    #[test]
    fn actualizar_salta_la_muestra_local_y_fuerza_el_endpoint() {
        let local = || uso_local(COLA, ahora());
        let pedido = std::cell::Cell::new(None);
        let endpoint = |f: bool| {
            pedido.set(Some(f));
            Ok(limites(false))
        };
        let u = resolver_uso(false, local, endpoint).expect("uso");
        assert_eq!((u.source, pedido.get()), (UsageSource::Local, None));
        let u = resolver_uso(true, local, endpoint).expect("uso");
        assert_eq!((u.source, pedido.get()), (UsageSource::Oauth, Some(true)));
        let u = resolver_uso(
            false,
            || None,
            |f| {
                assert!(!f, "el intervalo no fuerza");
                Ok(limites(true))
            },
        );
        assert!(u.expect("uso").stale);
    }

    #[test]
    fn la_fuente_viaja_con_el_ritmo() {
        let usage = PlanUsage {
            stale: true,
            last_error: Some("sin red".into()),
            fetched_at_ms: 1_000,
            ..vacio()
        };
        let v = con_fuente(json!({ "windows": [] }), &usage);
        assert_eq!(v["stale"], true);
        assert_eq!(v["source"], "oauth");
        assert_eq!(v["fetchedAtMs"], 1_000);
        assert_eq!(v["lastError"], "sin red");
        assert_eq!(v["windows"], json!([]));
    }

    #[test]
    fn los_limites_del_endpoint_conservan_el_motivo() {
        let l = crate::plan_limits::PlanLimits {
            subscription_type: Some("max".into()),
            five_hour: None,
            seven_day: Some(crate::plan_limits::PlanWindow {
                utilization: 42.0,
                resets_at: None,
            }),
            limits: Vec::new(),
            breakdown: Vec::new(),
            breakdown_as_of: None,
            extra_usage_enabled: false,
            fetched_at: 7,
            stale: true,
            last_error: Some("HTTP 500".into()),
        };
        let u = desde_limites(l);
        assert_eq!((u.fetched_at_ms, u.stale), (7_000, true));
        assert_eq!(u.last_error.as_deref(), Some("HTTP 500"));
        assert_eq!(u.source, UsageSource::Oauth);
    }

    #[test]
    fn la_entrada_lleva_solo_las_ventanas_con_dato() {
        let usage = PlanUsage {
            five_hour: Some(UsageWindow {
                percent: 25.0,
                resets_at: Some("2026-10-07T20:00:00Z".into()),
            }),
            ..vacio()
        };
        let v = bridge_input(&usage);
        let limits = v["rateLimits"].as_array().expect("array");
        assert_eq!(limits.len(), 1);
        assert_eq!(limits[0]["kind"], "five_hour");
        assert_eq!(limits[0]["percentUsed"], 25.0);
    }

    /// Un puente colgado no retiene el hilo: se corta al vencer el tope.
    #[cfg(windows)]
    #[test]
    fn un_puente_colgado_se_corta_al_vencer_el_tope() {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "ping -n 30 127.0.0.1 >NUL"]);
        let usage = vacio();
        let e = ejecutar_puente(cmd, &usage, Duration::from_secs(1)).expect_err("debe cortar");
        assert!(e.contains("no respondió"), "{e}");
        // Desde que el hijo existe: la cola de `spawn` de la suite no cuenta.
        let tras_spawn = crate::sesiones::cli_info::desde_el_ultimo_spawn();
        assert!(tras_spawn < Duration::from_secs(5), "{tras_spawn:?}");
    }
}
