// Registro de incidentes de Sessions (fiabilidad).
//
// Cada aviso `warn`/`error` del chat, cada error global de la ventana y cada
// atasco nuevo llega aquí desde el frontend (`sesiones_incident`) y se guarda
// como una línea JSON en `<logs>/sesiones-incidentes.jsonl`, junto con lo que
// solo el backend ve en ese instante: la máquina de estados de la sesión, sus
// herramientas abiertas y las filas visibles de la pantalla emulada de la TUI.
// Sin esto, cada fallo se diagnosticaba a partir de una captura de pantalla.
//
// - Varias ventanas de Sessions informan del mismo aviso: se descarta la
//   repetición de la misma sesión y el mismo texto durante `VENTANA_DEDUP`.
// - El fichero rota a `.1.jsonl` al pasar de `TOPE_BYTES`.
// - Es un fichero local de diagnóstico (lleva el cwd y lo que pinta la TUI);
//   no sale del equipo.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock, PoisonError};

use serde::Deserialize;
use serde_json::{json, Value};

use super::comandos::blocking;
use super::maquina::{iso, EstadoSesion, Ms};

/// Nombre del registro dentro de la carpeta de logs de la app.
pub const FICHERO: &str = "sesiones-incidentes.jsonl";
/// Al pasar de este tamaño el registro rota a `.1.jsonl` (se pisa el anterior).
const TOPE_BYTES: u64 = 5 * 1024 * 1024;
/// Misma sesión y mismo texto dentro de esta ventana: una sola línea.
const VENTANA_DEDUP: Ms = 10_000;
/// Claves recordadas para la deduplicación; por encima se purgan las viejas.
const MAX_CLAVES: usize = 256;
/// Tope de longitud del texto del aviso (un error puede traer un volcado).
const MAX_TEXTO: usize = 2_000;

/// Lo que manda el frontend (`IncidentReport` en `incidents.ts`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentReport {
    /// Sesión afectada; `None` en los errores globales de la ventana.
    pub id: Option<String>,
    /// `note`, `stall` o `error`.
    pub origin: String,
    /// `warn` o `error`.
    pub level: String,
    pub text: String,
}

/// Lo que solo el backend sabe de la sesión en el instante del aviso.
#[derive(Debug, Clone, Default)]
pub struct Contexto {
    pub info: Option<Value>,
    pub maquina: Option<Value>,
    pub pantalla: Vec<String>,
}

/// true si hay que escribir la línea: no se repite la misma clave dentro de
/// `VENTANA_DEDUP`. Anota la clave y purga las caducadas al pasar del tope.
pub fn debe_registrar(vistas: &mut HashMap<String, Ms>, clave: &str, ahora: Ms) -> bool {
    if let Some(&antes) = vistas.get(clave) {
        if ahora.saturating_sub(antes) < VENTANA_DEDUP {
            return false;
        }
    }
    vistas.insert(clave.to_string(), ahora);
    if vistas.len() > MAX_CLAVES {
        vistas.retain(|_, &mut t| ahora.saturating_sub(t) < VENTANA_DEDUP);
    }
    true
}

/// Resumen serializable de la máquina de estados de una sesión.
pub fn foto_maquina(e: &EstadoSesion, ahora: Ms) -> Value {
    let mut herramientas: Vec<Value> = e
        .herramientas
        .iter()
        .map(|(id, h)| {
            json!({
                "toolUseId": id,
                "nombre": h.nombre,
                "segundos": ahora.saturating_sub(h.desde) / 1000,
                "timeoutMs": h.timeout_ms,
            })
        })
        .collect();
    herramientas.sort_by_key(|h| std::cmp::Reverse(h["segundos"].as_u64().unwrap_or(0)));
    json!({
        "status": e.status,
        "pantalla": e.pantalla,
        "pantallaDesdeS": ahora.saturating_sub(e.pantalla_desde) / 1000,
        "ultimoProgresoS": ahora.saturating_sub(e.ultimo_progreso) / 1000,
        "protocolo": e.protocolo,
        "generacion": e.generacion,
        "turnoAbierto": e.turno.is_some(),
        "herramientas": herramientas,
        "stalled": e.stalled,
        "waiting": e.waiting,
        "interrumpiendo": e.interrumpiendo.is_some(),
        "reiniciando": e.reiniciando.is_some(),
        "pausaDrenaje": e.pausa_drenaje,
        "envioPendiente": e.envio_desde.is_some(),
    })
}

/// Filas visibles sin las vacías del final.
pub fn recortar_pantalla(mut filas: Vec<String>) -> Vec<String> {
    while filas.last().is_some_and(|f| f.trim().is_empty()) {
        filas.pop();
    }
    filas
}

fn recortar_texto(texto: &str) -> String {
    if texto.chars().count() <= MAX_TEXTO {
        return texto.to_string();
    }
    let mut corto: String = texto.chars().take(MAX_TEXTO).collect();
    corto.push('…');
    corto
}

/// Línea JSON del registro (sin salto final).
pub fn linea(r: &IncidentReport, ahora: Ms, ctx: &Contexto) -> String {
    json!({
        "ts": iso(ahora),
        "app": env!("CARGO_PKG_VERSION"),
        "sesion": r.id,
        "origen": r.origin,
        "nivel": r.level,
        "texto": recortar_texto(&r.text),
        "info": ctx.info,
        "maquina": ctx.maquina,
        "pantalla": ctx.pantalla,
    })
    .to_string()
}

/// Añade `linea` a `ruta`, rotando a `.1.jsonl` si el fichero pasa del tope.
pub fn anexar(ruta: &Path, linea: &str, tope: u64) -> std::io::Result<()> {
    if let Some(dir) = ruta.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::metadata(ruta).is_ok_and(|m| m.len() >= tope) {
        std::fs::rename(ruta, ruta.with_extension("1.jsonl"))?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(ruta)?;
    writeln!(f, "{linea}")
}

fn vistas() -> std::sync::MutexGuard<'static, HashMap<String, Ms>> {
    static V: OnceLock<Mutex<HashMap<String, Ms>>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn contexto_vivo(id: &str, ahora: Ms) -> Contexto {
    let info = super::registro::list()
        .into_iter()
        .find(|s| s.id == id)
        .and_then(|s| serde_json::to_value(s).ok());
    let maquina = super::registro::estado(id).map(|e| foto_maquina(&e, ahora));
    let pantalla = super::pantalla::monitor(id)
        .map(|m| recortar_pantalla(m.filas()))
        .unwrap_or_default();
    Contexto {
        info,
        maquina,
        pantalla,
    }
}

/// Registra un incidente. `Ok(false)` si era una repetición descartada.
pub fn registrar(r: &IncidentReport) -> Result<bool, String> {
    let ahora = super::buzon::ahora_ms();
    let clave = format!("{}|{}", r.id.as_deref().unwrap_or(""), r.text);
    if !debe_registrar(&mut vistas(), &clave, ahora) {
        return Ok(false);
    }
    let ctx =
        r.id.as_deref()
            .map(|id| contexto_vivo(id, ahora))
            .unwrap_or_default();
    let dir = crate::logs_dir().ok_or("no hay carpeta de datos locales en este sistema")?;
    anexar(&dir.join(FICHERO), &linea(r, ahora, &ctx), TOPE_BYTES)
        .map_err(|e| format!("no se pudo escribir el registro de incidentes: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub async fn sesiones_incident(report: IncidentReport) -> Result<(), String> {
    blocking(move || registrar(&report).map(|_| ())).await
}

#[cfg(test)]
#[path = "tests_incidentes.rs"]
mod tests;
