// Mascota — soltar ficheros encima de Pupus.
//
// La ventana de la mascota tapa el monitor entero y casi siempre deja pasar
// el ratón (WS_EX_TRANSPARENT); la webview la vuelve interactiva cuando ve el
// cursor encima de Pupus. Durante un arrastre OLE desde el Explorador eso no
// llegaba a ocurrir: Windows entregaba el fichero a la ventana de debajo (el
// Control Center, que lo rechaza: cursor de prohibido) y el drop no llegaba
// nunca a la mascota.
//
// Este hilo no depende de la webview: con el rectángulo de Pupus que ella
// publica (`mascot_pet_rect`, px físicos), si el botón izquierdo se pulsó
// FUERA de Pupus (se está arrastrando otra cosa) y el cursor entra en el
// rectángulo con el botón aún pulsado, la ventana deja de ser atravesable
// para que OLE la elija como destino. Al soltar (con margen para que OLE
// entregue el Drop) o al salir del rectángulo vuelve a serlo, y se avisa a la
// webview (`mascot:passthrough`) para que recalcule su propio estado. Todo
// pasa por tao (`set_ignore_cursor_events`) para no desincronizar sus flags.
// Cero tokens: GetCursorPos/GetAsyncKeyState cada 25 ms.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use super::win;

const TICK: Duration = Duration::from_millis(25);
const IDLE_TICK: Duration = Duration::from_millis(250);
/// Tras soltar el botón, la ventana sigue siendo destino este tiempo: OLE
/// entrega el Drop al destino que ya tenía, pero sin prisa por quitárselo.
const RELEASE_GRACE: Duration = Duration::from_millis(300);

/// Rectángulo de Pupus en px físicos de pantalla (left, top, right, bottom).
pub type PetRect = (i32, i32, i32, i32);

static PET_RECT: Mutex<Option<PetRect>> = Mutex::new(None);

fn inside(r: PetRect, x: i32, y: i32) -> bool {
    x >= r.0 && x <= r.2 && y >= r.1 && y <= r.3
}

/// Qué hacer con la ventana en este paso.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Paso {
    Nada,
    /// Volverla interactiva: hay un arrastre que entra en Pupus.
    Abrir,
    /// Devolverla a atravesable: el arrastre acabó o salió de Pupus.
    Cerrar,
}

/// Lógica pura del asistente (tests abajo).
#[derive(Debug, Default)]
pub struct Asistente {
    prev_down: bool,
    /// La pulsación en curso empezó fuera de Pupus (no es cogerlo a él).
    pulsado_fuera: bool,
    forzado: bool,
    soltado_en: Option<Instant>,
}

impl Asistente {
    /// `down`: botón izquierdo pulsado; `dentro`: cursor en el rectángulo de
    /// Pupus (false si no hay rectángulo); `atravesable`: la ventana deja
    /// pasar el ratón ahora mismo.
    pub fn paso(&mut self, down: bool, dentro: bool, atravesable: bool, ahora: Instant) -> Paso {
        if down && !self.prev_down {
            self.pulsado_fuera = !dentro;
        }
        self.prev_down = down;
        if !self.forzado {
            if down && self.pulsado_fuera && dentro && atravesable {
                self.forzado = true;
                self.soltado_en = None;
                return Paso::Abrir;
            }
            return Paso::Nada;
        }
        if down {
            self.soltado_en = None;
            if dentro {
                return Paso::Nada;
            }
        } else {
            let desde = *self.soltado_en.get_or_insert(ahora);
            if ahora.duration_since(desde) < RELEASE_GRACE {
                return Paso::Nada;
            }
        }
        self.soltar()
    }

    /// Deja de forzar (también si la ventana se oculta). Conserva el estado
    /// del botón: volver a entrar sin soltar sigue siendo el mismo arrastre.
    pub fn soltar(&mut self) -> Paso {
        let estaba = self.forzado;
        self.forzado = false;
        self.soltado_en = None;
        if estaba {
            Paso::Cerrar
        } else {
            Paso::Nada
        }
    }
}

/// La webview publica dónde está Pupus (px físicos) o `None` si no se le
/// puede soltar nada (oculto, en silencio de juego, conducido por el MCP).
#[tauri::command]
pub async fn mascot_pet_rect(rect: Option<PetRect>) {
    if let Ok(mut r) = PET_RECT.lock() {
        *r = rect.filter(|r| r.2 > r.0 && r.3 > r.1);
    }
}

fn pet_rect() -> Option<PetRect> {
    PET_RECT.lock().ok().and_then(|r| *r)
}

