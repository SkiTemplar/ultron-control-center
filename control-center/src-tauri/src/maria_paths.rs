// mar.ia — donde vive todo.
//
// El sistema de carpetas pasa a llamarse `.maria` (peticion del usuario,
// 2026-09-18: "todo el sistema de carpetas llamalo maria"). Esta es la UNICA
// funcion que decide la ruta: el resto del codigo pregunta aqui en vez de
// construir `home/.ultron` a mano.
//
// Orden de resolucion:
//   1. `MARIA_HOME` — para pruebas y para mover la instalacion de disco.
//   2. `~/.maria`   — el nombre nuevo, si existe.
//   3. `~/.ultron`  — el nombre heredado, mientras siga ahi.
//
// COMO CONVIVEN LOS DOS NOMBRES (limite declarado, mandamiento 13): la
// migracion renombra la carpeta a `.maria` y deja un ENLACE DE DIRECTORIO
// (junction) en `.ultron` apuntando a ella. Eso es lo que permite que el
// cambio sea seguro: los cientos de referencias que quedan por el sistema
// —hooks registrados en `~/.claude/settings.json`, scripts de PowerShell,
// rutas dentro de brain.db— siguen funcionando sin tocarlas, porque Windows
// las resuelve a la carpeta nueva. Este modulo NO es una capa de
// compatibilidad: la compatibilidad la da el enlace. Aqui solo se decide el
// nombre canonico.

use std::path::PathBuf;

/// Nombre nuevo de la carpeta raiz.
pub const DIR_NUEVO: &str = ".maria";
/// Nombre heredado (ULTRON).
pub const DIR_HEREDADO: &str = ".ultron";

/// Elige la carpeta raiz entre las candidatas. Pura: se testea sin tocar el
/// disco pasandole que rutas existen.
///
/// `existe` responde si una ruta esta en el disco. Se inyecta para poder
/// probar los tres caminos (variable de entorno, nombre nuevo, heredado) sin
/// crear carpetas de verdad.
#[must_use]
pub fn elegir_raiz(
    env_home: Option<&str>,
    home: Option<&std::path::Path>,
    existe: &dyn Fn(&std::path::Path) -> bool,
) -> Option<PathBuf> {
    // 1. Variable de entorno: manda siempre, exista o no (si no existe, se
    //    creara; es una decision explicita de quien la puso).
    if let Some(e) = env_home.map(str::trim).filter(|e| !e.is_empty()) {
        return Some(PathBuf::from(e));
    }
    let home = home?;
    let nuevo = home.join(DIR_NUEVO);
    if existe(&nuevo) {
        return Some(nuevo);
    }
    let heredado = home.join(DIR_HEREDADO);
    if existe(&heredado) {
        return Some(heredado);
    }
    // Ninguna existe todavia: instalacion nueva -> nombre nuevo.
    Some(nuevo)
}

/// Carpeta raiz de mar.ia.
///
/// Nunca falla: sin HOME cae a `.maria` relativo, que es preferible a que la
/// aplicacion no arranque.
#[must_use]
pub fn home() -> PathBuf {
    let env_home = std::env::var("MARIA_HOME")
        .ok()
        .or_else(|| std::env::var("ULTRON_HOME").ok());
    elegir_raiz(
        env_home.as_deref(),
        dirs::home_dir().as_deref(),
        &|p| p.exists(),
    )
    .unwrap_or_else(|| PathBuf::from(DIR_NUEVO))
}

/// Nombre de la carpeta raiz DENTRO de HOME (".maria" o ".ultron").
///
/// Hace falta para los backups, que trabajan con nombres relativos a HOME y no
/// con rutas absolutas: robocopy copia `~/<nombre>` a `<raiz de backup>/<nombre>`.
/// Si la raiz esta fuera de HOME (`MARIA_HOME` apuntando a otro disco), se
/// devuelve el nombre nuevo, que es lo unico sensato como etiqueta.
#[must_use]
pub fn nombre_en_home() -> String {
    let raiz = home();
    if let Some(h) = dirs::home_dir() {
        if let Ok(rel) = raiz.strip_prefix(&h) {
            if let Some(n) = rel.to_str().filter(|n| !n.is_empty()) {
                return n.to_string();
            }
        }
    }
    DIR_NUEVO.to_string()
}

