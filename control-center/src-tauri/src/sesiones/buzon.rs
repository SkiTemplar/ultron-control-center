// sesiones/buzon.rs — Buzón de operaciones backend → mod `ultron-puente`
// (contrato de estabilidad, §6.4).
//
// Entrega **al menos una vez**: una operación se reentrega en cada `inbox`
// (también a una generación nueva del mod) hasta recibir su `/v1/result`. El
// resultado es idempotente por `opId`: el segundo se ignora. Caducidad: sin
// resultado a los 10 min (5 s para `turn.abort`; 3 s para `prompt.read` y
// `prompt.clear`, cuyo llamante ya usó la reserva) se resuelve como
// `OpResult{ok:false, error:"sin respuesta del mod"}`. Cada operación viaja
// con esa caducidad como instante absoluto (`expiresAt`, ms desde la época
// UNIX): el mod no empieza una operación vencida y la contesta con `ok:false`
// («caducada»). Cada resolución se emite como `sesiones://op-result`, salvo
// las internas de G3 (`prompt.read`, `prompt.clear`), que no son del
// usuario. La lógica vive en `Buzon` con el reloj inyectado; las funciones
// libres (firmas congeladas en la fase 0a) usan la instancia global y el
// reloj real.
//
// Propiedad: WP-ESTADO.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::maquina::Ms;
use super::types::{ev, ConfigValue, OpResult};

/// Operación del buzón (§6.4). `opId` lo asigna `encolar_op`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all_fields = "camelCase")]
pub enum InboxOp {
    #[serde(rename = "command.run")]
    CommandRun {
        op_id: String,
        command: String,
        args: String,
    },
    #[serde(rename = "command.list")]
    CommandList { op_id: String },
    #[serde(rename = "config.list")]
    ConfigList { op_id: String },
    #[serde(rename = "config.set")]
    ConfigSet {
        op_id: String,
        key: String,
        value: ConfigValue,
    },
    #[serde(rename = "turn.abort")]
    TurnAbort { op_id: String, turn_id: String },
    #[serde(rename = "session.usage")]
    SessionUsage {
        op_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        breakdown: Option<String>,
    },
    #[serde(rename = "prompt.read")]
    PromptRead { op_id: String },
    #[serde(rename = "prompt.clear")]
    PromptClear { op_id: String },
}

impl InboxOp {
    fn op_id_mut(&mut self) -> &mut String {
        match self {
            Self::CommandRun { op_id, .. }
            | Self::CommandList { op_id }
            | Self::ConfigList { op_id }
            | Self::ConfigSet { op_id, .. }
            | Self::TurnAbort { op_id, .. }
            | Self::SessionUsage { op_id, .. }
            | Self::PromptRead { op_id }
            | Self::PromptClear { op_id } => op_id,
        }
    }

    pub fn op_id(&self) -> &str {
        match self {
            Self::CommandRun { op_id, .. }
            | Self::CommandList { op_id }
            | Self::ConfigList { op_id }
            | Self::ConfigSet { op_id, .. }
            | Self::TurnAbort { op_id, .. }
            | Self::SessionUsage { op_id, .. }
            | Self::PromptRead { op_id }
            | Self::PromptClear { op_id } => op_id,
        }
    }

    /// Operación interna de G3 (`caja.rs`) o de la recuperación: su
    /// resultado no se pinta en el chat.
    pub fn es_interna(&self) -> bool {
        matches!(self, Self::PromptRead { .. } | Self::PromptClear { .. })
    }

    /// Plazo sin resultado antes de darla por perdida. `prompt.read` y
    /// `prompt.clear` caducan con la espera de G3 (`caja.rs`): un
    /// `prompt.clear` vencido no puede ejecutarse tarde sobre una caja que ya
    /// contiene otra cosa.
    fn caducidad(&self) -> Ms {
        match self {
            Self::PromptRead { .. } | Self::PromptClear { .. } => ESPERA_CAJA_MS,
            Self::TurnAbort { .. } => 5_000,
            _ => 10 * 60_000,
        }
    }
}

/// Espera (y caducidad) de `prompt.read` y `prompt.clear`.
pub const ESPERA_CAJA_MS: Ms = 3_000;
/// Error de una operación sin respuesta del mod.
pub const SIN_RESPUESTA: &str = "sin respuesta del mod";
/// Error de una operación retirada porque venció la espera de quien la pidió.
pub const CANCELADA: &str = "cancelada: venció la espera";
const SIN_PUENTE: &str = "requiere el puente v2 (mod ultron-puente)";
/// Resultados que se recuerdan para la idempotencia y `esperar_resultado`.
const RECUERDO: Ms = 10 * 60_000;

