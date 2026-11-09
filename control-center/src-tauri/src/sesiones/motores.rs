// sesiones/motores.rs — Localización y detección de los motores externos
// (`sesiones_engines`, contrato v0.2, E9).
//
// - Codex: `codex` (en Windows, shim `.cmd` de npm → `node codex.js`).
// - Gemini: `agy` (CLI de Antigravity, ejecutable nativo) y, solo si `agy` no
//   existe, `gemini` de npm (shim `.cmd` → `node gemini.js`).
//
// Los shims `.cmd` se evitan siempre: pasar argumentos por `cmd.exe` expone
// el prompt a su intérprete. La detección se cachea 5 minutos; pasado ese
// tiempo se devuelve lo cacheado y se refresca en segundo plano.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::types::EngineStatus;

#[path = "motores_entorno.rs"]
mod entorno;
#[cfg(test)]
pub use entorno::quitar_secretos;
pub use entorno::{es_variable_secreta, se_excluye_de_claude, variables_de_la_app};

const CACHE_TTL: Duration = Duration::from_secs(300);
const VERSION_TIMEOUT: Duration = Duration::from_secs(8);
const CODEX_JS: &str = "node_modules/@openai/codex/bin/codex.js";
const GEMINI_JS: &str = "node_modules/@google/gemini-cli/bundle/gemini.js";
/// Aviso de Gemini por `gemini` de npm (sin `agy` en el PATH).
pub const NOTA_NPM: &str = "Se usa gemini-cli de npm porque no está agy: Google cortó su tier \
gratuito y suele fallar con «ineligible». Instala Antigravity (agy)";

/// Programa y argumentos previos para invocar una CLI sin `cmd.exe`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Program {
    pub exe: PathBuf,
    pub pre_args: Vec<String>,
}

/// Qué CLI de Gemini se usa.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeminiCli {
    Agy,
    Npm,
}

fn is_cmd_shim(p: &Path) -> bool {
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    matches!(ext.as_deref(), Some("cmd" | "bat"))
}

/// Resuelve un binario ya localizado: si es un shim `.cmd` de npm, devuelve
/// `node <js>`; si no, el propio ejecutable.
pub fn resolve_found(found: &Path, js_rel: &str) -> Result<Program, String> {
    let name = found
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !is_cmd_shim(found) {
        return Ok(Program {
            exe: found.to_path_buf(),
            pre_args: Vec::new(),
        });
    }
    let dir = found
        .parent()
        .ok_or_else(|| format!("ruta de {name} sin directorio"))?;
    let js = dir.join(js_rel);
    if !js.is_file() {
        return Err(format!(
            "{name} está instalado como .cmd y no se encontró su .js: no se lanza vía cmd.exe"
        ));
    }
    let local_node = dir.join("node.exe");
    let node = if local_node.is_file() {
        local_node
    } else {
        which::which("node").map_err(|_| "no se encontró 'node' en el PATH".to_string())?
    };
    Ok(Program {
        exe: node,
        pre_args: vec![js.to_string_lossy().into_owned()],
    })
}

pub fn codex_program() -> Result<Program, String> {
    let found = which::which("codex")
        .map_err(|_| "no se encontró 'codex' en el PATH: instala la CLI de Codex".to_string())?;
    resolve_found(&found, CODEX_JS)
}

/// CLI de Gemini: `agy` y, solo si no existe, `gemini` de npm.
pub fn gemini_program() -> Result<(GeminiCli, Program), String> {
    if let Ok(found) = which::which("agy") {
        return Ok((GeminiCli::Agy, resolve_found(&found, "")?));
    }
    let found = which::which("gemini").map_err(|_| {
        "no se encontró 'agy' (Antigravity) ni 'gemini' en el PATH: instala la CLI de Antigravity"
            .to_string()
    })?;
    Ok((GeminiCli::Npm, resolve_found(&found, GEMINI_JS)?))
}

