// sesiones/motor.rs — Registro y ejecución de tareas de motores externos
// (Codex y Gemini) en segundo plano (contrato v0.2, E8).
//
// Cada motor construye su `Command` y un intérprete de líneas de salida
// (`LineParser`); este módulo lanza el proceso dentro de un Job Object
// (`cli_info::Trabajo`: cancelar mata también el binario nativo que lanza
// `node codex.js`), escribe el prompt por stdin en un hilo aparte, va
// actualizando la tarea y la emite en `sesiones://engine`. Cada tarea tiene
// un plazo máximo (`plazo_de`): al vencer se mata su árbol de procesos y
// queda en `error`, para que un Codex colgado no se quede vivo toda la noche.
//
// Las tareas terminadas se guardan en `cockpit/sesiones/motores.json`
// (ignorado por git): `brought_at` sobrevive a un reinicio de la app y el
// botón «Traer a Claude» no vuelve a ofrecerse (R25).

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use super::cli_info::Trabajo;
use super::codex_parse::{evt, extract_cloud_task_id, LineOutcome, Veredicto};
use super::registro;
use super::types::{ev, now_iso, CodexEvent, EngineTask, EngineUsage};

#[path = "motor_guardado.rs"]
mod guardado;
use guardado::cargar_inicial;
#[cfg(test)]
pub use guardado::{cargar_de, guardar_en};
pub use guardado::{guardar, tareas_de};

#[path = "motor_chat.rs"]
mod chat;
use chat::es_chat;
pub use chat::{insertar_turnos, podar_turnos, retirar_turnos, turnos_de_sesion, KIND_CHAT};
#[cfg(test)]
pub use chat::{lanzar_para_prueba, nueva_para_prueba, terminar_para_prueba};

const MAX_EVENTS: usize = 200;
/// Tareas terminadas que se conservan en disco y en memoria.
const MAX_GUARDADAS: usize = 40;
/// Plazo máximo de una revisión automática (`kind == "review"`).
pub const PLAZO_REVISION: Duration = Duration::from_secs(15 * 60);
/// Plazo máximo del resto de tareas de motor.
pub const PLAZO_TAREA: Duration = Duration::from_secs(30 * 60);

/// Plazo máximo de una tarea según su tipo.
pub fn plazo_de(kind: &str) -> Duration {
    if kind == "review" {
        PLAZO_REVISION
    } else {
        PLAZO_TAREA
    }
}

/// Interpreta una línea de stdout del motor.
pub type LineParser = Box<dyn FnMut(&str) -> LineOutcome + Send>;
/// Se llama una vez al terminar la tarea (no si se canceló).
pub type OnDone = Box<dyn FnOnce(&EngineTask) + Send>;

/// Datos de la tarea que no dependen del proceso.
pub struct TaskSpec {
    pub engine: &'static str,
    pub kind: String,
    pub mode: String,
    pub cwd: String,
    pub prompt: String,
    pub session_id: Option<String>,
    pub context_chars: usize,
    /// Modelo elegido (`None` = el predeterminado de la CLI del motor).
    pub model: Option<String>,
    /// Id del Tribunal si se lanzó junto a otro motor.
    pub group: Option<String>,
}

/// Proceso a lanzar y cómo leer su salida.
pub struct Launch {
    pub cmd: Command,
    /// Bytes que se escriben en stdin antes de cerrarlo (`None` = se cierra
    /// sin escribir).
    pub stdin: Option<Vec<u8>>,
    pub parser: LineParser,
    pub on_done: Option<OnDone>,
    /// Vigía de stderr (`motor_stderr`): un fallo detectado mata el árbol.
    pub vigia_stderr: Option<super::motor_stderr::VigiaStderr>,
}

struct Entry {
    task: EngineTask,
    child: Option<Arc<Mutex<Child>>>,
    trabajo: Option<Arc<Trabajo>>,
}

fn tasks() -> &'static Mutex<HashMap<String, Entry>> {
    static T: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(cargar_inicial()))
}

fn lock() -> Result<std::sync::MutexGuard<'static, HashMap<String, Entry>>, String> {
    tasks()
        .lock()
        .map_err(|_| "registro de tareas de motores envenenado".to_string())
}

