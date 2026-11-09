// Servidor HTTP mínimo para los tests del router: atiende N peticiones en
// 127.0.0.1 con respuestas fijas y devuelve el texto de cada petición
// recibida (línea de petición + cabeceras + cuerpo) para comprobar qué ruta y
// qué cabeceras mandó el cliente. Solo se compila en tests.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;

/// Arranca el servidor; devuelve `http://127.0.0.1:<puerto>` y el canal con
/// las peticiones en orden de llegada.
pub(crate) fn serve(responses: Vec<(u16, String)>) -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for (status, body) in responses {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let request = read_request(&mut stream);
            let _ = tx.send(request);
            let reply = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    (base, rx)
}

fn read_request(stream: &mut std::net::TcpStream) -> String {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    while let Ok(n) = stream.read(&mut chunk) {
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        let text = String::from_utf8_lossy(&buf).to_string();
        let Some(head_end) = text.find("\r\n\r\n") else {
            continue;
        };
        let content_length = text[..head_end]
            .lines()
            .filter_map(|l| l.split_once(':'))
            .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.trim().parse::<usize>().ok())
            .unwrap_or(0);
        if buf.len() >= head_end + 4 + content_length {
            break;
        }
    }
    String::from_utf8_lossy(&buf).to_string()
}
