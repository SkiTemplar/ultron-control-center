// sesiones/comandos_v2.rs — Comandos Tauri del contrato v0.2
// (docs/sesiones/CONTRATO-v2.md, sección 1) y del contrato de estabilidad
// (columna «ESTADO» de §7.1). Envoltorios finos: la lógica vive en
// `ajustes`, `historial`, `catalogo`, `comando_run`, `cola`,
// `proyecto`, `motores`, `intervencion` y `motor`.

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::comandos::blocking;
use super::intervencion::RunRequest;
use super::preguntas::Broker;
use super::types::{
    Bitacora, CommandDef, CommandOutcome, EngineStatus, EngineTask, OpResult, QueueItem,
    QueueItemInput, QueueItemPatch, SessionInfo, SessionPrefs, SessionSettings,
};
use super::{
    ajustes, catalogo, cola, gestor, historial, intervencion, motor, motores, proyecto, registro,
    ventana,
};

/// Botón Claude de Projects: crea una sesión del proyecto y abre (o enfoca)
/// la ventana en ella.
#[tauri::command]
pub async fn sesiones_launch(app: AppHandle, project_id: String) -> Result<SessionInfo, String> {
    if !ajustes::valid_project_id(&project_id) {
        return Err(format!("id de proyecto no válido: '{project_id}'"));
    }
    let req = gestor::CreateRequest {
        project_id: Some(project_id.clone()),
        cwd: String::new(),
        resume: None,
        model: None,
        effort: None,
        permission_mode: None,
        fork_from: None,
    };
    let app2 = app.clone();
    let info = blocking(move || gestor::create(app2, req)).await?;
    ventana::open(&app, Some(project_id))?;
    Ok(info)
}

#[tauri::command]
pub async fn sesiones_settings(id: String) -> Result<SessionSettings, String> {
    blocking(move || ajustes::settings(&id)).await
}

/// `/effort` por el buzón (v2) o el PTY; `pending` con `opId` si Claude Code
/// no respondió en 5 s (§2.5).
#[tauri::command]
pub async fn sesiones_set_effort(id: String, effort: String) -> Result<OpResult, String> {
    blocking(move || ajustes::set_effort(&id, &effort)).await
}

#[tauri::command]
pub async fn sesiones_set_model(id: String, model: String) -> Result<OpResult, String> {
    blocking(move || ajustes::set_model(&id, &model)).await
}

#[tauri::command]
pub async fn sesiones_set_socratic(project_id: String, mode: String) -> Result<(), String> {
    blocking(move || ajustes::set_socratic(&project_id, &mode)).await
}

#[tauri::command]
pub async fn sesiones_prompt_history(
    project_id: Option<String>,
    cwd: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    blocking(move || historial::prompt_history(project_id.as_deref(), cwd.as_deref(), limit)).await
}

/// Paleta `/`: la lista viva de la sesión si el puente v2 la envió (§2.3);
/// si no, la fuente estática (parcial: sin plugins del marketplace).
#[tauri::command]
pub async fn sesiones_commands(cwd: String, id: Option<String>) -> Result<Vec<CommandDef>, String> {
    if let Some(id) = id
        .as_deref()
        .filter(|id| super::motor_sesion::get(id).is_ok())
    {
        let id = id.to_string();
        return blocking(move || Ok(super::motor_vivo::comandos(&id))).await;
    }
    if let Some(viva) = id.as_deref().and_then(catalogo::lista_viva) {
        return Ok(viva);
    }
    blocking(move || catalogo::commands(&cwd)).await
}

#[tauri::command]
pub async fn sesiones_bitacora(project_id: String) -> Result<Bitacora, String> {
    blocking(move || proyecto::bitacora(&project_id)).await
}

/// Motores disponibles. `force` (botón «Detectar») detecta en el acto en vez
/// de servir la caché.
#[tauri::command]
pub async fn sesiones_engines(force: Option<bool>) -> Result<Vec<EngineStatus>, String> {
    let force = force.unwrap_or(false);
    blocking(move || Ok(motores::engines(force))).await
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "comando Tauri: cada argumento es un campo del invoke del frontend"
)]
pub async fn sesiones_engine_run(
    session_id: String,
    engine: String,
    prompt: String,
    kind: String,
    include_context: bool,
    mode: Option<String>,
    model: Option<String>,
    group: Option<String>,
    turn_id: Option<String>,
    attachments: Option<Vec<String>>,
) -> Result<EngineTask, String> {
    let req = RunRequest {
        session_id,
        engine,
        prompt,
        kind,
        include_context,
        mode: mode.filter(|m| !m.is_empty()),
        model: model.filter(|m| !m.is_empty()),
        group: group.filter(|g| !g.is_empty()),
        turn_id: turn_id.filter(|t| !t.is_empty()),
        attachments: attachments.unwrap_or_default(),
    };
    blocking(move || intervencion::run(req)).await
}

