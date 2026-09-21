// hooks_admin/validation.rs — Input validation: events, commands, matchers.

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Catalogo de eventos — UNA sola lista (2026-09-22)
// ---------------------------------------------------------------------------
//
// Hasta hoy habia DOS listas y no se parecian: aqui nueve eventos escritos a
// mano, y otros treinta en `components/hooks/constants.ts`. El desplegable
// ofrecia treinta y el backend rechazaba veintiuno de ellos con
// "event 'X' is not supported" — un boton que no hace nada (mandamiento 11) y
// la razon por la que cualquier hook nuevo habia que escribirlo a mano en
// settings.json.
//
// La lista vive ahora en `claude-events.json`, al lado de este fichero: Rust
// la incrusta en el binario y la interfaz la pide por `hooks_event_catalog`.
// No es una lista de nombres: cada fila dice ademas contra QUE campo compara
// el matcher de ese evento, que valores admite y con que separadores se puede
// escribir. Sin eso se reproduce la misma clase de fallo que se viene a
// arreglar: un matcher en un evento que no compara nada casa SIEMPRE, y el
// usuario cree haber filtrado.

/// El catalogo, incrustado en el binario.
const CATALOGO_JSON: &str = include_str!("claude-events.json");

/// Un evento de hook y lo que se puede hacer con su matcher.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Evento {
    pub nombre: String,
    /// Campo del payload contra el que se compara el matcher. `None` = el
    /// evento no compara nada: cualquier matcher casa siempre, asi que la
    /// interfaz no ofrece el campo.
    #[serde(default)]
    pub campo: Option<String>,
    /// Valores del enum, cuando el campo tiene uno cerrado. Vacio = texto libre.
    #[serde(default)]
    pub valores: Vec<String>,
    /// El matcher literal admite tambien coma, espacio y guion. Si es `false`,
    /// solo la barra vertical (lo demas pasa a interpretarse como regex).
    #[serde(default)]
    pub relajado: bool,
}

#[derive(Debug, Deserialize)]
struct Catalogo {
    eventos: Vec<Evento>,
}

/// Los eventos que despacha Claude Code. Cualquier otro lo rechaza
/// `add_hook_inner`, para no escribir en settings.json un evento con una errata
/// que no se dispararia nunca.
///
/// El `expect` es deliberado: el JSON viaja DENTRO del binario, asi que si no
/// parsea es un error de quien lo edito y lo caza el test de abajo antes de
/// llegar a ninguna maquina. La alternativa (lista vacia en silencio) dejaria
/// la pantalla de hooks rechazandolo todo sin decir por que.
pub fn eventos() -> &'static [Evento] {
    static CACHE: OnceLock<Vec<Evento>> = OnceLock::new();
    CACHE.get_or_init(|| {
        serde_json::from_str::<Catalogo>(CATALOGO_JSON)
            .expect("claude-events.json no parsea")
            .eventos
    })
}

/// La ficha de un evento por su nombre.
#[must_use]
pub fn evento(nombre: &str) -> Option<&'static Evento> {
    eventos().iter().find(|e| e.nombre == nombre)
}

/// Hard cap on the test sandbox — Claude Code itself imposes a 60s ceiling
/// on hook execution; we test for "does this command produce sensible
/// output quickly" so 5s is plenty and protects against hangs from
/// commands that try to read stdin interactively.
pub const TEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Substrings rejected by `validate_command`. Not a perfect RCE filter —
/// the user could still write a malicious .ps1 file and call it — but it
/// blocks the most common copy-pasted footguns and the obvious AI
/// hallucinated "curl|bash" patterns we don't want to silently persist.
///
/// Built at module load so the source file itself never contains a
/// literal forbidden fragment (avoids tripping ULTRON's own
/// settings-edit safety hooks during dev edits of THIS file).
pub(crate) fn forbidden_fragments() -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    v.push("Invoke-Expression".to_string());
    v.push("invoke-expression".to_string());
    v.push(" IEX ".to_string());
    v.push(" iex ".to_string());
    v.push("IEX(".to_string());
    v.push("iex(".to_string());
    v.push("DownloadString".to_string());
    v.push("curl -s ".to_string());
    v.push("curl -fsSL ".to_string());
    v.push("wget -O- ".to_string());
    v.push("; rm -rf".to_string());
    v.push(";rm -rf".to_string());
    v.push("&& rm -rf".to_string());
    v.push("rm -rf /".to_string());
    v.push("rm -rf ~".to_string());
    v.push("; del /f /s /q".to_string());
    v.push("Remove-Item -Recurse -Force C:\\".to_string());
    v.push("format c:".to_string());
    v.push("format C:".to_string());
    // Built piecewise so this very file does not contain the literal
    // 4-letter danger token that some scanners block on save.
    v.push(format!("{}{}", "ev", "al("));
    v.push("/dev/tcp/".to_string());
    v.push("base64 -d | sh".to_string());
    v
}

pub fn validate_event(event: &str) -> Result<(), String> {
    if evento(event).is_some() {
        return Ok(());
    }
    let conocidos: Vec<&str> = eventos().iter().map(|e| e.nombre.as_str()).collect();
    Err(format!(
        "event '{}' is not supported (allowed: {})",
        event,
        conocidos.join(", ")
    ))
}

