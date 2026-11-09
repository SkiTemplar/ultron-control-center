// sesiones/caja.rs — G3 de un envío (contrato de estabilidad, §3.2): vaciar
// la caja de entrada de la TUI antes de reescribir el pegado.
//
// Con texto en la caja, el escritor rechaza el pegado (`EntradaConTexto`).
// Antes, el vaciado dependía solo del puente v2 (`prompt.read` +
// `prompt.clear`, 1 s por operación) y el reintento salía en el acto: si el
// buzón tardaba o la TUI aún no había repintado la caja vacía, el envío
// fallaba con «La entrada de la TUI tiene texto». Ahora:
// 1. Puente v2 con más margen. Lo que lee `prompt.read` es el texto exacto y
//    es el que se conserva aunque `prompt.clear` no responda. Cada operación
//    viaja con su caducidad absoluta (`expiresAt` = encolada + 3 s, la misma
//    espera de aquí): el mod no empieza una vencida y la contesta como
//    «caducada»; la que el mod aún no tomó se retira del buzón al vencer.
//    Lo que NO se garantiza: un `prompt.clear` que el mod empezó antes de
//    `expiresAt` y que la TUI aplica después puede caer aún sobre el
//    reintento (ventana del orden de lo que tarda la propia limpieza), y un
//    mod antiguo sin el campo la ejecuta tarde como antes.
// 2. Si el puente no limpia, Ctrl+U con la pantalla leída justo antes (no al
//    principio: entre medias pudo cambiar). Nunca con una lectura de
//    pantalla que pueda venir plegada (`[Pasted text …]`, `[Image #…]`) o
//    recortada (caja al tope de filas), ni si la caja cambió desde
//    `prompt.read`: entonces la caja se deja como está.
// 3. Solo vuelve a la cola el texto que salió de verdad de la caja. Con la
//    caja aún ocupada, el envío falla y el drenaje automático de la sesión
//    queda en pausa (`Pausas`) hasta que la caja cambie: sin bucles de un
//    Ctrl+U y un aviso por segundo con la app desatendida.
// 4. La lectura de la pantalla es una heurística (`pantalla.rs`); la de
//    `prompt.read`, el texto exacto. Si el puente lee la caja vacía (`""`,
//    sin `prompt.clear`; o solo espacios y `prompt.clear` confirmado) y la
//    pantalla aún muestra texto, es un falso positivo del clasificador
//    (placeholder o sugerencia en gris que no reconoció) o un repintado
//    pendiente: no se manda Ctrl+U, nada vuelve a la cola (ese texto no es
//    del usuario) y el reintento del pegado tolera exactamente ese texto de
//    pantalla (`Trabajo::Pegado::tolerada`). Solo si la pantalla muestra
//    exactamente el mismo texto antes y después de `prompt.read`: si cambió
//    entre las dos lecturas (el usuario escribió mientras el puente
//    contestaba), ese texto puede ser suyo y no se tolera; la caja se queda
//    como está, nada vuelve a la cola y el envío falla (Err `ocupada`, con
//    pausa). Si la caja cambia antes del reintento, G3 rechaza como siempre
//    (comparación exacta en el escritor); un menú abierto se rechaza
//    igualmente. Sin puente, o con una lectura no vacía, rigen los puntos 1-3.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::buzon;
use super::pantalla::MAX_FILAS_CAJA;
use super::types::OpResult;
use crate::pty::escritor::ErrorEscritura;

/// Espera de cada operación del buzón (`prompt.read`, `prompt.clear`): el mod
/// anota la operación en `$.state` antes y después de ejecutarla, y con la
/// TUI cargada 1 s se quedaba corto. Es también su caducidad en el buzón.
const ESPERA_BUZON: Duration = Duration::from_millis(buzon::ESPERA_CAJA_MS);
/// Tope de espera hasta que la pantalla muestra la caja vacía.
pub const ESPERA_VACIA: Duration = Duration::from_millis(1500);
const PASO: Duration = Duration::from_millis(50);
/// Con la caja igual, el drenaje automático vuelve a intentarlo como mucho
/// una vez por este plazo (por si la lectura de la pantalla era un falso
/// positivo): un Ctrl+U cada 10 min, no uno por segundo.
pub const REINTENTO_EN_PAUSA: Duration = Duration::from_secs(600);

/// Error cuando la caja no se pudo vaciar sin arriesgar su texto.
pub fn ocupada() -> String {
    format!(
        "{}: no se pudo vaciar sin arriesgar lo que hay escrito; se queda en la caja y la cola espera a que cambie",
        ErrorEscritura::EntradaConTexto
    )
}

