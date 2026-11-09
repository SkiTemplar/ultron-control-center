//! Ejecución y reducción de eventos; cada emisión se hace sin candados vivos.
use super::super::codex_app::ImagenCodex;
use super::super::intervencion::{split_attachments, with_attachment_list};
use super::*;

pub(super) fn enviar(
    id: &str,
    msg: &motor_sesion::Mensaje,
    vivo: Arc<Vivo>,
) -> Result<EngineTask, String> {
    if vivo.cerrado.load(Ordering::Acquire) {
        return Err("el proceso persistente terminó".into());
    }
    let tarea = nueva_tarea(id, msg)?;
    let usuario = transcript::usuario(msg.text, msg.attachments);
    transcript::anexar(id, std::slice::from_ref(&usuario))?;
    motor_sesion::fijar_vivo(id, &tarea.id)?;
    instalar_turno(id, &vivo, &tarea)?;
    vivo.emitir(ev::MESSAGES, json!({"id":id,"messages":[usuario]}));
    let (imagenes, archivos) = split_attachments(&tarea.engine, msg.attachments);
    let texto = with_attachment_list(msg.text.trim(), &archivos);
    let id = id.to_string();
    let modelo = tarea.model.clone();
    let (acuse, aceptado) = mpsc::channel();
    let ejecutando = vivo.clone();
    std::thread::spawn(move || ejecutar(&id, &ejecutando, texto, imagenes, modelo, acuse));
    match aceptado.recv_timeout(PLAZO) {
        Ok(resultado) => resultado?,
        Err(e) => {
            let texto = format!("el turno no fue aceptado: {e}");
            let _ = vivo.eventos.send(EventoMotor::Error(texto.clone()));
            return Err(texto);
        }
    }
    Ok(tarea)
}

pub(super) fn nueva_tarea(id: &str, msg: &motor_sesion::Mensaje) -> Result<EngineTask, String> {
    let s = motor_sesion::get(id)?;
    let mut tarea = motor::new_task(motor::TaskSpec {
        engine: motor_sesion::validar_motor(&s.engine)?,
        kind: motor::KIND_CHAT.into(),
        mode: "local".into(),
        cwd: s.cwd,
        prompt: msg.text.trim().into(),
        session_id: Some(id.into()),
        context_chars: 0,
        model: s.model,
        group: None,
    });
    tarea.thread_id = s.thread_id;
    Ok(tarea)
}

fn instalar_turno(id: &str, vivo: &Vivo, tarea: &EngineTask) -> Result<(), String> {
    {
        let mut estado = vivo.estado.lock().map_err(|e| e.to_string())?;
        if vivo.cerrado.load(Ordering::Acquire) {
            drop(estado);
            motor_sesion::terminar_vivo(id, &tarea.id);
            return Err("el proceso terminó antes de aceptar el turno".into());
        }
        estado.turno = Some(TurnoVivo {
            id: tarea.id.clone(),
            constructor: ConstructorTurno::nuevo(&tarea.id),
            fecha: tarea.started_at.clone(),
            inicio: Instant::now(),
            ultima: Instant::now(),
            sucio: false,
        });
    }
    Ok(())
}

fn ejecutar(
    id: &str,
    vivo: &Arc<Vivo>,
    texto: String,
    imagenes: Vec<String>,
    modelo: Option<String>,
    acuse: mpsc::Sender<Result<(), String>>,
) {
    let resultado = match &vivo.cliente {
        Cliente::Codex(c) => {
            let imagenes: Vec<_> = imagenes.into_iter().map(ImagenCodex::Local).collect();
            let resultado = if texto.trim() == "/review" {
                c.revisar(PLAZO)
            } else {
                c.turno_con_modelo(&texto, &imagenes, modelo.as_deref(), PLAZO)
            }
            .map(|_| ());
            let _ = acuse.send(resultado.as_ref().map(|_| ()).map_err(ToString::to_string));
            resultado
        }
        Cliente::Acp(c) => {
            let configurar = modelo
                .as_deref()
                .map(|m| c.establecer_modelo(m, PLAZO))
                .transpose();
            configurar
                .and_then(|_| {
                    c.prompt_con_acuse(&texto, &[], motor::PLAZO_TAREA, || {
                        let _ = acuse.send(Ok(()));
                    })
                })
                .map(|_| ())
        }
    };
    if let Err(error) = resultado {
        let _ = acuse.send(Err(error.to_string()));
        let _ = vivo
            .eventos
            .send(EventoMotor::Error(format!("{id}: {error}")));
    }
}

