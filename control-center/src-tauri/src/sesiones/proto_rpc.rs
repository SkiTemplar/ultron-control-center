// Cliente JSON-RPC 2.0 sobre flujos NDJSON independientes del proceso.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;
use std::io::{BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

type Resultado = Result<Value, RpcError>;
type Escritor = Arc<Mutex<Box<dyn Write + Send>>>;
type Manejador = dyn Fn(String, Value, Respondedor) + Send + Sync;
type Notificador = dyn Fn(String, Value) + Send + Sync;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RpcError {
    Remoto { codigo: i64, mensaje: String },
    Cerrado,
    TiempoAgotado,
    Transporte(String),
}
impl fmt::Display for RpcError {
    fn fmt(&self, salida: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Remoto { codigo, mensaje } => write!(salida, "RPC {codigo}: {mensaje}"),
            Self::Cerrado => write!(salida, "Canal RPC cerrado"),
            Self::TiempoAgotado => write!(salida, "Plazo RPC agotado"),
            Self::Transporte(mensaje) => write!(salida, "Transporte RPC: {mensaje}"),
        }
    }
}
impl std::error::Error for RpcError {}

#[derive(Default)]
struct Pendientes {
    cerrado: bool,
    respuestas: HashMap<u64, mpsc::Sender<Resultado>>,
}

/// La propiedad del respondedor permite contestar desde cualquier hilo una sola vez.
pub struct Respondedor {
    id: Value,
    escritor: Escritor,
    respondido: bool,
}
impl Respondedor {
    pub fn id(&self) -> &Value {
        &self.id
    }

    pub fn responder(mut self, resultado: Resultado) -> Result<(), RpcError> {
        self.respondido = true;
        self.enviar(resultado)
    }

    fn enviar(&self, resultado: Resultado) -> Result<(), RpcError> {
        let respuesta = match resultado {
            Ok(valor) => json!({"jsonrpc":"2.0", "id":self.id,"result":valor}),
            Err(error) => {
                let (codigo, mensaje) = match error {
                    RpcError::Remoto { codigo, mensaje } => (codigo, mensaje),
                    otro => (-32603, otro.to_string()),
                };
                json!({"jsonrpc":"2.0","id":self.id,"error":{"code":codigo,"message":mensaje}})
            }
        };
        escribir(&self.escritor, &respuesta)
    }
}
impl Drop for Respondedor {
    fn drop(&mut self) {
        if !self.respondido {
            let _ = self.enviar(Err(RpcError::Remoto {
                codigo: -32603,
                mensaje: "Petición descartada sin respuesta".into(),
            }));
        }
    }
}

#[derive(Clone)]
pub struct ClienteRpc {
    escritor: Escritor,
    pendientes: Arc<Mutex<Pendientes>>,
    siguiente: Arc<AtomicU64>,
}
impl ClienteRpc {
    pub fn nuevo(
        lector: impl BufRead + Send + 'static,
        escritor: impl Write + Send + 'static,
        peticiones: impl Fn(String, Value, Respondedor) + Send + Sync + 'static,
        notificaciones: impl Fn(String, Value) + Send + Sync + 'static,
    ) -> Self {
        let cliente = Self {
            escritor: Arc::new(Mutex::new(Box::new(escritor))),
            pendientes: Arc::new(Mutex::new(Pendientes::default())),
            siguiente: Arc::new(AtomicU64::new(0)),
        };
        let copia = cliente.clone();
        thread::spawn(move || copia.leer(lector, &peticiones, &notificaciones));
        cliente
    }

    pub fn request(&self, metodo: &str, parametros: Value, plazo: Duration) -> Resultado {
        self.request_con_acuse(metodo, parametros, plazo, || {})
    }

    /// El acuse local confirma que la petición ya salió por el transporte.
    pub(super) fn request_con_acuse(
        &self,
        metodo: &str,
        parametros: Value,
        plazo: Duration,
        aceptar: impl FnOnce(),
    ) -> Resultado {
        let id = self.siguiente.fetch_add(1, Ordering::Relaxed);
        let (enviar, recibir) = mpsc::channel();
        {
            let mut pendientes = self.pendientes.lock().map_err(error_bloqueo)?;
            if pendientes.cerrado {
                return Err(RpcError::Cerrado);
            }
            pendientes.respuestas.insert(id, enviar);
        }
        let solicitud = json!({"jsonrpc":"2.0","id":id,"method":metodo,"params":parametros});
        if let Err(error) = escribir(&self.escritor, &solicitud) {
            self.retirar(id);
            return Err(error);
        }
        aceptar();
        let resultado = recibir.recv_timeout(plazo).unwrap_or_else(|error| {
            Err(match error {
                mpsc::RecvTimeoutError::Timeout => RpcError::TiempoAgotado,
                mpsc::RecvTimeoutError::Disconnected => RpcError::Cerrado,
            })
        });
        self.retirar(id);
        resultado
    }

    pub fn notify(&self, metodo: &str, parametros: Value) -> Result<(), RpcError> {
        if self.pendientes.lock().map_err(error_bloqueo)?.cerrado {
            return Err(RpcError::Cerrado);
        }
        escribir(
            &self.escritor,
            &json!({"jsonrpc":"2.0","method":metodo,"params":parametros}),
        )
    }

