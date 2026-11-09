// sesiones/ventana_icono.rs — Identidad de cada ventana de Sessions en la
// barra de tareas de Windows (objetivo O2 del contrato de estabilidad).
//
// - Icono generado por ventana con el logo "Disco": disco negro a sangre con
//   un aro abierto en el borde y la inicial blanca (Georgia, del atlas
//   `iniciales.png`). El color del aro rota entre 10 tonos con cada ventana
//   nueva; la principal lleva el naranja Claude.
// - AppUserModelID propio por ventana (`PKEY_AppUserModel_ID` en el almacén
//   de propiedades de la ventana): sin él, Windows agrupa todas las ventanas
//   del proceso bajo un solo botón.
//
// El generador y el AUMID son puros y se prueban; la parte nativa es una FFI
// mínima de `SHGetPropertyStoreForWindow` (shell32), sin features nuevas de
// `windows`.
//
// Propiedad: WP-MOTORES.

use tauri::{AppHandle, WebviewWindow};

/// Lado del icono, en píxeles (Windows lo reduce con calidad para la barra).
pub const ICON_SIZE: usize = 64;
/// Aro: grosor (8 % del lado, como `logos-anillo.ps1`) y hueco (grados,
/// 0 = derecha, sentido horario).
const RING_WIDTH: f32 = ICON_SIZE as f32 * 0.08;
const RING_GAP: (f32, f32) = (210.0, 300.0);
/// Color del disco y de la inicial.
const DISCO: [u8; 3] = [0x05, 0x05, 0x07];
const LETRA: [u8; 3] = [0xF2, 0xF3, 0xF5];
/// Muestras por eje para el suavizado de bordes.
const SS: usize = 4;
const APP_AUMID: &str = "ULTRON.Sessions";

/// Colores del aro: naranja Claude primero y luego tonos que contrastan con el negro.
pub const RING_COLORS: [[u8; 3]; 10] = [
    [0xD9, 0x77, 0x57],
    [0x8A, 0xB4, 0xFF],
    [0x7E, 0xE7, 0x87],
    [0xC7, 0x92, 0xEA],
    [0xF2, 0xCC, 0x60],
    [0x5F, 0xD7, 0xD7],
    [0xFF, 0x8F, 0xB1],
    [0xFF, 0x6B, 0x6B],
    [0xB8, 0xE9, 0x86],
    [0xF2, 0xF3, 0xF5],
];

/// Contador de ventanas: el aro rota por la paleta (el 0 queda para la principal).
static NEXT_RING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Color del aro de la siguiente ventana; recorre la paleta saltando el de la principal.
pub fn siguiente_aro() -> [u8; 3] {
    let n = NEXT_RING.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    RING_COLORS[1 + n % (RING_COLORS.len() - 1)]
}

/// Título, AppUserModelID e icono RGBA de una ventana.
pub struct Aspecto {
    pub titulo: String,
    pub aumid: String,
    pub rgba: Vec<u8>,
}

impl Aspecto {
    pub fn principal() -> Self {
        Self {
            titulo: "ULTRON Sessions".into(),
            aumid: APP_AUMID.into(),
            rgba: icono('U', RING_COLORS[0]),
        }
    }

    pub fn extra(label: &str) -> Self {
        Self {
            titulo: "ULTRON Sessions · ventana".into(),
            aumid: aumid_para(label),
            rgba: icono('S', siguiente_aro()),
        }
    }

    pub fn de_sesion(label: &str, titulo: &str, proyecto: &str) -> Self {
        let inicial = proyecto
            .chars()
            .find(char::is_ascii_alphanumeric)
            .unwrap_or('S');
        Self {
            titulo: format!("{titulo} · {proyecto}"),
            aumid: aumid_para(label),
            rgba: icono(inicial, siguiente_aro()),
        }
    }
}

/// AppUserModelID de una ventana: el de la app para la principal y uno
/// derivado de la etiqueta para las adicionales (≤ 128 caracteres, sin
/// espacios).
pub fn aumid_para(label: &str) -> String {
    let suf: String = label
        .strip_prefix(super::registro::WINDOW_LABEL)
        .unwrap_or(label)
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(64)
        .collect();
    if suf.is_empty() {
        APP_AUMID.to_string()
    } else {
        format!("{APP_AUMID}.{suf}")
    }
}