pub(super) fn new_task(spec: TaskSpec) -> EngineTask {
    EngineTask {
        id: uuid::Uuid::new_v4().to_string(),
        engine: spec.engine.to_string(),
        kind: spec.kind,
        mode: spec.mode,
        cwd: spec.cwd,
        prompt: spec.prompt,
        status: "running".into(),
        started_at: now_iso(),
        finished_at: None,
        events: Vec::new(),
        summary: None,
        cloud_task_id: None,
        session_id: spec.session_id,
        thread_id: None,
        context_chars: spec.context_chars,
        model: spec.model,
        brought_at: None,
        anchor_message_uuid: None,
        usage: None,
        group: spec.group,
    }
}

/// Lanza el proceso y registra la tarea, con el plazo de su tipo.
pub fn spawn(spec: TaskSpec, launch: Launch) -> Result<EngineTask, String> {
    let plazo = plazo_de(&spec.kind);
    spawn_con_plazo(spec, launch, plazo)
}

/// `spawn` con un plazo explícito (los tests usan uno corto).
pub fn spawn_con_plazo(
    spec: TaskSpec,
    launch: Launch,
    plazo: Duration,
) -> Result<EngineTask, String> {
    let Launch {
        mut cmd,
        stdin,
        parser,
        on_done,
        vigia_stderr,
    } = launch;
    let engine = spec.engine;
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("no se pudo lanzar {engine}: {e}"))?;
    let trabajo = Trabajo::para(&child)
        .inspect_err(|e| tracing::warn!(motor = engine, error = %e, "motor sin Job Object"))
        .ok()
        .map(Arc::new);
    let pipe = child.stdin.take();
    std::thread::spawn(move || feed_stdin(pipe, stdin));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let task = new_task(spec);
    let child = Arc::new(Mutex::new(child));
    // Antes de tomar el registro: el relevo tiene su propio candado.
    let del_relevo = super::relevo::active_task_ids();
    {
        let mut m = lock()?;
        podar(&mut m, MAX_GUARDADAS, &del_relevo);
        m.insert(
            task.id.clone(),
            Entry {
                task: task.clone(),
                child: Some(child.clone()),
                trabajo,
            },
        );
    }
    emit(&task);
    let id = task.id.clone();
    let vigia = (id.clone(), child.clone());
    let plazo_id = id.clone();
    // Al terminar el lector se suelta `fin` y el vigilante del plazo sale.
    let (fin, fin_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let tid = id.clone();
        let cola = stderr
            .map(|e| std::thread::spawn(move || super::motor_stderr::cola(tid, e, vigia_stderr)));
        run_reader(&id, &child, stdout, cola, parser, on_done);
        drop(fin);
    });
    std::thread::spawn(move || cerrar_huerfanos(&vigia.0, &vigia.1));
    std::thread::spawn(move || vigilar_plazo(&plazo_id, &fin_rx, plazo));
    Ok(task)
}

/// Conserva las tareas en curso, las de un Tribunal con algún miembro en
/// curso, las de un relevo vivo (`del_relevo`: su escalado y su vuelta a Claude
/// todavía las leen) y las `max` terminadas más recientes. Los turnos de las
/// sesiones de motor (`chat`) no cuentan: los poda `podar_turnos` por sesión.
fn podar(m: &mut HashMap<String, Entry>, max: usize, del_relevo: &HashSet<String>) {
    let vivos = grupos_en_curso(m);
    let mut terminadas: Vec<(String, String)> = m
        .values()
        .filter(|e| !es_chat(&e.task))
        .filter(|e| !se_conserva(&e.task, &vivos) && !del_relevo.contains(&e.task.id))
        .map(|e| (e.task.started_at.clone(), e.task.id.clone()))
        .collect();
    if terminadas.len() <= max {
        return;
    }
    terminadas.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, id) in terminadas.into_iter().skip(max) {
        m.remove(&id);
    }
}

/// Grupos (Tribunal) con algún miembro en curso.
fn grupos_en_curso(m: &HashMap<String, Entry>) -> HashSet<String> {
    m.values()
        .filter(|e| e.task.status == "running")
        .filter_map(|e| e.task.group.clone())
        .collect()
}

