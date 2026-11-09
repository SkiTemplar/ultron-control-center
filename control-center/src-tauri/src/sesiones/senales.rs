// sesiones/senales.rs — Señales que alimentan la máquina de estados de cada
// sesión (contrato de estabilidad, §1.3). Interfaz congelada en la fase 0a.
//
// Productores: WP-PTY (gestor, pantalla, salida del proceso) y WP-ESTADO
// (puente_eventos y seguidor). Consumidor único: el manejador que WP-ESTADO
// instala en `sesiones::init` con `instalar`. Sin manejador, `emitir` solo
// deja una traza `debug`.
//
// `normalizar_envio` es la función pura con la que la cola empareja un envío
// con lo que la CLI registra (transcript, `queue-operation`, `prompt`); la
// misma que aplica `gestor::paste_bytes` al añadir las menciones.
//
// Propiedad: WP-PTY.
#![allow(
    dead_code,
    reason = "fase 0a: los productores y el manejador los cablean WP-PTY y WP-ESTADO"
)]

use std::sync::{Arc, OnceLock, RwLock};

pub use super::types::ScreenState as EstadoPantalla;

/// Longitud máxima del texto normalizado que se compara (§5.2).
pub const NORMALIZADO_MAX: usize = 500;

/// Qué se escribió en el PTY.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvioKind {
    Prompt,
    Comando { nombre: String },
    Bash,
}

/// Señal hacia la máquina de estados (§1.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Senal {
    // WP-PTY (gestor, pantalla, salida)
    EnvioEscrito {
        client_id: String,
        kind: EnvioKind,
        texto: String,
    },
    Pantalla {
        estado: EstadoPantalla,
        modo: Option<String>,
        entrada: Option<String>,
        /// La TUI pinta «ctrl+b to run in background» (§3.4): sin ella,
        /// Claude Code no acepta Ctrl+B para la herramienta en curso.
        pista: bool,
    },
    /// La línea del spinner cambió (como mucho 1/s).
    Progreso,
    ProcesoSalio {
        code: i32,
    },
    /// Restart: se emite antes de matar el proceso.
    ReinicioPedido,
    // WP-ESTADO (puente_eventos)
    PuenteHello {
        protocolo: u8,
        claude_session_id: Option<String>,
        generacion: u32,
        transcript_path: Option<String>,
        /// `start` | `clear` | `resume` | `compact` | `turn`.
        origen: String,
    },
    PuenteListo,
    PromptEntrado {
        turn_id: Option<String>,
        texto: String,
        origen: String,
    },
    TurnoInicio {
        turn_id: String,
    },
    TurnoFin {
        turn_id: String,
        motivo: String,
        abortado: bool,
    },
    ComandoInicio {
        run_id: String,
        nombre: String,
    },
    ComandoFin {
        run_id: String,
        nombre: String,
        interceptado: bool,
    },
    HerramientaInicio {
        tool_use_id: String,
        nombre: String,
        timeout_ms: Option<u64>,
    },
    HerramientaFin {
        tool_use_id: String,
    },
    AskAbierta {
        ask_id: String,
        kind: String,
    },
    AskCerrada {
        ask_id: String,
    },
    ModoPermisos {
        modo: String,
    },
    Actividad {
        agent_id: Option<String>,
    },
    // WP-ESTADO (seguidor; solo hilo principal: sin agentId ni isSidechain)
    TxTurnDuration,
    TxInterrumpido,
    TxSalidaLocal,
    TxSalidaBash,
    TxEndTurn,
    TxPromptUsuario {
        texto: String,
    },
    // Reloj y recuperación
    Tick,
    InterrupcionPedida,
    /// `motivo` solo con `ok: false`; `None` si el resultado ya lo cuenta la
    /// ventana y no merece aviso de la máquina.
    RecuperacionTerminada {
        ok: bool,
        motivo: Option<MotivoFallo>,
    },
    /// «Enviar ahora» de la ventana: levanta la pausa de la cola.
    ReanudarCola,
    /// Sesión restaurada con el turno a medias: la cola no sale sola por
    /// delante de la continuación que ofrece el composer.
    TurnoCortado,
    /// Aviso de cuota de Claude (`relevo::observe`) o cuota ya agotada antes
    /// de drenar: la cola se retiene hasta la vuelta. Idempotente.
    LimiteUso,
    /// La cuota volvió o el relevo terminó: la cola se reanuda.
    LimiteFin,
}