/// Operación tal como viaja en `inbox`: la operación y su caducidad absoluta.
/// El mod descarta las vencidas antes de ejecutarlas; un mod antiguo ignora
/// el campo.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OpEnCable {
    #[serde(flatten)]
    pub op: InboxOp,
    #[serde(rename = "expiresAt")]
    pub expires_at: Ms,
}

struct Pendiente {
    sesion: String,
    op: InboxOp,
    encolada: Ms,
}

impl Pendiente {
    fn vence(&self) -> Ms {
        self.encolada.saturating_add(self.op.caducidad())
    }
}

#[derive(Default)]
struct Estado {
    /// Sesiones con puente v2 y su generación vigente.
    sesiones: HashMap<String, u32>,
    pendientes: Vec<Pendiente>,
    /// `opId` → (sesión, resultado, cuándo).
    resueltas: HashMap<String, (String, OpResult, Ms)>,
}

/// Operación resuelta (para emitir `sesiones://op-result`).
#[derive(Debug, Clone, PartialEq)]
pub struct Resuelta {
    pub sesion: String,
    pub op_id: String,
    pub resultado: OpResult,
    /// `prompt.read`/`prompt.clear`: no se emite a la interfaz (un
    /// `prompt.clear` cancelado no es un error del usuario, y un `prompt.read`
    /// correcto pintaría el texto de la caja como nota).
    pub interna: bool,
}

#[derive(Default)]
pub struct Buzon {
    estado: Mutex<Estado>,
    cambio: Condvar,
}

