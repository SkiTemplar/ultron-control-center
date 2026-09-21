// mar.ia — puntos de control: deshacer lo que hizo un agente sin tocar el git
// del usuario.
//
// EL HUECO (2026-09-22): con «Acceso total» las tres CLI corren con las
// banderas de saltarse permisos dentro de la carpeta del proyecto, y la unica
// red de seguridad era el git del usuario a mano. Un grep de
// checkpoint|deshacer|revertir|stash sobre todo el codigo daba un solo acierto,
// y era una cadena de texto dentro de una plantilla.
//
// LA DECISION: un repositorio git EN LA SOMBRA por conversacion, fuera del
// proyecto (`<raiz>/cockpit/maria/puntos/<hilo>.git`), apuntando al arbol de
// trabajo real con `--work-tree`. El `.git` del usuario NO se toca: ni un
// commit en su rama, ni un stash, ni un ref nuevo. Fotografiar con commits en
// el repo del usuario ensuciaria su historia; pedirle el arbol limpio para
// poder deshacer —el problema documentado de otras herramientas— obligaria al
// usuario a trabajar para nosotros.
//
// LO QUE ESTE MODULO NO HACE TODAVIA (mandamiento 13, alcance explicito): no
// esta cableado a nada. No hay comando Tauri, ni foto por turno, ni boton de
// «volver a aqui». Es la mitad autonoma —foto, restauracion, listado y barrido
// por antiguedad— con sus pruebas; el cableado al relevo, a los encargos y al
// chat es un paso aparte, para que un fallo aqui no se coma trabajo del
// usuario antes de estar probado.
#![allow(dead_code)] // se consume en el paso de cableado; ver el parrafo de arriba

use std::path::{Path, PathBuf};

/// Identidad con la que firman los puntos de control. Fija y anonima: el repo
/// es publico y esto acaba en objetos de git.
const AUTOR: &str = "mar.ia";
const CORREO: &str = "maria@localhost";

/// Tope de entradas que se recorren antes de declarar el arbol demasiado
/// grande. Fotografiar un arbol de varios GB en cada turno es el fallo de
/// rendimiento que otras herramientas han publicado: turnos bloqueados de
/// segundos a minutos. Aqui se prefiere NO tomar la foto y decirlo.
const MAX_ENTRADAS: usize = 20_000;

/// Carpetas que el fusible no cuenta. No es un sustituto del `.gitignore` del
/// proyecto (de eso ya se encarga git al indexar): es solo para que el conteo
/// no se vaya en `node_modules` y compania.
const NO_CUENTAN: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".cache",
];

/// Un punto de control.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Punto {
    /// Identificador del commit en el repositorio en la sombra.
    pub sha: String,
    /// Momento en que se tomo, RFC 3339.
    pub ts: String,
    /// Para que se tomo ("turno 12", "encargo ab12cd34"…).
    pub etiqueta: String,
}

/// Lo que ha pasado al volver a un punto.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Restauracion {
    /// Punto que se tomo ANTES de restaurar. Volver tambien se puede deshacer.
    pub antes: String,
    /// Ficheros que han cambiado en el arbol de trabajo.
    pub ficheros: usize,
}

/// Motivo por el que no se ha tomado una foto. Se distingue del resto de
/// errores para que la interfaz pueda DECIRLO en vez de callarse: una red de
/// seguridad que no saltó y no avisa es peor que no tenerla.
pub const ARBOL_DEMASIADO_GRANDE: &str = "el proyecto tiene demasiados ficheros para fotografiarlo";

// ---------------------------------------------------------------------------
// Donde viven los puntos
// ---------------------------------------------------------------------------

/// Carpeta que guarda un repositorio en la sombra por conversacion.
fn raiz() -> Result<PathBuf, String> {
    let dir = crate::maria::paths::cockpit("maria")?.join("puntos");
    std::fs::create_dir_all(&dir).map_err(|e| format!("crear carpeta de puntos: {e}"))?;
    Ok(dir)
}

/// El repositorio en la sombra de una conversacion, dentro de `raiz`.
///
/// El id se valida igual que el de un hilo: es un nombre de carpeta, no una
/// ruta. Sin esto, un id con `..` escribiria fuera.
fn sombra_en(raiz: &Path, hilo: &str) -> Result<PathBuf, String> {
    if hilo.is_empty()
        || hilo.len() > 64
        || !hilo
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("id de conversacion invalido: {hilo:?}"));
    }
    Ok(raiz.join(format!("{hilo}.git")))
}