/// Tarea que no se puede borrar: en curso, o de un Tribunal a medias (borrar
/// la respuesta ya terminada dejaría el grupo sin poder contrastarse).
fn se_conserva(t: &EngineTask, vivos: &HashSet<String>) -> bool {
    t.status == "running" || t.group.as_ref().is_some_and(|g| vivos.contains(g))
}

/// Espera a que termine el lector; si antes vence `plazo`, mata la tarea.
fn vigilar_plazo(id: &str, fin: &mpsc::Receiver<()>, plazo: Duration) {
    if let Err(mpsc::RecvTimeoutError::Timeout) = fin.recv_timeout(plazo) {
        vencer(id, plazo);
    }
}

/// Plazo vencido: la tarea pasa a `error` con la causa y se mata su árbol de
/// procesos. El lector, al ver el EOF, ya no la cambia.
fn vencer(id: &str, plazo: Duration) {
    abortar(id, |t| {
        format!(
            "Plazo máximo vencido ({}): se canceló el proceso de {}.",
            texto_plazo(plazo),
            engine_label(&t.engine)
        )
    });
}

/// La tarea en curso pasa a `error` con la causa y se mata su árbol de
/// procesos (plazo vencido o fallo detectado por el vigía de stderr).
pub(super) fn abortar(id: &str, causa: impl FnOnce(&EngineTask) -> String) {
    let procesos = lock().ok().and_then(|mut m| {
        let e = m.get_mut(id)?;
        if e.task.status != "running" {
            return None;
        }
        e.task.status = "error".into();
        e.task.finished_at = Some(now_iso());
        let texto = causa(&e.task);
        push_event(&mut e.task, evt("error", texto));
        Some((e.child.clone(), e.trabajo.clone()))
    });
    let Some((child, trabajo)) = procesos else {
        return;
    };
    tracing::warn!(tarea = id, "tarea de motor abortada");
    if let Err(e) = terminar_arbol(id, child, trabajo) {
        tracing::warn!(tarea = id, error = %e, "no se pudo terminar el motor abortado");
    }
    with_task(id, |_| {});
    guardar();
    if let Ok(task) = get(id) {
        super::relevo::task_finished(&task);
    }
}

fn texto_plazo(plazo: Duration) -> String {
    let s = plazo.as_secs();
    if s >= 60 {
        format!("{} min", s / 60)
    } else {
        format!("{:.1} s", plazo.as_secs_f64())
    }
}

/// Termina el Job Object (proceso, `node` y el binario nativo que haya
/// lanzado) y, como red, el proceso directo.
fn terminar_arbol(
    id: &str,
    child: Option<Arc<Mutex<Child>>>,
    trabajo: Option<Arc<Trabajo>>,
) -> Result<(), String> {
    let job_err = trabajo.and_then(|t| t.terminar().err());
    if let Some(c) = child {
        if let Ok(mut c) = c.lock() {
            if let Err(e) = c.kill() {
                // Si el job ya lo mató, kill devuelve error: solo cuenta sin job.
                if job_err.is_some() {
                    return Err(format!("no se pudo terminar el motor: {e}"));
                }
            }
        }
    }
    if let Some(e) = job_err {
        tracing::warn!(tarea = id, error = %e, "job del motor no terminado; se mató el proceso directo");
    }
    Ok(())
}

/// Margen tras la salida del proceso para vaciar la salida pendiente.
const GRACIA_HUERFANOS: Duration = Duration::from_secs(2);

/// Cuando el proceso directo sale, termina su Job Object si la tarea sigue
/// abierta pasado `GRACIA_HUERFANOS`: un nieto que heredó stdout o stderr
/// impediría el EOF y la tarea se quedaría «running» para siempre. `finish`
/// ya cierra el job en el caso normal; esto solo actúa si el lector no acabó.
fn cerrar_huerfanos(id: &str, child: &Mutex<Child>) {
    wait_child(child);
    std::thread::sleep(GRACIA_HUERFANOS);
    let trabajo = lock().ok().and_then(|m| m.get(id)?.trabajo.clone());
    if let Some(t) = trabajo {
        if let Err(e) = t.terminar() {
            tracing::warn!(tarea = id, error = %e, "no se pudieron terminar los nietos del motor");
        }
    }
}