/// Por qué una recuperación no dejó la sesión libre.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MotivoFallo {
    /// El turno pedido terminó y la CLI abrió otro (aviso de una tarea en
    /// segundo plano) que tampoco cerró: se puede volver a interrumpir.
    TurnoNuevo,
    /// El mismo turno sigue abierto, sin actividad del puente y con la
    /// pantalla ocupada tras Esc y Ctrl+C: la CLI no responde.
    SinRespuesta,
    /// El menú de la TUI sigue abierto tras dos Esc.
    MenuAbierto,
}

type Manejador = Arc<dyn Fn(&str, Senal) + Send + Sync>;
/// Forma en que llega el manejador a `instalar` (firma congelada en 0a).
pub type ManejadorBox = Box<dyn Fn(&str, Senal) + Send + Sync>;

fn manejador() -> &'static RwLock<Option<Manejador>> {
    static M: OnceLock<RwLock<Option<Manejador>>> = OnceLock::new();
    M.get_or_init(|| RwLock::new(None))
}

/// Instala el manejador único de señales (WP-ESTADO, en `sesiones::init`).
/// Una segunda llamada lo sustituye (los tests lo usan).
pub fn instalar(h: ManejadorBox) {
    match manejador().write() {
        Ok(mut g) => *g = Some(Arc::from(h)),
        Err(_) => tracing::error!("manejador de señales envenenado: no se pudo instalar"),
    }
}

/// true si WP-ESTADO ya instaló la máquina de estados. Sin ella, `entrada.rs`
/// y `gestor.rs` aplican su reserva mínima de estado (idle, waiting, working,
/// exited) para que la ventana siga funcionando.
pub fn hay_manejador() -> bool {
    manejador().read().is_ok_and(|g| g.is_some())
}

/// Entrega `s` al manejador fuera del lock. Sin manejador: traza `debug`.
pub fn emitir(id: &str, s: Senal) {
    let h = manejador().read().ok().and_then(|g| g.clone());
    match h {
        Some(h) => h(id, s),
        None => tracing::debug!(sesion = id, senal = ?s, "señal sin manejador instalado"),
    }
}

/// Texto comparable de un envío (§5.2): sin las marcas `<pasted_content>` con
/// que la CLI guarda un pegado largo, sin las menciones `@"…"`, sin
/// caracteres de control, con los espacios colapsados, recortado y limitado
/// a los primeros `NORMALIZADO_MAX` caracteres.
pub fn normalizar_envio(texto: &str) -> String {
    let sin_menciones = quitar_menciones(&quitar_marcas_pegado(texto, " "));
    let mut out = String::with_capacity(sin_menciones.len());
    let mut hueco = false;
    for c in sin_menciones.chars() {
        if c.is_whitespace() {
            hueco = !out.is_empty();
            continue;
        }
        if c.is_control() {
            continue;
        }
        if hueco {
            out.push(' ');
            hueco = false;
        }
        out.push(c);
    }
    match out.char_indices().nth(NORMALIZADO_MAX) {
        Some((corte, _)) => out[..corte].trim_end().to_string(),
        None => out,
    }
}

/// Texto de un prompt del transcript para mostrarlo: sin las marcas
/// `<pasted_content>` y sin las líneas en blanco que la CLI pone alrededor.
/// `None` si no tiene marcas (el texto se muestra tal cual).
pub fn sin_marcas_pegado(texto: &str) -> Option<String> {
    let limpio = quitar_marcas_pegado(texto, "");
    (limpio.len() != texto.len()).then(|| limpio.trim_matches(['\n', '\r']).to_string())
}

/// Quita las etiquetas `<pasted_content id="…">` y `</pasted_content id="…">`
/// (Claude Code 2.1.296 envuelve así en el transcript un pegado largo), pone
/// `sustituto` en su lugar y conserva su contenido. Una etiqueta sin `>` de
/// cierre se deja tal cual.
fn quitar_marcas_pegado(texto: &str, sustituto: &str) -> String {
    const MARCAS: [&str; 2] = ["<pasted_content", "</pasted_content"];
    let mut out = String::with_capacity(texto.len());
    let mut resto = texto;
    while let Some((i, marca)) = MARCAS
        .iter()
        .filter_map(|m| resto.find(m).map(|i| (i, *m)))
        .min_by_key(|(i, _)| *i)
    {
        let tras = &resto[i + marca.len()..];
        let es_etiqueta = tras.starts_with(['>', ' ']);
        let Some(fin) = tras.find('>').filter(|_| es_etiqueta) else {
            out.push_str(&resto[..i + marca.len()]);
            resto = tras;
            continue;
        };
        out.push_str(&resto[..i]);
        out.push_str(sustituto);
        resto = &tras[fin + 1..];
    }
    out.push_str(resto);
    out
}

