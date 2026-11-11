// sesiones/remoto.rs — `claude remote-control` mientras haya una ventana de
// Sessions abierta: permite crear sesiones desde la app móvil de Claude o
// desde claude.ai/code sin ninguna terminal visible.
//
// Ciclo de vida: `abrir` al crear una ventana de Sessions (idempotente) y
// `cerrar` al destruirse la última y en `RunEvent::Exit`. Un supervisor en su
// propio hilo relanza el servidor si sale solo, con espera creciente.
//
// El servidor corre en una pseudoconsola (ConPTY) y no en un proceso con
// `CREATE_NO_WINDOW`, por el cierre: el registro del entorno es un candado
// del servidor por dispositivo y carpeta (`POST /v1/environments/bridge` da
// 409 «This folder is already served…»). Un `TerminateProcess` no lo libera
// y el siguiente arranque se rechaza durante minutos; la CLI solo se da de
// baja al recibir Ctrl+C por su teclado, que fuera de un TTY no lee (ni
// `GenerateConsoleCtrlEvent` la para). Medido el 2026-11-10: en ConPTY,
// `\x03` la cierra en 0,4 s y el relanzamiento inmediato conecta. Si no sale
// en el plazo, se mata el árbol por Job Object (`pty::arbol`).
//
// Configuración (variables de entorno o `~/.ultron/.env`):
//   ULTRON_REMOTE_CONTROL=0          desactiva el servidor
//   ULTRON_REMOTE_CONTROL_CWD=<ruta> carpeta de las sesiones (por defecto
//                                    `~/.ultron`; el home no vale, la CLI no
//                                    guarda la confianza del directorio home)

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};

use crate::pty::arbol::Arbol;

const CLAUDE_JS: &str = "node_modules/@anthropic-ai/claude-code/cli.js";
const ARGS: [&str; 4] = [
    "remote-control",
    "--spawn",
    "same-dir",
    // Sin sesión precreada: cada apertura de Sessions no deja un `claude`
    // ocioso; las sesiones nacen bajo demanda desde el móvil.
    "--no-create-session-in-dir",
];
const ESPERA_MIN: Duration = Duration::from_secs(5);
const ESPERA_MAX: Duration = Duration::from_secs(300);
/// Una ejecución que duró más que esto se considera sana: la espera vuelve
/// al mínimo.
const VIDA_SANA: Duration = Duration::from_secs(120);
const PLAZO_CIERRE: Duration = Duration::from_secs(5);
const CTRL_C: &[u8] = b"\x03";
const CURSOR_QUERY: &[u8] = b"\x1b[6n";
const CURSOR_REPLY: &[u8] = b"\x1b[1;1R";
const COLA_SALIDA: usize = 4096;

type Escritor = Arc<Mutex<Box<dyn Write + Send>>>;

/// Proceso vivo del servidor.
struct Vivo {
    /// Lo marca el supervisor cuando vuelve `wait()`.
    salido: Arc<AtomicBool>,
    /// Lo marca el lector al ver la URL del entorno (servidor registrado).
    listo: Arc<AtomicBool>,
    escritor: Escritor,
    killer: Box<dyn ChildKiller + Send + Sync>,
    arbol: Arbol,
}

#[derive(Default)]
struct Estado {
    /// Cambia en cada `abrir` y `cerrar`: un supervisor de otra generación
    /// termina en cuanto lo ve.
    generacion: u64,
    activo: bool,
    vivo: Option<Vivo>,
}

fn estado() -> &'static Mutex<Estado> {
    static E: OnceLock<Mutex<Estado>> = OnceLock::new();
    E.get_or_init(|| Mutex::new(Estado::default()))
}

fn bloquear() -> std::sync::MutexGuard<'static, Estado> {
    estado()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn vigente(generacion: u64) -> bool {
    let e = bloquear();
    e.activo && e.generacion == generacion
}

/// Arranca el supervisor si no está en marcha. Idempotente.
pub fn abrir() {
    if desactivado(std::env::var("ULTRON_REMOTE_CONTROL").ok().as_deref()) {
        tracing::info!("Remote Control desactivado (ULTRON_REMOTE_CONTROL=0)");
        return;
    }
    let generacion = {
        let mut e = bloquear();
        if e.activo {
            return;
        }
        e.activo = true;
        e.generacion += 1;
        e.generacion
    };
    let r = thread::Builder::new()
        .name("remote-control".into())
        .spawn(move || supervisar(generacion));
    if let Err(e) = r {
        tracing::error!(error = %e, "no se pudo lanzar el supervisor de Remote Control");
        bloquear().activo = false;
    }
}

/// Para el servidor: Ctrl+C por la pseudoconsola y, si no sale en
/// `PLAZO_CIERRE`, mata su árbol. Bloquea como mucho ese plazo.
pub fn cerrar() {
    let vivo = {
        let mut e = bloquear();
        e.activo = false;
        e.generacion += 1;
        e.vivo.take()
    };
    if let Some(v) = vivo {
        detener(&v);
    }
}

