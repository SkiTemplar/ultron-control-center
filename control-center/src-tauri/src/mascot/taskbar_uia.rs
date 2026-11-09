// Mascota — botones de la barra de tareas por UI Automation (solo Windows).
//
// Windows 11 pinta la barra con XAML: no hay MSTaskListWClass y los botones
// solo existen para UIA. Cada botón de app es un elemento de clase
// `Taskbar.TaskListButtonAutomationPeer` con AutomationId «Appid: <AUMID o
// ruta del exe>» y un Name localizado («Discord: 1 ventana en ejecución
// anclado»). Sonda del 2026-10-16: 3 barras (Shell_TrayWnd y dos
// Shell_SecondaryTrayWnd) y cada una repite todos los botones.
//
// Coste: un único viaje entre procesos por barra (FindAllBuildCache con la
// caché de Name, AutomationId y BoundingRectangle, sin referencias vivas).
//
// UIA dentro de explorer puede colgarse si el shell está ocupado: todo pasa
// en un hilo propio («pupus-uia», COM en MTA) con los tiempos de conexión y
// transacción de IUIAutomation2 a 2 s, y quien pregunta espera como mucho
// QUERY_TIMEOUT. Nunca desde el hilo de la UI ni desde un comando síncrono.
//
// Recurso para Windows 10: si la condición no encuentra nada y la barra
// tiene un MSTaskListWClass, se toman los hijos de ese HWND.

/// Botón tal como lo da UIA, antes de interpretarlo (taskbar.rs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawButton {
    pub bar: u64,
    pub name: String,
    pub automation_id: String,
    pub rect: (i32, i32, i32, i32),
}

#[cfg(target_os = "windows")]
pub use imp::query;

#[cfg(not(target_os = "windows"))]
pub fn query(_bars: &[u64]) -> Result<Vec<RawButton>, String> {
    Err("la barra de tareas solo se lee en Windows".into())
}

