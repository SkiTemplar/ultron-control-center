// memory/service/candidates/paraphrase.rs — gate anti-paráfrasis del write-path.
//
// Problema medido (2026-09-06): la MISMA decisión entró tres veces en una sola
// sesión (ids 8408e95a, edaa6ece, f821560c). Los dos dedupes que ya existían no
// la vieron:
//   - el exacto por `content_hash` compara texto normalizado byte a byte — dos
//     redacciones distintas del mismo hecho dan hashes distintos;
//   - el near-dup Jaccard (`find_near_dup_active`) parte de `search_items`
//     (FTS5 term-OR): si la reformulación no comparte suficientes términos, el
//     hit ni siquiera entra en el top-3 que se confirma.
//
// Este gate añade dos detectores INDEPENDIENTES sobre los vecinos RECIENTES del
// mismo proyecto (o del mismo scope cuando el candidato no tiene proyecto):
//   (a) TÍTULO normalizado (minúsculas, sin tildes, sin stopwords, tokens
//       únicos y ordenados) idéntico, o con Jaccard de tokens >= 0,8;
//   (b) COSENO E5 >= 0,92 entre los `searchable_text`, cuando hay embedding
//       disponible (Qdrant vivo; el vector de la query se lo pide al daemon).
// Cualquiera de los dos basta: (a) atrapa la reformulación cosmética, (b) la
// reescritura con otras palabras. Los umbrales son altos a propósito — este
// gate DESCARTA memoria, así que ante la duda deja pasar el candidato.
//
// Alcance real (mand. 13):
//   - la ventana es de 24 h: una decisión repetida meses después vuelve a entrar
//     (es señal de que sigue vigente, no ruido de una misma sesión);
//   - (b) solo compara contra items ACTIVOS, que son los que Qdrant indexa; los
//     candidatos PENDING del inbox solo pasan por (a);
//   - las negaciones (`no`, `not`, `sin`, `nunca`, `never`) NO son stopwords: si
//     lo fueran, "usar X" y "no usar X" normalizarían igual y el gate borraría
//     precisamente la actualización que contradice al item viejo.

use std::collections::HashSet;

use rusqlite::Connection;

use crate::memory::model::{CandidateStatus, MemoryCandidate, MemoryItem, Scope, Source, Status};
use crate::memory::sqlite_store as store;
use crate::memory::MemoryError;

/// Ventana de comparación: 24 h en milisegundos.
pub(crate) const PARAPHRASE_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// Jaccard mínimo entre los tokens significativos de los dos títulos.
pub(crate) const PARAPHRASE_TITLE_JACCARD: f32 = 0.8;

/// Coseno E5 mínimo entre `searchable_text` para considerar paráfrasis.
pub(crate) const PARAPHRASE_COSINE: f32 = 0.92;

/// Tokens significativos mínimos EN CADA LADO para que el gate de título opine.
/// Con menos no hay masa léxica: dos títulos de una palabra pueden ser el mismo
/// tema y hechos distintos.
const MIN_TITLE_TOKENS: usize = 3;

/// Vecinos densos que se piden a Qdrant. Una paráfrasis con coseno >= 0,92 está
/// en las primerísimas posiciones o no está.
const DENSE_NEIGHBOURS: u32 = 5;

/// Tope de ACTIVOS recientes escaneados por el gate de título. Alcance real: si
/// se tocaran más de 500 items en 24 h, el gate (a) vería solo los 500 más
/// recientes (el (b) no depende de este tope, va por k-NN).
const ACTIVE_SCAN_LIMIT: usize = 500;

/// Stopwords ES/EN. SIN negaciones (ver cabecera).
const STOPWORDS: &[&str] = &[
    "de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas", "y", "o", "en", "al",
    "que", "por", "para", "con", "se", "su", "sus", "lo", "es", "son", "como", "ya", "the", "a",
    "an", "of", "to", "in", "on", "for", "and", "or", "with", "is", "are", "was", "were", "by",
    "from", "at", "it", "this", "that", "its",
];

/// Minúscula + plegado de tildes (y `ñ`→`n`). El plegado se aplica a los DOS
/// lados, así que solo afecta a la comparación, nunca al texto persistido.
fn fold(raw: &str) -> String {
    raw.to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            other if other.is_alphanumeric() => other,
            _ => ' ',
        })
        .collect()
}

