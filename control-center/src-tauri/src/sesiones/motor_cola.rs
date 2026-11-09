//! FIFO volátil de las sesiones de motor, independiente de la cola del PTY.
//! Nunca se emite ni se consulta/envía al motor con el candado tomado.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use super::motor_sesion::{self, Mensaje, Turno};
use super::types::{
    now_iso, QueueItem, QueueItemInput, QueueItemKind, QueueItemPatch, QueueOrigin, QueueState,
};

type Envio = dyn Fn(&str, &Mensaje<'_>) -> Result<(), String> + Send + Sync;
type Emision = dyn Fn(&str, &[QueueItem]) + Send + Sync;
type Trabajo = Box<dyn FnOnce() + Send>;
pub(super) const ERROR_ACP: &str =
    "Gemini/OpenCode no admite añadir mensajes a un turno en curso: se envía al terminar";
#[path = "motor_cola_envio_ya.rs"]
mod envio_ya;

enum Desenlace {
    Aceptado,
    Fallido(String),
    Ocupado,
}

/// Dependencias inyectables para probar sin procesos ni ventanas.
pub(super) struct Entorno {
    pub libre: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub enviar: Arc<Envio>,
    pub emitir: Arc<Emision>,
    pub ejecutar: Arc<dyn Fn(Trabajo) + Send + Sync>,
}

#[derive(Default)]
struct Cola {
    items: Vec<QueueItem>,
    conocidos: HashSet<String>,
    // Distingue una cola nueva tras cerrar y reabrir del envío antiguo.
    generacion: uuid::Uuid,
}

pub struct Colas {
    mapa: Mutex<HashMap<String, Cola>>,
    pub(super) entorno: Entorno,
}

impl Colas {
    pub(super) fn nueva(entorno: Entorno) -> Arc<Self> {
        Arc::new(Self {
            mapa: Mutex::new(HashMap::new()),
            entorno,
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, HashMap<String, Cola>>, String> {
        self.mapa
            .lock()
            .map_err(|_| "cola de motor envenenada".into())
    }

    pub fn lista(&self, id: &str) -> Result<Vec<QueueItem>, String> {
        Ok(self
            .lock()?
            .get(id)
            .map(|c| c.items.clone())
            .unwrap_or_default())
    }

    fn cambiar(
        &self,
        id: &str,
        cambio: impl FnOnce(&mut Cola) -> Result<(), String>,
    ) -> Result<Vec<QueueItem>, String> {
        let items = {
            let mut mapa = self.lock()?;
            let cola = mapa.entry(id.into()).or_insert_with(|| Cola {
                generacion: uuid::Uuid::new_v4(),
                ..Default::default()
            });
            cambio(cola)?;
            cola.items.clone()
        };
        (self.entorno.emitir)(id, &items);
        Ok(items)
    }

    pub fn encolar(
        self: &Arc<Self>,
        id: &str,
        entrada: QueueItemInput,
    ) -> Result<Vec<QueueItem>, String> {
        if entrada.client_id.trim().is_empty() {
            return Err("falta clientId".into());
        }
        self.cambiar(id, |cola| {
            if !cola.conocidos.insert(entrada.client_id.clone()) {
                return Ok(());
            }
            cola.items.push(QueueItem {
                client_id: entrada.client_id,
                text: entrada.text,
                attachments: entrada.attachments,
                delegate: false,
                kind: QueueItemKind::Prompt,
                origin: QueueOrigin::Ultron,
                state: QueueState::Queued,
                created_at: now_iso(),
                sent_at: None,
                error: None,
                message_uuid: None,
            });
            Ok(())
        })?;
        self.drenar(id);
        self.lista(id)
    }

    pub fn editar(
        &self,
        id: &str,
        client_id: &str,
        patch: QueueItemPatch,
    ) -> Result<Vec<QueueItem>, String> {
        self.cambiar(id, |cola| {
            let i = editable(cola, client_id)?;
            if let Some(texto) = patch.text {
                i.text = texto;
            }
            if let Some(adjuntos) = patch.attachments {
                i.attachments = adjuntos;
            }
            Ok(())
        })
    }

    pub fn quitar(&self, id: &str, client_id: &str) -> Result<Vec<QueueItem>, String> {
        self.cambiar(id, |cola| {
            editable(cola, client_id)?;
            cola.items.retain(|i| i.client_id != client_id);
            Ok(())
        })
    }

    pub fn mover(
        &self,
        id: &str,
        client_id: &str,
        destino: usize,
    ) -> Result<Vec<QueueItem>, String> {
        self.cambiar(id, |cola| {
            editable(cola, client_id)?;
            let indice = cola
                .items
                .iter()
                .position(|i| i.client_id == client_id)
                .ok_or_else(|| "no existe el elemento de cola".to_string())?;
            let item = cola.items.remove(indice);
            cola.items.insert(destino.min(cola.items.len()), item);
            Ok(())
        })
    }

    pub fn reintentar(
        self: &Arc<Self>,
        id: &str,
        client_id: &str,
    ) -> Result<Vec<QueueItem>, String> {
        self.cambiar(id, |cola| {
            let i = editable(cola, client_id)?;
            if i.state != QueueState::Failed {
                return Err("el elemento no ha fallado".into());
            }
            i.state = QueueState::Queued;
            i.error = None;
            i.sent_at = None;
            Ok(())
        })?;
        self.drenar(id);
        self.lista(id)
    }

    pub fn olvidar(&self, id: &str) {
        if let Ok(mut mapa) = self.lock() {
            mapa.remove(id);
        }
        (self.entorno.emitir)(id, &[]);
    }

    fn reservar(&self, id: &str, client_id: Option<&str>) -> Option<(QueueItem, uuid::Uuid)> {
        let mut mapa = self.lock().ok()?;
        let cola = mapa.get_mut(id)?;
        if cola.items.iter().any(|i| i.state == QueueState::Sending) {
            return None;
        }
        let item = cola.items.iter_mut().find(|i| {
            i.state == QueueState::Queued && client_id.is_none_or(|c| c == i.client_id)
        })?;
        item.state = QueueState::Sending;
        item.sent_at = Some(now_iso());
        Some((item.clone(), cola.generacion))
    }

    pub fn drenar(self: &Arc<Self>, id: &str) {
        self.drenar_elegido(id, None);
    }

    fn drenar_elegido(self: &Arc<Self>, id: &str, client_id: Option<&str>) {
        // Consultar fuera del candado evita invertir el orden de los registros.
        if !(self.entorno.libre)(id) {
            return;
        }
        let Some((item, generacion)) = self.reservar(id, client_id) else {
            return;
        };
        if let Ok(items) = self.lista(id) {
            (self.entorno.emitir)(id, &items);
        }
        let cola = self.clone();
        let id = id.to_string();
        (self.entorno.ejecutar)(Box::new(move || {
            if !cola.vigente(&id, generacion) {
                return;
            }
            // Otro envío pudo ocupar la sesión después de consultar libre.
            if !(cola.entorno.libre)(&id) {
                cola.finalizar(&id, &item.client_id, generacion, Desenlace::Ocupado);
                cola.drenar(&id);
                return;
            }
            let resultado = (cola.entorno.enviar)(
                &id,
                &Mensaje {
                    text: &item.text,
                    attachments: &item.attachments,
                    model: None,
                },
            );
            let aceptado = resultado.is_ok();
            let desenlace = match resultado {
                Ok(()) => Desenlace::Aceptado,
                Err(error) => Desenlace::Fallido(error),
            };
            cola.finalizar(&id, &item.client_id, generacion, desenlace);
            // El turno pudo terminar mientras el elemento seguía en sending.
            if aceptado {
                cola.drenar(&id);
            }
        }));
    }

    fn vigente(&self, id: &str, generacion: uuid::Uuid) -> bool {
        self.lock()
            .is_ok_and(|mapa| mapa.get(id).is_some_and(|c| c.generacion == generacion))
    }

    fn finalizar(&self, id: &str, client_id: &str, generacion: uuid::Uuid, resultado: Desenlace) {
        let items = (|| {
            let mut mapa = self.lock().ok()?;
            let cola = mapa.get_mut(id).filter(|c| c.generacion == generacion)?;
            let indice = cola.items.iter().position(|i| i.client_id == client_id)?;
            match resultado {
                Desenlace::Aceptado => {
                    cola.items.remove(indice);
                }
                Desenlace::Fallido(error) => {
                    cola.items[indice].state = QueueState::Failed;
                    cola.items[indice].error = Some(error);
                }
                Desenlace::Ocupado => {
                    cola.items[indice].state = QueueState::Queued;
                    cola.items[indice].sent_at = None;
                }
            }
            Some(cola.items.clone())
        })();
        if let Some(items) = items {
            (self.entorno.emitir)(id, &items);
        }
    }
}

fn editable<'a>(cola: &'a mut Cola, client_id: &str) -> Result<&'a mut QueueItem, String> {
    let item = cola
        .items
        .iter_mut()
        .find(|i| i.client_id == client_id)
        .ok_or_else(|| "no existe el elemento de cola".to_string())?;
    if !matches!(item.state, QueueState::Queued | QueueState::Failed) {
        return Err("el elemento se está enviando".into());
    }
    Ok(item)
}

pub fn global() -> &'static Arc<Colas> {
    static COLAS: OnceLock<Arc<Colas>> = OnceLock::new();
    COLAS.get_or_init(|| {
        Colas::nueva(Entorno {
            libre: Arc::new(|id| {
                motor_sesion::get(id).is_ok_and(|s| s.open && s.turno == Turno::Libre)
            }),
            enviar: Arc::new(|id, msg| motor_sesion::send(id, msg).map(|_| ())),
            emitir: Arc::new(|id, items| {
                super::registro::emit(
                    super::types::ev::QUEUE,
                    serde_json::json!({"id": id, "items": items}),
                )
            }),
            ejecutar: Arc::new(|trabajo| {
                std::thread::spawn(trabajo);
            }),
        })
    })
}

pub fn drenar(id: &str) {
    global().drenar(id);
}

pub fn olvidar(id: &str) {
    global().olvidar(id);
}