fn aplicar(app: &AppHandle, paso: Paso) {
    let Some(w) = app.get_webview_window(super::LABEL) else {
        return;
    };
    match paso {
        Paso::Abrir => {
            if let Err(e) = w.set_ignore_cursor_events(false) {
                tracing::warn!(error = %e, "mascota: no se pudo abrir la ventana al arrastre");
            }
        }
        Paso::Cerrar => {
            if let Err(e) = w.set_ignore_cursor_events(true) {
                tracing::warn!(error = %e, "mascota: no se pudo devolver la ventana a atravesable");
            }
            let _ = app.emit_to(super::LABEL, "mascot:passthrough", ());
        }
        Paso::Nada => {}
    }
}

/// Arranca el hilo (una vez, en `mascot::init`).
pub fn start(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("mascota-drop".into())
        .spawn(move || {
            let mut a = Asistente::default();
            loop {
                let hwnd = super::mascot_hwnd();
                if hwnd == 0 || !win::is_visible(hwnd) {
                    // Si se oculta a mitad de un arrastre forzado, que vuelva
                    // a ser atravesable al reaparecer.
                    aplicar(&app, a.soltar());
                    std::thread::sleep(IDLE_TICK);
                    continue;
                }
                let Some(c) = win::cursor_state() else {
                    std::thread::sleep(IDLE_TICK);
                    continue;
                };
                let dentro = pet_rect().is_some_and(|r| inside(r, c.x, c.y));
                let paso = a.paso(c.lbutton, dentro, win::ignores_cursor(hwnd), Instant::now());
                aplicar(&app, paso);
                std::thread::sleep(TICK);
            }
        });
    if let Err(e) = spawned {
        tracing::error!(error = %e, "mascota: no arrancó el hilo de soltar ficheros");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn un_arrastre_desde_fuera_que_entra_en_pupus_abre_y_al_soltar_cierra_con_margen() {
        let mut a = Asistente::default();
        let t = t0();
        assert_eq!(a.paso(true, false, true, t), Paso::Nada); // pulsa en el Explorador
        assert_eq!(a.paso(true, true, true, t), Paso::Abrir); // entra en Pupus
        assert_eq!(a.paso(true, true, false, t), Paso::Nada); // sigue encima
        assert_eq!(a.paso(false, true, false, t), Paso::Nada); // suelta: margen para el Drop
        assert_eq!(
            a.paso(false, true, false, t + Duration::from_millis(100)),
            Paso::Nada
        );
        assert_eq!(a.paso(false, true, false, t + RELEASE_GRACE), Paso::Cerrar);
        assert_eq!(a.paso(false, true, true, t + RELEASE_GRACE * 2), Paso::Nada);
    }

    #[test]
    fn salir_de_pupus_con_el_boton_pulsado_cierra_al_momento() {
        let mut a = Asistente::default();
        let t = t0();
        a.paso(true, false, true, t);
        assert_eq!(a.paso(true, true, true, t), Paso::Abrir);
        assert_eq!(a.paso(true, false, false, t), Paso::Cerrar);
        // Vuelve a entrar sin soltar: otra vez destino.
        assert_eq!(a.paso(true, true, true, t), Paso::Abrir);
    }

    #[test]
    fn caso_negativo_coger_a_pupus_o_pasar_sin_boton_no_hace_nada() {
        let mut a = Asistente::default();
        let t = t0();
        // Pulsar encima de Pupus es cogerlo: eso lo lleva la webview.
        assert_eq!(a.paso(true, true, true, t), Paso::Nada);
        assert_eq!(a.paso(true, true, true, t), Paso::Nada);
        assert_eq!(a.paso(false, true, true, t), Paso::Nada);
        // Pasar por encima sin botón tampoco (el hover normal es de la webview).
        assert_eq!(a.paso(false, true, true, t), Paso::Nada);
    }

    #[test]
    fn caso_negativo_si_la_webview_ya_la_hizo_interactiva_no_la_toca() {
        let mut a = Asistente::default();
        let t = t0();
        a.paso(true, false, true, t);
        assert_eq!(a.paso(true, true, false, t), Paso::Nada);
        assert_eq!(a.paso(false, true, false, t + RELEASE_GRACE), Paso::Nada);
    }

    #[test]
    fn ocultarse_a_mitad_de_un_arrastre_forzado_la_devuelve_a_atravesable() {
        let mut a = Asistente::default();
        let t = t0();
        a.paso(true, false, true, t);
        assert_eq!(a.paso(true, true, true, t), Paso::Abrir);
        assert_eq!(a.soltar(), Paso::Cerrar);
        assert_eq!(a.soltar(), Paso::Nada);
    }

    #[test]
    fn el_borde_del_rectangulo_cuenta_como_dentro() {
        assert!(inside((0, 0, 10, 10), 10, 0));
        assert!(!inside((0, 0, 10, 10), 11, 5));
    }
}
