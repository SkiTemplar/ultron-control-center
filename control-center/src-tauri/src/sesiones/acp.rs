// Adaptador ACP v1, compartido por las sesiones persistentes y las pruebas.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::acp_normalizar;
use super::motor_eventos::EventoMotor;
use super::proto_rpc::{ClienteRpc, Respondedor, RpcError};

type Emisor = Arc<dyn Fn(EventoMotor) + Send + Sync>;
type Permisos = Arc<Mutex<HashMap<String, PermisoPendiente>>>;

struct PermisoPendiente {
    respondedor: Respondedor,
    opciones: Vec<String>,
}

#[derive(Default)]
struct EstadoAcp {
    imagenes: bool,
    sesion: Option<String>,
    opciones: Vec<String>,
}

/// Imagen codificada en base64, sin prefijo de URL de datos.
pub struct ImagenAcp {
    pub tipo_mime: String,
    pub datos: String,
}

pub struct ClienteAcp {
    rpc: ClienteRpc,
    estado: Mutex<EstadoAcp>,
    permisos: Permisos,
    emitir: Emisor,
}

impl ClienteAcp {
    pub fn nuevo(
        lector: impl BufRead + Send + 'static,
        escritor: impl Write + Send + 'static,
        emitir: impl Fn(EventoMotor) + Send + Sync + 'static,
    ) -> Self {
        let emitir: Emisor = Arc::new(emitir);
        let permisos = Permisos::default();
        let permisos_peticion = permisos.clone();
        let emisor_peticion = emitir.clone();
        let emisor_aviso = emitir.clone();
        let rpc = ClienteRpc::nuevo(
            lector,
            escritor,
            move |metodo, parametros, respondedor| {
                recibir_peticion(
                    &metodo,
                    &parametros,
                    respondedor,
                    &permisos_peticion,
                    &emisor_peticion,
                );
            },
            move |metodo, parametros| {
                if metodo == "session/update" {
                    for evento in acp_normalizar::normalizar(&parametros) {
                        emisor_aviso(evento);
                    }
                } else {
                    tracing::debug!(metodo, "Notificación ACP desconocida");
                }
            },
        );
        Self {
            rpc,
            estado: Mutex::default(),
            permisos,
            emitir,
        }
    }

    pub fn initialize(&self, plazo: Duration) -> Result<Value, RpcError> {
        let resultado = self.rpc.request("initialize", json!({
            "protocolVersion":1,
            "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}
        }), plazo)?;
        if resultado["protocolVersion"] != 1 {
            return Err(error_local("Versión ACP incompatible"));
        }
        self.estado.lock().map_err(error_bloqueo)?.imagenes = resultado
            .pointer("/agentCapabilities/promptCapabilities/image")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(resultado)
    }

    pub fn nueva_sesion(&self, cwd: &str, plazo: Duration) -> Result<Value, RpcError> {
        let resultado =
            self.rpc
                .request("session/new", json!({"cwd":cwd,"mcpServers":[]}), plazo)?;
        let resultado = acp_normalizar::configuracion_compatible(resultado);
        let id = resultado["sessionId"]
            .as_str()
            .ok_or_else(|| error_local("Respuesta ACP sin sessionId"))?;
        self.registrar_sesion(id, &resultado)?;
        Ok(resultado)
    }

    pub fn cargar_sesion(&self, id: &str, cwd: &str, plazo: Duration) -> Result<Value, RpcError> {
        let resultado = self.rpc.request(
            "session/load",
            json!({"sessionId":id,"cwd":cwd,"mcpServers":[]}),
            plazo,
        )?;
        let resultado = acp_normalizar::configuracion_compatible(resultado);
        self.registrar_sesion(id, &resultado)?;
        Ok(resultado)
    }

