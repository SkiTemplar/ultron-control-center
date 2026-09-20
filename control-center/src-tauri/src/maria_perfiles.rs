// mar.ia — varias cuentas por proveedor, y poder cambiar entre ellas.
//
// El usuario lo pidio el 2026-09-19: tiene su cuenta y la de clase/compañeros,
// y hasta ahora cambiar significaba cerrar sesion en la CLI y volver a entrar.
// Un perfil es la credencial de una CLI guardada con un nombre; activarlo la
// vuelve a poner en su sitio.
//
// QUE IMPLICA ESTO, dicho claro (y por eso esta escrito aqui y en la pantalla):
// guardar un perfil COPIA el fichero de credenciales, token incluido, a
// `<raiz>/cuentas/<proveedor>/<nombre>.json`. Es lo mismo que hace cualquiera
// a mano, pero significa que ese token existe en dos sitios del disco en vez
// de uno. Los ficheros quedan bajo el perfil del usuario, con sus mismos
// permisos; en un equipo compartido, esto es un motivo para no usarlo.
//
// Borrar es destructivo de verdad: cerrar sesion obliga a volver a entrar en la
// CLI. Por eso TODAS las operaciones que borran exigen `confirmar: true`
// ademas del dialogo de la interfaz — dos redes, no una.

use serde::Serialize;

/// Donde guarda cada CLI su sesion. Lista cerrada: la ruta NUNCA viene del
/// frontend, o seria un borrado arbitrario de ficheros.
fn credencial(provider: &str) -> Option<Vec<std::path::PathBuf>> {
    let home = dirs::home_dir()?;
    match provider {
        "claude" => Some(vec![home.join(".claude").join(".credentials.json")]),
        "codex" => Some(vec![home.join(".codex").join("auth.json")]),
        // Gemini guarda el token y la lista de cuentas por separado: si solo se
        // borrara uno, la CLI se queda en un estado a medias.
        // Antigravity (`agy`) NO aparece aqui a proposito: no guarda la
        // sesion en un fichero conocido, asi que no se puede copiar ni
        // restaurar. Cambiar de cuenta ahi se hace desde la propia CLI.
        // Gemini salio el 2026-09-20 junto con el proveedor.
        _ => None,
    }
}

/// Variables de API que mar.ia sabe borrar. Lista cerrada: el nombre acaba en
/// `reg delete`, asi que aceptar cualquiera seria dejar tocar el registro.
/// Variables que el boton de borrar puede tocar.
///
/// Es una lista CERRADA a proposito: `maria_clave_borrar` escribe en el `.env`
/// y en el registro del usuario, y no puede aceptar un nombre arbitrario que
/// venga de la interfaz.
///
/// Tiene que cubrir TODO lo que la pantalla de API Keys ensena; si no, el
/// boton saldria y no haria nada (mandamiento 11). El test
/// `cubre_todo_el_catalogo_de_la_pantalla` es el que lo sujeta.
const CLAVES_CONOCIDAS: &[&str] = &[
    // Providers de IA (Settings > API Keys > primera lista)
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "DEEPSEEK_API_KEY",
    "NVIDIA_NIM_API_KEY",
    "OPENROUTER_API_KEY",
    // Investigacion (buscador de papers del TFG)
    "SEMANTIC_SCHOLAR_API_KEY",
    "OPENALEX_API_KEY",
    "OPENALEX_MAILTO",
    "UNPAYWALL_EMAIL",
    // Token de GitHub (su propia tarjeta, mas abajo en la misma pantalla)
    "GITHUB_TOKEN",
];

/// ¿Es una variable que se puede borrar? Pura.
#[must_use]
pub fn clave_conocida(variable: &str) -> bool {
    CLAVES_CONOCIDAS.contains(&variable.trim())
}

/// Guarda comun de todo lo que borra. Pura.
///
/// La confirmacion se exige tambien AQUI, no solo en el dialogo de la
/// interfaz: un comando destructivo no puede depender de que la pantalla se
/// porte bien.
pub fn exige_confirmacion(confirmar: bool) -> Result<(), String> {
    if confirmar {
        Ok(())
    } else {
        Err("hace falta confirmar".into())
    }
}

/// Nombre de perfil valido: es un nombre de fichero, no una ruta.
#[must_use]
pub fn nombre_valido(nombre: &str) -> bool {
    let n = nombre.trim();
    !n.is_empty()
        && n.len() <= 48
        && n
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == ' ')
}

