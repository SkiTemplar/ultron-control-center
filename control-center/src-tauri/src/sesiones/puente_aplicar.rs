// sesiones/puente_aplicar.rs — Traducción de cada `PuenteEvent` (§6.3) a
// señales de la máquina, eventos de la ventana y estado de la sesión. Tipos
// desconocidos y eventos mal formados se ignoran con traza `debug` sin
// afectar al resto del lote (§6.1, tolerancia).
//
// Propiedad: WP-ESTADO.

use serde_json::{json, Value};

use super::{con_puente, s, stream, AcumTurno, SesionesPuente};
use crate::sesiones::senales::{self, Senal};
use crate::sesiones::types::{ev, now_iso, AgentNode, CommandInfoLive, Usage};
use crate::sesiones::{agentes, buzon, catalogo, cola, gestor, recuperacion, registro, transcript};

fn agente(e: &Value) -> Option<String> {
    e.get("agentId")
        .and_then(Value::as_str)
        .filter(|a| !a.is_empty())
        .map(str::to_string)
}

/// Etiqueta con la que la CLI abre un turno por el aviso de una tarea en
/// segundo plano (Bash o subagente).
const ETIQUETA_TAREA: &str = "<task-notification>";

/// Un `turnStart` o un `prompt` del hilo principal que abre el turno con el
/// aviso de una tarea: evidencia en tiempo real para `recuperacion`, que ya
/// no depende de que el transcript se escriba a tiempo.
fn es_aviso_de_tarea(e: &Value) -> bool {
    let por_texto = s(e, "text").is_some_and(|t| t.trim_start().starts_with(ETIQUETA_TAREA));
    por_texto || s(e, "origin").as_deref() == Some("task-notification")
}

fn actividad(id: &str, e: &Value) {
    senales::emitir(
        id,
        Senal::Actividad {
            agent_id: agente(e),
        },
    );
}

impl SesionesPuente {
    pub(super) fn apply(&self, id: &str, e: &Value) {
        let Some(tipo) = e.get("type").and_then(Value::as_str) else {
            tracing::debug!(sesion = id, "evento del puente sin tipo");
            return;
        };
        match tipo {
            "ready" => senales::emitir(id, Senal::PuenteListo),
            "turnStart" => self.turn_start(id, e),
            "text" | "thinking" => self.delta(id, e, tipo == "thinking"),
            "stepEnd" => self.step_end(id, e),
            "turnEnd" => self.turn_end(id, e),
            "tool" => self.tool(id, e),
            "agentSpawn" => self.agent_spawn(id, e),
            "agentEnd" => self.agent_end(id, e),
            "status" => self.status(id, e),
            "prompt" => prompt(id, e),
            "commandStart" | "commandEnd" => comando(id, e, tipo == "commandEnd"),
            "mode" => modo(id, e),
            "commands" => self.commands(id, e),
            "composerFill" => self.composer_fill(id, e),
            "notice" => self.sink.emit(
                ev::NOTICE,
                json!({ "id": id, "level": e.get("level"), "text": e.get("text") }),
            ),
            otro => tracing::debug!(sesion = id, tipo = otro, "evento del puente desconocido"),
        }
    }

    fn turn_start(&self, id: &str, e: &Value) {
        let Some(turn) = s(e, "turnId") else {
            return;
        };
        if agente(e).is_some() {
            return actividad(id, e);
        }
        con_puente(id, |p| {
            p.turno = AcumTurno {
                turn_id: turn.clone(),
                ..AcumTurno::default()
            }
        });
        recuperacion::anotar_turno(id);
        if es_aviso_de_tarea(e) {
            recuperacion::anotar_tarea(id);
        }
        senales::emitir(id, Senal::TurnoInicio { turn_id: turn });
    }

    fn delta(&self, id: &str, e: &Value, thinking: bool) {
        let delta = e.get("delta").and_then(Value::as_str).unwrap_or_default();
        let clave = stream::Clave::de_evento(e);
        let p = json!({
            "id": id, "agentId": e.get("agentId"), "turnId": e.get("turnId"),
            "step": clave.step, "block": clave.block,
            "text": delta, "thinking": thinking, "done": false,
        });
        self.sink.emit(ev::STREAM, p);
        if !thinking {
            registro::primer_token(id);
            for m in stream::delta(id, &clave, delta) {
                self.sink.emit(ev::STREAM_MATCHED, m.payload(id));
            }
        }
        actividad(id, e);
    }

    fn step_end(&self, id: &str, e: &Value) {
        let clave = stream::Clave::de_evento(e);
        self.sink.emit(
            ev::STREAM,
            json!({
                "id": id, "agentId": e.get("agentId"), "turnId": e.get("turnId"),
                "step": clave.step, "block": clave.block,
                "text": "", "stepDone": true, "done": false,
            }),
        );
        for m in stream::paso_fin(id, &clave) {
            self.sink.emit(ev::STREAM_MATCHED, m.payload(id));
        }
        actividad(id, e);
    }

