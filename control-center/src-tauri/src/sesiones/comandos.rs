// sesiones/comandos.rs — Comandos Tauri de la ventana Sesiones.
//
// Envoltorios finos sobre `gestor`, `adjuntos`, `ficheros` y `ventana` (los de
// la v0.2 están en `comandos_v2`; los de PTY, en `comandos_pty`). Los
// argumentos llegan con nombre desde `invoke` (camelCase en JS, snake_case
// aquí). Lo que bloquea (disco, git, HTTP, esperas) va a `spawn_blocking`.

use tauri::AppHandle;

use super::adjuntos::{self, SavedAttachment};
use super::pagina::HistoryPage;
use super::preguntas::Broker;
use super::registro;
use super::types::{
    AgentNode, AskAnswer, PastSession, PermissionDecision, PlanUsage, QueueItemInput,
    QueueItemKind, SendMode, SendOutcome, SessionInfo, WorkflowRun,
};
use super::{cola, gestor, permiso_siempre, ventana};

pub(super) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("tarea interna fallida: {e}"))?
}

#[tauri::command]
pub async fn sesiones_open_window(
    app: AppHandle,
    project_id: Option<String>,
) -> Result<(), String> {
    ventana::open(&app, project_id)
}

#[tauri::command]
pub async fn sesiones_list() -> Result<Vec<SessionInfo>, String> {
    Ok(gestor::list())
}