/// Tokens significativos de un título: plegados, sin stopwords, únicos y
/// ORDENADOS (el orden de las palabras no distingue una paráfrasis). PURA.
pub(crate) fn title_tokens(raw: &str) -> Vec<String> {
    let mut toks: Vec<String> = fold(raw)
        .split_whitespace()
        .filter(|t| !STOPWORDS.contains(t))
        .map(str::to_string)
        .collect();
    toks.sort();
    toks.dedup();
    toks
}

/// Jaccard entre tokens de título ya normalizados, en [0,1]. Devuelve 0.0 si
/// alguno no llega a [`MIN_TITLE_TOKENS`]: sin masa léxica no hay señal. PURA.
pub(crate) fn jaccard_of(ta: &[String], tb: &[String]) -> f32 {
    if ta.len() < MIN_TITLE_TOKENS || tb.len() < MIN_TITLE_TOKENS {
        return 0.0;
    }
    let sa: HashSet<&str> = ta.iter().map(String::as_str).collect();
    let sb: HashSet<&str> = tb.iter().map(String::as_str).collect();
    let inter = sa.intersection(&sb).count() as f32;
    let union = sa.union(&sb).count() as f32;
    inter / union
}

/// Marcas de negación. No son stopwords (se conservan como tokens) y además
/// vetan la paráfrasis cuando solo aparecen en un lado.
const NEGATIONS: &[&str] = &[
    "no", "not", "ni", "nunca", "jamas", "tampoco", "sin", "never", "without", "neither", "nor",
];

/// ¿Los dos títulos NIEGAN distinto? Entonces no son paráfrasis, por muy alto
/// que sea el solapamiento: "usar el daemon" y "no usar el daemon" difieren en
/// un token y en todo lo demás son idénticos, así que el Jaccard los daría por
/// el mismo hecho y el gate borraría justo la corrección. E5 tampoco separa bien
/// la negación, así que este veto se aplica ANTES que el coseno. PURA.
fn negation_mismatch(ta: &[String], tb: &[String]) -> bool {
    let marks = |t: &[String]| -> HashSet<String> {
        t.iter()
            .filter(|tok| NEGATIONS.contains(&tok.as_str()))
            .cloned()
            .collect()
    };
    marks(ta) != marks(tb)
}

/// Gate (a): ¿los dos títulos son el mismo título reformulado? PURA.
pub(crate) fn titles_match(a: &str, b: &str) -> bool {
    let (ta, tb) = (title_tokens(a), title_tokens(b));
    if ta.is_empty() || tb.is_empty() || negation_mismatch(&ta, &tb) {
        return false;
    }
    if ta == tb {
        return true;
    }
    jaccard_of(&ta, &tb) >= PARAPHRASE_TITLE_JACCARD
}

/// ¿El vecino se creó dentro de la ventana de 24 h que termina en `now_ms`? Un
/// `created_at` futuro (reloj movido) NO se considera dentro. PURA.
pub(crate) fn within_window(created_at: i64, now_ms: i64) -> bool {
    created_at <= now_ms && now_ms - created_at <= PARAPHRASE_WINDOW_MS
}

/// Decisión PURA del gate para UN vecino: fuera de ventana nunca dispara;
/// dentro, basta con el gate de título (a) o con el coseno (b). `cosine` es
/// `None` cuando no hay embedding disponible para ese vecino. Una negación
/// asimétrica veta AMBOS gates (ver [`negation_mismatch`]).
pub(crate) fn is_paraphrase_of(
    cand_title: &str,
    other_title: &str,
    other_created_at: i64,
    now_ms: i64,
    cosine: Option<f32>,
) -> bool {
    if !within_window(other_created_at, now_ms) {
        return false;
    }
    if negation_mismatch(&title_tokens(cand_title), &title_tokens(other_title)) {
        return false;
    }
    if titles_match(cand_title, other_title) {
        return true;
    }
    matches!(cosine, Some(score) if score >= PARAPHRASE_COSINE)
}

/// ¿Comparten frontera de comparación? Con proyecto, el mismo proyecto; sin él,
/// el mismo scope y tampoco proyecto (misma regla que el dedupe exacto). PURA.
pub(crate) fn same_bucket(
    cand_project: Option<&str>,
    cand_scope: Scope,
    other_project: Option<&str>,
    other_scope: Scope,
) -> bool {
    match cand_project {
        Some(p) => other_project == Some(p),
        None => other_project.is_none() && other_scope == cand_scope,
    }
}

/// Texto de título del candidato para el gate (a): el título propuesto y, si no
/// lo hay, el summary (la captura no siempre rellena título).
pub(crate) fn probe_title(cand: &MemoryCandidate) -> Option<&str> {
    cand.proposed_title
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .or_else(|| {
            cand.proposed_summary
                .as_deref()
                .filter(|s| !s.trim().is_empty())
        })
}

