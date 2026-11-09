// Mascota — juegos: tabla de ejecutables con su disfraz y «no molestar».
//
// Lógica pura (con tests): desk_watch.rs le da el ejecutable y la geometría
// de la ventana en primer plano y aquí se decide si es un juego conocido
// (disfraz), si Pupus tiene que callarse y si el juego le quita el suelo.
// Cero tokens: solo Win32 y el fichero de ajustes.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Disfraces que sabe pintar la webview (gameOutfits.ts / accessories.ts).
pub const OUTFITS: [&str; 4] = ["car", "pirate", "tactical", "none"];

/// Tope de entradas de la tabla (se edita a mano en Settings).
pub const MAX_GAMES: usize = 64;

/// Silencio que aguanta tras dejar de ver el juego (Alt+Tab rápido a otra
/// ventana): Pupus no se despierta por un vistazo a Discord.
pub const QUIET_HOLD: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameEntry {
    /// Nombre del ejecutable, en minúsculas y sin ruta («cs2.exe»).
    pub exe: String,
    /// Nombre legible para Settings.
    pub name: String,
    /// Uno de OUTFITS.
    pub outfit: String,
}

fn entry(exe: &str, name: &str, outfit: &str) -> GameEntry {
    GameEntry {
        exe: exe.into(),
        name: name.into(),
        outfit: outfit.into(),
    }
}

pub fn default_games() -> Vec<GameEntry> {
    vec![
        entry("rocketleague.exe", "Rocket League", "car"),
        entry("sotgame.exe", "Sea of Thieves", "pirate"),
        entry("cs2.exe", "Counter-Strike 2", "tactical"),
    ]
}

/// Limpia la tabla que llega de Settings o del JSON: ejecutable en
/// minúsculas, sin ruta y acabado en .exe, disfraz conocido, sin duplicados
/// y con tope (mismo criterio que normalizeGames en settings.ts).
pub fn normalize_games(list: Vec<GameEntry>) -> Vec<GameEntry> {
    let mut out: Vec<GameEntry> = Vec::new();
    for g in list {
        let exe = g.exe.trim().to_lowercase();
        if !exe.ends_with(".exe") || exe.contains(['\\', '/']) {
            continue;
        }
        if out.iter().any(|o| o.exe == exe) {
            continue;
        }
        let outfit = if OUTFITS.contains(&g.outfit.as_str()) {
            g.outfit
        } else {
            "none".into()
        };
        let name = g.name.trim().to_string();
        out.push(GameEntry { exe, name, outfit });
        if out.len() >= MAX_GAMES {
            break;
        }
    }
    out
}

/// Por qué Pupus se calla.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuietReason {
    /// Un juego de la tabla (aunque vaya en ventana).
    Game,
    /// SHQueryUserNotificationState = QUNS_RUNNING_D3D_FULL_SCREEN.
    ExclusiveFullscreen,
    /// Ventana sin bordes que tapa su monitor (juego desconocido o vídeo).
    Borderless,
}

/// QUNS_RUNNING_D3D_FULL_SCREEN.
pub const QUNS_D3D_FULLSCREEN: u32 = 3;

/// Juego conocido (con su disfraz) y motivo de silencio, si lo hay.
pub fn classify(
    exe: &str,
    covers_monitor: bool,
    has_caption: bool,
    quns: u32,
    games: &[GameEntry],
) -> (Option<GameEntry>, Option<QuietReason>) {
    let exe = exe.trim().to_lowercase();
    if let Some(g) = games.iter().find(|g| !exe.is_empty() && g.exe == exe) {
        return (Some(g.clone()), Some(QuietReason::Game));
    }
    if quns == QUNS_D3D_FULLSCREEN {
        return (None, Some(QuietReason::ExclusiveFullscreen));
    }
    if covers_monitor && !has_caption {
        return (None, Some(QuietReason::Borderless));
    }
    (None, None)
}

/// Silencio con histéresis: entra al instante y sale tras QUIET_HOLD sin
/// silencio.
#[derive(Debug, Default)]
pub struct QuietLatch {
    since_off: Option<Instant>,
    on: bool,
}

impl QuietLatch {
    pub fn update(&mut self, raw: bool, now: Instant) -> bool {
        if raw {
            self.on = true;
            self.since_off = None;
            return true;
        }
        if !self.on {
            return false;
        }
        let since = *self.since_off.get_or_insert(now);
        if now.duration_since(since) >= QUIET_HOLD {
            self.on = false;
            self.since_off = None;
        }
        self.on
    }
}