#[tauri::command]
pub async fn sesiones_past(
    project_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<PastSession>, String> {
    blocking(move || gestor::past(project_id.as_deref(), limit)).await
}

/// Envío desde el composer (§5.2): pasa siempre por la cola del backend
/// (idempotente por `clientId`); `auto` encola si la sesión no está libre y
/// `now` escribe en la cola nativa de la CLI. Un fallo de escritura deja el
/// elemento en `failed` y devuelve el error.
#[tauri::command]
pub async fn sesiones_send(
    id: String,
    text: String,
    attachments: Option<Vec<String>>,
    client_id: Option<String>,
    mode: Option<SendMode>,
) -> Result<SendOutcome, String> {
    let client_id = client_id
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    blocking(move || {
        let kind = if text.trim_start().starts_with('!') {
            QueueItemKind::Bash
        } else {
            QueueItemKind::Prompt
        };
        let input = QueueItemInput {
            client_id,
            text,
            attachments: attachments.unwrap_or_default(),
            delegate: false,
            kind,
        };
        let ctx = registro::contexto(&id);
        let w = cola::escritor();
        let ahora = super::buzon::ahora_ms();
        let r = cola::global().enviar(&id, input, mode.unwrap_or_default(), ctx, &*w, ahora);
        cola::emitir_actual(&id);
        r
    })
    .await
}

#[tauri::command]
pub async fn sesiones_rename(id: String, title: String) -> Result<(), String> {
    gestor::rename(&id, &title)
}

/// Página del historial (CONTRATO-v3 §7): los últimos `limit` mensajes antes
/// de `beforeUuid`, sin partir el turno. Error `history_cursor_gone` si el
/// cursor ya no existe.
#[tauri::command]
pub async fn sesiones_history(
    id: String,
    agent_id: Option<String>,
    before_uuid: Option<String>,
    limit: Option<usize>,
) -> Result<HistoryPage, String> {
    blocking(move || gestor::history(&id, agent_id.as_deref(), before_uuid.as_deref(), limit)).await
}

/// Ficheros del proyecto para el autocompletar `@` del composer.
#[tauri::command]
pub async fn sesiones_files(cwd: String) -> Result<Vec<String>, String> {
    blocking(move || {
        let vivos: Vec<String> = registro::list().into_iter().map(|s| s.cwd).collect();
        if !super::ficheros::es_cwd_de_sesion(&cwd, &vivos) {
            return Err(format!(
                "{cwd} no es el directorio de ninguna sesión abierta"
            ));
        }
        super::ficheros::listar(&cwd)
    })
    .await
}

#[tauri::command]
pub async fn sesiones_agents(id: String) -> Result<Vec<AgentNode>, String> {
    // Una sesión de motor no tiene subagentes de Claude Code.
    if super::motor_sesion::existe(&id) {
        return Ok(Vec::new());
    }
    blocking(move || gestor::agents(&id)).await
}

/// Runs de `Workflow` de la sesión (tarjeta del chat); se reconstruyen
/// desde el disco si el seguidor aún no tiene foto.
#[tauri::command]
pub async fn sesiones_workflows(id: String) -> Result<Vec<WorkflowRun>, String> {
    // Ni runs de `Workflow`: son de Claude Code.
    if super::motor_sesion::existe(&id) {
        return Ok(Vec::new());
    }
    blocking(move || super::workflows::seguidor::de_sesion(&id)).await
}

#[tauri::command]
pub async fn sesiones_answer(ask_id: String, answer: AskAnswer) -> Result<(), String> {
    let sink = registro::sink().ok_or_else(|| "Sesiones no está inicializado".to_string())?;
    if es_permitir_siempre(&answer)
        && Broker::global()
            .sesion_de(&ask_id)
            .is_none_or(|id| requiere_regla_claude(&id))
    {
        let id = ask_id.clone();
        blocking(move || guardar_regla_siempre(&id)).await?;
    }
    Broker::global()
        .answer(&*sink, &ask_id, answer)
        .map_err(|e| e.codigo().to_string())
}

fn es_permitir_siempre(answer: &AskAnswer) -> bool {
    matches!(
        answer,
        AskAnswer::Permission {
            decision: PermissionDecision::AllowAlways,
            ..
        }
    )
}

/// H6: guarda la regla de «Permitir siempre» antes de contestar. Si no se
/// puede, el ask sigue pendiente y la ventana enseña el motivo. Un ask ya
/// resuelto sigue su camino: `answer` devolverá `ask_gone`.
fn guardar_regla_siempre(ask_id: &str) -> Result<(), String> {
    let Some(ask) = Broker::global().pendiente(ask_id) else {
        return Ok(());
    };
    let cwd = registro::read(&ask.sesion_id, |s| s.info.cwd.clone())?;
    permiso_siempre::guardar(&ask, &cwd).map_err(|e| {
        format!("No se guardó la regla de «Permitir siempre»: {e}. La petición sigue abierta.")
    })
}

pub(super) fn requiere_regla_claude(id: &str) -> bool {
    super::motor_sesion::get(id).is_err()
}

#[tauri::command]
pub async fn sesiones_save_attachment(
    name: String,
    data_base64: String,
    media_type: Option<String>,
) -> Result<SavedAttachment, String> {
    // El tipo se deduce de la extensión; `media_type` es informativo.
    let _ = media_type;
    blocking(move || adjuntos::save(&name, &data_base64)).await
}

#[tauri::command]
pub async fn sesiones_read_image(path: String) -> Result<String, String> {
    blocking(move || adjuntos::read_image(&path)).await
}

#[tauri::command]
pub async fn sesiones_open_image(
    app: tauri::AppHandle,
    path: String,
    cwd: Option<String>,
) -> Result<(), String> {
    blocking(move || super::archivos::open_image(&app, &path, cwd.as_deref())).await
}

#[tauri::command]
pub async fn sesiones_reveal_path(
    app: tauri::AppHandle,
    path: String,
    cwd: Option<String>,
) -> Result<(), String> {
    blocking(move || super::archivos::reveal(&app, &path, cwd.as_deref())).await
}

/// Abre un fichero citado en la sesión con la app del sistema (pestaña
/// Adjuntos); rechaza ejecutables y scripts (ver `archivos::ABRIBLES`).
#[tauri::command]
pub async fn sesiones_open_file(
    app: tauri::AppHandle,
    path: String,
    cwd: Option<String>,
) -> Result<(), String> {
    blocking(move || super::archivos::open_file(&app, &path, cwd.as_deref())).await
}

/// Estado en disco de rutas absolutas citadas en la sesión (existe, es
/// fichero, se puede abrir), en el mismo orden.
#[tauri::command]
pub async fn sesiones_paths_status(
    paths: Vec<String>,
) -> Result<Vec<super::archivos::EstadoRuta>, String> {
    blocking(move || super::archivos::estados(&paths)).await
}

/// Ficheros que Claude editó en el turno que empezó en `since` (ISO), leídos
/// del transcript (hilo principal y subagentes): la segunda opinión
/// automática no puede contarlos en la ventana, que recorta los mensajes.
#[tauri::command]
pub async fn sesiones_turn_edits(id: String, since: String) -> Result<Vec<String>, String> {
    blocking(move || gestor::ediciones_turno(&id, &since)).await
}

#[tauri::command]
pub async fn sesiones_open_in_editor(
    app: tauri::AppHandle,
    path: String,
    line: Option<u32>,
    cwd: Option<String>,
) -> Result<(), String> {
    blocking(move || super::archivos::open_in_editor(&app, &path, line, cwd.as_deref())).await
}

/// Guarda una imagen del chat donde elija el usuario; `None` si cancela.
#[tauri::command]
pub async fn sesiones_save_image(
    app: tauri::AppHandle,
    data_url: String,
    name: String,
) -> Result<Option<String>, String> {
    blocking(move || super::archivos::save_image(&app, &data_url, &name)).await
}

/// Exporta la conversación completa de la sesión a Markdown o HTML en el
/// destino que el usuario elige en el diálogo; `None` si cancela.
#[tauri::command]
pub async fn sesiones_export(
    app: tauri::AppHandle,
    id: String,
    format: super::exportar::Formato,
) -> Result<Option<super::exportar::Exportado>, String> {
    blocking(move || super::exportar::exportar(&app, &id, format)).await
}

/// Abre (o muestra en su carpeta, con `reveal`) un fichero exportado antes
/// por `sesiones_export` en este proceso.
#[tauri::command]
pub async fn sesiones_export_open(
    app: tauri::AppHandle,
    path: String,
    reveal: Option<bool>,
) -> Result<(), String> {
    blocking(move || super::exportar::abrir(&app, &path, reveal.unwrap_or(false))).await
}

/// Uso del plan: la muestra local de la línea de estado si es reciente y, si
/// no, el endpoint OAuth (ver `uso::plan_usage`). `force` (Actualizar) pide
/// el dato en vivo aunque haya caché o se esté esperando tras un fallo.
#[tauri::command]
pub async fn sesiones_usage(force: Option<bool>) -> Result<PlanUsage, String> {
    let force = force.unwrap_or(false);
    blocking(move || super::uso::plan_usage(force)).await
}

/// Ritmo, límite estimado y ventanas de 5 h que quedan (mismo cálculo que el
/// mod `ultron-uso`), con la fuente, la hora de la lectura y el motivo del
/// último fallo del endpoint. `force` como en `sesiones_usage`: pedidos
/// seguidos comparten la llamada (`plan_limits::FORCE_DEDUP_SECS`).
#[tauri::command]
pub async fn sesiones_usage_pace(force: Option<bool>) -> Result<serde_json::Value, String> {
    let force = force.unwrap_or(false);
    blocking(move || {
        let usage = super::uso::plan_usage(force)?;
        Ok(super::uso::con_fuente(super::uso::pace(&usage)?, &usage))
    })
    .await
}

/// Uso de las suscripciones de Codex y agy (`uso_motores`), aparte del de
/// Claude: si uno falla, el otro sigue. `force` salta la caché de `agy /usage`.
#[tauri::command]
pub async fn sesiones_engines_usage(force: Option<bool>) -> Result<serde_json::Value, String> {
    let force = force.unwrap_or(false);
    blocking(move || super::uso_motores::engines_usage(force)).await
}
