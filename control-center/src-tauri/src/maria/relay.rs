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
use std::path::{Path, PathBuf};
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    // Lo que costo el turno (2026-09-22). Todo `Option` + `#[serde(default)]`,
    // igual que se hizo con provider/model/effort: los hilos escritos antes de
    // que esto existiera se siguen leyendo igual. Vacio = el proveedor no lo
    // da, y la pantalla escribe "sin dato" en vez de una cifra inventada.
    /// Tokens de entrada, segun el proveedor.
    #[serde(default)]
    pub tokens_in: Option<u64>,
    /// Tokens de salida, segun el proveedor.
    #[serde(default)]
    pub tokens_out: Option<u64>,
    /// Estimacion en dolares del proveedor (solo Claude la publica).
    #[serde(default)]
    pub coste_usd: Option<f64>,
    /// Tiempo de pared del turno. Lo mide mar.ia, asi que lo hay siempre.
    #[serde(default)]
    pub ms: Option<u64>,
    /// Punto de control tomado ANTES de que corriera el proveedor (2026-09-22).
    /// Solo en el turno del ASISTENTE: es el estado al que devuelve «volver
    /// aqui». `None` cuando la conversacion no tiene proyecto, cuando el arbol
    /// era demasiado grande o cuando la foto fallo — en los dos ultimos casos
    /// la respuesta trae ademas el `aviso` de `RelayAnswer`. `#[serde(default)]`
    /// como el resto: los hilos escritos antes de hoy se siguen leyendo.
    #[serde(default)]
    pub punto: Option<String>,
    /// Modelo CONCRETO que contesto, si el proveedor lo dice ("claude-opus-5-5"
    /// cuando se pidio el alias `opus`). Vacio en hilos anteriores al
    /// 2026-09-23 y en proveedores que no lo publican.
    #[serde(default)]
    pub modelo_real: Option<String>,
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
    /// Consumo del turno tal cual lo publica el proveedor (`cli::Consumo`) y
    /// el tiempo medido aqui: lo mismo que se guarda en el hilo, para que la
    /// interfaz pinte el turno recien llegado sin releer el fichero. Hasta el
    /// 2026-09-22 la respuesta optimista salia con «tokens: sin dato» aunque
    /// el hilo en disco ya tuviera la cifra.
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
    pub coste_usd: Option<f64>,
    pub ms: Option<u64>,
    /// Lo que hay que contarle al usuario de este turno aunque haya contestado
    /// bien (2026-09-22). Hoy solo lo usa el punto de control: si no se ha
    /// podido fotografiar el proyecto, el turno sale igual pero SIN red de
    /// seguridad, y eso se dice. No es un `SkipReason`: no se ha descartado a
    /// nadie. `None` = no hay nada que advertir.
    pub aviso: Option<String>,
    /// Punto de control tomado antes de este turno (el mismo `Turn.punto`),
    /// para que la respuesta recien llegada ofrezca «volver» sin releer el
    /// hilo (2026-09-22: sin esto el enlace solo salia al reabrir la
    /// conversacion, igual que le paso al consumo).
    pub punto: Option<String>,
    /// El mismo `Turn.modelo_real`, para pintarlo sin releer el hilo.
    pub modelo_real: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkipReason {
    pub provider: String,
    /// "sin_cli" | "cuota" | "cuenta" | "enfriando" | "error" | "desactivado" |
    /// "timeout" | "modelo".
    pub kind: String,
    pub detail: String,
    /// Que puede HACER el usuario. Nunca vacio: un motivo de descarte sin
    /// siguiente paso obliga a adivinar (mandamiento 11).
    pub accion: String,
}

// ---------------------------------------------------------------------------
// Que hacer cuando un proveedor se cae
// ---------------------------------------------------------------------------
//
// Hasta el 2026-09-22 la pantalla decia "agy (CLI no instalada)" y ahi acababa
// todo. Peor: "sin_cli" y "timeout" estaban DOCUMENTADOS arriba como kinds
// posibles y no los producia nadie — los dos fallos caian en "error", asi que
// ni siquiera se distinguia el caso. El patron correcto ya estaba en casa:
// `maria/arranque.rs` comprueba las tres cosas que pueden fallar al arrancar
// con Windows y dice CUAL. Esto es trasladarlo al camino que se ve cada dia.

/// Clasifica el fallo de una CLI en uno de los `kind` de `SkipReason`.
///
/// Reconoce los mensajes que compone `cli::msg_sin_cli` / `cli::msg_timeout`.
/// Los tests atan una cosa a la otra: si alguien cambia el texto alli y no
/// aqui, saltan.
#[must_use]
pub fn clasifica_fallo(detail: &str, cuota: bool) -> &'static str {
    if cuota {
        return "cuota";
    }
    let t = detail.to_lowercase();
    if t.contains("no esta en el path") {
        "sin_cli"
    } else if t.contains("no respondio en") {
        "timeout"
    } else {
        "error"
    }
}

