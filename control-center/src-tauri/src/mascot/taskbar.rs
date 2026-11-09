// Mascota — la barra de tareas: qué apps tienen botón y dónde está cada uno,
// para que Pupus pueda ir hasta él y señalarlo (useTaskbar.ts).
//
// taskbar_uia.rs lee los botones crudos; aquí se interpretan (nombre
// localizado → etiqueta, ventanas y anclado), se calcula en qué borde de su
// monitor está cada barra y se guarda una instantánea en caché. desk_watch.rs
// la refresca cuando cambia la huella de ventanas y emite `mascot:taskbar`.
//
// ALCANCE REAL: nombres verificados en vivo solo en español (Windows 11).
// El patrón en inglés (« - N running window(s)», « pinned») es una
// suposición sin verificar.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::taskbar_islands::{islands_of, TaskbarIsland};
use super::taskbar_uia::RawButton;
use super::win_fg;

/// Borde del monitor en el que está la barra.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Bottom,
    Top,
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskbarBar {
    pub hwnd: u64,
    pub primary: bool,
    pub rect: (i32, i32, i32, i32),
    pub monitor: (i32, i32, i32, i32),
    pub edge: Edge,
    pub auto_hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskbarButton {
    /// AUMID o ruta del exe, sin el prefijo «Appid: ».
    pub app_id: String,
    pub label: String,
    pub windows: u32,
    pub pinned: bool,
    pub rect: (i32, i32, i32, i32),
    pub bar: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskbarSnapshot {
    /// Sube cada vez que cambia el contenido.
    pub version: u64,
    pub taken_ms: u32,
    pub bars: Vec<TaskbarBar>,
    pub buttons: Vec<TaskbarButton>,
    /// Zonas visibles de una barra transparente (taskbar_islands.rs).
    pub islands: Vec<TaskbarIsland>,
}

/// Identidad de una ventana para buscarle el botón.
#[derive(Debug, Clone, Default)]
pub struct WindowIdent {
    pub aumid: String,
    pub exe_path: String,
    /// Nombre del ejecutable en minúsculas.
    pub exe: String,
    pub title: String,
}

const APPID_PREFIX: &str = "Appid: ";
const PINNED: [&str; 2] = [" anclado", " pinned"];
/// Botones del shell que no son apps.
const SHELL_IDS: [&str; 5] = [
    "StartButton",
    "SearchButton",
    "TaskViewButton",
    "WidgetsButton",
    "CopilotButton",
];
/// Antigüedad máxima de la caché cuando se pide con `force`.
const FORCE_MAX_AGE: Duration = Duration::from_secs(5);

/// «Discord: 1 ventana en ejecución anclado» → ("Discord", 1, true).
pub fn parse_name(name: &str) -> (String, u32, bool) {
    let mut s = name.trim();
    let mut pinned = false;
    for p in PINNED {
        if let Some(rest) = s.strip_suffix(p) {
            s = rest.trim_end();
            pinned = true;
            break;
        }
    }
    let (label, windows) = split_count(s);
    (label, windows, pinned)
}

fn split_count(s: &str) -> (String, u32) {
    for sep in [": ", " - "] {
        let Some(i) = s.rfind(sep) else { continue };
        let tail = &s[i + sep.len()..];
        let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
        let rest = tail[digits.len()..].trim_start();
        let is_count = rest.starts_with("ventana") || rest.starts_with("running window");
        if let (true, Ok(n)) = (is_count, digits.parse::<u32>()) {
            return (s[..i].trim().to_string(), n);
        }
    }
    (s.to_string(), 0)
}

/// Botón crudo → botón de app, o None si es del shell (Inicio, Buscar,
/// Vista de tareas, bandeja) o no tiene nombre.
pub fn to_button(raw: &RawButton) -> Option<TaskbarButton> {
    let id = raw.automation_id.trim();
    if SHELL_IDS.contains(&id) || id.starts_with("SystemTray") {
        return None;
    }
    let app_id = match id.strip_prefix(APPID_PREFIX) {
        Some(a) => a.trim().to_string(),
        // Windows 10: los botones clásicos no traen Appid.
        None if id.is_empty() => String::new(),
        None => return None,
    };
    let (label, windows, pinned) = parse_name(&raw.name);
    if label.is_empty() {
        return None;
    }
    Some(TaskbarButton {
        app_id,
        label,
        windows,
        pinned,
        rect: raw.rect,
        bar: raw.bar,
    })
}

/// Borde del monitor donde está la barra (por su eje largo y su centro).
pub fn edge_of(bar: (i32, i32, i32, i32), monitor: (i32, i32, i32, i32)) -> Edge {
    let (w, h) = (bar.2 - bar.0, bar.3 - bar.1);
    if w >= h {
        let bar_mid = bar.1 + bar.3;
        let mon_mid = monitor.1 + monitor.3;
        if bar_mid < mon_mid {
            Edge::Top
        } else {
            Edge::Bottom
        }
    } else if bar.0 + bar.2 < monitor.0 + monitor.2 {
        Edge::Left
    } else {
        Edge::Right
    }
}

fn eq_ci(a: &str, b: &str) -> bool {
    !a.is_empty() && a.to_lowercase() == b.to_lowercase()
}

/// Mínimo de la raíz del exe para emparejar por componentes.
const MIN_EXE_ROOT: usize = 4;

/// La raíz del exe («discord» de «Discord.exe») es un componente entero del
/// app_id: un segmento de ruta o una parte separada por puntos
/// («com.squirrel.Discord.Discord»). No vale una subcadena: «app» no es
/// «app-1.0.9262».
fn exe_root_matches(exe: &str, app_id: &str) -> bool {
    let exe = exe.to_lowercase();
    let root = exe.strip_suffix(".exe").unwrap_or(&exe);
    if root.chars().count() < MIN_EXE_ROOT {
        return false;
    }
    app_id
        .to_lowercase()
        .split(['\\', '/', '.'])
        .any(|part| part == root)
}

/// Botón de una ventana: AUMID exacto > ruta del exe > raíz del exe como
/// componente del app_id > sufijo del título tras « - » igual a la etiqueta.
pub fn match_button(win: &WindowIdent, buttons: &[TaskbarButton]) -> Option<usize> {
    if let Some(i) = buttons.iter().position(|b| eq_ci(&win.aumid, &b.app_id)) {
        return Some(i);
    }
    if let Some(i) = buttons.iter().position(|b| eq_ci(&win.exe_path, &b.app_id)) {
        return Some(i);
    }
    if let Some(i) = buttons
        .iter()
        .position(|b| exe_root_matches(&win.exe, &b.app_id))
    {
        return Some(i);
    }
    let suffix = win.title.rsplit(" - ").next().unwrap_or("").trim();
    if win.title.contains(" - ") {
        return buttons.iter().position(|b| eq_ci(suffix, &b.label));
    }
    None
}

/// AUMID explícito de una ventana (PKEY_AppUserModel_ID), si lo tiene.
#[cfg(target_os = "windows")]
pub fn window_aumid(hwnd: u64) -> Option<String> {
    use windows::core::GUID;
    use windows::Win32::Foundation::{HWND, PROPERTYKEY};
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PropVariantToStringAlloc,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::{
        IPropertyStore, SHGetPropertyStoreForWindow,
    };
    // {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3},5 (definida a mano: no viene
    // con las features activas).
    let key = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9F4C2855_9F79_4B39_A8D0_E1D42DE1D5F3),
        pid: 5,
    };
    unsafe {
        let store: IPropertyStore =
            SHGetPropertyStoreForWindow(HWND(hwnd as usize as *mut _)).ok()?;
        let mut value = store.GetValue(&key).ok()?;
        let text = PropVariantToStringAlloc(&value).ok().map(|p| {
            let s = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0 as *const _));
            s
        });
        let _ = PropVariantClear(&mut value);
        text.filter(|s| !s.is_empty())
    }
}

