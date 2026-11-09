// sesiones/permiso_siempre.rs — «Permitir siempre» con regla real (H6,
// auditoría 2026-10-17).
//
// Antes el puente traducía `allowAlways` a `allow` y nadie guardaba nada: la
// herramienta volvía a preguntar en la llamada siguiente. Ahora, al abrir un
// ask de permiso, el backend deduce una regla concreta en la sintaxis de
// Claude Code (`Bash(<comando exacto>)`, `WebFetch(domain:<host>)`,
// `mcp__servidor__herramienta`…) y la anuncia en `always` con destino
// `localSettings`. Si no hay una regla concreta y segura, no se anuncia nada y
// la tarjeta no ofrece el botón. Al contestar `allowAlways`, la regla se añade
// a `permissions.allow` de `<cwd>/.claude/settings.local.json` (escritura
// atómica, sin duplicados) antes de contestar al puente; Claude Code vigila
// ese fichero (evento `ConfigChange` con `local_settings`). Si no se puede
// escribir, el ask sigue pendiente y la ventana recibe el motivo: nunca se
// contesta «siempre» sin haber guardado la regla.
//
// Un `always` que ya traiga el puente se respeta. Este módulo solo escribe
// los destinos de proyecto (`localSettings` y `projectSettings`); `session` y
// `userSettings` tendría que aplicarlos el puente (`updatedPermissions`), y
// hoy no lo hace: contestar «siempre» con esos destinos es un error explícito
// en vez de un «Permitir» disfrazado.
//
// Propiedad: WP-ESTADO.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Map, Value};

use super::persistencia::escribir_atomico;
use super::preguntas::PendingAsk;

/// Destino que anuncia el backend: el `settings.local.json` del proyecto, que
/// no se versiona.
pub const DESTINO_LOCAL: &str = "localSettings";
const DESTINO_PROYECTO: &str = "projectSettings";
/// Por encima, un comando exacto como regla es ruido en el settings.
const MAX_COMANDO: usize = 300;
/// Caracteres con los que una regla exacta de shell no es fiable: compuestos
/// (Claude Code evalúa cada subcomando), comodines y paréntesis del propio
/// formato de regla.
const SHELL_NO_FIABLE: &[char] = &['\n', '\r', '(', ')', '`', ';', '|', '&', '<', '>', '*', '$'];

/// Regla de Claude Code que permitiría `tool` con este `input`, o `None` si
/// no hay una concreta y segura.
pub fn regla(tool: &str, input: &Value) -> Option<String> {
    match tool {
        "Bash" | "PowerShell" => regla_shell(tool, input),
        "WebFetch" => {
            let url = input.get("url")?.as_str()?;
            Some(format!("WebFetch(domain:{})", host(url)?))
        }
        "WebSearch" => Some("WebSearch".to_string()),
        _ if es_herramienta_mcp(tool) => Some(tool.to_string()),
        _ => None,
    }
}

fn regla_shell(tool: &str, input: &Value) -> Option<String> {
    let cmd = input.get("command")?.as_str()?.trim();
    let valido = !cmd.is_empty() && cmd.len() <= MAX_COMANDO && !cmd.contains(SHELL_NO_FIABLE);
    valido.then(|| format!("{tool}({cmd})"))
}

/// `mcp__<servidor>__<herramienta>` con las dos partes no vacías: con la
/// herramienta vacía (`mcp__srv__`) la regla podría leerse como el servidor
/// entero.
fn es_herramienta_mcp(tool: &str) -> bool {
    let Some((servidor, herramienta)) = tool
        .strip_prefix("mcp__")
        .and_then(|resto| resto.split_once("__"))
    else {
        return false;
    };
    let valida = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    valida(servidor) && valida(herramienta)
}

/// Host de una URL `http(s)://`, sin usuario ni puerto, en minúsculas.
fn host(url: &str) -> Option<String> {
    let lower = url.trim().to_ascii_lowercase();
    let resto = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))?;
    let autoridad = resto.split(['/', '?', '#']).next()?;
    let sin_usuario = autoridad.rsplit('@').next()?;
    let h = sin_usuario.split(':').next()?;
    // Cada etiqueta no vacía: `.com`, `com.` o `a..b` no son un host concreto.
    let valido = h.contains('.')
        && h.split('.').all(|etiqueta| {
            !etiqueta.is_empty()
                && etiqueta
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-')
        });
    valido.then(|| h.to_string())
}

/// Valida una regla que se va a escribir (la anuncie el backend o la traiga el
/// puente) con el mismo criterio de `regla`: solo pasa si es exactamente la
/// regla canónica que el backend habría deducido para su herramienta y su
/// argumento. Así quedan fuera la herramienta entera (`Bash`, `WebFetch`),
/// los prefijos y comodines (`Bash(ls:*)`, `mcp__srv__*`), los compuestos de
/// shell y cualquier forma que no sea `Herramienta(argumento)`.
pub fn validar_regla(r: &str) -> Result<(), String> {
    let canonica = match r.split_once('(') {
        Some((tool, resto)) => {
            let arg = resto.strip_suffix(')').unwrap_or_default();
            match tool {
                "Bash" | "PowerShell" => regla(tool, &json!({ "command": arg })),
                "WebFetch" => arg
                    .strip_prefix("domain:")
                    .and_then(|h| regla(tool, &json!({ "url": format!("https://{h}/") }))),
                _ => None,
            }
        }
        None => regla(r, &Value::Null),
    };
    if canonica.as_deref() == Some(r) {
        return Ok(());
    }
    let motivo = if r.contains('(') {
        "mal formada o demasiado amplia"
    } else {
        "demasiado amplia o desconocida"
    };
    Err(format!(
        "regla rechazada «{r}»: {motivo}; solo se guardan reglas concretas \
         (`Bash(<comando exacto>)`, `WebFetch(domain:<host>)`, `WebSearch`, \
         `mcp__servidor__herramienta`): usa «Permitir»"
    ))
}

