//! Qué tipos de memoria NUNCA se inyectan en un prompt.
//!
//! El recall y el corpus no son la misma cosa. `brain.db` guarda todo lo que el
//! sistema observa — incluidas las notas que `subagent-harvest` escribe tras
//! cada subagente — pero solo una parte de eso merece competir por el hueco de
//! contexto de un prompt.
//!
//! Medido el 2026-08-23 sobre 3.536 items activos: 1.623 (46%) eran
//! `agent_note` del harvest, con títulos repetidos en masa ("Subagente
//! workflow-subagent — resultado" x561, "Subagente unknown — resultado" x269).
//! Ese bloque copaba el fanout y salía en el recall de prompts con los que no
//! tenía nada que ver, empujando fuera a las decisiones reales. La exclusión se
//! aplica en la FUENTE de ambas ramas (FTS5 y Qdrant), no al ensamblar el pack:
//! filtrar al final dejaría a los excluidos ocupando igualmente los 30-60
//! slots del fanout y el pack saldría vacío.
//!
//! Los items siguen ACTIVOS y visibles en la UI, el doctor y el reconcile: esto
//! decide qué se inyecta, no qué se guarda. Reversible sin tocar datos —
//! `ULTRON_RECALL_EXCLUDE_TYPES` manda sobre el default, y vacío lo desactiva.

/// Tipos excluidos del recall por defecto.
const DEFAULT_EXCLUDED_TYPES: &[&str] = &["agent_note"];

/// Tipos que no deben llegar nunca a un pack de recall.
///
/// `ULTRON_RECALL_EXCLUDE_TYPES` acepta una lista separada por comas y sustituye
/// al default; ponerla a vacío (o a `-`) desactiva la exclusión y devuelve el
/// comportamiento anterior sin recompilar.
pub fn excluded_types() -> Vec<String> {
    match std::env::var("ULTRON_RECALL_EXCLUDE_TYPES") {
        Ok(raw) => {
            let raw = raw.trim();
            if raw.is_empty() || raw == "-" {
                return Vec::new();
            }
            raw.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        }
        Err(_) => DEFAULT_EXCLUDED_TYPES
            .iter()
            .map(|s| (*s).to_string())
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    // Los tests leen y escriben una variable de entorno del proceso, así que no
    // pueden correr en paralelo entre ellos: van todos dentro de un test.
    #[test]
    fn env_override_manda_sobre_el_default() {
        let key = "ULTRON_RECALL_EXCLUDE_TYPES";
        let previo = std::env::var(key).ok();

        std::env::remove_var(key);
        assert_eq!(super::excluded_types(), vec!["agent_note".to_string()]);

        std::env::set_var(key, "agent_note, session_summary");
        assert_eq!(
            super::excluded_types(),
            vec!["agent_note".to_string(), "session_summary".to_string()]
        );

        // Vacío = sin exclusión: la vuelta atrás no necesita recompilar.
        std::env::set_var(key, "");
        assert!(super::excluded_types().is_empty());
        std::env::set_var(key, "-");
        assert!(super::excluded_types().is_empty());

        match previo {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
    }
}
