// mar.ia — arrancar con Windows, y saber POR QUE no arranca cuando no lo hace.
//
// El usuario lo reporto el 2026-09-21: "la aplicacion deberia iniciarse en el
// arranque del pc y no lo hace, debes poner una opcion en ajustes para ello, y
// que si esta activada lo cumpla".
//
// Habia un interruptor (el plugin de Tauri) y la entrada estaba puesta, asi que
// "activar" no era el problema. El problema es que un arranque que falla no
// dice nada: la entrada puede estar escrita y aun asi Windows no ejecutarla, o
// apuntar a un binario que ya no existe. Este modulo mira las TRES cosas que
// pueden fallar y las cuenta:
//
//   1. ¿Hay entrada en HKCU\...\Run?
//   2. ¿Apunta a ESTE ejecutable? (tras mover o reconstruir el repo, no)
//   3. ¿La ha desactivado Windows? El Administrador de tareas guarda esa
//      decision aparte, en `...\Explorer\StartupApproved\Run`, y con la entrada
//      intacta. Es el caso silencioso: parece configurado y no arranca.
//
// Solo toca HKCU (el usuario actual). No pide administrador ni escribe en
// HKLM.

use serde::Serialize;

/// Nombre del valor dentro de la clave Run. El mismo que usa el plugin de
/// Tauri y el que deja `scripts/instalar-lanzador.ps1`: si fueran distintos,
/// habria dos entradas y dos copias de mar.ia al iniciar sesion.
const VALOR: &str = "mar.ia";
const CLAVE_RUN: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const CLAVE_APROBADO: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
/// Marca que Windows pone al arrancar desde la entrada, para distinguirlo de
/// una apertura a mano.
const BANDERA: &str = "--from-autostart";

#[derive(Debug, Clone, Serialize)]
pub struct EstadoArranque {
    /// Hay una entrada de arranque para mar.ia.
    pub registrado: bool,
    /// Lo que hay escrito en el registro (ruta + argumentos).
    pub comando: String,
    /// La entrada apunta al ejecutable que se esta ejecutando ahora.
    pub apunta_aqui: bool,
    /// Windows la tiene desactivada desde el Administrador de tareas.
    pub bloqueado_por_windows: bool,
    /// Que pasa ahora, en una frase. Vacio = todo en orden.
    pub problema: String,
}

fn exe_actual() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Comando que deberia estar escrito en el registro.
#[must_use]
pub fn comando_esperado() -> String {
    format!("\"{}\" {BANDERA}", exe_actual())
}

#[cfg(windows)]
fn leer_valor(clave: &str, nombre: &str) -> Option<String> {
    let salida = crate::proc::oculto("reg.exe")
        .args(["query", clave, "/v", nombre])
        .output()
        .ok()?;
    if !salida.status.success() {
        return None;
    }
    let texto = String::from_utf8_lossy(&salida.stdout).to_string();
    // Formato: "    mar.ia    REG_SZ    C:\...\control-center.exe --from-autostart"
    texto
        .lines()
        .find(|l| l.trim_start().starts_with(nombre))
        .and_then(|l| {
            l.split_once("REG_SZ")
                .or_else(|| l.split_once("REG_BINARY"))
        })
        .map(|(_, v)| v.trim().to_string())
}

#[cfg(not(windows))]
fn leer_valor(_clave: &str, _nombre: &str) -> Option<String> {
    None
}

/// ¿Windows ha desactivado la entrada desde el Administrador de tareas?
///
/// El valor es binario; el PRIMER byte manda: 2 o 6 = habilitada, 3 = el
/// usuario la desactivo. Que no exista el valor significa que nadie la ha
/// tocado, o sea habilitada.
#[must_use]
pub fn bloqueada(primer_byte: Option<u8>) -> bool {
    matches!(primer_byte, Some(b) if b != 2 && b != 6)
}

#[cfg(windows)]
fn primer_byte_aprobado() -> Option<u8> {
    let hex = leer_valor(CLAVE_APROBADO, VALOR)?;
    // `reg query` devuelve el binario como una cadena hexadecimal continua.
    let limpio: String = hex.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    u8::from_str_radix(limpio.get(0..2)?, 16).ok()
}

#[cfg(not(windows))]
fn primer_byte_aprobado() -> Option<u8> {
    None
}

/// Decide la frase de diagnostico. Pura: se testea sin registro.
#[must_use]
pub fn problema_de(registrado: bool, apunta_aqui: bool, bloqueado: bool) -> String {
    if !registrado {
        return "No está configurado para arrancar con Windows.".into();
    }
    if bloqueado {
        return "Windows lo tiene desactivado. Administrador de tareas → Aplicaciones de \
                inicio → mar.ia → Habilitar. Mientras esté así, la entrada existe pero no \
                se ejecuta."
            .into();
    }
    if !apunta_aqui {
        return "La entrada de arranque apunta a OTRA copia de mar.ia. Vuelve a activarla \
                aquí para que apunte a esta."
            .into();
    }
    String::new()
}