fn detener(v: &Vivo) {
    let inicio = Instant::now();
    let mut enviados = 0;
    while inicio.elapsed() < PLAZO_CIERRE {
        if v.salido.load(Ordering::Acquire) {
            tracing::info!(ms = inicio.elapsed().as_millis(), "Remote Control cerrado");
            return;
        }
        // Un segundo Ctrl+C por si el primero solo pidió confirmación.
        if enviados < 2 && inicio.elapsed() >= Duration::from_secs(enviados) {
            escribir(&v.escritor, CTRL_C);
            enviados += 1;
        }
        thread::sleep(Duration::from_millis(100));
    }
    tracing::warn!("Remote Control no salió con Ctrl+C: se mata su árbol");
    if let Err(e) = v.arbol.matar() {
        tracing::warn!(error = %e, "árbol de Remote Control sin matar; se mata el hijo");
        let mut killer = v.killer.clone_killer();
        if let Err(e) = killer.kill() {
            tracing::error!(error = %e, "no se pudo terminar Remote Control");
        }
    }
}

fn escribir(escritor: &Escritor, datos: &[u8]) {
    let mut w = escritor
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Err(e) = w.write_all(datos).and_then(|()| w.flush()) {
        tracing::debug!(error = %e, "Remote Control: escritura en el PTY fallida");
    }
}

fn supervisar(generacion: u64) {
    let mut espera = ESPERA_MIN;
    while vigente(generacion) {
        let inicio = Instant::now();
        match ejecutar(generacion) {
            Ok(Some(salida)) => tracing::warn!(salida = %salida, "Remote Control salió"),
            Ok(None) => return,
            Err(e) => tracing::warn!(error = %e, "Remote Control no arrancó"),
        }
        espera = siguiente_espera(espera, inicio.elapsed());
        tracing::info!(segundos = espera.as_secs(), "Remote Control: reintento");
        if !dormir_vigilando(generacion, espera) {
            return;
        }
    }
}

/// Espera tras una salida: el mínimo si la ejecución fue sana; si no, el
/// doble de la anterior hasta `ESPERA_MAX`.
fn siguiente_espera(anterior: Duration, vida: Duration) -> Duration {
    if vida >= VIDA_SANA {
        return ESPERA_MIN;
    }
    (anterior * 2).clamp(ESPERA_MIN, ESPERA_MAX)
}

/// Duerme `total` mirando cada segundo si la generación sigue vigente.
fn dormir_vigilando(generacion: u64, total: Duration) -> bool {
    let fin = Instant::now() + total;
    while Instant::now() < fin {
        if !vigente(generacion) {
            return false;
        }
        thread::sleep(Duration::from_secs(1).min(fin - Instant::now()));
    }
    vigente(generacion)
}

/// Lanza el servidor y espera a que salga. `Ok(None)` si lo cerró `cerrar`;
/// `Ok(Some(motivo))` si salió solo.
fn ejecutar(generacion: u64) -> Result<Option<String>, String> {
    let cwd = carpeta(
        std::env::var("ULTRON_REMOTE_CONTROL_CWD").ok().as_deref(),
        dirs::home_dir().as_deref(),
    )?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;
    let mut child = pair
        .slave
        .spawn_command(comando(&cwd)?)
        .map_err(|e| format!("spawn claude remote-control: {e}"))?;
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("lector del PTY: {e}"))?;
    let escritor: Escritor = Arc::new(Mutex::new(
        pair.master
            .take_writer()
            .map_err(|e| format!("escritor del PTY: {e}"))?,
    ));
    let pid = child.process_id();
    let salido = Arc::new(AtomicBool::new(false));
    let listo = Arc::new(AtomicBool::new(false));
    let vivo = Vivo {
        salido: salido.clone(),
        listo: listo.clone(),
        escritor: escritor.clone(),
        killer: child.clone_killer(),
        arbol: Arbol::crear(pid),
    };
    tracing::info!(pid = ?pid, cwd = %cwd.display(), "Remote Control lanzado");
    let cola = Arc::new(Mutex::new(String::new()));
    let lector = {
        let cola = cola.clone();
        thread::Builder::new()
            .name("remote-control-lector".into())
            .spawn(move || leer(reader, &escritor, &cola, &listo))
            .map_err(|e| format!("hilo lector: {e}"))?
    };
    // `cerrar` pudo llegar durante el arranque: entonces se detiene aquí.
    let huerfano = {
        let mut e = bloquear();
        if e.activo && e.generacion == generacion {
            e.vivo = Some(vivo);
            None
        } else {
            Some(vivo)
        }
    };
    if let Some(v) = huerfano {
        // En otro hilo: `detener` espera a que este vuelva de `wait()`.
        thread::spawn(move || detener(&v));
    }
    let status = child.wait();
    salido.store(true, Ordering::Release);
    // El maestro vive hasta aquí: soltarlo antes cerraría la pseudoconsola.
    drop(pair.master);
    let _ = lector.join();
    let registrado = {
        let mut e = bloquear();
        if !(e.activo && e.generacion == generacion) {
            return Ok(None);
        }
        e.vivo
            .take()
            .is_some_and(|v| v.listo.load(Ordering::Acquire))
    };
    let codigo = status.map_or_else(
        |e| format!("error al esperar: {e}"),
        |s| format!("código {}", s.exit_code()),
    );
    let texto = cola.lock().map(|c| c.clone()).unwrap_or_default();
    let fase = if registrado {
        "tras registrarse"
    } else {
        "sin llegar a registrarse"
    };
    Ok(Some(match ultimo_error(&texto) {
        Some(err) => format!("{fase}, {codigo}: {err}"),
        None => format!("{fase}, {codigo}"),
    }))
}

