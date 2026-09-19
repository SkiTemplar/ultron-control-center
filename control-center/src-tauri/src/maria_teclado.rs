// mar.ia — el autocompletado global: escribes `//maria <lo que sea>` y Enter.
//
// Lo pidio el usuario el 2026-09-19: "que detecte el comando //maria por
// teclado, y cuando reciba un enter, se active, analice todo, responda y se
// descargue de vuelta hasta el siguiente". Funciona en cualquier sitio donde
// se pueda escribir: el bloc de notas, un editor, un campo de texto del
// navegador.
//
// COMO FUNCIONA, porque es lo menos obvio del programa:
//   1. Un hook de teclado de Windows (WH_KEYBOARD_LL) mira lo que se teclea.
//      NO guarda nada: mantiene en memoria los ultimos caracteres y, en cuanto
//      la linea deja de empezar por el disparador, la tira.
//   2. Mientras no aparece `//maria`, el modelo NO se toca. Ni existe.
//   3. Al pulsar Enter con una orden escrita: se borra lo tecleado
//      (retrocesos), se carga el modelo, se responde, se escribe la respuesta
//      donde estaba el cursor y se DESCARGA. Punto.
//
// LO QUE NO HACE, y conviene que conste: no registra pulsaciones en disco, no
// manda nada a ningun sitio salvo al modelo local de este ordenador, y solo
// mira la linea en curso. Fuera del disparador, cada tecla se olvida.
//
// LIMITE DECLARADO: es Windows. En otros sistemas el modulo compila vacio y la
// funcion de arranque no hace nada.

use serde::{Deserialize, Serialize};

/// Lo que dispara la captura. Se escribe tal cual.
pub const DISPARADOR: &str = "//maria";

/// Tope de caracteres de una orden. Pasado eso se abandona la captura: una
/// linea larguisima casi nunca es una orden, y no tiene sentido crecer sin fin.
const MAX_ORDEN: usize = 400;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigTeclado {
    /// Apagado por defecto: un hook de teclado global se enciende a mano,
    /// nunca por sorpresa.
    pub enabled: bool,
    /// Lo que hay que escribir para despertarla.
    pub disparador: String,
}

impl Default for ConfigTeclado {
    fn default() -> Self {
        Self {
            enabled: false,
            disparador: DISPARADOR.to_string(),
        }
    }
}

fn ruta() -> Result<std::path::PathBuf, String> {
    Ok(crate::maria_paths::cockpit("maria")?.join("teclado.json"))
}

#[must_use]
pub fn cargar() -> ConfigTeclado {
    ruta()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn guardar(c: &ConfigTeclado) -> Result<(), String> {
    let p = ruta()?;
    let texto = serde_json::to_string_pretty(c).map_err(|e| format!("serializar: {e}"))?;
    std::fs::write(p, texto).map_err(|e| format!("guardar teclado.json: {e}"))
}

// ---------------------------------------------------------------------------
// La maquina de estados (pura, y por eso testeable sin tocar el teclado)
// ---------------------------------------------------------------------------

/// Que hacer despues de procesar una tecla.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Accion {
    /// Nada que hacer: seguir mirando.
    Nada,
    /// Hay una orden lista. Lleva el texto y cuantos caracteres hay que borrar
    /// de la pantalla (el disparador mas la orden).
    Ejecutar { orden: String, borrar: usize },
}

/// Lo tecleado desde el ultimo corte.
///
/// Solo guarda la linea EN CURSO y, en cuanto se ve que no puede llegar a ser
/// el disparador, la vacia. No es un registro de pulsaciones.
#[derive(Debug, Default)]
pub struct Buffer {
    linea: String,
}

impl Buffer {
    #[must_use]
    pub fn nuevo() -> Self {
        Self::default()
    }

    /// Lo que hay capturado ahora mismo. Solo lo usan las pruebas: es la
    /// unica forma de comprobar que al escribir texto normal el buffer se
    /// queda VACIO, que es la propiedad importante de este modulo.
    #[cfg(test)]
    #[must_use]
    pub fn linea(&self) -> &str {
        &self.linea
    }

