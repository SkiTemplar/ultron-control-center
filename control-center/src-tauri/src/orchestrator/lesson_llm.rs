//! lesson_llm.rs — destilado de lecciones al cerrar sesión (ULTRON 4, F1.2).
//!
//! Decisión Q2b (2026-09-02): al cerrar una sesión, el hook `lesson-distill`
//! (SessionEnd) manda al daemon un digest ya redactado de los últimos turnos y
//! de los errores de herramienta; el daemon le pide a la cadena de proveedores
//! de `skill_llm` entre 0 y 3 lecciones con forma fija (síntoma, causa, regla)
//! y las devuelve validadas. El hook las propone como candidatos `lesson` por
//! el camino de siempre (`ultron-memory candidate`, escritor único): nada se
//! auto-aprueba, todo cae al inbox.
//!
//! Doctrina heredada de `skill_llm`:
//!   - timeout duro y fallo silencioso: sin proveedor, lista vacía;
//!   - misma cuota separada del AI Router (Groq por modelo, Gemini free);
//!   - la respuesta se valida estructuralmente: campos presentes, no vacíos,
//!     recortados, sin duplicados, tope de 3. Nada que no cumpla la forma
//!     llega al pipeline.
//!
//! El digest se redacta AQUÍ además de en el hook (secretos + PII): el texto
//! sale de la máquina y una segunda pasada cuesta microsegundos.

use serde::{Deserialize, Serialize};

/// Por debajo de esto la sesión no da para una lección: una pregunta suelta,
/// un "hola", una sesión abortada. Evita gastar cuota en vacío.
pub const MIN_DIGEST_CHARS: usize = 300;
/// El digest que viaja al proveedor. Las sesiones largas se recortan por el
/// principio: lo reciente es lo que cerró el problema.
pub const MAX_DIGEST_CHARS: usize = 12_000;
/// Tope de lecciones por sesión (decisión Q2b: 1–3).
pub const MAX_LESSONS: usize = 3;
/// Tope por campo, en caracteres. Una regla más larga no es una regla.
pub const MAX_FIELD_CHARS: usize = 280;
/// Salida del modelo: 3 lecciones × 3 campos × ~280 chars caben de sobra.
const MAX_COMPLETION_TOKENS: u32 = 700;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lesson {
    /// Qué se vio fallar (observable, sin interpretar).
    pub symptom: String,
    /// Por qué fallaba (la causa real, no la primera hipótesis).
    pub cause: String,
    /// Qué hacer la próxima vez para no repetirlo, en imperativo.
    pub rule: String,
}

#[derive(Debug, Deserialize)]
struct Respuesta {
    #[serde(default)]
    lessons: Vec<LessonCruda>,
}

#[derive(Debug, Deserialize)]
struct LessonCruda {
    #[serde(default)]
    symptom: String,
    #[serde(default)]
    cause: String,
    #[serde(default)]
    rule: String,
}

/// ¿Merece la pena consultar? Solo con cuerpo suficiente.
pub fn merece_destilar(digest: &str) -> bool {
    digest.trim().chars().count() >= MIN_DIGEST_CHARS
}

fn system_prompt() -> String {
    format!(
        "Eres el destilador de lecciones de un ingeniero de software. Recibes el digest \
de una sesion de trabajo con un asistente de programacion: turnos del usuario, respuestas \
del asistente y errores de herramientas.\n\n\
Extrae entre 0 y {} LECCIONES reutilizables: cosas que, sabidas de antemano, habrian \
evitado un fallo, un rodeo o una perdida de tiempo, y que sirven en OTRO proyecto. \
Cada leccion tiene exactamente tres campos:\n\
- symptom: que se vio fallar, observable y concreto (mensaje de error, comportamiento).\n\
- cause: por que fallaba de verdad (la causa raiz, no la primera hipotesis).\n\
- rule: que hacer la proxima vez, en imperativo y en una frase.\n\n\
Devuelve SOLO JSON con esta forma exacta, sin markdown ni texto alrededor:\n\
{{\"lessons\":[{{\"symptom\":\"...\",\"cause\":\"...\",\"rule\":\"...\"}}]}}\n\n\
Reglas:\n\
- Si la sesion no ensena nada reutilizable (charla, una pregunta, trabajo rutinario sin \
sorpresas), devuelve {{\"lessons\":[]}}. Es mejor cero lecciones que una inventada.\n\
- No resumas la sesion ni listes lo que se hizo: solo lo que se aprendio.\n\
- Nada de nombres de personas ni datos personales.\n\
- Escribe SIEMPRE en espanol, aunque el digest mezcle ingles (salidas de herramientas, \
mensajes de error): los identificadores de codigo y los mensajes de error se citan tal cual.",
        MAX_LESSONS
    )
}

/// Recorta el digest por el principio (lo reciente manda) y lo redacta.
pub fn preparar_digest(digest: &str) -> String {
    let limpio = crate::memory::redaction::redact_pii(&crate::memory::redaction::redact(digest));
    let total = limpio.chars().count();
    if total <= MAX_DIGEST_CHARS {
        return limpio;
    }
    let saltar = total - MAX_DIGEST_CHARS;
    limpio.chars().skip(saltar).collect()
}

fn recortar(s: &str) -> String {
    let plano = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if plano.chars().count() <= MAX_FIELD_CHARS {
        return plano;
    }
    plano.chars().take(MAX_FIELD_CHARS).collect::<String>() + "…"
}

