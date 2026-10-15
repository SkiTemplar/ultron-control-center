// Mascota — capa Win32.
//
// Todo lo que la mascota necesita del sistema y que la webview no puede
// saber por sí sola:
//   * el cursor GLOBAL (la ventana de la mascota ignora el ratón casi siempre,
//     así que no recibe mousemove; hay que preguntarlo),
//   * los rectángulos de las ventanas visibles, en orden Z, para subirse a
//     ellas y estamparse contra ellas,
//   * entrada sintética (mover, clicar, teclear) y captura de pantalla para
//     el MCP de escritorio (`bridge.rs`).
//
// Coordenadas: SIEMPRE píxeles físicos de pantalla. El proceso es
// per-monitor DPI aware (tao lo declara al arrancar), así que GetCursorPos,
// SetCursorPos, BitBlt y DWMWA_EXTENDED_FRAME_BOUNDS hablan el mismo idioma.
// La conversión a píxeles CSS la hace la webview con el origen y la escala
// que le da `mascot_env`.
//
// Fuera de Windows cada función devuelve un error explícito o un valor
// vacío: la app se compila en Linux/macOS (CI), pero la mascota es una
// función de Windows y lo dice en vez de fingir que funciona.

use serde::Serialize;

/// Rectángulo de una ventana de nivel superior, en píxeles físicos.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WinRect {
    /// HWND como entero: identidad estable mientras la ventana viva. La
    /// mascota lo usa para «ir montada» en la ventana cuando esta se mueve.
    pub id: u64,
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub title: String,
}

/// Estado del puntero global.
#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct CursorState {
    pub x: i32,
    pub y: i32,
    pub ctrl: bool,
    pub lbutton: bool,
}

/// Captura en BGRA de arriba abajo (4 bytes por píxel).
pub struct RawCapture {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[cfg(target_os = "windows")]
pub use imp::*;

#[cfg(not(target_os = "windows"))]
pub use stub::*;

#[cfg(target_os = "windows")]
mod imp {
    use super::{CursorState, MouseButton, RawCapture, WinRect};
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
    use windows_sys::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, SRCCOPY,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_HWHEEL,
        MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
        MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT, VK_CONTROL,
        VK_LBUTTON, VK_RETURN,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetCursorPos, GetSystemMetrics, GetWindowLongPtrW,
        GetWindowRect, GetWindowTextLengthW, GetWindowTextW, IsIconic, IsWindowVisible,
        SetCursorPos, SetWindowDisplayAffinity, GWL_EXSTYLE, SM_CXSCREEN, SM_CYSCREEN,
        WDA_EXCLUDEFROMCAPTURE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    fn key_down(vk: i32) -> bool {
        // Bit alto = pulsada ahora mismo.
        (unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000) != 0
    }

