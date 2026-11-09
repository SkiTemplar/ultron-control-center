// sesiones/cola_despacho.rs — Tipo efectivo de un elemento de la cola y su
// despacho al buzón del puente o al PTY (H5, auditoría 2026-10-17).
//
// El buzón (`CommandRun`) solo lleva nombre y argumentos: ni adjuntos ni el
// texto de delegación. Antes todo lo que empezaba por «/» iba por ahí con la
// sesión ocupada, y se perdían las capturas de un `/comando` con adjuntos, se
// rompía una ruta de Git Bash (`/c/Users/...`) y se despachaba mal un
// elemento editado en la cola. Ahora un `command` solo sale por el buzón si
// es un `/nombre` bien formado (la misma forma que `parseSlash` en
// `composer/route.ts`) y no lleva adjuntos ni delegación; si no, es un
// `prompt` y va por el PTY con sus adjuntos, igual que con la sesión libre.
//
// Propiedad: WP-ESTADO.

use super::{Envio, Escritor};
use crate::sesiones::types::QueueItemKind;

/// `(nombre, argumentos)` de un `/nombre [args]` bien formado: el nombre son
/// letras, dígitos, `_`, `:`, `.` o `-`, y tras él solo puede ir un espacio o
/// un tabulador. `None` para una ruta (`/c/Users/x`), un `/` suelto o un
/// texto que no empieza por «/».
pub fn comando_slash(texto: &str) -> Option<(&str, &str)> {
    let linea = texto.trim().strip_prefix('/')?;
    let fin = linea
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '.' | '-')))
        .unwrap_or(linea.len());
    let (nombre, resto) = linea.split_at(fin);
    if nombre.is_empty() {
        return None;
    }
    match resto.chars().next() {
        None => Some((nombre, "")),
        Some(' ' | '\t') => Some((nombre, resto.trim())),
        Some(_) => None,
    }
}

/// Tipo con el que se guarda y se despacha un elemento. Solo baja `command` a
/// `prompt` (nunca sube un prompt: el catálogo lo decide la ventana).
pub fn tipo_efectivo(kind: QueueItemKind, texto: &str, con_extras: bool) -> QueueItemKind {
    if kind == QueueItemKind::Command && (con_extras || comando_slash(texto).is_none()) {
        QueueItemKind::Prompt
    } else {
        kind
    }
}

/// Tipo de un texto sin catálogo («Interrumpir y enviar»): `!bash`, un
/// `/comando` bien formado sin adjuntos, o prompt.
pub fn tipo_de_texto(texto: &str, con_adjuntos: bool) -> QueueItemKind {
    if texto.trim_start().starts_with('!') {
        QueueItemKind::Bash
    } else {
        tipo_efectivo(QueueItemKind::Command, texto, con_adjuntos)
    }
}

