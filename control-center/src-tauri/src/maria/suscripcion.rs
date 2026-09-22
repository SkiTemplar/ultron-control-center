// mar.ia — que me deja usar MI suscripcion en cada proveedor.
//
// El usuario lo pidio el 2026-09-22: "debe saber la suscripcion que tengo de
// cada proveedor y ponerme los modelos que me permite acceder con esa
// suscripcion... ya que podria querer un opus 5, o un 4.6". Hasta hoy el
// catalogo era una constante de Rust, asi que pedir Fable 5.1 o un Opus 4.6
// era imposible: el id no estaba en la lista blanca y `relay` lo cambiaba por
// el modelo por defecto SIN DECIRLO.
//
// QUE SE LEE Y QUE NO (esto es lo que hay que mirar en una revision):
//   * claude — `~/.claude.json` (`additionalModelOptionsCache` es lo que el
//     servidor ofrece A ESTA CUENTA; `modelAccessCache` son las denegaciones)
//     y, del fichero de credenciales, UNICAMENTE `subscriptionType` y
//     `rateLimitTier`. Por aqui NO pasa ningun token: ni se lee, ni se
//     devuelve, ni se guarda. Esos caches los reescribe la propia CLI en cada
//     arranque, asi que basta con leer: cero red y cero cuota.
//   * codex — `~/.codex/models_cache.json` es el catalogo que el servidor
//     sirve a ESTA cuenta. El plan sale del claim `chatgpt_plan_type` del
//     `id_token`, decodificado sin verificar firma y SOLO para enseñar la
//     palabra ("free", "plus"...), igual que ya hace `cuentas::correo_en_jwt`.
//   * antigravity — `agy models` imprime la lista ya filtrada por la cuenta.
//     El nombre del plan de Google no se puede leer (solo esta en la TUI), asi
//     que lo unico que se afirma es si la cuenta es personal o de empresa,
//     leyendo `authMethod=` del log de su CLI. Nunca el correo.
//
// NADA DE ESTO ESTA EN EL CAMINO DE UN TURNO. Las sondas que lanzan un proceso
// (`codex debug models`, `agy models`) cuestan cientos de ms o segundos: solo
// corren desde `refrescar()`, que es el boton de la interfaz y el arranque.
// Lo que se lee en caliente es la CACHE en disco, y aun esa la memoiza
// `models::catalogo_vivo`.
//
// DEGRADACION (obligatoria): sin CLI, sin sesion, con los JSON borrados o
// rotos, todas las sondas devuelven una `Suscripcion` vacia y el catalogo se
// queda EXACTAMENTE como el de casa. Ninguna de las dos caches puede ser un
// requisito para contestar un mensaje.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

/// Lo que una cuenta permite en un proveedor, tal y como se guarda en disco.
///
/// Solo ids y etiquetas de plan: no hay ningun campo capaz de contener un
/// token, y eso es a proposito.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Suscripcion {
    pub provider: String,
    /// Etiqueta humana del plan ("Claude Pro", "ChatGPT Free"). Vacia = no se
    /// sabe, que es una respuesta valida y mejor que estimarla.
    #[serde(default)]
    pub plan: String,
    /// De donde salio el plan: nombre de fichero y campo, o el comando. Nunca
    /// un valor sensible.
    #[serde(default)]
    pub origen: String,
    /// Ids que la cuenta sirve HOY.
    #[serde(default)]
    pub permitidos: Vec<String>,
    /// Ids que la cuenta tiene vetados con evidencia (entitled:false).
    #[serde(default)]
    pub vetados: Vec<String>,
    /// RFC 3339 del sondeo.
    #[serde(default)]
    pub at: String,
}

/// Lo ultimo que contesto DE VERDAD un modelo concreto.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Veredicto {
    /// "ok" | "rechazado".
    pub estado: String,
    /// Frase del proveedor, ya recortada. Nunca un token.
    #[serde(default)]
    pub detalle: String,
    /// RFC 3339.
    #[serde(default)]
    pub at: String,
}

