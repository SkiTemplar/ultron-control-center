// Mascota — superficies de dentro de las ventanas de Sessions por las que
// se mueve Pupus (useDesktopWindows.ts).
//
// Por cada ventana de Sessions visible y sin minimizar devuelve su HWND (el
// mismo `id` que da `mascot_windows`, para cruzarla con el orden Z que ya
// tiene la webview) y el rectángulo del cuadro de texto del chat en px
// físicos, sacado del informe de la columna (sesiones/barra_lateral.rs). La
// webview convierte el borde superior del cuadro en una plataforma y los
// laterales de la ventana en paredes por las que trepar; si otra ventana la
// tapa, la plataforma pierde ese tramo igual que el borde de cualquier
// ventana (world.ts). Solo lectura y cero tokens.

use serde::Serialize;
use tauri::AppHandle;

use super::sessions_windows::{candidatos, Cand};
use crate::sesiones::barra_lateral::{a_fisico, PhysRect};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsSurface {
    /// HWND de la ventana de Sessions.
    pub hwnd: u64,
    /// Cuadro de texto del chat (px físicos), si se ve.
    pub composer: Option<PhysRect>,
}

/// Superficies de las ventanas de Sessions que se ven. Pura (tests abajo).
pub fn superficies(cands: &[Cand]) -> Vec<SessionsSurface> {
    cands
        .iter()
        .filter(|c| c.visible && !c.minimized && c.hwnd != 0)
        .map(|c| SessionsSurface {
            hwnd: c.hwnd,
            composer: c.report.as_ref().and_then(|r| {
                r.composer
                    .as_ref()
                    .map(|comp| a_fisico(c.inner, r.dpr, comp))
            }),
        })
        .collect()
}

/// `mascot_sessions_surfaces`: ventanas de Sessions y su cuadro de texto.
#[tauri::command]
pub async fn mascot_sessions_surfaces(app: AppHandle) -> Vec<SessionsSurface> {
    superficies(&candidatos(&app))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sesiones::barra_lateral::{CssRect, RailReport};

    fn cand(hwnd: u64, visible: bool, minimized: bool, composer: Option<CssRect>) -> Cand {
        Cand {
            label: "sesiones".into(),
            hwnd,
            visible,
            minimized,
            inner: (100, 50),
            report: Some(RailReport {
                dpr: 1.5,
                rail: None,
                items: vec![],
                composer,
            }),
        }
    }

    fn comp() -> CssRect {
        CssRect {
            x: 300.0,
            y: 600.0,
            w: 400.0,
            h: 80.0,
        }
    }

    #[test]
    fn el_composer_sale_en_px_fisicos() {
        let out = superficies(&[cand(7, true, false, Some(comp()))]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].hwnd, 7);
        let c = out[0].composer.expect("composer");
        assert_eq!(
            (c.left, c.top, c.right, c.bottom),
            (550, 950, 1150, 1070),
            "esquina del área cliente + px CSS × dpr"
        );
    }

    #[test]
    fn minimizada_oculta_o_sin_hwnd_no_cuenta() {
        let cands = [
            cand(1, true, true, Some(comp())),
            cand(2, false, false, Some(comp())),
            cand(0, true, false, Some(comp())),
        ];
        assert!(superficies(&cands).is_empty());
    }

    #[test]
    fn sin_informe_o_sin_composer_va_la_ventana_sola() {
        let mut sin_informe = cand(3, true, false, None);
        sin_informe.report = None;
        let out = superficies(&[sin_informe, cand(4, true, false, None)]);
        assert_eq!(out.iter().map(|s| s.hwnd).collect::<Vec<_>>(), vec![3, 4]);
        assert!(out.iter().all(|s| s.composer.is_none()));
    }

    #[test]
    fn el_json_va_en_camel_case() {
        let v = serde_json::to_value(SessionsSurface {
            hwnd: 9,
            composer: None,
        })
        .unwrap();
        assert_eq!(v["hwnd"], 9);
        assert!(v["composer"].is_null());
    }
}