#[cfg(not(target_os = "windows"))]
pub fn window_aumid(_hwnd: u64) -> Option<String> {
    None
}

/// Identidad completa de una ventana para match_button.
pub fn ident_of(hwnd: u64) -> WindowIdent {
    let (exe, exe_path, title) = win_fg::window_process(hwnd);
    WindowIdent {
        aumid: window_aumid(hwnd).unwrap_or_default(),
        exe_path,
        exe,
        title,
    }
}

// ---------------------------------------------------------------------------
// Caché
// ---------------------------------------------------------------------------

struct Cached {
    snap: TaskbarSnapshot,
    at: Instant,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);
static VERSION: AtomicU64 = AtomicU64::new(0);

fn read_bars() -> Vec<TaskbarBar> {
    let auto_hidden = win_fg::taskbar_autohide();
    win_fg::taskbar_hwnds()
        .into_iter()
        .filter_map(|(hwnd, primary)| {
            let rect = win_fg::window_rect(hwnd)?;
            let (monitor, _) = win_fg::monitor_of(hwnd)?;
            Some(TaskbarBar {
                hwnd,
                primary,
                rect,
                monitor,
                edge: edge_of(rect, monitor),
                auto_hidden,
            })
        })
        .collect()
}

/// Relee la barra por UIA. Devuelve la instantánea y si ha cambiado.
pub fn refresh() -> Result<(TaskbarSnapshot, bool), String> {
    let t0 = Instant::now();
    let bars = read_bars();
    if bars.is_empty() {
        return Err("no se encuentra la barra de tareas".into());
    }
    let hwnds: Vec<u64> = bars.iter().map(|b| b.hwnd).collect();
    let raw = super::taskbar_uia::query(&hwnds)?;
    let buttons: Vec<TaskbarButton> = raw.iter().filter_map(to_button).collect();
    let islands = islands_of(&raw);
    let taken_ms = t0.elapsed().as_millis().min(u32::MAX as u128) as u32;
    let mut cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    let changed = cache.as_ref().is_none_or(|c| {
        c.snap.bars != bars || c.snap.buttons != buttons || c.snap.islands != islands
    });
    let version = if changed {
        VERSION.fetch_add(1, Ordering::SeqCst) + 1
    } else {
        VERSION.load(Ordering::SeqCst)
    };
    let snap = TaskbarSnapshot {
        version,
        taken_ms,
        bars,
        buttons,
        islands,
    };
    *cache = Some(Cached {
        snap: snap.clone(),
        at: Instant::now(),
    });
    Ok((snap, changed))
}