fn feed_stdin(pipe: Option<std::process::ChildStdin>, bytes: Option<Vec<u8>>) {
    let (Some(mut pipe), Some(bytes)) = (pipe, bytes) else {
        return; // al soltar `pipe` se cierra stdin
    };
    if let Err(e) = pipe.write_all(&bytes) {
        tracing::warn!(error = %e, "no se pudo escribir el prompt en el motor");
    }
}

/// Salidas del proceso y vigía de stderr.
/// Lee stdout hasta el EOF y cierra la tarea; `cola` es el hilo que lee
/// stderr (`motor_stderr::cola`).
fn run_reader(
    id: &str,
    child: &Mutex<Child>,
    stdout: Option<std::process::ChildStdout>,
    cola: Option<std::thread::JoinHandle<String>>,
    mut parser: LineParser,
    on_done: Option<OnDone>,
) {
    // El fallo se decide al final: un `error` provisional de Codex seguido de
    // `turn.completed` era un reintento, no un fallo.
    let mut veredicto = Veredicto::default();
    if let Some(out) = stdout {
        por_lineas(out, |line| {
            let o = parser(line);
            veredicto.anotar(&o);
            with_task(id, |t| {
                // Una tarea cancelada o vencida no cambia aunque llegue
                // salida rezagada.
                if t.status == "running" {
                    apply_outcome(t, o);
                }
            });
        });
    }
    let tail = cola.and_then(|h| h.join().ok()).unwrap_or_default();
    let code = wait_child(child);
    if let Some(done) = finish(id, code, &veredicto, &tail) {
        if let Some(f) = on_done {
            f(&done);
        }
    }
}

/// Llama a `f` con cada línea de `r`, sin el salto. Una línea que no es UTF-8
/// (la salida de texto de `gemini` o `codex cloud`) se convierte con pérdida:
/// `lines()` paraba en ella, soltaba el pipe y el motor moría por pipe roto.
fn por_lineas(r: impl std::io::Read, mut f: impl FnMut(&str)) {
    let mut lector = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match lector.read_until(b'\n', &mut buf) {
            Ok(0) => return,
            Ok(_) => f(String::from_utf8_lossy(&buf).trim_end_matches(['\n', '\r'])),
            Err(e) => {
                tracing::warn!(error = %e, "lectura de la salida del motor interrumpida");
                return;
            }
        }
    }
}

/// Aplica a la tarea lo interpretado en una línea.
pub fn apply_outcome(t: &mut EngineTask, o: LineOutcome) {
    if let Some(m) = o.message {
        t.summary = Some(m);
    }
    if o.thread_id.is_some() {
        t.thread_id = o.thread_id;
    }
    if o.usage.is_some() {
        t.usage = o.usage;
    }
    push_event(t, o.event);
}

/// Espera al proceso con `try_wait` para no retener el mutex (cancelar
/// necesita tomarlo para matar el proceso).
fn wait_child(child: &Mutex<Child>) -> Option<i32> {
    loop {
        let polled = match child.lock() {
            Ok(mut c) => c.try_wait(),
            Err(_) => return None,
        };
        match polled {
            Ok(Some(status)) => return status.code(),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(_) => return None,
        }
    }
}

fn push_event(t: &mut EngineTask, e: Option<CodexEvent>) {
    if let Some(e) = e {
        t.events.push(e);
        if t.events.len() > MAX_EVENTS {
            let extra = t.events.len() - MAX_EVENTS;
            t.events.drain(0..extra);
        }
    }
}

/// Cierra la tarea; devuelve la instantánea final salvo si ya no estaba en
/// curso (cancelada o con el plazo vencido).
fn finish(id: &str, code: Option<i32>, veredicto: &Veredicto, stderr: &str) -> Option<EngineTask> {
    let mut finished = None;
    with_task(id, |t| {
        if t.status != "running" {
            return;
        }
        t.finished_at = Some(now_iso());
        let ok = code == Some(0) && !veredicto.fallido();
        t.status = if ok { "done" } else { "error" }.into();
        if t.mode == "cloud" {
            t.cloud_task_id = t.summary.as_deref().and_then(extract_cloud_task_id);
        }
        if let Some(e) = veredicto.error_pendiente().filter(|_| !ok) {
            push_event(t, evt("error", e.to_string()));
        }
        if !ok && !stderr.trim().is_empty() {
            push_event(t, evt("error", stderr.trim().to_string()));
        }
        if let Some(causa) = (!ok).then(|| causa_conocida(t)).flatten() {
            push_event(t, evt("error", causa.to_string()));
        }
        finished = Some(t.clone());
    });
    if let Ok(mut m) = lock() {
        if let Some(e) = m.get_mut(id) {
            e.child = None;
            // Cerrar el job (KILL_ON_JOB_CLOSE) se lleva los procesos huérfanos.
            e.trabajo = None;
        }
    }
    guardar();
    finished
}

