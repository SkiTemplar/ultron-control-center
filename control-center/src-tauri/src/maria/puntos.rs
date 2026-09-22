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
// YA ESTA CABLEADO (2026-09-22). La mitad autonoma se escribio primero a
// proposito —foto, restauracion, listado y barrido, con sus pruebas— para que
// un fallo aqui no se comiera trabajo del usuario antes de estar probada. Hoy
// la consume el producto:
//
//   * `relay::ask_inner` fotografia JUSTO ANTES de lanzar al proveedor y deja
//     el sha en el turno del asistente (`Turn.punto`).
//   * `encargos::lanzar` hace lo mismo antes de soltar a un agente en paralelo
//     (`Encargo.punto`).
//   * `maria_puntos_listar` y `maria_punto_volver` (al final de este fichero)
//     son lo que pulsa la interfaz.
//   * `lib.rs` llama a `barrer(30)` en un hilo al arrancar.
//
// LO QUE SIGUE SIN HACER (mandamiento 13, alcance explicito): solo se
// fotografia si la conversacion tiene CARPETA DE PROYECTO. Sin proyecto los
// agentes trabajan en la carpeta comun del hilo y no hay arbol del usuario que
// proteger. Cuando la foto se pide y no sale (arbol enorme, git ausente), el
// turno NO se descarta: se contesta igual y se dice —ver `del_turno`—, porque
// una red de seguridad que no salta y encima calla es peor que no tenerla.

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
        // Y que la foto no ejecute NADA del usuario (2026-09-22). El repo en
        // la sombra hereda su `~/.gitconfig`: un `core.hooksPath` global —o un
        // hook que haya dejado `init.templateDir`— correria en CADA turno del
        // chat, y ademas con el cwd puesto en la carpeta del proyecto. Dos
        // danos medidos: un `pre-commit` que reformatea (prettier --write,
        // black, husky) le REESCRIBE los ficheros sin que haya pedido ningun
        // commit, y uno que falla —lo normal con trabajo a medias— deja el
        // turno sin red de seguridad, siempre. Se apunta a una carpeta que no
        // existe dentro de la sombra: eso apaga tambien `post-commit`, que
        // `--no-verify` no evita.
        let sin_hooks = sombra.join("sin-hooks").display().to_string();
        git(sombra, proyecto, &["config", "core.hooksPath", &sin_hooks])?;
        // Firmar los commits es cosa del usuario, no nuestra: con un
        // `commit.gpgsign=true` global y sin clave a mano la foto fallaria
        // siempre, y por un motivo que no tiene nada que ver con el chat.
        git(sombra, proyecto, &["config", "commit.gpgsign", "false"])?;
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
    // `--no-verify` y el `-c` van ademas de los `config` de `asegurar` porque
    // aquellos solo se escriben cuando el repo en la sombra SE CREA: una
    // conversacion abierta antes de este arreglo no los tendria, y seguiria
    // corriendo los hooks del usuario en cada turno.
    git(
        &sombra,
        proyecto,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "--allow-empty",
            "--no-verify",
            "-m",
            &mensaje,
        ],
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

