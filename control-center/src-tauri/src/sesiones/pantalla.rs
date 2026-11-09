// sesiones/pantalla.rs — Pantalla emulada de la TUI de claude y su
// clasificación (contrato de estabilidad, §8.3 paso 3; `EST-01`,
// `seguridad-robustez:F2`, `M2`).
//
// Cada sesión tiene un `vt100::Parser` del tamaño del PTY que el lector
// alimenta de forma incremental (`Monitor::alimentar`). La clasificación mira
// la pantalla visible, no el búfer acumulado: un `❯` antiguo o un pie de
// diálogo ya cerrado no cuentan (`readiness()` sobre 256 KB decidía mal).
//
// Marcadores calibrados con los fixtures de `fixtures/tui/` (Claude Code
// 2.1.293, `tui: fullscreen`, mods de ULTRON cargados; ver
// `docs/sesiones/spikes-pty.md`):
// - prompt: caja de entrada entre dos reglas `─` a todo lo ancho, con el
//   glifo del prompt (`❯`, o `!` en modo shell) seguido de un espacio duro
//   (U+00A0) en su primera fila. El texto atenuado (SGR 2) de la caja es una
//   pista, no entrada.
// - busy: con la caja visible, una línea de spinner (`· Redactando…`,
//   `✻ Thinking…`) o `⎿ Running…` justo encima, o `esc to interrupt`.
// - dialog: sin caja y con un pie de diálogo (`Esc to cancel`, `Enter to
//   confirm`…) o el borde `▔` de los paneles a pantalla completa.
// - trust: `No, exit` con `trust this folder` (o `trust the files`,
//   `Yes, proceed`).
// - modo: indicador del pie (`bypass permissions on`, `manual mode on`…).
//
// Propiedad: WP-PTY.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use super::senales::EstadoPantalla;
use super::types::DialogOption;
use crate::pty::escritor::Vista;
use crate::pty::types::bloquear;

/// Evento a las ventanas cuando cambia el menú en pantalla (`{ id }`).
///
/// Sin oyente en el frontend a 2026-10-13: el bloque de menú del chat pinta
/// la TUI en un xterm enganchado al PTY y no lo necesita. Las opciones de la
/// clasificación tampoco viajan todavía en `WaitInfo.options` (la máquina las
/// deja en `None`), así que los botones de opciones del bloque solo aparecen
/// con el mock. Cablearlo es escuchar este evento y rellenar esas opciones.
pub const EV_SCREEN: &str = "sesiones://screen";
/// Silencio tras el último byte antes de clasificar.
pub const DEBOUNCE: Duration = Duration::from_millis(150);
/// Con salida continua, se clasifica como mucho cada este tiempo.
pub const MAX_LATENCIA: Duration = Duration::from_millis(250);
const SPINNER: &[char] = &['·', '✢', '✳', '✶', '✻', '✽', '*', '∗'];
const MAX_OPCIONES: usize = 50;
const MIN_REGLA: usize = 40;

/// Resultado de clasificar una pantalla.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Clasificacion {
    pub estado: EstadoPantalla,
    /// Modo de permisos del pie (`bypassPermissions`, `default`…), si se lee.
    pub modo: Option<String>,
    /// Texto de la caja de entrada; `None` si está vacía o no se ve.
    pub entrada: Option<String>,
    /// Opciones de `dialog` y `trust` con el cursor.
    pub opciones: Vec<DialogOption>,
    /// Línea del spinner con `busy` (cambia con el progreso).
    pub actividad: Option<String>,
    /// Con `busy`, la TUI pinta la pista «ctrl+b to run in background» de una
    /// tarea en primer plano (§3.4). Confirma el contexto de Ctrl+B; no es la
    /// única condición para mandarlo.
    pub pista_segundo_plano: bool,
}

impl Clasificacion {
    pub fn vista(&self) -> Vista {
        Vista {
            pantalla: self.estado,
            entrada: self.entrada.clone(),
        }
    }
}

/// Filas de la pantalla: texto completo y texto sin las celdas atenuadas.
struct Filas {
    todo: Vec<String>,
    sin_dim: Vec<String>,
}

