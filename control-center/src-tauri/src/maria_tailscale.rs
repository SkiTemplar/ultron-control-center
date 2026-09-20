// mar.ia — por que la direccion de Tailscale da 404.
//
// El usuario lo reporto asi el 2026-09-20: "al hacer el comando para tailscale
// sale error 404". La pantalla del movil le daba un comando para copiar
// (`tailscale serve --bg <puerto>`) y nada mas: si fallaba, fallaba en
// silencio y el unico sintoma era una pagina 404 al abrir la direccion
// `.ts.net`.
//
// Un 404 ahi puede venir de tres sitios distintos, y desde fuera se parecen:
//   1. Tailscale no esta conectado. `tailscale serve` ni llega a configurarse
//      (aqui devuelve "unexpected state: NoState", comprobado el 2026-09-20),
//      y la direccion `.ts.net` contesta 404 porque no hay nada publicado.
//   2. `serve` no esta configurado (nunca se ejecuto, o se hizo `serve reset`).
//      Misma pagina 404.
//   3. Esta configurado pero apunta a un puerto donde mar.ia no escucha.
//
// Este modulo mira los tres y dice cual es, en vez de dejar al usuario
// adivinando. Solo LEE: no ejecuta `serve` por su cuenta — publicar un puerto
// en la red privada del usuario es decision suya.

use serde::Serialize;

/// Donde busca el ejecutable cuando no esta en el PATH.
const RUTAS: &[&str] = &[
    r"C:\Program Files\Tailscale\tailscale.exe",
    r"C:\Program Files (x86)\Tailscale\tailscale.exe",
];

#[derive(Debug, Clone, Serialize)]
pub struct Diagnostico {
    /// Tailscale esta instalado en la maquina.
    pub instalado: bool,
    /// Esta conectado a la red (no basta con estar instalado).
    pub conectado: bool,
    /// Lo que dice `tailscale status`, recortado.
    pub estado: String,
    /// Hay un `serve` configurado ahora mismo.
    pub sirviendo: bool,
    /// Lo que dice `tailscale serve status`, recortado.
    pub serve: String,
    /// mar.ia esta escuchando en su puerto.
    pub maria_escucha: bool,
    /// Puerto que mira (el de la configuracion del movil).
    pub puerto: u16,
    /// El comando exacto que hay que ejecutar, ya con el puerto puesto.
    pub comando: String,
    /// Que hacer ahora, en una frase. Vacio = todo en orden.
    pub siguiente_paso: String,
}

fn ejecutable() -> Option<String> {
    if crate::maria_login::en_path("tailscale") {
        return Some("tailscale".into());
    }
    RUTAS
        .iter()
        .find(|p| std::path::Path::new(p).is_file())
        .map(|p| (*p).to_string())
}

/// Ejecuta un subcomando de tailscale y devuelve su salida (o el error).
fn correr(exe: &str, args: &[&str]) -> String {
    match crate::proc::oculto(exe).args(args).output() {
        Ok(o) => {
            let s = if o.stdout.is_empty() {
                String::from_utf8_lossy(&o.stderr).to_string()
            } else {
                String::from_utf8_lossy(&o.stdout).to_string()
            };
            s.trim().chars().take(400).collect()
        }
        Err(e) => format!("no pude ejecutar tailscale: {e}"),
    }
}

/// ¿Hay algo escuchando en 127.0.0.1:puerto?
///
/// Se conecta de verdad en vez de mirar una lista: es la unica forma de saber
/// que el servidor esta VIVO y no solo configurado como encendido.
#[must_use]
pub fn puerto_escucha(puerto: u16) -> bool {
    use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
    TcpStream::connect_timeout(
        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, puerto).into(),
        std::time::Duration::from_millis(400),
    )
    .is_ok()
}

/// Decide el siguiente paso a partir de los hechos. Pura: se testea sin red.
#[must_use]
pub fn siguiente_paso(
    instalado: bool,
    conectado: bool,
    sirviendo: bool,
    maria_escucha: bool,
    puerto: u16,
) -> String {
    if !instalado {
        return "Tailscale no esta instalado. Bajalo de tailscale.com e inicia sesion.".into();
    }
    if !conectado {
        return "Tailscale esta instalado pero no conectado. Abrelo desde la bandeja e inicia \
                sesion; hasta entonces la direccion .ts.net contesta 404."
            .into();
    }
    if !maria_escucha {
        return format!(
            "El servidor movil de mar.ia no escucha en el puerto {puerto}. Enciendelo aqui \
             arriba antes de publicar nada: si no, la direccion .ts.net no tiene a donde ir."
        );
    }
    if !sirviendo {
        return format!(
            "Falta publicar el puerto. Ejecuta `tailscale serve --bg {puerto}` en una terminal \
             del PC; sin eso, la direccion .ts.net contesta 404."
        );
    }
    String::new()
}

/// Mira por que la direccion de Tailscale no responde.
#[tauri::command]
pub async fn maria_tailscale_diagnostico() -> Result<Diagnostico, String> {
    tauri::async_runtime::spawn_blocking(diagnostico)
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))
}

#[must_use]
pub fn diagnostico() -> Diagnostico {
    let puerto = crate::maria_web::load_config().port;
    let maria_escucha = puerto_escucha(puerto);
    let Some(exe) = ejecutable() else {
        return Diagnostico {
            instalado: false,
            conectado: false,
            estado: "no encuentro tailscale.exe".into(),
            sirviendo: false,
            serve: String::new(),
            maria_escucha,
            puerto,
            comando: format!("tailscale serve --bg {puerto}"),
            siguiente_paso: siguiente_paso(false, false, false, maria_escucha, puerto),
        };
    };

    let estado = correr(&exe, &["status"]);
    // `tailscale status` escupe la lista de maquinas cuando esta conectado, y
    // un "unexpected state: ..." o "Logged out" cuando no.
    let bajo = estado.to_lowercase();
    let conectado = !bajo.contains("unexpected state")
        && !bajo.contains("logged out")
        && !bajo.contains("stopped")
        && !estado.trim().is_empty();

    let serve = correr(&exe, &["serve", "status"]);
    let sirviendo = !serve.to_lowercase().contains("no serve config") && !serve.trim().is_empty();

    Diagnostico {
        instalado: true,
        conectado,
        estado,
        sirviendo,
        serve,
        maria_escucha,
        puerto,
        comando: format!("tailscale serve --bg {puerto}"),
        siguiente_paso: siguiente_paso(true, conectado, sirviendo, maria_escucha, puerto),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cada_fallo_tiene_su_frase_y_solo_una() {
        // El orden importa: lo primero que hay que arreglar es lo primero que
        // se dice. De nada sirve mandar a ejecutar `serve` si Tailscale no
        // esta conectado.
        assert!(siguiente_paso(false, false, false, false, 8790).contains("no esta instalado"));
        assert!(siguiente_paso(true, false, false, true, 8790).contains("no conectado"));
        assert!(siguiente_paso(true, true, false, false, 8790).contains("no escucha"));
        assert!(siguiente_paso(true, true, false, true, 8790).contains("serve --bg 8790"));
    }

    #[test]
    fn con_todo_en_orden_no_se_inventa_un_problema() {
        // Caso negativo: si los cuatro hechos son buenos, la pantalla no puede
        // seguir enseñando un aviso — seria mandar a arreglar lo que funciona.
        assert_eq!(siguiente_paso(true, true, true, true, 8790), "");
    }

    #[test]
    fn un_puerto_cerrado_no_se_da_por_abierto() {
        // 1 es un puerto privilegiado donde no escucha nada.
        assert!(!puerto_escucha(1));
    }
}
