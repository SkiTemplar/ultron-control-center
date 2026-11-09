// Mascota — islas de una barra de tareas transparente (ajuste
// `taskbar_islands`): las zonas que se ven, sobre las que Pupus se posa.
//
// Con la barra transparente (TranslucentTB + estilos de Windhawk) solo se
// ven dos «píldoras»: el grupo central (Inicio, Buscar, Vista de tareas y las
// apps) y la bandeja (red, volumen, batería, reloj, notificaciones). UIA da
// el marco del grupo central (`TaskbarFrame`) y cada icono de la bandeja
// (`SystemTrayIcon`); la isla de la bandeja es la unión de sus iconos más un
// margen, sin «Mostrar escritorio» (una franja estrecha pegada al borde).
// Medido el 2026-10-27 a 2560×1600: grupo central 728..1832 y bandeja
// 2124..2534 (px físicos); la píldora pintada sobresale unos 8 px a cada lado
// de los iconos de la bandeja.

use serde::Serialize;

use super::taskbar_uia::RawButton;

/// AutomationId del marco del grupo central (Windows 11).
pub const FRAME_ID: &str = "TaskbarFrame";
/// AutomationId de cada icono de la bandeja.
pub const TRAY_ID: &str = "SystemTrayIcon";
/// Más estrecho que esto es «Mostrar escritorio», no un icono.
const MIN_TRAY_ICON_W: i32 = 24;
/// Lo que sobresale la píldora de la bandeja a cada lado de sus iconos.
const TRAY_PAD: i32 = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskbarIsland {
    pub bar: u64,
    /// (izquierda, arriba, derecha, abajo) en px físicos.
    pub rect: (i32, i32, i32, i32),
}

fn union(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)) -> (i32, i32, i32, i32) {
    (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3))
}

/// Islas de cada barra a partir de los elementos crudos de UIA. Pura.
pub fn islands_of(raw: &[RawButton]) -> Vec<TaskbarIsland> {
    let mut bars: Vec<u64> = raw.iter().map(|r| r.bar).collect();
    bars.sort_unstable();
    bars.dedup();
    let mut out = Vec::new();
    for bar in bars {
        let mine = || raw.iter().filter(move |r| r.bar == bar);
        if let Some(frame) = mine().find(|r| r.automation_id == FRAME_ID) {
            out.push(TaskbarIsland {
                bar,
                rect: frame.rect,
            });
        }
        let tray = mine()
            .filter(|r| r.automation_id == TRAY_ID && r.rect.2 - r.rect.0 >= MIN_TRAY_ICON_W)
            .map(|r| r.rect)
            .reduce(union);
        if let Some((l, t, r, b)) = tray {
            out.push(TaskbarIsland {
                bar,
                rect: (l - TRAY_PAD, t, r + TRAY_PAD, b),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(bar: u64, id: &str, rect: (i32, i32, i32, i32)) -> RawButton {
        RawButton {
            bar,
            name: String::new(),
            automation_id: id.into(),
            rect,
        }
    }

    #[test]
    fn grupo_central_y_bandeja_sin_mostrar_escritorio() {
        // Medidas reales del 2026-10-27 (px físicos, barra en y 1528..1600).
        let raw = [
            el(1, FRAME_ID, (728, 1533, 1832, 1593)),
            el(1, "Appid: Chrome", (1284, 1535, 1350, 1590)),
            el(1, TRAY_ID, (2124, 1535, 2172, 1590)),
            el(1, TRAY_ID, (2316, 1535, 2480, 1590)),
            el(1, TRAY_ID, (2486, 1535, 2534, 1590)),
            el(1, TRAY_ID, (2540, 1528, 2558, 1595)), // Mostrar escritorio
        ];
        let islands = islands_of(&raw);
        assert_eq!(
            islands,
            vec![
                TaskbarIsland {
                    bar: 1,
                    rect: (728, 1533, 1832, 1593)
                },
                TaskbarIsland {
                    bar: 1,
                    rect: (2116, 1535, 2542, 1590)
                },
            ]
        );
    }

    #[test]
    fn cada_barra_las_suyas_y_sin_marco_no_hay_isla_central() {
        let raw = [
            el(1, FRAME_ID, (0, 0, 100, 40)),
            el(2, TRAY_ID, (500, 5, 540, 40)),
            el(2, "Appid: x", (10, 5, 50, 40)),
        ];
        let islands = islands_of(&raw);
        assert_eq!(islands.len(), 2);
        assert_eq!(islands[0].bar, 1);
        assert_eq!(
            islands[1],
            TaskbarIsland {
                bar: 2,
                rect: (492, 5, 548, 40)
            }
        );
        // Caso negativo: sin marco ni bandeja (Windows 10), ninguna isla.
        assert!(islands_of(&[el(3, "Appid: y", (0, 0, 40, 40))]).is_empty());
    }
}