fn filas_de(screen: &vt100::Screen) -> Filas {
    let (rows, cols) = screen.size();
    let mut todo = Vec::with_capacity(usize::from(rows));
    let mut sin_dim = Vec::with_capacity(usize::from(rows));
    for r in 0..rows {
        let celdas: Vec<&vt100::Cell> = (0..cols)
            .filter_map(|c| screen.cell(r, c))
            .filter(|cell| !cell.is_wide_continuation())
            .collect();
        let mut a = String::with_capacity(usize::from(cols));
        let mut b = String::with_capacity(usize::from(cols));
        for (i, cell) in celdas.iter().enumerate() {
            let txt = if cell.has_contents() {
                cell.contents()
            } else {
                " "
            };
            a.push_str(txt);
            if cell.dim() || cursor_sobre_pista(cell, &celdas[i + 1..]) {
                b.extend(std::iter::repeat_n(' ', txt.chars().count()));
            } else {
                b.push_str(txt);
            }
        }
        todo.push(a.trim_end().to_string());
        sin_dim.push(b.trim_end().to_string());
    }
    Filas { todo, sin_dim }
}

/// El cursor de la TUI sobre un placeholder (pista o sugerencia de prompt):
/// celda en inverso sin atenuar seguida solo de texto atenuado. La TUI pinta
/// así la primera letra del placeholder, que no es entrada.
fn cursor_sobre_pista(cell: &vt100::Cell, resto: &[&vt100::Cell]) -> bool {
    let con_texto = |c: &&&vt100::Cell| c.has_contents() && !c.contents().trim().is_empty();
    cell.inverse()
        && resto.iter().filter(con_texto).all(|c| c.dim())
        && resto.iter().any(|c| con_texto(&c) && c.dim())
}

/// Clasifica la pantalla visible de un `vt100::Parser`.
pub fn clasificar(screen: &vt100::Screen) -> Clasificacion {
    clasificar_filas(&filas_de(screen))
}

/// Función pura sobre el texto de pantalla (sin secuencias de escape ni
/// atributos: todo el texto cuenta como entrada).
#[allow(
    dead_code,
    reason = "interfaz pura del contrato (§8.3); la usan los tests"
)]
pub fn clasificar_texto(texto: &str) -> Clasificacion {
    let todo: Vec<String> = texto.lines().map(|l| l.trim_end().to_string()).collect();
    clasificar_filas(&Filas {
        sin_dim: todo.clone(),
        todo,
    })
}

fn clasificar_filas(f: &Filas) -> Clasificacion {
    if let Some((arriba, abajo)) = caja(&f.todo) {
        let actividad = spinner(&f.todo[..arriba]);
        let ocupada = actividad.is_some() || contiene(&f.todo, "esc to interrupt");
        return Clasificacion {
            estado: if ocupada {
                EstadoPantalla::Busy
            } else {
                EstadoPantalla::Prompt
            },
            modo: modo(&f.todo[abajo..]),
            entrada: entrada(&f.sin_dim[arriba + 1..abajo]),
            opciones: Vec::new(),
            actividad: if ocupada {
                actividad.or_else(|| Some("esc to interrupt".into()))
            } else {
                None
            },
            pista_segundo_plano: ocupada && pista_segundo_plano(&f.todo[..abajo]),
        };
    }
    let estado = if es_confianza(&f.todo) {
        EstadoPantalla::Trust
    } else if es_dialogo(&f.todo) {
        EstadoPantalla::Dialog
    } else {
        EstadoPantalla::Unknown
    };
    let opciones = if estado == EstadoPantalla::Unknown {
        Vec::new()
    } else {
        opciones(&f.todo)
    };
    Clasificacion {
        estado,
        opciones,
        ..Clasificacion::default()
    }
}

fn es_regla(linea: &str, c: char) -> bool {
    let t = linea.trim();
    t.chars().count() >= MIN_REGLA && t.chars().all(|x| x == c)
}

/// (fila de la regla superior, fila de la regla inferior) de la caja de
/// entrada: la pareja de reglas `─` más baja con el glifo del prompt debajo
/// de la primera.
fn caja(filas: &[String]) -> Option<(usize, usize)> {
    let reglas: Vec<usize> = (0..filas.len())
        .filter(|&i| es_regla(&filas[i], '─'))
        .collect();
    reglas.windows(2).rev().find_map(|w| {
        let (a, b) = (w[0], w[1]);
        (b > a + 1 && b - a <= MAX_FILAS_CAJA + 1 && es_linea_prompt(&filas[a + 1]))
            .then_some((a, b))
    })
}

