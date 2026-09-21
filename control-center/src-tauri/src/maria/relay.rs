// mar.ia — relevo de proveedores sobre un unico hilo de conversacion.
//
// El problema: Claude Code, Codex y Gemini guardan su historial en formatos
// propios y ninguno puede leer la sesion del otro. "Seguir la misma
// conversacion con los tres" no existe como tal; hay que declararlo.
//
// La solucion: el hilo canonico es de mar.ia. Vive en
// `<raiz>/cockpit/maria/threads/<id>.jsonl`, un turno por linea, con el
// proveedor que lo contesto. Cuando toca cambiar de proveedor (porque se agoto
// la cuota o porque la tarea pide otro), se compone un PAQUETE DE CONTEXTO —
// resumen del hilo + ultimos turnos + memoria relevante de ULTRON — y se
// arranca al siguiente con ese paquete por delante.
//
// Reparto de responsabilidades:
//   * el orden de proveedores y su estado vive en `relay.json`;
//   * la memoria la pone el daemon de ULTRON (mismo recall que el resto);
//   * cada proveedor se invoca por su CLI real, en modo no interactivo.
//
// Limite declarado (mandamiento 13): esto es un RELEVO con traspaso de
// contexto, no una sesion compartida. El proveedor nuevo sabe lo que se
// hablo porque se le cuenta, no porque lea la sesion del anterior.

use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Turnos recientes que viajan literalmente en el paquete de contexto.
const TURNOS_EN_CONTEXTO: usize = 8;

/// Tope de caracteres del paquete. Un traspaso gigante gasta tokens del
/// proveedor nuevo justo cuando venimos de quedarnos sin ellos.
const MAX_CONTEXTO_CHARS: usize = 6_000;

/// Tope por turno dentro del paquete.
const MAX_TURNO_CHARS: usize = 1_200;

/// Cuanto vive el modelo local en VRAM tras una llamada: CERO.
///
/// El usuario lo dijo dos veces y sin matices (2026-09-19): "nunca debe estar
/// en memoria (vram) todo el rato" y "no quiero un keep alive de 2mins". Con
/// 2m se quedaron 8,65 GB ocupados con mar.ia ya cerrada.
///
/// Lo que cuesta: la eleccion de destino y la respuesta son dos llamadas
/// seguidas, asi que el modelo se carga DOS veces por turno (unos 3 s mas en
/// caliente). Es el precio de no reservar 8,6 GB, y el usuario ya dijo que le
/// da igual que tarde un poco mas. La descarga no depende solo de esto:
/// `EnUso` la fuerza al acabar y el vigilante barre lo que se escape.
const KEEP_ALIVE_TURNO: &str = "0";

/// `keep_alive` de la RESPUESTA del modelo local.
///
/// Sin residencia es "0" y manda `EnUso`. Con residencia se le da a Ollama un
/// margen por encima del plazo: quien descarga es el vigilante de `local.rs`,
/// y el plazo de Ollama queda de red por si mar.ia muere antes.
pub(crate) fn keep_alive_respuesta() -> String {
    match crate::maria::criterio::cargar().local_residente_s {
        0 => KEEP_ALIVE_TURNO.to_string(),
        s => format!("{}s", s.saturating_add(45)),
    }
}

/// Lo maximo que un mensaje espera a la memoria antes de salir sin ella.
const ESPERA_MEMORIA: Duration = Duration::from_millis(2_000);

/// Ventana de la llamada de DECISION, cuando la hay: lo justo para que la
/// respuesta que viene detras no vuelva a cargar el modelo (la doble carga
/// eran unos 3 s por turno). No deja nada residente: `EnUso` descarga al acabar
/// el turno, conteste quien conteste.
const KEEP_ALIVE_DECISION: &str = "20s";

/// Un turno del hilo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Turn {
    pub ts: String,
    /// "user" | "assistant".
    pub role: String,
    /// Proveedor que lo contesto ("claude", "codex", "gemini", "local").
    /// Vacio en los turnos del usuario.
    #[serde(default)]
    pub provider: String,
    /// Modelo concreto ("opus", "gpt-5-codex", …). Vacio en los turnos del
    /// usuario y en los hilos anteriores a que esto existiera.
    #[serde(default)]
    pub model: String,
    /// Esfuerzo pedido ("bajo" | "medio" | "alto").
    #[serde(default)]
    pub effort: String,
    pub text: String,
}

/// Resultado de una vuelta de relevo.
#[derive(Debug, Serialize)]
pub struct RelayAnswer {
    pub thread_id: String,
    /// Proveedor que finalmente contesto.
    pub provider: String,
    /// Modelo concreto que atendio el turno.
    pub model: String,
    /// Esfuerzo con el que se pidio.
    pub effort: String,
    /// "local" si lo decidio mar.ia, "manual" si lo fijo el usuario.
    pub decided_by: String,
    pub text: String,
    /// Proveedores que se intentaron antes, con su motivo de descarte. Se
    /// devuelve siempre: si el relevo salto de Claude a Codex, el usuario
    /// tiene derecho a saberlo sin mirar un log.
    pub skipped: Vec<SkipReason>,
    /// Proveedor que propuso el modelo local para esta tarea (None si no
    /// estaba disponible o contesto algo que no existe).
    pub chosen_by_local: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkipReason {
    pub provider: String,
    /// "sin_cli" | "cuota" | "error" | "desactivado" | "timeout".
    pub kind: String,
    pub detail: String,
}

/// Orden y estado de los proveedores.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayConfig {
    /// Orden de preferencia. El primero que pueda contestar, contesta.
    pub order: Vec<String>,
    /// Proveedores apagados a mano.
    #[serde(default)]
    pub disabled: Vec<String>,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            // Claude primero (es la suscripcion con mas contexto), el modelo
            // local el ultimo: es gratis pero el mas flojo, asi que hace de red.
            //
            // Gemini salio el 2026-09-20 y entro Antigravity (`agy`) en su
            // sitio, por peticion del usuario ("quitar gemini por agy"). La CLI
            // de Gemini pedia una cuenta que aqui ya no esta viva; Antigravity
            // da los mismos modelos de Google con la suscripcion que si hay.
            order: vec![
                "claude".into(),
                "codex".into(),
                "antigravity".into(),
                "local".into(),
            ],
            disabled: Vec::new(),
        }
    }
}

pub(crate) fn maria_dir() -> Result<PathBuf, String> {
    let dir = crate::maria::paths::cockpit("maria")?;
    std::fs::create_dir_all(dir.join("threads")).map_err(|e| format!("crear carpeta: {e}"))?;
    Ok(dir)
}

fn config_path() -> Result<PathBuf, String> {
    Ok(maria_dir()?.join("relay.json"))
}

fn state_path() -> Result<PathBuf, String> {
    Ok(maria_dir()?.join("relay-state.json"))
}

/// Ultimo resultado conocido de cada proveedor.
///
/// Es la unica medida HONESTA de "cuanto le queda": las CLI de suscripcion
/// (Claude, Codex, Gemini) no publican un contador de cuota, solo fallan
/// cuando se agota. Asi que se guarda lo que de verdad paso — contesto, se
/// quedo sin cuota o fallo — con su hora.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderState {
    /// "ok" | "cuota" | "error" | "desactivado".
    pub status: String,
    pub detail: String,
    pub at: String,
    /// Veces que ha contestado desde que se lleva la cuenta.
    #[serde(default)]
    pub answered: u64,
    /// Hasta cuando se le deja en paz tras quedarse sin cuota (RFC 3339; vacio
    /// = disponible). Ver `enrutado::enfriar_hasta`.
    #[serde(default)]
    pub cooldown_until: String,
    /// Avisos de cuota seguidos, para alargar el plazo si insiste.
    #[serde(default)]
    pub quota_strikes: u32,
}

pub type RelayState = std::collections::BTreeMap<String, ProviderState>;

pub fn load_state() -> RelayState {
    let bruto: RelayState = state_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    limpiar_estado(bruto, &load_config().order)
}

/// Quita del estado los proveedores que ya no existen.
///
/// El estado es PEGAJOSO a proposito (dice lo ultimo que paso de verdad), y
/// eso tiene un efecto feo: un proveedor retirado se queda para siempre en
/// rojo en la pantalla. Con Gemini fuera (2026-09-20) la lista enseñaba un
/// error eterno de una CLI que ya no se llama. Pura y testeada.
#[must_use]
pub fn limpiar_estado(estado: RelayState, orden: &[String]) -> RelayState {
    estado
        .into_iter()
        .filter(|(p, _)| p == "local" || orden.iter().any(|o| o == p))
        .collect()
}

fn save_state(state: &RelayState) {
    if let Ok(path) = state_path() {
        if let Ok(text) = serde_json::to_string_pretty(state) {
            let _ = std::fs::write(path, text);
        }
    }
}

/// Deja a un proveedor enfriando desde fuera del bucle del chat (las llamadas
/// internas tambien se topan con la cuota, y el chat debe enterarse).
pub(crate) fn enfriar_proveedor(provider: &str, detalle: &str) {
    let mut state = load_state();
    enfriar(&mut state, provider, detalle);
    record_attempt(&mut state, provider, "cuota", detalle);
    save_state(&state);
}

/// Anota el resultado de un intento conservando el contador de respuestas.
fn record_attempt(state: &mut RelayState, provider: &str, status: &str, detail: &str) {
    let entry = state.entry(provider.to_string()).or_default();
    entry.status = status.to_string();
    entry.detail = recorta(detail, 200);
    entry.at = chrono::Utc::now().to_rfc3339();
    if status == "ok" {
        entry.answered += 1;
        entry.cooldown_until.clear();
        entry.quota_strikes = 0;
    }
}

