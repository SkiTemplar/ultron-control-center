// Mascota — avisos del shell: cuando una app hace parpadear su botón de la
// barra de tareas (HSHELL_FLASH), Pupus va y lo señala.
//
// RegisterShellHookWindow no entrega mensajes a ventanas message-only: hace
// falta una ventana de nivel superior oculta (WS_EX_TOOLWINDOW, sin botón en
// la barra) con su propio bucle de mensajes, en un hilo dedicado
// («pupus-shellhook»). Si el registro falla, queda solo el sondeo de
// desk_watch.rs y se deja constancia en el log.
//
// Emite `mascot:attention` { app_id, label } a la ventana de la mascota,
// salvo en silencio de juego. Cero tokens.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Attention {
    pub app_id: String,
    pub label: String,
}

/// HSHELL_REDRAW | HSHELL_HIGHBIT: la ventana `lparam` parpadea.
pub const HSHELL_FLASH: usize = 0x8006;

/// ¿El mensaje del shell es un parpadeo? Pura, para los tests.
pub fn is_flash(wparam: usize) -> bool {
    wparam == HSHELL_FLASH
}

#[cfg(target_os = "windows")]
pub use imp::start;

#[cfg(not(target_os = "windows"))]
pub fn start(_app: tauri::AppHandle) {}

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::OnceLock;

    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
        RegisterShellHookWindow, RegisterWindowMessageW, TranslateMessage, MSG, WNDCLASSW,
        WS_EX_TOOLWINDOW, WS_POPUP,
    };

    use super::super::{desk_watch, taskbar, LABEL};
    use super::{is_flash, Attention};

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static SHELLHOOK_MSG: AtomicU32 = AtomicU32::new(0);

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn start(app: AppHandle) {
        if APP.set(app).is_err() {
            return; // ya arrancado
        }
        let spawned = std::thread::Builder::new()
            .name("pupus-shellhook".into())
            .spawn(run);
        if let Err(e) = spawned {
            tracing::warn!(error = %e, "mascota: no arrancó el hilo del shell hook");
        }
    }

    fn run() {
        // STA: el AUMID se lee con SHGetPropertyStoreForWindow (COM).
        let _ = unsafe {
            windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
            )
        };
        let Some(hwnd) = create_window() else {
            tracing::warn!("mascota: sin ventana para el shell hook; solo sondeo");
            return;
        };
        let msg = unsafe { RegisterWindowMessageW(wide("SHELLHOOK").as_ptr()) };
        if msg == 0 || unsafe { RegisterShellHookWindow(hwnd) } == 0 {
            tracing::warn!("mascota: RegisterShellHookWindow falló; solo sondeo");
            return;
        }
        SHELLHOOK_MSG.store(msg, Ordering::SeqCst);
        let mut m: MSG = unsafe { std::mem::zeroed() };
        while unsafe { GetMessageW(&mut m, std::ptr::null_mut(), 0, 0) } > 0 {
            unsafe {
                TranslateMessage(&m);
                DispatchMessageW(&m);
            }
        }
    }

    fn create_window() -> Option<HWND> {
        let class = wide("UltronPupusShellHook");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            lpszClassName: class.as_ptr(),
            ..unsafe { std::mem::zeroed() }
        };
        if unsafe { RegisterClassW(&wc) } == 0 {
            return None;
        }
        // Nivel superior, oculta (sin WS_VISIBLE) y sin botón en la barra.
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOOLWINDOW,
                class.as_ptr(),
                class.as_ptr(),
                WS_POPUP,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        (!hwnd.is_null()).then_some(hwnd)
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        let hook = SHELLHOOK_MSG.load(Ordering::SeqCst);
        if hook != 0 && msg == hook {
            if is_flash(wp) {
                on_flash(lp as usize as u64);
            }
            return 0;
        }
        DefWindowProcW(hwnd, msg, wp, lp)
    }

    fn on_flash(win: u64) {
        let Some(app) = APP.get() else { return };
        if desk_watch::current().is_some_and(|s| s.quiet) {
            return; // jugando: no se interrumpe
        }
        let Some((snap, _)) = taskbar::cached() else {
            return;
        };
        let ident = taskbar::ident_of(win);
        let Some(i) = taskbar::match_button(&ident, &snap.buttons) else {
            tracing::debug!(exe = %ident.exe, "mascota: parpadeo sin botón conocido");
            return;
        };
        let b = &snap.buttons[i];
        let _ = app.emit_to(
            LABEL,
            "mascot:attention",
            Attention {
                app_id: b.app_id.clone(),
                label: b.label.clone(),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solo_el_parpadeo_cuenta() {
        assert!(is_flash(0x8006));
        // HSHELL_REDRAW sin el bit alto (cambio de título) no es parpadeo.
        assert!(!is_flash(0x0006));
        assert!(!is_flash(1), "HSHELL_WINDOWCREATED");
    }
}