    fn turn_end(&self, id: &str, e: &Value) {
        let turn = s(e, "turnId").unwrap_or_default();
        let aborted = e.get("isAborted").and_then(Value::as_bool) == Some(true);
        self.sink.emit(
            ev::STREAM,
            json!({ "id": id, "agentId": e.get("agentId"), "turnId": turn,
                    "text": "", "done": true, "aborted": aborted }),
        );
        let usage = e
            .get("usage")
            .filter(|u| u.is_object())
            .map(transcript::parse_usage);
        if agente(e).is_some() {
            // El subagente se valora con su modelo, que el mod manda si lo vio.
            let usage = usage.map(|u| Usage {
                model: s(e, "model"),
                ..u
            });
            con_puente(id, |p| p.turno.subagentes.extend(usage));
            return actividad(id, e);
        }
        con_puente(id, |p| {
            if p.turno.turn_id != turn {
                p.turno = AcumTurno {
                    turn_id: turn.clone(),
                    ..AcumTurno::default()
                };
            }
            p.turno.usage = usage;
        });
        let motivo = s(e, "reason").unwrap_or_else(|| "answer".into());
        recuperacion::anotar_turno(id);
        senales::emitir(
            id,
            Senal::TurnoFin {
                turn_id: turn,
                motivo,
                abortado: aborted,
            },
        );
    }

    fn tool(&self, id: &str, e: &Value) {
        self.sink.emit(
            ev::TOOL,
            json!({
                "id": id, "agentId": e.get("agentId"),
                "toolUseId": e.get("toolUseId"), "name": e.get("name"),
                "summary": e.get("summary"), "phase": e.get("phase"),
                "isError": e.get("isError"),
            }),
        );
        let (Some(tool), None) = (s(e, "toolUseId"), agente(e)) else {
            return actividad(id, e);
        };
        let senal = if e.get("phase").and_then(Value::as_str) == Some("end") {
            Senal::HerramientaFin { tool_use_id: tool }
        } else {
            Senal::HerramientaInicio {
                tool_use_id: tool,
                nombre: s(e, "name").unwrap_or_default(),
                timeout_ms: e.get("timeoutMs").and_then(Value::as_u64),
            }
        };
        senales::emitir(id, senal);
    }

    fn agent_spawn(&self, id: &str, e: &Value) {
        let Some(agent_id) = s(e, "agentId") else {
            return;
        };
        let agent_type = s(e, "agentType").unwrap_or_else(|| "subagente".into());
        let node = AgentNode {
            agent_id: agent_id.clone(),
            parent_agent_id: s(e, "parentAgentId"),
            max_turns: agentes::max_turns(&agent_type),
            agent_type,
            description: s(e, "description").unwrap_or_default(),
            status: "running".into(),
            started_at: now_iso(),
            turns: 0,
            tokens: 0,
            workflow_run: None,
            last_write_ms: 0,
            ended_at_ms: 0,
        };
        let _ = registro::update(id, |se| {
            se.live_agents.insert(agent_id, node);
            agentes::podar_vivos(&mut se.live_agents, agentes::MAX_VIVOS);
            (false, ())
        });
        gestor::emit_agents(id);
        actividad(id, e);
    }

    fn agent_end(&self, id: &str, e: &Value) {
        let Some(agent_id) = s(e, "agentId") else {
            return;
        };
        let status = if e.get("isError").and_then(Value::as_bool) == Some(true) {
            "error"
        } else {
            "done"
        };
        let _ = registro::update(id, |se| {
            if let Some(n) = se.live_agents.get_mut(&agent_id) {
                n.status = status.into();
                n.ended_at_ms = agentes::ahora_ms();
            }
            (false, ())
        });
        gestor::emit_agents(id);
        actividad(id, e);
    }

    fn status(&self, id: &str, e: &Value) {
        let model = s(e, "model");
        if let Some(m) = model.clone().filter(|m| !m.is_empty()) {
            let cambio = registro::update(id, |se| {
                let ch = se.info.model.as_deref() != Some(m.as_str());
                se.info.model = Some(m.clone());
                (ch, ch)
            });
            // Un `/model` a mitad de sesión (desde el chat o la TUI) entra en
            // la `Config` guardada: `restart` y la restauración relanzan con
            // él y no con el `--model` del lanzamiento.
            if cambio.unwrap_or(false) {
                crate::sesiones::lanzamiento::actualizar(id, Some(m.as_str()), None);
            }
        }
        if let Some(m) = s(e, "mode").filter(|m| !m.is_empty()) {
            senales::emitir(id, Senal::ModoPermisos { modo: m });
        }
        self.sink.emit(
            ev::STATUS,
            json!({
                "id": id, "model": model,
                "contextTokens": e.get("contextTokens"),
                "contextWindow": e.get("contextWindow"),
                "costUsd": e.get("costUsd"),
                "mode": e.get("mode"),
            }),
        );
    }

