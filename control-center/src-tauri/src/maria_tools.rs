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
                return match crate::proc::oculto(&exe).spawn() {
                    Ok(_) => ToolOutcome::ok(format!("Abriendo {}.", app.name)),
                    Err(e) => ToolOutcome::fail(format!("No pude abrir {}: {e}.", app.name)),
                };
            }
        }
    }

    // 2) Start-Process: resuelve alias del sistema, apps de la Store y lo que
    //    este en el PATH. El nombre viaja como argumento suelto (argv), no
    //    concatenado en una linea de comandos.
    let mut cmd = crate::proc::oculto("powershell.exe");
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

/// Estado real de este ordenador, en una frase locutable.
///
/// Por que existe: el usuario pidio (2026-09-19) que mar.ia pudiera "acceder a
/// la red y mirar los registros del ordenador". La voz corre sobre un modelo
/// local que no sabe nada de esta maquina; sin una herramienta que lea los
/// datos de verdad, cualquier respuesta sobre la CPU, el disco o la conexion
/// seria inventada.
///
/// LIMITE DECLARADO (mandamiento 13): son datos de LECTURA y del propio equipo.
/// No cambia nada, no sale a buscar informacion a internet — solo comprueba si
/// hay salida a la red.
#[must_use]
pub fn estado_del_sistema() -> ToolOutcome {
    let t = crate::maria_sysinfo::telemetry();
    let cpu = t
        .cpu_pct
        .map(|c| format!("{c:.0} por ciento de CPU"))
        .unwrap_or_else(|| "CPU sin medir".to_string());
    let gpu = t
        .gpus
        .first()
        .map(|g| match (g.mem_used_mb, g.mem_total_mb) {
            (Some(u), Some(tot)) if tot > 0 => {
                format!("; la gráfica {} con {u} de {tot} megas", g.name)
            }
            _ => format!("; gráfica {}", g.name),
        })
        .unwrap_or_default();
    let red = if hay_internet() {
        "con conexión a internet"
    } else {
        "sin conexión a internet"
    };
    ToolOutcome::ok(format!(
        "{cpu}, {:.1} de {:.1} gigas de memoria y {:.0} gigas libres en disco{gpu}. Estamos {red}.",
        t.ram_used_gb, t.ram_total_gb, t.disk_free_gb
    ))
}

/// ¿Hay salida a internet? Una peticion corta y sin cuerpo.
///
/// Se pregunta a Cloudflare porque su `/cdn-cgi/trace` responde en texto plano
/// y sin cookies. Tres segundos de tope: esto se locuta, no puede colgar la voz.
fn hay_internet() -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .ok()
        .and_then(|c| c.get("https://1.1.1.1/cdn-cgi/trace").send().ok())
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Los ultimos avisos y errores, de mar.ia o de Windows.
///
/// `fuente`: "windows" mira el visor de eventos del sistema; cualquier otra
/// cosa, los propios registros de mar.ia.
#[must_use]
pub fn mirar_registros(fuente: &str) -> ToolOutcome {
    if fuente.trim().eq_ignore_ascii_case("windows") {
        return registros_de_windows();
    }
    registros_de_maria()
}

/// Ultimas lineas con pinta de problema en los logs de mar.ia.
fn registros_de_maria() -> ToolOutcome {
    let dir = crate::maria_paths::home().join("logs");
    let Ok(entradas) = std::fs::read_dir(&dir) else {
        return ToolOutcome::fail(format!("No encuentro la carpeta de registros en {}.", dir.display()));
    };
    // El fichero tocado mas recientemente: es donde esta lo de ahora.
    let mut ficheros: Vec<(std::time::SystemTime, std::path::PathBuf)> = entradas
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "log"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    // De mas reciente a mas antiguo.
    ficheros.sort_by_key(|(fecha, _)| std::cmp::Reverse(*fecha));
    let Some((_, ruta)) = ficheros.first() else {
        return ToolOutcome::ok("No hay ningún registro todavía.");
    };
    let Ok(texto) = std::fs::read_to_string(ruta) else {
        return ToolOutcome::fail("No he podido leer el registro.");
    };
    let malas: Vec<&str> = texto
        .lines()
        .rev()
        .filter(|l| {
            let b = l.to_lowercase();
            b.contains("error") || b.contains("warn") || b.contains("fail")
        })
        .take(3)
        .collect();
    let nombre = ruta
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if malas.is_empty() {
        return ToolOutcome::ok(format!("En {nombre} no hay errores recientes."));
    }
    // Se locuta: una frase, no un volcado. Se recorta cada linea.
    let resumen: Vec<String> = malas
        .iter()
        .rev()
        .map(|l| l.chars().take(140).collect::<String>())
        .collect();
    ToolOutcome::ok(format!("En {nombre}: {}", resumen.join(" | ")))
}

/// Los ultimos errores del visor de eventos de Windows.
#[cfg(windows)]
fn registros_de_windows() -> ToolOutcome {
    // `wevtutil` viene con Windows y no necesita permisos de administrador
    // para el registro del sistema. `/c:3` = tres sucesos, `/rd:true` = los
    // mas recientes primero, `/f:text` = legible.
    let salida = crate::proc::oculto("wevtutil.exe")
        .args([
            "qe",
            "System",
            "/q:*[System[(Level=1 or Level=2)]]",
            "/c:3",
            "/rd:true",
            "/f:text",
        ])
        .output();
    let Ok(out) = salida else {
        return ToolOutcome::fail("No he podido consultar el visor de eventos.");
    };
    if !out.status.success() {
        return ToolOutcome::fail("El visor de eventos ha rechazado la consulta.");
    }
    let texto = String::from_utf8_lossy(&out.stdout);
    // De cada suceso interesa la descripcion, no la cabecera entera.
    let lineas: Vec<String> = texto
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("Description:") || l.starts_with("Descripción:"))
        .map(|l| l.chars().take(140).collect::<String>())
        .take(3)
        .collect();
    if lineas.is_empty() {
        return ToolOutcome::ok("Windows no ha registrado errores recientes.");
    }
    ToolOutcome::ok(format!("Últimos errores de Windows: {}", lineas.join(" | ")))
}

#[cfg(not(windows))]
fn registros_de_windows() -> ToolOutcome {
    ToolOutcome::fail("El visor de eventos solo existe en Windows.")
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

    #[test]
    fn el_estado_del_sistema_da_numeros_de_verdad() {
        // No se comprueba un valor concreto (cambia cada segundo), si que la
        // frase sale de la telemetria real y no de una plantilla vacia: tiene
        // que mencionar la memoria, que siempre se mide.
        let r = estado_del_sistema();
        assert!(r.ok);
        assert!(r.say.contains("gigas de memoria"), "frase rara: {}", r.say);
        assert!(r.say.contains("disco"), "frase rara: {}", r.say);
    }

    #[test]
    fn los_registros_siempre_contestan_algo() {
        // Caso negativo del mandamiento 11: aunque no haya logs, la
        // herramienta tiene que decir QUE pasa, no devolver una frase vacia.
        for fuente in ["maria", "", "loquesea"] {
            let r = mirar_registros(fuente);
            assert!(!r.say.trim().is_empty(), "fuente {fuente:?} se quedo muda");
        }
    }
}