/// Operaciones del buzón que usa G3 (inyectable en los tests).
pub trait BuzonOps {
    /// Encola `op` y espera su resultado; `None` si no llega o no hay buzón.
    fn op(&self, id: &str, op: buzon::InboxOp) -> Option<OpResult>;
}

pub struct BuzonReal;

impl BuzonOps for BuzonReal {
    fn op(&self, id: &str, op: buzon::InboxOp) -> Option<OpResult> {
        match buzon::encolar_op(id, op) {
            Ok(op_id) => {
                let r = buzon::esperar_resultado(&op_id, ESPERA_BUZON);
                if r.is_none() {
                    // Vencida: si el mod no la tomó, ya no la verá; si la
                    // tomó, la frena su `expiresAt` (ver la cabecera). Como
                    // operación interna, la cancelación no llega al chat.
                    buzon::cancelar_op(&op_id);
                }
                r
            }
            Err(e) => {
                tracing::debug!(sesion = id, error = %e, "buzón no disponible");
                None
            }
        }
    }
}

/// Lo que el vaciado necesita de la pantalla y del PTY (inyectable).
pub trait Pantalla {
    /// Texto de la caja según la pantalla emulada; `None` si está vacía.
    fn entrada(&self) -> Option<String>;
    /// Ctrl+U por el escritor del PTY.
    fn limpiar_linea(&self) -> Result<(), ErrorEscritura>;
    fn dormir(&self, d: Duration);
}

/// Respuesta del puente v2 a `prompt.read` + `prompt.clear`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Puente {
    /// Texto exacto de la caja según `prompt.read`; `None` sin puente o sin
    /// respuesta, `Some("")` con la caja vacía.
    pub leido: Option<String>,
    /// `prompt.clear` confirmó la limpieza.
    pub limpia: bool,
}

impl Puente {
    /// true si el puente afirma que la caja está vacía: `prompt.read` leyó
    /// `""` (no hizo falta limpiar) o solo espacios y `prompt.clear` lo
    /// confirmó. Sin lectura, false: no hay autoridad.
    pub fn vacia(&self) -> bool {
        self.leido
            .as_deref()
            .is_some_and(|t| t.is_empty() || (t.trim().is_empty() && self.limpia))
    }
}

/// Puente v2: `prompt.read` y, si leyó texto, `prompt.clear`. Sin lectura no
/// se limpia (el texto se perdería); con la caja vacía, no hace falta.
pub fn vaciar_caja(id: &str, v2: bool, b: &dyn BuzonOps) -> Puente {
    if !v2 {
        return Puente::default();
    }
    let leido = b
        .op(
            id,
            buzon::InboxOp::PromptRead {
                op_id: String::new(),
            },
        )
        .filter(|r| r.ok)
        .and_then(|r| r.value)
        .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(str::to_string));
    let Some(leido) = leido else {
        return Puente::default();
    };
    if leido.is_empty() {
        return Puente {
            leido: Some(leido),
            limpia: false,
        };
    }
    let limpia = b
        .op(
            id,
            buzon::InboxOp::PromptClear {
                op_id: String::new(),
            },
        )
        .is_some_and(|r| r.ok);
    Puente {
        leido: Some(leido),
        limpia,
    }
}

/// Resultado del vaciado: el texto que salió de la caja (para la cola; nunca
/// lo que sigue dentro) y si la caja acabó vacía: en la pantalla o, con
/// `tolerada`, según el puente aunque la pantalla muestre ese texto.
#[derive(Debug, PartialEq, Eq)]
pub struct Vaciado {
    pub texto: Option<String>,
    pub vacia: bool,
    /// Falso positivo de la pantalla (cabecera, punto 4): el texto que
    /// muestra en una caja que `prompt.read` lee vacía. El reintento del
    /// pegado no lo cuenta como caja ocupada.
    pub tolerada: Option<String>,
}

impl Vaciado {
    fn intacta() -> Self {
        Self {
            texto: None,
            vacia: false,
            tolerada: None,
        }
    }

    fn vaciada(texto: Option<String>) -> Self {
        Self {
            texto,
            vacia: true,
            tolerada: None,
        }
    }
}