/// Apunta que el proveedor se quedo sin cuota y hasta cuando se le salta.
fn enfriar(state: &mut RelayState, provider: &str, detail: &str) {
    let entry = state.entry(provider.to_string()).or_default();
    let hasta = super::enrutado::enfriar_hasta(detail, entry.quota_strikes, chrono::Utc::now());
    entry.cooldown_until = hasta.to_rfc3339();
    entry.quota_strikes = entry.quota_strikes.saturating_add(1);
}

pub fn load_config() -> RelayConfig {
    let Ok(path) = config_path() else {
        return RelayConfig::default();
    };
    let cfg: RelayConfig = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    migrar_gemini(cfg)
}

/// Sustituye `gemini` por `antigravity` en una configuracion ya guardada.
///
/// Sin esto, quien tuviera el orden guardado (que es el caso normal: se guarda
/// al tocar la pantalla del Router) seguiria con un proveedor que ya no se sabe
/// invocar y el relevo le daria error para siempre. Pura y testeada.
#[must_use]
pub fn migrar_gemini(mut cfg: RelayConfig) -> RelayConfig {
    let cambia = |v: &mut Vec<String>| {
        for p in v.iter_mut() {
            if p == "gemini" {
                *p = "antigravity".to_string();
            }
        }
        // Por si la lista ya tenia los dos.
        let mut vistos = std::collections::HashSet::new();
        v.retain(|p| vistos.insert(p.clone()));
    };
    cambia(&mut cfg.order);
    cambia(&mut cfg.disabled);
    cfg
}

/// Ruta del hilo. El id se valida: es un nombre de fichero, no una ruta.
pub(crate) fn thread_path(thread_id: &str) -> Result<PathBuf, String> {
    if thread_id.is_empty()
        || thread_id.len() > 64
        || !thread_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("id de hilo invalido: {thread_id:?}"));
    }
    Ok(maria_dir()?
        .join("threads")
        .join(format!("{thread_id}.jsonl")))
}

pub fn append_turn(thread_id: &str, turn: &Turn) -> Result<(), String> {
    let path = thread_path(thread_id)?;
    let line = serde_json::to_string(turn).map_err(|e| format!("serializar turno: {e}"))?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("abrir hilo: {e}"))?;
    writeln!(f, "{line}").map_err(|e| format!("escribir turno: {e}"))
}

pub fn read_thread(thread_id: &str) -> Result<Vec<Turn>, String> {
    let path = thread_path(thread_id)?;
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(Vec::new()); // hilo nuevo: no es un error
    };
    Ok(text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Turn>(l).ok())
        .collect())
}

/// ¿El fallo es "se acabo la cuota" y no otra cosa?
///
/// Distinguirlo importa: ante cuota agotada hay que RELEVAR al siguiente
/// proveedor, mientras que ante un error de red o de sintaxis reintentar con
/// otro modelo no arregla nada y solo gasta la cuota del siguiente.
#[must_use]
pub fn is_quota_error(text: &str) -> bool {
    let t = text.to_lowercase();
    const SENALES: &[&str] = &[
        "usage limit",
        "limit reached",
        "rate limit",
        "rate_limit",
        "quota",
        "resource_exhausted",
        "insufficient_quota",
        "insufficient credit",
        "out of credit",
        "too many requests",
        "429",
        "upgrade to continue",
    ];
    SENALES.iter().any(|s| t.contains(s))
}

/// Recorta un texto a `max` caracteres respetando limites de caracter.
pub(crate) fn recorta(texto: &str, max: usize) -> String {
    if texto.chars().count() <= max {
        return texto.to_string();
    }
    let corto: String = texto.chars().take(max).collect();
    format!("{corto}…")
}

/// Compone el paquete de contexto que se le da al proveedor entrante.
///
/// Pura: se testea sin ficheros ni red.
#[must_use]
pub fn build_context(turns: &[Turn], memoria: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(mem) = memoria.filter(|m| !m.trim().is_empty()) {
        out.push_str("[memoria de ULTRON]\n");
        out.push_str(&recorta(mem.trim(), 1_500));
        out.push_str("\n\n");
    }
    let recientes: Vec<&Turn> = turns.iter().rev().take(TURNOS_EN_CONTEXTO).rev().collect();
    if !recientes.is_empty() {
        out.push_str("[conversacion previa]\n");
        for t in recientes {
            let quien = if t.role == "user" {
                "Usuario".to_string()
            } else if t.provider.is_empty() {
                "Asistente".to_string()
            } else {
                format!("Asistente ({})", t.provider)
            };
            out.push_str(&format!("{quien}: {}\n", recorta(&t.text, MAX_TURNO_CHARS)));
        }
        out.push('\n');
    }
    // Si aun asi se pasa del tope, se recorta por el PRINCIPIO: lo ultimo
    // dicho es lo que mas importa para continuar.
    if out.chars().count() > MAX_CONTEXTO_CHARS {
        let sobran = out.chars().count() - MAX_CONTEXTO_CHARS;
        let recortado: String = out.chars().skip(sobran).collect();
        out = format!("[…contexto anterior recortado…]\n{recortado}");
    }
    out
}

/// Lo que el usuario pide hacer con el proveedor, dicho con palabras.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IntencionProveedor {
    /// "respondeme con codex" -> fijar ese proveedor para la conversacion.
    Fijar(String),
    /// "ahora respondeme tu" -> volver a que decida el relevo.
    Soltar,
}

/// Lee una orden de cambio de proveedor en lenguaje normal. Pura.
///
/// Solo reconoce frases que son CLARAMENTE una instruccion sobre quien
/// responde. Nombrar un proveedor de pasada ("codex me dio un error") no puede
/// cambiar nada: el usuario lo pidio explicito el 2026-09-21 — "no cambiar de
/// modelo automaticamente porque el usuario simplemente haya respondido a una
/// pregunta de aclaracion".
#[must_use]
pub fn intencion_de_proveedor(texto: &str, conocidos: &[String]) -> Option<IntencionProveedor> {
    let t = texto.trim().to_lowercase();
    if t.is_empty() || t.chars().count() > 120 {
        // Una instruccion de cambio es corta. En un parrafo largo, el nombre
        // de un proveedor casi siempre es una mencion, no una orden.
        return None;
    }

    // Volver al reparto normal.
    const SOLTAR: &[&str] = &[
        "ahora respondeme tu",
        "ahora respóndeme tú",
        "respondeme tu",
        "respóndeme tú",
        "vuelve a decidir tu",
        "vuelve a decidir tú",
        "decide tu",
        "decide tú",
        "quita el proveedor",
        "sin proveedor fijo",
    ];
    if SOLTAR.iter().any(|f| t.contains(f)) {
        return Some(IntencionProveedor::Soltar);
    }

    // Verbos que convierten una mencion en una orden.
    const ORDENES: &[&str] = &[
        "respondeme con",
        "respóndeme con",
        "contestame con",
        "contéstame con",
        "usa ",
        "utiliza ",
        "cambia a ",
        "pasa a ",
        "preguntaselo a",
        "pregúntaselo a",
        "que responda ",
        "habla con ",
    ];
    if !ORDENES.iter().any(|v| t.contains(v)) {
        return None;
    }
    // Y el proveedor tiene que ser uno de los que existen de verdad.
    conocidos
        .iter()
        .find(|p| t.contains(p.as_str()))
        .map(|p| IntencionProveedor::Fijar(p.clone()))
}

/// Ruta real del binario en el PATH, o None si no esta.
///
/// Hace falta la RUTA y no solo saber si existe, porque de su extension
/// depende como hay que lanzarlo (ver `run_cli`).
pub(crate) fn ruta_de_cli(cmd: &str) -> Option<String> {
    // `where` es un proceso mas por mensaje (50-100 ms en Windows) para una
    // respuesta que no cambia mientras la aplicacion esta abierta. Solo se
    // recuerdan los aciertos: si la CLI no estaba y el usuario la instala, el
    // siguiente mensaje la encuentra.
    static RUTAS: std::sync::Mutex<Option<std::collections::HashMap<String, String>>> =
        std::sync::Mutex::new(None);
    if let Some(r) = RUTAS
        .lock()
        .ok()
        .and_then(|g| g.as_ref().and_then(|m| m.get(cmd).cloned()))
    {
        if std::path::Path::new(&r).exists() {
            return Some(r);
        }
    }
    let ruta = ruta_de_cli_sin_cache(cmd)?;
    if let Ok(mut g) = RUTAS.lock() {
        g.get_or_insert_with(std::collections::HashMap::new)
            .insert(cmd.to_string(), ruta.clone());
    }
    Some(ruta)
}

fn ruta_de_cli_sin_cache(cmd: &str) -> Option<String> {
    let salida = crate::proc::oculto(if cfg!(windows) { "where" } else { "which" })
        .arg(cmd)
        .output()
        .ok()?;
    if !salida.status.success() {
        return None;
    }
    Some(elegir_ruta(&String::from_utf8_lossy(&salida.stdout))?.to_string())
}

/// De todo lo que devuelve `where`, la ruta que Windows sabe ejecutar. Pura.
///
/// `where codex` devuelve DOS lineas: el script de shell de npm (sin
/// extension) y, debajo, el shim `.cmd` que es el que arranca en Windows.
/// Coger la primera y lanzarla directa no funciona — no es un ejecutable — y
/// dejaba a codex sin arrancar, con el relevo saltando a claude.
///
/// Si ninguna trae extension se devuelve la primera, que es lo correcto en
/// Linux: alli los binarios no la llevan.
#[must_use]
pub fn elegir_ruta(salida: &str) -> Option<&str> {
    let lineas: Vec<&str> = salida
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    for ext in [".exe", ".cmd", ".bat", ".com"] {
        if let Some(l) = lineas.iter().find(|l| l.to_lowercase().ends_with(ext)) {
            return Some(l);
        }
    }
    lineas.first().copied()
}