/// Última instantánea y su antigüedad.
pub fn cached() -> Option<(TaskbarSnapshot, Duration)> {
    let cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    cache.as_ref().map(|c| (c.snap.clone(), c.at.elapsed()))
}

/// Instantánea de la barra. Sin `force` vale la caché; con `force`, si
/// tiene más de 5 s se relee.
#[tauri::command]
pub async fn mascot_taskbar(force: bool) -> Result<TaskbarSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || match cached() {
        Some((snap, age)) if !force || age < FORCE_MAX_AGE => Ok(snap),
        _ => refresh().map(|(s, _)| s),
    })
    .await
    .map_err(|e| format!("tarea interrumpida: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(id: &str, name: &str) -> RawButton {
        RawButton {
            bar: 1,
            name: name.into(),
            automation_id: id.into(),
            rect: (0, 0, 44, 48),
        }
    }

    fn button(app_id: &str, label: &str) -> TaskbarButton {
        to_button(&raw(&format!("Appid: {app_id}"), label)).unwrap()
    }

    #[test]
    fn parsea_nombres_reales_en_espanol() {
        // Cadenas exactas de la sonda del 2026-10-16.
        assert_eq!(
            parse_name("Discord: 1 ventana en ejecución anclado"),
            ("Discord".into(), 1, true)
        );
        assert_eq!(parse_name("Word anclado"), ("Word".into(), 0, true));
        assert_eq!(
            parse_name("ULTRON Control Center: 1 ventana en ejecución"),
            ("ULTRON Control Center".into(), 1, false)
        );
        assert_eq!(
            parse_name("Configuración anclado"),
            ("Configuración".into(), 0, true)
        );
        assert_eq!(
            parse_name("Google Chrome: 3 ventanas en ejecución anclado"),
            ("Google Chrome".into(), 3, true)
        );
        // Dos puntos que no son un recuento: se quedan en la etiqueta.
        assert_eq!(
            parse_name("Proyecto: notas"),
            ("Proyecto: notas".into(), 0, false)
        );
    }

    #[test]
    fn descarta_inicio_buscar_y_bandeja() {
        for id in [
            "StartButton",
            "SearchButton",
            "TaskViewButton",
            "SystemTrayIcon",
        ] {
            assert!(to_button(&raw(id, "Inicio")).is_none(), "{id}");
        }
        assert!(
            to_button(&raw("Appid: Chrome", "   ")).is_none(),
            "sin nombre"
        );
        assert!(to_button(&raw("OtraCosa", "Algo")).is_none(), "id ajeno");
        let b = to_button(&raw(
            "Appid: ULTRON.Sessions",
            "ULTRON Control Center: 1 ventana en ejecución",
        ))
        .unwrap();
        assert_eq!(b.app_id, "ULTRON.Sessions");
        assert_eq!(b.windows, 1);
    }

    #[test]
    fn empareja_ventana_con_boton() {
        let buttons = vec![
            button("com.squirrel.Discord.Discord", "Discord"),
            button("Microsoft.Office.WINWORD.EXE.15", "Word"),
            button("C:\\Apps\\control-center.exe", "ULTRON Control Center"),
            button("ULTRON.Sessions", "ULTRON Control Center"),
            button("Chrome", "Google Chrome"),
        ];
        let w = |aumid: &str, path: &str, exe: &str, title: &str| WindowIdent {
            aumid: aumid.into(),
            exe_path: path.into(),
            exe: exe.into(),
            title: title.into(),
        };
        assert_eq!(
            match_button(
                &w("ULTRON.Sessions", "", "control-center.exe", ""),
                &buttons
            ),
            Some(3)
        );
        assert_eq!(
            match_button(
                &w("", "c:\\apps\\control-center.exe", "control-center.exe", ""),
                &buttons
            ),
            Some(2)
        );
        assert_eq!(
            match_button(&w("", "", "discord.exe", "#general"), &buttons),
            Some(0)
        );
        assert_eq!(
            match_button(&w("", "", "x.exe", "YouTube - Google Chrome"), &buttons),
            Some(4)
        );
        // Negativo: VS Code no tiene botón.
        assert_eq!(
            match_button(
                &w(
                    "",
                    "",
                    "code.exe",
                    "main.rs - proyecto - Visual Studio Code"
                ),
                &buttons
            ),
            None
        );
    }

    #[test]
    fn la_raiz_del_exe_tiene_que_ser_un_componente_entero() {
        let discord = "C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0.9262\\Discord.exe";
        assert!(exe_root_matches("Discord.exe", discord));
        assert!(exe_root_matches(
            "WINWORD.EXE",
            "Microsoft.Office.WINWORD.EXE.15"
        ));
        // Casos negativos: subcadena de un segmento y raíz demasiado corta.
        assert!(!exe_root_matches("app.exe", discord), "app ≠ app-1.0.9262");
        assert!(!exe_root_matches("cord.exe", discord));
        assert!(!exe_root_matches("x.exe", "x.y"), "menos de 4 letras");
        let buttons = vec![button(discord, "Discord")];
        let w = WindowIdent {
            aumid: String::new(),
            exe_path: String::new(),
            exe: "app.exe".into(),
            title: "Sin guion".into(),
        };
        assert_eq!(match_button(&w, &buttons), None);
    }

    #[test]
    fn edge_segun_rect_y_monitor() {
        let m = (0, 0, 2560, 1600);
        assert_eq!(edge_of((0, 1528, 2560, 1600), m), Edge::Bottom);
        assert_eq!(edge_of((0, 0, 2560, 72), m), Edge::Top);
        assert_eq!(edge_of((0, 0, 72, 1600), m), Edge::Left);
        assert_eq!(edge_of((2488, 0, 2560, 1600), m), Edge::Right);
        // Monitor secundario a la derecha, barra abajo.
        assert_eq!(
            edge_of((2560, 1032, 4480, 1080), (2560, 0, 4480, 1080)),
            Edge::Bottom
        );
    }

    /// Sonda en vivo (no corre en CI): cargo test --lib
    /// mascot::taskbar::tests::aumid_de_ventanas_reales -- --ignored --nocapture
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore]
    fn aumid_de_ventanas_reales() {
        let _ = unsafe {
            windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_MULTITHREADED,
            )
        };
        let wins = crate::mascot::win::desktop_windows(&[]);
        let mut found = 0;
        for w in &wins {
            let ident = ident_of(w.id);
            println!("{:?} | {} | {}", ident.aumid, ident.exe, w.title);
            found += usize::from(!ident.aumid.is_empty());
        }
        assert!(!wins.is_empty());
        println!("{found} de {} ventanas con AUMID explícito", wins.len());
    }
}