/// Atlas de iniciales (A-Z y 0-9) en Georgia Bold: una fila de celdas de
/// `ICON_SIZE` px, blanco sobre transparente. Lo genera
/// `desktop/escritorio/logos-anillo.ps1 -Tauri`, con la misma U que el logo
/// de los accesos directos.
const ATLAS_PNG: &[u8] = include_bytes!("iniciales.png");
const ATLAS_CHARS: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/// Canal alfa del atlas, decodificado una vez. `None` si el PNG no se puede
/// leer: el icono sale sin inicial, pero sale.
fn atlas() -> Option<&'static (usize, Vec<u8>)> {
    static ATLAS: std::sync::OnceLock<Option<(usize, Vec<u8>)>> = std::sync::OnceLock::new();
    ATLAS
        .get_or_init(|| match decodificar_atlas() {
            Ok(a) => Some(a),
            Err(e) => {
                tracing::warn!(error = %e, "atlas de iniciales ilegible: iconos sin inicial");
                None
            }
        })
        .as_ref()
}

/// Ancho y alfa (un byte por píxel) del atlas.
fn decodificar_atlas() -> Result<(usize, Vec<u8>), String> {
    let mut dec = png::Decoder::new(ATLAS_PNG);
    dec.set_transformations(png::Transformations::EXPAND);
    let mut reader = dec.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    if info.color_type != png::ColorType::Rgba || info.height as usize != ICON_SIZE {
        return Err(format!(
            "formato inesperado: {:?} {}x{}",
            info.color_type, info.width, info.height
        ));
    }
    let alfa = buf[..info.buffer_size()]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|p| p[3])
        .collect();
    Ok((info.width as usize, alfa))
}

/// Cobertura (0..1) de la inicial en el píxel (x, y); 0 si no está en el atlas.
fn cobertura_inicial(inicial: char, x: usize, y: usize) -> f32 {
    let Some((ancho, alfa)) = atlas() else {
        return 0.0;
    };
    let c = inicial.to_ascii_uppercase();
    let idx = ATLAS_CHARS
        .find(c)
        .or_else(|| ATLAS_CHARS.find('S'))
        .unwrap_or(0);
    let col = idx * ICON_SIZE + x;
    if col >= *ancho {
        return 0.0;
    }
    f32::from(alfa[y * ancho + col]) / 255.0
}

/// Fracción del píxel (x, y) que cubren el disco y el aro, por supermuestreo.
fn cobertura_disco(x: usize, y: usize) -> (f32, f32) {
    let c = ICON_SIZE as f32 / 2.0;
    let total = (SS * SS) as f32;
    let (mut disco, mut aro) = (0.0_f32, 0.0_f32);
    for sy in 0..SS {
        for sx in 0..SS {
            let dx = x as f32 + (sx as f32 + 0.5) / SS as f32 - c;
            let dy = y as f32 + (sy as f32 + 0.5) / SS as f32 - c;
            let d = (dx * dx + dy * dy).sqrt();
            if d > c {
                continue;
            }
            disco += 1.0;
            let ang = dy.atan2(dx).to_degrees().rem_euclid(360.0);
            if d >= c - RING_WIDTH && !(ang > RING_GAP.0 && ang < RING_GAP.1) {
                aro += 1.0;
            }
        }
    }
    (disco / total, aro / total)
}

/// Icono RGBA de `ICON_SIZE`×`ICON_SIZE`: disco negro a sangre con un aro
/// abierto de color `aro` en el borde y la inicial blanca en el centro, como
/// el logo de los accesos directos (`logos-anillo.ps1`).
pub fn icono(inicial: char, aro: [u8; 3]) -> Vec<u8> {
    let mut px = Vec::with_capacity(ICON_SIZE * ICON_SIZE * 4);
    for y in 0..ICON_SIZE {
        for x in 0..ICON_SIZE {
            let (disco, anillo) = cobertura_disco(x, y);
            if disco == 0.0 {
                px.extend_from_slice(&[0, 0, 0, 0]);
                continue;
            }
            let k = anillo / disco;
            let t = cobertura_inicial(inicial, x, y);
            // Aro sobre el negro del disco según lo que cubre; la inicial encima.
            let mezcla = |i: usize| {
                let fondo = f32::from(DISCO[i]) * (1.0 - k) + f32::from(aro[i]) * k;
                (fondo * (1.0 - t) + f32::from(LETRA[i]) * t).round() as u8
            };
            px.extend_from_slice(&[
                mezcla(0),
                mezcla(1),
                mezcla(2),
                (disco * 255.0).round() as u8,
            ]);
        }
    }
    px
}

/// Pone el icono, fija el AppUserModelID en el hilo de la UI y muestra la
/// ventana (se crea oculta para que Windows le dé su propio botón).
pub fn decorar_y_mostrar(app: &AppHandle, window: &WebviewWindow, look: Aspecto) {
    let img = tauri::image::Image::new_owned(look.rgba, ICON_SIZE as u32, ICON_SIZE as u32);
    if let Err(e) = window.set_icon(img) {
        tracing::warn!(error = %e, "no se pudo poner el icono de la ventana de Sessions");
    }
    let w = window.clone();
    let aumid = look.aumid;
    let r = app.run_on_main_thread(move || {
        fijar_aumid(&w, &aumid);
        mostrar(&w);
    });
    if let Err(e) = r {
        tracing::warn!(error = %e, "sin hilo de UI para el AUMID: se muestra igual");
        mostrar(window);
    }
}