impl Buzon {
    fn lock(&self) -> Option<MutexGuard<'_, Estado>> {
        match self.estado.lock() {
            Ok(g) => Some(g),
            Err(_) => {
                tracing::error!("buzón del puente envenenado");
                None
            }
        }
    }

    /// La sesión tiene puente v2 con la generación `gen` (hello aceptado).
    /// Solo avanza: dos `hello` casi a la vez (`--resume`) pueden habilitar
    /// fuera de orden, y volver a la generación vieja dejaba el sondeo de la
    /// vigente en `stale`.
    pub fn habilitar(&self, id: &str, gen: u32) {
        if let Some(mut e) = self.lock() {
            let g = e.sesiones.entry(id.to_string()).or_insert(gen);
            *g = (*g).max(gen);
        }
        self.cambio.notify_all();
    }

    /// La sesión se fue: sus operaciones pendientes fallan.
    pub fn olvidar(&self, id: &str, ahora: Ms) -> Vec<Resuelta> {
        let mut out = Vec::new();
        if let Some(mut e) = self.lock() {
            e.sesiones.remove(id);
            let (suyas, resto): (Vec<Pendiente>, Vec<Pendiente>) =
                e.pendientes.drain(..).partition(|p| p.sesion == id);
            e.pendientes = resto;
            for p in suyas {
                out.push(resolver_en(&mut e, p, fallo("la sesión terminó"), ahora));
            }
        }
        self.cambio.notify_all();
        out
    }

    pub fn generacion(&self, id: &str) -> Option<u32> {
        self.lock().and_then(|e| e.sesiones.get(id).copied())
    }

    pub fn encolar(&self, id: &str, mut op: InboxOp, ahora: Ms) -> Result<String, String> {
        let mut e = self.lock().ok_or_else(|| "buzón envenenado".to_string())?;
        if !e.sesiones.contains_key(id) {
            return Err(SIN_PUENTE.to_string());
        }
        let op_id = uuid::Uuid::new_v4().to_string();
        *op.op_id_mut() = op_id.clone();
        e.pendientes.push(Pendiente {
            sesion: id.to_string(),
            op,
            encolada: ahora,
        });
        drop(e);
        self.cambio.notify_all();
        Ok(op_id)
    }

    /// Todas las operaciones sin resultado de la sesión, en orden.
    pub fn pendientes(&self, id: &str) -> Vec<InboxOp> {
        self.lock().map(|e| ops_de(&e, id)).unwrap_or_default()
    }

    /// Sondeo `inbox`: `None` si la generación es vieja (`stale`); si no,
    /// espera hasta `timeout` a que haya alguna operación. Cada una lleva su
    /// caducidad absoluta.
    pub fn esperar_pendientes(
        &self,
        id: &str,
        gen: u32,
        timeout: Duration,
    ) -> Option<Vec<OpEnCable>> {
        let fin = Instant::now() + timeout;
        let mut e = self.lock()?;
        loop {
            if e.sesiones.get(id).is_some_and(|g| *g != gen) {
                return None;
            }
            let ops = en_cable(&e, id);
            let ahora = Instant::now();
            if !ops.is_empty() || ahora >= fin {
                return Some(ops);
            }
            e = self.cambio.wait_timeout(e, fin - ahora).ok()?.0;
        }
    }

    /// `/v1/result`: idempotente; `None` si el `opId` ya estaba resuelto o
    /// no existe. Sin comprobar la sesión: solo lo usan los tests del buzón;
    /// el puente pasa por `resolver_de`.
    #[cfg(test)]
    pub fn resolver(&self, op_id: &str, r: OpResult, ahora: Ms) -> Option<Resuelta> {
        self.resolver_si(|_| true, op_id, r, ahora)
    }

    /// `resolver` desde el puente de `sesion`: una operación de otra sesión
    /// cuenta como desconocida (`None`) y sigue pendiente.
    pub fn resolver_de(
        &self,
        sesion: &str,
        op_id: &str,
        r: OpResult,
        ahora: Ms,
    ) -> Option<Resuelta> {
        self.resolver_si(|p| p.sesion == sesion, op_id, r, ahora)
    }

    fn resolver_si(
        &self,
        es_suya: impl Fn(&Pendiente) -> bool,
        op_id: &str,
        r: OpResult,
        ahora: Ms,
    ) -> Option<Resuelta> {
        let out = {
            let mut e = self.lock()?;
            let i = e
                .pendientes
                .iter()
                .position(|p| p.op.op_id() == op_id && es_suya(p))?;
            let p = e.pendientes.remove(i);
            resolver_en(&mut e, p, r, ahora)
        };
        self.cambio.notify_all();
        Some(out)
    }

    pub fn esperar_resultado(&self, op_id: &str, timeout: Duration) -> Option<OpResult> {
        let fin = Instant::now() + timeout;
        let mut e = self.lock()?;
        loop {
            if let Some((_, r, _)) = e.resueltas.get(op_id) {
                return Some(r.clone());
            }
            let ahora = Instant::now();
            if ahora >= fin {
                return None;
            }
            e = self.cambio.wait_timeout(e, fin - ahora).ok()?.0;
        }
    }

    /// Retira una operación que ya nadie espera (venció la espera de quien la
    /// pidió): si el mod aún no la había tomado, ya no la ve, y un resultado
    /// tardío cuenta como desconocido. Si ya la tomó, cancelar no la detiene:
    /// lo único que la frena es su `expiresAt`. `None` si ya estaba resuelta.
    pub fn cancelar(&self, op_id: &str, ahora: Ms) -> Option<Resuelta> {
        let out = {
            let mut e = self.lock()?;
            let i = e.pendientes.iter().position(|p| p.op.op_id() == op_id)?;
            let p = e.pendientes.remove(i);
            resolver_en(&mut e, p, fallo(CANCELADA), ahora)
        };
        self.cambio.notify_all();
        Some(out)
    }

    /// Resuelve como fallo las operaciones caducadas y olvida los
    /// resultados antiguos.
    pub fn caducar(&self, ahora: Ms) -> Vec<Resuelta> {
        let mut out = Vec::new();
        if let Some(mut e) = self.lock() {
            let (viejas, vivas): (Vec<Pendiente>, Vec<Pendiente>) =
                e.pendientes.drain(..).partition(|p| ahora >= p.vence());
            e.pendientes = vivas;
            for p in viejas {
                out.push(resolver_en(&mut e, p, fallo(SIN_RESPUESTA), ahora));
            }
            e.resueltas
                .retain(|_, (_, _, t)| ahora.saturating_sub(*t) < RECUERDO);
        }
        if !out.is_empty() {
            self.cambio.notify_all();
        }
        out
    }
}

fn ops_de(e: &Estado, id: &str) -> Vec<InboxOp> {
    e.pendientes
        .iter()
        .filter(|p| p.sesion == id)
        .map(|p| p.op.clone())
        .collect()
}

fn en_cable(e: &Estado, id: &str) -> Vec<OpEnCable> {
    e.pendientes
        .iter()
        .filter(|p| p.sesion == id)
        .map(|p| OpEnCable {
            op: p.op.clone(),
            expires_at: p.vence(),
        })
        .collect()
}