/// Quita un fence de markdown si el modelo lo puso pese a la instrucción.
fn sin_fence(raw: &str) -> &str {
    let t = raw.trim();
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim()
}

/// Valida la respuesta del modelo. Devuelve solo lecciones completas, sin
/// repetir, recortadas y como mucho `MAX_LESSONS`. Cualquier desviación de la
/// forma (JSON ilegible, campos vacíos, un array suelto) se descarta en
/// silencio: el llamante ve una lista más corta, nunca un error.
pub fn parse_lessons(raw: &str) -> Vec<Lesson> {
    let texto = sin_fence(raw);
    let crudas: Vec<LessonCruda> = match serde_json::from_str::<Respuesta>(texto) {
        Ok(r) => r.lessons,
        // Algunos modelos devuelven el array pelado: se acepta.
        Err(_) => serde_json::from_str::<Vec<LessonCruda>>(texto).unwrap_or_default(),
    };
    let mut out: Vec<Lesson> = Vec::new();
    for c in crudas {
        let l = Lesson {
            symptom: recortar(&c.symptom),
            cause: recortar(&c.cause),
            rule: recortar(&c.rule),
        };
        if l.symptom.is_empty() || l.cause.is_empty() || l.rule.is_empty() {
            continue;
        }
        if out.iter().any(|o| {
            o.rule.eq_ignore_ascii_case(&l.rule) || o.symptom.eq_ignore_ascii_case(&l.symptom)
        }) {
            continue;
        }
        out.push(l);
        if out.len() >= MAX_LESSONS {
            break;
        }
    }
    out
}

/// Destila lecciones del digest. Vacío si el digest no da para ello o si
/// ningún proveedor de la cadena responde.
pub fn destilar(digest: &str) -> Vec<Lesson> {
    if !merece_destilar(digest) {
        return Vec::new();
    }
    let preparado = preparar_digest(digest);
    match super::skill_llm::consultar(&system_prompt(), &preparado, MAX_COMPLETION_TOKENS) {
        Some(raw) => parse_lessons(&raw),
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leccion(n: usize) -> String {
        format!("{{\"symptom\":\"sintoma {n}\",\"cause\":\"causa {n}\",\"rule\":\"regla {n}\"}}")
    }

    #[test]
    fn acepta_la_forma_canonica() {
        let raw = format!("{{\"lessons\":[{},{}]}}", leccion(1), leccion(2));
        let l = parse_lessons(&raw);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].symptom, "sintoma 1");
        assert_eq!(l[1].rule, "regla 2");
    }

    #[test]
    fn tolera_fence_de_markdown_y_array_pelado() {
        let con_fence = format!("```json\n{{\"lessons\":[{}]}}\n```", leccion(1));
        assert_eq!(parse_lessons(&con_fence).len(), 1);
        let pelado = format!("[{}]", leccion(3));
        assert_eq!(parse_lessons(&pelado)[0].cause, "causa 3");
    }

    #[test]
    fn una_leccion_incompleta_no_se_cuela() {
        let raw = "{\"lessons\":[{\"symptom\":\"x\",\"cause\":\"\",\"rule\":\"y\"},\
                   {\"symptom\":\"solo sintoma\"}]}";
        assert!(parse_lessons(raw).is_empty());
    }

    #[test]
    fn nunca_mas_del_tope_ni_repetidas() {
        let raw = format!(
            "{{\"lessons\":[{},{},{},{},{}]}}",
            leccion(1),
            leccion(1),
            leccion(2),
            leccion(3),
            leccion(4)
        );
        let l = parse_lessons(&raw);
        assert_eq!(l.len(), MAX_LESSONS);
        assert_eq!(l.iter().filter(|x| x.rule == "regla 1").count(), 1);
    }

    #[test]
    fn basura_devuelve_vacio_sin_lanzar() {
        assert!(parse_lessons("no soy json").is_empty());
        assert!(parse_lessons("").is_empty());
        assert!(parse_lessons("{\"lessons\":[]}").is_empty());
        assert!(parse_lessons("{\"otra\":1}").is_empty());
    }

    #[test]
    fn los_campos_se_recortan() {
        let largo = "a".repeat(MAX_FIELD_CHARS + 50);
        let raw =
            format!("{{\"lessons\":[{{\"symptom\":\"{largo}\",\"cause\":\"c\",\"rule\":\"r\"}}]}}");
        let l = parse_lessons(&raw);
        assert_eq!(l[0].symptom.chars().count(), MAX_FIELD_CHARS + 1); // + elipsis
    }

    #[test]
    fn un_digest_corto_no_merece_consulta() {
        assert!(!merece_destilar("hola"));
        assert!(!merece_destilar(&"x".repeat(MIN_DIGEST_CHARS - 1)));
        assert!(merece_destilar(&"x".repeat(MIN_DIGEST_CHARS)));
        // Sin cuerpo no se toca la red: devuelve vacio al instante.
        assert!(destilar("hola").is_empty());
    }

    #[test]
    fn el_digest_se_recorta_por_el_principio_y_se_redacta() {
        let viejo = "v".repeat(MAX_DIGEST_CHARS);
        let reciente = "RECIENTE";
        let d = format!("{viejo}{reciente}");
        let p = preparar_digest(&d);
        assert_eq!(p.chars().count(), MAX_DIGEST_CHARS);
        assert!(p.ends_with(reciente));
        let con_secreto = "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 en el log";
        assert!(!preparar_digest(con_secreto).contains("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
    }
}