/// Id del item ACTIVO o candidato PENDING reciente del que este candidato es una
/// PARÁFRASIS, o `None` si es nuevo. `Err` = no se pudo comprobar (el llamante
/// marca `dedup-unverified` y deja el candidato en el inbox: fail-closed).
///
/// Orden por coste: primero el gate de título sobre los recientes de SQLite
/// (barato, sin red), y solo si no dispara se paga el k-NN denso.
pub(super) fn find_paraphrase_dup(
    conn: &Connection,
    cand: &MemoryCandidate,
) -> Result<Option<String>, MemoryError> {
    let Some(title) = probe_title(cand) else {
        return Ok(None); // sin texto no hay paráfrasis que detectar
    };
    let probe = cand.to_item(Status::Active, Source::AssistantInferred);
    let now = crate::memory::model::now_millis();

    if let Some(id) = title_dup_in_active(conn, &probe, title, now)? {
        return Ok(Some(id));
    }
    if let Some(id) = title_dup_in_pending(conn, &probe, &cand.id, title, now)? {
        return Ok(Some(id));
    }
    Ok(cosine_dup_in_active(conn, &probe, title, now))
}

/// Gate (a) contra los items ACTIVOS recientes.
fn title_dup_in_active(
    conn: &Connection,
    probe: &MemoryItem,
    title: &str,
    now: i64,
) -> Result<Option<String>, MemoryError> {
    for item in store::list_items(conn, Status::Active, ACTIVE_SCAN_LIMIT)? {
        if !same_bucket(
            probe.project_id.as_deref(),
            probe.scope,
            item.project_id.as_deref(),
            item.scope,
        ) {
            continue;
        }
        let other_title = item.title.as_deref().or(item.summary.as_deref());
        let Some(other_title) = other_title.filter(|t| !t.trim().is_empty()) else {
            continue;
        };
        if is_paraphrase_of(title, other_title, item.created_at, now, None) {
            return Ok(Some(item.id));
        }
    }
    Ok(None)
}

/// Gate (a) contra los candidatos PENDING del inbox (que Qdrant no indexa, así
/// que el gate (b) no los ve).
fn title_dup_in_pending(
    conn: &Connection,
    probe: &MemoryItem,
    cand_id: &str,
    title: &str,
    now: i64,
) -> Result<Option<String>, MemoryError> {
    let pending_all = store::list_candidates(conn, CandidateStatus::Pending, usize::MAX)?;
    for pending in pending_all {
        if pending.id == cand_id {
            continue; // re-chequeo idempotente del propio candidato
        }
        let other = pending.to_item(Status::Active, Source::AssistantInferred);
        if !same_bucket(
            probe.project_id.as_deref(),
            probe.scope,
            other.project_id.as_deref(),
            other.scope,
        ) {
            continue;
        }
        let Some(other_title) = probe_title(&pending) else {
            continue;
        };
        if is_paraphrase_of(title, other_title, pending.created_at, now, None) {
            return Ok(Some(pending.id));
        }
    }
    Ok(None)
}

/// Gate (b): k-NN denso sobre los ACTIVOS (los únicos que Qdrant indexa). El
/// veredicto final lo da [`is_paraphrase_of`], así que aquí también aplican la
/// ventana de 24 h y el veto por negación. Best-effort — si la infra de búsqueda
/// no está disponible devuelve `None` (el gate (a) ya corrió; no se bloquea la
/// captura por no poder pagar el coseno).
fn cosine_dup_in_active(
    conn: &Connection,
    probe: &MemoryItem,
    title: &str,
    now: i64,
) -> Option<String> {
    let text = probe.searchable_text();
    if text.trim().is_empty() {
        return None;
    }
    let project = probe.project_id.as_deref();
    let hits =
        crate::memory::qdrant_index::search_dense_scored_checked(&text, DENSE_NEIGHBOURS, project)?;
    hits.into_iter()
        .filter(|(_, score)| *score >= PARAPHRASE_COSINE)
        .find_map(|(id, score)| {
            let item = store::get_item(conn, &id).ok().flatten()?;
            if !same_bucket(project, probe.scope, item.project_id.as_deref(), item.scope) {
                return None;
            }
            let other_title = item
                .title
                .as_deref()
                .or(item.summary.as_deref())
                .unwrap_or("");
            is_paraphrase_of(title, other_title, item.created_at, now, Some(score))
                .then_some(item.id)
        })
}

#[cfg(test)]
#[path = "paraphrase_tests.rs"]
mod tests;