/// Modelos que ofrece la CLI del motor (`codex` | `gemini`).
#[tauri::command]
pub async fn sesiones_engine_models(
    engine: String,
) -> Result<Vec<super::modelos::EngineModel>, String> {
    blocking(move || super::modelos::list(&engine)).await
}

#[tauri::command]
pub async fn sesiones_engine_bring(task_id: String, session_id: String) -> Result<(), String> {
    blocking(move || motor::bring(&task_id, &session_id)).await
}

#[tauri::command]
pub async fn sesiones_engine_cancel(task_id: String) -> Result<(), String> {
    blocking(move || motor::cancel(&task_id)).await
}

#[tauri::command]
pub async fn sesiones_engine_list() -> Result<Vec<EngineTask>, String> {
    Ok(motor::list(None))
}

#[tauri::command]
pub async fn sesiones_relay_list() -> Result<Vec<super::relevo::RelayState>, String> {
    Ok(super::relevo::list())
}

#[tauri::command]
pub async fn sesiones_relay_switch_gemini(
    session_id: String,
) -> Result<super::relevo::RelayState, String> {
    blocking(move || super::relevo::switch_to_gemini(&session_id)).await
}

#[tauri::command]
pub async fn sesiones_relay_return(session_id: String) -> Result<(), String> {
    blocking(move || super::relevo::return_to_claude(&session_id, true)).await
}

/// Borra de Motores las tareas terminadas de la sesión; devuelve la lista
/// que queda.
#[tauri::command]
pub async fn sesiones_engine_clear(session_id: String) -> Result<Vec<EngineTask>, String> {
    blocking(move || {
        motor::limpiar(&session_id)?;
        Ok(motor::list(None))
    })
    .await
}

/// Tribunal: pega en la sesión las respuestas del grupo para contrastarlas.
#[tauri::command]
pub async fn sesiones_engine_contrast(group: String, session_id: String) -> Result<(), String> {
    blocking(move || {
        intervencion::contrastar(&group, &session_id, &|sid, text| {
            super::gestor::send(sid, text, &[])
        })
    })
    .await
}

/// `/mejorar` desde el composer: reescribe el borrador por el AI Router y
/// devuelve el texto para revisarlo (no lo envía).
#[tauri::command]
pub async fn sesiones_mejorar(
    id: String,
    draft: String,
    last_error: Option<String>,
) -> Result<String, String> {
    blocking(move || super::mejorar::mejorar(&id, &draft, last_error)).await
}

/// Ventana adicional de Sessions (para ver chats a la vez); devuelve su etiqueta.
#[tauri::command]
pub async fn sesiones_new_window(
    app: AppHandle,
    session_id: Option<String>,
) -> Result<String, String> {
    ventana::open_extra(&app, session_id)
}

/// Botón «Control Center» de la barra superior: trae la ventana principal
/// (oculta en la bandeja si se arrancó con el acceso de Sessions).
#[tauri::command]
pub async fn sesiones_open_control_center(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window("main").is_none() {
        return Err("la ventana del Control Center no existe".into());
    }
    crate::tray::focus_main_window(&app);
    Ok(())
}

/// Dictado: un trozo de audio en base64 a texto (Whisper de Groq).
#[tauri::command]
pub async fn sesiones_transcribe(
    audio_b64: String,
    mime: String,
    language: Option<String>,
) -> Result<String, String> {
    blocking(move || super::voz::transcribe(&audio_b64, &mime, language.as_deref())).await
}

// ---------------------------------------------------------------------------
// Contrato de estabilidad (§7.1, columna «ESTADO»). Envoltorios finos: la
// lógica vive en `comando_run`, `cola`, `ajustes`, `preguntas` y `buzon`.
// ---------------------------------------------------------------------------

fn ahora() -> u64 {
    super::buzon::ahora_ms()
}

/// Ejecuta una operación de la cola y emite la instantánea resultante.
fn con_cola(
    id: &str,
    f: impl FnOnce(&cola::Colas) -> Result<Vec<QueueItem>, String>,
) -> Result<Vec<QueueItem>, String> {
    let r = f(cola::global());
    let items = cola::global().lista(id, ahora());
    cola::emitir(id, &items);
    r.map(|_| items)
}