/// Nombre del vault de notas dentro de HOME.
///
/// Mismo criterio que la raiz: `.maria-vault` si existe, `.ultron-vault`
/// mientras sea lo unico que hay. La migracion lo renombra y deja un enlace,
/// igual que con la carpeta principal.
#[must_use]
pub fn nombre_vault_en_home() -> String {
    let nuevo = format!("{DIR_NUEVO}-vault");
    let heredado = format!("{DIR_HEREDADO}-vault");
    match dirs::home_dir() {
        Some(h) if !h.join(&nuevo).exists() && h.join(&heredado).exists() => heredado,
        _ => nuevo,
    }
}

/// Subcarpeta de la raiz, creandola si hace falta.
fn sub(rel: &str) -> Result<PathBuf, String> {
    let dir = home().join(rel);
    std::fs::create_dir_all(&dir).map_err(|e| format!("crear {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Carpeta del cockpit (`<raiz>/cockpit/...`).
pub fn cockpit(rel: &str) -> Result<PathBuf, String> {
    sub(&format!("cockpit/{rel}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn nada(_: &Path) -> bool {
        false
    }

    #[test]
    fn la_variable_de_entorno_manda() {
        let r = elegir_raiz(Some("D:/otra/maria"), Some(Path::new("C:/Users/x")), &nada);
        assert_eq!(r, Some(PathBuf::from("D:/otra/maria")));
    }

    #[test]
    fn una_variable_vacia_no_cuenta() {
        // Caso negativo: `MARIA_HOME=""` mandaria la instalacion a la raiz del
        // disco. Una cadena en blanco es "sin configurar", no una ruta.
        let home = Path::new("C:/Users/x");
        let r = elegir_raiz(Some("   "), Some(home), &nada);
        assert_eq!(r, Some(home.join(DIR_NUEVO)));
    }

    #[test]
    fn prefiere_el_nombre_nuevo_cuando_existe() {
        let home = Path::new("C:/Users/x");
        let esperado = home.join(DIR_NUEVO);
        let existe = |p: &Path| p == esperado;
        assert_eq!(elegir_raiz(None, Some(home), &existe), Some(esperado));
    }

    #[test]
    fn usa_el_heredado_mientras_sea_el_unico() {
        // Una instalacion que todavia no ha migrado tiene que seguir
        // arrancando contra `.ultron`.
        let home = Path::new("C:/Users/x");
        let esperado = home.join(DIR_HEREDADO);
        let existe = |p: &Path| p == esperado;
        assert_eq!(elegir_raiz(None, Some(home), &existe), Some(esperado));
    }

    #[test]
    fn con_los_dos_presentes_gana_el_nuevo() {
        // Tras la migracion existen los dos (`.ultron` es un enlace a
        // `.maria`). Si ganara el heredado, el nombre nuevo no serviria de
        // nada.
        let home = Path::new("C:/Users/x");
        let existe = |_: &Path| true;
        assert_eq!(elegir_raiz(None, Some(home), &existe), Some(home.join(DIR_NUEVO)));
    }

    #[test]
    fn instalacion_nueva_estrena_el_nombre_nuevo() {
        let home = Path::new("C:/Users/x");
        assert_eq!(elegir_raiz(None, Some(home), &nada), Some(home.join(DIR_NUEVO)));
    }

    #[test]
    fn sin_home_no_inventa_una_ruta() {
        assert_eq!(elegir_raiz(None, None, &nada), None);
    }

    #[test]
    fn el_nombre_en_home_es_relativo_y_corto() {
        // Se usa como nombre de carpeta destino en el disco de backup: si
        // saliera una ruta absoluta, robocopy crearia un arbol absurdo.
        let n = nombre_en_home();
        assert!(!n.is_empty());
        assert!(!n.contains('/') && !n.contains('\\'), "no puede ser una ruta: {n}");
        assert!(n.starts_with('.'), "la raiz es una carpeta oculta: {n}");
    }

    #[test]
    fn el_vault_sigue_el_mismo_nombre_que_la_raiz() {
        let v = nombre_vault_en_home();
        assert!(v.ends_with("-vault"), "{v}");
        assert!(v == format!("{DIR_NUEVO}-vault") || v == format!("{DIR_HEREDADO}-vault"));
    }

    #[test]
    fn home_devuelve_algo_usable() {
        let h = home();
        assert!(!h.as_os_str().is_empty());
    }
}
