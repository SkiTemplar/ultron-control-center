//! Envío inmediato reservado con la misma exclusión que el drenaje FIFO.
use super::*;

impl Colas {
    pub fn enviar_ya(
        self: &Arc<Self>,
        id: &str,
        client_id: Option<&str>,
    ) -> Result<Vec<QueueItem>, String> {
        let sesion = motor_sesion::get(id)?;
        if sesion.engine != "codex" {
            return Err(ERROR_ACP.into());
        }
        if sesion.turno == Turno::Libre {
            self.drenar_elegido(id, client_id);
            return self.lista(id);
        }
        if !matches!(sesion.turno, Turno::Vivo(_)) {
            return Err("Codex todavía no tiene un turno persistente activo".into());
        }
        self.dirigir_con(id, client_id, &super::super::motor_vivo::dirigir)
    }

    pub(super) fn dirigir_con(
        &self,
        id: &str,
        client_id: Option<&str>,
        enviar: &dyn Fn(&str, &QueueItem) -> Result<(), String>,
    ) -> Result<Vec<QueueItem>, String> {
        loop {
            let reserva = {
                let mut mapa = self.lock()?;
                let Some(cola) = mapa.get_mut(id) else {
                    break;
                };
                if cola.items.iter().any(|i| i.state == QueueState::Sending) {
                    break;
                }
                let Some(item) = cola.items.iter_mut().find(|i| {
                    i.state == QueueState::Queued && client_id.is_none_or(|c| c == i.client_id)
                }) else {
                    break;
                };
                item.state = QueueState::Sending;
                (item.clone(), cola.generacion)
            };
            let (item, generacion) = reserva;
            let resultado = enviar(id, &item);
            let desenlace = match &resultado {
                Ok(()) => Desenlace::Aceptado,
                Err(e) => Desenlace::Fallido(e.clone()),
            };
            self.finalizar(id, &item.client_id, generacion, desenlace);
            resultado?;
        }
        self.lista(id)
    }
}
