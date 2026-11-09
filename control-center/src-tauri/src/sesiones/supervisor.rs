// sesiones/supervisor.rs — Reinicio acotado de los hilos de larga vida tras
// un pánico (estabilidad nocturna, hallazgo 9): el vigilante de pantalla de
// cada sesión (`entrada.rs`) y el escritor de `abiertas.json`
// (`persistencia.rs`). El seguidor y el drenaje ya llevan su propio
// `catch_unwind`.
//
// Sin esto, un pánico (por ejemplo, una secuencia rara del parser `vt100` en
// `clasificar`) mataba el hilo en silencio: la máquina se quedaba sin señales
// `Pantalla` y la cola sin drenar, y el rastro solo quedaba en `panic.log`.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::{Duration, Instant};

/// Reinicios tras pánico antes de rendirse (un fallo determinista no puede
/// convertirse en un bucle de pánicos toda la noche).
pub const MAX_REINICIOS: u32 = 5;
/// Pausa entre un pánico y el reinicio.
pub const PAUSA_REINICIO: Duration = Duration::from_secs(1);
/// Periodo sano que devuelve el presupuesto: tras este tiempo sin pánico, el
/// contador de reinicios vuelve a cero (como `ventana::admitir_recarga`). Un
/// pánico esporádico (uno por hora) no agota los reinicios en una noche; uno
/// determinista, que se repite en segundos, sí.
pub const VENTANA_SANA: Duration = Duration::from_secs(600);

/// Cómo terminó un hilo supervisado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fin {
    /// El cuerpo volvió sin pánico (tras `reinicios` reinicios).
    Normal { reinicios: u32 },
    /// Pánico tras agotar los reinicios: el hilo se detiene.
    Agotado,
}

/// Ejecuta `cuerpo` y lo relanza tras cada pánico, como mucho `max` veces
/// seguidas (sin `VENTANA_SANA` sin pánico entre medias) y con `pausa` entre
/// medias. `al_reiniciar` recibe el número de reinicio antes de relanzar
/// (aviso visible). Cada pánico queda en el log.
pub fn con_reinicio(
    nombre: &str,
    max: u32,
    pausa: Duration,
    cuerpo: impl FnMut(),
    al_reiniciar: impl FnMut(u32),
) -> Fin {
    con_reinicio_en(
        nombre,
        Limites {
            max,
            pausa,
            ventana: VENTANA_SANA,
        },
        Instant::now,
        cuerpo,
        al_reiniciar,
    )
}

/// Topes de `con_reinicio_en`.
#[derive(Debug, Clone, Copy)]
pub struct Limites {
    pub max: u32,
    pub pausa: Duration,
    /// Tiempo sin pánico tras el que el contador vuelve a cero.
    pub ventana: Duration,
}

/// `con_reinicio` con el reloj inyectado (tests).
pub fn con_reinicio_en(
    nombre: &str,
    l: Limites,
    mut reloj: impl FnMut() -> Instant,
    mut cuerpo: impl FnMut(),
    mut al_reiniciar: impl FnMut(u32),
) -> Fin {
    let mut reinicios = 0;
    let mut ultimo_panico: Option<Instant> = None;
    loop {
        if catch_unwind(AssertUnwindSafe(&mut cuerpo)).is_ok() {
            return Fin::Normal { reinicios };
        }
        let ahora = reloj();
        if ultimo_panico.is_some_and(|t| ahora.saturating_duration_since(t) >= l.ventana) {
            tracing::info!(
                hilo = nombre,
                reinicios,
                "pánico tras un periodo sano: el presupuesto de reinicios vuelve a cero"
            );
            reinicios = 0;
        }
        ultimo_panico = Some(ahora);
        if reinicios >= l.max {
            tracing::error!(
                hilo = nombre,
                reinicios,
                "pánico repetido: el hilo se detiene"
            );
            return Fin::Agotado;
        }
        reinicios += 1;
        tracing::error!(
            hilo = nombre,
            reinicio = reinicios,
            "pánico en un hilo de larga vida: se reinicia"
        );
        al_reiniciar(reinicios);
        std::thread::sleep(l.pausa);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_panico_reinicia_el_cuerpo() {
        let mut vueltas = 0;
        let mut avisos = Vec::new();
        let fin = con_reinicio(
            "prueba",
            MAX_REINICIOS,
            Duration::ZERO,
            || {
                vueltas += 1;
                assert!(vueltas >= 3, "pánico de prueba {vueltas}");
            },
            |n| avisos.push(n),
        );
        assert_eq!(fin, Fin::Normal { reinicios: 2 });
        assert_eq!(vueltas, 3);
        assert_eq!(avisos, vec![1, 2]);
    }

    /// Caso negativo: un pánico determinista no reinicia sin fin.
    #[test]
    fn los_reinicios_estan_acotados() {
        let mut vueltas = 0u32;
        let fin = con_reinicio(
            "prueba",
            3,
            Duration::ZERO,
            || {
                vueltas += 1;
                panic!("pánico de prueba");
            },
            |_| {},
        );
        assert_eq!(fin, Fin::Agotado);
        assert_eq!(vueltas, 4, "la vuelta inicial y 3 reinicios");
    }

    fn limites(max: u32) -> Limites {
        Limites {
            max,
            pausa: Duration::ZERO,
            ventana: VENTANA_SANA,
        }
    }

    /// M4: pánicos esporádicos, separados por más de la ventana sana, no
    /// agotan el presupuesto aunque sumen muchos más que `max`.
    #[test]
    fn panicos_separados_por_la_ventana_no_agotan() {
        let t0 = Instant::now();
        let mut pasos = 0u32;
        let reloj = || {
            pasos += 1;
            t0 + (VENTANA_SANA + Duration::from_secs(1)) * pasos
        };
        let mut vueltas = 0u32;
        let fin = con_reinicio_en(
            "prueba",
            limites(2),
            reloj,
            || {
                vueltas += 1;
                assert!(vueltas > 10, "pánico esporádico {vueltas}");
            },
            |_| {},
        );
        assert_eq!(fin, Fin::Normal { reinicios: 1 });
        assert_eq!(vueltas, 11);
    }

    /// Caso negativo: los mismos pánicos dentro de la ventana sí agotan.
    #[test]
    fn panicos_dentro_de_la_ventana_agotan() {
        let t0 = Instant::now();
        let mut pasos = 0u32;
        let reloj = || {
            pasos += 1;
            t0 + Duration::from_secs(60) * pasos
        };
        let mut vueltas = 0u32;
        let fin = con_reinicio_en(
            "prueba",
            limites(2),
            reloj,
            || {
                vueltas += 1;
                assert!(vueltas > 10, "pánico seguido {vueltas}");
            },
            |_| {},
        );
        assert_eq!(fin, Fin::Agotado);
        assert_eq!(vueltas, 3, "la vuelta inicial y 2 reinicios");
    }

    #[test]
    fn sin_panico_no_hay_reinicio() {
        let fin = con_reinicio("prueba", 3, Duration::ZERO, || {}, |_| unreachable!());
        assert_eq!(fin, Fin::Normal { reinicios: 0 });
    }
}