/// Añade `always` al payload de un ask de permiso si el puente no lo trae y
/// hay una regla concreta.
pub fn anunciar(payload: &mut Map<String, Value>) {
    if payload.get("kind").and_then(Value::as_str) != Some("permission")
        || payload.contains_key("always")
    {
        return;
    }
    let tool = payload
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let input = payload.get("input").cloned().unwrap_or(Value::Null);
    if let Some(r) = regla(tool, &input) {
        payload.insert(
            "always".into(),
            json!({ "rules": [r], "destination": DESTINO_LOCAL }),
        );
    }
}

/// Reglas y destino anunciados en el payload (`always`).
fn anunciadas(payload: &Value) -> Option<(Vec<String>, String)> {
    let always = payload.get("always")?;
    let destino = always.get("destination")?.as_str()?.to_string();
    let reglas: Vec<String> = always
        .get("rules")?
        .as_array()?
        .iter()
        .filter_map(|r| r.as_str().map(str::trim))
        .filter(|r| !r.is_empty())
        .map(str::to_string)
        .collect();
    (!reglas.is_empty()).then_some((reglas, destino))
}

/// Fichero de settings de Claude Code para un destino que escribe el
/// backend; `None` para el resto (`session`, `userSettings`).
fn ruta_settings(cwd: &Path, destino: &str) -> Option<PathBuf> {
    let dir = cwd.join(".claude");
    match destino {
        DESTINO_LOCAL => Some(dir.join("settings.local.json")),
        DESTINO_PROYECTO => Some(dir.join("settings.json")),
        _ => None,
    }
}

/// Guarda la regla anunciada de `ask` para la sesión con este `cwd`. `Ok` si
/// quedó escrita (o ya estaba); `Err` con el motivo si no hay regla, el
/// destino no lo aplica nadie o no se pudo escribir.
pub fn guardar(ask: &PendingAsk, cwd: &str) -> Result<(), String> {
    let (reglas, destino) = anunciadas(&ask.payload)
        .ok_or_else(|| "esta petición no trae una regla que guardar: usa «Permitir»".to_string())?;
    let Some(ruta) = ruta_settings(Path::new(cwd), &destino) else {
        return Err(format!(
            "el destino «{destino}» no lo aplica ni el backend ni el puente: usa «Permitir»"
        ));
    };
    // El `always` del puente no pasa por `regla`: se valida aquí con el mismo
    // criterio antes de escribir nada, y una sola regla mala rechaza todas.
    reglas.iter().try_for_each(|r| validar_regla(r))?;
    if cwd.trim().is_empty() || !Path::new(cwd).is_dir() {
        return Err(format!("la carpeta de la sesión no existe: {cwd}"));
    }
    anadir_reglas(&ruta, &reglas).map(|_| ())
}

/// Serializa las escrituras de settings de este proceso: dos «Permitir
/// siempre» seguidos no se pisan el leer-modificar-escribir.
fn cerrojo() -> &'static Mutex<()> {
    static M: Mutex<()> = Mutex::new(());
    &M
}

/// Añade `reglas` a `permissions.allow` de `ruta` sin duplicar y conservando
/// el resto del fichero. Devuelve cuántas añadió. Un fichero que no es JSON
/// o con una forma inesperada no se toca: es un error.
pub fn anadir_reglas(ruta: &Path, reglas: &[String]) -> Result<usize, String> {
    let _guard = cerrojo()
        .lock()
        .map_err(|_| "cerrojo de settings envenenado".to_string())?;
    let mut raiz = leer_settings(ruta)?;
    let obj = raiz
        .as_object_mut()
        .ok_or_else(|| format!("{} no es un objeto JSON: no se toca", ruta.display()))?;
    let permisos = obj
        .entry("permissions")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| format!("`permissions` de {} no es un objeto", ruta.display()))?;
    let allow = permisos
        .entry("allow")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| format!("`permissions.allow` de {} no es una lista", ruta.display()))?;
    let nuevas: Vec<String> = reglas
        .iter()
        .filter(|r| !allow.iter().any(|a| a.as_str() == Some(r.as_str())))
        .cloned()
        .collect();
    if nuevas.is_empty() {
        return Ok(0);
    }
    allow.extend(nuevas.iter().cloned().map(Value::String));
    let texto = serde_json::to_string_pretty(&raiz)
        .map_err(|e| format!("no se pudo serializar {}: {e}", ruta.display()))?;
    escribir_atomico(ruta, &format!("{texto}\n"))?;
    Ok(nuevas.len())
}

fn leer_settings(ruta: &Path) -> Result<Value, String> {
    let texto = match std::fs::read_to_string(ruta) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(e) => return Err(format!("no se pudo leer {}: {e}", ruta.display())),
    };
    let limpio = texto.trim_start_matches('\u{feff}');
    if limpio.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(limpio)
        .map_err(|e| format!("{} no es JSON válido ({e}): no se toca", ruta.display()))
}

#[cfg(test)]
#[path = "tests_permiso_siempre.rs"]
mod tests;
