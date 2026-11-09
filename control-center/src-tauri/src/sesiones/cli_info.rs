// sesiones/cli_info.rs — Procesos de CLI externas con tope de tiempo y árbol
// de procesos acotado (contrato de estabilidad, §8.7).
//
// - `Trabajo`: Job Object de Windows con `KILL_ON_JOB_CLOSE`. Los hijos del
//   proceso asignado heredan el job, así que terminarlo mata también los
//   nietos (el binario nativo de Codex que lanza `node codex.js`,
//   seguridad-robustez:F10). Fuera de Windows es un no-op documentado.
// - `run_cli`: ejecuta una CLI dentro de un `Trabajo` y la corta si supera el
//   tope (motores-ventanas:F11). Lo usan la lista de modelos y cualquier
//   consulta a una CLI fuera del PTY.
//
// Los comandos `sesiones_cli_info` y `sesiones_auth` de la fase 0a se
// retiraron con el cambio de diseño del 2026-10-08 (los menús de la TUI se
// manejan desde el chat): este módulo conserva solo la ejecución acotada.
//
// Propiedad: WP-MOTORES.

use std::io::Read;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(50);

#[cfg(test)]
thread_local! {
    static ULTIMO_SPAWN: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
}

/// Marca, en el hilo actual, el instante en que `spawn` devolvió el hijo.
/// Solo hace algo en los tests: los topes se miden desde que el hijo existe.
/// `Command::spawn` en Windows se serializa dentro de std (un mutex global
/// alrededor de `CreateProcessW`) y, con la suite en paralelo y la máquina
/// cargada, un spawn ha llegado a esperar 11-23 s en esa cola (medido el
/// 2026-10-23, con ~300 ms por `CreateProcessW` sin contención). Medir desde
/// antes del spawn hacía fallar los tests por la cola, no por el tope.
pub(crate) fn marcar_spawn() {
    #[cfg(test)]
    ULTIMO_SPAWN.with(|c| c.set(Some(Instant::now())));
}

/// Tiempo transcurrido desde el último `marcar_spawn` de este hilo.
#[cfg(test)]
pub(crate) fn desde_el_ultimo_spawn() -> Duration {
    ULTIMO_SPAWN
        .with(std::cell::Cell::get)
        .expect("ningún spawn marcado en este hilo")
        .elapsed()
}