/// ¿El juego (en ventana) deja menos de `min_free_px` de suelo libre a
/// izquierda y a derecha en el área de trabajo `work`? Rectángulos
/// (left, top, right, bottom) en píxeles físicos.
pub fn blocks_floor(
    game: (i32, i32, i32, i32),
    work: (i32, i32, i32, i32),
    min_free_px: i32,
) -> bool {
    let overlaps = game.0 < work.2 && game.2 > work.0 && game.1 < work.3 && game.3 > work.1;
    if !overlaps {
        return false;
    }
    let left_free = (game.0 - work.0).max(0);
    let right_free = (work.2 - game.2).max(0);
    left_free.max(right_free) < min_free_px
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clasifica_por_exe_sin_importar_mayusculas() {
        let (g, q) = classify("RocketLeague.exe", false, true, 5, &default_games());
        assert_eq!(g.unwrap().outfit, "car");
        assert_eq!(q, Some(QuietReason::Game));
    }

    #[test]
    fn pantalla_completa_desconocida_es_silencio_sin_disfraz() {
        let (g, q) = classify("vlc.exe", true, false, 5, &default_games());
        assert!(g.is_none());
        assert_eq!(q, Some(QuietReason::Borderless));
    }

    #[test]
    fn ventana_maximizada_con_titulo_no_es_juego() {
        assert_eq!(
            classify("code.exe", false, true, 5, &default_games()),
            (None, None)
        );
        // Tapa el monitor pero con barra de título: tampoco.
        assert_eq!(
            classify("code.exe", true, true, 5, &default_games()),
            (None, None)
        );
    }

    #[test]
    fn quns_3_es_silencio() {
        let (g, q) = classify("unknown.exe", false, true, 3, &default_games());
        assert!(g.is_none());
        assert_eq!(q, Some(QuietReason::ExclusiveFullscreen));
    }

    #[test]
    fn outfit_desconocido_pasa_a_none() {
        let n = normalize_games(vec![entry(" Foo.EXE ", " Foo ", "astronauta")]);
        assert_eq!(n, vec![entry("foo.exe", "Foo", "none")]);
    }

    #[test]
    fn exe_con_ruta_se_descarta() {
        let n = normalize_games(vec![
            entry("C:\\Games\\x.exe", "X", "car"),
            entry("bin/y.exe", "Y", "car"),
            entry("  ", "vacío", "car"),
            entry("juego", "sin extensión", "car"),
            entry("ok.exe", "Ok", "pirate"),
            entry("OK.exe", "duplicado", "car"),
        ]);
        assert_eq!(n, vec![entry("ok.exe", "Ok", "pirate")]);
    }

    #[test]
    fn la_tabla_tiene_tope() {
        let many = (0..100)
            .map(|i| entry(&format!("g{i}.exe"), "", "none"))
            .collect();
        assert_eq!(normalize_games(many).len(), MAX_GAMES);
    }

    #[test]
    fn el_silencio_aguanta_3_s_tras_alt_tab() {
        let t0 = Instant::now();
        let mut l = QuietLatch::default();
        assert!(l.update(true, t0));
        assert!(l.update(false, t0 + Duration::from_millis(500)));
        assert!(l.update(false, t0 + Duration::from_millis(3400)));
        // Vuelve al juego antes de los 3 s: el contador se reinicia.
        assert!(l.update(true, t0 + Duration::from_millis(3450)));
        assert!(l.update(false, t0 + Duration::from_millis(4000)));
        assert!(l.update(false, t0 + Duration::from_millis(6900)));
    }

    #[test]
    fn sale_a_los_3_s() {
        let t0 = Instant::now();
        let mut l = QuietLatch::default();
        assert!(!l.update(false, t0), "sin silencio previo no entra");
        assert!(l.update(true, t0));
        assert!(l.update(false, t0 + Duration::from_secs(1)));
        assert!(!l.update(false, t0 + Duration::from_millis(4100)));
    }

    #[test]
    fn json_sin_games_trae_la_tabla_por_defecto() {
        let s: crate::mascot::MascotSettings = serde_json::from_str(r#"{"scale":5}"#).unwrap();
        assert_eq!(s.games, default_games());
        assert!(s.game_mode);
    }

    #[test]
    fn lista_vacia_se_respeta() {
        let s: crate::mascot::MascotSettings =
            serde_json::from_str(r#"{"games":[],"game_mode":false}"#).unwrap();
        let s = s.normalized();
        assert!(s.games.is_empty());
        assert!(!s.game_mode);
    }

    #[test]
    fn un_juego_ancho_quita_el_suelo_y_uno_estrecho_no() {
        let work = (0, 0, 2560, 1392);
        let wide = (280, 100, 2280, 1200);
        assert!(blocks_floor(wide, work, 400));
        let narrow = (880, 100, 1680, 700);
        assert!(!blocks_floor(narrow, work, 400));
        // En otro monitor: no toca este suelo.
        assert!(!blocks_floor((2600, 0, 4400, 1000), work, 400));
    }
}