    /// ¿Estamos dentro de una orden? Es lo que decide si el modelo hace falta.
    #[must_use]
    pub fn capturando(&self, disparador: &str) -> bool {
        self.linea.starts_with(disparador)
    }

    /// Procesa un caracter tecleado. `enter` marca la tecla Intro.
    pub fn tecla(&mut self, c: Option<char>, enter: bool, disparador: &str) -> Accion {
        if enter {
            if self.capturando(disparador) {
                let orden = self.linea[disparador.len()..].trim().to_string();
                let borrar = self.linea.chars().count();
                self.linea.clear();
                if !orden.is_empty() {
                    return Accion::Ejecutar { orden, borrar };
                }
            }
            self.linea.clear();
            return Accion::Nada;
        }

        match c {
            // Retroceso.
            Some('\u{8}') => {
                self.linea.pop();
            }
            // Escape: cancela la captura sin ejecutar nada.
            Some('\u{1b}') => self.linea.clear(),
            Some(ch) => self.linea.push(ch),
            None => return Accion::Nada,
        }

        // Poda: si lo escrito ya no puede llegar a ser el disparador, se tira.
        // Esto es lo que hace que NO sea un registrador de teclas: fuera del
        // disparador, el buffer esta casi siempre vacio.
        if !self.capturando(disparador) && !disparador.starts_with(&self.linea) {
            // Puede que el disparador empiece mas adelante en la linea
            // (escribiste texto y luego `//maria`): se conserva la cola que
            // todavia podria serlo.
            let mut cola = self.linea.as_str();
            while !cola.is_empty() && !disparador.starts_with(cola) {
                let mut cs = cola.chars();
                cs.next();
                cola = cs.as_str();
            }
            self.linea = cola.to_string();
        }
        if self.linea.chars().count() > MAX_ORDEN + disparador.chars().count() {
            self.linea.clear();
        }
        Accion::Nada
    }
}

// ---------------------------------------------------------------------------
// Ejecucion de la orden
// ---------------------------------------------------------------------------

/// Pregunta al modelo local y devuelve el texto a escribir.
///
/// `EnUso` es lo que garantiza lo que pidio el usuario: el modelo entra en VRAM
/// aqui y sale al terminar esta funcion, pase lo que pase.
fn responder(orden: &str) -> Result<String, String> {
    let _en_uso = crate::maria_local::EnUso::nuevo();
    let modelo = crate::ollama::toggle::model_name();
    let body = serde_json::json!({
        "model": modelo,
        "stream": false,
        "think": false,
        "keep_alive": "0",
        "messages": [
            {
                "role": "system",
                "content":
                    "Eres mar.ia. Te llega una orden escrita en mitad de un texto, en \
                     cualquier programa. Devuelve SOLO lo que hay que escribir en ese sitio: \
                     sin saludos, sin explicaciones, sin comillas y sin repetir la pregunta. \
                     Si te piden codigo, devuelve solo el codigo. Responde en español salvo \
                     que la orden este en otro idioma."
            },
            { "role": "user", "content": orden }
        ],
        "options": { "num_ctx": 4096, "num_predict": 500, "temperature": 0.3 },
    });
    let cliente = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("cliente http: {e}"))?;
    let v: serde_json::Value = cliente
        .post("http://127.0.0.1:11434/api/chat")
        .json(&body)
        .send()
        .map_err(|e| format!("el modelo local no responde: {e}"))?
        .json()
        .map_err(|e| format!("respuesta ilegible: {e}"))?;
    let texto = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if texto.is_empty() {
        return Err("el modelo local devolvio una respuesta vacia".into());
    }
    Ok(texto)
}

