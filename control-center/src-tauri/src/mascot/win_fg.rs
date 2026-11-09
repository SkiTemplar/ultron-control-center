// Mascota — qué hay en primer plano y dónde están las barras de tareas
// (Win32 nativo, sin PowerShell: se sondea cada 500 ms desde desk_watch.rs).
//
// Coordenadas en píxeles físicos (el proceso es per-monitor DPI aware).
// Fuera de Windows todo devuelve vacío: la mascota es una función de
// Windows y no finge lo contrario.

use serde::Serialize;

/// (left, top, right, bottom) en píxeles físicos.
pub type Rect = (i32, i32, i32, i32);

/// Ventana en primer plano, con su monitor y el área de trabajo de este.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct FgWindow {
    pub hwnd: u64,
    pub pid: u32,
    /// Nombre del ejecutable en minúsculas («rocketleague.exe»).
    pub exe: String,
    /// Ruta completa del ejecutable (para emparejar con la barra de tareas).
    pub exe_path: String,
    pub title: String,
    /// GetWindowRect (incluye el marco invisible de redimensionado).
    pub rect: (i32, i32, i32, i32),
    pub monitor: (i32, i32, i32, i32),
    pub work: (i32, i32, i32, i32),
    pub has_caption: bool,
    /// Escritorio o barra de tareas: nunca es un juego ni pantalla completa.
    pub shell: bool,
}

/// Clases del propio shell (escritorio y barras de tareas).
pub fn is_shell_class(class: &str) -> bool {
    matches!(
        class,
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    )
}

/// «C:\Games\RocketLeague.exe» → «rocketleague.exe».
pub fn exe_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase()
}

#[cfg(target_os = "windows")]
pub use imp::*;

#[cfg(not(target_os = "windows"))]
pub use stub::*;

#[cfg(target_os = "windows")]
mod imp {
    use super::FgWindow;
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::mem::{size_of, zeroed};
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Shell::{
        SHAppBarMessage, SHQueryUserNotificationState, ABM_GETSTATE, ABS_AUTOHIDE, APPBARDATA,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowW, GetClassNameW, GetForegroundWindow, GetSystemMetrics, GetWindow,
        GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, GWL_STYLE, GW_OWNER, SM_CMONITORS,
        WS_CAPTION, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    /// (hwnd, pid) → (exe, ruta): OpenProcess solo cuando cambia la ventana.
    static EXE_CACHE: Mutex<Option<(u64, u32, String, String)>> = Mutex::new(None);

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
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

    fn rect_tuple(r: RECT) -> (i32, i32, i32, i32) {
        (r.left, r.top, r.right, r.bottom)
    }

    /// GetWindowRect de un HWND (píxeles físicos).
    pub fn window_rect(hwnd: u64) -> Option<(i32, i32, i32, i32)> {
        let mut r: RECT = unsafe { zeroed() };
        let ok = unsafe { GetWindowRect(hwnd as usize as HWND, &mut r) } != 0;
        ok.then(|| rect_tuple(r))
    }

    /// Monitor y área de trabajo del monitor más cercano a la ventana.
    pub fn monitor_of(hwnd: u64) -> Option<(super::Rect, super::Rect)> {
        let mon = unsafe { MonitorFromWindow(hwnd as usize as HWND, MONITOR_DEFAULTTONEAREST) };
        if mon.is_null() {
            return None;
        }
        let mut mi: MONITORINFO = unsafe { zeroed() };
        mi.cbSize = size_of::<MONITORINFO>() as u32;
        if unsafe { GetMonitorInfoW(mon, &mut mi) } == 0 {
            return None;
        }
        Some((rect_tuple(mi.rcMonitor), rect_tuple(mi.rcWork)))
    }

    fn process_image(pid: u32) -> Option<String> {
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = unsafe {
            QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        } != 0;
        unsafe { CloseHandle(h) };
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }

    fn exe_of(hwnd: u64, pid: u32) -> (String, String) {
        let mut cache = EXE_CACHE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((h, p, exe, path)) = cache.as_ref() {
            if *h == hwnd && *p == pid {
                return (exe.clone(), path.clone());
            }
        }
        let path = process_image(pid).unwrap_or_default();
        let exe = super::exe_name(&path);
        *cache = Some((hwnd, pid, exe.clone(), path.clone()));
        (exe, path)
    }

    /// (exe en minúsculas, ruta del exe, título) de cualquier ventana.
    pub fn window_process(hwnd: u64) -> (String, String, String) {
        let h = hwnd as usize as HWND;
        let mut pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(h, &mut pid) };
        let path = if pid != 0 {
            process_image(pid).unwrap_or_default()
        } else {
            String::new()
        };
        (super::exe_name(&path), path, title(h))
    }