pub type Suscripciones = BTreeMap<String, Suscripcion>;
/// proveedor -> modelo -> veredicto.
pub type Veredictos = BTreeMap<String, BTreeMap<String, Veredicto>>;

const FICHERO_SUSCRIPCION: &str = "modelos-suscripcion.json";
const FICHERO_VEREDICTOS: &str = "modelos-veredictos.json";

/// Cuanto se da por bueno `models_cache.json` de codex antes de pedirle a la
/// CLI que lo refresque. 12 h: el propio codex tiene su TTL y refrescar cuesta
/// ~300 ms, asi que no merece la pena hacerlo mas a menudo.
const FRESCURA_CODEX: chrono::Duration = chrono::Duration::hours(12);

/// Tope de los dos procesos que se lanzan. Medido en esta maquina el
/// 2026-09-22: `codex debug models` ~290 ms, `agy models` ~2,2 s.
const TOPE_CODEX: Duration = Duration::from_secs(10);
const TOPE_AGY: Duration = Duration::from_secs(8);

// ---------------------------------------------------------------------------
// Cache en disco (patron `_en(dir)`: puro sobre una carpeta, como relay.rs)
// ---------------------------------------------------------------------------

fn carpeta() -> Option<PathBuf> {
    crate::maria::paths::cockpit("maria").ok()
}

