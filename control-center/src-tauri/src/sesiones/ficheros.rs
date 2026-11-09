// sesiones/ficheros.rs — Ficheros del proyecto para el autocompletar `@`
// del composer (`sesiones_files`).
//
// Rutas relativas a `cwd` con `/`. En un repositorio salen de
// `git ls-files --cached --others --exclude-standard` (respeta .gitignore),
// con un plazo máximo; fuera de un repositorio, de un recorrido acotado que
// salta `node_modules`, `target` y `.git`. Como mucho `MAX_FICHEROS`.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// Tope de rutas devueltas.
pub const MAX_FICHEROS: usize = 5_000;
/// Directorios que el recorrido sin git no visita.
const SALTAR: &[&str] = &["node_modules", "target", ".git"];
/// Entradas de directorio que el recorrido sin git mira como mucho.
const MAX_VISITADAS: usize = 50_000;
const PROFUNDIDAD_MAX: usize = 12;
const PLAZO_GIT: Duration = Duration::from_secs(5);

/// true si `cwd` es el directorio de alguna sesión viva: el comando no lista
/// ni ejecuta git en directorios arbitrarios que mande el cliente.
pub fn es_cwd_de_sesion(cwd: &str, cwds_vivos: &[String]) -> bool {
    // `canonicalize` de un UNC abre una conexión SMB antes de poder rechazarlo.
    if super::archivos::es_ruta_de_red(cwd) {
        return false;
    }
    let norm = |s: &str| {
        std::fs::canonicalize(s.trim())
            .map(|p| p.to_string_lossy().to_lowercase())
            .ok()
    };
    let Some(pedido) = norm(cwd) else {
        return false;
    };
    cwds_vivos
        .iter()
        .any(|c| norm(c).as_deref() == Some(pedido.as_str()))
}

/// Ficheros del proyecto en `cwd`, relativos a él.
pub fn listar(cwd: &str) -> Result<Vec<String>, String> {
    if super::archivos::es_ruta_de_red(cwd) {
        return Err(super::archivos::ERROR_RUTA_DE_RED.to_string());
    }
    let dir = Path::new(cwd.trim());
    if cwd.trim().is_empty() || !dir.is_dir() {
        return Err(format!("el directorio no existe: {cwd}"));
    }
    match git_ls_files(dir) {
        Some(v) if !v.is_empty() => Ok(v),
        _ => Ok(recorrer(dir)),
    }
}

fn leer_rutas(r: impl Read) -> Vec<String> {
    BufReader::new(r)
        .split(0)
        .map_while(Result::ok)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(&s).into_owned())
        .take(MAX_FICHEROS)
        .collect()
}

fn comando_git(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.args([
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
    ])
    .current_dir(dir)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Rutas según git; `None` si no es un repositorio o git no está.
fn git_ls_files(dir: &Path) -> Option<Vec<String>> {
    let mut child = comando_git(dir).spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(leer_rutas(stdout));
    });
    let leido = rx.recv_timeout(PLAZO_GIT);
    let ok = fin_de_git(&mut child);
    match leido {
        Ok(v) if ok || v.len() >= MAX_FICHEROS => Some(v),
        Ok(_) => None,
        Err(_) => {
            tracing::warn!(dir = %dir.display(), "git ls-files no terminó a tiempo");
            rx.recv().ok().filter(|v| !v.is_empty())
        }
    }
}

/// Espera brevemente a que git salga tras cerrar su salida; solo lo mata si
/// sigue vivo (tope alcanzado o plazo vencido). true si salió con éxito.
fn fin_de_git(child: &mut std::process::Child) -> bool {
    let limite = std::time::Instant::now() + Duration::from_millis(500);
    loop {
        match child.try_wait() {
            Ok(Some(s)) => return s.success(),
            Ok(None) if std::time::Instant::now() < limite => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn relativa(base: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(base).ok()?;
    let partes: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(partes.join("/"))
}

/// Recorrido en anchura acotado (sin git).
fn recorrer(base: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut cola: VecDeque<(PathBuf, usize)> = VecDeque::from([(base.to_path_buf(), 0)]);
    let mut visitadas = 0usize;
    while let Some((dir, nivel)) = cola.pop_front() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            visitadas += 1;
            if out.len() >= MAX_FICHEROS || visitadas > MAX_VISITADAS {
                return out;
            }
            let Ok(tipo) = e.file_type() else { continue };
            let p = e.path();
            if tipo.is_dir() {
                let saltar = SALTAR.iter().any(|s| e.file_name() == *s);
                if !saltar && nivel < PROFUNDIDAD_MAX {
                    cola.push_back((p, nivel + 1));
                }
            } else if tipo.is_file() {
                out.extend(relativa(base, &p));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crear(base: &Path, rel: &str) {
        let p = base.join(rel);
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).expect("dir");
        }
        std::fs::write(p, "x").expect("fichero");
    }

    #[test]
    fn un_cwd_que_no_es_directorio_es_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(listar("").is_err());
        assert!(listar(&dir.path().join("nada").to_string_lossy()).is_err());
        crear(dir.path(), "f.txt");
        assert!(listar(&dir.path().join("f.txt").to_string_lossy()).is_err());
    }

    #[test]
    fn sin_git_salta_node_modules_target_y_git() {
        let dir = tempfile::tempdir().expect("tempdir");
        for f in [
            "a.txt",
            "src/b.rs",
            "node_modules/x/i.js",
            "target/o",
            ".git/HEAD",
        ] {
            crear(dir.path(), f);
        }
        let mut v = recorrer(dir.path());
        v.sort();
        assert_eq!(v, ["a.txt", "src/b.rs"]);
    }

    #[test]
    fn en_un_repositorio_respeta_el_gitignore() {
        let dir = tempfile::tempdir().expect("tempdir");
        let init = Command::new("git")
            .args(["init", "-q"])
            .current_dir(dir.path())
            .status();
        if !init.is_ok_and(|s| s.success()) {
            return; // sin git en el PATH no hay nada que probar
        }
        for f in [".gitignore", "a.txt", "sub/c.md", "ignorado.log"] {
            crear(dir.path(), f);
        }
        std::fs::write(dir.path().join(".gitignore"), "*.log\n").expect("gitignore");
        let mut v = listar(&dir.path().to_string_lossy()).expect("listar");
        v.sort();
        assert_eq!(v, [".gitignore", "a.txt", "sub/c.md"]);
    }

    #[test]
    fn solo_lista_el_cwd_de_una_sesion_viva() {
        let dir = tempfile::tempdir().expect("tmp");
        let otro = tempfile::tempdir().expect("tmp");
        let vivos = vec![dir.path().to_string_lossy().into_owned()];
        assert!(es_cwd_de_sesion(&dir.path().to_string_lossy(), &vivos));
        assert!(!es_cwd_de_sesion(&otro.path().to_string_lossy(), &vivos));
        assert!(!es_cwd_de_sesion("", &vivos));
        assert!(!es_cwd_de_sesion(&dir.path().to_string_lossy(), &[]));
        // Por el texto, sin tocar la red, aunque un cwd vivo coincida.
        for red in ["//host/s", r"\\host\s"] {
            assert!(!es_cwd_de_sesion(red, &[red.to_string()]), "{red}");
        }
    }
}
