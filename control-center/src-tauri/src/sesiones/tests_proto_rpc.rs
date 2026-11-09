use super::*;
use serde_json::json;
use std::io::{self, BufReader, Read};

const PLAZO: Duration = Duration::from_secs(2);

struct LectorMemoria(mpsc::Receiver<Vec<u8>>, std::io::Cursor<Vec<u8>>);
impl Read for LectorMemoria {
    fn read(&mut self, salida: &mut [u8]) -> io::Result<usize> {
        if self.1.position() >= self.1.get_ref().len() as u64 {
            match self.0.recv() {
                Ok(datos) => self.1 = io::Cursor::new(datos),
                Err(_) => return Ok(0),
            }
        }
        self.1.read(salida)
    }
}
struct EscritorMemoria(mpsc::Sender<Vec<u8>>);
impl Write for EscritorMemoria {
    fn write(&mut self, datos: &[u8]) -> io::Result<usize> {
        self.0
            .send(datos.to_vec())
            .map_err(|_| io::ErrorKind::BrokenPipe)?;
        Ok(datos.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn conexion(
    manejador: impl Fn(String, Value, Respondedor) + Send + Sync + 'static,
) -> (ClienteRpc, mpsc::Sender<Vec<u8>>, mpsc::Receiver<Vec<u8>>) {
    let (entrada, lector) = mpsc::channel();
    let (escritor, salida) = mpsc::channel();
    let cliente = ClienteRpc::nuevo(
        BufReader::new(LectorMemoria(lector, io::Cursor::new(Vec::new()))),
        EscritorMemoria(escritor),
        manejador,
        |_, _| {},
    );
    (cliente, entrada, salida)
}
fn recibir(salida: &mpsc::Receiver<Vec<u8>>) -> Value {
    serde_json::from_slice(&salida.recv_timeout(PLAZO).unwrap()).unwrap()
}
fn enviar(entrada: &mpsc::Sender<Vec<u8>>, valor: Value) {
    entrada.send(format!("{valor}\n").into_bytes()).unwrap();
}
fn pedir(cliente: &ClienteRpc, metodo: &str) -> thread::JoinHandle<Result<Value, RpcError>> {
    let cliente = cliente.clone();
    let metodo = metodo.to_string();
    thread::spawn(move || cliente.request(&metodo, json!({}), PLAZO))
}

#[test]
fn correlaciona_respuestas_desordenadas() {
    let (cliente, entrada, salida) = conexion(|_, _, _| {});
    let primero = pedir(&cliente, "primero");
    let solicitud_primera = recibir(&salida);
    let segundo = pedir(&cliente, "segundo");
    let solicitud_segunda = recibir(&salida);
    enviar(
        &entrada,
        json!({"jsonrpc":"2.0", "id":solicitud_segunda["id"],"result":2}),
    );
    enviar(
        &entrada,
        json!({"jsonrpc":"2.0", "id":solicitud_primera["id"],"result":1}),
    );
    assert_eq!(primero.join().unwrap(), Ok(json!(1)));
    assert_eq!(segundo.join().unwrap(), Ok(json!(2)));
}
#[test]
fn conserva_codigo_y_mensaje_del_error_remoto() {
    let (cliente, entrada, salida) = conexion(|_, _, _| {});
    let pendiente = pedir(&cliente, "fallar");
    let solicitud = recibir(&salida);
    enviar(
        &entrada,
        json!({"id":solicitud["id"],"error":{"code":-32601,"message":"Desconocido"}}),
    );
    assert_eq!(
        pendiente.join().unwrap(),
        Err(RpcError::Remoto {
            codigo: -32601,
            mensaje: "Desconocido".into()
        })
    );
}
#[test]
fn vence_el_plazo_y_descarta_respuesta_tardia() {
    let (cliente, entrada, salida) = conexion(|_, _, _| {});
    assert_eq!(
        cliente.request("lento", json!({}), Duration::from_millis(10)),
        Err(RpcError::TiempoAgotado)
    );
    let vencida = recibir(&salida);
    enviar(&entrada, json!({"id":vencida["id"],"result":"tarde"}));
    let pendiente = pedir(&cliente, "siguiente");
    let solicitud = recibir(&salida);
    enviar(&entrada, json!({"id":solicitud["id"],"result":"actual"}));
    assert_eq!(pendiente.join().unwrap(), Ok(json!("actual")));
}
#[test]
fn ignora_basura_y_respuestas_desconocidas() {
    let (cliente, entrada, salida) = conexion(|_, _, _| {});
    entrada.send(b"aviso del proceso\n\xff\n".to_vec()).unwrap();
    enviar(&entrada, json!({"id":99999,"result":"ajeno"}));
    let pendiente = pedir(&cliente, "valido");
    let solicitud = recibir(&salida);
    enviar(&entrada, json!({"id":solicitud["id"],"result":true}));
    assert_eq!(pendiente.join().unwrap(), Ok(json!(true)));
}
#[test]
fn responde_peticion_desde_otro_hilo() {
    let (guardar, recuperar) = mpsc::channel();
    let (cliente, entrada, salida) = conexion(move |_, _, respondedor| {
        guardar.send(respondedor).unwrap();
    });
    enviar(
        &entrada,
        json!({"id":"permiso", "method":"permiso", "params":{}}),
    );
    let respondedor = recuperar.recv_timeout(PLAZO).unwrap();
    cliente.notify("continua", json!({})).unwrap();
    assert_eq!(recibir(&salida)["method"], "continua");
    thread::spawn(move || respondedor.responder(Ok(json!("permitido"))).unwrap())
        .join()
        .unwrap();
    assert_eq!(
        recibir(&salida),
        json!({"jsonrpc":"2.0","id":"permiso","result":"permitido"})
    );
}
#[test]
fn respondedor_descartado_envia_error() {
    let (_cliente, entrada, salida) = conexion(|_, _, _| {});
    enviar(&entrada, json!({"id":7,"method":"sin_respuesta"}));
    let respuesta = recibir(&salida);
    assert_eq!(respuesta["id"], 7);
    assert_eq!(respuesta["error"]["code"], -32603);
    assert!(salida.recv_timeout(Duration::from_millis(10)).is_err());
}
#[test]
fn cierre_del_lector_termina_todas_las_peticiones() {
    let (cliente, entrada, salida) = conexion(|_, _, _| {});
    let primero = pedir(&cliente, "uno");
    recibir(&salida);
    let segundo = pedir(&cliente, "dos");
    recibir(&salida);
    drop(entrada);
    assert_eq!(primero.join().unwrap(), Err(RpcError::Cerrado));
    assert_eq!(segundo.join().unwrap(), Err(RpcError::Cerrado));
    assert_eq!(
        cliente.request("tres", Value::Null, PLAZO),
        Err(RpcError::Cerrado)
    );
}
#[test]
fn entrega_notificaciones_sin_responder() {
    let (entrada, lector) = mpsc::channel();
    let (escritor, salida) = mpsc::channel();
    let (notificar, notificaciones) = mpsc::channel();
    let _cliente = ClienteRpc::nuevo(
        BufReader::new(LectorMemoria(lector, io::Cursor::new(Vec::new()))),
        EscritorMemoria(escritor),
        |_, _, _| {},
        move |metodo, parametros| notificar.send((metodo, parametros)).unwrap(),
    );
    enviar(
        &entrada,
        json!({"method":"actualizar","params":{"texto":"hola"}}),
    );
    assert_eq!(
        notificaciones.recv_timeout(PLAZO).unwrap(),
        ("actualizar".into(), json!({"texto":"hola"}))
    );
    assert!(salida.recv_timeout(Duration::from_millis(10)).is_err());
}

#[test]
fn panico_del_manejador_responde_error_y_conserva_el_lector() {
    let (cliente, entrada, salida) = conexion(|_, _, _| panic!("Fallo del manejador"));
    enviar(&entrada, json!({"id":"fallo","method":"provocar_fallo"}));
    let error = recibir(&salida);
    assert_eq!(error["id"], "fallo");
    assert_eq!(error["error"]["code"], -32603);
    let pendiente = pedir(&cliente, "sigue_vivo");
    let solicitud = recibir(&salida);
    enviar(&entrada, json!({"id":solicitud["id"],"result":true}));
    assert_eq!(pendiente.join().unwrap(), Ok(json!(true)));
}
