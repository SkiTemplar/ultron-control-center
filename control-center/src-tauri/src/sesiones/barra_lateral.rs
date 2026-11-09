// sesiones/barra_lateral.rs — Dónde está, en pantalla, cada sesión de la
// columna izquierda de Sessions.
//
// La webview de Sessions informa (`sesiones_rail_report`) de los
// rectángulos de su columna y de cada fila de sesión, en px CSS de su
// viewport, solo cuando cambia el layout (rail-rects.ts). Aquí se validan y
// se guardan por etiqueta de ventana. La mascota lee el cuadro de texto del
// chat (composer), lo pasa a px físicos con la posición del área cliente de
// la ventana y el `devicePixelRatio` informado y se sube a su borde superior
// (mascot/sessions_windows.rs, mascot/sessions_surfaces.rs). Las filas de
// sesión ya no las consume nadie desde que se retiró la coreografía del
// permiso (2026-10-28): Pupus pide el permiso en su propio chat.
//
// La etiqueta sale de la ventana que invoca, no del payload: una ventana no
// puede escribir el informe de otra. Coste: cero tokens; un `Mutex` y un
// `HashMap` con, como mucho, una entrada por ventana de Sessions.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use super::registro;

/// Rectángulo en px CSS del viewport de la webview.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Cuánto se ve de la fila dentro de la columna (que hace scroll).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Clip {
    Full,
    Partial,
    Above,
    Below,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RailItem {
    pub id: String,
    pub rect: CssRect,
    pub clip: Clip,
}

/// Informe de una ventana. `rail = None`: la columna no se ve (layout
/// estrecho); entonces no hay filas. `composer = None`: no hay cuadro de
/// texto a la vista (o el frontend es anterior a este campo).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RailReport {
    pub dpr: f64,
    pub rail: Option<CssRect>,
    pub items: Vec<RailItem>,
    #[serde(default)]
    pub composer: Option<CssRect>,
}

/// Rectángulo en píxeles físicos de pantalla.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PhysRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

const MAX_ITEMS: usize = 200;
const MAX_ID: usize = 64;
/// Cota de cualquier coordenada o medida (px CSS).
const MAX_ABS: f64 = 100_000.0;

fn rect_ok(r: &CssRect) -> bool {
    [r.x, r.y, r.w, r.h]
        .iter()
        .all(|v| v.is_finite() && v.abs() <= MAX_ABS)
}

fn id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// El informe llega de una webview: se valida como cualquier entrada.
pub fn validar(r: &RailReport) -> Result<(), String> {
    if !r.dpr.is_finite() || r.dpr <= 0.25 || r.dpr > 8.0 {
        return Err(format!("devicePixelRatio no válido: {}", r.dpr));
    }
    if r.items.len() > MAX_ITEMS {
        return Err(format!(
            "demasiadas filas: {} (máximo {MAX_ITEMS})",
            r.items.len()
        ));
    }
    if r.rail.as_ref().is_some_and(|rail| !rect_ok(rail)) {
        return Err("rectángulo de la columna no válido".into());
    }
    if r.composer
        .as_ref()
        .is_some_and(|c| !rect_ok(c) || c.w <= 0.0 || c.h <= 0.0)
    {
        return Err("rectángulo del cuadro de texto no válido".into());
    }
    if r.rail.is_none() && !r.items.is_empty() {
        return Err("hay filas sin columna visible".into());
    }
    for it in &r.items {
        if !id_ok(&it.id) {
            return Err(format!("id de sesión no válido: '{}'", it.id));
        }
        if !rect_ok(&it.rect) {
            return Err(format!("rectángulo no válido para la sesión {}", it.id));
        }
    }
    Ok(())
}

type Informes = Mutex<HashMap<String, RailReport>>;

fn informes() -> &'static Informes {
    static I: OnceLock<Informes> = OnceLock::new();
    I.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn guardar(label: &str, r: RailReport) {
    let mut m = informes().lock().unwrap_or_else(|p| p.into_inner());
    m.insert(label.to_string(), r);
}

/// La ventana se ha cerrado: su informe ya no vale.
pub fn olvidar(label: &str) {
    let mut m = informes().lock().unwrap_or_else(|p| p.into_inner());
    m.remove(label);
}

pub fn informe(label: &str) -> Option<RailReport> {
    let m = informes().lock().unwrap_or_else(|p| p.into_inner());
    m.get(label).cloned()
}

/// px CSS del viewport → px físicos de pantalla. `inner` = esquina del área
/// cliente de la ventana (px físicos).
pub fn a_fisico(inner: (i32, i32), dpr: f64, r: &CssRect) -> PhysRect {
    let px = |base: i32, v: f64| base + (v * dpr).round() as i32;
    PhysRect {
        left: px(inner.0, r.x),
        top: px(inner.1, r.y),
        right: px(inner.0, r.x + r.w),
        bottom: px(inner.1, r.y + r.h),
    }
}

/// `sesiones_rail_report`: la ventana que invoca publica su columna.
#[tauri::command]
pub async fn sesiones_rail_report(
    webview_window: tauri::WebviewWindow,
    report: RailReport,
) -> Result<(), String> {
    let label = webview_window.label();
    if !registro::is_sessions_window(label) {
        return Err(format!("la ventana '{label}' no es de Sessions"));
    }
    validar(&report)?;
    guardar(label, report);
    Ok(())
}

#[cfg(test)]
#[path = "tests_barra_lateral.rs"]
mod tests;
