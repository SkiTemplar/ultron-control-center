// sesiones/cola_prioridad.rs — Alta al principio de la cola para
// «Interrumpir y enviar» (CONTRATO-v3, §3.4). Vive aparte para que `cola.rs`
// no pase de 800 líneas; como submódulo ve los privados de la cola.
//
// Propiedad: WP-ESTADO.

use super::{nuevo, Colas};
use crate::sesiones::maquina::Ms;
use crate::sesiones::types::{QueueItem, QueueItemInput, QueueOrigin, QueueState};

impl Colas {
    /// Alta en `queued` en la primera posición (origen ULTRON). Idempotente
    /// por `clientId`: un elemento que ya existe se devuelve tal cual, sin
    /// moverlo ni cambiar su estado, salvo si está `failed`: ese no llegó a
    /// la CLI (o no se pudo confirmar), así que vuelve a `queued` al
    /// principio, igual que con «Reintentar», y no se informa como enviado.
    pub fn encolar_delante(
        &self,
        id: &str,
        input: QueueItemInput,
        ahora: Ms,
    ) -> Result<QueueItem, String> {
        let mut m = self.lock()?;
        let v = m.entry(id.to_string()).or_default();
        let e = match v.iter().position(|e| e.item.client_id == input.client_id) {
            Some(i) if v[i].item.state != QueueState::Failed => return Ok(v[i].item.clone()),
            Some(i) => {
                let mut e = v.remove(i);
                e.item.state = QueueState::Queued;
                e.item.error = None;
                e
            }
            None => nuevo(input, QueueOrigin::Ultron, ahora),
        };
        let item = e.item.clone();
        v.insert(0, e);
        Ok(item)
    }

    /// Elemento `clientId` de la sesión tal como está ahora.
    pub fn elemento(&self, id: &str, client_id: &str) -> Result<QueueItem, String> {
        self.buscar(id, client_id)
    }
}
