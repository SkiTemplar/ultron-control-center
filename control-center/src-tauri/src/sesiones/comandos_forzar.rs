// sesiones/comandos_forzar.rs — Comandos Tauri de «Segundo plano» e
// «Interrumpir y enviar» (CONTRATO-v3, §3.4). Hacen E/S de PTY y esperan
// (≤ 3 s el Ctrl+B, la interrupción de §3.3): pasan por `blocking()`.
//
// Propiedad: WP-PTY.

use super::comandos::blocking;
use super::types::{BackgroundOutcome, InterruptSendOutcome, QueueItemInput, QueueItemKind};
use super::{cola, forzar, segundo_plano};

/// Ctrl+B sobre la herramienta en primer plano, verificado por su cierre.
#[tauri::command]
pub async fn sesiones_background(id: String) -> Result<BackgroundOutcome, String> {
    blocking(move || segundo_plano::background(&id)).await
}

/// Encola el mensaje el primero, interrumpe el turno y lo envía por delante
/// de lo que la interrupción devolvió a la cola. Idempotente por `clientId`.
#[tauri::command]
pub async fn sesiones_interrupt_send(
    id: String,
    text: String,
    attachments: Option<Vec<String>>,
    client_id: Option<String>,
    delegate: Option<bool>,
) -> Result<InterruptSendOutcome, String> {
    let client_id = client_id
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let attachments = attachments.unwrap_or_default();
    if text.trim().is_empty() && attachments.is_empty() {
        return Err("el mensaje está vacío".to_string());
    }
    blocking(move || {
        let input = QueueItemInput {
            client_id,
            kind: tipo(&text, !attachments.is_empty()),
            text,
            attachments,
            delegate: delegate.unwrap_or(false),
        };
        let r = forzar::interrupt_send(&id, input);
        cola::emitir_actual(&id);
        r
    })
    .await
}

/// `!bash`, `/comando` o prompt, como `itemKind` en `composer/submit.ts`
/// sin catálogo: un `/comando` con adjuntos o mal formado (una ruta de Git
/// Bash) es un prompt, porque el buzón no lleva adjuntos (H5).
fn tipo(text: &str, con_adjuntos: bool) -> QueueItemKind {
    cola::tipo_de_texto(text, con_adjuntos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_tipo_sale_del_texto_y_de_los_adjuntos() {
        assert_eq!(tipo("!ls", false), QueueItemKind::Bash);
        assert_eq!(tipo("  /compact", false), QueueItemKind::Command);
        assert_eq!(tipo("hola / adiós", false), QueueItemKind::Prompt);
        assert_eq!(tipo("", false), QueueItemKind::Prompt);
        // Casos negativos de H5: con capturas o con una ruta no es un comando.
        assert_eq!(tipo("/review mira esto", true), QueueItemKind::Prompt);
        assert_eq!(tipo("/c/Users/x/a.png", false), QueueItemKind::Prompt);
    }
}