/// Job Object que agrupa un proceso y todos sus descendientes.
pub struct Trabajo {
    #[cfg(windows)]
    handle: isize,
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Job anónimo. Con `matar_al_cerrar`, cerrar su último handle mata lo
    /// que quede dentro (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
    pub fn crear(matar_al_cerrar: bool) -> Result<isize, String> {
        // SAFETY: atributos y nombre nulos crean un job anónimo; se comprueba el handle.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(format!(
                "CreateJobObjectW falló: {}",
                std::io::Error::last_os_error()
            ));
        }
        if !matar_al_cerrar {
            return Ok(job as isize);
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `info` vive durante la llamada y el tamaño es el de la estructura.
        let ok = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            let e = std::io::Error::last_os_error();
            // SAFETY: handle propio recién creado.
            unsafe { CloseHandle(job) };
            return Err(format!("SetInformationJobObject falló: {e}"));
        }
        Ok(job as isize)
    }

    pub fn asignar(job: isize, proceso: HANDLE) -> Result<(), String> {
        // SAFETY: `job` es un handle propio vivo y `proceso` el del hijo recién lanzado.
        let ok = unsafe { AssignProcessToJobObject(job as HANDLE, proceso) };
        if ok == 0 {
            return Err(format!(
                "AssignProcessToJobObject falló: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    pub fn terminar(job: isize) -> Result<(), String> {
        // SAFETY: handle propio vivo.
        let ok = unsafe { TerminateJobObject(job as HANDLE, 1) };
        if ok == 0 {
            return Err(format!(
                "TerminateJobObject falló: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn activos(job: isize) -> Option<u32> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: `info` vive durante la llamada y el tamaño es el de la estructura.
        let ok = unsafe {
            QueryInformationJobObject(
                job as HANDLE,
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(info.ActiveProcesses)
    }

    pub fn cerrar(job: isize) {
        // SAFETY: handle propio; se cierra una sola vez desde `Drop`.
        unsafe { CloseHandle(job as HANDLE) };
    }
}

impl Trabajo {
    /// Crea el job y le asigna `child` (sus hijos futuros lo heredan). Al
    /// soltarlo muere lo que quede dentro (`KILL_ON_JOB_CLOSE`).
    pub fn para(child: &Child) -> Result<Self, String> {
        Self::con_cierre(child, true)
    }

    /// Como `para`, pero soltarlo no mata nada: el árbol solo muere con
    /// `terminar`. Para llamantes cuyos hijos pueden dejar procesos que deben
    /// sobrevivir a una salida normal (`ai_router::exec::run_with_timeout`).
    pub fn solo_al_cortar(child: &Child) -> Result<Self, String> {
        Self::con_cierre(child, false)
    }

    #[cfg(windows)]
    fn con_cierre(child: &Child, matar_al_cerrar: bool) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        let t = Self {
            handle: win::crear(matar_al_cerrar)?,
        };
        win::asignar(t.handle, child.as_raw_handle())?;
        Ok(t)
    }

    #[cfg(not(windows))]
    fn con_cierre(_child: &Child, _matar_al_cerrar: bool) -> Result<Self, String> {
        Ok(Self {})
    }

    /// Mata todos los procesos del job.
    pub fn terminar(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            win::terminar(self.handle)
        }
        #[cfg(not(windows))]
        {
            Ok(())
        }
    }

    /// Procesos vivos del job (`None` si no se puede consultar).
    #[cfg(test)]
    pub fn procesos_activos(&self) -> Option<u32> {
        #[cfg(windows)]
        {
            win::activos(self.handle)
        }
        #[cfg(not(windows))]
        {
            None
        }
    }
}

impl Drop for Trabajo {
    fn drop(&mut self) {
        // Con KILL_ON_JOB_CLOSE, cerrar el último handle mata lo que quede.
        #[cfg(windows)]
        win::cerrar(self.handle);
    }
}

// SAFETY: un handle de Job Object es un identificador del núcleo usable desde
// cualquier hilo; `Trabajo` no expone nada mutable.
unsafe impl Send for Trabajo {}
unsafe impl Sync for Trabajo {}

fn drain<R: Read + Send + 'static>(src: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = src {
            if let Err(e) = r.read_to_end(&mut buf) {
                tracing::debug!(error = %e, "lectura de la salida de la CLI interrumpida");
            }
        }
        buf
    })
}

/// Escribe `input` en la entrada estándar del hijo desde otro hilo (una CLI
/// que no lee no bloquea el tope) y la cierra al terminar.
fn feed(stdin: Option<std::process::ChildStdin>, input: Vec<u8>, nombre: &str) {
    let Some(mut stdin) = stdin else { return };
    let nombre = nombre.to_string();
    std::thread::spawn(move || {
        use std::io::Write;
        if let Err(e) = stdin.write_all(&input) {
            tracing::debug!(cli = %nombre, error = %e, "entrada de la CLI no escrita entera");
        }
    });
}

/// Ejecuta `cmd` con stdout y stderr capturados, dentro de un `Trabajo`, y
/// lo corta con su árbol si supera `tope`.
pub fn run_cli(cmd: Command, tope: Duration, nombre: &str) -> Result<Output, String> {
    run_cli_input(cmd, None, tope, nombre)
}

/// Como `run_cli`, pero con `input` en la entrada estándar (`None` = nula).
pub fn run_cli_input(
    mut cmd: Command,
    input: Option<Vec<u8>>,
    tope: Duration,
    nombre: &str,
) -> Result<Output, String> {
    let stdin = if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    };
    cmd.stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("no se pudo lanzar {nombre}: {e}"))?;
    marcar_spawn();
    let trabajo = Trabajo::para(&child)
        .inspect_err(|e| tracing::warn!(cli = nombre, error = %e, "CLI sin Job Object"))
        .ok();
    if let Some(input) = input {
        feed(child.stdin.take(), input, nombre);
    }
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let inicio = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if inicio.elapsed() < tope => std::thread::sleep(POLL),
            Ok(None) => {
                cortar(&mut child, trabajo.as_ref(), nombre);
                return Err(format!(
                    "{nombre} no respondió en {} s: se ha cortado",
                    tope.as_secs()
                ));
            }
            Err(e) => {
                cortar(&mut child, trabajo.as_ref(), nombre);
                return Err(format!("no se pudo esperar a {nombre}: {e}"));
            }
        }
    };
    // Con el hijo ya fuera, cerrar el job (KILL_ON_JOB_CLOSE) se lleva a los
    // nietos que sigan vivos: si heredaron stdout o stderr, las lecturas no
    // verían EOF hasta que acabasen y el tope dejaría de valer.
    drop(trabajo);
    Ok(Output {
        status,
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

fn cortar(child: &mut Child, trabajo: Option<&Trabajo>, nombre: &str) {
    if let Some(t) = trabajo {
        if let Err(e) = t.terminar() {
            tracing::warn!(cli = nombre, error = %e, "no se pudo terminar el job de la CLI");
        }
    }
    if let Err(e) = child.kill() {
        tracing::debug!(cli = nombre, error = %e, "kill de la CLI tras el tope");
    }
    if let Err(e) = child.wait() {
        tracing::debug!(cli = nombre, error = %e, "wait de la CLI tras el tope");
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// `cmd /C ping`: `cmd.exe` es el hijo y `ping` el nieto, que dura ~30 s.
    pub fn comando_lento() -> Command {
        let mut c = Command::new("cmd");
        c.args(["/C", "ping -n 30 127.0.0.1 >NUL"]);
        c
    }

    #[test]
    fn run_cli_corta_una_cli_que_no_responde() {
        let r = run_cli(comando_lento(), Duration::from_secs(1), "lenta");
        let err = r.expect_err("debe cortar");
        assert!(err.contains("no respondió en 1 s"), "{err}");
        let tras_spawn = desde_el_ultimo_spawn();
        assert!(tras_spawn < Duration::from_secs(5), "{tras_spawn:?}");
    }

    /// `cmd` sale al momento y deja un nieto (`ping`, ~20 s) con sus
    /// stdout y stderr heredados.
    pub fn comando_con_nieto_colgado() -> Command {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.arg("/C")
            .raw_arg("start /b ping -n 20 127.0.0.1 & echo hola");
        c
    }

    #[test]
    fn run_cli_no_espera_a_un_nieto_que_retiene_la_salida() {
        let out = run_cli(
            comando_con_nieto_colgado(),
            Duration::from_secs(60),
            "nieto",
        )
        .expect("el hijo sale bien");
        assert!(String::from_utf8_lossy(&out.stdout).contains("hola"));
        let tras_spawn = desde_el_ultimo_spawn();
        assert!(
            tras_spawn < Duration::from_secs(8),
            "el nieto retuvo las tuberías: {tras_spawn:?}"
        );
    }

    #[test]
    fn run_cli_devuelve_la_salida_de_una_cli_rapida() {
        let mut c = Command::new("cmd");
        c.args(["/C", "echo hola"]);
        let out = run_cli(c, Duration::from_secs(10), "eco").expect("rápida");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("hola"));
    }

    #[test]
    fn run_cli_input_entrega_la_entrada_y_respeta_el_tope() {
        let mut c = Command::new("cmd");
        c.args(["/C", "findstr ritmo"]);
        let out = run_cli_input(
            c,
            Some(b"ritmo 5h\r\n".to_vec()),
            Duration::from_secs(10),
            "f",
        )
        .expect("rápida");
        assert!(String::from_utf8_lossy(&out.stdout).contains("ritmo 5h"));
        let r = run_cli_input(
            comando_lento(),
            Some(b"{}".to_vec()),
            Duration::from_secs(1),
            "l",
        );
        assert!(r.is_err(), "con entrada también corta");
        let tras_spawn = desde_el_ultimo_spawn();
        assert!(tras_spawn < Duration::from_secs(5), "{tras_spawn:?}");
    }

    /// Caso negativo de `solo_al_cortar`: soltar el job no mata el árbol
    /// (lo usa `run_with_timeout`, cuyos llamantes pueden dejar procesos
    /// vivos a propósito). Un job exterior con `KILL_ON_JOB_CLOSE` recoge el
    /// árbol al final para no dejar procesos huérfanos.
    #[test]
    fn soltar_un_trabajo_solo_al_cortar_no_mata_el_arbol() {
        let mut child = comando_lento().spawn().expect("spawn");
        let recogida = Trabajo::para(&child).expect("job exterior");
        let corte = Trabajo::solo_al_cortar(&child).expect("job");
        let inicio = Instant::now();
        while corte.procesos_activos() < Some(2) && inicio.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(POLL);
        }
        assert_eq!(
            corte.procesos_activos(),
            Some(2),
            "cmd y ping dentro del job"
        );
        drop(corte);
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            child.try_wait().expect("try_wait").is_none(),
            "soltar el job mató al hijo"
        );
        assert_eq!(
            recogida.procesos_activos(),
            Some(2),
            "el nieto también sigue"
        );
        drop(recogida);
        child.wait().expect("wait");
    }

    #[test]
    fn terminar_el_trabajo_mata_tambien_al_nieto() {
        let mut child = comando_lento().spawn().expect("spawn");
        let t = Trabajo::para(&child).expect("job");
        let inicio = Instant::now();
        while t.procesos_activos() < Some(2) && inicio.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(POLL);
        }
        assert_eq!(t.procesos_activos(), Some(2), "cmd y ping dentro del job");
        t.terminar().expect("terminar");
        child.wait().expect("wait");
        let inicio = Instant::now();
        while t.procesos_activos() != Some(0) && inicio.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(POLL);
        }
        assert_eq!(
            t.procesos_activos(),
            Some(0),
            "no queda ningún proceso del job"
        );
    }
}