/// Comando con puente v2 por el buzón (reserva por el PTY si el buzón no
/// está); todo lo demás, por el escritor del PTY con sus adjuntos.
pub(super) fn despachar(
    id: &str,
    envio: &Envio,
    protocolo: u8,
    w: &dyn Escritor,
) -> Result<(), String> {
    let kind = tipo_efectivo(envio.kind, &envio.texto, !envio.adjuntos.is_empty());
    if kind != envio.kind {
        let pty = Envio {
            kind,
            ..envio.clone()
        };
        return w.escribir(id, &pty);
    }
    if kind == QueueItemKind::Command && protocolo >= 2 {
        if let Some((nombre, args)) = comando_slash(&envio.texto) {
            let op = crate::sesiones::buzon::InboxOp::CommandRun {
                op_id: String::new(),
                command: nombre.to_string(),
                args: args.to_string(),
            };
            match crate::sesiones::buzon::encolar_op(id, op) {
                Ok(_) => return Ok(()),
                Err(e) => {
                    tracing::warn!(sesion = id, error = %e, "buzón no disponible: comando por el PTY")
                }
            }
        }
    }
    w.escribir(id, envio)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::super::{Colas, Contexto};
    use super::*;
    use crate::sesiones::types::{
        QueueItemInput, QueueItemPatch, ScreenState, SendMode, SessionStatus,
    };

    const T0: u64 = 1_700_000_000_000;

    #[derive(Default)]
    struct Espia(Mutex<Vec<Envio>>);

    impl Escritor for Espia {
        fn escribir(&self, _id: &str, envio: &Envio) -> Result<(), String> {
            self.0.lock().expect("espía").push(envio.clone());
            Ok(())
        }
    }

    fn libre_con_puente_v2() -> Contexto {
        Contexto {
            status: SessionStatus::Idle,
            screen: ScreenState::Prompt,
            protocolo: 2,
            terminal: false,
            limite: false,
        }
    }

    fn comando(id: &str, texto: &str, adjuntos: &[&str]) -> QueueItemInput {
        QueueItemInput {
            client_id: id.into(),
            text: texto.into(),
            attachments: adjuntos.iter().map(|a| a.to_string()).collect(),
            delegate: false,
            kind: QueueItemKind::Command,
        }
    }

    #[test]
    fn un_comando_con_adjuntos_va_por_el_pty_como_prompt_y_los_conserva() {
        let c = Colas::default();
        let w = Espia::default();
        let i = comando("a", "/review mira esto", &["C:\\tmp\\captura.png"]);
        c.enviar(
            "h5-adjuntos",
            i,
            SendMode::Auto,
            libre_con_puente_v2(),
            &w,
            T0,
        )
        .expect("envío");
        let escritos = w.0.lock().expect("espía").clone();
        assert_eq!(escritos.len(), 1, "no se pierde por el buzón");
        assert_eq!(escritos[0].kind, QueueItemKind::Prompt);
        assert_eq!(
            escritos[0].adjuntos,
            vec!["C:\\tmp\\captura.png".to_string()]
        );
        assert_eq!(c.lista("h5-adjuntos", T0)[0].kind, QueueItemKind::Prompt);
    }

    /// Un `command` con adjuntos que llega tal cual (p. ej. repuesto de un
    /// `abiertas.json` anterior al arreglo) también sale por el PTY.
    #[test]
    fn despachar_no_manda_al_buzon_un_comando_con_adjuntos() {
        let w = Espia::default();
        let envio = Envio {
            client_id: "x".into(),
            kind: QueueItemKind::Command,
            texto: "/review".into(),
            adjuntos: vec!["C:\\tmp\\a.png".into()],
        };
        despachar("h5-directo", &envio, 2, &w).expect("despachar");
        let escritos = w.0.lock().expect("espía").clone();
        assert_eq!(escritos.len(), 1);
        assert_eq!(escritos[0].kind, QueueItemKind::Prompt);
        assert_eq!(escritos[0].adjuntos, envio.adjuntos);
    }

    #[test]
    fn una_ruta_de_git_bash_encolada_no_es_un_comando() {
        let c = Colas::default();
        let items = c
            .encolar("h5-ruta", comando("r", "/c/Users/x/notas.md", &[]), T0)
            .expect("encolar");
        assert_eq!(items[0].kind, QueueItemKind::Prompt);
        // Caso negativo: un comando bien formado sin adjuntos sigue siendo comando.
        let items = c
            .encolar("h5-ruta", comando("k", "/compact", &[]), T0)
            .expect("encolar");
        let k = items.iter().find(|i| i.client_id == "k").expect("k");
        assert_eq!(k.kind, QueueItemKind::Command);
    }

    #[test]
    fn editar_un_comando_para_anadirle_adjuntos_lo_pasa_a_prompt() {
        let c = Colas::default();
        c.encolar("h5-editar", comando("e", "/review", &[]), T0)
            .expect("encolar");
        let patch = QueueItemPatch {
            text: None,
            attachments: Some(vec!["C:\\tmp\\a.png".into()]),
            delegate: None,
        };
        let items = c.editar("h5-editar", "e", patch, T0).expect("editar");
        assert_eq!(items[0].kind, QueueItemKind::Prompt);
    }

    #[test]
    fn comando_slash_reconoce_solo_un_nombre_bien_formado() {
        assert_eq!(comando_slash("/compact"), Some(("compact", "")));
        assert_eq!(comando_slash("  /model  opus "), Some(("model", "opus")));
        assert_eq!(
            comando_slash("/plugin:skill\targs"),
            Some(("plugin:skill", "args"))
        );
        // Casos negativos: ruta de Git Bash, «/» suelto, salto de línea tras el
        // nombre y texto que no empieza por «/».
        assert_eq!(comando_slash("/c/Users/x/captura.png"), None);
        assert_eq!(comando_slash("/"), None);
        assert_eq!(comando_slash("/review\nmira esto"), None);
        assert_eq!(comando_slash("hola /compact"), None);
    }

    #[test]
    fn tipo_efectivo_baja_a_prompt_un_comando_con_adjuntos_o_mal_formado() {
        let cmd = QueueItemKind::Command;
        assert_eq!(tipo_efectivo(cmd, "/compact", false), cmd);
        assert_eq!(
            tipo_efectivo(cmd, "/review mira", true),
            QueueItemKind::Prompt
        );
        assert_eq!(
            tipo_efectivo(cmd, "/c/Users/x", false),
            QueueItemKind::Prompt
        );
        assert_eq!(tipo_efectivo(cmd, "hola", false), QueueItemKind::Prompt);
        // Nunca sube un prompt a comando ni toca un bash.
        assert_eq!(
            tipo_efectivo(QueueItemKind::Prompt, "/compact", false),
            QueueItemKind::Prompt
        );
        assert_eq!(
            tipo_efectivo(QueueItemKind::Bash, "!ls", true),
            QueueItemKind::Bash
        );
    }

    #[test]
    fn tipo_de_texto_sin_catalogo() {
        assert_eq!(tipo_de_texto("!ls", false), QueueItemKind::Bash);
        assert_eq!(tipo_de_texto("  /compact", false), QueueItemKind::Command);
        assert_eq!(tipo_de_texto("/compact", true), QueueItemKind::Prompt);
        assert_eq!(tipo_de_texto("/c/Users/x", false), QueueItemKind::Prompt);
        assert_eq!(tipo_de_texto("hola / adiós", false), QueueItemKind::Prompt);
        assert_eq!(tipo_de_texto("", false), QueueItemKind::Prompt);
    }
}
