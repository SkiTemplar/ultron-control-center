//! Aprobaciones compartidas con Claude y traducción de modos de los motores.
use super::*;
use crate::sesiones::codex_app::{Decision, PoliticaCodex};
use crate::sesiones::motor_eventos::OpcionPermiso;
use crate::sesiones::preguntas::{Broker, Resolucion};
use crate::sesiones::types::{
    AskAnswer, AskCancelReason, PermissionDecision, PermissionMode, WaitInfo, WaitKind,
};

impl registro::Sink for Vivo {
    fn emit(&self, evento: &str, valor: serde_json::Value) {
        self.emitir(evento, valor);
    }
    fn window_open(&self) -> bool {
        self.salida
            .as_ref()
            .or(registro::sink().as_ref())
            .is_some_and(|s| s.window_open())
    }
    fn avisar(&self, texto: &str) {
        if let Some(sink) = self.salida.clone().or_else(registro::sink) {
            sink.avisar(texto);
        }
    }
}

pub(crate) fn espera_permiso(id: &str) -> Option<WaitInfo> {
    let ask = Broker::global()
        .pending_for(id)
        .into_iter()
        .find(|a| a.kind == "permission")?;
    Some(WaitInfo {
        kind: WaitKind::Permission,
        ask_id: Some(ask.ask_id),
        label: ask.payload["summary"]
            .as_str()
            .unwrap_or("Permiso del motor")
            .into(),
        since: ask.created_at,
        options: None,
    })
}

pub(crate) fn aplicar_modo(id: &str, engine: &str, mode: PermissionMode) -> Result<(), String> {
    if matches!(mode, PermissionMode::Auto | PermissionMode::DontAsk) {
        return Err(format!(
            "{engine} no tiene equivalente para el modo {}",
            super::super::lanzamiento::modo_cli(mode)
        ));
    }
    let politica = if engine == "codex" {
        Some(PoliticaCodex::desde_modo(mode)?)
    } else {
        None
    };
    let Some(vivo) = obtener(id) else {
        return Ok(());
    };
    if engine == "opencode" {
        return reiniciar_opencode(id, &vivo, mode);
    }
    match (&vivo.cliente, politica) {
        (Cliente::Codex(c), Some(politica)) => c
            .establecer_politica(politica, &motor_sesion::get(id)?.cwd)
            .map_err(|e| e.to_string()),
        (Cliente::Acp(c), _) => {
            let modos = vivo.estado.lock().map_err(|e| e.to_string())?.modos.clone();
            let r = json!({"modes":{"availableModes":modos.iter().map(|m| json!({"id":m.id})).collect::<Vec<_>>()}});
            let modo = lanzar::modo_acp(engine, mode, &r)?;
            c.establecer_modo(&modo, PLAZO).map_err(|e| e.to_string())?;
            Ok(())
        }
        _ => Err(format!("{engine}: política de permisos incompatible")),
    }
}

/// Las reglas de OpenCode van en el entorno del proceso: un cambio de modo que
/// las cambia cierra el proceso y el siguiente envío lo relanza con las nuevas
/// (retoma el hilo con `session/load`). Con un turno en marcha no se cambia.
fn reiniciar_opencode(id: &str, vivo: &Arc<Vivo>, mode: PermissionMode) -> Result<(), String> {
    let sesion = motor_sesion::get(id)?;
    let antes = crate::sesiones::opencode::permisos_sesion(sesion.permission_mode);
    if antes == crate::sesiones::opencode::permisos_sesion(mode) {
        return Ok(());
    }
    if sesion.turno != motor_sesion::Turno::Libre {
        return Err(
            "OpenCode aplica los permisos al arrancar: cambia el modo cuando termine el turno"
                .into(),
        );
    }
    descartar(id, vivo);
    Ok(())
}

