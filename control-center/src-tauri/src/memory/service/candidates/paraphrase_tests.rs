// Tests del gate anti-paráfrasis. PUROS: sin brain.db ni red.

use super::*;

/// Jaccard entre dos títulos en bruto (lo que hace el gate por dentro).
fn jaccard(a: &str, b: &str) -> f32 {
    jaccard_of(&title_tokens(a), &title_tokens(b))
}

// --- gate (a): título normalizado -------------------------------------------

#[test]
fn el_mismo_titulo_reordenado_y_con_tildes_normaliza_igual() {
    // Minúsculas, tildes, puntuación, stopwords y orden no distinguen un título.
    let a = "La decisión de usar SQLite nativo";
    let b = "usar sqlite nativo: decision";
    assert_eq!(title_tokens(a), title_tokens(b));
    assert!(titles_match(a, b));
}

#[test]
fn titulo_reformulado_por_encima_del_umbral_es_paraphrasis() {
    let a = "Recall híbrido con RRF sobre FTS5 y BM25";
    let b = "Recall híbrido RRF sobre FTS5, BM25 y ranking";
    let j = jaccard(a, b);
    assert!(
        j >= PARAPHRASE_TITLE_JACCARD,
        "jaccard de títulos {j} debería confirmar la paráfrasis"
    );
    assert!(titles_match(a, b));
}

#[test]
fn titulos_de_hechos_distintos_no_disparan() {
    // Caso negativo: compartir alguna palabra NO es una paráfrasis.
    let a = "El ranking reordena el top fusionado del recall";
    let b = "La pestaña Finance se compila con la feature del build local";
    assert!(jaccard(a, b) < PARAPHRASE_TITLE_JACCARD);
    assert!(!titles_match(a, b));
}

#[test]
fn las_negaciones_no_son_stopwords() {
    // Caso negativo CRÍTICO: si "no" se filtrara como stopword, la corrección
    // ("no usar X") normalizaría igual que la afirmación ("usar X") y el gate
    // descartaría justo la actualización que corrige a la memoria vieja.
    let afirma = "Usar el daemon para embeber la query";
    let niega = "No usar el daemon para embeber la query";
    assert!(
        title_tokens(niega).contains(&"no".to_string()),
        "la negación tiene que sobrevivir a la normalización"
    );
    assert!(
        jaccard(afirma, niega) >= PARAPHRASE_TITLE_JACCARD,
        "el Jaccard solo, sin el veto, daría estos dos títulos por el mismo hecho"
    );
    assert!(!titles_match(afirma, niega));
}

#[test]
fn una_negacion_asimetrica_veta_la_parafrasis_dentro_de_la_ventana() {
    // Caso negativo: dentro de la ventana, "usar X" y "no usar X" no son el
    // mismo hecho; el gate deja que el detector de contradicción lo adjudique.
    let ahora = 1_757_000_000_000_i64;
    assert!(!is_paraphrase_of(
        "Usar el daemon para embeber la query",
        "No usar el daemon para embeber la query",
        ahora - HORA_MS,
        ahora,
    ));
}

#[test]
fn titulos_cortos_solo_disparan_si_son_identicos() {
    // Sin masa léxica el Jaccard no opina (dos títulos de una palabra pueden ser
    // el mismo tema y hechos distintos); la identidad exacta sí.
    assert_eq!(jaccard("SQLite", "SQLite nativo"), 0.0);
    assert!(titles_match("SQLite nativo", "sqlite, nativo"));
    assert!(!titles_match("SQLite", "Ranking"));
    assert!(!titles_match("", "lo que sea"));
}

// --- ventana de 24 h ---------------------------------------------------------

const HORA_MS: i64 = 60 * 60 * 1000;

#[test]
fn la_ventana_cubre_24_h_y_nada_mas() {
    let ahora = 1_757_000_000_000_i64;
    assert!(within_window(ahora - HORA_MS, ahora), "hace 1 h: dentro");
    assert!(within_window(ahora, ahora), "ahora mismo: dentro");
    assert!(
        within_window(ahora - PARAPHRASE_WINDOW_MS, ahora),
        "justo en el borde: dentro"
    );
    // Casos negativos: fuera de ventana y reloj movido hacia el futuro.
    assert!(
        !within_window(ahora - 25 * HORA_MS, ahora),
        "hace 25 h: la misma decisión meses después vuelve a entrar"
    );
    assert!(!within_window(ahora + HORA_MS, ahora), "created_at futuro");
}

#[test]
fn dentro_de_la_ventana_dispara_con_titulo_identico_y_fuera_no() {
    let ahora = 1_757_000_000_000_i64;
    assert!(is_paraphrase_of(
        "Recall con RRF sobre FTS5",
        "Recall con RRF sobre FTS5",
        ahora - HORA_MS,
        ahora,
    ));
    // Caso negativo: el mismo título hace 25 h vuelve a entrar.
    assert!(!is_paraphrase_of(
        "Recall con RRF sobre FTS5",
        "Recall con RRF sobre FTS5",
        ahora - 25 * HORA_MS,
        ahora,
    ));
}

#[test]
fn titulos_distintos_no_disparan_dentro_de_la_ventana() {
    // Caso negativo: sin el detector de coseno, una reescritura con otras
    // palabras ya no se marca como paráfrasis (alcance declarado).
    let ahora = 1_757_000_000_000_i64;
    assert!(!is_paraphrase_of(
        "El daemon sirve el recall a los one-shot",
        "Los procesos de un solo tiro piden el pack al proceso residente",
        ahora - HORA_MS,
        ahora,
    ));
}

// --- frontera de comparación (proyecto / scope) ------------------------------

#[test]
fn con_proyecto_solo_compara_contra_el_mismo_proyecto() {
    assert!(same_bucket(
        Some("ultron"),
        Scope::Project,
        Some("ultron"),
        Scope::Project
    ));
    assert!(!same_bucket(
        Some("ultron"),
        Scope::Project,
        Some("tortunabo"),
        Scope::Project
    ));
    assert!(
        !same_bucket(Some("ultron"), Scope::Project, None, Scope::Project),
        "un item ambiente no es del proyecto"
    );
}

#[test]
fn sin_proyecto_la_frontera_es_el_scope() {
    assert!(same_bucket(None, Scope::Global, None, Scope::Global));
    assert!(!same_bucket(None, Scope::Global, None, Scope::Session));
    assert!(!same_bucket(
        None,
        Scope::Global,
        Some("ultron"),
        Scope::Global
    ));
}

// --- selección del texto de título ------------------------------------------

#[test]
fn el_titulo_de_sondeo_cae_al_summary_cuando_no_hay_titulo() {
    use crate::memory::model::{MemoryCandidate, MemoryType};

    let mut c = MemoryCandidate::new(MemoryType::Decision, Scope::Global);
    assert_eq!(probe_title(&c), None, "sin texto no hay sondeo");
    c.proposed_summary = Some("usar el daemon para embeber".to_string());
    assert_eq!(probe_title(&c), Some("usar el daemon para embeber"));
    c.proposed_title = Some("   ".to_string());
    assert_eq!(
        probe_title(&c),
        Some("usar el daemon para embeber"),
        "un título en blanco no cuenta"
    );
    c.proposed_title = Some("Daemon de embeddings".to_string());
    assert_eq!(probe_title(&c), Some("Daemon de embeddings"));
}
