//! intent_llm.rs — rescate del intent para prompts conversacionales.
//!
//! `classify_intent` acierta cuando el prompt viene formulado como un encargo
//! técnico. El usuario real escribe en español coloquial y describe SÍNTOMAS
//! ("no se pueden eliminar fotos", "mi equipo sale mal en la tabla"), así que
//! cae en `general` — y `general` no delega nunca por diseño. Medido sobre 15
//! prompts reales del 2026-08-22: 14 de 15 clasificaban `general`.
//!
//! Este módulo pregunta a un modelo pequeño y rápido SOLO en los turnos que las
//! reglas no supieron clasificar. Sobre esos mismos 15 prompts baja `general` a
//! 3 de 15 (los tres correctos: preguntas de estado sin trabajo asociado), con
//! p50 306 ms y p90 389 ms.
//!
//! DOCTRINA (2026-08-16): nada caro entra en el turno. De ahí que:
//!   - solo se consulte cuando las reglas dicen `general`;
//!   - el timeout sea duro y el fallo devuelva `general`, nunca un error;
//!   - un proveedor caído active un cooldown, para no pagar el timeout entero
//!     en cada prompt mientras dure la caída.

use once_cell::sync::OnceCell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::delegation::DELEGABLE_INTENTS;

/// Techo de espera. El presupuesto del hook es ~6000 ms y el p50 de una
/// orquestación ronda 1300 ms: 800 ms cubren el p90 medido (389 ms) con margen
/// sin poner en riesgo el turno.
const TIMEOUT: Duration = Duration::from_millis(800);

/// Tras un fallo (rate limit, red, 5xx) no se vuelve a intentar durante este
/// tiempo. Sin esto, un proveedor caído cuesta el timeout completo en CADA
/// prompt — el patrón que dejó 12 turnos ciegos con el cross-encoder.
const COOLDOWN_SECS: u64 = 120;

/// Modelo pequeño de razonamiento. Con `reasoning_effort: low` responde una
/// etiqueta en ~300 ms. `llama-3.3-70b-versatile`, que seguía en la config del
/// AI Router, fue retirado por Groq y ya no existe.
const MODEL: &str = "openai/gpt-oss-20b";
const ENDPOINT: &str = "https://api.groq.com/openai/v1/chat/completions";

/// Epoch (segundos) hasta el cual no se consulta al proveedor. 0 = disponible.
static COOLDOWN_UNTIL: AtomicU64 = AtomicU64::new(0);

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn en_cooldown() -> bool {
    COOLDOWN_UNTIL.load(Ordering::Relaxed) > now_secs()
}

fn activar_cooldown() {
    COOLDOWN_UNTIL.store(now_secs() + COOLDOWN_SECS, Ordering::Relaxed);
}

fn http_client() -> Option<&'static reqwest::blocking::Client> {
    static CLIENT: OnceCell<reqwest::blocking::Client> = OnceCell::new();
    CLIENT
        .get_or_try_init(|| {
            reqwest::blocking::Client::builder()
                .timeout(TIMEOUT)
                .build()
        })
        .ok()
}

/// Instrucción del clasificador. Enumera SOLO los intents delegables: el
/// objetivo no es etiquetar bien por gusto, es rescatar trabajo que se puede
/// delegar. Cualquier otra cosa debe caer en `general`.
fn system_prompt() -> String {
    format!(
        "Eres un clasificador de intents para un asistente de programacion. El usuario escribe \
en espanol coloquial y suele describir SINTOMAS en vez de dar ordenes tecnicas.\n\n\
Devuelve SOLO una etiqueta de esta lista: {}, general.\n\n\
Reglas:\n\
- Describir algo que no funciona, sale mal, falta o esta roto = bug_fix, aunque no diga \"arregla\".\n\
- Pedir algo nuevo, continuar trabajo pendiente o \"sigue con X\" = feature.\n\
- Preguntas sobre estado, ubicacion o dudas sin trabajo asociado = general.\n\
- Commits, push, deploy, CI = devops.\n\n\
Ejemplos:\n\
\"No se pueden eliminar fotos ni reordenar paginas\" -> bug_fix\n\
\"mi equipo sale mal en la tabla de clasificacion\" -> bug_fix\n\
\"Adelante, continua trabajando en Album maker\" -> feature\n\
\"Es el de mi escritorio?\" -> general\n\
\"Queda algo pendiente?\" -> general",
        DELEGABLE_INTENTS.join(", ")
    )
}