/// La hora local de una marca RFC 3339, para decirla en un mensaje. Cadena
/// vacia si no se entiende: mejor callarse la hora que inventarla.
#[must_use]
fn hora_corta(rfc: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(rfc.trim())
        .map(|d| {
            d.with_timezone(&chrono::Local)
                .format("las %H:%M")
                .to_string()
        })
        .unwrap_or_default()
}

/// Como se instala cada CLI. Solo el nombre del paquete: ni rutas, ni PATH.
fn como_se_instala(provider: &str) -> &'static str {
    match provider {
        "claude" => {
            "Instalala con `npm i -g @anthropic-ai/claude-code` y entra una vez con `claude`."
        }
        "codex" => "Instalala con `npm i -g @openai/codex` y entra con tu cuenta de ChatGPT.",
        "antigravity" | "agy" => {
            "Instala Antigravity desde antigravity.google y entra una vez con `agy`."
        }
        _ => "Instala su CLI y asegurate de que queda en el PATH.",
    }
}

/// Que puede hacer el usuario ante este descarte. Pura: se prueba sin red.
///
/// `hasta` es la marca RFC 3339 del enfriamiento, vacia si no aplica.
#[must_use]
pub fn consejo(provider: &str, kind: &str, hasta: &str) -> String {
    let cuando = hora_corta(hasta);
    match kind {
        "sin_cli" => format!(
            "{} Si no la vas a usar, apagala en el relevo y dejara de intentarlo.",
            como_se_instala(provider)
        ),
        "cuota" => {
            let vuelve = if cuando.is_empty() {
                "Se le vuelve a preguntar cuando pase el enfriamiento.".to_string()
            } else {
                format!("Se le vuelve a preguntar a partir de {cuando}.")
            };
            format!("Se ha quedado sin cuota y el relevo pasa al siguiente. {vuelve}")
        }
        "enfriando" => {
            let vuelve = if cuando.is_empty() {
                "Todavia esta en espera.".to_string()
            } else {
                format!("Vuelve a estar disponible a partir de {cuando}.")
            };
            format!("{vuelve} Para usarlo YA, fijalo a mano en el selector «proveedor».")
        }
        "timeout" => format!(
            "{provider} tardo mas de lo que se le espera. Vuelve a enviarlo con \
             /regenerar, o fija otro proveedor en el selector."
        ),
        "desactivado" => {
            format!("{provider} esta apagado en el relevo. Enciendelo si lo quieres de vuelta.")
        }
        // Hasta el 2026-09-22 este caso NO existia: cuando el modelo pedido no
        // valia para ese proveedor, el turno se contestaba con el modelo por
        // defecto y no quedaba rastro en ningun sitio. El usuario pedia un
        // Opus 5 y le respondia un sonnet sin que nadie se lo dijera.
        "modelo" => format!(
            "Ese modelo no se le ha podido pedir a {provider}, asi que ha contestado con el suyo \
             por defecto. Elige otro en el selector «modelo», o pulsa refrescar para volver a \
             preguntarle a tu cuenta que te deja usar."
        ),
        "cuenta" => format!(
            "La cuenta de {provider} no esta operativa (facturacion, sesion caducada o \
             verificacion pendiente) y esperar no lo arregla: vuelve a entrar con su CLI o \
             revisa la cuenta. Mientras, el relevo usa a los demas."
        ),
        _ if provider == "local" => {
            "El modelo local no contesto: casi siempre es que Ollama no esta levantado. \
             mar.ia lo arranca sola, asi que si sigue fallando comprueba `ollama list`."
                .to_string()
        }
        _ => format!(
            "{provider} fallo por algo que no es la cuota, asi que el relevo paso al \
             siguiente. Si se repite, fija otro proveedor en el selector."
        ),
    }
}

impl SkipReason {
    /// Descarte con su siguiente paso ya escrito.
    fn nuevo(provider: &str, kind: &str, detail: impl Into<String>, hasta: &str) -> Self {
        Self {
            provider: provider.to_string(),
            kind: kind.to_string(),
            detail: detail.into(),
            accion: consejo(provider, kind, hasta),
        }
    }
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
    maria_dir().map(|d| load_state_en(&d)).unwrap_or_default()
}

