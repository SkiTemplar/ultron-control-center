// Mascota — orden Z respecto a la barra de tareas.
//
// La ventana de Pupus se crea `always_on_top`, pero la barra de tareas
// también es «topmost» y sube al principio de esa banda cada vez que se
// activa (clic en ella, tecla Windows) o cuando el Explorador se reinicia.
// Entonces Pupus, que camina sobre la barra, queda tapado por ella.
// El vigilante del escritorio (desk_watch.rs) llama a `raise_above_taskbar`
// en cada tick: solo si hay una barra por encima de Pupus lo vuelve a subir,
// para no pelearse con otras ventanas «topmost» (menús, avisos).

/// Clases de ventana de la barra de tareas: la principal y las de los demás
/// monitores. Pura, para los tests.
pub fn is_taskbar_class(class: &str) -> bool {
    matches!(class, "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
}

#[cfg(target_os = "windows")]
pub use imp::raise_above_taskbar;

#[cfg(not(target_os = "windows"))]
pub fn raise_above_taskbar(_hwnd: u64) -> bool {
    false
}

#[cfg(target_os = "windows")]
mod imp {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetWindow, SetWindowPos, GW_HWNDPREV, HWND_TOPMOST, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
    };

    /// Ventanas que se miran por encima de Pupus como mucho: la barra, si lo
    /// tapa, está entre las primeras de la banda «topmost».
    const MAX_ABOVE: usize = 64;

    fn class_name(hwnd: HWND) -> String {
        let mut buf = [0u16; 64];
        let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    /// Si alguna barra de tareas está por encima de la ventana `hwnd`, la sube
    /// al principio de la banda «topmost» sin activarla. Devuelve si la subió.
    pub fn raise_above_taskbar(hwnd: u64) -> bool {
        if hwnd == 0 {
            return false;
        }
        let own = hwnd as HWND;
        let mut above = unsafe { GetWindow(own, GW_HWNDPREV) };
        for _ in 0..MAX_ABOVE {
            if above.is_null() {
                return false;
            }
            if super::is_taskbar_class(&class_name(above)) {
                let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
                return unsafe { SetWindowPos(own, HWND_TOPMOST, 0, 0, 0, 0, flags) } != 0;
            }
            above = unsafe { GetWindow(above, GW_HWNDPREV) };
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconoce_las_barras_de_tareas_y_nada_mas() {
        assert!(is_taskbar_class("Shell_TrayWnd"));
        assert!(is_taskbar_class("Shell_SecondaryTrayWnd"));
        assert!(!is_taskbar_class("Progman"));
        assert!(!is_taskbar_class("Shell_traywnd"));
        assert!(!is_taskbar_class(""));
    }

    #[test]
    fn sin_ventana_no_hace_nada() {
        assert!(!raise_above_taskbar(0));
    }
}
