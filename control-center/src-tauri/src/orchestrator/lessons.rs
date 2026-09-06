//! lessons.rs — recall cross-project de lecciones por síntoma (ULTRON 4, F1.3).
//!
//! Decisión F1.3(a) (2026-09-02): las `lesson` de OTROS proyectos se buscan en
//! UserPromptSubmit, y solo cuando el turno describe un síntoma (intent
//! `bug_fix` o workflow `debug`). En SessionStart no hay síntoma todavía y una
//! lista fija de lecciones sería ruido en cada sesión.
//!
//! Camino: segunda pasada de `build_trace_typed` con `cross_project = true` y
//! `only_type = lesson` (mismas puertas de honestidad que el recall normal:
//! floor, poda por margen, trust gate), sin repetir lo que ya trae el pack del
//! proyecto. Coste: un recall híbrido extra SOLO en turnos de fallo. Se inyecta
//! como una línea por lección (máximo 3) en el bloque `<orchestration-context>`
//! del hook.
//!
//! Por qué solo entre `lesson` (decidido 2026-09-03): el hot path va sin
//! reranker y en el recall general la lección relevante (dense 0.888) caía al
//! rango 15, detrás de constraints con un solo hit sparse; con el k-NN y el FTS
//! restringidos al tipo, el fanout es solo de lecciones y el floor dense sigue
//! dejando fuera las que no encajan con el síntoma.

use crate::commands::memory::recall_unified::{build_trace_typed, RecallEntry};
use crate::memory::MemoryType;
use serde::{Deserialize, Serialize};

/// Máximo de lecciones inyectadas por turno.
pub const MAX_LECCIONES: usize = 3;
/// Candidatas que se piden al recall antes de filtrar por tipo.
const FANOUT: usize = 12;
/// Similitud dense mínima para que una lección "encaje" con el síntoma. Con el
/// k-NN restringido a `lesson` el fanout trae TODAS las lecciones del corpus
/// (hoy 3) y la poda por margen del recall conserva siempre las primeras, así
/// que sin este corte cada turno de fallo inyectaba las tres. 0.83 es el mismo
/// listón empírico del floor de abstención del read-path y del juez de
/// contradicción: por debajo, dos textos E5 no hablan del mismo tema.
const LESSON_MIN_DENSE: f32 = 0.83;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LessonHit {
    pub canonical_id: String,
    /// Regla en imperativo (el título del item es `[lesson] <regla>`).
    pub rule: String,
    /// `síntoma → causa` (el summary del item).
    pub symptom_cause: String,
    pub project_id: Option<String>,
    pub score: f32,
}

/// ¿El turno describe un fallo? Solo entonces merece la segunda pasada.
///
/// Decisión 2026-09-03: además del intent `bug_fix` / workflow `debug`, abre la
/// puerta el LÉXICO de fallo del propio prompt. Medido: "hay un bug: al
/// compilar con cargo sale el error X" rutea a intent `rust` + workflow
/// `feature` y la lección que lo resolvía (top-1 del recall) no llegaba. El
/// routing no se toca: esta puerta es local y solo cuesta un recall extra.
pub fn es_sintoma(intent: &str, workflow_id: Option<&str>, prompt: &str) -> bool {
    intent == "bug_fix" || workflow_id == Some("debug") || tiene_lexico_de_fallo(prompt)
}

/// Palabras sueltas que solo aparecen describiendo un fallo (es/en). Fuera
/// quedan a propósito `error`/`errores`: nombran también pantallas, mensajes o
/// tipos ("la pantalla de errores", "el enum Error") y abrirían la puerta en
/// prompts de feature.
const PALABRAS_DE_FALLO: &[&str] = &[
    "bug",
    "bugs",
    "falla",
    "fallan",
    "fallo",
    "fallos",
    "peta",
    "petan",
    "revienta",
    "rompe",
    "rompen",
    "roto",
    "rota",
    "crash",
    "crashea",
    "crashes",
    "panic",
    "panics",
    "traceback",
    "stacktrace",
    "exception",
    "excepcion",
    "segfault",
    "fails",
    "failed",
    "failing",
    "failure",
    "broken",
];

/// Locuciones de fallo (dos o tres palabras) sobre el texto normalizado.
const LOCUCIONES_DE_FALLO: &[&str] = &[
    "no compila",
    "no arranca",
    "no funciona",
    "no responde",
    "no carga",
    "no abre",
    "deja de funcionar",
    "se cuelga",
    "se cae",
    "se queda colgado",
    "stack trace",
    "sale error",
    "sale un error",
    "sale el error",
    "da error",
    "da un error",
    "lanza error",
    "lanza un error",
    "devuelve error",
    "devuelve un error",
    "tira error",
    "tira un error",
    "doesn't work",
    "does not work",
    "not working",
];

