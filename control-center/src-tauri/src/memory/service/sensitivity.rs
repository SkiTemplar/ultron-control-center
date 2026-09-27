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
    /// Ids cuyo título generado recuperó la fecha (con `dry_run`, los que la
    /// recuperarían). Ver [`restore_title_date`].
    pub titles_restored: Vec<String>,
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

/// Prefijos de título que generan los hooks con la fecha UTC de creación
/// detrás (`session-end-summary.js`, feedback de sesión). Solo en ellos se
/// sabe qué había bajo el marcador.
const DATED_TITLE_PREFIXES: [&str; 2] = ["Resumen SessionEnd ", "Feedback de sesion "];

/// Puro: si `title` es un título generado cuya fecha quedó como
/// `[REDACTED_PHONE]`, devuelve el título con la fecha UTC de `created_at_ms`
/// (la misma que puso el hook: `new Date().toISOString().slice(0, 10)`).
/// Cualquier otro título → `None`: fuera de esos prefijos no se sabe qué borró
/// la redacción.
pub fn restore_title_date(title: &str, created_at_ms: i64) -> Option<String> {
    let prefix = DATED_TITLE_PREFIXES
        .iter()
        .find(|p| title.starts_with(*p))?;
    let rest = title[prefix.len()..].strip_prefix(PHONE_MARKER)?;
    let date = chrono::DateTime::from_timestamp_millis(created_at_ms)?
        .format("%Y-%m-%d")
        .to_string();
    Some(format!("{prefix}{date}{rest}"))
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
            titles_restored: Vec::new(),
            failed: Vec::new(),
        };
        for item in items {
            let is_secret = item.sensitivity == Sensitivity::Secret;
            let text = item_text(&item);
            let downgrade = is_secret && only_phone_marker(&text);
            if is_secret {
                result.scanned_secret += 1;
                if !downgrade {
                    result.kept_secret += 1;
                }
            }
            let new_title = item
                .title
                .as_deref()
                .filter(|_| only_phone_marker(&text))
                .and_then(|t| restore_title_date(t, item.created_at));
            if !downgrade && new_title.is_none() {
                continue;
            }
            if dry_run {
                if downgrade {
                    result.downgraded.push(item.id.clone());
                }
                if new_title.is_some() {
                    result.titles_restored.push(item.id.clone());
                }
                continue;
            }
            let before = serde_json::to_string(&item).unwrap_or_default();
            let mut updated = item.clone();
            if downgrade {
                updated.sensitivity = Sensitivity::Internal;
            }
            if let Some(t) = new_title.clone() {
                updated.title = Some(t);
            }
            updated.updated_at = now_millis();
            match store::insert_item(&conn, &updated) {
                Ok(()) => {
                    sync_index(&updated);
                    let ev = MemoryEvent::new(EventType::Updated, Some(updated.id.clone()), actor)
                        .with_reason(
                            "secret-backfill: [REDACTED_PHONE] era una fecha ISO (falso positivo del detector de PII, 2026-09-22)"
                                .to_string(),
                        )
                        .with_before(before)
                        .with_after(serde_json::to_string(&updated).unwrap_or_default());
                    let _ = store::insert_event(&conn, &ev);
                    if downgrade {
                        result.downgraded.push(updated.id.clone());
                    }
                    if new_title.is_some() {
                        result.titles_restored.push(updated.id);
                    }
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

    // 2026-09-21T17:04:01.510Z
    const TS: i64 = 1_790_010_241_510;

    #[test]
    fn titulo_generado_recupera_la_fecha_utc_de_creacion() {
        assert_eq!(
            restore_title_date("Resumen SessionEnd [REDACTED_PHONE]", TS).as_deref(),
            Some("Resumen SessionEnd 2026-09-21")
        );
        assert_eq!(
            restore_title_date("Feedback de sesion [REDACTED_PHONE]: sí", TS).as_deref(),
            Some("Feedback de sesion 2026-09-21: sí")
        );
    }

    // Caso negativo: fuera de los prefijos generados no se inventa nada.
    #[test]
    fn titulos_ajenos_o_sin_marcador_no_se_tocan() {
        assert!(restore_title_date("llamar al [REDACTED_PHONE]", TS).is_none());
        assert!(restore_title_date("Resumen SessionEnd 2026-09-21", TS).is_none());
        assert!(restore_title_date("Resumen SessionEnd x [REDACTED_PHONE]", TS).is_none());
    }
}