/// `Command` sin ventana de consola, en `cwd`.
pub fn command_for(p: &Program, cwd: &str) -> Command {
    let mut cmd = Command::new(&p.exe);
    cmd.args(&p.pre_args).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// `command_for` sin las variables secretas de la app: para las tareas de
/// motores (`codex`, `gemini`, `opencode`), que no deben ver keys ajenas.
pub fn command_for_task(p: &Program, cwd: &str) -> Command {
    let mut cmd = command_for(p, cwd);
    entorno::quitar_secretos(&mut cmd, entorno::variables_de_la_app());
    cmd
}

/// Primera línea no vacía de `<programa> --version`, con tope de tiempo y
/// dentro de un Job Object (`cli_info::run_cli`): al cortar no quedan nietos
/// huérfanos y uno que herede la salida no bloquea la lectura.
fn version_of(p: &Program) -> Option<String> {
    let mut cmd = command_for(p, ".");
    cmd.arg("--version");
    let out = match super::cli_info::run_cli(cmd, VERSION_TIMEOUT, "--version") {
        Ok(out) => out,
        Err(e) => {
            tracing::debug!(exe = %p.exe.display(), error = %e, "versión del motor no disponible");
            return None;
        }
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// Estado de un motor a partir del resultado de localizarlo.
pub fn status_from(
    id: &str,
    located: Result<Program, String>,
    version: impl Fn(&Program) -> Option<String>,
    label: Option<&str>,
) -> EngineStatus {
    match located {
        Ok(p) => EngineStatus {
            id: id.to_string(),
            available: true,
            reason: None,
            version: version(&p).map(|v| match label {
                Some(l) => format!("{l} {v}"),
                None => v,
            }),
            note: None,
        },
        Err(reason) => EngineStatus {
            id: id.to_string(),
            available: false,
            reason: Some(reason),
            version: None,
            note: None,
        },
    }
}

/// Estado de los dos motores. Las dos `--version` van en paralelo: en frío,
/// `agy` tarda unos 6 s y `codex` 1 s, y en serie se sumaban.
fn detect_with<V>(
    codex: Result<Program, String>,
    gemini: Result<(GeminiCli, Program), String>,
    version: V,
) -> Vec<EngineStatus>
where
    V: Fn(&Program) -> Option<String> + Sync,
{
    let version = &version;
    std::thread::scope(|s| {
        let gemini = s.spawn(move || match gemini {
            // Por `agy` es la vía normal: la versión ya dice «agy …», sin aviso.
            Ok((GeminiCli::Agy, p)) => status_from("gemini", Ok(p), version, Some("agy")),
            Ok((GeminiCli::Npm, p)) => EngineStatus {
                note: Some(NOTA_NPM.into()),
                ..status_from("gemini", Ok(p), version, Some("gemini"))
            },
            Err(e) => status_from("gemini", Err(e), version, None),
        });
        let codex = status_from("codex", codex, version, None);
        let gemini = gemini.join().unwrap_or_else(|_| EngineStatus {
            id: "gemini".into(),
            available: false,
            reason: Some("la detección de Gemini falló (panic)".into()),
            version: None,
            note: None,
        });
        vec![codex, gemini]
    })
}

/// Codex y Gemini, y OpenCode en paralelo (`opencode_entorno::estado`).
fn detect_now() -> Vec<EngineStatus> {
    std::thread::scope(|s| {
        let opencode = s.spawn(|| super::opencode_entorno::estado(version_of));
        let mut v = detect_with(codex_program(), gemini_program(), version_of);
        v.push(opencode.join().unwrap_or_else(|_| EngineStatus {
            id: "opencode".into(),
            available: false,
            reason: Some("la detección de OpenCode falló (panic)".into()),
            version: None,
            note: None,
        }));
        v
    })
}

/// Caché con revalidación en segundo plano: mientras haya un valor, se
/// devuelve al momento aunque esté caducado; solo la primera consulta espera.
/// `force` (botón «Detectar») detecta en el acto: tras instalar un motor, el
/// usuario tiene que verlo sin esperar al TTL ni a un refresco que no llega a
/// la ventana.
#[derive(Default)]
struct EngineCache {
    slot: Mutex<Option<(Instant, Vec<EngineStatus>)>>,
    refreshing: AtomicBool,
}

/// Pone `refreshing` a `false` al soltarse (también al deshacer un panic).
struct Refrescando<'a>(&'a AtomicBool);

impl Drop for Refrescando<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl EngineCache {
    fn store(&self, v: &[EngineStatus]) {
        if let Ok(mut c) = self.slot.lock() {
            *c = Some((Instant::now(), v.to_vec()));
        }
    }

    fn get(
        self: &Arc<Self>,
        ttl: Duration,
        force: bool,
        detect: fn() -> Vec<EngineStatus>,
    ) -> Vec<EngineStatus> {
        let cached = self
            .slot
            .lock()
            .ok()
            .and_then(|c| c.clone())
            .filter(|_| !force);
        let Some((at, v)) = cached else {
            let fresh = detect();
            self.store(&fresh);
            return fresh;
        };
        if at.elapsed() >= ttl && !self.refreshing.swap(true, Ordering::AcqRel) {
            let me = Arc::clone(self);
            let spawned = std::thread::Builder::new()
                .name("motores-refresco".into())
                .spawn(move || {
                    // Baja `refreshing` aunque `detect` haga panic: si no, la
                    // caché no volvería a renovarse en segundo plano.
                    let _bandera = Refrescando(&me.refreshing);
                    me.store(&detect());
                });
            if let Err(e) = spawned {
                tracing::warn!(error = %e, "no se pudo refrescar la detección de motores");
                self.refreshing.store(false, Ordering::Release);
            }
        }
        v
    }
}

/// Motores disponibles, con caché de 5 minutos y revalidación en segundo
/// plano; con `force`, detección síncrona que renueva la caché.
pub fn engines(force: bool) -> Vec<EngineStatus> {
    static CACHE: OnceLock<Arc<EngineCache>> = OnceLock::new();
    CACHE
        .get_or_init(|| Arc::new(EngineCache::default()))
        .get(CACHE_TTL, force, detect_now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sin_binario_el_motor_no_esta_disponible_y_dice_por_que() {
        let s = status_from(
            "gemini",
            Err("no se encontró 'agy'".into()),
            |_| Some("1.0".into()),
            None,
        );
        assert!(!s.available);
        assert_eq!(s.reason.as_deref(), Some("no se encontró 'agy'"));
        assert_eq!(s.version, None);
    }

    #[test]
    fn con_binario_esta_disponible_con_version_etiquetada() {
        let p = Program {
            exe: PathBuf::from("agy"),
            pre_args: Vec::new(),
        };
        let s = status_from("gemini", Ok(p), |_| Some("1.2.17".into()), Some("agy"));
        assert!(s.available);
        assert_eq!(s.reason, None);
        assert_eq!(s.version.as_deref(), Some("agy 1.2.17"));
    }

    #[test]
    fn un_shim_cmd_sin_js_se_rechaza() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shim = dir.path().join("codex.cmd");
        std::fs::write(&shim, "@echo off").expect("shim");
        let err = resolve_found(&shim, CODEX_JS).expect_err("debe fallar");
        assert!(err.contains("cmd.exe"), "{err}");
    }

    #[test]
    fn un_ejecutable_nativo_se_usa_tal_cual() {
        let p = resolve_found(Path::new("agy.exe"), "").expect("nativo");
        assert_eq!(p.exe, PathBuf::from("agy.exe"));
        assert!(p.pre_args.is_empty());
    }

    /// `cmd` responde al momento, pero deja un nieto (`ping`, ~20 s) con su
    /// stdout heredado: la versión no puede esperar a que el nieto acabe.
    #[cfg(windows)]
    #[test]
    fn la_version_respeta_el_tope_aunque_un_nieto_retenga_la_salida() {
        let pre = "/C start /b ping -n 20 127.0.0.1 & echo 9.9.9 & rem";
        let p = Program {
            exe: PathBuf::from("cmd"),
            pre_args: pre.split(' ').map(str::to_string).collect(),
        };
        let v = version_of(&p);
        // Desde que el hijo existe: la cola de `spawn` de la suite no cuenta.
        let tras_spawn = crate::sesiones::cli_info::desde_el_ultimo_spawn();
        assert!(
            tras_spawn < VERSION_TIMEOUT,
            "esperó al nieto: {tras_spawn:?}"
        );
        assert!(v.is_some());
    }

    fn prog(name: &str) -> Program {
        Program {
            exe: PathBuf::from(name),
            pre_args: Vec::new(),
        }
    }

    #[test]
    fn las_dos_versiones_se_consultan_en_paralelo() {
        let lenta = |_: &Program| {
            std::thread::sleep(Duration::from_millis(300));
            Some("1.0".to_string())
        };
        let inicio = Instant::now();
        let v = detect_with(Ok(prog("codex")), Ok((GeminiCli::Agy, prog("agy"))), lenta);
        let t = inicio.elapsed();
        assert!(t < Duration::from_millis(450), "en serie: {t:?}");
        assert_eq!(v[0].id, "codex");
        assert_eq!(v[1].version.as_deref(), Some("agy 1.0"));
    }

    fn deteccion_lenta() -> Vec<EngineStatus> {
        std::thread::sleep(Duration::from_millis(300));
        vec![status_from(
            "codex",
            Ok(prog("codex")),
            |_| Some("2".into()),
            None,
        )]
    }

    #[test]
    fn caducada_devuelve_lo_cacheado_al_momento_y_refresca_detras() {
        let cache = Arc::new(EngineCache::default());
        let viejo = status_from("codex", Ok(prog("codex")), |_| Some("1".into()), None);
        cache.store(&[viejo]);
        let inicio = Instant::now();
        let v = cache.get(Duration::ZERO, false, deteccion_lenta);
        assert!(
            inicio.elapsed() < Duration::from_millis(150),
            "esperó a detectar"
        );
        assert_eq!(v[0].version.as_deref(), Some("1"));
        let limite = Instant::now() + Duration::from_secs(5);
        while cache.refreshing.load(Ordering::Acquire) && Instant::now() < limite {
            std::thread::sleep(Duration::from_millis(20));
        }
        let ahora = cache.get(Duration::from_secs(300), false, deteccion_lenta);
        assert_eq!(ahora[0].version.as_deref(), Some("2"));
    }

    /// «Detectar» con la caché vigente detecta en el acto (antes devolvía la
    /// caché durante los 5 min del TTL); sin `force` sigue sirviendo la caché.
    #[test]
    fn forzar_detecta_aunque_la_cache_este_vigente() {
        let cache = Arc::new(EngineCache::default());
        let viejo = status_from(
            "codex",
            Err("no se encontró 'codex'".into()),
            |_| None,
            None,
        );
        cache.store(&[viejo]);
        let sin_forzar = cache.get(Duration::from_secs(300), false, deteccion_lenta);
        assert!(!sin_forzar[0].available, "caso negativo: sirve la caché");
        let forzado = cache.get(Duration::from_secs(300), true, deteccion_lenta);
        assert_eq!(forzado[0].version.as_deref(), Some("2"));
        let despues = cache.get(Duration::from_secs(300), false, deteccion_lenta);
        assert_eq!(despues[0].version.as_deref(), Some("2"), "renueva la caché");
    }

    fn deteccion_que_revienta() -> Vec<EngineStatus> {
        panic!("detección rota");
    }

    /// Un panic en el refresco de fondo no deja `refreshing` a `true`.
    #[test]
    fn un_panic_al_refrescar_no_bloquea_los_refrescos_siguientes() {
        let cache = Arc::new(EngineCache::default());
        let viejo = status_from("codex", Ok(prog("codex")), |_| Some("1".into()), None);
        cache.store(&[viejo]);
        cache.get(Duration::ZERO, false, deteccion_que_revienta);
        let limite = Instant::now() + Duration::from_secs(5);
        while cache.refreshing.load(Ordering::Acquire) && Instant::now() < limite {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !cache.refreshing.load(Ordering::Acquire),
            "refreshing atascado"
        );
    }

    #[test]
    fn sin_cache_la_primera_consulta_espera_a_detectar() {
        let cache = Arc::new(EngineCache::default());
        let v = cache.get(Duration::from_secs(300), false, deteccion_lenta);
        assert_eq!(v[0].version.as_deref(), Some("2"));
    }
}