    fn registrar_sesion(&self, id: &str, resultado: &Value) -> Result<(), RpcError> {
        {
            let mut estado = self.estado.lock().map_err(error_bloqueo)?;
            estado.sesion = Some(id.into());
            estado.opciones = resultado["configOptions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|o| o["id"].as_str().map(str::to_string))
                .collect();
        }
        for evento in acp_normalizar::configuracion(resultado) {
            (self.emitir)(evento);
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn prompt(
        &self,
        texto: &str,
        imagenes: &[ImagenAcp],
        plazo: Duration,
    ) -> Result<Value, RpcError> {
        self.prompt_con_acuse(texto, imagenes, plazo, || {})
    }

    pub(super) fn prompt_con_acuse(
        &self,
        texto: &str,
        imagenes: &[ImagenAcp],
        plazo: Duration,
        aceptar: impl FnOnce(),
    ) -> Result<Value, RpcError> {
        let id = self.id_sesion()?;
        if !imagenes.is_empty() && !self.estado.lock().map_err(error_bloqueo)?.imagenes {
            return Err(error_local("El agente ACP no admite imágenes"));
        }
        let mut contenido = vec![json!({"type":"text","text":texto})];
        contenido.extend(
            imagenes
                .iter()
                .map(|i| json!({"type":"image","mimeType":i.tipo_mime,"data":i.datos})),
        );
        match self.rpc.request_con_acuse(
            "session/prompt",
            json!({"sessionId":id,"prompt":contenido}),
            plazo,
            aceptar,
        ) {
            Ok(resultado) => {
                (self.emitir)(acp_normalizar::fin_turno(&resultado));
                Ok(resultado)
            }
            Err(error) => {
                (self.emitir)(EventoMotor::Error(error.to_string()));
                Err(error)
            }
        }
    }

    pub fn cancelar(&self) -> Result<(), RpcError> {
        self.rpc
            .notify("session/cancel", json!({"sessionId":self.id_sesion()?}))
    }

    pub fn establecer_modo(&self, modo: &str, plazo: Duration) -> Result<Value, RpcError> {
        if self
            .estado
            .lock()
            .map_err(error_bloqueo)?
            .opciones
            .iter()
            .any(|id| id == "mode")
        {
            return self.establecer_opcion("mode", modo, plazo);
        }
        self.rpc.request(
            "session/set_mode",
            json!({"sessionId":self.id_sesion()?,"modeId":modo}),
            plazo,
        )
    }

    pub fn establecer_modelo(&self, modelo: &str, plazo: Duration) -> Result<Value, RpcError> {
        if self
            .estado
            .lock()
            .map_err(error_bloqueo)?
            .opciones
            .iter()
            .any(|id| id == "model")
        {
            return self.establecer_opcion("model", modelo, plazo);
        }
        self.rpc.request(
            "session/set_model",
            json!({"sessionId":self.id_sesion()?,"modelId":modelo}),
            plazo,
        )
    }

    fn establecer_opcion(&self, id: &str, valor: &str, plazo: Duration) -> Result<Value, RpcError> {
        let r = self.rpc.request(
            "session/set_config_option",
            json!({"sessionId":self.id_sesion()?,"configId":id,"value":valor}),
            plazo,
        )?;
        for evento in
            acp_normalizar::configuracion(&acp_normalizar::configuracion_compatible(r.clone()))
        {
            (self.emitir)(evento);
        }
        Ok(r)
    }

    fn id_sesion(&self) -> Result<String, RpcError> {
        self.estado
            .lock()
            .map_err(error_bloqueo)?
            .sesion
            .clone()
            .ok_or_else(|| error_local("No hay una sesión ACP abierta"))
    }

    /// `id_peticion` es opaco; `None` cancela, `Some` elige un `optionId` real.
    pub fn responder_permiso(
        &self,
        id_peticion: &str,
        opcion: Option<&str>,
    ) -> Result<(), RpcError> {
        let pendiente = {
            let mut permisos = self.permisos.lock().map_err(error_bloqueo)?;
            let pendiente = permisos
                .get(id_peticion)
                .ok_or_else(|| error_local("Permiso desconocido o ya respondido"))?;
            if opcion.is_some_and(|id| !pendiente.opciones.iter().any(|o| o == id)) {
                return Err(error_local("Opción de permiso desconocida"));
            }
            permisos
                .remove(id_peticion)
                .ok_or_else(|| error_local("Permiso retirado"))?
        };
        let resultado = match opcion {
            Some(id) => json!({"outcome":{"outcome":"selected","optionId":id}}),
            None => json!({"outcome":{"outcome":"cancelled"}}),
        };
        pendiente.respondedor.responder(Ok(resultado))
    }
}

impl Drop for ClienteAcp {
    fn drop(&mut self) {
        // El lector posee otra referencia al mapa: vaciarlo libera respondedores.
        if let Ok(mut permisos) = self.permisos.lock() {
            permisos.clear();
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
    if metodo != "session/request_permission" {
        let _ = respondedor.responder(Err(RpcError::Remoto {
            codigo: -32601,
            mensaje: format!("Método ACP no soportado: {metodo}"),
        }));
        return;
    }
    // La representación JSON distingue, por ejemplo, el id numérico 1 de "1".
    let id = respondedor.id().to_string();
    let evento = acp_normalizar::permiso(&id, parametros);
    let opciones = parametros["options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|o| o["optionId"].as_str().map(str::to_string))
        .collect();
    match permisos.lock() {
        Ok(mut pendientes) => {
            pendientes.insert(
                id,
                PermisoPendiente {
                    respondedor,
                    opciones,
                },
            );
        }
        Err(_) => {
            let _ = respondedor.responder(Err(error_local("Mapa de permisos envenenado")));
            return;
        }
    }
    emitir(evento);
}

fn error_local(mensaje: &str) -> RpcError {
    RpcError::Transporte(mensaje.into())
}
fn error_bloqueo<T>(_: std::sync::PoisonError<T>) -> RpcError {
    error_local("Estado ACP envenenado")
}

#[cfg(test)]
#[path = "tests_acp.rs"]
mod tests;
