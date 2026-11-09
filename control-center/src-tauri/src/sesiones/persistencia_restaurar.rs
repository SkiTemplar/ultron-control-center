// sesiones/persistencia_restaurar.rs — Restauración de las sesiones abiertas
// al arrancar ULTRON (hallazgo #35, opción B).
//
// `restaurar` lee `abiertas.json` y da de alta cada sesión con su mismo id
// (los paneles del workspace la siguen encontrando), su `Config` y su cola,
// antes de que arranque el seguidor; después activa el escritor. `relanzar`
// lanza, en un hilo y de una en una, `claude --resume <sid>` en su cwd.
//
// No se restaura (y se avisa en el Control Center, con cuántos mensajes de
// cola hay): una sesión sin conversación de Claude, con el cwd desaparecido,
// sin transcript en disco, o cuya conversación ya está abierta en otra sesión
// (la misma comprobación de `gestor::create`). Las dos causas pasajeras (cwd
// o carpeta de transcripts inaccesibles) apartan la sesión con su cola en
// `abiertas.descartadas.json`, que se reintenta en el arranque siguiente
// (`persistencia_descartes.rs`); el resto se pierde. Sin transcript con la
// carpeta accesible, la conversación no llegó a empezar: descarte
// definitivo, y sin aviso si tampoco tenía cola. Un fichero dañado se
// aparta a `.bad` y se arranca sin sesiones, con aviso.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::AppHandle;

use super::en_vuelo::{self, Reparto};
use super::{anotar, avisar, descartes, leer, ruta, Abierta, Lectura};
use crate::pty::types::bloquear;
use crate::sesiones::lanzamiento::{self, Arranque, Config};
use crate::sesiones::senales::{self, Senal};
use crate::sesiones::titulo::OrigenTitulo;
use crate::sesiones::types::QueueItem;
use crate::sesiones::{cola, entrada, gestor, registro};

/// Pausa entre dos relanzamientos (cada `claude` carga hooks y MCP).
const PAUSA_RELANZAR: Duration = Duration::from_millis(400);

/// Sesión dada de alta que falta por relanzar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Restaurada {
    pub id: String,
    pub sid: String,
    pub cfg: Config,
}

/// Sesión que pasa las comprobaciones de disco.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub abierta: Abierta,
    pub sid: String,
    pub cfg: Config,
    pub transcript: PathBuf,
}

/// Sesión que no se restaura.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Descarte {
    pub titulo: String,
    pub motivo: String,
    pub pendientes: usize,
    /// La sesión guardada, si la causa es pasajera (se aparta y se reintenta).
    pub apartable: Option<Box<Abierta>>,
    /// La conversación no llegó a empezar: sin cola, no hay nada que perder
    /// y no se avisa (solo queda en el log).
    pub sin_conversacion: bool,
}

fn descarte(a: &Abierta, motivo: impl Into<String>) -> Descarte {
    Descarte {
        titulo: a.title.clone(),
        motivo: motivo.into(),
        pendientes: a.cola.len(),
        apartable: None,
        sin_conversacion: false,
    }
}

/// Descarte permanente de una sesión cuya conversación no llegó a empezar.
fn descarte_sin_conversacion(a: &Abierta, motivo: impl Into<String>) -> Descarte {
    Descarte {
        sin_conversacion: true,
        ..descarte(a, motivo)
    }
}

/// Descarte por una condición que puede cambiar (unidad sin montar, carpeta
/// de red caída): conserva la sesión para reintentarla.
fn descarte_pasajero(a: &Abierta, motivo: impl Into<String>) -> Descarte {
    Descarte {
        apartable: Some(Box::new(a.clone())),
        ..descarte(a, motivo)
    }
}

/// `Config` de una sesión guardada antes de tener su lanzamiento.
fn config_minima(a: &Abierta) -> Config {
    Config {
        cwd: a.cwd.clone(),
        project_id: a.project_id.clone(),
        model: None,
        effort: None,
        permission_mode: a.launch_permission_mode,
        settings_file: None,
    }
}

/// Transcript de la conversación `sid`: el guardado si es `<sid>.jsonl` y
/// existe; si no, `<projects>/<slug del cwd>/<sid>.jsonl` si existe.
fn transcript_de(a: &Abierta, cwd: &str, sid: &str, projects: &Path) -> Option<PathBuf> {
    let nombre = format!("{sid}.jsonl");
    let guardado = a
        .transcript
        .as_ref()
        .map(PathBuf::from)
        .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy() == nombre));
    let calculado = projects.join(registro::claude_slug(cwd)).join(&nombre);
    guardado
        .into_iter()
        .chain(std::iter::once(calculado))
        .find(|p| p.is_file())
}