/// Normaliza la respuesta del modelo y la valida contra la lista canónica.
/// Devuelve el `&'static str` del intent — nunca un `String` del modelo, para
/// que una alucinación no pueda colarse como intent en el resto del pipeline.
pub(super) fn parse_label(raw: &str) -> Option<&'static str> {
    let limpio: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || *c == '_')
        .collect();
    if limpio.is_empty() || limpio == "general" {
        return None;
    }
    DELEGABLE_INTENTS.iter().copied().find(|i| *i == limpio)
}

/// `true` si merece la pena preguntar al modelo. Solo turnos que las reglas no
/// supieron clasificar y que tienen cuerpo suficiente para ser trabajo.
pub(super) fn merece_consulta(intent: &str, prompt: &str) -> bool {
    intent == "general" && prompt.split_whitespace().count() >= 4
}

/// Intent rescatado por el modelo, o `None` si no se pudo (sin clave, en
/// cooldown, timeout, respuesta inválida). `None` significa "quédate con lo que
/// dijeron las reglas": este camino nunca degrada el resultado anterior.
pub fn rescatar_intent(prompt: &str) -> Option<&'static str> {
    if en_cooldown() {
        return None;
    }
    let key = std::env::var("GROQ_API_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())?;
    let client = http_client()?;

    let body = serde_json::json!({
        "model": MODEL,
        "temperature": 0,
        "reasoning_effort": "low",
        "max_completion_tokens": 200,
        "messages": [
            { "role": "system", "content": system_prompt() },
            { "role": "user", "content": prompt }
        ]
    });

    let resp = match client.post(ENDPOINT).bearer_auth(key).json(&body).send() {
        Ok(r) if r.status().is_success() => r,
        // Rate limit, 5xx, red: el proveedor no está para esto ahora mismo.
        _ => {
            activar_cooldown();
            return None;
        }
    };

    let json: serde_json::Value = match resp.json() {
        Ok(v) => v,
        Err(_) => {
            activar_cooldown();
            return None;
        }
    };
    let content = json
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()?;
    parse_label(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solo_acepta_intents_canonicos() {
        assert_eq!(parse_label("bug_fix"), Some("bug_fix"));
        assert_eq!(parse_label("  BUG_FIX \n"), Some("bug_fix"));
        assert_eq!(parse_label("`feature`"), Some("feature"));
    }

    #[test]
    fn una_alucinacion_no_se_cuela_como_intent() {
        // Caso negativo: el modelo puede devolver cualquier cosa. Nada fuera de
        // la lista canónica puede llegar al pipeline.
        assert_eq!(parse_label("arreglar_cosas"), None);
        assert_eq!(parse_label("intent: bug_fix porque el usuario dice"), None);
        assert_eq!(parse_label(""), None);
        assert_eq!(parse_label("   "), None);
        // `general` es "no rescatado": debe comportarse como fallo, no como intent.
        assert_eq!(parse_label("general"), None);
    }

    #[test]
    fn solo_se_consulta_cuando_las_reglas_no_supieron() {
        // Un intent ya resuelto por reglas jamás paga la llamada.
        assert!(!merece_consulta(
            "bug_fix",
            "no se pueden eliminar las fotos del album"
        ));
        // Charla corta: tampoco, no hay trabajo que rescatar.
        assert!(!merece_consulta("general", "vale gracias"));
        assert!(!merece_consulta("general", "si"));
        // General con cuerpo: este es el caso que se perdía.
        assert!(merece_consulta(
            "general",
            "Varias cosas, no se pueden eliminar fotos y faltan paginas"
        ));
    }

    #[test]
    fn el_cooldown_corta_las_llamadas() {
        // Sin cooldown activo el gate deja pasar; tras un fallo, no.
        COOLDOWN_UNTIL.store(0, Ordering::Relaxed);
        assert!(!en_cooldown());
        activar_cooldown();
        assert!(
            en_cooldown(),
            "tras un fallo no se vuelve a llamar al proveedor"
        );
        COOLDOWN_UNTIL.store(0, Ordering::Relaxed);
    }
}