fn mostrar(w: &WebviewWindow) {
    if let Err(e) = w.show().and_then(|()| w.set_focus()) {
        tracing::warn!(error = %e, "no se pudo mostrar la ventana de Sessions");
    }
}

#[cfg(windows)]
fn fijar_aumid(w: &WebviewWindow, aumid: &str) {
    let r = w
        .hwnd()
        .map_err(|e| e.to_string())
        .and_then(|h| nativo::set_window_aumid(h.0, aumid));
    if let Err(e) = r {
        tracing::warn!(error = %e, "no se pudo fijar el AppUserModelID de la ventana");
    }
}

#[cfg(not(windows))]
fn fijar_aumid(_w: &WebviewWindow, _aumid: &str) {}

#[cfg(windows)]
mod nativo {
    use std::ffi::c_void;

    #[repr(C)]
    struct Guid(u32, u16, u16, [u8; 8]);

    #[repr(C)]
    struct PropertyKey {
        fmtid: Guid,
        pid: u32,
    }

    /// `PROPVARIANT` con `VT_LPWSTR` (24 bytes en x64, 16 en x86).
    #[repr(C)]
    struct PropVariant {
        vt: u16,
        reserved: [u16; 3],
        pwsz: *const u16,
        pad: usize,
    }

    #[repr(C)]
    struct PropertyStoreVtbl {
        query_interface: usize,
        add_ref: usize,
        release: unsafe extern "system" fn(*mut c_void) -> u32,
        get_count: usize,
        get_at: usize,
        get_value: usize,
        set_value:
            unsafe extern "system" fn(*mut c_void, *const PropertyKey, *const PropVariant) -> i32,
        commit: unsafe extern "system" fn(*mut c_void) -> i32,
    }

    const IID_IPROPERTYSTORE: Guid = Guid(
        0x886D_8EEB,
        0x8CF2,
        0x4446,
        [0x8D, 0x02, 0xCD, 0xBA, 0x1D, 0xBD, 0xCF, 0x99],
    );
    const PKEY_APPUSERMODEL_ID: PropertyKey = PropertyKey {
        fmtid: Guid(
            0x9F4C_2855,
            0x9F79,
            0x4B39,
            [0xA8, 0xD0, 0xE1, 0xD4, 0x2D, 0xE1, 0xD5, 0xF3],
        ),
        pid: 5,
    };
    const VT_LPWSTR: u16 = 31;

    #[link(name = "shell32")]
    extern "system" {
        fn SHGetPropertyStoreForWindow(
            hwnd: *mut c_void,
            riid: *const Guid,
            ppv: *mut *mut c_void,
        ) -> i32;
    }

    fn hr(code: i32, what: &str) -> Result<(), String> {
        if code < 0 {
            Err(format!("{what} falló (HRESULT 0x{code:08X})"))
        } else {
            Ok(())
        }
    }

    /// Fija `PKEY_AppUserModel_ID` en el almacén de propiedades de la ventana.
    pub fn set_window_aumid(hwnd: *mut c_void, aumid: &str) -> Result<(), String> {
        let wide: Vec<u16> = aumid.encode_utf16().chain(std::iter::once(0)).collect();
        let mut store: *mut c_void = std::ptr::null_mut();
        // SAFETY: `hwnd` es una ventana viva del hilo de la UI y `store` recibe
        // una interfaz COM que se libera abajo.
        hr(
            unsafe { SHGetPropertyStoreForWindow(hwnd, &IID_IPROPERTYSTORE, &mut store) },
            "SHGetPropertyStoreForWindow",
        )?;
        if store.is_null() {
            return Err("SHGetPropertyStoreForWindow sin almacén".into());
        }
        let value = PropVariant {
            vt: VT_LPWSTR,
            reserved: [0; 3],
            pwsz: wide.as_ptr(),
            pad: 0,
        };
        // SAFETY: el primer campo de una interfaz COM es su vtable; el almacén
        // copia el valor en `SetValue` y `wide` vive hasta el final.
        unsafe {
            let vtbl = &**(store as *const *const PropertyStoreVtbl);
            let set = hr(
                (vtbl.set_value)(store, &PKEY_APPUSERMODEL_ID, &value),
                "IPropertyStore::SetValue",
            );
            let commit = set.and_then(|()| hr((vtbl.commit)(store), "IPropertyStore::Commit"));
            (vtbl.release)(store);
            commit
        }
    }
}