    fn retirar(&self, id: u64) {
        if let Ok(mut pendientes) = self.pendientes.lock() {
            pendientes.respuestas.remove(&id);
        }
    }

    fn leer(&self, mut lector: impl BufRead, peticiones: &Manejador, avisos: &Notificador) {
        let mut linea = Vec::new();
        loop {
            linea.clear();
            match lector.read_until(b'\n', &mut linea) {
                Ok(0) => break,
                Ok(_) => self.interpretar(&linea, peticiones, avisos),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    tracing::debug!(%error, "Lectura RPC interrumpida");
                    break;
                }
            }
        }
        self.cerrar();
    }

    fn interpretar(&self, linea: &[u8], peticiones: &Manejador, avisos: &Notificador) {
        let Ok(valor) = serde_json::from_slice::<Value>(linea) else {
            tracing::debug!(linea = %String::from_utf8_lossy(linea), "Línea ajena a JSON-RPC ignorada");
            return;
        };
        if let Some(metodo) = valor.get("method").and_then(Value::as_str) {
            self.entregar(metodo, &valor, peticiones, avisos);
            return;
        }
        if let Some(id) = valor.get("id").and_then(Value::as_u64) {
            if let Ok(mut pendientes) = self.pendientes.lock() {
                if let Some(respuesta) = pendientes.respuestas.remove(&id) {
                    let _ = respuesta.send(resultado_de(&valor));
                }
            }
        }
    }

    fn entregar(&self, metodo: &str, valor: &Value, peticiones: &Manejador, avisos: &Notificador) {
        let parametros = valor.get("params").cloned().unwrap_or(Value::Null);
        let ejecucion = catch_unwind(AssertUnwindSafe(|| {
            if let Some(id) = valor.get("id") {
                let respondedor = Respondedor {
                    id: id.clone(),
                    escritor: self.escritor.clone(),
                    respondido: false,
                };
                peticiones(metodo.to_string(), parametros, respondedor);
            } else {
                avisos(metodo.to_string(), parametros);
            }
        }));
        if ejecucion.is_err() {
            tracing::debug!(metodo, "El manejador RPC interrumpió su ejecución");
        }
    }

    fn cerrar(&self) {
        if let Ok(mut pendientes) = self.pendientes.lock() {
            pendientes.cerrado = true;
            for (_, respuesta) in pendientes.respuestas.drain() {
                let _ = respuesta.send(Err(RpcError::Cerrado));
            }
        }
    }
}

fn error_bloqueo<T>(_: std::sync::PoisonError<T>) -> RpcError {
    RpcError::Transporte("Estado RPC bloqueado por un fallo previo".into())
}
fn escribir(escritor: &Escritor, valor: &Value) -> Result<(), RpcError> {
    let mut datos =
        serde_json::to_vec(valor).map_err(|error| RpcError::Transporte(error.to_string()))?;
    datos.push(b'\n');
    let mut escritor = escritor.lock().map_err(error_bloqueo)?;
    escritor
        .write_all(&datos)
        .and_then(|_| escritor.flush())
        .map_err(|error| RpcError::Transporte(error.to_string()))
}
fn resultado_de(valor: &Value) -> Resultado {
    if let Some(error) = valor.get("error") {
        return Err(RpcError::Remoto {
            codigo: error.get("code").and_then(Value::as_i64).unwrap_or(-32603),
            mensaje: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Error RPC sin mensaje")
                .into(),
        });
    }
    valor
        .get("result")
        .cloned()
        .ok_or_else(|| RpcError::Transporte("Respuesta RPC sin resultado".into()))
}

#[cfg(test)]
#[path = "tests_proto_rpc.rs"]
mod tests;

#[cfg(test)]
mod compatibilidad_codex {
    use super::*;

    #[test]
    fn metodo_con_id_cero_es_peticion_y_resultado_sin_jsonrpc_es_respuesta() {
        let (enviar, recibir) = mpsc::channel();
        let cliente = ClienteRpc {
            escritor: Arc::new(Mutex::new(Box::new(Vec::<u8>::new()))),
            pendientes: Arc::new(Mutex::new(Pendientes::default())),
            siguiente: Arc::new(AtomicU64::new(0)),
        };
        cliente
            .pendientes
            .lock()
            .unwrap()
            .respuestas
            .insert(0, enviar);
        let manejador = |_: String, _: Value, respondedor: Respondedor| {
            respondedor
                .responder(Ok(json!({"decision":"decline"})))
                .unwrap();
        };
        cliente.interpretar(
            br#"{"id":0,"method":"item/commandExecution/requestApproval","params":{}}"#,
            &manejador,
            &|_, _| {},
        );
        assert!(matches!(recibir.try_recv(), Err(mpsc::TryRecvError::Empty)));
        cliente.interpretar(
            br#"{"id":0,"result":{"correcto":true}}"#,
            &manejador,
            &|_, _| {},
        );
        assert_eq!(
            recibir.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ok(json!({"correcto":true}))
        );
    }
}
