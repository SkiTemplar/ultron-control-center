// mar.ia — ejecucion de las herramientas que pide la voz.
//
// El sidecar de voz DECIDE ("abre Spotify"), pero no toca el sistema: emite
// {"event":"tool"} y la ejecucion ocurre aqui, en la aplicacion, que es quien
// tiene los comandos, los permisos y el daemon. Asi un proceso que escucha el
// microfono no puede lanzar nada por su cuenta.
//
// Cada herramienta devuelve una frase para que mar.ia la diga. Regla dura: la
// frase describe lo que HA PASADO de verdad — si abrir falla, lo dice. Nada de
// "hecho" optimista (mandamiento 11: prohibido el no-op silencioso).

use std::time::Duration;

/// Resultado de ejecutar una herramienta: que decir y si salio bien.
pub struct ToolOutcome {
    pub ok: bool,
    /// Frase corta, en español, lista para locutar.
    pub say: String,
}

impl ToolOutcome {
    fn ok(say: impl Into<String>) -> Self {
        Self { ok: true, say: say.into() }
    }
    fn fail(say: impl Into<String>) -> Self {
        Self { ok: false, say: say.into() }
    }
}

/// Nombre aceptable para abrir una aplicacion.
///
/// El texto viene de una transcripcion de voz pasada por un modelo: no es
/// entrada de confianza. Se permite lo que puede ser un nombre de programa y
/// nada mas — sin `&`, `|`, `;`, comillas ni saltos de linea, que son las
/// piezas con las que se encadenan ordenes.
#[must_use]
pub fn is_safe_app_name(name: &str) -> bool {
    let n = name.trim();
    if n.is_empty() || n.len() > 64 {
        return false;
    }
    n.chars()
        .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_' | '+'))
}

/// Busca el ejecutable principal dentro de una carpeta de instalacion.
///
/// Heuristica deliberadamente pobre: el .exe cuyo nombre mas se parezca al de
/// la aplicacion. Si no hay nada claro se devuelve None y el llamante cae a
/// Start-Process, que sabe resolver alias del sistema y apps de la Store.
fn exe_in(dir: &std::path::Path, app_name: &str) -> Option<std::path::PathBuf> {
    let needle = app_name.to_lowercase().replace(' ', "");
    let mut best: Option<(usize, std::path::PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()).map(str::to_lowercase) != Some("exe".into()) {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_lowercase();
        let score = if stem == needle {
            0
        } else if needle.contains(&stem) || stem.contains(&needle) {
            1
        } else {
            continue;
        };
        if best.as_ref().map(|(s, _)| score < *s).unwrap_or(true) {
            best = Some((score, path));
        }
    }
    best.map(|(_, p)| p)
}

/// Abre una aplicacion por nombre.
pub fn abrir_app(nombre: &str) -> ToolOutcome {
    if !is_safe_app_name(nombre) {
        return ToolOutcome::fail(format!("No abro «{nombre}»: ese nombre no me cuadra."));
    }
    let nombre = nombre.trim();

    // 1) Inventario ya cacheado -> ejecutable directo, sin shell de por medio.
    if let Some(app) = crate::installed_apps::find_cached_app(nombre) {
        if let Some(dir) = app.install_location.as_deref().filter(|d| !d.is_empty()) {
            if let Some(exe) = exe_in(std::path::Path::new(dir), &app.name) {
                return match std::process::Command::new(&exe).spawn() {
                    Ok(_) => ToolOutcome::ok(format!("Abriendo {}.", app.name)),
                    Err(e) => ToolOutcome::fail(format!("No pude abrir {}: {e}.", app.name)),
                };
            }
        }
    }

    // 2) Start-Process: resuelve alias del sistema, apps de la Store y lo que
    //    este en el PATH. El nombre viaja como argumento suelto (argv), no
    //    concatenado en una linea de comandos.
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "Start-Process",
        "-FilePath",
        nombre,
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match cmd.status() {
        Ok(st) if st.success() => ToolOutcome::ok(format!("Abriendo {nombre}.")),
        Ok(_) => ToolOutcome::fail(format!("No encuentro {nombre} en este equipo.")),
        Err(e) => ToolOutcome::fail(format!("No pude abrir {nombre}: {e}.")),
    }
}