// ---------------------------------------------------------------------------
// Windows: el hook y la escritura
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win {
    use super::{cargar, responder, Accion, Buffer};
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, GetKeyState, GetKeyboardState, MapVirtualKeyW, SendInput, ToUnicode,
        INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC,
        VK_BACK, VK_CAPITAL, VK_CONTROL, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_MENU, VK_RCONTROL,
        VK_RETURN, VK_RMENU, VK_RSHIFT, VK_SHIFT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx, KBDLLHOOKSTRUCT,
        MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
    };

    static BUFFER: Mutex<Option<Buffer>> = Mutex::new(None);

    /// Traduce un codigo de tecla a su caracter, respetando el teclado actual.
    ///
    /// Hace falta `ToUnicode` y no una tabla: en un teclado español la barra
    /// esta en Shift+7 y en uno ingles en su propia tecla; `//maria` tiene que
    /// escribirse igual en los dos.
    ///
    /// OJO con el estado de las teclas: dentro de un hook de bajo nivel,
    /// `GetKeyboardState` va por detras — el sistema todavia no ha aplicado la
    /// pulsacion que estamos mirando. Con el teclado español eso hacia que la
    /// barra de `//maria` no se tradujera, el buffer contara un caracter menos
    /// que la pantalla y el borrado dejara una `/` suelta delante de la
    /// respuesta (medido en el Bloc de notas el 2026-09-19). Se rellena a mano
    /// con `GetAsyncKeyState`, que si dice el estado real AHORA.
    fn caracter(vk: u32, scan: u32) -> Option<char> {
        let mut estado = [0u8; 256];
        unsafe {
            // Se parte del estado del sistema y se corrigen los modificadores.
            GetKeyboardState(estado.as_mut_ptr());
            for m in [
                VK_SHIFT, VK_LSHIFT, VK_RSHIFT, VK_CONTROL, VK_LCONTROL, VK_RCONTROL, VK_MENU,
                VK_LMENU, VK_RMENU,
            ] {
                let pulsada = (GetAsyncKeyState(m as i32) as u16 & 0x8000) != 0;
                estado[m as usize] = if pulsada { 0x80 } else { 0 };
            }
            // Bloq Mayus es un interruptor, no una tecla pulsada: va en el bit
            // bajo.
            estado[VK_CAPITAL as usize] =
                u8::from((GetKeyState(VK_CAPITAL as i32) as u16 & 0x0001) != 0);
        }
        let mut buf = [0u16; 8];
        let n = unsafe {
            ToUnicode(
                vk,
                if scan == 0 { MapVirtualKeyW(vk, MAPVK_VK_TO_VSC) } else { scan },
                estado.as_ptr(),
                buf.as_mut_ptr(),
                buf.len() as i32,
                0,
            )
        };
        if n <= 0 {
            return None;
        }
        String::from_utf16_lossy(&buf[..n as usize]).chars().next()
    }

    /// Manda una pulsacion de una tecla virtual (para los retrocesos).
    fn pulsar(vk: u16, veces: usize) {
        for _ in 0..veces {
            let mut entradas = [INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: unsafe { std::mem::zeroed() },
            }; 2];
            unsafe {
                entradas[0].Anonymous.ki = KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: 0,
                    time: 0,
                    dwExtraInfo: 0,
                };
                entradas[1].Anonymous.ki = KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                };
                SendInput(2, entradas.as_ptr(), std::mem::size_of::<INPUT>() as i32);
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    /// Escribe texto donde este el cursor, caracter a caracter en Unicode.
    ///
    /// `KEYEVENTF_UNICODE` en vez de simular teclas: asi salen las tildes y la
    /// ñ sin depender de la distribucion del teclado.
    fn escribir(texto: &str) {
        for ch in texto.encode_utf16() {
            let mut entradas = [INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: unsafe { std::mem::zeroed() },
            }; 2];
            unsafe {
                entradas[0].Anonymous.ki = KEYBDINPUT {
                    wVk: 0,
                    wScan: ch,
                    dwFlags: KEYEVENTF_UNICODE,
                    time: 0,
                    dwExtraInfo: 0,
                };
                entradas[1].Anonymous.ki = KEYBDINPUT {
                    wVk: 0,
                    wScan: ch,
                    dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                };
                SendInput(2, entradas.as_ptr(), std::mem::size_of::<INPUT>() as i32);
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    unsafe extern "system" fn hook(codigo: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if codigo >= 0 && (w as u32 == WM_KEYDOWN || w as u32 == WM_SYSKEYDOWN) {
            let info = &*(l as *const KBDLLHOOKSTRUCT);
            let vk = info.vkCode;
            let enter = vk == VK_RETURN as u32;
            let c = if enter {
                None
            } else if vk == VK_BACK as u32 {
                Some('\u{8}')
            } else {
                caracter(vk, info.scanCode)
            };

            let cfg = cargar();
            let accion = {
                let mut guard = BUFFER.lock().unwrap_or_else(|e| e.into_inner());
                let buf = guard.get_or_insert_with(Buffer::nuevo);
                buf.tecla(c, enter, &cfg.disparador)
            };

            if let Accion::Ejecutar { orden, borrar } = accion {
                // En un hilo aparte: el hook de teclado del sistema NO puede
                // bloquearse. Si tarda, Windows lo desengancha y deja de
                // funcionar para todo el escritorio.
                std::thread::spawn(move || {
                    // Se borra EXACTAMENTE lo tecleado desde el disparador. El
                    // Enter no cuenta porque no ha llegado a la aplicacion: se
                    // traga mas abajo.
                    //
                    // Antes se borraba `borrar + 1` con el Enter ya entregado,
                    // asi que los retrocesos se comian el salto de linea y
                    // seguian mordiendo la linea ANTERIOR: en la primera
                    // prueba real (2026-09-19, Bloc de notas) se llevo por
                    // delante texto que el usuario ya tenia escrito. Borrar a
                    // ciegas por encima de la propia orden no es aceptable.
                    pulsar(VK_BACK, borrar);
                    match responder(&orden) {
                        Ok(texto) => escribir(&texto),
                        Err(e) => {
                            tracing::warn!(error = %e, "maria-teclado: sin respuesta");
                            escribir(&format!("[mar.ia no pudo responder: {e}]"));
                        }
                    }
                });
                // Se traga el Enter: no debe llegar al editor. Asi no hay
                // salto de linea que deshacer y el cursor se queda justo
                // detras de la orden, que es lo unico que se va a borrar.
                return 1;
            }
        }
        CallNextHookEx(std::ptr::null_mut(), codigo, w, l)
    }

    /// Engancha el hook y se queda bombeando mensajes. Bloqueante: va en su
    /// propio hilo, y ese hilo ES el que posee el hook (Windows lo exige).
    pub fn escuchar() {
        unsafe {
            let h = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), std::ptr::null_mut(), 0);
            if h.is_null() {
                tracing::error!("maria-teclado: no pude enganchar el hook de teclado");
                return;
            }
            tracing::info!("maria-teclado: escuchando el disparador");
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
            UnhookWindowsHookEx(h);
        }
    }
}

