//! Backfill de los items marcados `Secret` por un falso positivo del detector
//! de PII (2026-09-22).
//!
//! Hasta hoy `redaction::pii` tomaba cualquier fecha ISO (`2026-09-22`) por un
//! teléfono: el write-path la sustituía por `[REDACTED_PHONE]`, marcaba el
//! candidato como Secret y, al aprobarlo, el pack del recall lo excluía para
//! siempre. Medido en brain.db: 69 items activos Secret, 35 con esa marca y sin
//! ninguna otra — memorias con la fecha en el título, que es la convención de
//! todo el sistema, silenciadas.
//!
//! Bajar esos items a `Internal` es seguro por construcción: los dígitos ya no
//! están (la redacción los borró al entrar), así que el texto que se inyectaría
//! no lleva PII. Un item con CUALQUIER otro marcador (`[REDACTED_PATH]`,
//! credenciales…) se deja como está. Escritor único: pasa por `MemoryService`.

use super::super::model::{
    now_millis, Actor, EventType, MemoryEvent, MemoryItem, Sensitivity, Status,
};
use super::super::sqlite_store as store;
use super::super::MemoryError;
use super::{sync_index, MemoryService};

/// Marcador que deja `redact_pii` en lugar de un teléfono.
pub const PHONE_MARKER: &str = "[REDACTED_PHONE]";

/// Resultado de [`MemoryService::secret_backfill`].
#[derive(Debug, Clone, serde::Serialize)]
pub struct SecretBackfillResult {
    pub dry_run: bool,
    /// Items activos con `sensitivity = secret` examinados.
    pub scanned_secret: usize,
    /// Ids bajados a `internal` (con `dry_run`, los que se bajarían).
    pub downgraded: Vec<String>,
    /// Items que siguen Secret porque llevan otro marcador de redacción.
    pub kept_secret: usize,
    /// `(id, error)` de los que no se pudieron escribir.
    pub failed: Vec<(String, String)>,
}

/// Todo el texto que el write-path escaneó y redactó (mismos campos que
/// `pii_scan_text` en el intake), para buscar marcadores en cualquiera de ellos.
fn item_text(item: &MemoryItem) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for f in [
        &item.title,
        &item.summary,
        &item.content,
        &item.content_json,
    ] {
        if let Some(s) = f.as_deref() {
            parts.push(s);
        }
    }
    for t in &item.tags {
        parts.push(t);
    }
    parts.join("\n")
}

/// Puro: true si el texto lleva el marcador de teléfono y NINGÚN otro marcador
/// `[REDACTED_…]`. Sin marcadores → false (no hay evidencia de que el Secret
/// venga de una redacción; no se toca).
pub fn only_phone_marker(text: &str) -> bool {
    let mut has_phone = false;
    let mut rest = text;
    while let Some(pos) = rest.find("[REDACTED_") {
        let tail = &rest[pos..];
        let Some(close) = tail.find(']') else {
            return false;
        };
        let marker = &tail[..=close];
        if marker != PHONE_MARKER {
            return false;
        }
        has_phone = true;
        rest = &tail[close + 1..];
    }
    has_phone
}

impl MemoryService {
    /// Baja a `Internal` los items activos Secret cuyo único marcador de
    /// redacción es `[REDACTED_PHONE]`. Con `dry_run` solo cuenta. Cada cambio
    /// deja evento `updated` con motivo y re-sincroniza el índice denso.
    pub fn secret_backfill(
        dry_run: bool,
        actor: Actor,
    ) -> Result<SecretBackfillResult, MemoryError> {
        let items = Self::list_by_status(Status::Active, 100_000)?;
        let conn = store::open_conn()?;
        let mut result = SecretBackfillResult {
            dry_run,
            scanned_secret: 0,
            downgraded: Vec::new(),
            kept_secret: 0,
            failed: Vec::new(),
        };
        for item in items
            .into_iter()
            .filter(|i| i.sensitivity == Sensitivity::Secret)
        {
            result.scanned_secret += 1;
            if !only_phone_marker(&item_text(&item)) {
                result.kept_secret += 1;
                continue;
            }
            if dry_run {
                result.downgraded.push(item.id.clone());
                continue;
            }
            let before = serde_json::to_string(&item).unwrap_or_default();
            let mut updated = item.clone();
            updated.sensitivity = Sensitivity::Internal;
            updated.updated_at = now_millis();
            match store::insert_item(&conn, &updated) {
                Ok(()) => {
                    sync_index(&updated);
                    let ev = MemoryEvent::new(EventType::Updated, Some(updated.id.clone()), actor)
                        .with_reason(
                            "secret-backfill: solo [REDACTED_PHONE] (fecha ISO tomada por teléfono, 2026-09-22)"
                                .to_string(),
                        )
                        .with_before(before)
                        .with_after(serde_json::to_string(&updated).unwrap_or_default());
                    let _ = store::insert_event(&conn, &ev);
                    result.downgraded.push(updated.id);
                }
                Err(e) => result.failed.push((item.id.clone(), e.to_string())),
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solo_el_marcador_de_telefono_cuenta_como_falso_secret() {
        assert!(only_phone_marker("maria-core [REDACTED_PHONE]) corte"));
        assert!(only_phone_marker(
            "base ULTRON [REDACTED_PHONE]\nintegrado [REDACTED_PHONE] también"
        ));
    }

    // Casos negativos: cualquier otro marcador, ninguno, o uno sin cerrar,
    // mantienen el Secret.
    #[test]
    fn otros_marcadores_o_ninguno_no_se_tocan() {
        assert!(!only_phone_marker(
            "ruta [REDACTED_PATH] y fecha [REDACTED_PHONE]"
        ));
        assert!(!only_phone_marker("token [REDACTED_CREDENTIAL]"));
        assert!(!only_phone_marker("sin marcadores, secret por otro motivo"));
        assert!(!only_phone_marker("roto [REDACTED_PHONE"));
        assert!(!only_phone_marker(""));
    }
}