pub(super) fn recibir(id: &str, vivo: &Arc<Vivo>, evento: EventoMotor) {
    match &evento {
        EventoMotor::Comandos(comandos) => {
            if let Ok(mut estado) = vivo.estado.lock() {
                estado.comandos = comandos.clone();
            }
            vivo.emitir(
                ev::COMMANDS,
                json!({"id":id,"items":comandos_motor::desde_vivo(vivo)}),
            );
            return;
        }
        EventoMotor::Titulo(titulo) => {
            motor_sesion::titulo_vivo(id, titulo);
            return;
        }
        EventoMotor::PeticionPermiso { .. } => {
            permisos::permiso(id, vivo, evento);
            return;
        }
        EventoMotor::Error(texto) => {
            descartar(id, vivo);
            vivo.notice(id, "error", texto);
            finalizar(
                id,
                vivo,
                EventoMotor::FinTurno {
                    motivo: "error".into(),
                    uso: None,
                },
            );
            return;
        }
        EventoMotor::FinTurno { .. } => {
            finalizar(id, vivo, evento);
            return;
        }
        _ => {}
    }
    let inmediata = !matches!(
        evento,
        EventoMotor::MensajeDelta { .. } | EventoMotor::PensamientoDelta { .. }
    );
    aplicar_contenido(vivo, evento, inmediata);
    vaciar(id, vivo);
}

fn aplicar_contenido(vivo: &Vivo, evento: EventoMotor, inmediata: bool) {
    if let Ok(mut estado) = vivo.estado.lock() {
        match evento {
            EventoMotor::Comandos(c) => {
                estado.comandos = c;
            }
            EventoMotor::Modo {
                actual,
                disponibles,
            } => {
                estado.modo = actual;
                if !disponibles.is_empty() {
                    estado.modos = disponibles;
                }
            }
            EventoMotor::Modelos {
                actual,
                disponibles,
            } => {
                estado.modelo = actual;
                if !disponibles.is_empty() {
                    estado.modelos = disponibles;
                }
            }
            e => {
                if let Some(turno) = &mut estado.turno {
                    turno.constructor.aplicar(e);
                    turno.sucio = true;
                    if inmediata {
                        turno.ultima = Instant::now() - COALESCENCIA;
                    }
                }
            }
        }
    }
}

/// Mensajes del turno con la fecha de inicio: `ConstructorTurno` no tiene reloj
/// y el front ordena y pinta la hora con `timestamp`.
fn instantanea(t: &TurnoVivo) -> Vec<ChatMessage> {
    t.constructor
        .mensajes()
        .into_iter()
        .map(|mut m| {
            if m.timestamp.is_empty() {
                m.timestamp.clone_from(&t.fecha);
            }
            m
        })
        .collect()
}

pub(super) fn vaciar(id: &str, vivo: &Vivo) {
    let mensajes = vivo.estado.lock().ok().and_then(|mut e| {
        let t = e.turno.as_mut()?;
        if !t.sucio || t.ultima.elapsed() < COALESCENCIA {
            return None;
        }
        t.sucio = false;
        t.ultima = Instant::now();
        Some(instantanea(t))
    });
    if let Some(mensajes) = mensajes {
        emitir_mensajes(id, vivo, &mensajes);
    }
}

fn finalizar(id: &str, vivo: &Vivo, evento: EventoMotor) {
    let turno = vivo.estado.lock().ok().and_then(|mut e| e.turno.take());
    let Some(mut turno) = turno else {
        return;
    };
    let EventoMotor::FinTurno { motivo, uso } = &evento else {
        return;
    };
    turno.constructor.aplicar(evento.clone());
    let mensajes = instantanea(&turno);
    emitir_mensajes(id, vivo, &mensajes);
    if let Err(e) = transcript::anexar(id, &mensajes) {
        vivo.notice(id, "error", &e);
    }
    let payload = TurnPayload {
        id: id.into(),
        turn_id: turno.id.clone(),
        started_at: turno.fecha,
        ended_at: now_iso(),
        duration_ms: turno.inicio.elapsed().as_millis() as u64,
        reason: motivo_turno(motivo).into(),
        usage: uso.clone(),
        subagent_usage: Vec::new(),
    };
    vivo.emitir(ev::TURN, json!(payload));
    motor_sesion::terminar_vivo(id, &turno.id);
}

/// Motivo de fin del protocolo (`stopReason` de ACP, `turn.status` de Codex) al
/// `TurnEndReason` del front: `answer`, `aborted`, `refusal` o `error`.
pub(super) fn motivo_turno(motivo: &str) -> &'static str {
    match motivo {
        "cancelled" | "interrupted" | "aborted" => "aborted",
        "refusal" => "refusal",
        "error" | "failed" => "error",
        _ => "answer",
    }
}

fn emitir_mensajes(id: &str, vivo: &Vivo, mensajes: &[ChatMessage]) {
    vivo.emitir(ev::MESSAGES, json!({"id":id,"messages":mensajes}));
}
