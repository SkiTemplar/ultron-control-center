// pty/arbol.rs — Árbol de procesos de un PTY en un Job Object (contrato de
// estabilidad, §3.4).
//
// El hijo del PTY es `cmd.exe /C claude`, que lanza `claude` y este sus
// propios nietos (node, bash, MCP…). Matar solo `cmd.exe` deja huérfanos. Cada
// PTY tiene un Job Object con `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: al
// terminarlo o al cerrar su handle muere todo el árbol. La asignación compite
// con el arranque de `cmd.exe`, así que justo después de asignar se recorren
// los descendientes (Toolhelp32, por PID padre) y se asignan también; los que
// nazcan después heredan el job. Si `TerminateJobObject` falla, se terminan
// uno a uno el hijo y esos mismos descendientes.
//
// El PID padre de Toolhelp32 no se actualiza al morir el padre: un huérfano
// cuyo padre muerto tuviera el PID que hoy usa la raíz parecería su hijo. Por
// eso un proceso solo cuenta como descendiente si nació después que su padre
// (hora de creación), y por eso no se usa `taskkill /T`, que no lo comprueba.

/// Job Object de un PTY. Al soltarlo se cierra el handle y, con
/// `KILL_ON_JOB_CLOSE`, muere lo que quede vivo del árbol.
pub struct Arbol {
    #[cfg_attr(
        not(windows),
        allow(dead_code, reason = "solo lo usa la red de Windows")
    )]
    pid: Option<u32>,
    #[cfg(windows)]
    job: Option<win::Job>,
}

impl Arbol {
    /// Crea el job, asigna `pid` y sus descendientes. Un fallo se registra y
    /// deja el árbol sin job (`matar` terminará los procesos uno a uno).
    pub fn crear(pid: Option<u32>) -> Self {
        #[cfg(windows)]
        {
            let job = pid.and_then(|p| match win::Job::nuevo() {
                Ok(j) => {
                    j.asignar_arbol(p);
                    Some(j)
                }
                Err(e) => {
                    tracing::warn!(pid = p, error = %e, "sin Job Object para el PTY");
                    None
                }
            });
            Self { pid, job }
        }
        #[cfg(not(windows))]
        {
            Self { pid }
        }
    }

    /// Mata el árbol entero. Ok si el job lo terminó o si la red lo hizo.
    pub fn matar(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            if let Some(j) = &self.job {
                match j.terminar() {
                    Ok(()) => return Ok(()),
                    Err(e) => tracing::warn!(error = %e, "TerminateJobObject falló: taskkill"),
                }
            }
            match self.pid {
                Some(p) => terminar_uno_a_uno(p),
                None => Err("el PTY no tiene PID".to_string()),
            }
        }
        #[cfg(not(windows))]
        {
            Err("matar el árbol solo está implementado en Windows".to_string())
        }
    }
}

/// Red de `matar` sin job: termina `pid` y sus descendientes verificados.
/// Los descendientes se leen antes de matar a la raíz, porque al morir ella
/// sus hijos quedan huérfanos y ya no se pueden validar contra su hora.
#[cfg(windows)]
fn terminar_uno_a_uno(pid: u32) -> Result<(), String> {
    let mut objetivo = descendientes(pid);
    objetivo.insert(0, pid);
    let fallos: Vec<String> = objetivo
        .into_iter()
        .filter_map(|p| win::terminar_proceso(p).err().map(|e| format!("{p}: {e}")))
        .collect();
    if fallos.is_empty() {
        Ok(())
    } else {
        Err(format!("no se pudo terminar: {}", fallos.join("; ")))
    }
}

/// PIDs de todos los descendientes de `raiz` (sin incluirla).
#[cfg(windows)]
pub fn descendientes(raiz: u32) -> Vec<u32> {
    descendientes_en(&win::procesos(), raiz, win::hora_de_creacion)
}

/// Recorrido de `descendientes` sobre una instantánea `(pid, pid padre)`.
/// Un proceso solo es hijo de `p` si nació después que `p` (`creado` da la
/// hora de creación; `None` = no se puede leer, y entonces no cuenta): así un
/// huérfano cuyo padre muerto tenía un PID hoy reutilizado no entra.
#[cfg_attr(not(windows), allow(dead_code, reason = "solo lo usa Windows"))]
fn descendientes_en(
    pares: &[(u32, u32)],
    raiz: u32,
    creado: impl Fn(u32) -> Option<u64>,
) -> Vec<u32> {
    let mut out = Vec::new();
    let mut frente = vec![raiz];
    while let Some(p) = frente.pop() {
        let Some(nacio_p) = creado(p) else { continue };
        for &(hijo, padre) in pares {
            if padre != p || hijo == raiz || out.contains(&hijo) {
                continue;
            }
            if creado(hijo).is_some_and(|nacio| nacio >= nacio_p) {
                out.push(hijo);
                frente.push(hijo);
            }
        }
    }
    out
}

