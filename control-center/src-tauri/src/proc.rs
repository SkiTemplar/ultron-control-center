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