fn json_de(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Lo ultimo que se sondeo, leido de `dir`. Un fichero roto NO es un error:
/// devuelve el mapa vacio y el catalogo se queda con lo de casa.
#[must_use]
pub fn cache_en(dir: &Path) -> Suscripciones {
    std::fs::read_to_string(dir.join(FICHERO_SUSCRIPCION))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn guardar_en(dir: &Path, v: &Suscripciones) {
    if let Ok(texto) = serde_json::to_string_pretty(v) {
        let _ = std::fs::write(dir.join(FICHERO_SUSCRIPCION), texto);
    }
}

#[must_use]
pub fn veredictos_en(dir: &Path) -> Veredictos {
    std::fs::read_to_string(dir.join(FICHERO_VEREDICTOS))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Apunta lo que acaba de pasar con un modelo concreto, en `dir`.
///
/// Solo se guarda el ULTIMO veredicto por (proveedor, modelo): lo que importa
/// es como esta ese id ahora, no su historia.
pub fn anotar_en(dir: &Path, provider: &str, model: &str, estado: &str, detalle: &str) {
    if provider.trim().is_empty() || model.trim().is_empty() {
        return; // modelo vacio = el que trae la CLI: no hay id del que opinar
    }
    let mut todos = veredictos_en(dir);
    todos.entry(provider.to_string()).or_default().insert(
        model.to_string(),
        Veredicto {
            estado: estado.to_string(),
            // El mismo recorte que `ProviderState::detail`: asi no cabe un
            // volcado largo, y mucho menos algo que hubiera que ocultar.
            detalle: crate::maria::relay::recorta(detalle.trim(), 200),
            at: chrono::Utc::now().to_rfc3339(),
        },
    );
    if let Ok(texto) = serde_json::to_string_pretty(&todos) {
        let _ = std::fs::write(dir.join(FICHERO_VEREDICTOS), texto);
    }
}

/// Lo ultimo que se sondeo. Lee disco; jamas lanza un proceso.
#[must_use]
pub fn cache() -> Suscripciones {
    carpeta().map(|d| cache_en(&d)).unwrap_or_default()
}

/// Los veredictos reales por modelo. Lee disco; jamas lanza un proceso.
#[must_use]
pub fn veredictos() -> Veredictos {
    carpeta().map(|d| veredictos_en(&d)).unwrap_or_default()
}

/// Apunta el veredicto y tira el catalogo memoizado para que se note ya.
pub fn anotar(provider: &str, model: &str, estado: &str, detalle: &str) {
    if let Some(d) = carpeta() {
        anotar_en(&d, provider, model, estado, detalle);
    }
    crate::maria::models::invalidar();
}

// ---------------------------------------------------------------------------
// Sondas puras (reciben lo ya leido: asi se prueban con ficheros de mentira)
// ---------------------------------------------------------------------------

fn ahora() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Etiqueta humana del plan de Claude, con la misma tabla que usa su CLI.
///
/// `tier` afina los Max (`default_claude_max_5x` -> "Claude Max 5x"), que es
/// justo la diferencia que al usuario le importa.
#[must_use]
pub fn plan_claude(tipo: &str, tier: &str) -> String {
    let t = tipo.trim().to_lowercase();
    if t.is_empty() {
        return String::new();
    }
    let sufijo = if t == "max" || t == "claude_max" {
        match tier.trim().to_lowercase() {
            x if x.contains("max_20x") => " 20x",
            x if x.contains("max_5x") => " 5x",
            _ => "",
        }
    } else {
        ""
    };
    let base = match t.as_str() {
        "enterprise" | "claude_enterprise" => "Claude Enterprise",
        "team" | "claude_team" => "Claude Team",
        "max" | "claude_max" => "Claude Max",
        "pro" | "claude_pro" => "Claude Pro",
        _ => return format!("Claude ({t})"),
    };
    format!("{base}{sufijo}")
}

/// Etiqueta humana del plan de ChatGPT.
#[must_use]
pub fn plan_codex(raw: &str) -> String {
    let t = raw.trim().to_lowercase();
    if t.is_empty() || t == "unknown" {
        return String::new();
    }
    match t.as_str() {
        "free" => "ChatGPT Free".into(),
        "plus" => "ChatGPT Plus".into(),
        "pro" => "ChatGPT Pro".into(),
        "team" => "ChatGPT Team".into(),
        "business" => "ChatGPT Business".into(),
        "edu" => "ChatGPT Edu".into(),
        "enterprise" => "ChatGPT Enterprise".into(),
        _ => format!("ChatGPT ({t})"),
    }
}

/// Que permite la cuenta de Claude, a partir de los DOS ficheros ya parseados.
///
/// Pura a proposito: recibe el JSON, no la ruta. Es la unica forma de probar
/// con ficheros de mentira sin tocar `~/.claude` de nadie.
///
/// Los dos ficheros pueden discrepar sobre el plan —en esta maquina, el
/// 2026-09-22, la credencial decia `pro` y el perfil `claude_max`— y la CLI
/// hace caso SOLO a la credencial. Asi que manda la credencial, y cuando el
/// perfil dice otra cosa se nombran LOS DOS en `origen`: elegir uno y callarse
/// el otro seria justo la mentira que este modulo viene a quitar.
#[must_use]
pub fn sonda_claude(
    claude_json: &serde_json::Value,
    credenciales: &serde_json::Value,
) -> Suscripcion {
    let oauth = credenciales.get("claudeAiOauth");
    let cred_tipo = oauth
        .and_then(|o| o.get("subscriptionType"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    let cred_tier = oauth
        .and_then(|o| o.get("rateLimitTier"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let perfil = claude_json.pointer("/oauthAccount/organizationType");
    let perfil_tipo = perfil
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    let perfil_tier = claude_json
        .pointer("/oauthAccount/organizationRateLimitTier")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");

    let (plan, mut origen) = if cred_tipo.is_empty() {
        (
            plan_claude(perfil_tipo, perfil_tier),
            ".claude.json (oauthAccount.organizationType)".to_string(),
        )
    } else {
        (
            plan_claude(cred_tipo, cred_tier),
            ".credentials.json (claudeAiOauth.subscriptionType)".to_string(),
        )
    };
    let del_perfil = plan_claude(perfil_tipo, perfil_tier);
    if !cred_tipo.is_empty() && !del_perfil.is_empty() && del_perfil != plan {
        origen.push_str(&format!(
            "; el perfil .claude.json (oauthAccount.organizationType) dice {del_perfil}, y la CLI \
             hace caso a la credencial"
        ));
    }

    // Lo que el SERVIDOR ofrece a esta cuenta ademas de los alias de siempre.
    let mut permitidos: Vec<String> = claude_json
        .get("additionalModelOptionsCache")
        .and_then(serde_json::Value::as_array)
        .map(|filas| {
            filas
                .iter()
                .filter_map(|f| f.get("value").and_then(serde_json::Value::as_str))
                .filter(|v| !v.trim().is_empty())
                .map(|v| v.trim().to_string())
                .collect()
        })
        .unwrap_or_default();

    // `modelAccessCache` es la lista de entitlements: `entitled:false` es la
    // UNICA evidencia de veto que Claude deja en disco. Vacia = sin restriccion.
    let mut vetados = Vec::new();
    if let Some(filas) = claude_json
        .get("modelAccessCache")
        .and_then(serde_json::Value::as_array)
    {
        for f in filas {
            let Some(id) = f
                .get("apiName")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            match f.get("entitled").and_then(serde_json::Value::as_bool) {
                Some(false) => vetados.push(id.to_string()),
                Some(true) => permitidos.push(id.to_string()),
                None => {}
            }
        }
    }
    permitidos.retain(|p| !vetados.contains(p));
    permitidos.dedup();

    Suscripcion {
        provider: "claude".into(),
        plan,
        origen,
        permitidos,
        vetados,
        at: ahora(),
    }
}

/// Que permite la cuenta de Codex, a partir de `models_cache.json` ya parseado
/// y del plan (que viene de otro sitio: el claim del `id_token`).
///
/// Solo entran los de `visibility == "list"`, ordenados por `priority` de menor
/// a mayor (menor = mas capaz). Los "hide" —`gpt-reserve`, `codex-auto-review`—
/// el servidor SI los sirve, pero no son modelos de chat: enseñarlos seria
/// ofrecer algo que no se puede elegir.
#[must_use]
pub fn sonda_codex(models_cache: &serde_json::Value, plan: Option<&str>) -> Suscripcion {
    let mut filas: Vec<(i64, String)> = models_cache
        .get("models")
        .and_then(serde_json::Value::as_array)
        .map(|ms| {
            ms.iter()
                .filter(|m| m.get("visibility").and_then(serde_json::Value::as_str) == Some("list"))
                .filter_map(|m| {
                    let slug = m
                        .get("slug")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())?;
                    let prioridad = m
                        .get("priority")
                        .and_then(serde_json::Value::as_i64)
                        .unwrap_or(i64::MAX);
                    Some((prioridad, slug.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    filas.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

    let etiqueta = plan.map(plan_codex).unwrap_or_default();
    Suscripcion {
        provider: "codex".into(),
        origen: if etiqueta.is_empty() {
            String::new()
        } else {
            "auth.json (id_token: chatgpt_plan_type)".into()
        },
        plan: etiqueta,
        permitidos: filas.into_iter().map(|(_, s)| s).collect(),
        vetados: Vec::new(),
        at: ahora(),
    }
}

/// Que permite la cuenta de Antigravity, a partir del TSV de `agy models`.
///
/// El formato es `id<TAB>etiqueta` por linea. El spinner de la CLI va por
/// stderr, pero se filtra igualmente todo lo que no tenga tabulador: una
/// version futura que escupa adorno por stdout no debe colar un id inventado
/// en una linea de comandos.
///
/// Sin sesion, `agy models` imprime vacio. Eso NO es "la cuenta no permite
/// nada": es "no se sabe", y por eso se devuelve la lista vacia y el catalogo
/// se queda con el de casa.
#[must_use]
pub fn sonda_antigravity(tsv: &str) -> Suscripcion {
    let permitidos: Vec<String> = tsv
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(id, _)| id.trim().to_string())
        .filter(|id| crate::maria::models::id_con_forma_de_modelo(id))
        .collect();
    Suscripcion {
        provider: "antigravity".into(),
        plan: String::new(),
        origen: String::new(),
        permitidos,
        vetados: Vec::new(),
        at: ahora(),
    }
}

/// Cuenta personal o de empresa, leyendo SOLO `authMethod=` del log de `agy`.
///
/// El nombre del plan de Google (Free / Pro / Ultra) no esta en ningun fichero:
/// la CLI solo lo pinta en su TUI y en `/usage`, que son interactivos. Asi que
/// esto es lo unico que se puede afirmar sin inventar. La linea del log lleva
/// tambien el correo: NO se lee, no se guarda y no sale de aqui.
#[must_use]
pub fn plan_antigravity(log: &str) -> String {
    let mut ultimo = "";
    for linea in log.lines() {
        if let Some(resto) = linea.split("authMethod=").nth(1) {
            let valor = resto
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .next()
                .unwrap_or("");
            if !valor.is_empty() {
                ultimo = valor;
            }
        }
    }
    match ultimo.to_lowercase().as_str() {
        "consumer" => "Google (cuenta personal)".into(),
        "" | "unspecified" => String::new(),
        "business" | "enterprise" => "Google (cuenta de empresa)".into(),
        otro => format!("Google ({otro})"),
    }
}

// ---------------------------------------------------------------------------
// Lectura del disco y de las CLI
// ---------------------------------------------------------------------------

fn home_del_usuario() -> PathBuf {
    // OJO: `paths::home()` es la raiz de mar.ia (`~/.maria`), no la del
    // usuario. Las credenciales de las CLI cuelgan de la del usuario.
    dirs::home_dir().unwrap_or_default()
}

/// Salida estandar de un comando con tope de tiempo, o None si falla.
///
/// stderr se tira a proposito: el spinner de `agy` va por ahi y no aporta
/// nada. Se reutiliza la ruta que ya calcula el relevo, con su regla de
/// `cmd /C` solo para los shims de npm.
fn salida_de(bin: &str, args: &[&str], tope: Duration) -> Option<String> {
    let ruta = crate::maria::relay::ruta_de_cli(bin)?;
    let mut cmd = if crate::maria::relay::necesita_cmd(&ruta) {
        let mut c = crate::proc::oculto("cmd");
        c.arg("/C").arg(&ruta);
        c
    } else {
        crate::proc::oculto(&ruta)
    };
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut hijo = cmd.spawn().ok()?;
    let lector = hijo.stdout.take().map(|mut o| {
        std::thread::spawn(move || {
            let mut t = String::new();
            let _ = o.read_to_string(&mut t);
            t
        })
    });
    let inicio = Instant::now();
    loop {
        match hijo.try_wait() {
            Ok(Some(estado)) => {
                let texto = lector.and_then(|h| h.join().ok()).unwrap_or_default();
                return estado.success().then_some(texto);
            }
            Ok(None) => {
                if inicio.elapsed() > tope {
                    let _ = hijo.kill();
                    let _ = hijo.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
}

/// Claude: solo ficheros. Cero red, cero cuota, cero procesos.
#[must_use]
pub fn claude_de_disco() -> Suscripcion {
    let home = home_del_usuario();
    let perfil = json_de(&home.join(".claude.json")).unwrap_or(serde_json::Value::Null);
    let cred =
        json_de(&home.join(".claude").join(".credentials.json")).unwrap_or(serde_json::Value::Null);
    sonda_claude(&perfil, &cred)
}

/// El plan de ChatGPT, sacado del `id_token` sin que el token salga de aqui.
fn plan_de_codex(auth: &serde_json::Value) -> Option<String> {
    for clave in ["id_token", "tokens"] {
        let nodo = auth.get(clave);
        let token = nodo
            .and_then(serde_json::Value::as_str)
            .or_else(|| nodo?.get("id_token")?.as_str());
        if let Some(p) = token.and_then(crate::maria::cuentas::plan_en_jwt) {
            return Some(p);
        }
    }
    None
}

/// Codex leyendo solo ficheros (para el informe de cuentas, que no puede
/// permitirse lanzar procesos).
#[must_use]
pub fn codex_de_disco() -> Suscripcion {
    let home = home_del_usuario();
    let cache =
        json_de(&home.join(".codex").join("models_cache.json")).unwrap_or(serde_json::Value::Null);
    let auth = json_de(&home.join(".codex").join("auth.json")).unwrap_or(serde_json::Value::Null);
    sonda_codex(&cache, plan_de_codex(&auth).as_deref())
}

/// ¿Se le puede seguir creyendo a `models_cache.json`?
fn cache_codex_fresca(v: &serde_json::Value, ahora: chrono::DateTime<chrono::Utc>) -> bool {
    v.get("fetched_at")
        .and_then(serde_json::Value::as_str)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|d| {
            ahora.signed_duration_since(d.with_timezone(&chrono::Utc)) < FRESCURA_CODEX
        })
}

/// Codex con refresco: si el catalogo falta o esta viejo, se le pide a la CLI
/// que lo rehaga. `codex debug models` NO gasta cuota (solo baja el catalogo).
#[must_use]
pub fn codex_refrescado() -> Suscripcion {
    let ruta = home_del_usuario().join(".codex").join("models_cache.json");
    let viejo = json_de(&ruta).unwrap_or(serde_json::Value::Null);
    if !cache_codex_fresca(&viejo, chrono::Utc::now()) {
        let _ = salida_de("codex", &["debug", "models"], TOPE_CODEX);
    }
    codex_de_disco()
}

/// Antigravity preguntandole a su CLI. Es la unica fuente que hay.
#[must_use]
pub fn antigravity_de_cli() -> Suscripcion {
    let tsv = salida_de("agy", &["models"], TOPE_AGY).unwrap_or_default();
    let mut s = sonda_antigravity(&tsv);
    let log = leer_cola(
        &home_del_usuario()
            .join(".gemini")
            .join("antigravity-cli")
            .join("cli.log"),
        64 * 1024,
    );
    s.plan = plan_antigravity(&log);
    if !s.plan.is_empty() {
        s.origen = "antigravity-cli/cli.log (authMethod)".into();
    }
    s
}

/// Ultimos `max` bytes de un fichero, como texto. El log de `agy` crece sin
/// tope y lo unico que interesa es la ultima sesion.
fn leer_cola(path: &Path, max: u64) -> String {
    let Ok(datos) = std::fs::read(path) else {
        return String::new();
    };
    let desde = datos
        .len()
        .saturating_sub(usize::try_from(max).unwrap_or(usize::MAX));
    String::from_utf8_lossy(&datos[desde..]).into_owned()
}

/// Sondea los tres proveedores, guarda el resultado y lo devuelve.
///
/// BLOQUEANTE (lanza dos procesos): va siempre dentro de `spawn_blocking` y
/// NUNCA en el camino de un turno.
///
/// Una sonda que falla no borra lo que ya se sabia: se parte de la cache y
/// solo se pisa la entrada de quien ha contestado algo. Si `agy` esta sin
/// sesion hoy, es mejor la lista de ayer —con su fecha a la vista— que un
/// selector vacio.
pub fn refrescar() -> Suscripciones {
    let mut out = cache();
    for s in [claude_de_disco(), codex_refrescado(), antigravity_de_cli()] {
        if s.permitidos.is_empty() && s.vetados.is_empty() && s.plan.is_empty() {
            continue; // la sonda no ha averiguado nada: no se pisa lo anterior
        }
        out.insert(s.provider.clone(), s);
    }
    if let Some(d) = carpeta() {
        guardar_en(&d, &out);
    }
    crate::maria::models::invalidar();
    out
}

/// Lo que se sabe del plan SIN lanzar un proceso: la cache, con los dos
/// ficheros de Claude y Codex releidos por encima (son gratis).
///
/// Lo usa el informe de cuentas, que se abre a mano y no puede quedarse
/// esperando 2 s a `agy models`.
#[must_use]
pub fn planes_en_disco() -> Suscripciones {
    let mut out = cache();
    for s in [claude_de_disco(), codex_de_disco()] {
        if s.plan.is_empty() && s.permitidos.is_empty() {
            continue;
        }
        out.insert(s.provider.clone(), s);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::load_fixture;

    fn json(nombre: &str) -> serde_json::Value {
        serde_json::from_str(&load_fixture("modelos", nombre)).expect("fixture ilegible")
    }

    #[test]
    fn de_claude_salen_el_plan_y_los_modelos_extra_de_la_cuenta() {
        let s = sonda_claude(&json("claude-json.json"), &json("claude-credenciales.json"));
        assert_eq!(s.provider, "claude");
        // Manda la credencial: es a la que hace caso la propia CLI.
        assert_eq!(s.plan, "Claude Pro");
        assert!(
            s.origen.contains("credentials.json"),
            "sin origen del plan: {}",
            s.origen
        );
        // Y cuando el perfil dice otra cosa, se nombran los dos.
        assert!(
            s.origen.contains("Claude Max 5x"),
            "se ha callado la discrepancia: {}",
            s.origen
        );
        assert!(s.permitidos.iter().any(|p| p == "claude-fable-5-1[1m]"));
        assert!(s.permitidos.iter().any(|p| p == "claude-opus-5"));
        // entitled:false es la unica evidencia de veto que deja Claude.
        assert_eq!(s.vetados, vec!["claude-mythos-5".to_string()]);
        assert!(
            !s.permitidos.iter().any(|p| p == "claude-mythos-5"),
            "un vetado no puede salir tambien como permitido"
        );
    }

    #[test]
    fn sin_ficheros_claude_no_se_inventa_nada() {
        // Degradacion: los dos JSON borrados o rotos.
        let s = sonda_claude(&serde_json::Value::Null, &serde_json::Value::Null);
        assert!(s.plan.is_empty(), "plan inventado: {}", s.plan);
        assert!(s.permitidos.is_empty() && s.vetados.is_empty());
    }

    #[test]
    fn de_codex_solo_salen_los_visibles_y_por_prioridad() {
        let s = sonda_codex(&json("codex-models-cache.json"), Some("free"));
        assert_eq!(s.plan, "ChatGPT Free");
        // Orden por `priority` ascendente y SIN los `hide`: `gpt-reserve`
        // (priority 3) tiene mejor prioridad que todos y aun asi no sale,
        // porque no es un modelo que se pueda elegir.
        assert_eq!(
            s.permitidos,
            vec![
                "gpt-5.6-terra".to_string(),
                "gpt-5.6-luna".to_string(),
                "gpt-5.5".to_string()
            ]
        );
        assert!(
            s.vetados.is_empty(),
            "un `hide` no es un veto con evidencia"
        );
    }

    #[test]
    fn un_models_cache_roto_deja_codex_sin_lista_pero_con_plan() {
        let s = sonda_codex(&serde_json::Value::Null, Some("plus"));
        assert_eq!(s.plan, "ChatGPT Plus");
        assert!(s.permitidos.is_empty());
        // Y sin plan tampoco se inventa un origen.
        let mudo = sonda_codex(&serde_json::Value::Null, None);
        assert!(mudo.plan.is_empty() && mudo.origen.is_empty());
    }

    #[test]
    fn de_agy_salen_los_ids_y_se_tira_el_ruido() {
        let s = sonda_antigravity(&load_fixture("modelos", "agy-models.tsv"));
        // 14 son los que `agy models` devolvio de verdad el 2026-09-22 en esta
        // maquina; el resto del fichero es ruido a proposito.
        assert_eq!(s.permitidos.len(), 14, "{:?}", s.permitidos);
        assert!(s.permitidos.iter().any(|p| p == "gemini-3.1-pro-high"));
        // Los Claude que sirve Google SI entran: gastan la cuota de Google.
        assert!(s.permitidos.iter().any(|p| p == "claude-opus-4-6-thinking"));
        // Caso negativo: ni el spinner, ni una linea sin tabulador, ni un id
        // con forma rara pueden acabar en una linea de comandos.
        for malo in ["Loading models...", "rm -rf /", "gemini; whoami"] {
            assert!(
                !s.permitidos.iter().any(|p| p.contains(malo)),
                "ha colado {malo}"
            );
        }
    }

    #[test]
    fn sin_sesion_agy_no_dice_que_la_cuenta_no_permita_nada() {
        // Degradacion: `agy models` sin sesion imprime vacio. Eso es "no se
        // sabe", no "no tienes modelos".
        let s = sonda_antigravity("");
        assert!(s.permitidos.is_empty());
        assert!(s.vetados.is_empty(), "vacio no puede convertirse en veto");
    }

    #[test]
    fn el_plan_de_google_solo_dice_lo_que_el_log_dice() {
        let log = "server_oauth.go:196] applyAuthResult: authMethod=consumer, quotaProject=\n";
        assert_eq!(plan_antigravity(log), "Google (cuenta personal)");
        // Caso negativo: sin log, sin plan. Nunca se estima "Free" o "Pro".
        assert!(plan_antigravity("").is_empty());
        assert!(plan_antigravity("authMethod=unspecified").is_empty());
    }

    #[test]
    fn las_etiquetas_de_plan_no_se_inventan() {
        assert_eq!(plan_claude("max", "default_claude_max_5x"), "Claude Max 5x");
        assert_eq!(
            plan_claude("max", "default_claude_max_20x"),
            "Claude Max 20x"
        );
        assert_eq!(plan_claude("pro", "default_claude_ai"), "Claude Pro");
        assert!(plan_claude("", "").is_empty());
        // Un valor que no esta en la tabla se enseña tal cual, no se traduce
        // a uno que suene bien.
        assert_eq!(plan_claude("beta_cosa", ""), "Claude (beta_cosa)");
        assert_eq!(plan_codex("free"), "ChatGPT Free");
        assert!(plan_codex("unknown").is_empty());
    }

    #[test]
    fn la_cache_va_y_vuelve_y_un_fichero_roto_no_rompe_nada() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(cache_en(dir.path()).is_empty(), "sin fichero, mapa vacio");
        let mut m = Suscripciones::new();
        m.insert(
            "codex".into(),
            Suscripcion {
                provider: "codex".into(),
                plan: "ChatGPT Free".into(),
                origen: "auth.json (id_token: chatgpt_plan_type)".into(),
                permitidos: vec!["gpt-5.6-terra".into()],
                vetados: Vec::new(),
                at: "2026-09-22T10:00:00Z".into(),
            },
        );
        guardar_en(dir.path(), &m);
        assert_eq!(cache_en(dir.path()), m);
        // Caso negativo: JSON roto -> mapa vacio, nunca un panico.
        std::fs::write(dir.path().join(FICHERO_SUSCRIPCION), "{esto no es json").expect("escribir");
        assert!(cache_en(dir.path()).is_empty());
    }

    #[test]
    fn los_veredictos_se_apuntan_y_el_detalle_va_recortado() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(veredictos_en(dir.path()).is_empty());
        anotar_en(dir.path(), "codex", "gpt-5", "rechazado", &"x".repeat(500));
        anotar_en(dir.path(), "claude", "opus", "ok", "");
        let v = veredictos_en(dir.path());
        let r = &v["codex"]["gpt-5"];
        assert_eq!(r.estado, "rechazado");
        assert!(r.detalle.chars().count() <= 201, "{}", r.detalle.len());
        assert!(!r.at.is_empty(), "un veredicto sin fecha no puede caducar");
        assert_eq!(v["claude"]["opus"].estado, "ok");
        // Caso negativo: el modelo vacio es "el que traiga la CLI"; no hay id
        // del que opinar y no se apunta nada.
        anotar_en(dir.path(), "claude", "", "ok", "");
        assert!(!veredictos_en(dir.path())["claude"].contains_key(""));
    }

    #[test]
    fn la_cache_de_codex_caduca_a_las_doce_horas() {
        let ahora = chrono::DateTime::parse_from_rfc3339("2026-09-22T12:00:00Z")
            .expect("fecha")
            .with_timezone(&chrono::Utc);
        let fresca = serde_json::json!({ "fetched_at": "2026-09-22T11:00:00Z" });
        let vieja = serde_json::json!({ "fetched_at": "2026-09-21T10:00:00Z" });
        assert!(cache_codex_fresca(&fresca, ahora));
        assert!(!cache_codex_fresca(&vieja, ahora));
        // Sin campo, o con basura, se considera vieja: refrescar cuesta 300 ms
        // y creerse un fichero sin fecha cuesta enseñar modelos que ya no van.
        assert!(!cache_codex_fresca(&serde_json::json!({}), ahora));
        assert!(!cache_codex_fresca(
            &serde_json::json!({ "fetched_at": "ayer" }),
            ahora
        ));
    }
}