/// Filas de texto de la caja de entrada que se reconocen: una caja que llega
/// a este tope puede venir recortada (G3 no la borra, `caja.rs`).
pub const MAX_FILAS_CAJA: usize = 11;

fn es_linea_prompt(l: &str) -> bool {
    let mut it = l.chars();
    match (it.next(), it.next()) {
        (Some(g), sig) => {
            !g.is_alphanumeric() && !g.is_whitespace() && sig.is_none_or(char::is_whitespace)
        }
        _ => false,
    }
}

/// Texto de la caja sin el glifo del prompt, las pistas atenuadas ni el panel
/// lateral de los mods (`izquierda`): si el panel se colara, la lectura
/// cambiaría sin que cambie la caja.
fn entrada(filas: &[String]) -> Option<String> {
    let lineas: Vec<String> = filas
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let l = izquierda(l);
            let s: String = if i == 0 {
                l.chars().skip(2).collect()
            } else {
                l.to_string()
            };
            s.trim().to_string()
        })
        .collect();
    let t = lineas.join("\n").trim().to_string();
    (!t.is_empty()).then_some(t)
}

/// Línea del spinner entre las últimas filas con contenido sobre la caja.
fn spinner(filas: &[String]) -> Option<String> {
    filas
        .iter()
        .rev()
        .map(|l| izquierda(l).trim())
        .filter(|t| !t.is_empty())
        .take(8)
        .find(|t| es_spinner(t))
        .map(str::to_string)
}

/// Parte de la fila antes del panel lateral de los mods (`│`).
fn izquierda(l: &str) -> &str {
    l.split('│').next().unwrap_or(l)
}

fn es_spinner(t: &str) -> bool {
    let mut it = t.chars();
    let primero = it.next();
    if primero == Some('⎿') {
        return t.contains("Running…");
    }
    primero.is_some_and(|c| SPINNER.contains(&c)) && it.next() == Some(' ') && t.contains('…')
}

/// Pista de Ctrl+B entre las últimas filas con contenido sobre el pie: la
/// zona del spinner, la herramienta en curso y la caja.
fn pista_segundo_plano(filas: &[String]) -> bool {
    filas
        .iter()
        .rev()
        .map(|l| izquierda(l).to_lowercase())
        .filter(|t| !t.trim().is_empty())
        .take(PISTA_FILAS)
        .any(|t| t.contains("to run in background") || t.contains("ctrl+b"))
}

/// Filas con contenido en las que se busca la pista de Ctrl+B.
const PISTA_FILAS: usize = 12;

fn contiene(filas: &[String], aguja: &str) -> bool {
    filas.iter().any(|l| l.to_lowercase().contains(aguja))
}

/// Modo de permisos del indicador del pie, en el nombre de `--permission-mode`.
fn modo(pie: &[String]) -> Option<String> {
    const MODOS: &[(&str, &str)] = &[
        ("bypass permissions on", "bypassPermissions"),
        ("accept edits on", "acceptEdits"),
        ("plan mode on", "plan"),
        ("auto mode on", "auto"),
        ("manual mode on", "default"),
        ("don't ask mode on", "dontAsk"),
        ("dontask mode on", "dontAsk"),
    ];
    let texto = pie.join("\n").to_lowercase();
    MODOS
        .iter()
        .find(|(m, _)| texto.contains(m))
        .map(|(_, id)| (*id).to_string())
}

fn es_confianza(filas: &[String]) -> bool {
    contiene(filas, "no, exit")
        && (contiene(filas, "trust this folder")
            || contiene(filas, "trust the files")
            || contiene(filas, "yes, proceed"))
}

fn es_dialogo(filas: &[String]) -> bool {
    const PIES: &[&str] = &[
        "enter to confirm",
        "esc to cancel",
        "esc to close",
        "esc to clear",
        "esc to go back",
        "esc to exit",
        "to navigate",
        "enter to select",
        "enter/space to change",
        "enter to set as default",
    ];
    PIES.iter().any(|p| contiene(filas, p)) || filas.iter().any(|l| es_regla(l, '▔'))
}

