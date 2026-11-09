//! Transiciones de los turnos exec; sin llamadas externas bajo el candado.
use super::{cambiado, lock, sembrar_hilo, Turno};
use crate::sesiones::types::{now_iso, EngineTask};

/// Aviso de `motor::emit` en cada cambio de un turno: si el turno en curso de
/// su sesión terminó (bien, con error, cancelado o vencido), la sesión vuelve
/// a `idle` y, si es un turno local de Codex u OpenCode bien terminado, guarda
/// su hilo.
pub fn turno_actualizado(t: &EngineTask) {
    if t.status == "running" {
        return;
    }
    let Some(sid) = t.session_id.as_deref() else {
        return;
    };
    let hilo = (guarda_hilo(&t.engine) && t.status == "done" && t.mode == "local")
        .then(|| t.thread_id.clone())
        .flatten();
    let cerrado = lock().is_ok_and(|mut m| {
        let Some(s) = m.get_mut(sid) else {
            return false;
        };
        if s.turno != Turno::EnCurso(t.id.clone()) {
            return false;
        }
        s.turno = Turno::Libre;
        s.working_since = None;
        s.last_activity_at = now_iso();
        if hilo.is_some() {
            s.thread_id.clone_from(&hilo);
        }
        true
    });
    if !cerrado {
        return;
    }
    // `codex::start` y `opencode::start` ya lo recuerdan al terminar;
    // sembrarlo aquí no depende de ese orden.
    if let Some(h) = &hilo {
        sembrar_hilo(&t.engine, sid, h);
    }
    cambiado();
    crate::sesiones::motor_vivo::emitir_turno_exec(t);
    crate::sesiones::motor_cola::drenar(sid);
}

/// Turnos de las sesiones abiertas al arrancar, para el registro de `motor`
/// (salen de aquí: con la sesión abierta viven allí).
pub fn turnos_iniciales() -> Vec<EngineTask> {
    lock()
        .map(|mut m| {
            m.values_mut()
                .filter(|s| s.open)
                .flat_map(|s| std::mem::take(&mut s.turns))
                .collect()
        })
        .unwrap_or_default()
}

/// Motor que retoma su propio hilo entre turnos (Codex y OpenCode).
fn guarda_hilo(engine: &str) -> bool {
    matches!(engine, "codex" | "opencode")
}