fn load_state_en(dir: &Path) -> RelayState {
    let bruto: RelayState = std::fs::read_to_string(dir.join("relay-state.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    limpiar_estado(bruto, &load_config_en(dir).order)
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

fn save_state_en(dir: &Path, state: &RelayState) {
    if let Ok(text) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(dir.join("relay-state.json"), text);
    }
}

/// Candado de proceso sobre `relay-state.json`: quien lo toca, lo carga, lo
/// cambia y lo guarda sin que nadie se cuele en medio.
static ESTADO_EN_FILA: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Todo cambio del estado pasa por aqui. Devuelve el estado tal y como queda.
///
/// Hasta el 2026-09-22 cada sitio cargaba su copia del estado y la volcaba
/// entera al terminar. En un turno de chat pasan minutos entre la carga y el
/// volcado, y entretanto el panel de inicio (cada 10 s) o una llamada interna
/// pueden enfriar a un proveedor: al guardar la copia vieja ese enfriamiento
/// se perdia. Con los avisos de los hooks era peor: la marca de "leido" ya
/// habia avanzado, asi que el aviso pisado no se releia nunca y el relevo
/// volvia a tropezar con Claude, justo lo que el aviso venia a evitar.
fn mutar_estado(f: impl FnOnce(&mut RelayState)) -> RelayState {
    maria_dir()
        .map(|d| mutar_estado_en(&d, f))
        .unwrap_or_default()
}

fn mutar_estado_en(dir: &Path, f: impl FnOnce(&mut RelayState)) -> RelayState {
    let _guardia = ESTADO_EN_FILA.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = load_state_en(dir);
    f(&mut state);
    save_state_en(dir, &state);
    state
}

/// Deja a un proveedor enfriando desde fuera del bucle del chat (las llamadas
/// internas tambien se topan con la cuota, y el chat debe enterarse).
pub(crate) fn enfriar_proveedor(provider: &str, detalle: &str) {
    mutar_estado(|state| {
        enfriar(state, provider, detalle);
        record_attempt(state, provider, "cuota", detalle);
    });
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

// ---------------------------------------------------------------------------
// Avisos de cuota de las sesiones que corren fuera de la aplicacion
// ---------------------------------------------------------------------------
//
// Hasta el 2026-09-22 el relevo solo descubria que Claude estaba sin cuota
// cuando la propia app lo intentaba y fallaba: varios segundos por turno en
// lanzar una CLI para que repitiera que no. Las sesiones de Claude Code que
// corren por su cuenta chocan con la MISMA cuota y eso no llegaba aqui.
//
// El hook `stopfailure-relay` (evento StopFailure, con matcher estrecho sobre
// los valores de `error` que hablan de disponibilidad) deja una linea por
// incidente en el JSONL de abajo. El contrato del formato esta escrito en la
// cabecera de ese script; la lectura tolera campos de mas y lineas rotas.
//
// Cada aviso se consume UNA vez: la marca de lo leido guarda el `ts` del ultimo
// que se vio, se aplicara o no.

/// Enfria a los proveedores de los que haya avisos nuevos. Devuelve cuantos se
/// aplicaron. Best-effort: sin fichero, o con el fichero ilegible, no pasa nada.
pub(crate) fn aplicar_senales_de_hooks() -> usize {
    maria_dir().map(|d| aplicar_senales_en(&d)).unwrap_or(0)
}

/// Un aviso con clase "cuenta" (facturacion, sesion caducada, verificacion
/// pendiente) no es una cuota que se pase esperando: se enfria igual para que
/// el relevo no insista, pero el estado dice "cuenta", que es lo que el
/// consejo del turno necesita para no mandar esperar por algo que no se
/// arregla esperando.
fn kind_de_senal(clase: &str) -> &'static str {
    if clase == "cuenta" {
        "cuenta"
    } else {
        "cuota"
    }
}

fn aplicar_senales_en(dir: &Path) -> usize {
    let jsonl = dir.join("relay-cuota.jsonl");
    let marca = dir.join("relay-cuota.leido");
    let Ok(texto) = std::fs::read_to_string(&jsonl) else {
        return 0; // sin avisos: el camino normal, el hook solo escribe si hay error
    };
    // Todo bajo el candado: dos lectores a la vez (el panel y un turno) leian
    // la misma marca y aplicaban el mismo aviso dos veces (doble strike).
    let _guardia = ESTADO_EN_FILA.lock().unwrap_or_else(|e| e.into_inner());
    let leido = std::fs::read_to_string(&marca).unwrap_or_default();
    let leido = leido.trim().to_string();
    let lote = super::enrutado::senales_nuevas(&texto, &leido, chrono::Utc::now());
    if lote.hasta == leido {
        return 0;
    }
    // Un aviso sobre un proveedor que aqui no existe no puede enfriar nada.
    let cfg = load_config_en(dir);
    let mut state = load_state_en(dir);
    let mut aplicados = 0;
    for s in &lote.aplicables {
        if !cfg.order.iter().any(|p| *p == s.proveedor) {
            continue;
        }
        let detalle = if s.detalle.is_empty() {
            format!("aviso de una sesion de Claude Code: {}", s.error)
        } else {
            format!(
                "aviso de una sesion de Claude Code: {} — {}",
                s.error, s.detalle
            )
        };
        enfriar(&mut state, &s.proveedor, &detalle);
        record_attempt(&mut state, &s.proveedor, kind_de_senal(&s.clase), &detalle);
        aplicados += 1;
    }
    if aplicados > 0 {
        save_state_en(dir, &state);
        tracing::info!(avisos = aplicados, "enfriados por avisos de hooks");
    }
    // La marca avanza DESPUES de guardar: si el proceso muere entre medias, el
    // aviso se relee en la siguiente pasada en vez de perderse.
    let _ = std::fs::write(&marca, &lote.hasta);
    aplicados
}

pub fn load_config() -> RelayConfig {
    maria_dir().map(|d| load_config_en(&d)).unwrap_or_default()
}

fn load_config_en(dir: &Path) -> RelayConfig {
    let cfg: RelayConfig = std::fs::read_to_string(dir.join("relay.json"))
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

/// ¿El proveedor ha rechazado el MODELO, y no la cuota ni la red?
///
/// Distinguirlo importa tanto como lo anterior, y en los dos sentidos: un
/// falso positivo apagaria un modelo bueno en el selector, y un falso negativo
/// dejaria a un proveedor sano enfriando horas por un id que solo hacia falta
/// cambiar.
///
/// Las señales son las frases REALES medidas el 2026-09-22 en esta maquina:
///   * codex  — "The 'gpt-5' model is not supported when using Codex with a
///              ChatGPT account." (HTTP 400)
///   * claude — "It may not exist or you may not have access to it." (404,
///              dentro de la linea `result` con `is_error:true`)
///   * agy    — "model X is not recognized as a known model or custom model
///              in settings" (validacion local, sin gastar peticion)
/// Pura y testeada, incluido el invariante de que no se pisa con
/// `is_quota_error`.
#[must_use]
pub fn es_modelo_rechazado(detail: &str) -> bool {
    let t = detail.to_lowercase();
    const SENALES: &[&str] = &[
        "not supported when using",
        "is not recognized as a known model",
        "may not exist or you may not have access",
        "unrecognized_model",
        "model not found",
        "model_not_found",
        "unknown model",
        "invalid model",
        "unsupported_model",
        "does not have access",
        "not available on your plan",
        "no such model",
        "not permitted by the org model restrictions",
        // La que compone `cli::msg_modelo_404` cuando Claude devuelve el 404
        // sin texto. Mismo trato que `msg_sin_cli` / `msg_timeout`: la frase se
        // escribe en un solo sitio y un test ata las dos puntas.
        "no tiene acceso al modelo elegido",
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
        // Sin los vetados: si el local elige uno, el turno saldria con
        // «modelo no permitido» sin que el usuario haya pedido nada.
        .map(|c| {
            c.models
                .iter()
                .filter(|m| m.permitido != crate::maria::models::Permitido::No)
                .map(|m| m.id.clone())
                .collect()
        })
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
            // Lo que la cuenta veta no se le ofrece al local para elegir.
            let ms: Vec<String> = c
                .models
                .iter()
                .filter(|m| m.permitido != crate::maria::models::Permitido::No)
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
    // El modelo de la regla va tal cual: si no vale, `ask_inner` cae al de
    // por defecto Y lo dice (SkipReason «modelo»). Sustituirlo aqui era el
    // ultimo cambiazo silencioso que quedaba (revision del 2026-09-22).
    let plan = crate::maria::models::Eleccion {
        provider: regla.provider.clone(),
        model: regla.model.clone(),
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
            // Un turno del usuario no consume nada: lo que se gasta es la
            // respuesta.
            ..Turn::default()
        },
    )?;

    let mut skipped: Vec<SkipReason> = Vec::new();
    // Antes de decidir el orden: lo que hayan visto las sesiones de Claude Code
    // que corren fuera de aqui. Si una se quedo sin cuota hace un minuto, no
    // hace falta volver a tropezar con ella en este turno.
    aplicar_senales_de_hooks();
    // Solo para LEER (quien esta frio). Los cambios van por `mutar_estado`,
    // que carga y guarda en el momento: esta copia envejece minutos.
    let state = load_state();
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
        let (hasta, kind) = state
            .get(p)
            .map(|e| {
                // Frio por la cuenta (facturacion, sesion caducada) no es lo
                // mismo que frio por cuota: el consejo cambia.
                let kind = if e.status == "cuenta" {
                    "cuenta"
                } else {
                    "enfriando"
                };
                (e.cooldown_until.clone(), kind)
            })
            .unwrap_or(("".to_string(), "enfriando"));
        let detalle = if kind == "cuenta" {
            format!("la cuenta no esta operativa; se le vuelve a probar a partir de {hasta}")
        } else {
            format!("sin cuota; se le vuelve a preguntar a partir de {hasta}")
        };
        skipped.push(SkipReason::nuevo(p, kind, detalle, &hasta));
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

    // La red de seguridad, ANTES de que corra nadie (2026-09-22). Con «Acceso
    // total» las tres CLI escriben en la carpeta del proyecto sin preguntar, y
    // hasta hoy lo unico que podia deshacerlo era el git del usuario a mano.
    // La foto se toma aqui, con el arbol todavia como lo dejo el, y una sola
    // vez para todo el turno: si el relevo salta de proveedor, el punto al que
    // se vuelve sigue siendo el de antes de empezar, que es el que el usuario
    // reconoce. `puntos::del_turno` no devuelve `Result` a proposito: que falle
    // la red no puede impedir que se conteste; se avisa y se sigue.
    let (punto, aviso) = crate::maria::puntos::del_turno(
        proyecto.as_deref(),
        thread_id,
        &crate::maria::puntos::etiqueta_turno(turnos_antes + 1, prompt),
    );

    for provider in &orden {
        if cfg.disabled.iter().any(|d| d == provider) {
            mutar_estado(|s| record_attempt(s, provider, "desactivado", "apagado en relay.json"));
            skipped.push(SkipReason::nuevo(
                provider,
                "desactivado",
                "apagado en relay.json",
                "",
            ));
            continue;
        }
        // El plan solo vale para el proveedor elegido; si el relevo salta a
        // otro, ese otro usa su modelo por defecto — pedirle "opus" a Gemini
        // seria pedirle un modelo que no tiene.
        let mismo = plan.as_ref().is_some_and(|p| {
            p.provider == *provider && crate::maria::models::modelo_valido(provider, &p.model)
        });
        // El cambiazo silencioso se acabo (2026-09-22): si el modelo se pidio
        // PARA ESTE proveedor y aun asi no se le puede pasar, se dice. Cuando
        // `mismo` es false porque el relevo ha saltado a otro proveedor no hay
        // nada que explicar: ahi el modelo nunca fue para este.
        if let Some(p) = plan
            .as_ref()
            .filter(|p| !mismo && p.provider == *provider && !p.model.trim().is_empty())
        {
            let (_, motivo) = crate::maria::models::estado_modelo(provider, &p.model);
            skipped.push(SkipReason::nuevo(
                provider,
                "modelo",
                format!("se pidió «{}»: {motivo}", p.model),
                "",
            ));
        }
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
        // Tiempo de pared del intento. Se mide AQUI y no dentro de cada CLI
        // porque es lo unico que se puede dar para los cuatro proveedores por
        // igual: los tokens dependen de que el proveedor los cuente.
        let reloj = std::time::Instant::now();
        let intento: Result<super::cli::Respuesta, (String, bool)> = if provider == "local" {
            let skills = if ajustes.compartir_skills {
                super::capacidades::indice_skills(prompt)
            } else {
                String::new()
            };
            super::local_agente::responder_con_consumo(
                thread_id,
                &format!("{skills}{completo}"),
                &esfuerzo,
                adjuntos,
                ajustes.acceso_total,
                trabajo.as_deref(),
            )
            .map(|(texto, consumo)| super::cli::Respuesta {
                texto,
                sesion: None,
                // Gratis, pero Ollama si publica sus tokens (2026-09-22).
                consumo,
                modelo_real: None,
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
                mutar_estado(|s| record_attempt(s, provider, "ok", "contesto"));
                // Que ESE modelo concreto conteste es la mejor evidencia que
                // hay de que la cuenta lo admite: mejor que cualquier lista.
                crate::maria::suscripcion::anotar(provider, &modelo, "ok", "");
                let ms = reloj.elapsed().as_millis() as u64;
                append_turn(
                    thread_id,
                    &Turn {
                        ts: chrono::Utc::now().to_rfc3339(),
                        role: "assistant".into(),
                        provider: provider.clone(),
                        model: modelo.clone(),
                        effort: esfuerzo.clone(),
                        text: text.clone(),
                        tokens_in: respuesta.consumo.tokens_in,
                        tokens_out: respuesta.consumo.tokens_out,
                        coste_usd: respuesta.consumo.coste_usd,
                        ms: Some(ms),
                        punto: punto.clone(),
                        modelo_real: respuesta.modelo_real.clone(),
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
                    tokens_in: respuesta.consumo.tokens_in,
                    tokens_out: respuesta.consumo.tokens_out,
                    coste_usd: respuesta.consumo.coste_usd,
                    ms: Some(ms),
                    aviso: aviso.clone(),
                    punto: punto.clone(),
                    modelo_real: respuesta.modelo_real.clone(),
                });
            }
            Err((detail, cuota)) => {
                // Parar no es un fallo del proveedor: ni se anota ni se releva.
                if crate::maria::flujo::cancelado(thread_id) {
                    return Err("parado".into());
                }
                // "sin_cli" y "timeout" se distinguen de un "error" cualquiera:
                // el siguiente paso no se parece en nada (instalar una CLI
                // frente a reintentar). Ver `clasifica_fallo`.
                let kind = clasifica_fallo(&detail, cuota);
                // Si lo que ha fallado es el MODELO y no la cuota, se apunta
                // ese id —y solo ese id— como rechazado, para que el selector
                // deje de ofrecerlo y el turno siguiente no lo vuelva a gastar.
                // Aqui NO se enfria al proveedor: el proveedor esta bien, el
                // que no vale es el modelo, y enfriarlo lo apagaria horas por
                // una eleccion que se arregla cambiando de fila en una lista.
                if !cuota && es_modelo_rechazado(&detail) {
                    crate::maria::suscripcion::anotar(
                        provider,
                        &modelo,
                        "rechazado",
                        &recorta(&detail, 200),
                    );
                }
                if cuota && provider == "claude" {
                    // Se aprende el tope practico de la ventana: el consumo
                    // que habia justo cuando el proveedor dijo basta.
                    let w = crate::maria::quota::claude_window();
                    crate::maria::quota::record_ceiling("claude", w.tokens);
                }
                let hasta = mutar_estado(|s| {
                    if cuota {
                        enfriar(s, provider, &detail);
                    }
                    record_attempt(s, provider, kind, &detail);
                })
                .get(provider.as_str())
                .map(|e| e.cooldown_until.clone())
                .unwrap_or_default();
                skipped.push(SkipReason::nuevo(provider, kind, detail, &hasta));
            }
        }
    }

    // Nadie ha contestado: es EL momento de decir que hacer, no de listar
    // codigos. Antes ponia "ningun proveedor pudo contestar: agy (error),
    // claude (cuota)" y el usuario se quedaba igual.
    Err(sin_respuesta(&skipped))
}

/// El mensaje de "no ha contestado nadie", con el siguiente paso de cada uno.
/// Pura: se prueba sin lanzar ninguna CLI.
#[must_use]
pub fn sin_respuesta(skipped: &[SkipReason]) -> String {
    if skipped.is_empty() {
        return "No hay ningun proveedor en el relevo al que preguntar. \
                Revisa el orden en Ajustes."
            .to_string();
    }
    let lineas: Vec<String> = skipped
        .iter()
        .map(|s| format!("· {} ({}): {}", s.provider, s.kind, s.accion))
        .collect();
    format!(
        "No ha contestado ninguno de los {} proveedores que se intentaron:\n{}",
        skipped.len(),
        lineas.join("\n")
    )
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
    // Se valida A LA ENTRADA y no 700 lineas despues: un modelo que sabemos
    // que la cuenta rechaza no merece que se lance una CLI, se espere y se
    // gaste un turno para oir otra vez que no.
    if let Some(e) = forzado.as_ref() {
        let (estado, motivo) = crate::maria::models::estado_modelo(&e.provider, &e.model);
        if estado == crate::maria::models::Permitido::No {
            return Err(format!(
                "«{}» no se le puede pedir a {}: {motivo}. Elige otro en el selector «modelo».",
                e.model, e.provider
            ));
        }
    }
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
    // Tambien aqui, y no solo al mandar un mensaje: el panel es donde el
    // usuario mira para saber por que no contesta Claude. Si el aviso solo se
    // leyera dentro del turno, el panel diria "ok" hasta que alguien escribe.
    aplicar_senales_de_hooks();
    Ok(load_state())
}

#[tauri::command]
pub async fn maria_relay_config() -> Result<RelayConfig, String> {
    Ok(load_config())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Los kinds que puede llevar un `SkipReason`. Si se anade uno, va aqui:
    /// el test de abajo comprueba que NINGUNO se queda sin consejo.
    const KINDS: &[&str] = &[
        "sin_cli",
        "cuota",
        "cuenta",
        "enfriando",
        "timeout",
        "desactivado",
        "error",
        "modelo",
    ];

    #[test]
    fn ningun_motivo_de_descarte_se_queda_sin_siguiente_paso() {
        for kind in KINDS {
            for p in ["claude", "codex", "antigravity", "local"] {
                let c = consejo(p, kind, "2026-09-22T18:30:00+02:00");
                assert!(!c.trim().is_empty(), "sin consejo: {p} / {kind}");
                assert!(
                    c.ends_with('.'),
                    "el consejo tiene que ser una frase entera: {c}"
                );
            }
        }
        // Caso negativo: un kind que nadie ha previsto tampoco puede dejar al
        // usuario sin nada que hacer (mandamiento 11).
        assert!(!consejo("claude", "loquesea", "").trim().is_empty());
    }

    #[test]
    fn el_consejo_de_cli_ausente_no_filtra_rutas_de_la_maquina() {
        // Repo publico (mandamiento 9): se dice el nombre del paquete, nunca
        // el PATH ni una carpeta del usuario.
        let c = consejo("antigravity", "sin_cli", "");
        assert!(c.contains("antigravity.google"), "sin instrucciones: {c}");
        assert!(!c.contains('\\') && !c.contains("C:"), "filtra ruta: {c}");
        assert!(consejo("codex", "sin_cli", "").contains("@openai/codex"));
    }

    #[test]
    fn la_cuota_dice_hasta_cuando() {
        let c = consejo("claude", "cuota", "2026-09-22T18:30:00+02:00");
        assert!(c.contains("sin cuota"), "{c}");
        // La hora sale en local, asi que solo se comprueba que la hay.
        assert!(c.contains("a partir de las"), "sin hora: {c}");
        // Sin marca valida no se inventa una hora.
        let sin = consejo("claude", "cuota", "");
        assert!(
            !sin.contains("a partir de las"),
            "se ha inventado la hora: {sin}"
        );
    }

    #[test]
    fn los_fallos_con_nombre_se_clasifican_y_no_caen_en_error() {
        // Ata `cli::msg_*` con el clasificador: si alguien cambia el texto de
        // uno sin tocar el otro, esto salta en vez de volver a "error" a secas.
        assert_eq!(
            clasifica_fallo(&crate::maria::cli::msg_sin_cli("agy"), false),
            "sin_cli"
        );
        assert_eq!(
            clasifica_fallo(&crate::maria::cli::msg_timeout("codex", 180), false),
            "timeout"
        );
        assert_eq!(clasifica_fallo("lo que sea", true), "cuota");
        // Caso negativo: un fallo cualquiera NO puede pasar por falta de CLI,
        // o la pantalla mandaria a instalar algo que ya esta instalado.
        assert_eq!(clasifica_fallo("connection reset by peer", false), "error");
        assert_eq!(clasifica_fallo("", false), "error");
    }

    #[test]
    fn un_modelo_rechazado_se_reconoce_por_las_frases_de_verdad() {
        // Las tres medidas en esta maquina el 2026-09-22, palabra por palabra.
        for real in [
            "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.",
            "There's an issue with the selected model (claude-mythos-5). It may not exist or you \
             may not have access to it. Run --model to pick a different model.",
            "error: invalid model selection (--model \"gemini-3.1-pro-medium\" --effort \"\"): \
             model gemini-3.1-pro-medium is not recognized as a known model or custom model in \
             settings",
        ] {
            assert!(es_modelo_rechazado(real), "no lo ve: {real}");
        }
        // Y la frase propia, la que se compone cuando Claude devuelve el 404
        // pelado. Si alguien la cambia en cli.rs sin tocar aqui, esto salta.
        assert!(es_modelo_rechazado(&crate::maria::cli::msg_modelo_404()));
    }

    #[test]
    fn la_cuota_y_el_modelo_no_se_pisan_nunca() {
        // INVARIANTE en los dos sentidos. Un falso positivo aqui apagaria un
        // modelo bueno en el selector; un falso negativo dejaria al proveedor
        // enfriando horas por un id que solo habia que cambiar.
        for cuota in [
            "Claude usage limit reached. Your limit will reset at 2pm.",
            "429 Too Many Requests",
            "insufficient_quota",
            "rate_limit_error",
            "resource_exhausted",
            "upgrade to continue",
        ] {
            assert!(is_quota_error(cuota), "deberia ser cuota: {cuota}");
            assert!(
                !es_modelo_rechazado(cuota),
                "una señal de cuota ha pasado por rechazo de modelo: {cuota}"
            );
        }
        for modelo in [
            "The 'gpt-5' model is not supported when using Codex with a ChatGPT account.",
            "model gemini-3.1-pro-medium is not recognized as a known model",
            "It may not exist or you may not have access to it.",
        ] {
            assert!(es_modelo_rechazado(modelo), "deberia ser modelo: {modelo}");
            assert!(
                !is_quota_error(modelo),
                "un rechazo de modelo enfriaria al proveedor entero: {modelo}"
            );
        }
        // Caso negativo: un fallo cualquiera no es ninguna de las dos cosas.
        for otro in [
            "connection reset by peer",
            "",
            "no pude lanzar codex: os error 2",
            // «model catalog» a secas era una senal (revision del 2026-09-22):
            // este fallo de red habria apagado el modelo siete dias.
            "error: failed to refresh model catalog: connection reset by peer",
        ] {
            assert!(
                !es_modelo_rechazado(otro) && !is_quota_error(otro),
                "{otro}"
            );
        }
    }

    #[test]
    fn cuando_no_contesta_nadie_se_dice_que_hacer_con_cada_uno() {
        let skips = vec![
            SkipReason::nuevo("antigravity", "sin_cli", "agy no esta en el PATH", ""),
            SkipReason::nuevo("claude", "cuota", "usage limit reached", ""),
        ];
        let msg = sin_respuesta(&skips);
        assert!(msg.contains("antigravity") && msg.contains("claude"));
        assert!(msg.contains("antigravity.google"), "sin el paso: {msg}");
        assert!(msg.contains("sin cuota"), "sin el paso: {msg}");
        // Caso negativo: sin descartes tampoco se devuelve una lista vacia.
        assert!(sin_respuesta(&[]).contains("relevo"));
    }

    #[test]
    fn el_punto_de_control_viaja_en_el_turno_y_los_hilos_viejos_se_siguen_leyendo() {
        // El contrato con la interfaz: el turno del ASISTENTE lleva el sha del
        // punto tomado antes de que corriera el proveedor, y un hilo escrito
        // antes de que este campo existiera se lee igual, con `punto` a None.
        // Sin `#[serde(default)]` la conversacion entera dejaria de cargar.
        let viejo: Turn = serde_json::from_str(
            r#"{"ts":"2026-09-21T10:00:00Z","role":"assistant","text":"hola"}"#,
        )
        .expect("un hilo de ayer tiene que seguir leyendose");
        assert_eq!(viejo.punto, None);

        let nuevo = Turn {
            ts: "2026-09-22T10:00:00Z".into(),
            role: "assistant".into(),
            text: "hecho".into(),
            punto: Some("0123456789abcdef0123456789abcdef01234567".into()),
            ..Turn::default()
        };
        let json = serde_json::to_string(&nuevo).expect("serializar");
        let leido: Turn = serde_json::from_str(&json).expect("releer");
        assert_eq!(leido.punto, nuevo.punto);
        // Y el turno del USUARIO no lo lleva: el punto es de antes de que
        // corriera el proveedor, no de antes de escribir el mensaje.
        assert_eq!(turno("user", "", "que tal").punto, None);
    }

    fn turno(role: &str, provider: &str, text: &str) -> Turn {
        Turn {
            ts: "2026-09-18T10:00:00Z".into(),
            role: role.into(),
            provider: provider.into(),
            model: String::new(),
            effort: String::new(),
            text: text.into(),
            ..Turn::default()
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
            ..Turn::default()
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

    fn senal(clase: &str, error: &str) -> String {
        format!(
            r#"{{"ts":"{}","proveedor":"claude","error":"{}","clase":"{}","detalle":"","sesion":null,"fuente":"stopfailure-relay"}}"#,
            chrono::Utc::now().to_rfc3339(),
            error,
            clase
        )
    }

    /// El fallo que arreglo el 2026-09-22: un turno cargaba su copia del
    /// estado, entretanto el panel aplicaba un aviso de cuota, y al acabar el
    /// turno volcaba la copia vieja. El aviso se perdia y, como la marca de
    /// leido ya habia avanzado, no se releia nunca.
    #[test]
    fn un_aviso_de_hooks_sobrevive_a_que_un_turno_guarde_lo_suyo() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        // El turno arranca y se queda con su foto del estado.
        let foto_del_turno = load_state_en(dir);
        assert!(foto_del_turno.get("claude").is_none());
        // Llega el aviso y el panel lo aplica.
        std::fs::write(dir.join("relay-cuota.jsonl"), senal("cuota", "rate_limit")).unwrap();
        assert_eq!(aplicar_senales_en(dir), 1);
        // El turno anota lo suyo por el camino nuevo: no pisa lo del panel.
        let tras = mutar_estado_en(dir, |s| record_attempt(s, "codex", "ok", "contesto"));
        let claude = tras.get("claude").expect("claude enfriado");
        assert!(
            !claude.cooldown_until.is_empty(),
            "se perdio el enfriamiento"
        );
        assert_eq!(claude.quota_strikes, 1);
        assert_eq!(claude.status, "cuota");
        assert_eq!(tras.get("codex").map(|e| e.status.as_str()), Some("ok"));
        // Caso negativo: el mismo aviso no se aplica dos veces (la marca
        // avanzo tras guardar) ni suma un segundo strike.
        assert_eq!(aplicar_senales_en(dir), 0);
        assert_eq!(load_state_en(dir).get("claude").unwrap().quota_strikes, 1);
        // Y lo que el turno habria hecho ANTES (volcar su foto) es exactamente
        // lo que borraba el aviso: el test fija que ese camino ya no existe
        // como API (`save_state` solo se llama desde `mutar_estado`).
        save_state_en(dir, &foto_del_turno);
        assert!(
            load_state_en(dir).get("claude").is_none(),
            "la foto vieja SI borra"
        );
    }

    #[test]
    fn un_aviso_de_cuenta_no_se_vende_como_cuota() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        std::fs::write(
            dir.join("relay-cuota.jsonl"),
            senal("cuenta", "billing_error"),
        )
        .unwrap();
        assert_eq!(aplicar_senales_en(dir), 1);
        let st = load_state_en(dir);
        let claude = st.get("claude").expect("claude anotado");
        assert_eq!(claude.status, "cuenta");
        assert!(
            !claude.cooldown_until.is_empty(),
            "tambien se enfria: insistir no ayuda"
        );
        // El consejo no manda esperar: eso no arregla una cuenta.
        let c = consejo("claude", "cuenta", &claude.cooldown_until);
        assert!(c.contains("cuenta") && !c.contains("a partir de"), "{c}");
        // Caso negativo: una clase desconocida cae en "cuota", nunca en "cuenta".
        assert_eq!(kind_de_senal("loquesea"), "cuota");
    }
}