    /// Ventana en primer plano salvo `exclude` (la propia mascota).
    pub fn foreground_window(exclude: u64) -> Option<FgWindow> {
        let hwnd = unsafe { GetForegroundWindow() };
        let id = hwnd as usize as u64;
        if hwnd.is_null() || id == exclude {
            return None;
        }
        let mut pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        let (exe, exe_path) = if pid != 0 {
            exe_of(id, pid)
        } else {
            Default::default()
        };
        let (monitor, work) = monitor_of(id).unwrap_or_default();
        let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32;
        Some(FgWindow {
            hwnd: id,
            pid,
            exe,
            exe_path,
            title: title(hwnd),
            rect: window_rect(id).unwrap_or_default(),
            monitor,
            work,
            has_caption: style & WS_CAPTION == WS_CAPTION,
            shell: super::is_shell_class(&class_name(hwnd)),
        })
    }

    /// SHQueryUserNotificationState: 3 = juego Direct3D a pantalla completa
    /// exclusiva, 5 = acepta notificaciones. 0 si la llamada falla.
    pub fn notification_state() -> u32 {
        let mut state: i32 = 0;
        let hr = unsafe { SHQueryUserNotificationState(&mut state) };
        if hr < 0 {
            0
        } else {
            state.max(0) as u32
        }
    }

    /// ¿La barra de tareas está en modo «ocultar automáticamente»? (en
    /// Windows 11 es un único ajuste para todas las barras).
    pub fn taskbar_autohide() -> bool {
        let mut abd: APPBARDATA = unsafe { zeroed() };
        abd.cbSize = size_of::<APPBARDATA>() as u32;
        let state = unsafe { SHAppBarMessage(ABM_GETSTATE, &mut abd) } as u32;
        state & ABS_AUTOHIDE != 0
    }

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> i32 {
        let out = &mut *(lparam as *mut Vec<HWND>);
        out.push(hwnd);
        1
    }

    #[cfg(test)]
    thread_local! {
        /// Llamadas a EnumWindows en este hilo (para los tests).
        pub(super) static ENUMS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    }

    fn top_level() -> Vec<HWND> {
        #[cfg(test)]
        ENUMS.with(|c| c.set(c.get() + 1));
        let mut hwnds: Vec<HWND> = Vec::new();
        unsafe {
            EnumWindows(Some(collect), &mut hwnds as *mut Vec<HWND> as LPARAM);
        }
        hwnds
    }

    /// Barras de tareas: (HWND, ¿es la principal?). La principal primero.
    pub fn taskbar_hwnds() -> Vec<(u64, bool)> {
        bars_from(&top_level())
    }

    /// La principal (FindWindowW) y las secundarias sacadas de una
    /// enumeración ya hecha.
    fn bars_from(hwnds: &[HWND]) -> Vec<(u64, bool)> {
        let mut out = Vec::new();
        let main = unsafe { FindWindowW(wide("Shell_TrayWnd").as_ptr(), std::ptr::null()) };
        if !main.is_null() {
            out.push((main as usize as u64, true));
        }
        for &h in hwnds {
            if class_name(h) == "Shell_SecondaryTrayWnd" {
                out.push((h as usize as u64, false));
            }
        }
        out
    }