/// Explicación de un fallo conocido del motor, para no dejar solo el error
/// crudo de su CLI.
pub fn causa_conocida(t: &EngineTask) -> Option<&'static str> {
    let texto = t
        .events
        .iter()
        .map(|e| e.text.to_lowercase())
        .collect::<Vec<_>>()
        .join("\n");
    if t.engine == "gemini" && texto.contains("ineligible") {
        return Some(
            "Causa: gemini-cli de npm no tiene tier gratuito (`ineligible`). Gemini solo \
funciona por agy (Antigravity).",
        );
    }
    None
}

/// Aplica `f` a la tarea y emite el resultado.
fn with_task(id: &str, f: impl FnOnce(&mut EngineTask)) {
    let snapshot = lock().ok().and_then(|mut m| {
        m.get_mut(id).map(|e| {
            f(&mut e.task);
            e.task.clone()
        })
    });
    if let Some(t) = snapshot {
        emit(&t);
    }
}

fn emit(t: &EngineTask) {
    // Solo `sesiones://engine`: el alias `sesiones://codex` duplicaba cada
    // línea de salida en todas las ventanas.
    if let Ok(v) = serde_json::to_value(t) {
        registro::emit(ev::ENGINE, v);
    }
    chat::avisar_cambio(t);
}

/// Tareas de todos los motores (o de uno), más recientes primero.
pub fn list(engine: Option<&str>) -> Vec<EngineTask> {
    let mut v: Vec<EngineTask> = lock()
        .map(|m| {
            m.values()
                .filter(|e| engine.is_none_or(|g| e.task.engine == g))
                .map(|e| e.task.clone())
                .collect()
        })
        .unwrap_or_default();
    v.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    v
}

/// Borra las tareas terminadas de `session_id` (y las que no tienen sesión):
/// la lista de Motores deja de arrastrar llamadas antiguas. Las que siguen en
/// curso y las de un Tribunal con algún miembro en curso se conservan. Emite
/// la lista que queda (`sesiones://engine-list`) para las demás ventanas.
/// Devuelve cuántas se borraron.
///
/// Las tareas sin sesión se borran a propósito: son las guardadas antes de
/// que cada tarea llevara `session_id`, y el inspector (`tasksOfSession` en
/// `Motores.tsx`) las muestra en la lista de TODAS las sesiones; si ninguna
/// sesión pudiera borrarlas, no habría forma de quitarlas. La UI siempre
/// lanza con sesión, así que no se crean tareas nuevas sin ella.
///
/// Los turnos de las sesiones de motor (`chat`) nunca se borran aquí.
pub fn limpiar(session_id: &str) -> Result<usize, String> {
    let borradas = {
        let del_relevo = super::relevo::active_task_ids();
        let mut m = lock()?;
        let antes = m.len();
        let vivos = grupos_en_curso(&m);
        m.retain(|_, e| {
            es_chat(&e.task)
                || se_conserva(&e.task, &vivos)
                || del_relevo.contains(&e.task.id)
                || e.task
                    .session_id
                    .as_deref()
                    .is_some_and(|s| s != session_id)
        });
        antes - m.len()
    };
    if borradas > 0 {
        guardar();
        chat::emitir_lista();
    }
    Ok(borradas)
}

pub fn get(id: &str) -> Result<EngineTask, String> {
    lock()?
        .get(id)
        .map(|e| e.task.clone())
        .ok_or_else(|| format!("no existe la tarea '{id}'"))
}

/// Fija el ancla de la tarea en la línea de tiempo (§5.6) y la emite.
pub fn anclar(id: &str, message_uuid: Option<String>) -> Result<EngineTask, String> {
    with_task(id, |t| t.anchor_message_uuid = message_uuid);
    get(id)
}

