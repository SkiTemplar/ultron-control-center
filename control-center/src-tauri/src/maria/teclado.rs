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
//   3. Al pulsar Intro o Escape con una orden escrita: se carga el modelo, se
//      responde, se PEGA la respuesta en una linea nueva debajo y se DESCARGA.
//      Se pega (portapapeles + Ctrl+V, devolviendolo despues como estaba) en
//      vez de teclearla: quinientas pulsaciones sinteticas seguidas salian
//      corrompidas. Ver `win::escribir`.
//
// NO BORRA NADA. Lo escrito por el usuario se queda donde esta. La primera
// version si borraba la orden para sustituirla por la respuesta y resulto ser
// mala idea: el contador de caracteres no puede ser exacto (teclas muertas,
// AltGr, clics del raton) y se dejaba media orden por delante. El usuario lo
// zanjo el 2026-09-19: "no quiero que borre nada del comentario".
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
    Ok(crate::maria::paths::cockpit("maria")?.join("teclado.json"))
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

/// Copia en memoria del disparador.
///
/// El hook lo consulta en CADA pulsacion, y antes eso era leer y parsear
/// `teclado.json` del disco cada vez. Un hook de bajo nivel que tarda demasiado
/// lo desengancha Windows sin avisar (LowLevelHooksTimeout), asi que ahi dentro
/// no puede haber entrada/salida. El valor se refresca al guardar.
static DISPARADOR_VIVO: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

/// El disparador que toca ahora, sin tocar el disco salvo la primera vez.
#[must_use]
pub fn disparador_actual() -> String {
    if let Some(d) = DISPARADOR_VIVO.read().ok().and_then(|g| g.clone()) {
        return d;
    }
    let d = cargar().disparador;
    if let Ok(mut g) = DISPARADOR_VIVO.write() {
        *g = Some(d.clone());
    }
    d
}

/// El hook deja de actuar. No se desengancha (vive en el hilo que bombea
/// mensajes y ese hilo muere con el proceso): lo que se garantiza es que
/// durante el cierre NO escriba en la ventana de otro programa.
pub fn parar() {
    PARADO.store(true, std::sync::atomic::Ordering::SeqCst);
    tracing::info!("apagado: autocompletado de teclado parado");
}

/// ¿Esta parado el hook?
#[must_use]
pub fn esta_parado() -> bool {
    PARADO.load(std::sync::atomic::Ordering::SeqCst)
}

static PARADO: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn refrescar_disparador(d: &str) {
    if let Ok(mut g) = DISPARADOR_VIVO.write() {
        *g = Some(d.to_string());
    }
}

// ---------------------------------------------------------------------------
// La maquina de estados (pura, y por eso testeable sin tocar el teclado)
// ---------------------------------------------------------------------------