/// Comprueba que `sha` es un punto de ESTA conversacion.
///
/// Se mira el tipo del objeto y no solo que el nombre exista: un sha de otro
/// repositorio, o el de un arbol o una etiqueta, no es algo a lo que se pueda
/// volver. Decir «he vuelto a X» sin que X sea un punto seria mentir.
pub fn existe_en(raiz: &Path, proyecto: &Path, hilo: &str, sha: &str) -> Result<(), String> {
    let sombra = sombra_en(raiz, hilo)?;
    if !sombra.join("HEAD").exists() {
        return Err("esta conversacion no tiene puntos de control".into());
    }
    let tipo = git(&sombra, proyecto, &["cat-file", "-t", sha])
        .map_err(|_| format!("no tengo ningun punto {sha}"))?;
    if tipo != "commit" {
        return Err(format!("{sha} no es un punto de control"));
    }
    Ok(())
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
    existe_en(raiz, proyecto, hilo, sha)?;
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

// No hay `foto(proyecto, hilo, etiqueta)` a secas: quien fotografia en
// produccion es `del_turno`, que decide tambien que hacer cuando no sale la
// foto. Un atajo que solo devuelve `Result` invitaria a un `let _ =` y a
// perder el aviso, que es justo lo que no puede pasar aqui (mandamiento 11).

pub fn lista(proyecto: &Path, hilo: &str) -> Result<Vec<Punto>, String> {
    lista_en(&raiz()?, proyecto, hilo)
}

pub fn volver(proyecto: &Path, hilo: &str, sha: &str) -> Result<Restauracion, String> {
    volver_en(&raiz()?, proyecto, hilo, sha)
}

pub fn existe(proyecto: &Path, hilo: &str, sha: &str) -> Result<(), String> {
    existe_en(&raiz()?, proyecto, hilo, sha)
}

/// Barrido por antiguedad, con el mismo plazo que usa Claude Code.
pub fn barrer(dias: u64) -> usize {
    raiz().map(|r| barrer_en(&r, dias)).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Lo que consumen el relevo y los encargos
// ---------------------------------------------------------------------------

/// Letras de prompt que caben en la etiqueta de un punto.
const LETRAS_ETIQUETA: usize = 40;

/// Etiqueta del punto de un turno: «turno 12: arregla el login…». Pura.
///
/// `n` es la POSICION del mensaje del usuario en el hilo (1 = el primero), no
/// el numero de intercambios: es lo unico que se puede decir sin suponer que
/// cada pregunta tuvo respuesta.
#[must_use]
pub fn etiqueta_turno(n: usize, prompt: &str) -> String {
    let limpio = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let corto: String = limpio.chars().take(LETRAS_ETIQUETA).collect();
    if corto.is_empty() {
        return format!("turno {n}");
    }
    let puntos = if limpio.chars().count() > LETRAS_ETIQUETA {
        "…"
    } else {
        ""
    };
    format!("turno {n}: {corto}{puntos}")
}

/// El punto que le toca a un turno o a un encargo: `(sha, aviso)`.
///
/// Los dos van por separado a proposito. Un `None` a secas obligaria a
/// adivinar si es que la conversacion no tiene proyecto —normal, no hay nada
/// que fotografiar— o es que la foto se cayo, que es justo lo que el usuario
/// tiene que saber ANTES de dejar a un agente suelto (mandamiento 11). Sin
/// proyecto no hay aviso; con proyecto y sin foto, siempre.
///
/// No devuelve `Result`: que falle la red de seguridad no puede impedir que se
/// conteste al usuario. Se avisa y se sigue.
#[must_use]
pub fn del_turno_en(
    raiz: &Path,
    proyecto: Option<&Path>,
    hilo: &str,
    etiqueta: &str,
) -> (Option<String>, Option<String>) {
    let Some(p) = proyecto else {
        return (None, None);
    };
    match foto_en(raiz, p, hilo, etiqueta) {
        Ok(punto) => (Some(punto.sha), None),
        Err(motivo) => {
            tracing::warn!(
                proyecto = %p.display(), hilo, error = %motivo,
                "sin punto de control para este turno"
            );
            (
                None,
                Some(format!(
                    "Sin punto de control: {motivo}. Lo que toquen los agentes en esta \
                     carpeta no se podra deshacer desde el chat."
                )),
            )
        }
    }
}

/// Igual, contra la carpeta de verdad.
#[must_use]
pub fn del_turno(
    proyecto: Option<&Path>,
    hilo: &str,
    etiqueta: &str,
) -> (Option<String>, Option<String>) {
    if proyecto.is_none() {
        return (None, None);
    }
    match raiz() {
        Ok(r) => del_turno_en(&r, proyecto, hilo, etiqueta),
        Err(e) => {
            tracing::warn!(error = %e, "sin carpeta donde guardar los puntos de control");
            (None, Some(format!("Sin punto de control: {e}.")))
        }
    }
}

// ---------------------------------------------------------------------------
// Comandos: lo que pulsa la interfaz
// ---------------------------------------------------------------------------

/// Lo que ha pasado al volver, tal y como lo lee la interfaz.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Restaurado {
    /// Ficheros del arbol que han cambiado. 0 en modo «conversacion», que no
    /// toca el codigo.
    pub ficheros: usize,
    /// Punto tomado justo ANTES de restaurar: con el se deshace la vuelta.
    /// Vacio en modo «conversacion», que no fotografia nada.
    pub antes: String,
    /// Turnos que quedan en el hilo. 0 en modo «codigo».
    pub turnos: usize,
}

/// Que toca cada modo de volver: `(codigo, conversacion)`. Pura.
///
/// Un modo que no se reconoce es un error, no un «pues no hagas nada»: un
/// boton que no puede actuar tiene que decirlo (mandamiento 11).
pub fn modo_volver(modo: &str) -> Result<(bool, bool), String> {
    match modo.trim() {
        "codigo" => Ok((true, false)),
        "conversacion" => Ok((false, true)),
        "todo" => Ok((true, true)),
        otro => Err(format!(
            "no se volver en modo «{otro}»: los modos son codigo, conversacion o todo"
        )),
    }
}

/// El trabajo de `maria_punto_volver`, sincrono y sin Tauri por medio.
fn volver_por_modo(
    thread_id: &str,
    sha: &str,
    modo: &str,
    conservar: Option<usize>,
) -> Result<Restaurado, String> {
    let (codigo, conversacion) = modo_volver(modo)?;
    let proyecto = crate::maria::threads::project_de(thread_id).ok_or_else(|| {
        "esta conversacion no tiene carpeta de proyecto, asi que no hay arbol al que volver"
            .to_string()
    })?;
    let mut r = Restaurado::default();
    if codigo {
        let vuelta = volver(&proyecto, thread_id, sha)?;
        r.ficheros = vuelta.ficheros;
        r.antes = vuelta.antes;
    } else {
        // Aqui el sha no se usa para restaurar nada, pero se comprueba igual:
        // si el punto no existe, lo honesto es negarse, no truncar el hilo y
        // dar por buena una vuelta a ninguna parte.
        existe(&proyecto, thread_id, sha)?;
    }
    if conversacion {
        let n = conservar.ok_or_else(|| {
            "no se cuantos turnos hay que conservar para volver la conversacion".to_string()
        })?;
        r.turnos = crate::maria::relay::truncar(thread_id, n)?;
    }
    Ok(r)
}

/// Los puntos de una conversacion, del mas nuevo al mas viejo.
///
/// Sin proyecto no hay puntos y la lista sale vacia: es el estado normal de una
/// conversacion que no trabaja sobre una carpeta, no un fallo.
#[tauri::command]
pub async fn maria_puntos_listar(thread_id: String) -> Vec<Punto> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(p) = crate::maria::threads::project_de(&thread_id) else {
            return Vec::new();
        };
        match lista(&p, &thread_id) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(hilo = %thread_id, error = %e, "no pude listar los puntos de control");
                Vec::new()
            }
        }
    })
    .await
    .unwrap_or_default()
}