/// Consulta la memoria de ULTRON.
///
/// Va por el daemon, que ya tiene los modelos calientes. Si no responde, se
/// dice — no se finge que no hay recuerdos.
pub fn recordar(consulta: &str) -> ToolOutcome {
    let Some(value) = crate::daemon_client::recall(
        consulta,
        3,
        None,
        true,
        false,
        Duration::from_secs(12),
    ) else {
        return ToolOutcome::fail(
            "No he podido consultar la memoria: el daemon no responde.",
        );
    };

    // El pack trae los items en `memories`; cada uno con titulo y resumen.
    let items = value
        .get("memories")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default();
    if items.is_empty() {
        return ToolOutcome::ok(format!("No tengo nada guardado sobre {consulta}."));
    }
    let primera = items
        .first()
        .and_then(|m| {
            m.get("summary")
                .or_else(|| m.get("title"))
                .or_else(|| m.get("text"))
        })
        .and_then(|v| v.as_str())
        .unwrap_or("algo, pero no puedo resumirlo");
    // Se locuta: una frase, no un volcado.
    let corta: String = primera.chars().take(220).collect();
    ToolOutcome::ok(corta)
}

/// Manda una tarea a un agente de Claude Code.
///
/// Fuego y olvido a proposito: el trabajo largo no puede bloquear la voz. El
/// aviso de que termino llegara por el canal de notificaciones.
pub fn delegar_a_agente(
    app: &tauri::AppHandle,
    tarea: &str,
    proyecto: Option<&str>,
) -> ToolOutcome {
    if tarea.trim().is_empty() {
        return ToolOutcome::fail("No me ha quedado claro qué tarea delegar.");
    }
    let cwd = proyecto
        .filter(|p| !p.trim().is_empty())
        .map(str::to_string)
        .or_else(|| dirs::home_dir().map(|h| h.to_string_lossy().to_string()));

    let app = app.clone();
    let tarea_owned = tarea.to_string();
    // spawn_session_inner es async y lanza una terminal: fuera del hilo que
    // esta procesando eventos del sidecar.
    tauri::async_runtime::spawn(async move {
        let flags = crate::sessions::SpawnFlags {
            paste_only: true,
            ..Default::default()
        };
        if let Err(e) = crate::sessions::spawn_session_inner(
            &app,
            "claude".to_string(),
            Some(tarea_owned),
            cwd,
            Some(flags),
        )
        .await
        {
            crate::toast_emit::record_alert_and_maybe_toast(&app, "maria_tools", "warn", &e);
        }
    });
    ToolOutcome::ok("Se lo paso a un agente.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acepta_nombres_de_aplicacion_normales() {
        for n in ["Spotify", "Visual Studio Code", "obs-studio", "7zip", "Notepad++"] {
            assert!(is_safe_app_name(n), "deberia aceptar {n}");
        }
    }

    #[test]
    fn rechaza_lo_que_encadena_ordenes() {
        // Caso negativo: el nombre sale de una transcripcion de voz pasada por
        // un modelo. Si colase un `;` o un `&`, seria ejecucion arbitraria.
        for n in [
            "spotify; shutdown /s",
            "cmd & del C:\\",
            "app | Remove-Item",
            "`whoami`",
            "notepad\nmalo",
            "",
            "   ",
        ] {
            assert!(!is_safe_app_name(n), "deberia rechazar {n:?}");
        }
    }

    #[test]
    fn rechaza_nombres_absurdamente_largos() {
        assert!(!is_safe_app_name(&"a".repeat(65)));
    }

    #[test]
    fn un_nombre_inseguro_no_llega_a_ejecutarse() {
        let out = abrir_app("spotify & calc");
        assert!(!out.ok);
        assert!(out.say.contains("no me cuadra"), "mensaje: {}", out.say);
    }

    #[test]
    fn elige_el_ejecutable_que_se_parece_al_nombre() {
        let dir = tempfile::tempdir().expect("tempdir");
        for f in ["unins000.exe", "Spotify.exe", "crashpad_handler.exe"] {
            std::fs::write(dir.path().join(f), "").expect("write");
        }
        let exe = exe_in(dir.path(), "Spotify").expect("encuentra el exe");
        assert_eq!(exe.file_name().unwrap(), "Spotify.exe");
    }

    #[test]
    fn sin_ejecutable_parecido_no_inventa_uno() {
        // Caso negativo: mejor caer a Start-Process que abrir el desinstalador.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("unins000.exe"), "").expect("write");
        assert!(exe_in(dir.path(), "Spotify").is_none());
    }
}
