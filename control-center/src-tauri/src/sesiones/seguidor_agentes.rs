// sesiones/seguidor_agentes.rs — Seguimiento de los transcripts de
// subagentes de una sesión (contrato de estabilidad, §1.4 y CONTRATO-v3 §7).
//
// Cada subagente tiene su cursor y sus estadísticas; su nodo se recalcula al
// leer y se guarda en la caché de `agentes` para que `emit_agents` no relea
// el disco. Un agente terminado hace más de `RETIRO` deja de sondearse en
// cada tick y solo se revisa cada `REVISION_RETIRADO` (puede reanudarse con
// `SendMessage`). Los ficheros previos a que se empezara a seguir la sesión
// se abren en puesta al día: alimentan las estadísticas pero no reemiten
// mensajes ni actividad.

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use super::abrir_cursor;
use super::cursor::Cursor;
use crate::sesiones::agentes::{self, AgentStats};
use crate::sesiones::registro::FollowTarget;
use crate::sesiones::senales::{self, Senal};
use crate::sesiones::transcript::parse_value;
use crate::sesiones::types::{AgentNode, ChatMessage};

/// Tiempo tras terminar en que el agente se sigue sondeando en cada tick.
const RETIRO: Duration = Duration::from_secs(120);
/// Cada cuánto se revisa un agente retirado.
const REVISION_RETIRADO: Duration = Duration::from_secs(10);

pub(super) struct AgentCursor {
    cursor: Cursor,
    stats: AgentStats,
    meta: (String, String),
    path: PathBuf,
    nodo: AgentNode,
    terminado_desde: Option<Instant>,
    proxima_revision: Option<Instant>,
}

impl AgentCursor {
    fn abrir(dir: &Path, agent_id: &str, path: PathBuf, desde: SystemTime) -> Self {
        let meta = agentes::read_meta(agentes::meta_dir(dir, &path), agent_id);
        let stats = AgentStats::default();
        let nodo = agentes::node_from(agent_id, &meta, &stats, &path);
        Self {
            cursor: abrir_cursor(path.clone(), desde),
            stats,
            meta,
            path,
            nodo,
            terminado_desde: None,
            proxima_revision: None,
        }
    }

    /// false si está retirado y aún no toca revisarlo.
    fn toca_sondear(&mut self, ahora: Instant) -> bool {
        let retirado = self
            .terminado_desde
            .is_some_and(|t| ahora.saturating_duration_since(t) > RETIRO);
        if !retirado {
            return true;
        }
        if self.proxima_revision.is_some_and(|p| ahora < p) {
            return false;
        }
        self.proxima_revision = Some(ahora + REVISION_RETIRADO);
        true
    }

    /// Recalcula el nodo; true si cambió el estado.
    fn actualizar_nodo(&mut self, agent_id: &str, ahora: Instant) -> bool {
        let nodo = agentes::node_from(agent_id, &self.meta, &self.stats, &self.path);
        let cambio = nodo.status != self.nodo.status;
        if nodo.status == "done" {
            self.terminado_desde.get_or_insert(ahora);
        } else {
            self.terminado_desde = None;
            self.proxima_revision = None;
        }
        self.nodo = nodo;
        cambio
    }

    /// Lee las líneas nuevas; devuelve true si hubo alguna.
    fn leer(&mut self, sesion: &str, agent_id: &str, out: &mut Vec<ChatMessage>) -> bool {
        let l = self.cursor.leer();
        if l.reiniciado {
            self.stats = AgentStats::default();
        }
        if l.lineas.is_empty() {
            return false;
        }
        if !l.historicas {
            let actividad = Senal::Actividad {
                agent_id: Some(agent_id.to_string()),
            };
            senales::emitir(sesion, actividad);
        }
        for v in l.lineas {
            self.stats.feed(&v);
            let m = parse_value(&v, Some(agent_id), &mut self.cursor.state);
            if let Some(mut m) = m.filter(|_| !l.historicas) {
                crate::sesiones::puente_eventos::stream::emparejar_mensaje(sesion, &mut m);
                out.push(m);
            }
        }
        true
    }
}

/// Subagentes seguidos de una sesión.
#[derive(Default)]
pub(super) struct Agentes {
    cursores: HashMap<String, AgentCursor>,
}

impl Agentes {
    pub(super) fn clear(&mut self) {
        self.cursores.clear();
    }

    fn nodos(&self) -> Vec<AgentNode> {
        let mut v: Vec<AgentNode> = self.cursores.values().map(|a| a.nodo.clone()).collect();
        v.sort_by(|a, b| a.started_at.cmp(&b.started_at));
        v
    }

    /// Sigue los subagentes del transcript `sid`. Actualiza la caché de
    /// nodos y devuelve true si cambió el árbol (agente nuevo o estado).
    pub(super) fn seguir(
        &mut self,
        t: &FollowTarget,
        sid: &str,
        desde: SystemTime,
        out: &mut Vec<ChatMessage>,
    ) -> bool {
        let dir = agentes::subagents_dir(&t.slug_dir, sid);
        let ahora = Instant::now();
        let (mut cambio, mut lineas) = (false, false);
        for (agent_id, path) in agentes::list_agent_files(&dir) {
            let ac = match self.cursores.entry(agent_id.clone()) {
                Entry::Occupied(e) => e.into_mut(),
                Entry::Vacant(e) => {
                    cambio = true;
                    e.insert(AgentCursor::abrir(&dir, &agent_id, path, desde))
                }
            };
            if !ac.toca_sondear(ahora) {
                continue;
            }
            lineas |= ac.leer(&t.id, &agent_id, out);
            cambio |= ac.actualizar_nodo(&agent_id, ahora);
        }
        if cambio || lineas {
            agentes::guardar_nodos(&t.id, self.nodos());
        }
        cambio
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_agente_terminado_hace_rato_solo_se_revisa_de_vez_en_cuando() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("agent-a1.jsonl");
        std::fs::write(&p, "").expect("escribir");
        let mut ac = AgentCursor::abrir(dir.path(), "a1", p, SystemTime::UNIX_EPOCH);
        let t0 = Instant::now();
        assert!(ac.toca_sondear(t0), "en marcha: siempre");
        ac.terminado_desde = Some(t0);
        assert!(
            ac.toca_sondear(t0 + Duration::from_secs(60)),
            "recién terminado"
        );
        let tarde = t0 + RETIRO + Duration::from_secs(1);
        assert!(ac.toca_sondear(tarde), "primera revisión del retirado");
        assert!(
            !ac.toca_sondear(tarde + Duration::from_secs(1)),
            "no en cada tick"
        );
        assert!(ac.toca_sondear(tarde + REVISION_RETIRADO));
    }
}