/// Minúsculas, sin tildes en las vocales, puntuación → espacio, espacios
/// colapsados. Así "FALLÓ:" casa con `fallo` y las locuciones se comparan
/// sobre una sola forma.
fn normalizar_prompt(prompt: &str) -> String {
    let mut out = String::with_capacity(prompt.len());
    for ch in prompt.chars() {
        let mapped = match ch.to_lowercase().next().unwrap_or(ch) {
            'á' | 'à' | 'ä' => 'a',
            'é' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'ï' => 'i',
            'ó' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'ü' => 'u',
            c if c.is_alphanumeric() || c == '\'' => c,
            _ => ' ',
        };
        out.push(mapped);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// ¿El prompt trae vocabulario de fallo? Palabras completas (`bugatti` o
/// `terror` no cuentan) y locuciones sobre el texto normalizado.
pub fn tiene_lexico_de_fallo(prompt: &str) -> bool {
    let texto = normalizar_prompt(prompt);
    if texto.is_empty() {
        return false;
    }
    let por_palabra = texto
        .split(' ')
        .any(|palabra| PALABRAS_DE_FALLO.contains(&palabra));
    if por_palabra {
        return true;
    }
    let con_bordes = format!(" {texto} ");
    LOCUCIONES_DE_FALLO
        .iter()
        .any(|loc| con_bordes.contains(&format!(" {loc} ")))
}

fn sin_prefijo(titulo: &str) -> String {
    titulo
        .trim()
        .strip_prefix("[lesson]")
        .unwrap_or(titulo)
        .trim()
        .to_string()
}

/// ¿La lección encaja con el síntoma? Dense >= `LESSON_MIN_DENSE`; si el dense
/// no está (E5/Qdrant caídos, modo degradado) solo pasa la primera del sparse,
/// que es la única con señal léxica fuerte.
fn encaja_con_el_sintoma(e: &RecallEntry) -> bool {
    match e.dense_score {
        Some(s) => s >= LESSON_MIN_DENSE,
        None => e.sparse_rank == Some(0),
    }
}

/// Filtro puro sobre las entradas del recall: solo `lesson`, que encajen con el
/// síntoma, sin las que ya están en el pack del proyecto, como mucho
/// `MAX_LECCIONES`, en el orden del recall (ya viene por score).
pub fn filtrar_lecciones(entries: &[RecallEntry], ya_inyectadas: &[RecallEntry]) -> Vec<LessonHit> {
    entries
        .iter()
        .filter(|e| e.kind == "lesson")
        .filter(|e| encaja_con_el_sintoma(e))
        .filter(|e| {
            !ya_inyectadas
                .iter()
                .any(|m| m.canonical_id == e.canonical_id)
        })
        .map(|e| LessonHit {
            canonical_id: e.canonical_id.clone(),
            rule: sin_prefijo(e.title.as_deref().unwrap_or("")),
            symptom_cause: e.summary.clone().unwrap_or_default(),
            project_id: e.project_id.clone(),
            score: e.score,
        })
        .filter(|l| !l.rule.is_empty())
        .take(MAX_LECCIONES)
        .collect()
}

/// Recall cross-project de lecciones. Devuelve (lecciones, avisos). Fail-safe:
/// sin recall, lista vacía y un aviso; nunca rompe el turno.
pub fn recall_lecciones(
    prompt: &str,
    project_id: Option<&str>,
    dense_enabled: bool,
    rerank: bool,
    ya_inyectadas: &[RecallEntry],
) -> (Vec<LessonHit>, Vec<String>) {
    match build_trace_typed(
        prompt,
        FANOUT,
        project_id,
        true,
        dense_enabled,
        rerank,
        Some(MemoryType::Lesson),
    ) {
        Ok(t) => (filtrar_lecciones(&t.injected, ya_inyectadas), Vec::new()),
        Err(e) => (Vec::new(), vec![format!("lessons recall unavailable: {e}")]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, kind: &str, title: &str, project: Option<&str>) -> RecallEntry {
        RecallEntry {
            canonical_id: id.to_string(),
            title: Some(title.to_string()),
            summary: Some(format!("sintoma de {id} → causa de {id}")),
            scope: "project".to_string(),
            project_id: project.map(str::to_string),
            kind: kind.to_string(),
            score: 0.5,
            dense_rank: Some(0),
            sparse_rank: None,
            dense_score: Some(0.9),
            reason: String::new(),
            token_estimate: 10,
        }
    }

    #[test]
    fn una_leccion_lejana_del_sintoma_no_se_inyecta() {
        // Medido 2026-09-03: con solo 3 lecciones en el corpus, un fallo de
        // macro Rust traia tambien la de "formato de salida" y la de "RAM".
        let mut lejana = entry("lejos", "lesson", "[lesson] otra cosa", Some("otro"));
        lejana.dense_score = Some(0.5);
        let mut justa = entry("justa", "lesson", "[lesson] en el limite", Some("otro"));
        justa.dense_score = Some(LESSON_MIN_DENSE);
        let l = filtrar_lecciones(&[lejana, justa], &[]);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].canonical_id, "justa");
    }

    #[test]
    fn sin_dense_solo_pasa_la_primera_del_sparse() {
        let mut top = entry("top", "lesson", "[lesson] primera del bm25", Some("otro"));
        top.dense_score = None;
        top.sparse_rank = Some(0);
        let mut tercera = entry(
            "tercera",
            "lesson",
            "[lesson] tercera del bm25",
            Some("otro"),
        );
        tercera.dense_score = None;
        tercera.sparse_rank = Some(2);
        let mut sin_nada = entry("nada", "lesson", "[lesson] sin señal", Some("otro"));
        sin_nada.dense_score = None;
        sin_nada.sparse_rank = None;
        let l = filtrar_lecciones(&[tercera, sin_nada, top], &[]);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].canonical_id, "top");
    }

    #[test]
    fn solo_los_turnos_de_fallo_son_sintoma() {
        let neutro = "documenta el modulo de rutas";
        assert!(es_sintoma("bug_fix", None, neutro));
        assert!(es_sintoma("general", Some("debug"), neutro));
        assert!(!es_sintoma("feature", Some("feature"), neutro));
        assert!(!es_sintoma("general", None, neutro));
        assert!(!es_sintoma("refactor", Some("refactor"), neutro));
    }

    #[test]
    fn el_lexico_de_fallo_abre_la_puerta_aunque_el_intent_sea_de_lenguaje() {
        // Medido 2026-09-03: estos prompts rutean a `rust`/`python` + workflow
        // `feature`, y la leccion que los resolvia (top-1 del recall) no llegaba.
        assert!(es_sintoma(
            "rust",
            Some("feature"),
            "hay un bug: al compilar con cargo sale el error doc comment not allowed here"
        ));
        assert!(es_sintoma(
            "python",
            Some("feature"),
            "el script peta con un traceback al arrancar"
        ));
        assert!(es_sintoma(
            "general",
            None,
            "no compila desde el ultimo cambio"
        ));
        assert!(es_sintoma("general", None, "Cargo build FALLA en CI"));
        assert!(es_sintoma(
            "general",
            None,
            "la app se rompe al abrir la pestaña Finance"
        ));
    }

    #[test]
    fn el_lexico_de_fallo_no_salta_con_palabras_parecidas_ni_prompts_de_feature() {
        assert!(!tiene_lexico_de_fallo(
            "me gusta el bugatti y el cine de terror"
        ));
        assert!(!tiene_lexico_de_fallo(
            "añade un boton para exportar el informe mensual"
        ));
        assert!(!tiene_lexico_de_fallo("panico escenico"));
        assert!(!es_sintoma(
            "feature",
            Some("feature"),
            "haz la pantalla de errores mas bonita"
        ));
    }

    #[test]
    fn filtra_por_tipo_y_quita_el_prefijo_del_titulo() {
        let entries = vec![
            entry("a", "decision", "una decision", Some("otro")),
            entry(
                "b",
                "lesson",
                "[lesson] Reinicia el daemon tras cambiar el entorno",
                Some("otro"),
            ),
            entry("c", "fact", "un hecho", None),
        ];
        let l = filtrar_lecciones(&entries, &[]);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].rule, "Reinicia el daemon tras cambiar el entorno");
        assert_eq!(l[0].project_id.as_deref(), Some("otro"));
        assert!(l[0].symptom_cause.starts_with("sintoma de b"));
    }

    #[test]
    fn no_repite_lo_que_ya_trae_el_pack_ni_pasa_del_tope() {
        let ya = vec![entry(
            "b",
            "lesson",
            "[lesson] ya inyectada",
            Some("ultron"),
        )];
        let entries: Vec<RecallEntry> = (0..6)
            .map(|i| {
                entry(
                    &format!("l{i}"),
                    "lesson",
                    &format!("[lesson] regla {i}"),
                    Some("otro"),
                )
            })
            .chain(std::iter::once(entry(
                "b",
                "lesson",
                "[lesson] ya inyectada",
                Some("ultron"),
            )))
            .collect();
        let l = filtrar_lecciones(&entries, &ya);
        assert_eq!(l.len(), MAX_LECCIONES);
        assert!(l.iter().all(|x| x.canonical_id != "b"));
    }

    #[test]
    fn una_leccion_sin_titulo_no_se_inyecta() {
        let mut e = entry("x", "lesson", "", Some("otro"));
        e.title = None;
        assert!(filtrar_lecciones(&[e], &[]).is_empty());
    }
}