/// Comprobaciones de disco de una sesión guardada.
pub fn decidir(a: Abierta, projects: &Path) -> Result<Plan, Descarte> {
    let Some(sid) = a
        .claude_session_id
        .clone()
        .filter(|s| lanzamiento::valid_resume(s))
    else {
        return Err(descarte_sin_conversacion(
            &a,
            "aún no tenía conversación de Claude que retomar",
        ));
    };
    let cfg = a.config.clone().unwrap_or_else(|| config_minima(&a));
    if !Path::new(&cfg.cwd).is_dir() {
        return Err(descarte_pasajero(
            &a,
            format!("su carpeta no existe o no está accesible ({})", cfg.cwd),
        ));
    }
    let Some(transcript) = transcript_de(&a, &cfg.cwd, &sid, projects) else {
        // Claude Code escribe el transcript con el primer mensaje: con la
        // carpeta de transcripts accesible, su falta es definitiva (una
        // sesión abierta y cortada antes de hablar). Reintentarla repetía el
        // aviso en cada arranque.
        if !projects.is_dir() {
            return Err(descarte_pasajero(
                &a,
                format!(
                    "la carpeta de transcripts de Claude no está accesible ({})",
                    projects.display()
                ),
            ));
        }
        return Err(descarte_sin_conversacion(
            &a,
            "la conversación no llegó a empezar (no hay transcript)",
        ));
    };
    Ok(Plan {
        abierta: a,
        sid,
        cfg,
        transcript,
    })
}

/// Lee `abiertas.json`, da de alta lo restaurable y activa el escritor.
/// Devuelve las sesiones que hay que relanzar.
pub fn restaurar() -> Vec<Restaurada> {
    let Some(ruta) = ruta() else {
        return Vec::new();
    };
    let projects = registro::claude_projects_dir().unwrap_or_default();
    let (out, escribir) = restaurar_desde(&ruta, &projects);
    if escribir {
        super::activar(ruta);
    }
    out
}

/// Restaura desde `ruta` y reintenta las apartadas en arranques anteriores.
/// El segundo valor dice si se puede activar el escritor: no, si el fichero
/// existe y no se pudo leer (no se pisa).
pub fn restaurar_desde(ruta: &Path, projects: &Path) -> (Vec<Restaurada>, bool) {
    let guardadas = match leer(ruta) {
        Err(e) => {
            avisar(&format!(
                "No se restauran las sesiones abiertas: {e}. El fichero no se toca y \
                 esta ejecución no las guardará."
            ));
            return (Vec::new(), false);
        }
        Ok(Lectura::Vacia) => Vec::new(),
        Ok(Lectura::Apartada { destino, error }) => {
            avisar(&format!(
                "abiertas.json estaba dañado ({error}): se ha apartado como {} y \
                 ULTRON arranca sin sesiones restauradas.",
                destino.display()
            ));
            Vec::new()
        }
        Ok(Lectura::Leida(f)) => f.sesiones,
    };
    let destino = descartes::ruta_de(ruta);
    (restaurar_con_apartadas(guardadas, projects, &destino), true)
}

/// Une las guardadas con las apartadas en `destino`, las restaura y reescribe
/// `destino` con las que vuelven a fallar por una causa pasajera. Si `destino`
/// no se pudo leer, no se toca y los descartes nuevos no se apartan.
fn restaurar_con_apartadas(
    guardadas: Vec<Abierta>,
    projects: &Path,
    destino: &Path,
) -> Vec<Restaurada> {
    let previas = descartes::leer_apartadas(destino).inspect_err(|e| {
        tracing::error!(error = %e, "no se pudieron leer las sesiones apartadas");
        avisar(&format!("No se reintentan las sesiones apartadas: {e}."));
    });
    let es_legible = previas.is_ok();
    let sesiones = descartes::unir(guardadas, previas.unwrap_or_default());
    let (out, descartadas) = restaurar_lote(sesiones, projects);
    let apartadas: Vec<Abierta> = descartadas
        .iter()
        .filter_map(|d| d.apartable.as_deref().cloned())
        .collect();
    let guardado = es_legible
        && descartes::guardar(destino, &apartadas)
            .inspect_err(|e| {
                tracing::error!(error = %e, "no se pudieron apartar las sesiones descartadas");
                avisar(&format!(
                    "No se pudieron apartar las sesiones no restauradas: {e}."
                ));
            })
            .is_ok();
    avisar_descartes(&descartadas, guardado.then_some(destino));
    out
}

/// Alta de cada sesión guardada; los descartes se avisan juntos (sin
/// apartarlos: eso lo hace `restaurar_desde`). Solo la usan los tests: el
/// arranque pasa por `restaurar_desde`.
#[cfg(test)]
pub fn restaurar_todas(sesiones: Vec<Abierta>, projects: &Path) -> Vec<Restaurada> {
    let (out, descartadas) = restaurar_lote(sesiones, projects);
    avisar_descartes(&descartadas, None);
    out
}

