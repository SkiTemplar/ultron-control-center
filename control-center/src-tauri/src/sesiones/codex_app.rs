//! Cliente stdio del app-server Codex; el propietario administra el proceso.
use super::codex_app_normalizar::{self as normalizar, FlujoCodex};
use super::motor_eventos::EventoMotor;
use super::proto_rpc::{ClienteRpc, Respondedor, RpcError};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Emisor = Arc<dyn Fn(EventoMotor) + Send + Sync>;
type Permisos = Arc<Mutex<HashMap<String, Aprobacion>>>;

/// Método de aprobación de Codex cuya respuesta no es `{ decision }`.
const APROBACION_PERMISOS: &str = "item/permissions/requestApproval";

/// Petición de aprobación pendiente: su respondedor, el método y los permisos
/// solicitados (solo en `item/permissions/requestApproval`).
struct Aprobacion {
    respondedor: Respondedor,
    metodo: String,
    solicitados: Value,
}

#[path = "codex_app_comandos.rs"]
mod comandos;
#[path = "codex_app_politica.rs"]
mod politica;
#[cfg(test)]
pub use politica::{AccionRed, EnmiendaRed};
pub use politica::{Decision, PoliticaCodex};

/// URL de imagen (incluidas URL data:) o ruta local, según UserInput del esquema.
pub enum ImagenCodex {
    #[allow(dead_code, reason = "el composer actual envía rutas locales")]
    Url(String),
    Local(String),
}

#[derive(Default)]
struct Estado {
    hilo: Option<String>,
    turno: Option<String>,
    flujo: FlujoCodex,
    politica: Option<(PoliticaCodex, String)>,
}

pub struct ClienteCodexApp {
    rpc: ClienteRpc,
    estado: Arc<Mutex<Estado>>,
    permisos: Permisos,
}
impl ClienteCodexApp {
    pub fn nuevo(
        lector: impl BufRead + Send + 'static,
        escritor: impl Write + Send + 'static,
        emitir: impl Fn(EventoMotor) + Send + Sync + 'static,
    ) -> Self {
        let emitir: Emisor = Arc::new(emitir);
        let permisos = Permisos::default();
        let pendientes = permisos.clone();
        let estado = Arc::new(Mutex::new(Estado::default()));
        let estado_aviso = estado.clone();
        let emisor_peticion = emitir.clone();
        let rpc = ClienteRpc::nuevo(
            lector,
            escritor,
            move |metodo, parametros, respondedor| {
                recibir_peticion(
                    &metodo,
                    &parametros,
                    respondedor,
                    &pendientes,
                    &emisor_peticion,
                )
            },
            move |metodo, parametros| {
                for evento in recibir_aviso(&estado_aviso, &metodo, &parametros) {
                    emitir(evento);
                }
            },
        );
        Self {
            rpc,
            estado,
            permisos,
        }
    }

    pub fn iniciar(&self, plazo: Duration) -> Result<Value, RpcError> {
        let resultado = self.rpc.request(
            "initialize",
            json!({"clientInfo":{"name":"ultron","version":env!("CARGO_PKG_VERSION")}}),
            plazo,
        )?;
        self.rpc.notify("initialized", json!({}))?;
        Ok(resultado)
    }

    pub fn nuevo_hilo(
        &self,
        cwd: &str,
        politica: PoliticaCodex,
        plazo: Duration,
    ) -> Result<Value, RpcError> {
        self.abrir("thread/start", politica.parametros(cwd), plazo)
    }

    #[cfg(test)]
    pub fn retomar_hilo(&self, id: &str, plazo: Duration) -> Result<Value, RpcError> {
        self.abrir("thread/resume", json!({"threadId":id}), plazo)
    }

    pub(super) fn retomar_con_politica(
        &self,
        id: &str,
        cwd: &str,
        politica: PoliticaCodex,
        plazo: Duration,
    ) -> Result<Value, RpcError> {
        let mut parametros = politica.parametros(cwd);
        parametros["threadId"] = json!(id);
        self.abrir("thread/resume", parametros, plazo)
    }

    fn abrir(&self, metodo: &str, parametros: Value, plazo: Duration) -> Result<Value, RpcError> {
        let resultado = self.rpc.request(metodo, parametros, plazo)?;
        let id = resultado["thread"]["id"]
            .as_str()
            .ok_or_else(|| error_local("Respuesta Codex sin thread.id"))?;
        let mut estado = self.estado.lock().map_err(error_bloqueo)?;
        estado.hilo = Some(id.into());
        estado.turno = None;
        estado.flujo = FlujoCodex::default();
        Ok(resultado)
    }

    #[cfg(test)]
    pub fn turno(
        &self,
        texto: &str,
        imagenes: &[ImagenCodex],
        plazo: Duration,
    ) -> Result<Value, RpcError> {
        self.turno_con_modelo(texto, imagenes, None, plazo)
    }

    pub(super) fn turno_con_modelo(
        &self,
        texto: &str,
        imagenes: &[ImagenCodex],
        modelo: Option<&str>,
        plazo: Duration,
    ) -> Result<Value, RpcError> {
        let mut parametros = json!({"threadId":self.hilo()?,"input":entrada(texto,imagenes)});
        // generate-ts de Codex 0.162.1 admite ambos campos por turno;
        // cambiar el modo conserva el proceso y la política llega al siguiente turn/start.
        if let Some((politica, cwd)) = &self.estado.lock().map_err(error_bloqueo)?.politica {
            if let Some(campos) = politica.parametros_turno(cwd).as_object() {
                parametros
                    .as_object_mut()
                    .ok_or_else(|| error_local("turno inválido"))?
                    .extend(campos.clone());
            }
        }
        if let Some(modelo) = modelo {
            parametros["model"] = json!(modelo);
        }
        let resultado = self.rpc.request("turn/start", parametros, plazo)?;
        let id = resultado["turn"]["id"]
            .as_str()
            .ok_or_else(|| error_local("Respuesta Codex sin turn.id"))?;
        self.estado.lock().map_err(error_bloqueo)?.turno = Some(id.into());
        Ok(resultado)
    }