/// Vacía la caja por el puente o, en su defecto, con un Ctrl+U, y espera a
/// que la pantalla lo refleje antes de dar paso al reintento del pegado.
pub fn liberar(id: &str, v2: bool, b: &dyn BuzonOps, p: &dyn Pantalla) -> Vaciado {
    // Lectura de la pantalla previa al puente (cabecera, punto 4).
    let antes_del_puente = if v2 { p.entrada() } else { None };
    let puente = vaciar_caja(id, v2, b);
    if puente.vacia() {
        return vacia_segun_puente(id, antes_del_puente.as_deref(), p);
    }
    let limpia = puente.limpia;
    let leido = puente.leido.filter(|t| !t.trim().is_empty());
    if limpia && esperar_vacia(p, ESPERA_VACIA) {
        return Vaciado::vaciada(leido);
    }
    // La pantalla se lee justo antes del Ctrl+U: las esperas del buzón
    // suman hasta 6 s y la caja pudo cambiar entre medias.
    let Some(antes) = p.entrada() else {
        // Vacía sin Ctrl+U (la limpió el puente tarde, o la CLI): lo que leyó
        // el puente se conserva.
        return Vaciado::vaciada(leido);
    };
    let conservar = match a_conservar(id, leido, limpia, &antes) {
        Ok(t) => t,
        Err(v) => return v,
    };
    tracing::info!(sesion = id, "G3: caja vaciada con Ctrl+U");
    if let Err(e) = p.limpiar_linea() {
        tracing::warn!(sesion = id, error = %e, "G3: Ctrl+U rechazado");
        return Vaciado::intacta();
    }
    if esperar_vacia(p, ESPERA_VACIA) {
        return Vaciado::vaciada(Some(conservar));
    }
    // Ctrl+U sin efecto: nada salió de la caja. Con efecto parcial (solo la
    // línea del cursor de una caja de varias), lo que salió solo está en
    // `conservar`: vuelve entero a la cola (un duplicado visible se borra; un
    // texto perdido no se recupera).
    let parcial = p.entrada().as_deref() != Some(antes.as_str());
    Vaciado {
        texto: parcial.then_some(conservar),
        ..Vaciado::intacta()
    }
}

/// El puente lee la caja vacía (cabecera, punto 4): nada salió de ella y
/// nada vuelve a la cola. Si la pantalla aún muestra texto, sin Ctrl+U (no
/// hay nada que borrar) y el reintento lo tolera, pero solo si es el mismo
/// texto exacto que mostraba antes de `prompt.read` (`antes`). Si cambió
/// entre las dos lecturas, pudo escribirlo el usuario mientras el puente
/// contestaba: la caja queda intacta y el envío falla.
fn vacia_segun_puente(id: &str, antes: Option<&str>, p: &dyn Pantalla) -> Vaciado {
    let Some(en_pantalla) = p.entrada() else {
        return Vaciado::vaciada(None);
    };
    if antes != Some(en_pantalla.as_str()) {
        tracing::warn!(
            sesion = id,
            "G3: prompt.read lee la caja vacía, pero la pantalla cambió durante la lectura; no se tolera ni se borra"
        );
        return Vaciado::intacta();
    }
    tracing::warn!(
        sesion = id,
        largo = en_pantalla.chars().count(),
        "G3: prompt.read lee la caja vacía y la pantalla muestra texto (falso positivo del clasificador); el pegado se reintenta tolerándolo"
    );
    Vaciado {
        tolerada: Some(en_pantalla),
        ..Vaciado::vaciada(None)
    }
}

/// Texto que se conservará si el Ctrl+U vacía la caja que ahora muestra
/// `antes`; Err con el resultado si no se debe mandar el Ctrl+U.
fn a_conservar(
    id: &str,
    leido: Option<String>,
    limpia: bool,
    antes: &str,
) -> Result<String, Vaciado> {
    let conservar = match leido {
        Some(t) if mismo_texto(&t, antes) => t,
        Some(t) if limpia => {
            // El puente sacó `t` y en la caja hay ya otro texto: `t` vuelve a
            // la cola y lo nuevo no se toca.
            tracing::warn!(
                sesion = id,
                "G3: tras prompt.clear la caja muestra otro texto"
            );
            return Err(Vaciado {
                texto: Some(t),
                ..Vaciado::intacta()
            });
        }
        Some(_) => {
            tracing::warn!(
                sesion = id,
                "G3: la caja cambió desde prompt.read; no se borra"
            );
            return Err(Vaciado::intacta());
        }
        None if recortada(antes) => {
            tracing::warn!(
                sesion = id,
                "G3: la caja llega al tope de filas; no se borra"
            );
            return Err(Vaciado::intacta());
        }
        None => antes.to_string(),
    };
    if plegada(&conservar) {
        tracing::warn!(
            sesion = id,
            "G3: la caja tiene un pegado plegado; no se borra"
        );
        return Err(Vaciado::intacta());
    }
    Ok(conservar)
}