fn resolver_en(e: &mut Estado, p: Pendiente, mut r: OpResult, ahora: Ms) -> Resuelta {
    let op_id = p.op.op_id().to_string();
    let interna = p.op.es_interna();
    r.op_id = Some(op_id.clone());
    r.pending = false;
    e.resueltas
        .insert(op_id.clone(), (p.sesion.clone(), r.clone(), ahora));
    Resuelta {
        sesion: p.sesion,
        op_id,
        resultado: r,
        interna,
    }
}

fn fallo(error: &str) -> OpResult {
    OpResult {
        ok: false,
        error: Some(error.to_string()),
        ..OpResult::default()
    }
}

/// Payload de `sesiones://op-result`.
pub fn payload(r: &Resuelta) -> Value {
    json!({
        "id": r.sesion,
        "opId": r.op_id,
        "ok": r.resultado.ok,
        "value": r.resultado.value,
        "error": r.resultado.error,
        "text": r.resultado.text,
    })
}

// ---------------------------------------------------------------------------
// Instancia global (firmas congeladas en la fase 0a)
// ---------------------------------------------------------------------------

pub fn global() -> &'static Buzon {
    static B: OnceLock<Buzon> = OnceLock::new();
    B.get_or_init(Buzon::default)
}

/// Reloj real en ms desde la época UNIX.
pub fn ahora_ms() -> Ms {
    u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or_default()
}

fn emitir(rs: &[Resuelta]) {
    for r in rs.iter().filter(|r| !r.interna) {
        super::registro::emit(ev::OP_RESULT, payload(r));
    }
}

/// Encola `op` para la sesión y devuelve su `opId`. Err si la sesión no tiene
/// puente v2.
pub fn encolar_op(id: &str, op: InboxOp) -> Result<String, String> {
    global().encolar(id, op, ahora_ms())
}

/// Espera el resultado de `op_id` hasta `timeout`; `None` si no llegó.
pub fn esperar_resultado(op_id: &str, timeout: Duration) -> Option<OpResult> {
    global().esperar_resultado(op_id, timeout)
}

/// Operaciones sin `/v1/result` de la sesión, para el sondeo `inbox` de la
/// generación `generacion` (las de generaciones anteriores pasan a la nueva).
/// El endpoint `inbox` usa la variante con espera (`Buzon::esperar_pendientes`).
#[allow(
    dead_code,
    reason = "firma congelada en la fase 0a; la puede usar WP-PTY sin esperar"
)]
pub fn pendientes(id: &str, generacion: u32) -> Vec<InboxOp> {
    match global().generacion(id) {
        Some(g) if g == generacion => global().pendientes(id),
        _ => Vec::new(),
    }
}

/// Resultado publicado por el mod de `sesion` (`/v1/result`); idempotente
/// por `opId`. Solo resuelve operaciones de esa sesión.
pub fn resolver(sesion: &str, op_id: &str, r: OpResult) {
    match global().resolver_de(sesion, op_id, r, ahora_ms()) {
        Some(res) => emitir(&[res]),
        None => tracing::debug!(
            sesion,
            op_id,
            "resultado repetido, de una operación desconocida o de otra sesión"
        ),
    }
}

/// Retira `op_id` si sigue pendiente (`Buzon::cancelar`).
pub fn cancelar_op(op_id: &str) {
    if let Some(r) = global().cancelar(op_id, ahora_ms()) {
        emitir(&[r]);
    }
}

/// Caducidad de las operaciones sin resultado (la llama el seguidor).
pub fn caducar() {
    emitir(&global().caducar(ahora_ms()));
}

/// La sesión se cerró: sus operaciones pendientes fallan.
pub fn olvidar(id: &str) {
    emitir(&global().olvidar(id, ahora_ms()));
}

/// Ejecuta `op` por el buzón y espera hasta `espera`. Sin resultado a
/// tiempo: `OpResult{pending:true, opId}` (el final llega por
/// `sesiones://op-result`).
pub fn ejecutar(id: &str, op: InboxOp, espera: Duration) -> Result<OpResult, String> {
    let op_id = encolar_op(id, op)?;
    Ok(esperar_resultado(&op_id, espera).unwrap_or(OpResult {
        ok: true,
        pending: true,
        op_id: Some(op_id),
        ..OpResult::default()
    }))
}

#[cfg(test)]
#[path = "tests_buzon.rs"]
mod tests;