/// Añade un evento de error a una tarea ya registrada y la emite.
pub fn anotar_error(id: &str, texto: String) {
    with_task(id, |t| push_event(t, evt("error", texto)));
}

/// Cancela una tarea en curso: termina su Job Object (proceso, `node` y el
/// binario nativo que haya lanzado) y, como red, el proceso directo.
pub fn cancel(id: &str) -> Result<(), String> {
    let (child, trabajo) = {
        let mut m = lock()?;
        let e = m
            .get_mut(id)
            .ok_or_else(|| format!("no existe la tarea '{id}'"))?;
        if e.task.status != "running" {
            return Err("la tarea ya no está en curso".to_string());
        }
        e.task.status = "cancelled".into();
        e.task.finished_at = Some(now_iso());
        (e.child.clone(), e.trabajo.clone())
    };
    terminar_arbol(id, child, trabajo)?;
    with_task(id, |_| {});
    guardar();
    Ok(())
}

/// Termina los procesos de motores en curso al cerrar la app (`RunEvent::Exit`
/// en `lib.rs`): cada tarea en curso se cancela con su árbol de procesos.
pub fn matar_todos() {
    cancelar_vivas(|_| true);
}

/// Cancela las tareas en curso de una sesión que se cierra.
pub fn cancelar_de_sesion(session_id: &str) {
    cancelar_vivas(|t| t.session_id.as_deref() == Some(session_id));
}

fn cancelar_vivas(de: impl Fn(&EngineTask) -> bool) {
    let vivas: Vec<String> = list(None)
        .into_iter()
        .filter(|t| t.status == "running" && de(t))
        .map(|t| t.id)
        .collect();
    for id in vivas {
        if let Err(e) = cancel(&id) {
            tracing::warn!(tarea = %id, error = %e, "no se pudo terminar el motor");
        }
    }
}

/// Nombre visible del motor.
pub fn engine_label(engine: &str) -> &str {
    match engine {
        "codex" => "Codex",
        "gemini" => "Gemini",
        "opencode" => "OpenCode",
        other => other,
    }
}

// ---------------------------------------------------------------------------
// «Traer a Claude»: reserva atómica (motores-ventanas:F10)
// ---------------------------------------------------------------------------

/// Marca la tarea como traída en una sola sección crítica, si está terminada
/// y aún no se trajo. Devuelve la instantánea para componer el texto.
pub fn reservar_traida(id: &str) -> Result<EngineTask, String> {
    let snap = {
        let mut m = lock()?;
        let e = m
            .get_mut(id)
            .ok_or_else(|| format!("no existe la tarea '{id}'"))?;
        if e.task.status == "running" {
            return Err(format!(
                "la tarea de {} sigue en curso",
                engine_label(&e.task.engine)
            ));
        }
        if e.task.brought_at.is_some() {
            return Err("el resultado ya se trajo a Claude".to_string());
        }
        e.task.brought_at = Some(now_iso());
        e.task.clone()
    };
    emit(&snap);
    Ok(snap)
}

/// Deshace la reserva si el envío a la sesión falló.
pub fn revertir_traida(id: &str) {
    with_task(id, |t| t.brought_at = None);
}

/// Pega el resultado de una tarea terminada en `session_id` y la marca como
/// traída: el botón no vuelve a ofrecerse.
pub fn bring(task_id: &str, session_id: &str) -> Result<(), String> {
    super::intervencion::traer(task_id, session_id, &|sid, text| {
        super::gestor::send(sid, text, &[])
    })
}

/// Registra una tarea ya terminada (solo tests).
#[cfg(test)]
pub fn insertar_para_prueba(task: EngineTask) {
    if let Ok(mut m) = lock() {
        m.insert(
            task.id.clone(),
            Entry {
                task,
                child: None,
                trabajo: None,
            },
        );
    }
}

/// Job Object de una tarea (solo tests).
#[cfg(test)]
pub fn trabajo_de(id: &str) -> Option<Arc<Trabajo>> {
    lock().ok()?.get(id)?.trabajo.clone()
}

#[cfg(test)]
#[path = "tests_motor.rs"]
mod tests;
