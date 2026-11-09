// memory/catalog_warm.rs — calentamiento del catálogo agente/skill al arrancar.
//
// La GUI lo pedía en cada arranque (primero al daemon, después en local)
// aunque el denso estuviese apagado a propósito (ULTRON_DENSE=0, decisión del
// 2026-09-28): con E5 en vector cero fallaba siempre y dejaba un WARN «catalog
// warm skipped» por arranque. Con el denso apagado no hay nada que calentar:
// ni la GUI ni el daemon tocan E5 y queda un INFO que lo explica.

use std::time::Duration;

use serde_json::{json, Value};

/// Tope de la petición `warm_catalog` al daemon.
const DAEMON_TIMEOUT: Duration = Duration::from_secs(120);

/// Resultado de un calentamiento.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WarmOutcome {
    /// Denso apagado a propósito: no se embebe nada.
    DenseOff,
    /// La colección ya respondía: no se reindexa.
    AlreadyWarm,
    /// Se indexaron `entities` entradas con `errors` fallos.
    Indexed { entities: usize, errors: usize },
}

impl WarmOutcome {
    /// Respuesta del comando `warm_catalog` del daemon.
    #[must_use]
    pub fn to_json(self) -> Value {
        match self {
            Self::DenseOff => json!({ "ok": true, "skipped": "dense_off" }),
            Self::AlreadyWarm => json!({ "ok": true, "entities": 0, "errors": 0 }),
            Self::Indexed { entities, errors } => {
                json!({ "ok": true, "entities": entities, "errors": errors })
            }
        }
    }
}

/// Calienta el catálogo si el denso está encendido (`dense_on`).
pub fn warm_with(dense_on: bool) -> Result<WarmOutcome, String> {
    if !dense_on {
        return Ok(WarmOutcome::DenseOff);
    }
    Ok(match super::catalog::maybe_warm_catalog()? {
        (0, 0) => WarmOutcome::AlreadyWarm,
        (entities, errors) => WarmOutcome::Indexed { entities, errors },
    })
}

/// La respuesta del daemon trae `error`: el calentamiento falló allí.
fn daemon_error(reply: &Value) -> Option<&str> {
    reply.get("error").and_then(Value::as_str)
}

/// Arranque de la GUI: con el denso apagado no se pide nada; si no, primero el
/// daemon (el modelo se carga una vez para todo el sistema) y, si no responde,
/// el camino local. Pensado para `spawn_blocking`: nunca falla, solo registra.
pub fn warm_at_startup() {
    if !crate::qdrant::dense_enabled() {
        tracing::info!("catalog warm: skipped — dense stack disabled (ULTRON_DENSE=0)");
        return;
    }
    if let Some(reply) = crate::daemon_client::request("warm_catalog", json!({}), DAEMON_TIMEOUT) {
        match daemon_error(&reply) {
            Some(e) => tracing::warn!(error = %e, "catalog warm failed (daemon)"),
            None => tracing::info!(respuesta = %reply, "catalog warmed (daemon)"),
        }
        return;
    }
    match warm_with(true) {
        Ok(WarmOutcome::Indexed { entities, errors }) => {
            tracing::info!(entities, errors, "catalog warmed");
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "catalog warm skipped"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn con_el_denso_apagado_no_se_calienta_nada() {
        // Sin E5 ni Qdrant en el test: si tocase el catálogo, fallaría.
        assert_eq!(warm_with(false), Ok(WarmOutcome::DenseOff));
        assert_eq!(
            WarmOutcome::DenseOff.to_json(),
            json!({ "ok": true, "skipped": "dense_off" })
        );
    }

    #[test]
    fn la_respuesta_del_daemon_con_error_no_cuenta_como_calentado() {
        assert_eq!(
            daemon_error(&json!({ "error": "E5 model unavailable" })),
            Some("E5 model unavailable")
        );
        assert_eq!(daemon_error(&json!({ "ok": true, "entities": 3 })), None);
    }

    #[test]
    fn el_json_del_daemon_conserva_la_forma_de_siempre() {
        assert_eq!(
            WarmOutcome::Indexed {
                entities: 5,
                errors: 1
            }
            .to_json(),
            json!({ "ok": true, "entities": 5, "errors": 1 })
        );
        assert_eq!(
            WarmOutcome::AlreadyWarm.to_json(),
            json!({ "ok": true, "entities": 0, "errors": 0 })
        );
    }
}
