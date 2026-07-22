// Tests unitarios de orchestrator/rules.rs — separados por el limite de
// 800 lineas por archivo (kirkardo 7.3); ver rules.rs para la tabla RULES.
use super::{classify_intent, matches_word};

#[test]
fn matches_word_anchors_both_boundaries() {
    // Los bordes del prompt cuentan como límite de palabra.
    assert!(matches_word("ml pipeline", "ml"));
    assert!(matches_word("es ml", "ml"));
    assert!(matches_word("ui/ux", "ui"));
    // Vecino multi-byte UTF-8 ('ñ') no rompe el chequeo de límite.
    assert!(matches_word("añade auth ya", "auth"));
    // Sub-palabra nunca matchea.
    assert!(!matches_word("html", "ml"));
    assert!(!matches_word("build", "ui"));
    assert!(!matches_word("me encargo del deploy", "cargo"));
    assert!(!matches_word("frustrado", "rust"));
    assert!(!matches_word("latest", "test"));
    assert!(!matches_word("array", "arr"));
}

/// Los 12 patrones que traían el límite como espacio embebido (muertos
/// con matches_word) rutean de nuevo tras normalizar la tabla RULES.
#[test]
fn normalized_patterns_route_to_their_zone() {
    assert_eq!(
        classify_intent("cargo build falla en ci"),
        ("rust", "feature")
    );
    assert_eq!(
        classify_intent("optimiza el sql lento"),
        ("database", "quick")
    );
    assert_eq!(
        classify_intent("añade auth middleware"),
        ("security", "security")
    );
    assert_eq!(
        classify_intent("entrena el ml con estos datos"),
        ("ml", "feature")
    );
    assert_eq!(
        classify_intent("mejora la ui de la pagina"),
        ("ui_design", "feature")
    );
    assert_eq!(
        classify_intent("actualiza los docs del proyecto"),
        ("docs", "quick")
    );
    assert_eq!(
        classify_intent("migra la app a react"),
        ("nextjs", "feature")
    );
    assert_eq!(classify_intent("escribe esto en swift"), ("ios", "feature"));
    assert_eq!(
        classify_intent("integra un llm en el backend"),
        ("llm", "feature")
    );
    assert_eq!(
        classify_intent("proyecta el arr del proximo año"),
        ("business", "quick")
    );
    assert_eq!(
        classify_intent("crea un juego de plataformas"),
        ("game", "game")
    );
    assert_eq!(
        classify_intent("mecanicas para juegos multijugador"),
        ("game", "game")
    );
}

/// Anti-hijack (audit 2026-07-20, cat3): sub-palabras no disparan intents.
#[test]
fn word_boundary_kills_known_hijacks() {
    // "frustrado" contiene "rust" pero NO es rust.
    assert_eq!(
        classify_intent("estoy frustrado con este error").0,
        "bug_fix"
    );
    // "latest" contiene "test" pero NO es testing.
    assert_eq!(
        classify_intent("usa la latest version disponible").0,
        "general"
    );
    // "array" ya no alimenta "arr" (hijack array→business).
    assert_eq!(
        classify_intent("convierte el array en un objeto").0,
        "general"
    );
    // "oauth2" no dispara "auth".
    assert_eq!(
        classify_intent("configura oauth2 con el proveedor").0,
        "general"
    );
}

#[test]
fn prompt_edges_count_as_word_boundary() {
    // Patrón al inicio del prompt.
    assert_eq!(classify_intent("ml en produccion, revisalo").0, "ml");
    // Patrón al final del prompt.
    assert_eq!(classify_intent("explícame qué es un llm").0, "llm");
}