#[must_use]
pub fn estado() -> EstadoArranque {
    let comando = leer_valor(CLAVE_RUN, VALOR).unwrap_or_default();
    let registrado = !comando.trim().is_empty();
    let exe = exe_actual();
    // Se compara sin comillas ni mayusculas: Windows no distingue y el valor
    // puede estar escrito con o sin ellas.
    let norm = |s: &str| s.replace('"', "").to_lowercase();
    let apunta_aqui = registrado && !exe.is_empty() && norm(&comando).contains(&norm(&exe));
    let bloqueado_por_windows = bloqueada(primer_byte_aprobado());
    EstadoArranque {
        registrado,
        comando,
        apunta_aqui,
        bloqueado_por_windows,
        problema: problema_de(registrado, apunta_aqui, bloqueado_por_windows),
    }
}

/// Enciende o apaga el arranque con Windows, y COMPRUEBA que quedo hecho.
///
/// Devuelve el estado leido despues de escribir: un interruptor que dice "ya
/// esta" sin volver a mirar es exactamente lo que dejo al usuario pensando que
/// lo tenia activado (mandamiento 11).
#[cfg(windows)]
pub fn fijar(activar: bool) -> Result<EstadoArranque, String> {
    if activar {
        let valor = comando_esperado();
        let ok = crate::proc::oculto("reg.exe")
            .args([
                "add", CLAVE_RUN, "/v", VALOR, "/t", "REG_SZ", "/d", &valor, "/f",
            ])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            return Err("no pude escribir la entrada de arranque".into());
        }
        // Y se quita la marca de "desactivado por el usuario": si estaba
        // puesta, activar sin borrarla no serviria de nada.
        let _ = crate::proc::oculto("reg.exe")
            .args(["delete", CLAVE_APROBADO, "/v", VALOR, "/f"])
            .output();
    } else {
        let _ = crate::proc::oculto("reg.exe")
            .args(["delete", CLAVE_RUN, "/v", VALOR, "/f"])
            .output();
    }
    Ok(estado())
}

#[cfg(not(windows))]
pub fn fijar(_activar: bool) -> Result<EstadoArranque, String> {
    Err("el arranque automatico solo esta implementado en Windows".into())
}

#[tauri::command]
pub async fn maria_arranque_estado() -> Result<EstadoArranque, String> {
    tauri::async_runtime::spawn_blocking(estado)
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))
}

#[tauri::command]
pub async fn maria_arranque_set(activar: bool) -> Result<EstadoArranque, String> {
    tauri::async_runtime::spawn_blocking(move || fijar(activar))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solo_2_y_6_significan_habilitado() {
        // Los valores que usa Windows. Un 3 es "el usuario la desactivo desde
        // el Administrador de tareas", que es el caso silencioso: la entrada
        // sigue escrita y aun asi no arranca.
        assert!(!bloqueada(Some(2)));
        assert!(!bloqueada(Some(6)));
        assert!(bloqueada(Some(3)));
        assert!(bloqueada(Some(1)));
    }

    #[test]
    fn sin_marca_no_esta_bloqueada() {
        // Caso negativo: que no exista el valor significa que nadie la ha
        // tocado. Tratarlo como bloqueo haria que la pantalla avisara de un
        // problema inexistente en una instalacion recien hecha.
        assert!(!bloqueada(None));
    }

    #[test]
    fn cada_fallo_tiene_su_frase_y_en_orden() {
        assert!(problema_de(false, false, false).contains("No está configurado"));
        // El bloqueo de Windows manda sobre el resto: mientras este puesto, da
        // igual a donde apunte la entrada.
        assert!(problema_de(true, true, true).contains("Administrador de tareas"));
        assert!(problema_de(true, false, false).contains("OTRA copia"));
    }

    #[test]
    fn con_todo_bien_no_se_inventa_un_problema() {
        assert_eq!(problema_de(true, true, false), "");
    }

    #[test]
    fn el_comando_lleva_la_bandera_de_arranque() {
        // Sin ella, la instancia unica no sabe distinguir un arranque
        // automatico de una apertura a mano y enfoca la ventana sin que nadie
        // se lo haya pedido.
        assert!(comando_esperado().contains(BANDERA));
        assert!(
            comando_esperado().starts_with('"'),
            "la ruta va entrecomillada"
        );
    }
}
