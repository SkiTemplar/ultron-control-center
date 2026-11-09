// Mascota — cuánto dura el «modo conducción» del MCP de escritorio.
//
// Cada acción que mueve el ratón (move, click, drag, scroll, type, key)
// empieza o prolonga la conducción; la mascota suelta el cursor cuando pasa
// `LINGER` sin actividad. Entre dos acciones el agente suele capturar la
// pantalla y pensar unos segundos: si la conducción terminara a mitad, la
// mascota caería al suelo y volvería a subir volando en la acción siguiente
// (efecto yoyó). Por eso las consultas (screenshot, cursor, windows)
// también la prolongan, pero solo si ya estaba en marcha: una captura
// suelta no hace volar a Pupus.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::LABEL;

/// Espera sin actividad antes de soltar el cursor.
pub const LINGER: Duration = Duration::from_millis(6000);

/// Estado puro (sin hilos ni Tauri) para poder probarlo.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DriveClock {
    gen: u64,
    active: bool,
}

impl DriveClock {
    pub const fn new() -> Self {
        Self {
            gen: 0,
            active: false,
        }
    }

    /// Acción con el ratón o el teclado: empieza o prolonga la conducción.
    pub fn begin(&mut self) -> u64 {
        self.gen += 1;
        self.active = true;
        self.gen
    }

    /// Consulta del agente: prolonga solo si ya se está conduciendo.
    pub fn renew(&mut self) -> Option<u64> {
        if !self.active {
            return None;
        }
        self.gen += 1;
        Some(self.gen)
    }

    /// Venció la espera programada para `gen`. Devuelve true si la
    /// conducción termina (nadie la renovó entre medias).
    pub fn expire(&mut self, gen: u64) -> bool {
        if !self.active || self.gen != gen {
            return false;
        }
        self.active = false;
        true
    }

    pub fn current(&self) -> u64 {
        self.gen
    }
}

static CLOCK: Mutex<DriveClock> = Mutex::new(DriveClock::new());

fn with_clock<T>(f: impl FnOnce(&mut DriveClock) -> T) -> T {
    let mut c = CLOCK.lock().unwrap_or_else(|p| p.into_inner());
    f(&mut c)
}

pub fn begin() -> u64 {
    with_clock(DriveClock::begin)
}

pub fn current() -> u64 {
    with_clock(|c| c.current())
}

/// Programa el final de la conducción para la generación `gen`.
pub fn schedule_end(app: &AppHandle, gen: u64) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(LINGER);
        if with_clock(|c| c.expire(gen)) {
            let _ = app.emit_to(LABEL, "mascot:drive", json!({"phase": "end"}));
        }
    });
}

/// Una consulta del agente (captura, cursor, ventanas) mientras conduce.
pub fn keep_alive(app: &AppHandle) {
    if let Some(gen) = with_clock(DriveClock::renew) {
        schedule_end(app, gen);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_espera_de_la_ultima_accion_termina_la_conduccion() {
        let mut c = DriveClock::new();
        let a = c.begin();
        let b = c.begin();
        assert!(!c.expire(a), "una espera vieja no corta una acción nueva");
        assert!(c.expire(b));
        assert!(!c.expire(b), "solo termina una vez");
    }

    #[test]
    fn una_captura_entre_acciones_prolonga_la_conduccion() {
        let mut c = DriveClock::new();
        let a = c.begin();
        let look = c.renew().expect("conduciendo: la captura prolonga");
        assert!(!c.expire(a), "la espera de la acción ya no vale");
        assert!(c.expire(look));
    }

    #[test]
    fn una_captura_suelta_no_empieza_a_conducir() {
        let mut c = DriveClock::new();
        assert_eq!(c.renew(), None);
        let a = c.begin();
        assert!(c.expire(a));
        assert_eq!(c.renew(), None, "tras terminar, otra captura tampoco");
    }
}