fn restaurar_lote(sesiones: Vec<Abierta>, projects: &Path) -> (Vec<Restaurada>, Vec<Descarte>) {
    let mut out = Vec::new();
    let mut descartadas = Vec::new();
    for a in sesiones {
        match decidir(a, projects).and_then(dar_de_alta) {
            Ok(r) => out.push(r),
            Err(d) => descartadas.push(d),
        }
    }
    (out, descartadas)
}

fn avisar_descartes(d: &[Descarte], apartadas: Option<&Path>) {
    if d.is_empty() {
        return;
    }
    tracing::warn!(n = d.len(), "sesiones guardadas que no se restauran");
    for x in d.iter().filter(|x| es_silencioso(x)) {
        tracing::info!(titulo = %x.titulo, motivo = %x.motivo, "sesión vacía descartada sin aviso");
    }
    if let Some(t) = texto_descartes(d, apartadas) {
        avisar(&t);
    }
}

/// Sin conversación ni cola: no se pierde nada, así que no se avisa.
fn es_silencioso(x: &Descarte) -> bool {
    x.sin_conversacion && x.pendientes == 0
}

/// Texto del aviso de las sesiones descartadas (`None` si todas son
/// silenciosas). Con `apartadas`, las de causa pasajera se conservan en ese
/// fichero con su cola.
pub fn texto_descartes(d: &[Descarte], apartadas: Option<&Path>) -> Option<String> {
    let conserva = |x: &Descarte| apartadas.is_some() && x.apartable.is_some();
    let avisables: Vec<&Descarte> = d.iter().filter(|x| !es_silencioso(x)).collect();
    if avisables.is_empty() {
        return None;
    }
    let partes: Vec<String> = avisables
        .iter()
        .map(|x| {
            let cola = match (x.pendientes, conserva(x)) {
                (0, _) => String::new(),
                (n, true) => format!(", con {n} mensaje(s) en cola"),
                (n, false) => format!(", con {n} mensaje(s) en cola que se pierden"),
            };
            format!("«{}» ({}{cola})", x.titulo, x.motivo)
        })
        .collect();
    let mut t = format!(
        "Sesiones no restauradas al arrancar ULTRON: {}.",
        partes.join("; ")
    );
    if let Some(p) = apartadas.filter(|_| avisables.iter().any(|x| conserva(x))) {
        t.push_str(&format!(
            " Las que no tenían su carpeta o su transcript accesibles se guardan en {} \
             y se reintentan en el próximo arranque.",
            p.display()
        ));
    }
    Some(t)
}

/// Alta en el registro con el mismo id, su `Config` (settings reescritos) y
/// su cola. Serializada con `gestor::create` y con su misma comprobación de
/// conversación ya abierta.
pub fn dar_de_alta(p: Plan) -> Result<Restaurada, Descarte> {
    let a = &p.abierta;
    let arranque = Arranque::Reanudar { sid: p.sid.clone() };
    let en_alta = bloquear(gestor::alta());
    gestor::comprobar_reanudacion(&arranque).map_err(|e| descarte(a, e))?;
    if registro::exists(&a.id) {
        return Err(descarte(a, "ya hay una sesión con su mismo id"));
    }
    let project = gestor::find_project(p.cfg.project_id.as_deref(), &p.cfg.cwd)
        .or_else(|| gestor::find_project(None, &p.cfg.cwd));
    let cfg = Config {
        settings_file: gestor::settings_de(&a.id, project.as_ref(), &p.cfg.cwd),
        ..p.cfg.clone()
    };
    if let Err(e) = lanzamiento::build(&cfg, &arranque) {
        lanzamiento::borrar_settings(&a.id);
        return Err(descarte(a, e));
    }
    gestor::registrar(&a.id, project.as_ref(), &cfg, &arranque).map_err(|e| descarte(a, e))?;
    fijar_datos(a, &p.transcript).map_err(|e| descarte(a, e))?;
    drop(en_alta);
    gestor::guardar_lanzamiento(&a.id, cfg.clone());
    let reparto = en_vuelo::resolver(&a.cola, &p.transcript);
    let items: Vec<QueueItem> = reparto.cola.iter().map(super::Guardado::a_item).collect();
    let repuestos = reponer_con_aviso(cola::global(), &a.id, items);
    cola::emitir_actual(&a.id);
    anotar(&a.id, "info", texto_restaurada(&p.sid, repuestos, &reparto));
    if let Some(t) = &a.turno_vivo {
        super::turno::ofrecer(&a.id, t, &p.transcript);
        // La cola no sale sola sobre una tarea a medias, por delante de la
        // continuación que ofrece el composer.
        senales::emitir(&a.id, Senal::TurnoCortado);
    }
    Ok(Restaurada {
        id: a.id.clone(),
        sid: p.sid,
        cfg,
    })
}