/// Que hacer despues de procesar una tecla.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Accion {
    /// Nada que hacer: seguir mirando.
    Nada,
    /// Hay una orden lista. Solo lleva el texto: NO se borra nada de lo que el
    /// usuario haya escrito.
    ///
    /// Antes llevaba tambien cuantos caracteres borrar, y ahi estaba el
    /// problema. El usuario lo dijo sin margen (2026-09-19): "no borra todo el
    /// comentario que yo le he puesto. Y de hecho es que no quiero que lo
    /// borre. Simplemente que escriba a partir de ahi". Ademas el contador
    /// nunca podia ser fiable: el buffer solo ve las teclas que sabe traducir,
    /// asi que un acento con tecla muerta, un AltGr o un clic con el raton ya
    /// lo descuadraban y los retrocesos se comian texto de mas o de menos.
    /// Quitando el campo, el error deja de ser posible.
    Ejecutar { orden: String },
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

    /// Procesa una tecla. `lanzar` marca las teclas que disparan la orden:
    /// Intro y Escape.
    ///
    /// Las dos, porque las dos las pidio el usuario: primero "cuando reciba un
    /// enter, se active" (2026-09-19) y despues "cuando le de al escape,
    /// escriba a partir de ahi". Con el disparador a medias, cualquiera de las
    /// dos limpia la captura sin ejecutar nada; para cancelar una orden ya
    /// escrita, se borra con el retroceso.
    pub fn tecla(&mut self, c: Option<char>, lanzar: bool, disparador: &str) -> Accion {
        if lanzar {
            let orden = if self.capturando(disparador) {
                self.linea[disparador.len()..].trim().to_string()
            } else {
                String::new()
            };
            self.linea.clear();
            if !orden.is_empty() {
                return Accion::Ejecutar { orden };
            }
            return Accion::Nada;
        }

        match c {
            // Retroceso.
            Some('\u{8}') => {
                self.linea.pop();
            }
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
    let _en_uso = crate::maria::local::EnUso::nuevo();
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
    use super::{disparador_actual, responder, Accion, Buffer};
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, GetKeyState, GetKeyboardState, MapVirtualKeyW, SendInput, ToUnicode,
        INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC,
        VK_BACK, VK_CAPITAL, VK_CONTROL, VK_ESCAPE, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_MENU,
        VK_RCONTROL, VK_RETURN, VK_RMENU, VK_RSHIFT, VK_SHIFT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG,
        WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
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
                VK_SHIFT,
                VK_LSHIFT,
                VK_RSHIFT,
                VK_CONTROL,
                VK_LCONTROL,
                VK_RCONTROL,
                VK_MENU,
                VK_LMENU,
                VK_RMENU,
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
                if scan == 0 {
                    MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)
                } else {
                    scan
                },
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

    /// Deja la respuesta donde este el cursor.
    ///
    /// SE PEGA, no se teclea. Y esto no es una preferencia: teclear la
    /// respuesta caracter a caracter con `SendInput` funcionaba con "hola" y se
    /// rompia con un cuento. Medido en el Bloc de notas el 2026-09-19, con una
    /// respuesta de 267 caracteres:
    ///
    ///     bbbía ssssssssssssssssssssemáforo mmmmmmmmmmmmmmmmmmmmmmenta ......
    ///
    /// Caracteres repetidos veinte y cuarenta veces y los de en medio perdidos.
    /// Eso es exactamente el fallo que reporto el usuario ("para tareas un poco
    /// mas grandes falla estrepitosamente"). Quinientas inyecciones seguidas a
    /// traves de la cola de entrada del sistema no son fiables, y ademas cada
    /// una despierta a todos los hooks de teclado del escritorio.
    ///
    /// Pegar son CUATRO eventos de teclado en total, pase lo que pase.
    ///
    /// EL PORTAPAPELES SE DEVUELVE COMO ESTABA: se guarda lo que hubiera antes
    /// y se restaura despues. Lo que tuvieras copiado no se pierde.
    ///
    /// Si el portapapeles no se deja abrir (otro programa lo tiene cogido), se
    /// vuelve al tecleo caracter a caracter en vez de quedarse sin escribir.
    fn escribir(texto: &str) {
        let normalizado = texto.replace("\r\n", "\n").replace('\n', "\r\n");
        let previo = portapapeles::leer();
        if !portapapeles::escribir(&normalizado) {
            tracing::warn!("maria-teclado: sin portapapeles, tecleo la respuesta");
            escribir_plano(&texto.replace("\r\n", "\n").replace('\n', " "));
            return;
        }
        pegar();
        // El programa de destino necesita un momento para leer el
        // portapapeles: restaurarlo antes le haria pegar lo anterior.
        std::thread::sleep(std::time::Duration::from_millis(250));
        if let Some(antes) = previo {
            portapapeles::escribir(&antes);
        }
    }

    /// Ctrl+V.
    fn pegar() {
        const VK_V: u16 = 0x56;
        tecla_abajo(VK_CONTROL);
        tecla_abajo(VK_V);
        tecla_arriba(VK_V);
        tecla_arriba(VK_CONTROL);
    }

    fn evento_tecla(vk: u16, flags: u32) {
        let mut entrada = [INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: unsafe { std::mem::zeroed() },
        }; 1];
        unsafe {
            entrada[0].Anonymous.ki = KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: FIRMA,
            };
            SendInput(1, entrada.as_ptr(), std::mem::size_of::<INPUT>() as i32);
        }
        std::thread::sleep(std::time::Duration::from_millis(12));
    }

    fn tecla_abajo(vk: u16) {
        evento_tecla(vk, 0);
    }

    fn tecla_arriba(vk: u16) {
        evento_tecla(vk, KEYEVENTF_KEYUP);
    }

    /// El portapapeles de Windows, solo texto.
    mod portapapeles {
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
        };
        use windows_sys::Win32::System::Memory::{
            GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
        };

        const CF_UNICODETEXT: u32 = 13;
        /// Intentos de abrirlo: otro programa puede tenerlo cogido un instante.
        const INTENTOS: usize = 8;

        fn abrir() -> bool {
            for _ in 0..INTENTOS {
                if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            false
        }

        /// Lo que hay copiado ahora, si es texto.
        pub fn leer() -> Option<String> {
            if !abrir() {
                return None;
            }
            let texto = unsafe {
                let h: HANDLE = GetClipboardData(CF_UNICODETEXT);
                if h.is_null() {
                    None
                } else {
                    let p = GlobalLock(h) as *const u16;
                    if p.is_null() {
                        None
                    } else {
                        let mut n = 0usize;
                        while *p.add(n) != 0 {
                            n += 1;
                        }
                        let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, n));
                        let _ = GlobalUnlock(h);
                        Some(s)
                    }
                }
            };
            unsafe { CloseClipboard() };
            texto
        }

        /// Deja `texto` copiado. Devuelve si lo consiguio.
        pub fn escribir(texto: &str) -> bool {
            let mut datos: Vec<u16> = texto.encode_utf16().collect();
            datos.push(0);
            if !abrir() {
                return false;
            }
            let ok = unsafe {
                EmptyClipboard();
                let bytes = std::mem::size_of_val(&datos[..]);
                let h = GlobalAlloc(GMEM_MOVEABLE, bytes);
                if h.is_null() {
                    false
                } else {
                    let p = GlobalLock(h) as *mut u16;
                    if p.is_null() {
                        false
                    } else {
                        std::ptr::copy_nonoverlapping(datos.as_ptr(), p, datos.len());
                        let _ = GlobalUnlock(h);
                        // Al entregarlo, el portapapeles se queda con la
                        // memoria: no se libera aqui.
                        !SetClipboardData(CF_UNICODETEXT, h as HANDLE).is_null()
                    }
                }
            };
            unsafe { CloseClipboard() };
            ok
        }
    }

    /// Tecleo caracter a caracter. Solo como ultimo recurso (ver `escribir`).
    fn escribir_plano(texto: &str) {
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
                    dwExtraInfo: FIRMA,
                };
                entradas[1].Anonymous.ki = KEYBDINPUT {
                    wVk: 0,
                    wScan: ch,
                    dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: FIRMA,
                };
                SendInput(2, entradas.as_ptr(), std::mem::size_of::<INPUT>() as i32);
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    /// Firma que mar.ia pone en las pulsaciones que genera ella.
    ///
    /// Va en `dwExtraInfo`, que Windows transporta sin tocarlo desde
    /// `SendInput` hasta el hook. Sirve para reconocer lo propio.
    ///
    /// Se firma en vez de mirar la marca generica de "inyectado"
    /// (LLKHF_INJECTED) porque esa marca la llevan TODAS las pulsaciones
    /// sinteticas: el teclado en pantalla, un escritorio remoto, un teclado
    /// macro. Filtrando por ella, mar.ia dejaria de funcionar para quien
    /// escribe con esas herramientas. Filtrando por firma, solo se ignora lo
    /// que ha escrito ella misma.
    const FIRMA: usize = 0x006D_6131; // "ma1"

    /// Hay una orden en marcha. Evita dos respuestas pisandose si se pulsa
    /// Intro dos veces seguidas mientras la primera todavia escribe.
    static RESPONDIENDO: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    unsafe extern "system" fn hook(codigo: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        // Con la aplicacion cerrandose, el hook no toca nada: escribir en la
        // ventana de otro programa mientras mar.ia se apaga es justo lo que no
        // puede pasar.
        if super::esta_parado() {
            return CallNextHookEx(std::ptr::null_mut(), codigo, w, l);
        }
        if codigo >= 0 && (w as u32 == WM_KEYDOWN || w as u32 == WM_SYSKEYDOWN) {
            let info = &*(l as *const KBDLLHOOKSTRUCT);

            // Lo que escribe mar.ia NO se vuelve a mirar (va firmado).
            //
            // Sin esto, cada caracter de la respuesta volvia a entrar por aqui
            // (`SendInput` pasa por el hook) y se procesaba como si lo hubiera
            // tecleado el usuario. Con una respuesta corta se notaba poco; con
            // una larga eran cientos de vueltas extra, cada una leyendo la
            // configuracion del disco, y Windows desengancha un hook de bajo
            // nivel que tarda demasiado (LowLevelHooksTimeout). Eso es lo que
            // hacia que "hola" funcionara y "cuentame un cuento" fallara.
            if info.dwExtraInfo == FIRMA {
                return CallNextHookEx(std::ptr::null_mut(), codigo, w, l);
            }

            let vk = info.vkCode;
            // Intro y Escape lanzan; el resto se acumula.
            let lanzar = vk == VK_RETURN as u32 || vk == VK_ESCAPE as u32;
            let c = if lanzar {
                None
            } else if vk == VK_BACK as u32 {
                Some('\u{8}')
            } else {
                caracter(vk, info.scanCode)
            };

            let disparador = disparador_actual();
            let accion = {
                let mut guard = BUFFER.lock().unwrap_or_else(|e| e.into_inner());
                let buf = guard.get_or_insert_with(Buffer::nuevo);
                buf.tecla(c, lanzar, &disparador)
            };

            if let Accion::Ejecutar { orden } = accion {
                use std::sync::atomic::Ordering;
                if RESPONDIENDO.swap(true, Ordering::SeqCst) {
                    // Ya hay una respuesta escribiendose: este disparo se
                    // ignora, pero la tecla sigue su camino normal.
                    return CallNextHookEx(std::ptr::null_mut(), codigo, w, l);
                }
                // En un hilo aparte: el hook de teclado del sistema NO puede
                // bloquearse. Si tarda, Windows lo desengancha y deja de
                // funcionar para todo el escritorio.
                std::thread::spawn(move || {
                    // NO SE BORRA NADA. El comentario que ha escrito el usuario
                    // se queda tal cual; la respuesta va debajo, en una linea
                    // nueva. Es lo que pidio el 2026-09-19 despues de que el
                    // borrado se dejara media orden por delante.
                    let salida = match responder(&orden) {
                        Ok(texto) => texto,
                        Err(e) => {
                            tracing::warn!(error = %e, "maria-teclado: sin respuesta");
                            format!("[mar.ia no pudo responder: {e}]")
                        }
                    };
                    // El salto va aqui y no en la respuesta: la tecla Intro se
                    // ha tragado arriba para que el editor no haga lo suyo
                    // (enviar el mensaje, buscar, ejecutar la celda...).
                    escribir(&format!("\n{salida}"));
                    RESPONDIENDO.store(false, Ordering::SeqCst);
                });
                // Se traga la tecla: en un editor de texto daria igual, pero en
                // un buscador o un chat el Intro enviaria el formulario y la
                // respuesta acabaria en otra pagina.
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
    // El hook lee el disparador de memoria: si no se refresca aqui, seguiria
    // esperando el anterior hasta reiniciar mar.ia.
    refrescar_disparador(&nueva.disparador);
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
    fn la_tecla_de_lanzar_devuelve_solo_la_orden() {
        let mut b = Buffer::nuevo();
        teclear(&mut b, "//maria dame un saludo");
        let accion = b.tecla(None, true, DISPARADOR);
        assert_eq!(
            accion,
            Accion::Ejecutar {
                orden: "dame un saludo".into()
            }
        );
        // Y el buffer queda limpio para la siguiente.
        assert_eq!(b.linea(), "");
    }

    #[test]
    fn la_accion_no_puede_pedir_que_se_borre_nada() {
        // Caso negativo del fallo que reporto el usuario: la respuesta se
        // ANADE, nunca sustituye. Si algun dia vuelve a aparecer un campo con
        // cuantos caracteres borrar, este test deja de compilar y hay que
        // volver a leer por que se quito.
        let mut b = Buffer::nuevo();
        teclear(&mut b, "//maria hola");
        match b.tecla(None, true, DISPARADOR) {
            Accion::Ejecutar { orden } => assert_eq!(orden, "hola"),
            otra => panic!("esperaba Ejecutar, vino {otra:?}"),
        }
    }

    #[test]
    fn escape_tambien_lanza_la_orden() {
        // "cuando le de al escape... escriba a partir de ahi" (2026-09-19).
        // El hook manda `lanzar` tanto con Intro como con Escape.
        let mut b = Buffer::nuevo();
        teclear(&mut b, "//maria traduce esto");
        assert_eq!(
            b.tecla(None, true, DISPARADOR),
            Accion::Ejecutar {
                orden: "traduce esto".into()
            }
        );
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
    fn borrar_el_disparador_cancela_la_captura() {
        // Escape ya no cancela: lanza (lo pidio asi el usuario). La forma de
        // arrepentirse es borrar lo escrito, y entonces la captura tiene que
        // soltarse de verdad — si no, una orden abandonada se ejecutaria con
        // el siguiente Intro de cualquier otra cosa.
        let mut b = Buffer::nuevo();
        teclear(&mut b, "//maria algo que no quiero");
        for _ in 0..b.linea().chars().count() {
            b.tecla(Some('\u{8}'), false, DISPARADOR);
        }
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