/// Opciones del bloque con el cursor `❯` de un diálogo.
fn opciones(filas: &[String]) -> Vec<DialogOption> {
    let Some((fila, col)) = cursor(filas) else {
        return Vec::new();
    };
    let mut desde = fila;
    while desde > 0 && es_fila_opcion(&filas[desde - 1], col) {
        desde -= 1;
    }
    let mut hasta = fila;
    while hasta + 1 < filas.len() && es_fila_opcion(&filas[hasta + 1], col) {
        hasta += 1;
    }
    let forma = forma_de(&filas[fila], col);
    (desde..=hasta)
        .filter(|&i| forma_de(&filas[i], col) == forma)
        .filter_map(|i| {
            let chars: Vec<char> = filas[i].chars().collect();
            let label = etiqueta(&chars[col + 1..].iter().collect::<String>());
            (!label.is_empty() && !es_pista(&label)).then(|| (chars[col] == '❯', label))
        })
        .take(MAX_OPCIONES)
        .enumerate()
        .map(|(n, (selected, label))| DialogOption {
            index: u32::try_from(n).unwrap_or(u32::MAX),
            label,
            selected,
        })
        .collect()
}

/// (fila, columna) del `❯` de selección más bajo con solo espacios delante.
fn cursor(filas: &[String]) -> Option<(usize, usize)> {
    filas.iter().enumerate().rev().find_map(|(i, l)| {
        let pos = l.chars().position(|c| c == '❯')?;
        l.chars().take(pos).all(|c| c == ' ').then_some((i, pos))
    })
}

fn es_fila_opcion(l: &str, col: usize) -> bool {
    let chars: Vec<char> = l.chars().collect();
    chars.len() > col + 2
        && chars[..col].iter().all(|c| *c == ' ')
        && matches!(chars[col], ' ' | '❯' | '↓' | '↑')
        && chars[col + 1] == ' '
        && !chars[col + 2..].iter().all(|c| c.is_whitespace())
}

/// Forma del texto de una fila del bloque de opciones.
#[derive(Debug, PartialEq, Eq)]
enum Forma {
    /// `1. Sí`: lista numerada.
    Numerada,
    /// `✔ codegraph`: empieza por un glifo de estado o de selección.
    Glifo,
    /// `User MCPs (…)`: empieza por letra.
    Texto,
}

/// Las opciones de un bloque comparten la forma de la fila del cursor: en
/// `/mcp`, las opciones empiezan por `✔`/`✘` y las cabeceras de sección
/// (`User MCPs (…)`), que no se pueden seleccionar, por letra.
fn forma_de(fila: &str, col: usize) -> Forma {
    let texto: String = fila.chars().skip(col + 1).collect();
    let t = texto.trim_start();
    let digitos = t.chars().take_while(char::is_ascii_digit).count();
    if digitos > 0 && t[digitos..].starts_with(". ") {
        return Forma::Numerada;
    }
    match t.chars().next() {
        Some(c) if c.is_alphanumeric() => Forma::Texto,
        _ => Forma::Glifo,
    }
}

fn es_pista(label: &str) -> bool {
    label.starts_with(['↓', '↑', '…', '+'])
}

/// Etiqueta sin la numeración `N.` y con los espacios colapsados.
fn etiqueta(s: &str) -> String {
    let t = s.trim();
    let sin_num = match t.split_once(". ") {
        Some((n, resto)) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => resto,
        _ => t,
    };
    let mut out: String = sin_num.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.chars().count() > 200 {
        out = out.chars().take(200).collect();
    }
    out
}

// ---------------------------------------------------------------------------
// Monitor por sesión
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct Marca {
    pendiente_desde: Option<Instant>,
    ultimo_byte: Option<Instant>,
}

/// Pantalla emulada de una sesión, alimentada por el lector del PTY.
pub struct Monitor {
    parser: Mutex<vt100::Parser>,
    marca: Mutex<Marca>,
    /// Turno de redimensionado (pantalla + PTY), aparte del parser: el lector
    /// no lo toma, así que esperar a ConPTY con él no bloquea la salida.
    redimension: Mutex<()>,
}