    fn commands(&self, id: &str, e: &Value) {
        let items: Vec<CommandInfoLive> = e
            .get("items")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|i| serde_json::from_value(i.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        let defs = catalogo::guardar_viva(id, &items);
        self.sink
            .emit(ev::COMMANDS, json!({ "id": id, "items": defs }));
    }
}

/// La señal va antes que la entrega en la cola: así el eco del transcript de
/// un turno ya cerrado, que llega por otro hilo, nunca ve la cola sin
/// pendientes sin ver también el prompt (`prompt_tras_cierre`, #41.3).
fn prompt(id: &str, e: &Value) {
    if agente(e).is_none() && es_aviso_de_tarea(e) {
        recuperacion::anotar_tarea(id);
    }
    let texto = s(e, "text").unwrap_or_default();
    let turn = s(e, "turnId");
    let en_turno = turn.is_some();
    senales::emitir(
        id,
        Senal::PromptEntrado {
            turn_id: turn,
            texto: texto.clone(),
            origen: s(e, "origin").unwrap_or_default(),
        },
    );
    cola::global().prompt_entrado(id, &texto, en_turno, buzon::ahora_ms());
    cola::emitir_actual(id);
}

fn comando(id: &str, e: &Value, fin: bool) {
    let run_id = s(e, "runId").unwrap_or_default();
    let nombre = s(e, "command").unwrap_or_default();
    let senal = if fin {
        Senal::ComandoFin {
            run_id,
            nombre,
            interceptado: e.get("intercepted").and_then(Value::as_bool) == Some(true),
        }
    } else {
        Senal::ComandoInicio { run_id, nombre }
    };
    senales::emitir(id, senal);
}

fn modo(id: &str, e: &Value) {
    if let Some(m) = s(e, "mode").filter(|m| !m.is_empty()) {
        senales::emitir(id, Senal::ModoPermisos { modo: m });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::super::{acumulado_turno, SesionesPuente};
    use crate::sesiones::preguntas::Broker;
    use crate::sesiones::test_sink::MockSink;
    use crate::sesiones::{recuperacion, registro};

    fn puente() -> SesionesPuente {
        SesionesPuente::new(Arc::new(MockSink::opened()), Arc::new(Broker::new()))
    }

    fn fin_de_subagente(agente: &str, modelo: Option<&str>) -> serde_json::Value {
        let mut e = json!({ "type": "turnEnd", "turnId": format!("t-{agente}"), "agentId": agente,
            "reason": "answer", "isAborted": false, "durationMs": 1,
            "usage": { "input_tokens": 3, "output_tokens": 4 } });
        if let Some(m) = modelo {
            e["model"] = json!(m);
        }
        e
    }

    #[test]
    fn el_uso_de_un_subagente_lleva_su_modelo_si_el_mod_lo_manda() {
        let id = format!("pa-{}", uuid::Uuid::new_v4());
        registro::insert(registro::sesion_de_prueba(&id)).expect("alta");
        let p = puente();
        p.apply(&id, &json!({ "type": "turnStart", "turnId": "t1" }));
        p.apply(&id, &fin_de_subagente("a1", Some("claude-sonnet-5-5")));
        p.apply(&id, &fin_de_subagente("a2", None));
        let acum = acumulado_turno(&id, "t1").expect("acumulado del turno");
        let modelos: Vec<Option<&str>> =
            acum.subagentes.iter().map(|u| u.model.as_deref()).collect();
        assert_eq!(modelos, [Some("claude-sonnet-5-5"), None]);
        assert_eq!(acum.subagentes[0].output, 4);
    }

    /// 2026-10-15: el turno que abre la CLI con el aviso de una tarea en
    /// segundo plano se anota al recibir su `turnStart` o su `prompt`, sin
    /// esperar al transcript. Un turno normal no (caso negativo).
    #[test]
    fn el_turno_abierto_por_un_aviso_de_tarea_se_anota_al_momento() {
        let id = format!("pa-tarea-{}", uuid::Uuid::new_v4());
        registro::insert(registro::sesion_de_prueba(&id)).expect("alta");
        let p = puente();
        let antes = std::time::Instant::now();
        p.apply(
            &id,
            &json!({ "type": "turnStart", "turnId": "t1", "text": "hola" }),
        );
        assert!(
            !recuperacion::tarea_desde(&id, antes),
            "un prompt normal no es una tarea"
        );
        assert!(
            recuperacion::turno_desde(&id, antes),
            "el turnStart cuenta como actividad"
        );
        let aviso = "<task-notification>\n<task-id>bi7gxenpf</task-id>";
        p.apply(
            &id,
            &json!({ "type": "turnStart", "turnId": "t2", "text": aviso }),
        );
        assert!(recuperacion::tarea_desde(&id, antes));
        let otra = format!("pa-tarea-{}", uuid::Uuid::new_v4());
        registro::insert(registro::sesion_de_prueba(&otra)).expect("alta");
        let antes = std::time::Instant::now();
        p.apply(
            &otra,
            &json!({ "type": "prompt", "text": "x", "origin": "task-notification" }),
        );
        assert!(recuperacion::tarea_desde(&otra, antes), "prompt con origin");
        registro::remove(&id);
        registro::remove(&otra);
    }
}