/// Lanza git contra el repositorio en la sombra, con el arbol de trabajo del
/// proyecto. Nunca se invoca sin las dos banderas: si se heredaran `GIT_DIR` o
/// `GIT_WORK_TREE` del entorno, se estaria escribiendo en el repo del usuario.
fn git(sombra: &Path, proyecto: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = crate::proc::oculto("git");
    cmd.arg(format!("--git-dir={}", sombra.display()))
        .arg(format!("--work-tree={}", proyecto.display()))
        .args(args)
        .current_dir(proyecto);
    let out = cmd.output().map_err(|e| format!("no encuentro git: {e}"))?;
    let salida = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        return Ok(salida);
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if err.is_empty() { salida } else { err })
}

/// Crea el repositorio en la sombra si no existe. Idempotente.
///
/// Escribe su propio `info/exclude` con `.git/`: el `.git` del proyecto, visto
/// desde un git-dir ajeno, es una carpeta normal y se indexaria entera. Seria
/// enorme y, peor, una restauracion podria sobrescribir la historia del
/// usuario. Esta linea es lo que lo impide.
fn asegurar(sombra: &Path, proyecto: &Path) -> Result<(), String> {
    if !proyecto.is_dir() {
        return Err(format!("el proyecto no existe: {}", proyecto.display()));
    }
    if !sombra.join("HEAD").exists() {
        std::fs::create_dir_all(sombra).map_err(|e| format!("crear el repo en la sombra: {e}"))?;
        // `init` es la unica invocacion SIN `--work-tree`: git se niega a
        // crear un repositorio desnudo y a la vez apuntar a un arbol ajeno.
        let out = crate::proc::oculto("git")
            .args(["init", "--quiet", "--bare"])
            .arg(sombra.as_os_str())
            .output()
            .map_err(|e| format!("no encuentro git: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "crear el repo en la sombra: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        // `--bare` deja core.bare=true y con eso git se niega a usar un arbol
        // de trabajo. Se apaga: el repositorio no tiene arbol PROPIO, pero si
        // el que se le pasa en cada invocacion.
        git(sombra, proyecto, &["config", "core.bare", "false"])?;
        git(sombra, proyecto, &["config", "user.name", AUTOR])?;
        git(sombra, proyecto, &["config", "user.email", CORREO])?;
        // Que el final de linea de los ficheros del usuario no se toque.
        git(sombra, proyecto, &["config", "core.autocrlf", "false"])?;
    }
    let info = sombra.join("info");
    std::fs::create_dir_all(&info).map_err(|e| format!("crear info/: {e}"))?;
    std::fs::write(info.join("exclude"), ".git/\n")
        .map_err(|e| format!("escribir info/exclude: {e}"))?;
    Ok(())
}

/// Cuenta entradas del arbol hasta `tope`, saltando las carpetas de siempre.
///
/// Se para en cuanto llega al tope: el coste esta acotado por construccion, que
/// es justo lo que le falta a un `git status` sobre un arbol enorme.
fn entradas_hasta(proyecto: &Path, tope: usize) -> usize {
    let mut n = 0;
    let mut pendientes = vec![proyecto.to_path_buf()];
    while let Some(dir) = pendientes.pop() {
        let Ok(hijos) = std::fs::read_dir(&dir) else {
            continue;
        };
        for hijo in hijos.flatten() {
            let nombre = hijo.file_name();
            let nombre = nombre.to_string_lossy();
            if NO_CUENTAN.iter().any(|x| *x == nombre) {
                continue;
            }
            n += 1;
            if n >= tope {
                return n;
            }
            if hijo.file_type().is_ok_and(|t| t.is_dir()) {
                pendientes.push(hijo.path());
            }
        }
    }
    n
}

// ---------------------------------------------------------------------------
// Foto, listado y vuelta
// ---------------------------------------------------------------------------

/// Fotografia el arbol de trabajo del proyecto. Devuelve el punto.
///
/// Se toma SIEMPRE una, aunque no haya cambios (`--allow-empty`): asi cada
/// turno tiene su punto y «volver a aqui» apunta a un sitio real.
pub fn foto_en(raiz: &Path, proyecto: &Path, hilo: &str, etiqueta: &str) -> Result<Punto, String> {
    let sombra = sombra_en(raiz, hilo)?;
    if entradas_hasta(proyecto, MAX_ENTRADAS) >= MAX_ENTRADAS {
        return Err(ARBOL_DEMASIADO_GRANDE.to_string());
    }
    asegurar(&sombra, proyecto)?;
    git(&sombra, proyecto, &["add", "-A"])?;
    let ts = chrono::Utc::now().to_rfc3339();
    let mensaje = format!("{ts} · {}", etiqueta.replace('\n', " "));
    git(
        &sombra,
        proyecto,
        &["commit", "--quiet", "--allow-empty", "-m", &mensaje],
    )?;
    let sha = git(&sombra, proyecto, &["rev-parse", "HEAD"])?;
    Ok(Punto {
        sha,
        ts,
        etiqueta: etiqueta.to_string(),
    })
}

/// Los puntos de una conversacion, del mas reciente al mas antiguo.
///
/// Una conversacion sin puntos devuelve la lista vacia, no un error: todavia no
/// se le ha tomado ninguna foto y eso es normal.
pub fn lista_en(raiz: &Path, proyecto: &Path, hilo: &str) -> Result<Vec<Punto>, String> {
    let sombra = sombra_en(raiz, hilo)?;
    if !sombra.join("HEAD").exists() {
        return Ok(Vec::new());
    }
    let salida = git(
        &sombra,
        proyecto,
        &["log", "--format=%H%x1f%s", "--max-count=200"],
    )
    .unwrap_or_default();
    Ok(salida
        .lines()
        .filter_map(|l| {
            let (sha, resto) = l.split_once('\u{1f}')?;
            let (ts, etiqueta) = resto.split_once(" · ").unwrap_or((resto, ""));
            Some(Punto {
                sha: sha.to_string(),
                ts: ts.to_string(),
                etiqueta: etiqueta.to_string(),
            })
        })
        .collect())
}

/// Devuelve el arbol de trabajo al estado de `sha`.
///
/// Antes de tocar nada se toma OTRA foto: volver tambien se puede deshacer, y
/// lo que el usuario tuviera a medias no se pierde por pulsar un boton.
///
/// `read-tree -u --reset` es lo que hace que la vuelta sea completa y no a
/// medias: restaura lo que cambio y BORRA lo que el agente creo despues. Solo
/// alcanza a lo que el repositorio en la sombra tiene indexado —es decir, lo
/// que el `.gitignore` del proyecto deja ver—, asi que ni toca `node_modules`
/// ni el `.git` del usuario.
pub fn volver_en(
    raiz: &Path,
    proyecto: &Path,
    hilo: &str,
    sha: &str,
) -> Result<Restauracion, String> {
    let sombra = sombra_en(raiz, hilo)?;
    if !sombra.join("HEAD").exists() {
        return Err("esta conversacion no tiene puntos de control".into());
    }
    // Que el punto exista Y sea un commit de ESTE repositorio en la sombra.
    let tipo = git(&sombra, proyecto, &["cat-file", "-t", sha])
        .map_err(|_| format!("no tengo ningun punto {sha}"))?;
    if tipo != "commit" {
        return Err(format!("{sha} no es un punto de control"));
    }
    let red = foto_en(raiz, proyecto, hilo, "antes de volver atras")?;
    let cambios = git(
        &sombra,
        proyecto,
        &["diff", "--name-only", &format!("{sha}..{}", red.sha)],
    )
    .unwrap_or_default();
    git(&sombra, proyecto, &["read-tree", "-u", "--reset", sha])?;
    Ok(Restauracion {
        antes: red.sha,
        ficheros: cambios.lines().filter(|l| !l.trim().is_empty()).count(),
    })
}

// ---------------------------------------------------------------------------
// Barrido
// ---------------------------------------------------------------------------

/// Borra los repositorios en la sombra que llevan mas de `dias` sin usarse.
///
/// Sin esto la carpeta crece sin freno: cada conversacion con proyecto deja el
/// suyo y nadie los quita. Se mira la fecha de `HEAD`, que es lo que toca cada
/// foto. Devuelve cuantos se han borrado.
pub fn barrer_en(raiz: &Path, dias: u64) -> usize {
    let Ok(entradas) = std::fs::read_dir(raiz) else {
        return 0;
    };
    let limite = std::time::Duration::from_secs(dias.saturating_mul(24 * 60 * 60));
    let ahora = std::time::SystemTime::now();
    let mut borrados = 0;
    for entrada in entradas.flatten() {
        let dir = entrada.path();
        if !dir.is_dir() || dir.extension().and_then(|x| x.to_str()) != Some("git") {
            continue;
        }
        let viejo = std::fs::metadata(dir.join("HEAD"))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| ahora.duration_since(t).ok())
            .is_some_and(|edad| edad > limite);
        if viejo && std::fs::remove_dir_all(&dir).is_ok() {
            borrados += 1;
        }
    }
    borrados
}

// ---------------------------------------------------------------------------
// Las mismas, contra la carpeta de verdad
// ---------------------------------------------------------------------------

pub fn foto(proyecto: &Path, hilo: &str, etiqueta: &str) -> Result<Punto, String> {
    foto_en(&raiz()?, proyecto, hilo, etiqueta)
}

pub fn lista(proyecto: &Path, hilo: &str) -> Result<Vec<Punto>, String> {
    lista_en(&raiz()?, proyecto, hilo)
}

pub fn volver(proyecto: &Path, hilo: &str, sha: &str) -> Result<Restauracion, String> {
    volver_en(&raiz()?, proyecto, hilo, sha)
}

/// Barrido por antiguedad, con el mismo plazo que usa Claude Code.
pub fn barrer(dias: u64) -> usize {
    raiz().map(|r| barrer_en(&r, dias)).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Un proyecto de usar y tirar CON su propio git, para poder comprobar que
    /// no se le toca. Se borra al soltar los `TempDir`.
    fn escenario() -> (tempfile::TempDir, tempfile::TempDir) {
        let puntos = tempfile::tempdir().expect("tempdir puntos");
        let proyecto = tempfile::tempdir().expect("tempdir proyecto");
        let p = proyecto.path();
        std::fs::write(p.join(".gitignore"), "secreto.txt\n").expect("gitignore");
        std::fs::write(p.join("uno.txt"), "A\n").expect("escribir");
        std::fs::write(p.join("secreto.txt"), "no mirar\n").expect("escribir");
        for args in [
            vec!["init", "--quiet"],
            vec!["config", "user.email", "pruebas@example.invalid"],
            vec!["config", "user.name", "pruebas"],
            vec!["config", "core.autocrlf", "false"],
            vec!["add", "."],
            vec!["commit", "--quiet", "-m", "del usuario"],
        ] {
            let ok = crate::proc::oculto("git")
                .args(&args)
                .current_dir(p)
                .output()
                .expect("git")
                .status
                .success();
            assert!(ok, "preparar el repo del usuario: {args:?}");
        }
        (puntos, proyecto)
    }

    fn commits_del_usuario(proyecto: &Path) -> usize {
        let out = crate::proc::oculto("git")
            .args(["rev-list", "--count", "HEAD"])
            .current_dir(proyecto)
            .output()
            .expect("git");
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or(0)
    }

    #[test]
    fn volver_a_un_punto_devuelve_el_fichero_y_borra_lo_que_vino_despues() {
        let (puntos, proyecto) = escenario();
        let (r, p) = (puntos.path(), proyecto.path());
        let antes_del_usuario = commits_del_usuario(p);

        let punto = foto_en(r, p, "hilo-1", "turno 1").expect("foto");
        // Un agente reescribe un fichero y crea otro.
        std::fs::write(p.join("uno.txt"), "B destrozado\n").expect("escribir");
        std::fs::write(p.join("dos.txt"), "nuevo\n").expect("escribir");

        let vuelta = volver_en(r, p, "hilo-1", &punto.sha).expect("volver");
        assert_eq!(
            std::fs::read_to_string(p.join("uno.txt")).expect("leer"),
            "A\n",
            "el fichero tenia que volver a como estaba"
        );
        assert!(
            !p.join("dos.txt").exists(),
            "lo que creo el agente despues del punto tenia que desaparecer"
        );
        assert_eq!(vuelta.ficheros, 2, "uno modificado y otro creado");
        assert!(!vuelta.antes.is_empty(), "volver tambien se puede deshacer");

        // Lo que NO puede pasar: tocar el git del usuario.
        assert_eq!(commits_del_usuario(p), antes_del_usuario);
        assert!(
            crate::proc::oculto("git")
                .args(["status", "--porcelain"])
                .current_dir(p)
                .output()
                .expect("git")
                .stdout
                .is_empty(),
            "el arbol del usuario tenia que quedar limpio tras la vuelta"
        );
    }

    #[test]
    fn el_gitignore_del_proyecto_se_respeta_y_el_git_del_usuario_no_se_fotografia() {
        let (puntos, proyecto) = escenario();
        let (r, p) = (puntos.path(), proyecto.path());
        foto_en(r, p, "hilo-1", "turno 1").expect("foto");
        let sombra = sombra_en(r, "hilo-1").expect("sombra");
        let ficheros = git(&sombra, p, &["ls-files"]).expect("ls-files");
        assert!(ficheros.contains("uno.txt"));
        assert!(
            !ficheros.contains("secreto.txt"),
            "lo ignorado por el proyecto no se fotografia: {ficheros}"
        );
        assert!(
            !ficheros.contains(".git/"),
            "el .git del usuario NO puede entrar en la foto: {ficheros}"
        );
    }

    #[test]
    fn los_puntos_se_listan_del_mas_nuevo_al_mas_viejo() {
        let (puntos, proyecto) = escenario();
        let (r, p) = (puntos.path(), proyecto.path());
        foto_en(r, p, "hilo-1", "turno 1").expect("foto");
        std::fs::write(p.join("uno.txt"), "B\n").expect("escribir");
        let segundo = foto_en(r, p, "hilo-1", "turno 2").expect("foto");

        let l = lista_en(r, p, "hilo-1").expect("lista");
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].sha, segundo.sha);
        assert_eq!(l[0].etiqueta, "turno 2");
        assert_eq!(l[1].etiqueta, "turno 1");
        // Una conversacion sin fotos no es un error: es que aun no hay ninguna.
        assert!(lista_en(r, p, "hilo-sin-nada").expect("lista").is_empty());
    }

    #[test]
    fn no_se_vuelve_a_un_punto_que_no_existe() {
        // Casos negativos: sin puntos, con un sha inventado, y con un id de
        // conversacion que intenta escribir fuera de su sitio.
        let (puntos, proyecto) = escenario();
        let (r, p) = (puntos.path(), proyecto.path());
        assert!(volver_en(r, p, "hilo-1", "deadbeef").is_err());

        foto_en(r, p, "hilo-1", "turno 1").expect("foto");
        let e = volver_en(r, p, "hilo-1", "0000000000000000000000000000000000000000")
            .expect_err("un punto inventado no puede restaurarse");
        assert!(e.contains("punto"), "{e}");

        assert!(foto_en(r, p, "../fuera", "turno 1").is_err());
        assert!(foto_en(r, p, "", "turno 1").is_err());
    }

    #[test]
    fn el_barrido_se_lleva_lo_viejo_y_respeta_lo_de_hoy() {
        let (puntos, proyecto) = escenario();
        let (r, p) = (puntos.path(), proyecto.path());
        foto_en(r, p, "hilo-1", "turno 1").expect("foto");
        // Con el plazo de un dia, un repo recien tocado se queda.
        assert_eq!(barrer_en(r, 1), 0);
        assert!(sombra_en(r, "hilo-1").expect("sombra").exists());
        // Con plazo cero, todo lo que no sea del futuro sobra.
        assert_eq!(barrer_en(r, 0), 1);
        assert!(!sombra_en(r, "hilo-1").expect("sombra").exists());
        // Y barrer una carpeta vacia no es un error.
        assert_eq!(barrer_en(r, 0), 0);
    }

    #[test]
    fn un_arbol_enorme_no_se_fotografia_y_se_dice_por_que() {
        // El fusible: mejor no tomar la foto que bloquear el turno. Y el conteo
        // se para en el tope, no recorre el arbol entero.
        let (_puntos, proyecto) = escenario();
        let p = proyecto.path();
        assert!(entradas_hasta(p, 2) >= 2, "hay mas de dos entradas");
        assert!(entradas_hasta(p, MAX_ENTRADAS) < MAX_ENTRADAS);
        // Las carpetas pesadas de siempre no cuentan para el fusible.
        let pesada = p.join("node_modules");
        std::fs::create_dir_all(&pesada).expect("crear");
        let antes = entradas_hasta(p, MAX_ENTRADAS);
        for i in 0..20 {
            std::fs::write(pesada.join(format!("{i}.js")), "x").expect("escribir");
        }
        assert_eq!(entradas_hasta(p, MAX_ENTRADAS), antes);
    }
}