pub(super) fn permiso(id: &str, vivo: &Arc<Vivo>, evento: EventoMotor) {
    let EventoMotor::PeticionPermiso {
        id_peticion,
        herramienta,
        mut entrada,
        opciones,
        ..
    } = evento
    else {
        return;
    };
    if motor_sesion::get(id).is_ok_and(|s| s.permission_mode == PermissionMode::BypassPermissions) {
        responder(vivo, &id_peticion, &opciones, PermissionDecision::Allow);
        return;
    }
    let always = opciones
        .iter()
        .any(|o| o.tipo == "allow_always")
        .then(|| json!({"rules":[herramienta],"destination":"session"}));
    let summary = resumen(vivo, &herramienta, &mut entrada);
    let ask = json!({"kind":"permission","tool":herramienta,"input":entrada,"summary":summary,"always":always});
    match Broker::global().abrir(&**vivo, id, &ask, None) {
        Ok(ask) => {
            if vivo.cerrado.load(Ordering::Acquire) || !motor_sesion::existe(id) {
                cancelar(id, vivo, AskCancelReason::SessionExited);
            }
            publicar(id, vivo);
            let (id, vivo) = (id.to_string(), vivo.clone());
            std::thread::spawn(move || {
                let decision = esperar(ask.ask_id);
                responder(&vivo, &id_peticion, &opciones, decision);
                publicar(&id, &vivo);
            });
        }
        Err(error) => {
            responder(vivo, &id_peticion, &opciones, PermissionDecision::Deny);
            vivo.notice(id, "error", &error);
        }
    }
}

fn esperar(ask_id: String) -> PermissionDecision {
    loop {
        let resultado =
            Broker::global().esperar(std::slice::from_ref(&ask_id), Duration::from_secs(30));
        match resultado.first().map(|r| &r.resolucion) {
            Some(Resolucion::Respondida(AskAnswer::Permission { decision, .. })) => {
                return *decision
            }
            Some(Resolucion::Pendiente) => {}
            _ => return PermissionDecision::Deny,
        }
    }
}

fn responder(
    vivo: &Vivo,
    peticion: &str,
    opciones: &[OpcionPermiso],
    decision: PermissionDecision,
) {
    let tipo = match decision {
        PermissionDecision::Allow => "allow_once",
        PermissionDecision::AllowAlways => "allow_always",
        PermissionDecision::Deny => "reject_once",
    };
    let resultado = match &vivo.cliente {
        Cliente::Codex(c) => c.responder_aprobacion(
            peticion,
            match decision {
                PermissionDecision::Allow => Decision::Accept,
                PermissionDecision::AllowAlways => Decision::AcceptForSession,
                PermissionDecision::Deny => Decision::Decline,
            },
        ),
        Cliente::Acp(c) => c.responder_permiso(
            peticion,
            opciones
                .iter()
                .find(|o| o.tipo == tipo)
                .map(|o| o.id.as_str()),
        ),
    };
    if let Err(error) = resultado {
        let _ = vivo.eventos.send(EventoMotor::Error(error.to_string()));
    }
}

pub(super) fn cancelar(id: &str, vivo: &Vivo, motivo: AskCancelReason) {
    Broker::global().cancel_for(vivo, id, motivo);
}

fn publicar(_id: &str, vivo: &Vivo) {
    registro::emit_sessions();
    if vivo.salida.is_some() {
        vivo.emitir(ev::SESSIONS, json!(motor_sesion::infos()));
    }
}

fn resumen(vivo: &Vivo, herramienta: &str, entrada: &mut serde_json::Value) -> String {
    if herramienta != "Edit" {
        return herramienta.into();
    }
    let item = entrada["itemId"].as_str().unwrap_or_default();
    let mensajes = vivo
        .estado
        .lock()
        .ok()
        .and_then(|e| e.turno.as_ref().map(|t| t.constructor.mensajes()))
        .unwrap_or_default();
    for bloque in mensajes.iter().flat_map(|m| &m.blocks) {
        if let super::super::types::Block::ToolUse { id, input, .. } = bloque {
            if id == item {
                *entrada = input.clone();
                break;
            }
        }
    }
    let rutas: Vec<_> = entrada["paths"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .collect();
    if rutas.is_empty() {
        herramienta.into()
    } else {
        format!("Editar: {}", rutas.join(", "))
    }
}