/// Quita cada `@"…"` cerrado. Una mención sin comilla de cierre se deja tal
/// cual (no es una mención que haya añadido `paste_bytes`).
fn quitar_menciones(texto: &str) -> String {
    let mut out = String::with_capacity(texto.len());
    let mut resto = texto;
    while let Some(i) = resto.find("@\"") {
        let tras = &resto[i + 2..];
        let Some(fin) = tras.find('"') else { break };
        out.push_str(&resto[..i]);
        out.push(' ');
        resto = &tras[fin + 1..];
    }
    out.push_str(resto);
    out
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[test]
    fn colapsa_espacios_y_recorta() {
        assert_eq!(normalizar_envio("  hola \n\n  mundo\t "), "hola mundo");
        assert_eq!(normalizar_envio("a\r\nb"), "a b");
        assert_eq!(normalizar_envio("   "), "");
    }

    #[test]
    fn quita_menciones_cerradas() {
        assert_eq!(
            normalizar_envio(r#"mira esto @"C:\tmp\a b.png" y @"/x/y.txt""#),
            "mira esto y"
        );
        assert_eq!(normalizar_envio(r#"@"C:\a.png""#), "");
    }

    #[test]
    fn mencion_sin_cerrar_se_conserva() {
        assert_eq!(
            normalizar_envio(r#"correo @"abierto"#),
            r#"correo @"abierto"#
        );
    }

    #[test]
    fn quita_caracteres_de_control() {
        assert_eq!(normalizar_envio("a\u{3}b\u{1b}[31mc"), "ab[31mc");
    }

    #[test]
    fn limita_a_500_caracteres_sin_partir_utf8() {
        let largo = "ñ".repeat(600);
        let n = normalizar_envio(&largo);
        assert_eq!(n.chars().count(), NORMALIZADO_MAX);
        let justo = "é".repeat(NORMALIZADO_MAX);
        assert_eq!(normalizar_envio(&justo), justo);
    }

    #[test]
    fn textos_distintos_no_se_igualan() {
        assert_ne!(
            normalizar_envio("hola mundo"),
            normalizar_envio("hola  mundos")
        );
        assert_ne!(normalizar_envio("a b"), normalizar_envio("ab"));
    }

    #[test]
    fn empareja_con_el_pegado_de_paste_bytes() {
        let texto = "revisa  esto\nahora";
        let adjuntos = vec![r"C:\tmp\captura 1.png".to_string()];
        let bytes = crate::sesiones::gestor::paste_bytes(texto, &adjuntos).expect("pegado");
        let pegado = String::from_utf8(bytes).expect("utf8");
        let cuerpo = pegado
            .strip_prefix("\u{1b}[200~")
            .and_then(|p| p.strip_suffix("\u{1b}[201~"))
            .expect("marcas de pegado");
        assert_eq!(normalizar_envio(cuerpo), normalizar_envio(texto));
        assert_eq!(normalizar_envio(cuerpo), "revisa esto ahora");
    }

    #[test]
    fn quita_el_envoltorio_pasted_content_de_la_cli() {
        let cli =
            "\n\n<pasted_content id=\"2218\">\nhola\n  mundo\n</pasted_content id=\"2218\">\n";
        assert_eq!(normalizar_envio(cli), normalizar_envio("hola\n  mundo"));
        assert_eq!(
            normalizar_envio("a<pasted_content>b</pasted_content>c"),
            "a b c"
        );
        // Caso negativo: sin `>` de cierre o con otro nombre no es la marca.
        assert_eq!(
            normalizar_envio("x <pasted_content id"),
            "x <pasted_content id"
        );
        assert_eq!(normalizar_envio("<pasted_contents>y"), "<pasted_contents>y");
    }

    #[test]
    fn emitir_entrega_al_manejador_instalado() {
        let vistas: Arc<Mutex<Vec<(String, Senal)>>> = Arc::default();
        let v2 = vistas.clone();
        instalar(Box::new(move |id, s| {
            if let Ok(mut g) = v2.lock() {
                g.push((id.to_string(), s));
            }
        }));
        emitir("s1", Senal::ProcesoSalio { code: 3 });
        let got = vistas.lock().expect("lock").clone();
        assert!(got.contains(&("s1".to_string(), Senal::ProcesoSalio { code: 3 })));
    }
}