#[cfg(target_os = "windows")]
mod imp {
    use super::RawButton;
    use std::mem::ManuallyDrop;
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;
    use windows::core::{Interface, BSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Variant::{VariantClear, VARIANT, VT_BSTR};
    use windows::Win32::UI::Accessibility::{
        AutomationElementMode_None, CUIAutomation8, IUIAutomation, IUIAutomation2,
        IUIAutomationCacheRequest, IUIAutomationCondition, IUIAutomationElement,
        TreeScope_Children, TreeScope_Descendants, UIA_AutomationIdPropertyId,
        UIA_BoundingRectanglePropertyId, UIA_ClassNamePropertyId, UIA_NamePropertyId,
        UIA_PROPERTY_ID,
    };

    use crate::mascot::taskbar_islands::{FRAME_ID, TRAY_ID};

    const BUTTON_CLASS: &str = "Taskbar.TaskListButtonAutomationPeer";
    const UIA_TIMEOUT_MS: u32 = 2000;
    const QUERY_TIMEOUT: Duration = Duration::from_secs(6);

    type Reply = Sender<Result<Vec<RawButton>, String>>;
    type Request = (Vec<u64>, Reply);

    static WORKER: OnceLock<Mutex<Sender<Request>>> = OnceLock::new();

    /// Lee los botones de las barras `bars` (HWND) en el hilo de UIA.
    pub fn query(bars: &[u64]) -> Result<Vec<RawButton>, String> {
        let worker = WORKER.get_or_init(|| Mutex::new(spawn_worker()));
        let (tx, rx) = channel();
        worker
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .send((bars.to_vec(), tx))
            .map_err(|_| "el hilo de UI Automation no está vivo".to_string())?;
        rx.recv_timeout(QUERY_TIMEOUT)
            .map_err(|_| "UI Automation no respondió a tiempo (¿explorer ocupado?)".to_string())?
    }

    fn spawn_worker() -> Sender<Request> {
        let (tx, rx) = channel::<Request>();
        let spawned = std::thread::Builder::new()
            .name("pupus-uia".into())
            .spawn(move || worker_loop(rx));
        if let Err(e) = spawned {
            tracing::warn!(error = %e, "mascota: no arrancó el hilo de UI Automation");
        }
        tx
    }

    fn worker_loop(rx: Receiver<Request>) {
        // S_FALSE (ya inicializado) también vale; un fallo real se reporta
        // en cada petición en vez de tumbar el hilo.
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let uia = if com.is_err() {
            Err(format!("CoInitializeEx: {com:?}"))
        } else {
            Uia::new()
        };
        for (bars, reply) in rx {
            let res = match &uia {
                Ok(u) => u.query_bars(&bars),
                Err(e) => Err(e.clone()),
            };
            let _ = reply.send(res);
        }
    }

    struct Uia {
        auto: IUIAutomation,
        cache: IUIAutomationCacheRequest,
        is_button: IUIAutomationCondition,
        all: IUIAutomationCondition,
    }

    fn err(what: &str, e: windows::core::Error) -> String {
        format!("UIA {what}: {e}")
    }

    /// VARIANT de tipo BSTR (la API de windows 0.61 no trae From<BSTR>).
    fn bstr_variant(s: &str) -> VARIANT {
        let mut v = VARIANT::default();
        unsafe {
            let inner = &mut *v.Anonymous.Anonymous;
            inner.vt = VT_BSTR;
            inner.Anonymous.bstrVal = ManuallyDrop::new(BSTR::from(s));
        }
        v
    }

    /// Condición «propiedad == texto».
    fn prop_condition(
        auto: &IUIAutomation,
        prop: UIA_PROPERTY_ID,
        value: &str,
    ) -> Result<IUIAutomationCondition, String> {
        let mut v = bstr_variant(value);
        let cond = unsafe { auto.CreatePropertyCondition(prop, &v) };
        unsafe {
            let _ = VariantClear(&mut v);
        }
        cond.map_err(|e| err("condición", e))
    }

    impl Uia {
        fn new() -> Result<Self, String> {
            let auto: IUIAutomation =
                unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
                    .map_err(|e| err("CoCreateInstance", e))?;
            if let Ok(a2) = auto.cast::<IUIAutomation2>() {
                unsafe {
                    let _ = a2.SetConnectionTimeout(UIA_TIMEOUT_MS);
                    let _ = a2.SetTransactionTimeout(UIA_TIMEOUT_MS);
                }
            }
            let cache = unsafe { auto.CreateCacheRequest() }.map_err(|e| err("cache", e))?;
            unsafe {
                for id in [
                    UIA_NamePropertyId,
                    UIA_AutomationIdPropertyId,
                    UIA_BoundingRectanglePropertyId,
                ] {
                    cache.AddProperty(id).map_err(|e| err("AddProperty", e))?;
                }
                cache
                    .SetAutomationElementMode(AutomationElementMode_None)
                    .map_err(|e| err("modo de caché", e))?;
            }
            // Botones de app, más el marco del grupo central y los iconos de
            // la bandeja (islas de una barra transparente, taskbar_islands.rs).
            let button = prop_condition(&auto, UIA_ClassNamePropertyId, BUTTON_CLASS)?;
            let frame = prop_condition(&auto, UIA_AutomationIdPropertyId, FRAME_ID)?;
            let tray = prop_condition(&auto, UIA_AutomationIdPropertyId, TRAY_ID)?;
            let is_button = unsafe {
                auto.CreateOrCondition(&button, &frame)
                    .and_then(|bf| auto.CreateOrCondition(&bf, &tray))
            }
            .map_err(|e| err("condición", e))?;
            let all = unsafe { auto.CreateTrueCondition() }.map_err(|e| err("condición", e))?;
            Ok(Self {
                auto,
                cache,
                is_button,
                all,
            })
        }

        fn query_bars(&self, bars: &[u64]) -> Result<Vec<RawButton>, String> {
            let mut out = Vec::new();
            let mut last_err = None;
            for &bar in bars {
                match self.query_bar(bar) {
                    Ok(mut list) => out.append(&mut list),
                    Err(e) => last_err = Some(e),
                }
            }
            match last_err {
                Some(e) if out.is_empty() => Err(e),
                _ => Ok(out),
            }
        }

        fn query_bar(&self, bar: u64) -> Result<Vec<RawButton>, String> {
            let hwnd = HWND(bar as usize as *mut _);
            let root = unsafe { self.auto.ElementFromHandle(hwnd) }.map_err(|e| err("barra", e))?;
            let found = self.collect(bar, &root, true)?;
            if !found.is_empty() {
                return Ok(found);
            }
            // Windows 10: lista clásica de botones.
            match task_list_win10(hwnd) {
                Some(list) => {
                    let el = unsafe { self.auto.ElementFromHandle(list) }
                        .map_err(|e| err("MSTaskListWClass", e))?;
                    self.collect(bar, &el, false)
                }
                None => Ok(found),
            }
        }

        fn collect(
            &self,
            bar: u64,
            root: &IUIAutomationElement,
            xaml: bool,
        ) -> Result<Vec<RawButton>, String> {
            let (scope, cond) = if xaml {
                (TreeScope_Descendants, &self.is_button)
            } else {
                (TreeScope_Children, &self.all)
            };
            let arr = unsafe { root.FindAllBuildCache(scope, cond, &self.cache) }
                .map_err(|e| err("FindAllBuildCache", e))?;
            let n = unsafe { arr.Length() }.unwrap_or(0);
            let mut out = Vec::with_capacity(n.max(0) as usize);
            for i in 0..n {
                let Ok(el) = (unsafe { arr.GetElement(i) }) else {
                    continue;
                };
                let name = unsafe { el.CachedName() }
                    .map(|b| b.to_string())
                    .unwrap_or_default();
                let automation_id = unsafe { el.CachedAutomationId() }
                    .map(|b| b.to_string())
                    .unwrap_or_default();
                let Ok(r) = (unsafe { el.CachedBoundingRectangle() }) else {
                    continue;
                };
                out.push(RawButton {
                    bar,
                    name,
                    automation_id,
                    rect: (r.left, r.top, r.right, r.bottom),
                });
            }
            Ok(out)
        }
    }

    /// Shell_TrayWnd → ReBarWindow32 → MSTaskSwWClass → MSTaskListWClass.
    fn task_list_win10(bar: HWND) -> Option<HWND> {
        use windows_sys::Win32::UI::WindowsAndMessaging::FindWindowExW;
        let mut cur = bar.0 as windows_sys::Win32::Foundation::HWND;
        for class in ["ReBarWindow32", "MSTaskSwWClass", "MSTaskListWClass"] {
            let wide: Vec<u16> = class.encode_utf16().chain(std::iter::once(0)).collect();
            cur = unsafe {
                FindWindowExW(cur, std::ptr::null_mut(), wide.as_ptr(), std::ptr::null())
            };
            if cur.is_null() {
                return None;
            }
        }
        Some(HWND(cur as *mut _))
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use crate::mascot::win_fg;
    use std::time::Instant;

    /// Sonda en vivo (no corre en CI): cargo test --lib mascot::taskbar_uia
    /// -- --ignored --nocapture
    #[test]
    #[ignore]
    fn uia_lista_la_barra_real() {
        // Como la app (tao lo declara al arrancar): per-monitor aware v2.
        // Sin esto, el ejecutable de tests ve coordenadas virtualizadas.
        #[link(name = "user32")]
        extern "system" {
            fn SetProcessDpiAwarenessContext(value: isize) -> i32;
        }
        unsafe { SetProcessDpiAwarenessContext(-4) };
        let bars = win_fg::taskbar_hwnds();
        assert!(!bars.is_empty(), "no hay barras de tareas");
        let t0 = Instant::now();
        let all = query(&bars.iter().map(|b| b.0).collect::<Vec<_>>()).expect("UIA");
        let total = t0.elapsed();
        for (bar, primary) in &bars {
            let rect = win_fg::window_rect(*bar).expect("GetWindowRect de la barra");
            let t = Instant::now();
            let mine = query(&[*bar]).expect("UIA por barra");
            println!(
                "barra {bar:#x} principal={primary} rect={rect:?}: {} botones en {} ms",
                mine.len(),
                t.elapsed().as_millis()
            );
            for b in &mine {
                println!("  {:?} {:?} {:?}", b.automation_id, b.name, b.rect);
                let (l, t, r, bo) = b.rect;
                assert!(
                    l >= rect.0 - 2 && t >= rect.1 - 2 && r <= rect.2 + 2 && bo <= rect.3 + 2,
                    "rect {:?} fuera de la barra {rect:?} (¿píxeles virtualizados?)",
                    b.rect
                );
            }
            assert!(!mine.is_empty(), "barra {bar:#x} sin botones");
        }
        println!("total {} botones en {} ms", all.len(), total.as_millis());
        assert!(total.as_millis() < 150, "demasiado lento: {total:?}");
    }
}