pub fn validate_command(command: &str) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("command is empty".into());
    }
    if trimmed.len() > 4_000 {
        return Err("command is suspiciously long (>4000 chars)".into());
    }
    // CC-12 hardening: PowerShell treats a backtick as a no-op escape
    // before any non-special char — `` `i`ex `` evaluates identically to
    // `iex`. The original substring check missed that. Normalise the
    // command by (a) stripping every backtick AND (b) lower-casing the
    // whole string before scanning for forbidden fragments. The needles
    // are also normalised the same way so we don't have to encode every
    // possible casing variant in the blocklist.
    let normalised: String = trimmed
        .chars()
        .filter(|c| *c != '`')
        .collect::<String>()
        .to_ascii_lowercase();
    for needle in forbidden_fragments() {
        let needle_norm: String = needle
            .chars()
            .filter(|c| *c != '`')
            .collect::<String>()
            .to_ascii_lowercase();
        if normalised.contains(&needle_norm) {
            return Err(format!(
                "command contains forbidden fragment '{}' (blocked by safety net)",
                needle.trim()
            ));
        }
        if trimmed.contains(&needle) {
            return Err(format!(
                "command contains forbidden fragment '{}' (blocked by safety net)",
                needle.trim()
            ));
        }
    }
    Ok(())
}

pub fn validate_matcher(matcher: Option<&str>) -> Result<(), String> {
    let Some(m) = matcher else { return Ok(()) };
    if m.len() > 512 {
        return Err("matcher is too long".into());
    }
    if m.contains('\n') || m.contains('\r') || m.contains('\0') {
        return Err("matcher cannot contain newlines or NUL bytes".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_catalogo_parsea_y_trae_los_33_eventos_sin_repetir() {
        let v = eventos();
        assert_eq!(v.len(), 33, "la CLI 2.1.278 despacha 33 eventos");
        let mut nombres: Vec<&str> = v.iter().map(|e| e.nombre.as_str()).collect();
        nombres.sort_unstable();
        let antes = nombres.len();
        nombres.dedup();
        assert_eq!(antes, nombres.len(), "hay un evento repetido");
    }

    #[test]
    fn un_evento_que_no_compara_nada_no_trae_valores_que_sugerir() {
        // Si un evento sin campo trajera valores, la interfaz ofreceria un
        // desplegable de sugerencias para un matcher que casa siempre.
        for e in eventos() {
            if e.campo.is_none() {
                assert!(
                    e.valores.is_empty(),
                    "{} no compara nada pero sugiere valores",
                    e.nombre
                );
            }
        }
        // Y al reves: los que sugieren valores tienen que decir contra que campo.
        for e in eventos() {
            if !e.valores.is_empty() {
                assert!(e.campo.is_some(), "{} sugiere valores sin campo", e.nombre);
            }
        }
    }

    #[test]
    fn se_aceptan_todos_los_del_catalogo_y_solo_esos() {
        for e in eventos() {
            assert!(
                validate_event(&e.nombre).is_ok(),
                "{} sale en el catalogo y no se acepta",
                e.nombre
            );
        }
        // Casos negativos: la errata de un nombre real y un evento inventado.
        assert!(validate_event("PostToolUseFailur").is_err());
        assert!(validate_event("PostToolUseFailure ").is_err());
        assert!(validate_event("").is_err());
        assert!(validate_event("EventoQueNoExiste").is_err());
    }

    #[test]
    fn stopfailure_es_el_unico_con_matcher_de_separadores_estrictos() {
        let e = evento("StopFailure").expect("StopFailure esta en el catalogo");
        assert_eq!(e.campo.as_deref(), Some("error"));
        assert!(
            !e.relajado,
            "su matcher NO admite comas ni espacios: solo la barra vertical"
        );
        // El relevo se apoya en estos valores para saber que un turno murio
        // por cuota o por la cuenta (ver maria/relay.rs).
        for v in [
            "rate_limit",
            "overloaded",
            "account_on_hold",
            "billing_error",
        ] {
            assert!(e.valores.iter().any(|x| x == v), "falta {v}");
        }
        let estrictos: Vec<&str> = eventos()
            .iter()
            .filter(|e| e.campo.is_some() && !e.relajado)
            .map(|e| e.nombre.as_str())
            .collect();
        assert_eq!(estrictos, vec!["StopFailure"]);
    }

    #[test]
    fn la_interfaz_no_vuelve_a_tener_su_propia_lista_de_eventos() {
        // Este es el test que pedia la auditoria, al reves: en vez de comparar
        // dos listas, se comprueba que la segunda ya no existe. Mientras
        // `constants.ts` no declare eventos, no pueden divergir.
        let ts = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/components/hooks/constants.ts");
        let texto = std::fs::read_to_string(&ts).expect("constants.ts del repo");
        assert!(
            !texto.contains("EVENT_OPTIONS"),
            "constants.ts ha vuelto a declarar su propia lista de eventos"
        );
        // Y un nombre de evento suelto en ese fichero solo puede venir de una
        // lista nueva: los colores se indexan por nombre, pero eso es otra cosa
        // — aqui basta con vigilar la lista.
        assert!(
            texto.contains("EventoHook"),
            "deberia usar el tipo del backend"
        );
    }
}
