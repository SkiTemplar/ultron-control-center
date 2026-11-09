// sesiones/titulo.rs — De dónde sale el título de una sesión de Sesiones.
//
// Claude Code resume cada conversación en una línea `{"type":"ai-title",
// "aiTitle":"…"}` de su transcript (293 de 400 transcripts medidos el
// 2026-10-23; en ninguno cambiaba a lo largo de la conversación). Ese resumen
// es el título de la sesión; hasta que llega, vale la primera línea del primer
// prompt. Cada fuente solo pisa a las de menos prioridad y un nombre puesto a
// mano no lo pisa nada.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OrigenTitulo {
    /// «Nueva sesión», «Reanudada …», «Rama de …».
    #[default]
    Provisional,
    /// Primera línea del primer prompt.
    Prompt,
    /// Resumen de Claude Code (`aiTitle`).
    Ia,
    /// Renombrada a mano: nada lo pisa.
    Manual,
    /// Guardada por una versión anterior con `titleAuto: false`, que no
    /// distinguía el título del prompt del puesto a mano: lo resuelve el
    /// primer prompt del transcript (`resolver_legado`).
    Legado,
}

impl OrigenTitulo {
    /// El primer prompt puede poner el título.
    pub fn acepta_prompt(self) -> bool {
        self == Self::Provisional
    }

    /// El resumen de Claude Code puede poner el título.
    pub fn acepta_ia(self) -> bool {
        matches!(self, Self::Provisional | Self::Prompt | Self::Ia)
    }

    /// Otra conversación en la misma sesión (`/clear`, otro transcript): un
    /// título automático vuelve a provisional para que el primer prompt y el
    /// resumen de la nueva lo sustituyan (el texto se queda hasta entonces).
    /// El manual y el legado sin resolver se conservan.
    pub fn tras_cambio_de_conversacion(self) -> Self {
        if self.acepta_ia() {
            Self::Provisional
        } else {
            self
        }
    }

    /// Origen de una sesión guardada: `title_source` si lo trae; si no, el
    /// `titleAuto` de las versiones anteriores.
    pub fn desde_guardado(guardado: Option<Self>, title_auto: bool) -> Self {
        guardado.unwrap_or(if title_auto {
            Self::Provisional
        } else {
            Self::Legado
        })
    }

    /// `titleAuto` que se sigue guardando para que una versión anterior lea
    /// bien el fichero.
    pub fn title_auto(self) -> bool {
        self.acepta_prompt()
    }

    /// Un `Legado` cuyo título coincide con el del primer prompt lo puso el
    /// prompt (el resumen lo puede pisar); si no, se renombró a mano.
    pub fn resolver_legado(actual: &str, del_prompt: &str) -> Self {
        if actual == del_prompt {
            Self::Prompt
        } else {
            Self::Manual
        }
    }
}

/// `aiTitle` de una línea `ai-title` del hilo principal, o `None`.
pub fn titulo_ia(v: &Value) -> Option<&str> {
    if v.get("type").and_then(Value::as_str) != Some("ai-title")
        || v.get("agentId").is_some()
        || v.get("isSidechain").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    v.get("aiTitle")
        .and_then(Value::as_str)
        .filter(|t| !t.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cada_fuente_solo_pisa_a_las_de_menos_prioridad() {
        use OrigenTitulo::*;
        assert!(Provisional.acepta_prompt());
        for o in [Prompt, Ia, Manual, Legado] {
            assert!(!o.acepta_prompt(), "{o:?} no lo pisa el prompt");
        }
        for o in [Provisional, Prompt, Ia] {
            assert!(o.acepta_ia(), "{o:?} lo pisa el resumen");
        }
        // Caso negativo: a mano o sin resolver, el resumen no entra.
        assert!(!Manual.acepta_ia());
        assert!(!Legado.acepta_ia());
    }

    #[test]
    fn otra_conversacion_reabre_el_titulo_automatico_y_no_el_manual() {
        use OrigenTitulo::*;
        for o in [Provisional, Prompt, Ia] {
            assert_eq!(o.tras_cambio_de_conversacion(), Provisional, "{o:?}");
        }
        assert_eq!(Manual.tras_cambio_de_conversacion(), Manual);
        assert_eq!(Legado.tras_cambio_de_conversacion(), Legado);
    }

    #[test]
    fn una_sesion_guardada_sin_origen_sale_de_title_auto() {
        use OrigenTitulo::*;
        assert_eq!(OrigenTitulo::desde_guardado(None, true), Provisional);
        assert_eq!(OrigenTitulo::desde_guardado(None, false), Legado);
        assert_eq!(OrigenTitulo::desde_guardado(Some(Ia), false), Ia);
        assert_eq!(
            OrigenTitulo::resolver_legado("Arregla el login", "Arregla el login"),
            Prompt
        );
        assert_eq!(
            OrigenTitulo::resolver_legado("Login", "Arregla el login"),
            Manual
        );
    }

    #[test]
    fn titulo_ia_solo_del_hilo_principal_y_no_vacio() {
        let ok = json!({"type": "ai-title", "aiTitle": "Auditoría de proyectos", "sessionId": "s"});
        assert_eq!(titulo_ia(&ok), Some("Auditoría de proyectos"));
        assert_eq!(
            titulo_ia(&json!({"type": "ai-title", "aiTitle": "  "})),
            None
        );
        assert_eq!(
            titulo_ia(&json!({"type": "last-prompt", "aiTitle": "x"})),
            None
        );
        assert_eq!(
            titulo_ia(&json!({"type": "ai-title", "aiTitle": "x", "agentId": "a"})),
            None
        );
        assert_eq!(
            titulo_ia(&json!({"type": "ai-title", "aiTitle": "x", "isSidechain": true})),
            None
        );
    }
}