/// true si el proceso `pid` sigue vivo.
#[cfg(all(test, windows))]
pub fn sigue_vivo(pid: u32) -> bool {
    win::sigue_vivo(pid)
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    /// Handle propio que se cierra al soltarlo.
    struct Handle(HANDLE);

    impl Handle {
        fn valido(h: HANDLE) -> Option<Self> {
            (!h.is_null() && h != INVALID_HANDLE_VALUE).then_some(Self(h))
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: `self.0` es un handle válido abierto por este módulo y
            // solo se cierra aquí, una vez.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub struct Job(Handle);

    // SAFETY: un handle de Job Object es un identificador del kernel que se
    // puede usar desde cualquier hilo; el tipo no expone el puntero.
    unsafe impl Send for Job {}
    // SAFETY: las llamadas sobre el job (asignar, terminar) son seguras en
    // paralelo según la documentación de Win32.
    unsafe impl Sync for Job {}

    impl Job {
        pub fn nuevo() -> Result<Self, String> {
            // SAFETY: atributos nulos y nombre nulo son válidos (job anónimo).
            let h = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            let h = Handle::valido(h).ok_or_else(ultimo_error)?;
            // SAFETY: estructura POD de Win32; todo a cero es un valor válido.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let tam = u32::try_from(std::mem::size_of_val(&info)).unwrap_or(u32::MAX);
            // SAFETY: `info` vive durante la llamada y `tam` es su tamaño.
            let ok = unsafe {
                SetInformationJobObject(
                    h.0,
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&info).cast(),
                    tam,
                )
            };
            if ok == 0 {
                return Err(ultimo_error());
            }
            Ok(Self(h))
        }

        /// Asigna `pid` y, después, todos sus descendientes ya existentes.
        pub fn asignar_arbol(&self, pid: u32) {
            if let Err(e) = self.asignar(pid) {
                tracing::warn!(pid, error = %e, "no se pudo asignar el proceso al job");
            }
            for d in super::descendientes(pid) {
                if let Err(e) = self.asignar(d) {
                    tracing::debug!(pid = d, error = %e, "descendiente fuera del job");
                }
            }
        }

        fn asignar(&self, pid: u32) -> Result<(), String> {
            // SAFETY: `OpenProcess` no tiene precondiciones; el handle se
            // envuelve para cerrarlo.
            let h = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
            let h = Handle::valido(h).ok_or_else(ultimo_error)?;
            // SAFETY: los dos handles son válidos durante la llamada.
            let ok = unsafe { AssignProcessToJobObject(self.0 .0, h.0) };
            if ok == 0 {
                return Err(ultimo_error());
            }
            Ok(())
        }

        pub fn terminar(&self) -> Result<(), String> {
            // SAFETY: handle de job válido mientras viva `self`.
            let ok = unsafe { TerminateJobObject(self.0 .0, 1) };
            if ok == 0 {
                return Err(ultimo_error());
            }
            Ok(())
        }
    }

    fn ultimo_error() -> String {
        std::io::Error::last_os_error().to_string()
    }

    /// Hora de creación de `pid` (FILETIME en un `u64`), o `None` si no se
    /// puede abrir el proceso.
    pub fn hora_de_creacion(pid: u32) -> Option<u64> {
        // SAFETY: sin precondiciones; el handle se envuelve para cerrarlo.
        let h = Handle::valido(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
        let cero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut creacion, mut salida, mut nucleo, mut usuario) = (cero, cero, cero, cero);
        // SAFETY: `h` es válido y las cuatro estructuras viven durante la llamada.
        let ok = unsafe {
            GetProcessTimes(
                h.0,
                &raw mut creacion,
                &raw mut salida,
                &raw mut nucleo,
                &raw mut usuario,
            )
        };
        (ok != 0)
            .then(|| (u64::from(creacion.dwHighDateTime) << 32) | u64::from(creacion.dwLowDateTime))
    }

    /// Termina un proceso por PID (red de `matar` sin job).
    pub fn terminar_proceso(pid: u32) -> Result<(), String> {
        // SAFETY: sin precondiciones; el handle se envuelve para cerrarlo.
        let h = Handle::valido(unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) })
            .ok_or_else(ultimo_error)?;
        // SAFETY: `h` es un handle válido con PROCESS_TERMINATE.
        if unsafe { TerminateProcess(h.0, 1) } == 0 {
            return Err(ultimo_error());
        }
        Ok(())
    }

    /// (pid, pid del padre) de todos los procesos del sistema.
    pub fn procesos() -> Vec<(u32, u32)> {
        // SAFETY: instantánea de procesos; el handle se envuelve para cerrarlo.
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        let Some(snap) = Handle::valido(snap) else {
            return Vec::new();
        };
        // SAFETY: estructura POD; `dwSize` se fija antes de usarla.
        let mut e: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        e.dwSize = u32::try_from(std::mem::size_of::<PROCESSENTRY32W>()).unwrap_or(0);
        let mut out = Vec::new();
        // SAFETY: `snap` es válido y `e` tiene su `dwSize` correcto.
        let mut ok = unsafe { Process32FirstW(snap.0, &raw mut e) };
        while ok != 0 {
            out.push((e.th32ProcessID, e.th32ParentProcessID));
            // SAFETY: igual que la llamada anterior.
            ok = unsafe { Process32NextW(snap.0, &raw mut e) };
        }
        out
    }

    #[cfg(test)]
    pub fn sigue_vivo(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::STILL_ACTIVE;
        use windows_sys::Win32::System::Threading::GetExitCodeProcess;
        // SAFETY: sin precondiciones; el handle se envuelve para cerrarlo.
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        let Some(h) = Handle::valido(h) else {
            return false;
        };
        let mut code = 0u32;
        // SAFETY: `h` es válido y `code` vive durante la llamada.
        let ok = unsafe { GetExitCodeProcess(h.0, &raw mut code) };
        ok != 0 && i32::try_from(code).ok() == Some(STILL_ACTIVE)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    fn esperar(cond: impl Fn() -> bool, max: Duration) -> bool {
        let t = Instant::now();
        while t.elapsed() < max {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        cond()
    }

    /// Un nieto creado por `cmd.exe /C` antes de la asignación muere con
    /// `matar` (el barrido de descendientes lo mete en el job).
    #[test]
    fn matar_el_arbol_mata_al_nieto_creado_antes_de_asignar() {
        let mut hijo = std::process::Command::new("cmd.exe")
            .args(["/C", "ping", "-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("cmd");
        let pid = hijo.id();
        assert!(
            esperar(|| !descendientes(pid).is_empty(), Duration::from_secs(5)),
            "cmd.exe no lanzó ping"
        );
        let nietos = descendientes(pid);
        let arbol = Arbol::crear(Some(pid));
        arbol.matar().expect("matar");
        let _ = hijo.wait();
        for n in nietos {
            assert!(
                esperar(|| !sigue_vivo(n), Duration::from_secs(3)),
                "el nieto {n} sigue vivo"
            );
        }
    }

    /// Caso negativo: un proceso que no está en el árbol no muere. El ajeno
    /// dura ~120 s: con 10 s, un `spawn` lento de la suite en paralelo (11 s
    /// medidos) le dejaba acabar solo con código 0 y el test lo daba por
    /// matado. Se comprueba con `try_wait` sobre su propio handle.
    #[test]
    fn matar_un_arbol_no_toca_procesos_ajenos() {
        let mut ajeno = std::process::Command::new("cmd.exe")
            .args(["/C", "ping", "-n", "120", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("cmd ajeno");
        let mut hijo = std::process::Command::new("cmd.exe")
            .args(["/C", "ping", "-n", "10", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("cmd");
        let arbol = Arbol::crear(Some(hijo.id()));
        arbol.matar().expect("matar");
        let _ = hijo.wait();
        let estado = ajeno.try_wait().expect("try_wait del ajeno");
        let _ = ajeno.kill();
        let _ = ajeno.wait();
        assert!(estado.is_none(), "el proceso ajeno murió: {estado:?}");
    }

    /// Un huérfano cuyo PID padre coincide con la raíz pero nació antes que
    /// ella (su padre real murió y el PID se reutilizó) no es descendiente.
    #[test]
    fn un_huerfano_con_el_pid_padre_reutilizado_no_es_descendiente() {
        // (pid, padre): 10 = raíz (t=100); 11 = hijo real (t=150) y 12 su
        // nieto (t=160); 20 = huérfano anterior a la raíz (t=50) y 21 su hijo.
        let pares = [(10, 1), (11, 10), (12, 11), (20, 10), (21, 20)];
        let creado = |p: u32| match p {
            10 => Some(100),
            11 => Some(150),
            12 => Some(160),
            20 => Some(50),
            21 => Some(60),
            _ => None,
        };
        let mut d = descendientes_en(&pares, 10, creado);
        d.sort_unstable();
        assert_eq!(d, vec![11, 12]);
    }

    /// Un proceso cuya hora no se puede leer no cuenta, ni sus hijos.
    #[test]
    fn sin_hora_de_creacion_no_hay_descendiente() {
        let pares = [(11, 10), (12, 11)];
        let creado = |p: u32| (p == 10).then_some(100);
        assert!(descendientes_en(&pares, 10, creado).is_empty());
        assert!(descendientes_en(&pares, 10, |_| None).is_empty());
    }
}