fn carpeta(provider: &str) -> Result<std::path::PathBuf, String> {
    if credencial(provider).is_none() {
        return Err(format!("proveedor desconocido: {provider}"));
    }
    let dir = crate::maria_paths::home().join("cuentas").join(provider);
    std::fs::create_dir_all(&dir).map_err(|e| format!("crear carpeta: {e}"))?;
    Ok(dir)
}

#[derive(Debug, Clone, Serialize)]
pub struct Perfil {
    pub provider: String,
    pub nombre: String,
    /// Correo de ese perfil, si se puede leer. Solo el correo.
    pub account: String,
    /// true = es el que esta puesto ahora mismo.
    pub activo: bool,
}

/// Correo del fichero principal de un perfil guardado.
fn correo_de(dir: &std::path::Path, nombre: &str) -> String {
    let f = dir.join(format!("{nombre}.json"));
    std::fs::read_to_string(f)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| crate::maria_cuentas::correo_en(&v).map(|(c, _)| c))
        .unwrap_or_default()
}

/// Perfiles guardados de un proveedor.
fn listar_de(provider: &str) -> Vec<Perfil> {
    let Ok(dir) = carpeta(provider) else {
        return Vec::new();
    };
    let activo = crate::maria_cuentas::informe()
        .cuentas
        .into_iter()
        .find(|c| c.provider == provider)
        .map(|c| c.account)
        .unwrap_or_default();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<Perfil> = rd
        .filter_map(Result::ok)
        .filter_map(|e| {
            let p = e.path();
            // Los ficheros extra de un perfil van como `<nombre>.2.json`; solo
            // el principal cuenta como perfil.
            let nombre = p.file_stem()?.to_str()?.to_string();
            if p.extension().and_then(|x| x.to_str()) != Some("json") || nombre.contains('.') {
                return None;
            }
            let account = correo_de(&dir, &nombre);
            Some(Perfil {
                provider: provider.to_string(),
                activo: !account.is_empty() && account.eq_ignore_ascii_case(&activo),
                nombre,
                account,
            })
        })
        .collect();
    out.sort_by(|a, b| a.nombre.cmp(&b.nombre));
    out
}