/// Vuelve a un punto: el codigo, la conversacion o las dos cosas.
#[tauri::command]
pub async fn maria_punto_volver(
    thread_id: String,
    sha: String,
    modo: String,
    conservar: Option<usize>,
) -> Result<Restaurado, String> {
    tauri::async_runtime::spawn_blocking(move || {
        volver_por_modo(&thread_id, &sha, &modo, conservar)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
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
    fn los_hooks_del_usuario_ni_corren_ni_dejan_el_turno_sin_punto() {
        // Caso negativo del 2026-09-22: la foto heredaba el `~/.gitconfig` del
        // usuario, asi que su `pre-commit` corria en CADA turno del chat con el
        // cwd en su carpeta. Aqui se reproduce con un `core.hooksPath` local
        // —que es lo que vería un repo en la sombra creado antes del arreglo—
        // y un hook que reescribe el arbol y falla, como los que reformatean.
        let (puntos, proyecto) = escenario();
        let (r, p) = (puntos.path(), proyecto.path());
        let primera = foto_en(r, p, "hilo-1", "turno 1").expect("foto");
        let sombra = sombra_en(r, "hilo-1").expect("sombra");

        // Un repo recien creado ya no mira a los hooks del usuario.
        let hooks = git(&sombra, p, &["config", "--get", "core.hooksPath"]).expect("hooksPath");
        assert!(
            Path::new(&hooks).starts_with(&sombra) && !Path::new(&hooks).exists(),
            "los hooks tienen que apuntar a una carpeta vacia de la sombra: {hooks}"
        );

        let ganchos = puntos.path().join("ganchos");
        std::fs::create_dir_all(&ganchos).expect("crear ganchos");
        std::fs::write(
            ganchos.join("pre-commit"),
            "#!/bin/sh\necho destrozado > uno.txt\nexit 1\n",
        )
        .expect("escribir hook");
        git(
            &sombra,
            p,
            &["config", "core.hooksPath", &ganchos.display().to_string()],
        )
        .expect("hooksPath a mano");

        let segunda = foto_en(r, p, "hilo-1", "turno 2").expect("el hook no puede tumbar la foto");
        assert_ne!(segunda.sha, primera.sha, "hay foto nueva");
        assert_eq!(
            std::fs::read_to_string(p.join("uno.txt")).expect("leer"),
            "A\n",
            "el hook del usuario le ha reescrito el fichero"
        );
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
    fn un_turno_con_proyecto_deja_punto_y_sin_proyecto_no_deja_ni_aviso() {
        // Lo que se cablea en `relay::ask_inner`: con carpeta de proyecto hay
        // sha; sin carpeta no hay nada que fotografiar y tampoco hay nada que
        // avisar, porque no falta ninguna red de seguridad.
        let (puntos, proyecto) = escenario();
        let (r, p) = (puntos.path(), proyecto.path());

        let (sha, aviso) = del_turno_en(r, Some(p), "hilo-1", "turno 1: hola");
        assert!(sha.is_some(), "con proyecto tiene que haber punto");
        assert!(aviso.is_none(), "y nada que avisar: {aviso:?}");
        assert_eq!(
            lista_en(r, p, "hilo-1").expect("lista")[0].etiqueta,
            "turno 1: hola"
        );

        assert_eq!(del_turno_en(r, None, "hilo-2", "turno 1"), (None, None));
    }

    #[test]
    fn cuando_la_foto_no_sale_se_avisa_en_vez_de_callarse() {
        // Caso negativo: el turno se contesta igual (no devuelve Result), pero
        // el aviso lleva el motivo. Un `None` mudo haria creer al usuario que
        // tiene red de seguridad cuando no la tiene.
        let puntos = tempfile::tempdir().expect("tempdir");
        let inexistente = puntos.path().join("no-esta");
        let (sha, aviso) = del_turno_en(puntos.path(), Some(&inexistente), "hilo-1", "turno 1");
        assert!(sha.is_none());
        let aviso = aviso.expect("tenia que avisar");
        assert!(aviso.contains("Sin punto de control"), "{aviso}");
        assert!(aviso.contains("no existe"), "sin el motivo: {aviso}");
    }

    #[test]
    fn la_etiqueta_del_turno_cabe_en_una_linea() {
        assert_eq!(
            etiqueta_turno(3, "arregla el login"),
            "turno 3: arregla el login"
        );
        // Los saltos de linea se aplanan: la etiqueta es el asunto de un commit.
        assert_eq!(
            etiqueta_turno(1, " hola\n  que tal "),
            "turno 1: hola que tal"
        );
        let largo = etiqueta_turno(7, &"a".repeat(80));
        assert_eq!(largo.chars().count(), "turno 7: ".chars().count() + 41);
        assert!(largo.ends_with('…'), "{largo}");
        // Un prompt en blanco no deja una etiqueta acabada en dos puntos.
        assert_eq!(etiqueta_turno(2, "   "), "turno 2");
    }

    #[test]
    fn los_modos_de_volver_son_tres_y_lo_demas_es_un_error() {
        assert_eq!(modo_volver("codigo"), Ok((true, false)));
        assert_eq!(modo_volver("conversacion"), Ok((false, true)));
        assert_eq!(modo_volver(" todo "), Ok((true, true)));
        // Caso negativo: un modo inventado no puede pasar por «no hago nada».
        let e = modo_volver("conversación").expect_err("con tilde no es un modo");
        assert!(e.contains("codigo"), "el error dice cuales hay: {e}");
        assert!(modo_volver("").is_err());
    }

    #[test]
    fn un_punto_inventado_no_pasa_la_comprobacion_ni_toca_el_arbol() {
        // La comprobacion que usan tanto `volver_en` como el modo
        // «conversacion»: sin ella se podria truncar un hilo diciendo que se ha
        // vuelto a un punto que no existe.
        let (puntos, proyecto) = escenario();
        let (r, p) = (puntos.path(), proyecto.path());
        assert!(existe_en(r, p, "hilo-1", "deadbeef").is_err());

        let punto = foto_en(r, p, "hilo-1", "turno 1").expect("foto");
        assert!(existe_en(r, p, "hilo-1", &punto.sha).is_ok());
        std::fs::write(p.join("uno.txt"), "tocado\n").expect("escribir");
        assert!(existe_en(r, p, "hilo-1", "0".repeat(40).as_str()).is_err());
        assert_eq!(
            std::fs::read_to_string(p.join("uno.txt")).expect("leer"),
            "tocado\n",
            "una comprobacion que falla no puede tocar el arbol"
        );
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