/// ¿Hay que lanzarlo a traves de `cmd /C`?
///
/// Solo los shims de npm (`.cmd`, `.bat`), que no son ejecutables y cmd es
/// quien sabe interpretarlos. Un `.exe` nativo se lanza DIRECTO, y ademas hay
/// que hacerlo asi:
///
/// **cmd.exe TRUNCA el argumento en el primer salto de linea.** El prompt del
/// relevo es multilinea (lleva el paquete de contexto), asi que a Antigravity
/// —el unico que recibe el prompt como argumento y no por stdin— le llegaba
/// solo la primera linea. Sin la pregunta, el modelo intentaba usar una
/// herramienta, en modo headless no puede pedir permiso, se auto-denegaba y
/// salia SIN TEXTO: el relevo lo contaba como error y saltaba a Claude.
///
/// Eso es el "a mi agy no me va, siempre sale error y termina en claude" que
/// reporto el usuario el 2026-09-21. Medido: por `cmd /C` no contesta; directo,
/// contesta. Pura sobre la ruta para poder probarla.
#[must_use]
pub fn necesita_cmd(ruta: &str) -> bool {
    let bajo = ruta.to_lowercase();
    bajo.ends_with(".cmd") || bajo.ends_with(".bat")
}

/// Ficheros que acompanan al mensaje (arrastrados, pegados o elegidos).
#[derive(Debug, Clone, Default)]
pub struct Adjuntos {
    pub rutas: Vec<PathBuf>,
}

const EXT_IMAGEN: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

/// Tope de texto que se incrusta por fichero cuando contesta el modelo local,
/// que no tiene herramientas para abrirlo por su cuenta.
const MAX_ADJUNTO_LOCAL: usize = 24_000;

impl Adjuntos {
    #[must_use]
    pub fn vacio(&self) -> bool {
        self.rutas.is_empty()
    }