    /// ¿La ventana sale con botón propio en la barra de tareas?
    fn on_taskbar(h: HWND) -> bool {
        if unsafe { IsWindowVisible(h) } == 0 {
            return false;
        }
        let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) } as u32;
        if ex & WS_EX_APPWINDOW != 0 {
            return true;
        }
        let owned = !unsafe { GetWindow(h, GW_OWNER) }.is_null();
        ex & WS_EX_TOOLWINDOW == 0 && !owned
    }

    /// Huella barata de lo que hay en la barra de tareas: ventanas con
    /// botón, rectángulos de las barras y número de monitores (sin títulos,
    /// que cambian con cada pestaña del navegador). Una sola enumeración de
    /// ventanas por vuelta: las barras secundarias salen de la misma.
    pub fn app_window_fingerprint() -> u64 {
        let mut hasher = DefaultHasher::new();
        let hwnds = top_level();
        for &h in &hwnds {
            if on_taskbar(h) {
                (h as usize).hash(&mut hasher);
            }
        }
        for (bar, _) in bars_from(&hwnds) {
            window_rect(bar).hash(&mut hasher);
        }
        unsafe { GetSystemMetrics(SM_CMONITORS) }.hash(&mut hasher);
        hasher.finish()
    }
}

#[cfg(not(target_os = "windows"))]
mod stub {
    use super::FgWindow;

    pub fn window_rect(_hwnd: u64) -> Option<(i32, i32, i32, i32)> {
        None
    }
    pub fn monitor_of(_hwnd: u64) -> Option<(super::Rect, super::Rect)> {
        None
    }
    pub fn foreground_window(_exclude: u64) -> Option<FgWindow> {
        None
    }
    pub fn window_process(_hwnd: u64) -> (String, String, String) {
        Default::default()
    }
    pub fn notification_state() -> u32 {
        0
    }
    pub fn taskbar_autohide() -> bool {
        false
    }
    pub fn taskbar_hwnds() -> Vec<(u64, bool)> {
        Vec::new()
    }
    pub fn app_window_fingerprint() -> u64 {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_shell_no_cuenta_como_ventana_de_app() {
        assert!(is_shell_class("Shell_SecondaryTrayWnd"));
        assert!(is_shell_class("Progman"));
        assert!(!is_shell_class("UnrealWindow"));
    }

    #[test]
    fn el_exe_sale_de_la_ruta_en_minusculas() {
        assert_eq!(exe_name("C:\\Games\\RocketLeague.exe"), "rocketleague.exe");
        assert_eq!(exe_name("cs2.exe"), "cs2.exe");
        assert_eq!(exe_name(""), "");
    }

    /// Solo lectura (EnumWindows y FindWindowW): no toca ninguna ventana.
    #[cfg(target_os = "windows")]
    #[test]
    fn la_huella_enumera_las_ventanas_una_sola_vez() {
        imp::ENUMS.with(|c| c.set(0));
        let _ = app_window_fingerprint();
        assert_eq!(imp::ENUMS.with(|c| c.get()), 1);
    }

    /// Sonda en vivo (no corre en CI): cargo test --lib
    /// mascot::win_fg::tests::sonda_primer_plano -- --ignored --nocapture
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore]
    fn sonda_primer_plano() {
        let fg = foreground_window(0).expect("hay ventana en primer plano");
        println!("{fg:?}");
        println!(
            "quns={} autohide={}",
            notification_state(),
            taskbar_autohide()
        );
        let (a, b) = (app_window_fingerprint(), app_window_fingerprint());
        println!("huella={a:#x}");
        assert_eq!(a, b, "la huella es estable sin cambios");
        assert!(!fg.exe.is_empty());
        assert!(fg.monitor.2 > fg.monitor.0 && fg.work.3 <= fg.monitor.3);
    }
}