    pub(super) fn establecer_politica(
        &self,
        politica: PoliticaCodex,
        cwd: &str,
    ) -> Result<(), RpcError> {
        self.estado.lock().map_err(error_bloqueo)?.politica = Some((politica, cwd.into()));
        Ok(())
    }

    pub fn responder_aprobacion(
        &self,
        id_peticion: &str,
        decision: Decision,
    ) -> Result<(), RpcError> {
        let aprobacion = self
            .permisos
            .lock()
            .map_err(error_bloqueo)?
            .remove(id_peticion)
            .ok_or_else(|| error_local("Aprobación desconocida o ya respondida"))?;
        let respuesta = respuesta_aprobacion(&aprobacion.metodo, &aprobacion.solicitados, decision);
        aprobacion.respondedor.responder(Ok(respuesta))
    }

    fn hilo(&self) -> Result<String, RpcError> {
        self.estado
            .lock()
            .map_err(error_bloqueo)?
            .hilo
            .clone()
            .ok_or_else(|| error_local("No hay hilo Codex abierto"))
    }

    fn turno_activo(&self) -> Result<(String, String), RpcError> {
        let estado = self.estado.lock().map_err(error_bloqueo)?;
        let hilo = estado
            .hilo
            .clone()
            .ok_or_else(|| error_local("No hay hilo Codex abierto"))?;
        let turno = estado
            .turno
            .clone()
            .ok_or_else(|| error_local("No hay turno Codex activo"))?;
        Ok((hilo, turno))
    }
}

fn recibir_aviso(estado: &Mutex<Estado>, metodo: &str, parametros: &Value) -> Vec<EventoMotor> {
    match estado.lock() {
        Ok(mut estado) => {
            if metodo == "turn/started" {
                estado.turno = parametros["turn"]["id"].as_str().map(str::to_string);
            }
            if metodo == "turn/completed" {
                estado.turno = None;
            }
            estado.flujo.aplicar(metodo, parametros)
        }
        Err(_) => vec![EventoMotor::Error("Estado Codex envenenado".into())],
    }
}
impl Drop for ClienteCodexApp {
    fn drop(&mut self) {
        if let Ok(mut pendientes) = self.permisos.lock() {
            pendientes.clear();
        }
    }
}

fn recibir_peticion(
    metodo: &str,
    parametros: &Value,
    respondedor: Respondedor,
    permisos: &Permisos,
    emitir: &Emisor,
) {
    if !normalizar::es_aprobacion(metodo) {
        let _ = respondedor.responder(Err(RpcError::Remoto {
            codigo: -32601,
            mensaje: format!("Método Codex no soportado: {metodo}"),
        }));
        return;
    }
    let id = respondedor.id().to_string();
    let evento = normalizar::permiso(&id, metodo, parametros);
    let aprobacion = Aprobacion {
        respondedor,
        metodo: metodo.to_string(),
        solicitados: parametros
            .get("permissions")
            .cloned()
            .unwrap_or(Value::Null),
    };
    match permisos.lock() {
        Ok(mut pendientes) => {
            pendientes.insert(id, aprobacion);
        }
        Err(_) => {
            // Al descartarla, el `Drop` del respondedor contesta con error.
            drop(aprobacion);
            tracing::warn!("mapa de aprobaciones de Codex envenenado: la petición se rechaza");
            return;
        }
    }
    emitir(evento);
}

/// Respuesta a una aprobación. `item/permissions/requestApproval` espera
/// `{ permissions, scope }` (esquema de la CLI 0.162.1): aceptar concede los
/// permisos solicitados (los campos no nulos) para el turno o la sesión;
/// rechazar o cancelar no concede ninguno. El resto espera `{ decision }`.
fn respuesta_aprobacion(metodo: &str, solicitados: &Value, decision: Decision) -> Value {
    if metodo != APROBACION_PERMISOS {
        return json!({ "decision": decision });
    }
    let (concedidos, alcance) = match decision {
        Decision::Accept => (no_nulos(solicitados), "turn"),
        Decision::AcceptForSession => (no_nulos(solicitados), "session"),
        _ => (json!({}), "turn"),
    };
    json!({ "permissions": concedidos, "scope": alcance })
}

/// Copia de un objeto sin sus campos nulos (`{}` si no es un objeto).
fn no_nulos(v: &Value) -> Value {
    let campos = v
        .as_object()
        .map(|o| {
            o.iter()
                .filter(|(_, x)| !x.is_null())
                .map(|(k, x)| (k.clone(), x.clone()))
                .collect()
        })
        .unwrap_or_default();
    Value::Object(campos)
}

fn entrada(texto: &str, imagenes: &[ImagenCodex]) -> Vec<Value> {
    let mut entrada = vec![json!({"type":"text","text":texto,"text_elements":[]})];
    entrada.extend(imagenes.iter().map(|imagen| match imagen {
        ImagenCodex::Url(url) => json!({"type":"image","url":url}),
        ImagenCodex::Local(ruta) => json!({"type":"localImage","path":ruta}),
    }));
    entrada
}
fn error_local(mensaje: &str) -> RpcError {
    RpcError::Transporte(mensaje.into())
}
fn error_bloqueo<T>(_: std::sync::PoisonError<T>) -> RpcError {
    error_local("Estado Codex envenenado")
}

#[cfg(test)]
#[path = "tests_codex_app.rs"]
mod tests;