/// Ficheros de un perfil: el principal y, si el proveedor usa varios, los
/// numerados detras.
fn ficheros_perfil(dir: &std::path::Path, nombre: &str, n: usize) -> Vec<std::path::PathBuf> {
    (0..n)
        .map(|i| {
            if i == 0 {
                dir.join(format!("{nombre}.json"))
            } else {
                dir.join(format!("{nombre}.{}.json", i + 1))
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn maria_perfiles_listar() -> Result<Vec<Perfil>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        ["claude", "codex"]
            .iter()
            .flat_map(|p| listar_de(p))
            .collect()
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))
}

/// Guarda la sesion actual de un proveedor con un nombre.
#[tauri::command]
pub async fn maria_perfil_guardar(provider: String, nombre: String) -> Result<Perfil, String> {
    if !nombre_valido(&nombre) {
        return Err("nombre inválido: letras, números, guiones y espacios (máx. 48)".into());
    }
    let origen = credencial(&provider).ok_or_else(|| format!("proveedor desconocido: {provider}"))?;
    if !origen[0].exists() {
        return Err(format!(
            "no hay sesión activa de {provider} que guardar (falta {})",
            origen[0].display()
        ));
    }
    let dir = carpeta(&provider)?;
    let nombre = nombre.trim().to_string();
    let destinos = ficheros_perfil(&dir, &nombre, origen.len());
    for (o, d) in origen.iter().zip(destinos.iter()) {
        if o.exists() {
            std::fs::copy(o, d).map_err(|e| format!("copiar {}: {e}", o.display()))?;
        }
    }
    let account = correo_de(&dir, &nombre);
    Ok(Perfil {
        provider,
        nombre,
        activo: true,
        account,
    })
}

/// Pone un perfil guardado como sesion activa.
///
/// Antes de pisar nada, guarda lo que hubiera como perfil `anterior`: cambiar
/// de cuenta no puede ser la forma de perder la que tenias.
#[tauri::command]
pub async fn maria_perfil_activar(provider: String, nombre: String) -> Result<String, String> {
    if !nombre_valido(&nombre) {
        return Err("nombre inválido".into());
    }
    let destino = credencial(&provider).ok_or_else(|| format!("proveedor desconocido: {provider}"))?;
    let dir = carpeta(&provider)?;
    let origen = ficheros_perfil(&dir, nombre.trim(), destino.len());
    if !origen[0].exists() {
        return Err(format!("no existe el perfil «{nombre}» de {provider}"));
    }

    // Red de seguridad: lo que hay ahora se guarda como «anterior».
    if destino[0].exists() {
        let respaldo = ficheros_perfil(&dir, "anterior", destino.len());
        for (d, r) in destino.iter().zip(respaldo.iter()) {
            if d.exists() {
                let _ = std::fs::copy(d, r);
            }
        }
    }

    for (o, d) in origen.iter().zip(destino.iter()) {
        if let Some(padre) = d.parent() {
            let _ = std::fs::create_dir_all(padre);
        }
        if o.exists() {
            std::fs::copy(o, d).map_err(|e| format!("activar perfil: {e}"))?;
        } else if d.exists() {
            // El perfil no tenia este fichero: se quita para no dejar mezcla
            // de dos cuentas distintas.
            let _ = std::fs::remove_file(d);
        }
    }
    Ok(format!("perfil «{}» activo en {provider}", nombre.trim()))
}

/// Borra un perfil guardado. NO toca la sesion activa.
#[tauri::command]
pub async fn maria_perfil_borrar(
    provider: String,
    nombre: String,
    confirmar: bool,
) -> Result<String, String> {
    exige_confirmacion(confirmar)?;
    if !nombre_valido(&nombre) {
        return Err("nombre inválido".into());
    }
    let n = credencial(&provider)
        .ok_or_else(|| format!("proveedor desconocido: {provider}"))?
        .len();
    let dir = carpeta(&provider)?;
    let mut borrados = 0;
    for f in ficheros_perfil(&dir, nombre.trim(), n) {
        if f.exists() {
            std::fs::remove_file(&f).map_err(|e| format!("borrar {}: {e}", f.display()))?;
            borrados += 1;
        }
    }
    if borrados == 0 {
        return Err(format!("no existe el perfil «{nombre}»"));
    }
    Ok(format!("perfil «{}» borrado", nombre.trim()))
}

/// Cierra la sesion activa de un proveedor: borra su credencial.
#[tauri::command]
pub async fn maria_cuenta_cerrar_sesion(
    provider: String,
    confirmar: bool,
) -> Result<String, String> {
    exige_confirmacion(confirmar)?;
    let ficheros =
        credencial(&provider).ok_or_else(|| format!("proveedor desconocido: {provider}"))?;
    let mut borrados = 0;
    for f in &ficheros {
        if f.exists() {
            std::fs::remove_file(f).map_err(|e| format!("borrar {}: {e}", f.display()))?;
            borrados += 1;
        }
    }
    if borrados == 0 {
        return Err(format!("{provider} no tenía sesión activa"));
    }
    Ok(format!(
        "sesión de {provider} cerrada; tendrás que volver a entrar en su CLI"
    ))
}

/// Quita una clave de API del `.env` de mar.ia y de las variables del usuario.
///
/// Lo que NO puede hacer: quitarla de una variable de SISTEMA (hace falta
/// administrador) ni del proceso ya arrancado. Cuando pase, se dice.
#[tauri::command]
pub async fn maria_clave_borrar(variable: String, confirmar: bool) -> Result<String, String> {
    exige_confirmacion(confirmar)?;
    let var = variable.trim().to_string();
    if !clave_conocida(&var) {
        return Err(format!("variable no reconocida: {var}"));
    }

    let mut hecho: Vec<String> = Vec::new();

    // 1. El .env de mar.ia.
    let env_file = crate::maria_paths::home().join(".env");
    if let Ok(texto) = std::fs::read_to_string(&env_file) {
        let filtrado: Vec<&str> = texto
            .lines()
            .filter(|l| !l.trim_start().starts_with(&format!("{var}=")))
            .collect();
        if filtrado.len() != texto.lines().count() {
            std::fs::write(&env_file, filtrado.join("\n") + "\n")
                .map_err(|e| format!("reescribir .env: {e}"))?;
            hecho.push("quitada del .env".into());
        }
    }

    // 2. La variable de usuario de Windows.
    #[cfg(windows)]
    {
        let existe_usuario = crate::proc::oculto("reg")
            .args(["query", "HKCU\\Environment", "/v", &var])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if existe_usuario {
            let ok = crate::proc::oculto("reg")
                .args(["delete", "HKCU\\Environment", "/v", &var, "/f"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if ok {
                hecho.push("quitada de las variables del usuario".into());
            }
        }
    }

    // 3. Lo que queda en ESTE proceso y en el sistema no se puede tocar.
    let en_proceso = std::env::var(&var).map(|v| !v.is_empty()).unwrap_or(false);
    if hecho.is_empty() && !en_proceso {
        return Err(format!("{var} no estaba definida en ningún sitio que pueda tocar"));
    }
    if en_proceso {
        hecho.push(
            "sigue definida en este proceso: cierra y vuelve a abrir mar.ia para que se vaya \
             del todo (si vuelve a aparecer, es una variable del SISTEMA y hay que quitarla \
             con permisos de administrador)"
                .into(),
        );
    }
    Ok(hecho.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acepta_nombres_de_perfil_normales() {
        for n in ["personal", "clase 2026", "cuenta-trabajo", "a_b"] {
            assert!(nombre_valido(n), "deberia aceptar {n:?}");
        }
    }

    #[test]
    fn rechaza_nombres_que_se_salen_de_la_carpeta() {
        // Caso negativo: el nombre acaba en una ruta de fichero que se BORRA y
        // se SOBRESCRIBE. Sin este filtro, "../../.claude/.credentials" seria
        // una forma de pisar cualquier cosa.
        for n in ["../secreto", "a/b", "a\\b", "", "   ", "a:b", &"x".repeat(49)] {
            assert!(!nombre_valido(n), "no deberia aceptar {n:?}");
        }
    }

    #[test]
    fn solo_hay_credenciales_para_los_proveedores_con_sesion() {
        for p in ["claude", "codex"] {
            assert!(credencial(p).is_some(), "falta {p}");
        }
        // El local no tiene sesion, y un proveedor inventado tampoco.
        assert!(credencial("local").is_none());
        assert!(credencial("../../etc").is_none());
    }

    #[test]
    fn solo_hay_perfiles_de_quien_guarda_la_sesion_en_un_fichero() {
        // Claude y Codex si: se puede copiar y restaurar su credencial.
        assert_eq!(credencial("claude").unwrap().len(), 1);
        assert_eq!(credencial("codex").unwrap().len(), 1);
        // Antigravity no guarda la sesion en ningun fichero conocido, asi que
        // no se puede ofrecer cambiar de cuenta: prometerlo seria un boton que
        // no hace nada. Gemini salio del programa el 2026-09-20.
        assert!(credencial("antigravity").is_none());
        assert!(credencial("gemini").is_none());
    }

    #[test]
    fn los_ficheros_de_un_perfil_se_numeran_a_partir_del_segundo() {
        let dir = std::path::Path::new("C:/tmp");
        let fs = ficheros_perfil(dir, "personal", 2);
        assert!(fs[0].ends_with("personal.json"));
        assert!(fs[1].ends_with("personal.2.json"));
    }

    #[test]
    fn no_se_borra_nada_sin_confirmar() {
        // Caso negativo y el mas importante: la confirmacion no es solo del
        // dialogo de la interfaz — el backend tambien la exige.
        assert!(exige_confirmacion(false).is_err());
        assert!(exige_confirmacion(true).is_ok());
    }

    #[test]
    fn no_se_borra_una_variable_cualquiera() {
        // Caso negativo: el nombre acaba en `reg delete`. PATH o USERPROFILE
        // serian un estropicio, y un nombre con `;` una via de inyeccion.
        for v in ["PATH", "USERPROFILE", "", "ANTHROPIC_API_KEY; calc", "TEMP"] {
            assert!(!clave_conocida(v), "colo: {v:?}");
        }
        for v in ["ANTHROPIC_API_KEY", " OPENAI_API_KEY ", "GITHUB_TOKEN"] {
            assert!(clave_conocida(v), "deberia aceptar {v:?}");
        }
    }

    #[test]
    fn cubre_todo_el_catalogo_de_la_pantalla() {
        // El boton de Eliminar sale en TODAS las filas de Settings > API Keys.
        // Si el catalogo del frontend gana una clave y esta lista no, el boton
        // apareceria y el backend lo rechazaria con "variable no reconocida":
        // un boton que no hace nada, que es justo lo que no queremos.
        //
        // Por eso el test lee el catalogo de verdad en vez de una copia.
        let catalogo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/components/Settings/api-keys/key-catalog.ts");
        let texto = std::fs::read_to_string(&catalogo)
            .unwrap_or_else(|e| panic!("no pude leer {}: {e}", catalogo.display()));

        let mut faltan: Vec<String> = Vec::new();
        for linea in texto.lines() {
            let Some(resto) = linea.trim().strip_prefix("envVar: \"") else {
                continue;
            };
            let Some(nombre) = resto.split('"').next() else {
                continue;
            };
            if !clave_conocida(nombre) {
                faltan.push(nombre.to_string());
            }
        }
        assert!(
            faltan.is_empty(),
            "la pantalla ensena claves que no se pueden borrar: {faltan:?}"
        );
    }
}