    pub fn cursor_state() -> Option<CursorState> {
        let mut p = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut p) } == 0 {
            return None;
        }
        Some(CursorState {
            x: p.x,
            y: p.y,
            ctrl: key_down(VK_CONTROL as i32),
            lbutton: key_down(VK_LBUTTON as i32),
        })
    }

    fn class_name(hwnd: HWND) -> String {
        let mut buf = [0u16; 128];
        let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn title(hwnd: HWND) -> String {
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn frame_rect(hwnd: HWND) -> Option<RECT> {
        let mut r: RECT = unsafe { zeroed() };
        // EXTENDED_FRAME_BOUNDS = el borde visible. GetWindowRect incluye el
        // marco invisible de redimensionado (~7 px por lado en Windows 10/11)
        // y la mascota flotaría por encima de la barra de título.
        let hr = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS as u32,
                &mut r as *mut RECT as *mut _,
                size_of::<RECT>() as u32,
            )
        };
        if hr == 0 {
            return Some(r);
        }
        if unsafe { GetWindowRect(hwnd, &mut r) } != 0 {
            Some(r)
        } else {
            None
        }
    }

    fn is_cloaked(hwnd: HWND) -> bool {
        // Ventanas de otros escritorios virtuales y apps UWP suspendidas son
        // «visibles» para IsWindowVisible pero no se ven en pantalla.
        let mut cloaked: u32 = 0;
        let hr = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED as u32,
                &mut cloaked as *mut u32 as *mut _,
                size_of::<u32>() as u32,
            )
        };
        hr == 0 && cloaked != 0
    }

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> i32 {
        let out = &mut *(lparam as *mut Vec<HWND>);
        out.push(hwnd);
        1
    }

    /// Ventanas visibles de nivel superior, de la más alta a la más baja en
    /// orden Z (el orden en que las devuelve EnumWindows).
    pub fn desktop_windows(exclude: &[u64]) -> Vec<WinRect> {
        let mut hwnds: Vec<HWND> = Vec::new();
        unsafe {
            EnumWindows(Some(collect), &mut hwnds as *mut Vec<HWND> as LPARAM);
        }
        let mut out = Vec::new();
        for hwnd in hwnds {
            let id = hwnd as usize as u64;
            if exclude.contains(&id) {
                continue;
            }
            unsafe {
                if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
                    continue;
                }
            }
            let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
            if ex & WS_EX_TOOLWINDOW != 0 && ex & WS_EX_APPWINDOW == 0 {
                continue;
            }
            if is_cloaked(hwnd) {
                continue;
            }
            let class = class_name(hwnd);
            // Escritorio y barra de tareas: el suelo ya es el área de trabajo.
            if matches!(
                class.as_str(),
                "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
            ) {
                continue;
            }
            let t = title(hwnd);
            if t.is_empty() {
                continue;
            }
            let Some(r) = frame_rect(hwnd) else { continue };
            if r.right - r.left < 80 || r.bottom - r.top < 40 {
                continue;
            }
            out.push(WinRect {
                id,
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
                title: t,
            });
        }
        out
    }

    pub fn exclude_from_capture(hwnd: u64) -> bool {
        unsafe { SetWindowDisplayAffinity(hwnd as usize as HWND, WDA_EXCLUDEFROMCAPTURE) != 0 }
    }

    pub fn move_cursor(x: i32, y: i32) -> Result<(), String> {
        if unsafe { SetCursorPos(x, y) } == 0 {
            return Err("SetCursorPos falló".into());
        }
        Ok(())
    }

    fn send(inputs: &[INPUT]) -> Result<(), String> {
        if inputs.is_empty() {
            return Ok(());
        }
        let sent =
            unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            // UIPI: Windows bloquea la entrada sintética hacia ventanas con
            // más privilegios (p. ej. un programa abierto como administrador).
            return Err(format!(
                "SendInput solo entregó {sent}/{} eventos (¿ventana destino elevada?)",
                inputs.len()
            ));
        }
        Ok(())
    }

    fn mouse(flags: u32, data: i32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: data as _,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn key(vk: u16, scan: u16, flags: u32) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    pub fn mouse_button(button: MouseButton, down: bool) -> Result<(), String> {
        let flags = match (button, down) {
            (MouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
            (MouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
            (MouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
            (MouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
            (MouseButton::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
            (MouseButton::Middle, false) => MOUSEEVENTF_MIDDLEUP,
        };
        send(&[mouse(flags, 0)])
    }

    /// `dy` > 0 = rueda hacia arriba (contenido sube), en «muescas».
    pub fn scroll(dx: i32, dy: i32) -> Result<(), String> {
        let mut v = Vec::new();
        if dy != 0 {
            v.push(mouse(MOUSEEVENTF_WHEEL, dy * 120));
        }
        if dx != 0 {
            v.push(mouse(MOUSEEVENTF_HWHEEL, dx * 120));
        }
        send(&v)
    }

    pub fn type_text(text: &str) -> Result<(), String> {
        let mut v = Vec::new();
        for unit in text.encode_utf16() {
            if unit == '\n' as u16 {
                v.push(key(VK_RETURN, 0, 0));
                v.push(key(VK_RETURN, 0, KEYEVENTF_KEYUP));
                continue;
            }
            if unit == '\r' as u16 {
                continue;
            }
            v.push(key(0, unit, KEYEVENTF_UNICODE));
            v.push(key(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
        send(&v)
    }

    pub fn key_combo(vks: &[u16]) -> Result<(), String> {
        let ext = |vk: u16| {
            if super::super::keys::is_extended(vk) {
                KEYEVENTF_EXTENDEDKEY
            } else {
                0
            }
        };
        let mut v = Vec::new();
        for &vk in vks {
            v.push(key(vk, 0, ext(vk)));
        }
        for &vk in vks.iter().rev() {
            v.push(key(vk, 0, ext(vk) | KEYEVENTF_KEYUP));
        }
        send(&v)
    }

    /// Captura el monitor principal.
    /// Tamaño del monitor principal en píxeles físicos.
    pub fn primary_size() -> (u32, u32) {
        let (w, h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
        (w.max(0) as u32, h.max(0) as u32)
    }

    pub fn capture_primary() -> Result<RawCapture, String> {
        unsafe {
            let w = GetSystemMetrics(SM_CXSCREEN);
            let h = GetSystemMetrics(SM_CYSCREEN);
            if w <= 0 || h <= 0 {
                return Err("tamaño de pantalla desconocido".into());
            }
            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() {
                return Err("GetDC falló".into());
            }
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, bmp as _);
            let ok = BitBlt(mem, 0, 0, w, h, screen, 0, 0, SRCCOPY | CAPTUREBLT);
            let mut info: BITMAPINFO = zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // negativo = filas de arriba abajo
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..zeroed()
            };
            let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
            let lines = if ok != 0 {
                GetDIBits(
                    mem,
                    bmp,
                    0,
                    h as u32,
                    buf.as_mut_ptr() as *mut _,
                    &mut info,
                    DIB_RGB_COLORS,
                )
            } else {
                0
            };
            SelectObject(mem, old);
            DeleteObject(bmp as _);
            DeleteDC(mem);
            ReleaseDC(std::ptr::null_mut(), screen);
            if lines == 0 {
                return Err("BitBlt/GetDIBits falló".into());
            }
            Ok(RawCapture {
                width: w as u32,
                height: h as u32,
                bgra: buf,
            })
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod stub {
    use super::{CursorState, MouseButton, RawCapture, WinRect};

    const NO: &str = "solo disponible en Windows";

    pub fn cursor_state() -> Option<CursorState> {
        None
    }
    pub fn desktop_windows(_exclude: &[u64]) -> Vec<WinRect> {
        Vec::new()
    }
    pub fn exclude_from_capture(_hwnd: u64) -> bool {
        false
    }
    pub fn move_cursor(_x: i32, _y: i32) -> Result<(), String> {
        Err(NO.into())
    }
    pub fn mouse_button(_b: MouseButton, _down: bool) -> Result<(), String> {
        Err(NO.into())
    }
    pub fn scroll(_dx: i32, _dy: i32) -> Result<(), String> {
        Err(NO.into())
    }
    pub fn type_text(_t: &str) -> Result<(), String> {
        Err(NO.into())
    }
    pub fn key_combo(_vks: &[u16]) -> Result<(), String> {
        Err(NO.into())
    }
    pub fn primary_size() -> (u32, u32) {
        (0, 0)
    }
    pub fn capture_primary() -> Result<RawCapture, String> {
        Err(NO.into())
    }
}