/// `/x args` desde el composer (§2.2).
#[tauri::command]
pub async fn sesiones_run_command(
    id: String,
    command: String,
    args: String,
    client_id: String,
) -> Result<CommandOutcome, String> {
    blocking(move || super::comando_run::ejecutar(&id, &command, &args, &client_id)).await
}

/// Preguntas pendientes de una sesión o de todas (§4.2, paso 7).
#[tauri::command]
pub async fn sesiones_pending_asks(id: Option<String>) -> Result<Vec<Value>, String> {
    Ok(Broker::global().list(id.as_deref()))
}

#[tauri::command]
pub async fn sesiones_queue_list(id: String) -> Result<Vec<QueueItem>, String> {
    if super::motor_sesion::existe(&id) {
        return super::motor_cola::global().lista(&id);
    }
    Ok(cola::global().lista(&id, ahora()))
}

#[tauri::command]
pub async fn sesiones_queue_enqueue(
    id: String,
    item: QueueItemInput,
) -> Result<Vec<QueueItem>, String> {
    if item.client_id.trim().is_empty() {
        return Err("falta clientId".to_string());
    }
    if super::motor_sesion::existe(&id) {
        return super::motor_cola::global().encolar(&id, item);
    }
    con_cola(&id, |c| c.encolar(&id, item, ahora()))
}

#[tauri::command]
pub async fn sesiones_queue_update(
    id: String,
    client_id: String,
    patch: QueueItemPatch,
) -> Result<Vec<QueueItem>, String> {
    if super::motor_sesion::existe(&id) {
        return super::motor_cola::global().editar(&id, &client_id, patch);
    }
    con_cola(&id, |c| c.editar(&id, &client_id, patch, ahora()))
}

#[tauri::command]
pub async fn sesiones_queue_remove(
    id: String,
    client_id: String,
) -> Result<Vec<QueueItem>, String> {
    if super::motor_sesion::existe(&id) {
        return super::motor_cola::global().quitar(&id, &client_id);
    }
    con_cola(&id, |c| c.quitar(&id, &client_id, ahora()))
}

#[tauri::command]
pub async fn sesiones_queue_move(
    id: String,
    client_id: String,
    to_index: usize,
) -> Result<Vec<QueueItem>, String> {
    if super::motor_sesion::existe(&id) {
        return super::motor_cola::global().mover(&id, &client_id, to_index);
    }
    con_cola(&id, |c| c.mover(&id, &client_id, to_index, ahora()))
}

/// Sin `clientId`, todos los elementos en cola, seguidos. Levanta también la
/// pausa de la cola tras un cierre por plazo: el usuario decide que Claude
/// está libre.
#[tauri::command]
pub async fn sesiones_queue_send_now(
    id: String,
    client_id: Option<String>,
) -> Result<Vec<QueueItem>, String> {
    validar_envio_ya(&id)?;
    if super::motor_sesion::existe(&id) {
        return blocking(move || super::motor_cola::global().enviar_ya(&id, client_id.as_deref()))
            .await;
    }
    blocking(move || {
        let ctx = registro::contexto(&id);
        let w = cola::escritor();
        let r = con_cola(&id, |c| {
            c.enviar_ya(&id, client_id.as_deref(), ctx, &*w, ahora())
        })?;
        // Después de escribir: con la pausa levantada en idle, la máquina
        // drenaría a la vez lo mismo que se está enviando.
        super::senales::emitir(&id, super::senales::Senal::ReanudarCola);
        Ok(r)
    })
    .await
}

#[tauri::command]
pub async fn sesiones_queue_retry(id: String, client_id: String) -> Result<Vec<QueueItem>, String> {
    if super::motor_sesion::existe(&id) {
        return super::motor_cola::global().reintentar(&id, &client_id);
    }
    let r = con_cola(&id, |c| c.reintentar(&id, &client_id, ahora()));
    registro::pedir_drenaje(&id);
    r
}

/// Mantiene el camino de Claude y rechaza explícitamente el de motor.
pub(super) fn validar_envio_ya(id: &str) -> Result<(), String> {
    if super::motor_sesion::get(id).is_ok_and(|s| s.engine != "codex") {
        return Err(super::motor_cola::ERROR_ACP.into());
    }
    Ok(())
}

/// Preferencias de lanzamiento vigentes.
#[tauri::command]
pub async fn sesiones_prefs_get() -> Result<SessionPrefs, String> {
    blocking(|| Ok(ajustes::prefs_actuales())).await
}

#[tauri::command]
pub async fn sesiones_prefs_set(prefs: SessionPrefs) -> Result<SessionPrefs, String> {
    blocking(move || ajustes::guardar_prefs(&prefs)).await
}
