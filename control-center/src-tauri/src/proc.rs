// mar.ia — lanzar procesos SIN abrir una consola.
//
// El usuario lo reporto dos veces: "se me estan abriendo y cerrando de vez en
// cuando pantallas emergentes que se instacierran" (2026-09-18) y de nuevo el
// 2026-09-19. La causa no es un sitio concreto: en Windows, CUALQUIER
// `std::process::Command` que lance un ejecutable de consola abre una ventana
// negra a menos que se le pase `CREATE_NO_WINDOW`. Con ~84 sitios que lanzan
// procesos y varios de ellos en temporizadores (estado del sistema, git de los
// proyectos, sesiones vivas), el escritorio parpadea cada pocos segundos.
//
// Arreglarlo sitio por sitio ya se intento y se volvio a escapar. Aqui esta la
// forma UNICA de construir un `Command`: `proc::oculto(bin)` devuelve un
// Command con la bandera ya puesta. Lo que no pase por aqui, parpadea.
//
// Excepcion legitima: `pty/` NO usa esto — portable-pty no crea consola propia
// (el PTY es la terminal), y ahi el proceso debe conservar su terminal.

use std::process::Command;

/// Bandera de Windows: el proceso hijo no recibe consola.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `Command` que no abre ventana. Sustituye a `Command::new` en todo el
/// codigo que lanza procesos de consola.
#[must_use]
pub fn oculto(bin: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(bin);
    ocultar(&mut cmd);
    cmd
}

/// Pone la bandera en un `Command` ya construido (para los sitios que lo
/// reciben hecho, como los builders de terceros).
pub fn ocultar(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd; // en Unix no hay consola que ocultar
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn construye_un_comando_con_el_binario_pedido() {
        let cmd = oculto("cmd");
        assert_eq!(cmd.get_program(), "cmd");
    }

    #[test]
    fn ocultar_no_toca_los_argumentos() {
        // Caso negativo: si `ocultar` tocara argv, un comando perfectamente
        // formado empezaria a fallar solo por pedirle que no abra ventana.
        let mut cmd = Command::new("git");
        cmd.arg("status").arg("--porcelain");
        ocultar(&mut cmd);
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, vec!["status", "--porcelain"]);
        assert_eq!(cmd.get_program(), "git");
    }

    #[cfg(windows)]
    #[test]
    fn la_bandera_es_la_de_windows() {
        // 0x08000000 es CREATE_NO_WINDOW. Un valor equivocado aqui se
        // traduciria en ventanas parpadeando por todo el escritorio.
        assert_eq!(CREATE_NO_WINDOW, 134_217_728);
    }
}

use std::process::Stdio;
use std::time::{Duration, Instant};

/// Run a prepared `Command` with piped stdio and a wall-clock timeout.
///
/// `stdin_input`, when `Some`, is written to the child's stdin on a
/// background thread and the handle is then dropped to close the pipe (EOF)
/// — `codex exec -` blocks reading stdin until EOF, so writing synchronously
/// before draining stdout/stderr would deadlock once the prompt exceeds the
/// OS pipe buffer. `None` keeps stdin closed (`Stdio::null()`), as before.
///
/// stdout/stderr are drained on background threads (so a chatty child can
/// never deadlock on a full pipe), and on timeout the child is killed and an
/// `ErrorKind::TimedOut` error returned.
pub(crate) fn run_with_timeout(
    mut cmd: std::process::Command,
    timeout: Duration,
    stdin_input: Option<&str>,
) -> std::io::Result<std::process::Output> {
    use std::io::{Read, Write};

    let stdin_mode = if stdin_input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    };
    let mut child = cmd
        .stdin(stdin_mode)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(input) = stdin_input {
        if let Some(mut stdin) = child.stdin.take() {
            let payload = input.as_bytes().to_vec();
            std::thread::spawn(move || {
                let _ = stdin.write_all(&payload);
                // `stdin` drops here, closing the pipe so the child sees EOF.
            });
        }
    }

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut p) = stdout_pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut p) = stderr_pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_reader.join();
                let _ = err_reader.join();
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("CLI call exceeded {}s timeout", timeout.as_secs()),
                ));
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    };

    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}