/// Repone la cola guardada. Si falla (cola envenenada), lo dice en el chat
/// de la sesión y en el Control Center con cuántos mensajes no entraron; el
/// escritor tampoco reescribe `abiertas.json` mientras la cola no se pueda
/// leer (`proyeccion_actual`), así que el fichero los conserva.
pub(super) fn reponer_con_aviso(c: &cola::Colas, id: &str, items: Vec<QueueItem>) -> usize {
    let n = items.len();
    match c.reponer(id, items) {
        Ok(repuestos) => repuestos,
        Err(e) => {
            tracing::error!(sesion = %id, error = %e, "no se pudo reponer la cola");
            let texto = format!(
                "No se pudieron reponer {n} mensaje(s) de la cola guardada ({e}): siguen en \
                 abiertas.json, pero esta ejecución no los enviará."
            );
            anotar(id, "error", texto.clone());
            avisar(&texto);
            0
        }
    }
}

/// Título, alta, modelo y transcript guardados (`registrar` pone los de una
/// sesión reanudada nueva).
fn fijar_datos(a: &Abierta, transcript: &Path) -> Result<(), String> {
    registro::update(&a.id, |s| {
        s.info.title = a.title.clone();
        s.titulo = OrigenTitulo::desde_guardado(a.title_source, a.title_auto);
        s.info.started_at = a.started_at.clone();
        s.info.model = a.model.clone();
        s.transcript = Some(transcript.to_path_buf());
        (true, ())
    })
}

/// Nota del chat de una sesión restaurada.
pub fn texto_restaurada(sid: &str, repuestos: usize, r: &Reparto) -> String {
    let corto: String = sid.chars().take(8).collect();
    let mut t = format!(
        "Sesión restaurada al arrancar ULTRON: se retoma la conversación {corto} con --resume."
    );
    if repuestos > 0 {
        t.push_str(&format!(" Vuelven a la cola {repuestos} mensaje(s)."));
    }
    if r.llegados > 0 {
        t.push_str(&format!(
            " {} se estaba(n) enviando al cerrar y ya consta(n) en el transcript: no se repite(n).",
            r.llegados
        ));
    }
    if r.no_llegados > 0 {
        t.push_str(&format!(
            " {} se estaba(n) enviando al cerrar y no llegó(aron) a Claude: sale(n) de nuevo.",
            r.no_llegados
        ));
    }
    if r.sin_comprobar > 0 {
        t.push_str(&format!(
            " {} se estaba(n) enviando al cerrar y no se ha podido comprobar si llegó(aron): \
             saldrá(n) otra vez en cuanto la sesión quede libre.",
            r.sin_comprobar
        ));
    }
    t
}

/// Relanza en un hilo, de una en una, las sesiones dadas de alta.
pub fn relanzar(app: AppHandle, restauradas: Vec<Restaurada>) {
    if restauradas.is_empty() {
        return;
    }
    let r = std::thread::Builder::new()
        .name("sesiones-restaurar".into())
        .spawn(move || {
            for x in restauradas {
                relanzar_una(&app, &x);
                std::thread::sleep(PAUSA_RELANZAR);
            }
        });
    if let Err(e) = r {
        avisar(&format!(
            "No se pudieron relanzar las sesiones restauradas ({e}): usa Reiniciar en cada una."
        ));
    }
}

/// `claude --resume <sid>` con el vigilante de pantalla. Si falla, la sesión
/// queda terminada (con su cola) y una nota pide usar Reiniciar.
fn relanzar_una(app: &AppHandle, x: &Restaurada) {
    if !registro::exists(&x.id) {
        tracing::info!(sesion = %x.id, "sesión restaurada cerrada antes de relanzarla");
        return;
    }
    // Un Reiniciar en el hueco de la restauración ya la lanzó: dos procesos
    // sobre el mismo transcript lo corromperían (`gestor.rs`).
    if registro::pty_id(&x.id).is_ok_and(|p| !p.is_empty()) {
        tracing::info!(sesion = %x.id, "sesión restaurada ya lanzada por un Reiniciar");
        return;
    }
    let arranque = Arranque::Reanudar { sid: x.sid.clone() };
    let r = gestor::lanzar_pty(app.clone(), &x.id, &x.cfg, &arranque);
    // El vigilante va siempre: Reiniciar no lanza otro.
    entrada::spawn_watcher(x.id.clone());
    if let Err(e) = r {
        tracing::warn!(sesion = %x.id, error = %e, "no se pudo relanzar la sesión restaurada");
        anotar(
            &x.id,
            "error",
            format!("No se pudo relanzar claude al restaurar la sesión: {e}. Usa Reiniciar cuando esté resuelto."),
        );
        senales::emitir(&x.id, Senal::ProcesoSalio { code: -1 });
    }
}