/// Arranca el vigilante del teclado si esta encendido en la configuracion.
pub fn arrancar_si_procede() {
    let cfg = cargar();
    if !cfg.enabled {
        tracing::info!("maria-teclado: apagado (se enciende en Ajustes)");
        return;
    }
    #[cfg(windows)]
    std::thread::spawn(win::escuchar);
    #[cfg(not(windows))]
    tracing::warn!("maria-teclado: solo disponible en Windows");
}

#[tauri::command]
pub async fn maria_teclado_get() -> Result<ConfigTeclado, String> {
    Ok(cargar())
}

/// Enciende o apaga el vigilante. Encenderlo arranca el hook al momento;
/// apagarlo requiere reiniciar mar.ia (el hook vive con su hilo).
#[tauri::command]
pub async fn maria_teclado_set(config: ConfigTeclado) -> Result<ConfigTeclado, String> {
    let antes = cargar();
    let disparador = config.disparador.trim().to_string();
    if disparador.len() < 3 {
        return Err("el disparador tiene que tener al menos 3 caracteres".into());
    }
    let nueva = ConfigTeclado {
        enabled: config.enabled,
        disparador,
    };
    guardar(&nueva)?;
    if nueva.enabled && !antes.enabled {
        arrancar_si_procede();
    }
    Ok(nueva)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn teclear(buf: &mut Buffer, texto: &str) -> Accion {
        let mut ultima = Accion::Nada;
        for ch in texto.chars() {
            ultima = buf.tecla(Some(ch), false, DISPARADOR);
        }
        ultima
    }

    #[test]
    fn el_disparador_activa_la_captura() {
        let mut b = Buffer::nuevo();
        teclear(&mut b, "//maria");
        assert!(b.capturando(DISPARADOR));
    }

    #[test]
    fn el_enter_devuelve_la_orden_y_cuanto_hay_que_borrar() {
        let mut b = Buffer::nuevo();
        teclear(&mut b, "//maria dame un saludo");
        let accion = b.tecla(None, true, DISPARADOR);
        assert_eq!(
            accion,
            Accion::Ejecutar {
                orden: "dame un saludo".into(),
                // "//maria dame un saludo" = 22 caracteres. NI UNO MAS: el
                // Enter se traga el hook, asi que no hay salto que borrar, y
                // pasarse muerde la linea anterior del documento.
                borrar: 22,
            }
        );
        // Y el buffer queda limpio para la siguiente.
        assert_eq!(b.linea(), "");
    }

    #[test]
    fn escribir_normal_no_dispara_nada() {
        // Caso negativo y el mas importante: esto NO puede ser un registrador
        // de teclas. Al escribir texto corriente, el buffer se queda vacio.
        let mut b = Buffer::nuevo();
        teclear(&mut b, "esto es un correo normal para un companero");
        assert_eq!(b.tecla(None, true, DISPARADOR), Accion::Nada);
        assert_eq!(b.linea(), "", "quedo texto guardado: {:?}", b.linea());
    }

    #[test]
    fn una_barra_suelta_no_basta() {
        let mut b = Buffer::nuevo();
        teclear(&mut b, "/ruta/de/fichero");
        assert!(!b.capturando(DISPARADOR));
        assert_eq!(b.tecla(None, true, DISPARADOR), Accion::Nada);
    }

    #[test]
    fn el_disparador_vale_aunque_venga_detras_de_otro_texto() {
        let mut b = Buffer::nuevo();
        teclear(&mut b, "hola //maria traduce esto");
        let accion = b.tecla(None, true, DISPARADOR);
        match accion {
            Accion::Ejecutar { orden, .. } => assert_eq!(orden, "traduce esto"),
            otra => panic!("no disparo: {otra:?}"),
        }
    }

    #[test]
    fn el_retroceso_deshace() {
        let mut b = Buffer::nuevo();
        teclear(&mut b, "//mariaX");
        b.tecla(Some('\u{8}'), false, DISPARADOR);
        assert_eq!(b.linea(), "//maria");
    }

    #[test]
    fn escape_cancela_la_captura() {
        // Caso negativo: si Escape no limpiara, una orden a medias se quedaria
        // pegada y se ejecutaria con el siguiente Enter.
        let mut b = Buffer::nuevo();
        teclear(&mut b, "//maria algo que no quiero");
        b.tecla(Some('\u{1b}'), false, DISPARADOR);
        assert_eq!(b.linea(), "");
        assert_eq!(b.tecla(None, true, DISPARADOR), Accion::Nada);
    }

    #[test]
    fn el_disparador_sin_orden_no_ejecuta() {
        // Caso negativo: `//maria` + Enter a secas no debe llamar al modelo.
        let mut b = Buffer::nuevo();
        teclear(&mut b, "//maria   ");
        assert_eq!(b.tecla(None, true, DISPARADOR), Accion::Nada);
    }

    #[test]
    fn una_linea_larguisima_se_abandona() {
        let mut b = Buffer::nuevo();
        teclear(&mut b, DISPARADOR);
        teclear(&mut b, &"a".repeat(MAX_ORDEN + 50));
        assert_eq!(b.linea(), "", "el buffer crecio sin limite");
    }

    #[test]
    fn viene_apagado_de_fabrica() {
        // Un hook de teclado global no se enciende solo.
        let c = ConfigTeclado::default();
        assert!(!c.enabled);
        assert_eq!(c.disparador, "//maria");
    }
}