/// G3 completo: vacía la caja (`liberar`), pasa a `recuperar` solo el texto
/// que salió de ella y, con la caja aún ocupada, pone en pausa el drenaje
/// automático de la sesión y devuelve Err. Ok si el pegado puede
/// reintentarse, con el texto de pantalla que el reintento debe tolerar
/// (`Some` solo en el falso positivo del punto 4 de la cabecera).
pub fn despejar(
    id: &str,
    v2: bool,
    b: &dyn BuzonOps,
    p: &dyn Pantalla,
    pausas: &Pausas,
    recuperar: &mut dyn FnMut(String),
) -> Result<Option<String>, String> {
    let v = liberar(id, v2, b, p);
    if let Some(texto) = v.texto {
        tracing::info!(
            sesion = id,
            largo = texto.chars().count(),
            "G3: el texto que había en la caja de la TUI vuelve a la cola"
        );
        recuperar(texto);
    }
    if v.vacia {
        pausas.levantar(id);
        return Ok(v.tolerada);
    }
    pausas.pausar(id, p.entrada(), Instant::now());
    tracing::warn!(
        sesion = id,
        "G3: la caja sigue ocupada; drenaje automático en pausa hasta que cambie"
    );
    Err(ocupada())
}

/// true si la pantalla muestra la caja vacía antes de `tope` (en pasos de
/// `PASO`, sin reloj: los tests no esperan de verdad).
pub fn esperar_vacia(p: &dyn Pantalla, tope: Duration) -> bool {
    let pasos = tope.as_millis() / PASO.as_millis();
    for _ in 0..pasos {
        if p.entrada().is_none() {
            return true;
        }
        p.dormir(PASO);
    }
    p.entrada().is_none()
}

/// Mismo texto salvo espacios y saltos: la pantalla recorta cada línea y
/// convierte el ajuste de línea en `\n`.
pub fn mismo_texto(a: &str, b: &str) -> bool {
    let sin = |t: &str| t.chars().filter(|c| !c.is_whitespace()).collect::<String>();
    sin(a) == sin(b)
}

/// La TUI pliega los pegados largos y las imágenes en un marcador: leído de
/// la pantalla, el contenido real no está.
pub fn plegada(t: &str) -> bool {
    t.contains("[Pasted text") || t.contains("[Image #")
}

/// Caja al tope de filas que reconoce `pantalla.rs`: puede faltar texto.
fn recortada(t: &str) -> bool {
    t.lines().count() >= MAX_FILAS_CAJA
}

/// true si, tras un envío, la caja sigue mostrando su texto: el Enter no
/// salió. Solo para el registro; no se reenvía nada.
pub fn enter_sin_salir(caja: Option<&str>, enviado: &str) -> bool {
    caja.is_some_and(|c| mismo_texto(c, enviado) || plegada(c))
}

// ---------------------------------------------------------------------------
// Pausa del drenaje con la caja ocupada
// ---------------------------------------------------------------------------

/// Sesiones cuyo vaciado falló: la lectura de la caja en ese momento y
/// cuándo. Mientras la caja muestre lo mismo, el drenaje automático no
/// vuelve a intentarlo (lo haría con el mismo resultado cada tick).
#[derive(Default)]
pub struct Pausas(Mutex<HashMap<String, (String, Instant)>>);

impl Pausas {
    /// Pausa con la caja tal como está; con la caja ya vacía, no hay pausa.
    pub fn pausar(&self, id: &str, entrada: Option<String>, ahora: Instant) {
        let Ok(mut g) = self.0.lock() else { return };
        match entrada {
            Some(e) => g.insert(id.to_string(), (e, ahora)),
            None => g.remove(id),
        };
    }

    pub fn levantar(&self, id: &str) {
        if let Ok(mut g) = self.0.lock() {
            g.remove(id);
        }
    }

    /// true mientras la caja muestre lo mismo que cuando falló el vaciado y
    /// no haya pasado `REINTENTO_EN_PAUSA`. Un cambio de la caja (o el plazo)
    /// levanta la pausa. `entrada` solo se lee si hay pausa.
    pub fn en_pausa(
        &self,
        id: &str,
        entrada: impl FnOnce() -> Option<String>,
        ahora: Instant,
    ) -> bool {
        let previa = match self.0.lock() {
            Ok(g) => g.get(id).cloned(),
            Err(_) => return false,
        };
        let Some((texto, desde)) = previa else {
            return false;
        };
        let igual = entrada().as_deref() == Some(texto.as_str());
        if igual && ahora.saturating_duration_since(desde) < REINTENTO_EN_PAUSA {
            return true;
        }
        self.levantar(id);
        false
    }
}

/// Pausas de todas las sesiones.
pub fn pausas() -> &'static Pausas {
    static P: OnceLock<Pausas> = OnceLock::new();
    P.get_or_init(Pausas::default)
}

#[cfg(test)]
#[path = "tests_caja.rs"]
mod tests;