fn comando(cwd: &Path) -> Result<CommandBuilder, String> {
    let found =
        which::which("claude").map_err(|_| "no se encontró 'claude' en el PATH".to_string())?;
    let p = super::motores::resolve_found(&found, CLAUDE_JS)?;
    let mut cmd = CommandBuilder::new(&p.exe);
    cmd.args(&p.pre_args);
    cmd.args(ARGS);
    cmd.cwd(cwd);
    for k in super::lanzamiento::claves_excluidas(std::env::vars().map(|(k, _)| k)) {
        cmd.env_remove(k);
    }
    Ok(cmd)
}

/// Lee la pseudoconsola: contesta la consulta de cursor de ConPTY, anota la
/// URL del entorno y conserva la cola del texto para diagnosticar una salida.
fn leer(
    mut reader: Box<dyn Read + Send>,
    escritor: &Escritor,
    cola: &Mutex<String>,
    listo: &AtomicBool,
) {
    let mut buf = [0u8; 4096];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let trozo = &buf[..n];
        if trozo.windows(CURSOR_QUERY.len()).any(|w| w == CURSOR_QUERY) {
            escribir(escritor, CURSOR_REPLY);
        }
        let texto = sin_ansi(&String::from_utf8_lossy(trozo));
        let Ok(mut c) = cola.lock() else { return };
        c.push_str(&texto);
        recortar(&mut c, COLA_SALIDA);
        if !listo.load(Ordering::Relaxed) {
            if let Some(url) = url_entorno(&c) {
                tracing::info!(%url, "Remote Control listo");
                listo.store(true, Ordering::Release);
            }
        }
    }
}

/// `false` salvo que la variable pida apagarlo (`0`, `false`, `off`, `no`).
fn desactivado(valor: Option<&str>) -> bool {
    valor.is_some_and(|v| {
        matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        )
    })
}

/// Carpeta del servidor: la configurada o `~/.ultron`. Tiene que existir y
/// no puede ser el home (la CLI lo rechaza siempre).
fn carpeta(configurada: Option<&str>, home: Option<&Path>) -> Result<PathBuf, String> {
    let home = home.ok_or("no se encontró el directorio home")?;
    let dir = match configurada.map(str::trim).filter(|s| !s.is_empty()) {
        Some(c) => PathBuf::from(c),
        None => home.join(".ultron"),
    };
    if !dir.is_dir() {
        return Err(format!(
            "la carpeta de Remote Control no existe: {}",
            dir.display()
        ));
    }
    if dir == home {
        return Err("Remote Control no puede servir el home: elige una carpeta de proyecto".into());
    }
    Ok(dir)
}

/// Quita las secuencias de escape CSI y OSC de un trozo de salida.
fn sin_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('[') => {
                for c in it.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(c) = it.next() {
                    if c == '\u{7}' || (c == '\u{1b}' && it.next_if_eq(&'\\').is_some()) {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Deja en `s` como mucho los últimos `max` bytes, cortando en un carácter.
fn recortar(s: &mut String, max: usize) {
    if s.len() <= max {
        return;
    }
    let mut corte = s.len() - max;
    while !s.is_char_boundary(corte) {
        corte += 1;
    }
    s.drain(..corte);
}

fn url_entorno(texto: &str) -> Option<&str> {
    let inicio = texto.find("https://claude.ai/code?environment=")?;
    let resto = &texto[inicio..];
    let fin = resto.find(char::is_whitespace).unwrap_or(resto.len());
    Some(&resto[..fin])
}

fn ultimo_error(texto: &str) -> Option<String> {
    texto
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with("Error"))
        .map(|l| l.trim().to_string())
}

#[cfg(test)]
#[path = "tests_remoto.rs"]
mod tests;