    #[must_use]
    pub fn imagenes(&self) -> Vec<&PathBuf> {
        self.rutas
            .iter()
            .filter(|r| {
                r.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| EXT_IMAGEN.contains(&e.to_lowercase().as_str()))
            })
            .collect()
    }

    /// Carpetas a las que hay que dar acceso a la CLI, sin repetir.
    #[must_use]
    pub fn carpetas(&self) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = Vec::new();
        for r in &self.rutas {
            if let Some(d) = r.parent() {
                if !out.iter().any(|o| o == d) {
                    out.push(d.to_path_buf());
                }
            }
        }
        out
    }

    /// Linea que se guarda en el hilo junto al mensaje del usuario.
    #[must_use]
    pub fn etiqueta(&self) -> String {
        if self.vacio() {
            return String::new();
        }
        let nombres: Vec<&str> = self
            .rutas
            .iter()
            .filter_map(|r| r.file_name().and_then(|n| n.to_str()))
            .collect();
        format!("\n\n_adjuntos: {}_", nombres.join(", "))
    }

    /// Lo que se anade al mensaje para una CLI con herramientas: las rutas.
    #[must_use]
    pub fn como_rutas(&self) -> String {
        if self.vacio() {
            return String::new();
        }
        let lista: Vec<String> = self
            .rutas
            .iter()
            .map(|r| format!("- {}", r.display()))
            .collect();
        format!(
            "\n\n[archivos adjuntos — abrelos con tus herramientas antes de contestar]\n{}\n",
            lista.join("\n")
        )
    }

    /// Lo que se anade al mensaje para el modelo local: el texto, incrustado.
    #[must_use]
    pub fn como_texto(&self) -> String {
        let mut out = String::new();
        for r in &self.rutas {
            let nombre = r.file_name().and_then(|n| n.to_str()).unwrap_or("adjunto");
            match std::fs::read_to_string(r) {
                Ok(t) => out.push_str(&format!(
                    "\n\n[adjunto: {nombre}]\n{}\n",
                    recorta(&t, MAX_ADJUNTO_LOCAL)
                )),
                Err(_) => out.push_str(&format!(
                    "\n\n[adjunto: {nombre} — no es texto y este modelo no puede abrirlo]\n"
                )),
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Sesion propia de cada CLI, por hilo
// ---------------------------------------------------------------------------

/// Sesion de una CLI que este hilo puede reanudar.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SesionGuardada {
    pub id: String,
    /// Turnos que tenia el hilo justo despues de que este proveedor contestara.
    /// Si el hilo tiene otro numero, alguien mas ha hablado desde entonces (o
    /// se ha editado) y a esa sesion le falta contexto: no se reanuda.
    pub turnos: usize,
}

pub type Sesiones = std::collections::BTreeMap<String, SesionGuardada>;

fn sesiones_path(thread_id: &str) -> Result<PathBuf, String> {
    Ok(thread_path(thread_id)?.with_extension("sesiones.json"))
}

pub fn cargar_sesiones(thread_id: &str) -> Sesiones {
    sesiones_path(thread_id)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn guardar_sesiones(thread_id: &str, s: &Sesiones) {
    if let (Ok(p), Ok(t)) = (sesiones_path(thread_id), serde_json::to_string_pretty(s)) {
        let _ = std::fs::write(p, t);
    }
}

/// Que hacer con la sesion de `provider` en este turno. Pura.
#[must_use]
pub fn decidir_sesion(
    guardada: Option<&SesionGuardada>,
    provider: &str,
    turnos_en_hilo: usize,
    id_nuevo: &str,
) -> super::cli::Sesion {
    match guardada {
        Some(g) if !g.id.is_empty() && g.turnos == turnos_en_hilo => {
            super::cli::Sesion::Reanudar(g.id.clone())
        }
        // Solo Claude deja elegir el identificador; las otras lo devuelven.
        _ if provider == "claude" => super::cli::Sesion::Nueva(id_nuevo.to_string()),
        _ => super::cli::Sesion::Nueva(String::new()),
    }
}

/// Carpeta que comparten todos los agentes que trabajan para este hilo.
pub fn carpeta_de_trabajo(thread_id: &str) -> Result<PathBuf, String> {
    let dir = thread_path(thread_id)?.with_extension("trabajo");
    std::fs::create_dir_all(&dir).map_err(|e| format!("crear carpeta de trabajo: {e}"))?;
    Ok(dir)
}

/// Deja el hilo en sus primeros `conservar` turnos (editar un mensaje o
/// regenerar una respuesta). Las sesiones de las CLI se olvidan: recuerdan una
/// conversacion que ya no es esta.
pub fn truncar(thread_id: &str, conservar: usize) -> Result<usize, String> {
    let turns = read_thread(thread_id)?;
    if conservar >= turns.len() {
        return Ok(turns.len());
    }
    let path = thread_path(thread_id)?;
    let mut cuerpo = String::new();
    for t in turns.iter().take(conservar) {
        cuerpo.push_str(&serde_json::to_string(t).map_err(|e| format!("serializar turno: {e}"))?);
        cuerpo.push('\n');
    }
    // Lo que se quita no se pierde: queda como rama, por si el camino nuevo
    // resulta peor que el viejo.
    archivar_rama(thread_id, conservar, &turns[conservar..]);
    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, cuerpo).map_err(|e| format!("escribir hilo: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("renombrar hilo: {e}"))?;
    if let Ok(p) = sesiones_path(thread_id) {
        let _ = std::fs::remove_file(p);
    }
    Ok(conservar)
}

// ---------------------------------------------------------------------------
// Ramas: lo que una edicion dejo atras
// ---------------------------------------------------------------------------

/// Tramo de conversacion que se aparto al editar o regenerar.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rama {
    pub ts: String,
    /// Turno del hilo a partir del cual colgaba.
    pub desde: usize,
    pub turnos: Vec<Turn>,
}

/// Ramas que se guardan por conversacion. Las mas viejas se van.
const MAX_RAMAS: usize = 12;

fn ramas_path(thread_id: &str) -> Result<PathBuf, String> {
    Ok(thread_path(thread_id)?.with_extension("ramas.json"))
}

pub fn cargar_ramas(thread_id: &str) -> Vec<Rama> {
    ramas_path(thread_id)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn guardar_ramas(thread_id: &str, ramas: &[Rama]) {
    if let (Ok(p), Ok(t)) = (ramas_path(thread_id), serde_json::to_string_pretty(ramas)) {
        let _ = std::fs::write(p, t);
    }
}

fn archivar_rama(thread_id: &str, desde: usize, turnos: &[Turn]) {
    if turnos.is_empty() {
        return;
    }
    let mut ramas = cargar_ramas(thread_id);
    ramas.push(Rama {
        ts: chrono::Utc::now().to_rfc3339(),
        desde,
        turnos: turnos.to_vec(),
    });
    let sobran = ramas.len().saturating_sub(MAX_RAMAS);
    ramas.drain(..sobran);
    guardar_ramas(thread_id, &ramas);
}

/// Vuelve a una rama: el hilo se corta donde colgaba (lo que hubiera despues
/// pasa a ser rama a su vez) y se le cuelga ella.
pub fn restaurar_rama(thread_id: &str, indice: usize) -> Result<usize, String> {
    let mut ramas = cargar_ramas(thread_id);
    if indice >= ramas.len() {
        return Err("esa rama ya no existe".into());
    }
    let rama = ramas.remove(indice);
    guardar_ramas(thread_id, &ramas);
    truncar(thread_id, rama.desde)?;
    for t in &rama.turnos {
        append_turn(thread_id, t)?;
    }
    Ok(rama.desde + rama.turnos.len())
}

// ---------------------------------------------------------------------------
// Reparto: el agente que contesta puede encargar trabajo a otros
// ---------------------------------------------------------------------------

/// Encargos que pide una respuesta, y la respuesta sin esas lineas. Pura.
///
/// Solo cuenta una linea que EMPIECE por `@delegar <proveedor>:` con un
/// proveedor conocido: una mencion en mitad de una frase no lanza nada.
#[must_use]
pub fn encargos_en(texto: &str, conocidos: &[String]) -> (String, Vec<(String, String)>) {
    let mut resto: Vec<&str> = Vec::new();
    let mut encargos: Vec<(String, String)> = Vec::new();
    for linea in texto.lines() {
        let l = linea
            .trim()
            .trim_start_matches(['-', '*', ' '])
            .trim_matches('`');
        let pedido = l.strip_prefix("@delegar ").and_then(|r| r.split_once(':'));
        match pedido {
            Some((prov, que))
                if conocidos.iter().any(|c| c == prov.trim()) && !que.trim().is_empty() =>
            {
                encargos.push((prov.trim().to_string(), que.trim().to_string()));
            }
            _ => resto.push(linea),
        }
    }
    (resto.join("\n").trim().to_string(), encargos)
}

// ---------------------------------------------------------------------------
// Exportar
// ---------------------------------------------------------------------------

/// La conversacion en Markdown. Pura.
#[must_use]
pub fn como_markdown(titulo: &str, turnos: &[Turn]) -> String {
    let mut out = format!(
        "# {}\n\n",
        if titulo.trim().is_empty() {
            "Conversación"
        } else {
            titulo.trim()
        }
    );
    for t in turnos {
        let quien = if t.role == "user" {
            "Tú".to_string()
        } else if t.model.is_empty() {
            t.provider.clone()
        } else {
            format!("{} ({})", t.provider, t.model)
        };
        out.push_str(&format!(
            "## {quien} — {}\n\n{}\n\n",
            t.ts.get(..16).unwrap_or(&t.ts).replace('T', " "),
            t.text.trim()
        ));
    }
    out
}

/// Proveedor que el modelo local propone para una tarea, validado.
///
/// El modelo puede alucinar cualquier cosa; aqui solo se aceptan nombres que
/// existan en el orden configurado. Si propone una fantasia, se devuelve None
/// y manda el orden de siempre. Pura: se testea sin red.
#[must_use]
pub fn parse_choice(raw: &str, known: &[String]) -> Option<String> {
    let limpio: String = raw
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || c.is_whitespace())
        .collect();
    // Se busca la primera palabra que sea un proveedor conocido: el modelo
    // suele contestar "claude" a secas, pero a veces mete una frase.
    limpio
        .split_whitespace()
        .find(|w| known.iter().any(|k| k == w))
        .map(str::to_string)
}

/// Lo que el modelo local propone: proveedor, modelo y esfuerzo. Pura: se
/// testea sin red.
///
/// El modelo puede contestar cualquier cosa, asi que TODO se valida contra el
/// catalogo. Lo que no cuadre se cae a un valor sensato en vez de acabar en
/// una linea de comandos.
#[must_use]
pub fn parse_plan(raw: &str, known: &[String]) -> Option<crate::maria::models::Eleccion> {
    let provider = parse_choice(raw, known)?;
    let limpio = raw.to_lowercase();
    // Modelo: la primera palabra del catalogo de ESE proveedor que aparezca.
    let catalogo = crate::maria::models::catalogo_vivo();
    let modelos: Vec<String> = catalogo
        .iter()
        .find(|c| c.provider == provider)
        .map(|c| c.models.iter().map(|m| m.id.clone()).collect())
        .unwrap_or_default();
    let model = modelos
        .iter()
        .find(|id| limpio.contains(&id.to_lowercase()))
        .cloned()
        .unwrap_or_else(|| crate::maria::models::modelo_por_defecto(&provider));
    // Esfuerzo: se busca la palabra tal cual; si no viene, medio.
    let effort = ["alto", "bajo", "high", "low", "medio", "medium"]
        .iter()
        .find(|p| limpio.contains(*p))
        .map(|p| crate::maria::models::normaliza_esfuerzo(p))
        .unwrap_or_else(|| "medio".to_string());
    Some(crate::maria::models::Eleccion {
        provider,
        model,
        effort,
    })
}

/// Plan para ESTA tarea, decidido por el modelo local: a quien se le pide, con
/// que modelo y con cuanto esfuerzo.
///
/// El local es gratis y ya esta ahi: decidir cuesta ~1 s y evita gastar una
/// peticion de Opus en un "que hora es". Devuelve tambien el orden de relevo
/// (el elegido primero, el resto detras como red de seguridad).
fn plan_para_tarea(
    prompt: &str,
    cfg: &RelayConfig,
) -> (Vec<String>, Option<crate::maria::models::Eleccion>) {
    let proveedores = cfg.order.join(", ");
    let catalogo: String = crate::maria::models::catalogo_vivo()
        .iter()
        .filter(|c| cfg.order.contains(&c.provider))
        .map(|c| {
            let ms: Vec<String> = c
                .models
                .iter()
                .map(|m| format!("{} ({})", m.id, m.para))
                .collect();
            format!(
                "- {}: {}
",
                c.provider,
                ms.join("; ")
            )
        })
        .collect();
    // El criterio es EDITABLE desde la pantalla Router: lo que el usuario
    // escriba ahi entra aqui tal cual. Si se quedara clavado en el codigo, esa
    // pantalla no serviria para nada.
    let criterio = crate::maria::criterio::cargar();
    let reglas = crate::maria::criterio::como_prompt(&criterio);
    let instruccion = format!(
        "Decide QUIEN resuelve esta peticion, CON QUE MODELO y CON CUANTO          ESFUERZO.
         Responde en UNA linea con tres palabras separadas por espacios:          proveedor modelo esfuerzo.
         Proveedores: {proveedores}. Esfuerzo: bajo, medio o alto.
         Modelos por proveedor:
{catalogo}
         Criterio:
{reglas}
         Peticion: {prompt}"
    );
    let body = serde_json::json!({
        "model": crate::ollama::toggle::model_name(),
        "stream": false,
        "think": false,
        "keep_alive": KEEP_ALIVE_DECISION,
        "messages": [{ "role": "user", "content": instruccion }],
        "options": { "num_ctx": 4096, "num_predict": 24, "temperature": 0 },
    });
    let elegido = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .ok()
        .and_then(|c| {
            c.post("http://127.0.0.1:11434/api/chat")
                .json(&body)
                .send()
                .ok()
        })
        .and_then(|r| r.json::<serde_json::Value>().ok())
        .and_then(|v| {
            v.get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .map(str::to_string)
        })
        .and_then(|raw| parse_plan(&raw, &cfg.order));

    match elegido {
        Some(plan) => {
            let mut orden = vec![plan.provider.clone()];
            orden.extend(cfg.order.iter().filter(|o| **o != plan.provider).cloned());
            (orden, Some(plan))
        }
        // Sin modelo local (o respuesta ininteligible) no se bloquea nada: se
        // usa el orden configurado y el modelo por defecto de cada CLI.
        None => (cfg.order.clone(), None),
    }
}

/// Plan decidido SIN modelo: senales lexicas + las reglas del criterio.
///
/// None = no esta claro, o el usuario no tiene regla para esa clase, o la regla
/// apunta a un proveedor que no esta en el orden: entonces decide el local como
/// siempre. Ver `enrutado`.
fn plan_rapido(
    prompt: &str,
    cfg: &RelayConfig,
    adjuntos: &Adjuntos,
) -> Option<(Vec<String>, Option<crate::maria::models::Eleccion>)> {
    let clase = super::enrutado::clasificar(prompt, !adjuntos.imagenes().is_empty())?;
    let criterio = crate::maria::criterio::solo_proveedores_validos(
        &crate::maria::criterio::cargar(),
        &cfg.order,
    );
    let regla = super::enrutado::regla_para(clase, &criterio)?;
    // Una imagen no puede acabar en el modelo que no ve.
    if regla.provider == "local" && !adjuntos.imagenes().is_empty() {
        return None;
    }
    let model = if crate::maria::models::modelo_valido(&regla.provider, &regla.model) {
        regla.model.clone()
    } else {
        crate::maria::models::modelo_por_defecto(&regla.provider)
    };
    let plan = crate::maria::models::Eleccion {
        provider: regla.provider.clone(),
        model,
        effort: crate::maria::models::normaliza_esfuerzo(&regla.effort),
    };
    tracing::info!(clase = ?clase, proveedor = %plan.provider, "destino por reglas, sin consultar al local");
    let mut orden = vec![plan.provider.clone()];
    orden.extend(cfg.order.iter().filter(|o| **o != plan.provider).cloned());
    Some((orden, Some(plan)))
}

/// Memoria relevante para este turno, via daemon de ULTRON. Mismo recall que
/// usa el resto del sistema: las skills, los hooks y la memoria no se
/// reimplementan aqui.
pub(crate) fn memoria_para(prompt: &str) -> Option<String> {
    let value = crate::daemon_client::recall(prompt, 3, None, true, false, Duration::from_secs(8))?;
    let items = value.get("memories")?.as_array()?;
    if items.is_empty() {
        return None;
    }
    let mut out = String::new();
    for m in items.iter().take(3) {
        if let Some(s) = m
            .get("summary")
            .or_else(|| m.get("text"))
            .and_then(|v| v.as_str())
        {
            out.push_str("- ");
            out.push_str(&recorta(s, 400));
            out.push('\n');
        }
    }
    (!out.is_empty()).then_some(out)
}

/// Pregunta al hilo `thread_id`, relevando proveedores hasta que uno conteste.
///
/// `forzado` salta la eleccion del modelo local y pone ese proveedor el
/// primero (lo usa el comando `/migrar` del chat). El resto del orden se
/// conserva como red de seguridad: forzar a Claude cuando Claude no tiene
/// cuota no puede dejar al usuario sin respuesta.
pub fn ask(
    thread_id: &str,
    prompt: &str,
    forzado: Option<&crate::maria::models::Eleccion>,
) -> Result<RelayAnswer, String> {
    ask_con(thread_id, prompt, forzado, &Adjuntos::default())
}

/// Como `ask`, con ficheros adjuntos al mensaje.
pub fn ask_con(
    thread_id: &str,
    prompt: &str,
    forzado: Option<&crate::maria::models::Eleccion>,
    adjuntos: &Adjuntos,
) -> Result<RelayAnswer, String> {
    // Mientras viva este guardia, el modelo cuenta como "en uso"; al soltarlo
    // se descarga solo, tambien si `ask_inner` sale por un error o un panico.
    let _en_uso = crate::maria::local::EnUso::nuevo();
    // Una orden de parar es de UN turno: ni hereda la del anterior ni deja la
    // suya para el siguiente.
    crate::maria::flujo::limpiar(thread_id);
    let r = ask_inner(thread_id, prompt, forzado, adjuntos);
    crate::maria::flujo::limpiar(thread_id);
    if r.is_ok() {
        crate::maria::threads::touch(thread_id);
        // Y ponerle nombre si aun no lo tiene. En su propio hilo: la respuesta
        // ya esta lista y no puede esperar a que el modelo local redacte un
        // titulo. Aqui, y no en la pantalla de chat, para que tambien lo
        // tengan las conversaciones que nacen por voz, por el movil o por
        // `//maria`.
        let hilo = thread_id.to_string();
        std::thread::spawn(move || {
            crate::maria::threads::titular_si_hace_falta(&hilo);
        });
    }
    r
}

fn ask_inner(
    thread_id: &str,
    prompt: &str,
    forzado: Option<&crate::maria::models::Eleccion>,
    adjuntos: &Adjuntos,
) -> Result<RelayAnswer, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("no me has dicho nada".into());
    }
    let cfg = load_config();
    let turns = read_thread(thread_id)?;
    // La memoria se pide YA, en su hilo: hasta 8 s de recall que antes se
    // esperaban en fila delante de la decision de destino. Ahora corren a la
    // vez y se recoge justo antes de montar el paquete.
    let (tx_mem, rx_mem) = std::sync::mpsc::channel::<Option<String>>();
    {
        let p = prompt.to_string();
        std::thread::spawn(move || {
            let _ = tx_mem.send(memoria_para(&p));
        });
    }

    append_turn(
        thread_id,
        &Turn {
            ts: chrono::Utc::now().to_rfc3339(),
            role: "user".into(),
            provider: String::new(),
            model: String::new(),
            effort: String::new(),
            // Los nombres de los adjuntos quedan en el hilo: al releer la
            // conversacion (o al traspasarla a otro proveedor) se sabe que
            // los hubo.
            text: format!("{prompt}{}", adjuntos.etiqueta()),
        },
    )?;

    let mut skipped: Vec<SkipReason> = Vec::new();
    let mut state = load_state();
    // Quien atiende, con que modelo y con cuanto esfuerzo lo decide el modelo
    // local segun la tarea: es gratis y evita gastar una peticion de Opus en
    // algo trivial. Si el usuario lo ha fijado a mano, manda el usuario.
    // Quien responde: por este orden de mando.
    //   1. lo que el usuario acaba de pedir con palabras en este mensaje
    //   2. lo que haya fijado la pantalla para este turno (`forzado`)
    //   3. el proveedor que quedo pegado a la conversacion
    //   4. el relevo decide
    match intencion_de_proveedor(prompt, &cfg.order) {
        Some(IntencionProveedor::Fijar(p)) => {
            let _ = crate::maria::threads::fijar_provider(thread_id, &p);
        }
        Some(IntencionProveedor::Soltar) => {
            let _ = crate::maria::threads::fijar_provider(thread_id, "");
        }
        None => {}
    }
    let pegado = crate::maria::threads::provider_de(thread_id);
    let del_hilo = (!pegado.is_empty() && cfg.order.contains(&pegado)).then(|| {
        crate::maria::models::Eleccion {
            provider: pegado.clone(),
            model: crate::maria::models::modelo_por_defecto(&pegado),
            effort: "medio".into(),
        }
    });
    let elegido_a_mano = forzado.cloned().or(del_hilo);
    // Si la pantalla fija uno, ese se pega tambien a la conversacion: un
    // cambio en el desplegable vale para los mensajes siguientes, no solo
    // para este.
    if let Some(f) = forzado {
        let _ = crate::maria::threads::fijar_provider(thread_id, &f.provider);
    }
    let manual = elegido_a_mano.filter(|f| cfg.order.contains(&f.provider));
    let manual = manual.as_ref();
    // El criterio puede apagar la decision del local (p. ej. con Ollama
    // caido): entonces manda el orden de relevo y no se pierde un segundo
    // preguntando a un modelo que no esta.
    let ajustes = crate::maria::criterio::cargar();
    let decide_local = ajustes.decide_la_local;
    let turnos_antes = turns.len();
    let mut sesiones = cargar_sesiones(thread_id);
    // Donde arrancan los agentes: en el proyecto de la conversacion si lo
    // tiene (Claude lee ahi su CLAUDE.md y Codex su AGENTS.md); si no, y hay
    // acceso total, en la carpeta de trabajo comun.
    let proyecto = crate::maria::threads::project_de(thread_id);
    let trabajo = proyecto.clone().or_else(|| {
        ajustes
            .acceso_total
            .then(|| carpeta_de_trabajo(thread_id).ok())
            .flatten()
    });
    let ajustes_cli = super::cli::Ajustes {
        ligero: ajustes.claude_ligero,
        acceso_total: ajustes.acceso_total,
        mcp_config: super::capacidades::fichero_mcp_chat(&ajustes.claude_mcps),
    };
    let mut por_reglas = false;
    let (orden, plan) = match manual {
        Some(f) => {
            let mut orden = vec![f.provider.clone()];
            orden.extend(cfg.order.iter().filter(|o| **o != f.provider).cloned());
            (orden, Some(f.clone()))
        }
        None => match plan_rapido(prompt, &cfg, adjuntos) {
            Some(rapido) => {
                por_reglas = true;
                rapido
            }
            None if decide_local => plan_para_tarea(prompt, &cfg),
            None => (cfg.order.clone(), None),
        },
    };
    let decided_by = if manual.is_some() {
        "manual"
    } else if por_reglas {
        "reglas"
    } else {
        "local"
    };

    // Quien acaba de quedarse sin cuota pasa al final hasta que venza su
    // plazo. Solo se respeta tal cual lo que el usuario fija A MANO en este
    // turno: si pide Claude, se intenta Claude.
    let ahora = chrono::Utc::now();
    let frios: Vec<String> = orden
        .iter()
        .filter(|p| p.as_str() != "local")
        .filter(|p| forzado.is_none_or(|f| f.provider != **p))
        .filter(|p| {
            state
                .get(p.as_str())
                .is_some_and(|e| super::enrutado::enfriando(&e.cooldown_until, ahora))
        })
        .cloned()
        .collect();
    for p in &frios {
        let hasta = state
            .get(p)
            .map(|e| e.cooldown_until.clone())
            .unwrap_or_default();
        skipped.push(SkipReason {
            provider: p.clone(),
            kind: "enfriando".into(),
            detail: format!("sin cuota; se le vuelve a preguntar a partir de {hasta}"),
        });
    }
    let orden = super::enrutado::ordenar_por_disponibilidad(&orden, &frios);

    // Con el daemon caliente la memoria llega en 100-300 ms y ya esta aqui. Si
    // el sistema de memoria esta degradado (Qdrant caido, daemon frio) no se
    // le regalan 8 s a cada mensaje: se contesta sin ella y se dice en el log.
    let memoria = rx_mem.recv_timeout(ESPERA_MEMORIA).ok().flatten();
    if memoria.is_none() {
        tracing::debug!("turno sin memoria: no llego a tiempo o no habia nada");
    }
    let contexto = build_context(&turns, memoria.as_deref());
    let completo = if contexto.is_empty() {
        prompt.to_string()
    } else {
        format!("{contexto}[mensaje actual]\n{prompt}")
    };
    // A una sesion reanudada no se le repite el hilo: ya lo tiene. Solo lo
    // nuevo — la memoria que haya salido para este mensaje, y el mensaje.
    let solo_mensaje = match memoria.as_deref() {
        Some(m) => format!("[memoria relevante]\n{m}\n[mensaje actual]\n{prompt}"),
        None => prompt.to_string(),
    };
    let mut manual_agentes = super::capacidades::manual(trabajo.as_deref(), ajustes.acceso_total);
    if let Some(p) = &proyecto {
        manual_agentes.push_str(&format!(
            "- Esta conversacion trabaja sobre el proyecto {}. Lee su CLAUDE.md o AGENTS.md si existe antes de tocar nada.\n",
            p.display()
        ));
    }
    if ajustes.reparto_auto {
        manual_agentes.push_str(&super::capacidades::manual_reparto(&cfg.order));
    }
    manual_agentes.push('\n');
    let chosen_by_local = if manual.is_some() {
        None
    } else {
        plan.as_ref().map(|p| p.provider.clone())
    };
    if let Some(p) = &plan {
        tracing::info!(
            proveedor = %p.provider, modelo = %p.model, esfuerzo = %p.effort,
            origen = decided_by, "destino del turno"
        );
    }
    for provider in &orden {
        if cfg.disabled.iter().any(|d| d == provider) {
            record_attempt(&mut state, provider, "desactivado", "apagado en relay.json");
            skipped.push(SkipReason {
                provider: provider.clone(),
                kind: "desactivado".into(),
                detail: "apagado en relay.json".into(),
            });
            continue;
        }
        // El plan solo vale para el proveedor elegido; si el relevo salta a
        // otro, ese otro usa su modelo por defecto — pedirle "opus" a Gemini
        // seria pedirle un modelo que no tiene.
        let mismo = plan.as_ref().is_some_and(|p| {
            p.provider == *provider && crate::maria::models::modelo_valido(provider, &p.model)
        });
        let (modelo, esfuerzo) = match plan.as_ref().filter(|_| mismo) {
            Some(p) => (
                p.model.clone(),
                crate::maria::models::normaliza_esfuerzo(&p.effort),
            ),
            None => (
                crate::maria::models::modelo_por_defecto(provider),
                "medio".to_string(),
            ),
        };
        // Lo que hubiera pintado un proveedor que al final no contesto no es
        // de este: la pantalla lo descarta.
        crate::maria::flujo::trozo(thread_id, provider, "", true);
        let intento: Result<super::cli::Respuesta, (String, bool)> = if provider == "local" {
            let skills = if ajustes.compartir_skills {
                super::capacidades::indice_skills(prompt)
            } else {
                String::new()
            };
            super::local_agente::responder(
                thread_id,
                &format!("{skills}{completo}"),
                &esfuerzo,
                adjuntos,
                ajustes.acceso_total,
                trabajo.as_deref(),
            )
            .map(|texto| super::cli::Respuesta {
                texto,
                sesion: None,
            })
        } else {
            let sesion = if ajustes.sesion_continua {
                decidir_sesion(
                    sesiones.get(provider.as_str()),
                    provider,
                    turnos_antes,
                    &uuid::Uuid::new_v4().to_string(),
                )
            } else {
                super::cli::Sesion::Ninguna
            };
            let reanuda = matches!(sesion, super::cli::Sesion::Reanudar(_));
            // Claude carga las skills de verdad; a los demas se les ofrece el
            // indice de las que casan con la peticion.
            let skills = if ajustes.compartir_skills && provider != "claude" {
                super::capacidades::indice_skills(prompt)
            } else {
                String::new()
            };
            let de_cero = format!("{manual_agentes}{skills}{completo}");
            let cuerpo = if reanuda {
                format!("{skills}{solo_mensaje}")
            } else {
                de_cero.clone()
            };
            let pedir = |cuerpo: &str, sesion: super::cli::Sesion| {
                super::cli::ejecutar(&super::cli::Peticion {
                    clave: thread_id,
                    provider,
                    prompt: cuerpo,
                    model: &modelo,
                    effort: &esfuerzo,
                    ajustes: &ajustes_cli,
                    adjuntos,
                    sesion,
                    cwd: trabajo.clone(),
                })
            };
            let mut r = pedir(&cuerpo, sesion);
            // Una sesion que ya no existe (caducada, borrada) no es motivo para
            // relevar a otro proveedor: se le cuenta el hilo de nuevo y listo.
            if reanuda
                && matches!(&r, Err((_, cuota)) if !cuota)
                && !crate::maria::flujo::cancelado(thread_id)
            {
                tracing::info!(proveedor = %provider, "la sesion no se pudo reanudar; se empieza otra");
                sesiones.remove(provider.as_str());
                crate::maria::flujo::trozo(thread_id, provider, "", true);
                let nueva = decidir_sesion(
                    None,
                    provider,
                    turnos_antes,
                    &uuid::Uuid::new_v4().to_string(),
                );
                r = pedir(&de_cero, nueva);
            }
            r
        };
        match intento {
            Ok(respuesta) => {
                let (text, pedidos) = if ajustes.reparto_auto {
                    encargos_en(&respuesta.texto, &cfg.order)
                } else {
                    (respuesta.texto.clone(), Vec::new())
                };
                let mut text = if text.is_empty() {
                    respuesta.texto.clone()
                } else {
                    text
                };
                for (prov, que) in &pedidos {
                    match super::encargos::lanzar(thread_id, prov, que) {
                        Ok(e) => text.push_str(&format!(
                            "\n\n> encargo `{}` lanzado a **{}**: {}",
                            e.id,
                            prov,
                            recorta(que, 160)
                        )),
                        Err(motivo) => {
                            text.push_str(&format!("\n\n> no pude encargar a {prov}: {motivo}"))
                        }
                    }
                }
                match respuesta.sesion {
                    Some(id) if !id.is_empty() => {
                        sesiones.insert(
                            provider.clone(),
                            SesionGuardada {
                                id,
                                turnos: turnos_antes + 2,
                            },
                        );
                    }
                    _ => {
                        sesiones.remove(provider.as_str());
                    }
                }
                guardar_sesiones(thread_id, &sesiones);
                record_attempt(&mut state, provider, "ok", "contesto");
                save_state(&state);
                append_turn(
                    thread_id,
                    &Turn {
                        ts: chrono::Utc::now().to_rfc3339(),
                        role: "assistant".into(),
                        provider: provider.clone(),
                        model: modelo.clone(),
                        effort: esfuerzo.clone(),
                        text: text.clone(),
                    },
                )?;
                return Ok(RelayAnswer {
                    thread_id: thread_id.to_string(),
                    provider: provider.clone(),
                    model: modelo,
                    effort: esfuerzo,
                    decided_by: decided_by.to_string(),
                    text,
                    skipped,
                    chosen_by_local,
                });
            }
            Err((detail, cuota)) => {
                // Parar no es un fallo del proveedor: ni se anota ni se releva.
                if crate::maria::flujo::cancelado(thread_id) {
                    save_state(&state);
                    return Err("parado".into());
                }
                let kind = if cuota { "cuota" } else { "error" };
                if cuota {
                    enfriar(&mut state, provider, &detail);
                    // Se aprende el tope practico de la ventana: el consumo
                    // que habia justo cuando el proveedor dijo basta.
                    let w = crate::maria::quota::claude_window();
                    if provider == "claude" {
                        crate::maria::quota::record_ceiling("claude", w.tokens);
                    }
                }
                record_attempt(&mut state, provider, kind, &detail);
                skipped.push(SkipReason {
                    provider: provider.clone(),
                    kind: kind.into(),
                    detail,
                });
            }
        }
    }

    save_state(&state);
    Err(format!(
        "ningun proveedor pudo contestar: {}",
        skipped
            .iter()
            .map(|s| format!("{} ({})", s.provider, s.kind))
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

// ---------------------------------------------------------------------------
// Comandos Tauri
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn maria_relay_ask(
    thread_id: String,
    prompt: String,
    provider: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    adjuntos: Option<Vec<String>>,
) -> Result<RelayAnswer, String> {
    // Un proveedor fijado a mano puede venir sin modelo: entonces se usa el
    // que ESE proveedor tenga por defecto, no el de otro.
    let forzado =
        provider
            .filter(|p| !p.trim().is_empty())
            .map(|p| crate::maria::models::Eleccion {
                model: model
                    .filter(|m| !m.trim().is_empty())
                    .unwrap_or_else(|| crate::maria::models::modelo_por_defecto(&p)),
                effort: crate::maria::models::normaliza_esfuerzo(&effort.unwrap_or_default()),
                provider: p,
            });
    // Bloqueante (procesos + red) fuera del hilo async de Tauri.
    let adjuntos = Adjuntos {
        rutas: adjuntos
            .unwrap_or_default()
            .into_iter()
            .map(PathBuf::from)
            .filter(|p| p.is_file())
            .collect(),
    };
    tauri::async_runtime::spawn_blocking(move || {
        ask_con(&thread_id, &prompt, forzado.as_ref(), &adjuntos)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

#[tauri::command]
pub async fn maria_relay_ramas(thread_id: String) -> Result<Vec<Rama>, String> {
    Ok(cargar_ramas(&thread_id))
}

#[tauri::command]
pub async fn maria_relay_rama_restaurar(thread_id: String, indice: usize) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || restaurar_rama(&thread_id, indice))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Escribe la conversacion en Markdown en `destino` (lo elige el usuario).
#[tauri::command]
pub async fn maria_relay_exportar(
    thread_id: String,
    titulo: String,
    destino: String,
) -> Result<String, String> {
    let turnos = read_thread(&thread_id)?;
    if turnos.is_empty() {
        return Err("la conversación está vacía".into());
    }
    std::fs::write(&destino, como_markdown(&titulo, &turnos))
        .map_err(|e| format!("no pude escribir {destino}: {e}"))?;
    Ok(destino)
}

#[tauri::command]
pub async fn maria_relay_truncar(thread_id: String, conservar: usize) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || truncar(&thread_id, conservar))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

#[tauri::command]
pub async fn maria_relay_thread(thread_id: String) -> Result<Vec<Turn>, String> {
    read_thread(&thread_id)
}

/// Ultimo resultado conocido por proveedor (para el panel de la pantalla
/// principal: quien contesta, quien se quedo sin cuota y cuando).
#[tauri::command]
pub async fn maria_relay_state() -> Result<RelayState, String> {
    Ok(load_state())
}

#[tauri::command]
pub async fn maria_relay_config() -> Result<RelayConfig, String> {
    Ok(load_config())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turno(role: &str, provider: &str, text: &str) -> Turn {
        Turn {
            ts: "2026-09-18T10:00:00Z".into(),
            role: role.into(),
            provider: provider.into(),
            model: String::new(),
            effort: String::new(),
            text: text.into(),
        }
    }

    #[test]
    fn detecta_los_mensajes_de_cuota_agotada() {
        for t in [
            "Claude usage limit reached. Resets at 3pm",
            "Error 429: Too Many Requests",
            "RESOURCE_EXHAUSTED: quota exceeded for model",
            "insufficient_quota: add credit",
            "You have hit the rate limit",
        ] {
            assert!(is_quota_error(t), "deberia ser cuota: {t}");
        }
    }

    #[test]
    fn no_confunde_otros_fallos_con_cuota() {
        // Caso negativo: si un fallo de red se tomara por cuota, el relevo
        // quemaria la cuota del siguiente proveedor sin motivo.
        for t in [
            "ENOTFOUND api.anthropic.com",
            "command not found",
            "SyntaxError: unexpected token",
            "permission denied",
            "",
        ] {
            assert!(!is_quota_error(t), "no deberia ser cuota: {t}");
        }
    }

    #[test]
    fn el_contexto_incluye_memoria_y_ultimos_turnos() {
        let turns = vec![
            turno("user", "", "arregla el login"),
            turno("assistant", "claude", "falta el token CSRF"),
        ];
        let ctx = build_context(&turns, Some("- el proyecto usa Supabase"));
        assert!(ctx.contains("[memoria de ULTRON]"));
        assert!(ctx.contains("Supabase"));
        assert!(ctx.contains("Usuario: arregla el login"));
        assert!(ctx.contains("Asistente (claude): falta el token CSRF"));
    }

    #[test]
    fn el_contexto_solo_lleva_los_ultimos_turnos() {
        let turns: Vec<Turn> = (0..30)
            .map(|i| turno("user", "", &format!("mensaje {i}")))
            .collect();
        let ctx = build_context(&turns, None);
        assert!(ctx.contains("mensaje 29"), "falta el ultimo turno");
        assert!(!ctx.contains("mensaje 5"), "no deberia traer turnos viejos");
    }

    #[test]
    fn el_contexto_respeta_el_tope_de_caracteres() {
        let gordo = "a".repeat(5_000);
        let turns: Vec<Turn> = (0..10).map(|_| turno("user", "", &gordo)).collect();
        let ctx = build_context(&turns, None);
        assert!(
            ctx.chars().count() <= MAX_CONTEXTO_CHARS + 40,
            "contexto sin recortar: {} caracteres",
            ctx.chars().count()
        );
        // Se recorta por el principio: lo ultimo dicho sobrevive.
        assert!(ctx.starts_with("[…contexto anterior recortado…]"));
    }

    #[test]
    fn sin_memoria_ni_turnos_el_contexto_va_vacio() {
        // Caso negativo: un hilo nuevo no debe arrastrar cabeceras vacias que
        // solo gastan tokens.
        assert_eq!(build_context(&[], None), "");
    }

    #[test]
    fn el_id_de_hilo_no_puede_escaparse_de_la_carpeta() {
        for malo in ["../secreto", "a/b", "a\\b", "", &"x".repeat(65)] {
            assert!(thread_path(malo).is_err(), "deberia rechazar {malo:?}");
        }
        assert!(thread_path("hilo-01_test").is_ok());
    }

    #[test]
    fn acepta_la_eleccion_del_modelo_local() {
        let conocidos: Vec<String> = RelayConfig::default().order;
        assert_eq!(
            parse_choice("claude", &conocidos).as_deref(),
            Some("claude")
        );
        assert_eq!(
            parse_choice(
                "  ANTIGRAVITY
",
                &conocidos
            )
            .as_deref(),
            Some("antigravity")
        );
        assert_eq!(
            parse_choice("Yo usaria local para esto", &conocidos).as_deref(),
            Some("local")
        );
    }

    #[test]
    fn rechaza_una_eleccion_inventada() {
        // Caso negativo: el modelo puede devolver cualquier cosa. Un nombre
        // que no existe tiene que caer al orden configurado, no colarse.
        let conocidos: Vec<String> = RelayConfig::default().order;
        for raw in ["gpt-4", "", "no lo se", "deepseek", "!!!"] {
            assert!(parse_choice(raw, &conocidos).is_none(), "colo: {raw:?}");
        }
    }

    #[test]
    fn el_orden_por_defecto_deja_el_local_el_ultimo() {
        let cfg = RelayConfig::default();
        assert_eq!(cfg.order.first().map(String::as_str), Some("claude"));
        assert_eq!(cfg.order.last().map(String::as_str), Some("local"));
    }

    fn conocidos() -> Vec<String> {
        vec![
            "claude".into(),
            "codex".into(),
            "antigravity".into(),
            "local".into(),
        ]
    }

    #[test]
    fn de_varias_rutas_se_coge_la_ejecutable() {
        // Salida real de `where codex` en esta maquina (2026-09-21). La
        // primera linea NO es ejecutable: es el script de shell de npm.
        // Cogerla dejaba a codex sin arrancar y el relevo saltaba a claude.
        let donde = "C:\\npm\\codex\r\nC:\\npm\\codex.cmd\r\n";
        assert_eq!(elegir_ruta(donde), Some("C:\\npm\\codex.cmd"));
    }

    #[test]
    fn un_exe_gana_a_un_cmd() {
        let donde = "C:\\x\\cosa.cmd\nC:\\x\\cosa.exe\n";
        assert_eq!(elegir_ruta(donde), Some("C:\\x\\cosa.exe"));
    }

    #[test]
    fn sin_extension_vale_la_primera() {
        // En Linux los binarios no llevan extension: no se puede exigir una.
        assert_eq!(
            elegir_ruta("/usr/local/bin/claude\n"),
            Some("/usr/local/bin/claude")
        );
        assert_eq!(elegir_ruta("   \n\n"), None);
    }

    #[test]
    fn solo_los_shims_de_npm_pasan_por_cmd() {
        // Los .exe nativos van directos. Es lo que arregla Antigravity: por
        // `cmd /C` recibia el prompt cortado en el primer salto de linea.
        assert!(necesita_cmd(r"C:\Users\x\AppData\Roaming\npm\codex.cmd"));
        assert!(necesita_cmd(r"C:\algo\raro.BAT"));
        assert!(!necesita_cmd(r"C:\Users\x\AppData\Local\agy\bin\agy.exe"));
        assert!(!necesita_cmd(r"C:\Users\x\.local\bin\claude.exe"));
        assert!(!necesita_cmd("/usr/local/bin/claude"));
    }

    #[test]
    fn se_entiende_a_quien_se_le_pide_responder() {
        // Lo que el usuario escribio como ejemplo el 2026-09-21.
        for frase in [
            "Respóndeme con Codex",
            "respondeme con codex",
            "usa codex",
            "cambia a codex por favor",
            "pregúntaselo a codex",
        ] {
            assert_eq!(
                intencion_de_proveedor(frase, &conocidos()),
                Some(IntencionProveedor::Fijar("codex".into())),
                "no entendio: {frase}"
            );
        }
    }

    #[test]
    fn se_entiende_volver_al_reparto_normal() {
        for frase in ["Ahora respóndeme tú", "ahora respondeme tu", "decide tú"] {
            assert_eq!(
                intencion_de_proveedor(frase, &conocidos()),
                Some(IntencionProveedor::Soltar),
                "no entendio: {frase}"
            );
        }
    }

    #[test]
    fn nombrar_un_proveedor_de_pasada_no_cambia_nada() {
        // EL caso negativo que importa. El usuario fue explicito: "no cambiar
        // de modelo automaticamente porque el usuario simplemente haya
        // respondido a una pregunta de aclaracion". Si esto fallara, contar
        // que codex dio un error te sacaria de la conversacion con codex.
        for frase in [
            "codex me dio un error raro",
            "¿que opinas del modelo local?",
            "analiza este proyecto",
            "claude y codex son distintos",
            "",
        ] {
            assert_eq!(
                intencion_de_proveedor(frase, &conocidos()),
                None,
                "cambio con: {frase:?}"
            );
        }
    }

    #[test]
    fn un_parrafo_largo_no_es_una_orden() {
        // Una instruccion de cambio es corta. En un texto largo el nombre de
        // un proveedor es casi siempre una mencion.
        let largo = format!(
            "usa codex {}",
            "y ademas analiza todo esto con calma ".repeat(6)
        );
        assert!(largo.chars().count() > 120);
        assert_eq!(intencion_de_proveedor(&largo, &conocidos()), None);
    }

    #[test]
    fn un_proveedor_que_no_existe_no_se_fija() {
        // Caso negativo: pedir uno que no esta en la cadena no puede dejar el
        // hilo apuntando a algo que nadie sabe invocar.
        assert_eq!(intencion_de_proveedor("usa gemini", &conocidos()), None);
    }

    #[test]
    fn el_estado_no_ensena_proveedores_retirados() {
        // Caso real: relay-state.json guardaba el ultimo error de Gemini con
        // fecha del 2026-09-19 y la pantalla lo seguia pintando en rojo
        // despues de quitarlo. Un error de algo que ya no existe no es
        // informacion, es ruido.
        let mut estado = RelayState::new();
        for p in ["claude", "gemini", "local"] {
            estado.insert(p.to_string(), ProviderState::default());
        }
        let orden = vec!["claude".to_string(), "antigravity".to_string()];
        let limpio = limpiar_estado(estado, &orden);
        assert!(limpio.contains_key("claude"));
        // El local no esta en el orden y aun asi se queda: siempre existe.
        assert!(limpio.contains_key("local"));
        assert!(!limpio.contains_key("gemini"), "gemini seguia en el estado");
    }

    #[test]
    fn una_configuracion_vieja_con_gemini_se_migra() {
        // Caso real: el orden se guarda al tocar la pantalla del Router, asi
        // que casi todo el mundo tiene un relay.json con "gemini" dentro. Sin
        // migrarlo, el relevo intentaria un proveedor que ya no sabe invocar.
        let vieja = RelayConfig {
            order: vec!["claude".into(), "gemini".into(), "local".into()],
            disabled: vec!["gemini".into()],
        };
        let nueva = migrar_gemini(vieja);
        assert_eq!(nueva.order, vec!["claude", "antigravity", "local"]);
        assert_eq!(nueva.disabled, vec!["antigravity"]);
    }

    #[test]
    fn migrar_no_duplica_si_ya_estaban_los_dos() {
        // Caso negativo: si alguien ya habia añadido antigravity a mano, la
        // migracion no puede dejar el proveedor dos veces en la cadena (se
        // intentaria dos veces y se contaria dos veces el fallo).
        let mezcla = RelayConfig {
            order: vec!["antigravity".into(), "gemini".into(), "local".into()],
            disabled: Vec::new(),
        };
        let nueva = migrar_gemini(mezcla);
        assert_eq!(nueva.order, vec!["antigravity", "local"]);
    }

    #[test]
    fn los_adjuntos_separan_imagenes_y_no_repiten_carpetas() {
        let a = Adjuntos {
            rutas: vec![
                PathBuf::from("C:/x/foto.PNG"),
                PathBuf::from("C:/x/notas.md"),
                PathBuf::from("C:/y/plano.jpg"),
            ],
        };
        assert_eq!(a.imagenes().len(), 2);
        assert_eq!(a.carpetas().len(), 2);
        assert!(a.como_rutas().contains("notas.md"));
        assert!(Adjuntos::default().como_rutas().is_empty());
    }

    #[test]
    fn un_ok_borra_el_enfriamiento_y_un_aviso_de_cuota_lo_pone() {
        let mut st = RelayState::new();
        enfriar(
            &mut st,
            "claude",
            "usage limit reached, try again in 30 minutes",
        );
        let e = st.get("claude").unwrap().clone();
        assert_eq!(e.quota_strikes, 1);
        assert!(super::super::enrutado::enfriando(
            &e.cooldown_until,
            chrono::Utc::now()
        ));
        record_attempt(&mut st, "claude", "ok", "contesto");
        let e = st.get("claude").unwrap();
        assert!(e.cooldown_until.is_empty());
        assert_eq!(e.quota_strikes, 0);
    }

    /// Prueba REAL del relevo (gasta una peticion minima de cada proveedor y
    /// carga el modelo local). No corre en CI: `cargo test -- --ignored relevo_real`.
    #[test]
    #[ignore = "toca proveedores reales"]
    fn relevo_real_mide_las_dos_rutas() {
        let hilo = format!("prueba-relevo-{}", chrono::Utc::now().timestamp());
        let t0 = std::time::Instant::now();
        let r = ask(&hilo, "hola, que tal", None).expect("alguien contesta");
        println!(
            "[trivial] {} ms · decidio={} · contesto={} · saltados={:?}",
            t0.elapsed().as_millis(),
            r.decided_by,
            r.provider,
            r.skipped
                .iter()
                .map(|s| format!("{}:{}", s.provider, s.kind))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            r.decided_by, "reglas",
            "un saludo no debe consultar al modelo local"
        );

        let forzado = crate::maria::models::Eleccion {
            provider: "claude".into(),
            model: crate::maria::models::modelo_por_defecto("claude"),
            effort: "bajo".into(),
        };
        let t1 = std::time::Instant::now();
        let r = ask(&hilo, "responde solo con la palabra: listo", Some(&forzado))
            .expect("alguien contesta");
        println!(
            "[claude forzado] {} ms · contesto={} · texto={:?}",
            t1.elapsed().as_millis(),
            r.provider,
            r.text.chars().take(40).collect::<String>()
        );
        if let Ok(p) = thread_path(&hilo) {
            let _ = std::fs::remove_file(p);
        }
        let _ = crate::maria::threads::fijar_provider(&hilo, "");
    }

    #[test]
    fn se_reanuda_solo_si_nadie_mas_ha_hablado_desde_entonces() {
        use crate::maria::cli::Sesion;
        let g = SesionGuardada {
            id: "s1".into(),
            turnos: 4,
        };
        assert_eq!(
            decidir_sesion(Some(&g), "claude", 4, "nuevo"),
            Sesion::Reanudar("s1".into())
        );
        // Otro proveedor contesto en medio (o se edito el hilo): de cero.
        assert_eq!(
            decidir_sesion(Some(&g), "claude", 6, "nuevo"),
            Sesion::Nueva("nuevo".into())
        );
        assert_eq!(
            decidir_sesion(None, "codex", 0, "nuevo"),
            Sesion::Nueva(String::new())
        );
        let vacia = SesionGuardada {
            id: String::new(),
            turnos: 4,
        };
        assert_eq!(
            decidir_sesion(Some(&vacia), "codex", 4, "x"),
            Sesion::Nueva(String::new())
        );
    }

    /// Prueba REAL de la sesion continua con las tres CLI (gasta dos peticiones
    /// minimas de cada una). `cargo test -- --ignored sesion_real --nocapture`.
    #[test]
    #[ignore = "toca proveedores reales"]
    fn sesion_real_se_reanuda_en_las_tres_cli() {
        for provider in ["claude", "codex", "antigravity"] {
            let hilo = format!(
                "prueba-sesion-{provider}-{}",
                chrono::Utc::now().timestamp()
            );
            let forzado = crate::maria::models::Eleccion {
                provider: provider.into(),
                model: crate::maria::models::modelo_por_defecto(provider),
                effort: "bajo".into(),
            };
            let t0 = std::time::Instant::now();
            let r1 = ask(
                &hilo,
                "Recuerda el numero 4172. Responde solo: ok",
                Some(&forzado),
            );
            let ms1 = t0.elapsed().as_millis();
            let s1 = cargar_sesiones(&hilo).get(provider).cloned();
            let t1 = std::time::Instant::now();
            let r2 = ask(
                &hilo,
                "Que numero te dije? Responde solo con el numero.",
                Some(&forzado),
            );
            let ms2 = t1.elapsed().as_millis();
            let s2 = cargar_sesiones(&hilo).get(provider).cloned();
            println!(
                "[{provider}] t1={ms1} ms ({:?}) · t2={ms2} ms ({:?}) · sesion1={:?} · sesion2={:?}",
                r1.as_ref().map(|r| (r.provider.clone(), r.text.chars().take(20).collect::<String>())),
                r2.as_ref().map(|r| (r.provider.clone(), r.text.chars().take(20).collect::<String>())),
                s1,
                s2
            );
            if let Ok(pth) = thread_path(&hilo) {
                let _ = std::fs::remove_file(&pth);
                let _ = std::fs::remove_file(pth.with_extension("sesiones.json"));
                let _ = std::fs::remove_dir_all(pth.with_extension("trabajo"));
            }
        }
    }

    #[test]
    fn solo_una_linea_que_empieza_por_delegar_lanza_un_encargo() {
        let conocidos: Vec<String> = ["claude", "codex", "local"]
            .iter()
            .map(|s| (*s).into())
            .collect();
        let texto = "Hago yo el capitulo 1.\n@delegar codex: redacta el capitulo 2 en cap2.md\n- `@delegar local: resume las fuentes`\nFin.";
        let (resto, e) = encargos_en(texto, &conocidos);
        assert_eq!(e.len(), 2);
        assert_eq!(
            e[0],
            (
                "codex".to_string(),
                "redacta el capitulo 2 en cap2.md".to_string()
            )
        );
        assert_eq!(e[1].0, "local");
        assert!(!resto.contains("@delegar"));
        assert!(resto.starts_with("Hago yo") && resto.ends_with("Fin."));
        // Ni una mencion en mitad de frase, ni un proveedor inventado, ni un encargo vacio.
        let (r2, e2) = encargos_en(
            "puedes usar @delegar codex: x si quieres\n@delegar skynet: domina el mundo\n@delegar codex:   ",
            &conocidos,
        );
        assert!(e2.is_empty());
        assert!(r2.contains("skynet"));
    }

    #[test]
    fn la_conversacion_exportada_dice_quien_dijo_que() {
        let t = |role: &str, provider: &str, model: &str, text: &str| Turn {
            ts: "2026-09-21T18:57:03Z".into(),
            role: role.into(),
            provider: provider.into(),
            model: model.into(),
            effort: String::new(),
            text: text.into(),
        };
        let md = como_markdown(
            "Cachés",
            &[
                t("user", "", "", "hola"),
                t("assistant", "codex", "gpt", "buenas"),
            ],
        );
        assert!(md.starts_with("# Cachés\n"));
        assert!(md.contains("## Tú — 2026-09-21 18:57\n\nhola"));
        assert!(md.contains("## codex (gpt) — "));
        assert!(como_markdown("  ", &[]).starts_with("# Conversación"));
    }
}