/// Copia de la pantalla (diagnóstico de los tests).
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instantanea {
    pub filas: Vec<String>,
    /// Pantalla con color en ANSI, para un xterm de solo lectura.
    pub ansi: String,
    pub cursor: (u16, u16),
}

impl Monitor {
    pub fn nuevo(rows: u16, cols: u16) -> Self {
        Self {
            parser: Mutex::new(vt100::Parser::new(rows, cols, 0)),
            marca: Mutex::new(Marca::default()),
            redimension: Mutex::new(()),
        }
    }

    /// Turno exclusivo para redimensionar: dos redimensionados a la vez
    /// (cierre de ventana y recarga) se pisaban la vuelta atrás.
    pub fn turno_redimension(&self) -> MutexGuard<'_, ()> {
        bloquear(&self.redimension)
    }

    /// Procesa un bloque de salida del PTY (hilo lector).
    pub fn alimentar(&self, bytes: &[u8]) {
        bloquear(&self.parser).process(bytes);
        let ahora = Instant::now();
        let mut m = bloquear(&self.marca);
        m.pendiente_desde.get_or_insert(ahora);
        m.ultimo_byte = Some(ahora);
    }

    pub fn clasificar(&self) -> Clasificacion {
        clasificar(bloquear(&self.parser).screen())
    }

    pub fn vista(&self) -> Vista {
        self.clasificar().vista()
    }

    /// Tamaño actual de la pantalla emulada: `(filas, columnas)`.
    pub fn tamano(&self) -> (u16, u16) {
        bloquear(&self.parser).screen().size()
    }

    pub fn redimensionar(&self, rows: u16, cols: u16) {
        bloquear(&self.parser).screen_mut().set_size(rows, cols);
        bloquear(&self.marca).pendiente_desde = Some(Instant::now());
    }

    /// true si hay salida sin clasificar y ya toca (debounce); consume la
    /// marca.
    pub fn toca_clasificar(&self, ahora: Instant) -> bool {
        let mut m = bloquear(&self.marca);
        let toca = debe_clasificar(m.pendiente_desde, m.ultimo_byte, ahora);
        if toca {
            *m = Marca::default();
        }
        toca
    }

    /// Texto de las filas visibles (registro de incidentes).
    pub fn filas(&self) -> Vec<String> {
        filas_de(bloquear(&self.parser).screen()).todo
    }

    #[cfg(test)]
    pub fn instantanea(&self) -> Instantanea {
        let p = bloquear(&self.parser);
        let s = p.screen();
        Instantanea {
            filas: filas_de(s).todo,
            ansi: String::from_utf8_lossy(&s.contents_formatted()).into_owned(),
            cursor: s.cursor_position(),
        }
    }
}

/// Debounce de 150 ms con latencia máxima de 250 ms.
pub fn debe_clasificar(
    pendiente_desde: Option<Instant>,
    ultimo_byte: Option<Instant>,
    ahora: Instant,
) -> bool {
    let (Some(desde), Some(ultimo)) = (pendiente_desde, ultimo_byte) else {
        return false;
    };
    ahora.saturating_duration_since(ultimo) >= DEBOUNCE
        || ahora.saturating_duration_since(desde) >= MAX_LATENCIA
}

fn monitores() -> &'static Mutex<HashMap<String, Arc<Monitor>>> {
    static M: OnceLock<Mutex<HashMap<String, Arc<Monitor>>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Registra (o sustituye, tras un reinicio) el monitor de la sesión `id`.
pub fn registrar(id: &str, m: Arc<Monitor>) {
    bloquear(monitores()).insert(id.to_string(), m);
}

pub fn monitor(id: &str) -> Option<Arc<Monitor>> {
    bloquear(monitores()).get(id).cloned()
}

pub fn olvidar(id: &str) {
    bloquear(monitores()).remove(id);
}

/// Clasificación actual de la sesión; `Unknown` si no tiene monitor.
pub fn actual(id: &str) -> Clasificacion {
    monitor(id).map(|m| m.clasificar()).unwrap_or_default()
}

#[cfg(test)]
#[path = "tests_pantalla.rs"]
mod tests;
