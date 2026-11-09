// sesiones/agentes.rs — Árbol de subagentes de una sesión.
//
// Claude Code guarda cada subagente en
// `<slugdir>/<sessionId>/subagents/agent-<agentId>.jsonl` con un
// `agent-<agentId>.meta.json` al lado (`agentType`, `description`,
// `toolUseId`, `spawnDepth`…); los agentes de un `Workflow` van un nivel más
// abajo, en `subagents/workflows/<runId>/`. El estado se deduce del transcript (último
// `stop_reason`) y se combina con lo que notifique el puente en vivo.
//
// El disco solo se recorre entero al abrir o reanudar (`scan`, comando
// `sesiones_agents`); en vivo, el seguidor mantiene los nodos en una caché
// por sesión (`guardar_nodos`) a partir de las estadísticas que ya acumula,
// y `gestor::emit_agents` la usa sin releer ningún JSONL.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;

use super::transcript::IdsRecientes;
use super::types::AgentNode;

/// Sin escrituras en este tiempo y sin fin de turno, el agente queda «sin señal»:
/// una orden larga no escribe en el transcript, así que no se sabe si terminó.
const STALE_AFTER: Duration = Duration::from_secs(600);
/// Holgura entre el fin que notifica el puente y las últimas escrituras en disco.
const MARGEN_FIN_MS: u64 = 5_000;
/// Agentes notificados por el puente que se recuerdan por sesión: por encima
/// se olvidan los terminados más antiguos (el disco conserva su nodo).
pub const MAX_VIVOS: usize = 256;

/// Vigencia de un `maxTurns` leído del frontmatter: después se relee, por si
/// se editó el agente con la app abierta.
const MAX_TURNS_TTL: Duration = Duration::from_secs(60);

/// Directorio que sustituye al de un sid que no es un nombre simple: queda
/// dentro de `slug_dir` y no existe, así que no se lista nada.
const SIN_SID_VALIDO: &str = ".sid-no-valido";

/// `<slug_dir>/<sid>/subagents`. Un sid absoluto, UNC, con separadores o
/// `..` sacaba la ruta de `slug_dir` (`PathBuf::join` sustituye la base):
/// solo se admiten alfanuméricos, `-` y `_` (un UUID lo es).
pub fn subagents_dir(slug_dir: &Path, claude_session_id: &str) -> PathBuf {
    if es_sid_simple(claude_session_id) {
        return slug_dir.join(claude_session_id).join("subagents");
    }
    tracing::warn!(
        sid = claude_session_id,
        "sid no válido para el directorio de subagentes"
    );
    slug_dir.join(SIN_SID_VALIDO).join("subagents")
}

fn es_sid_simple(sid: &str) -> bool {
    (1..=128).contains(&sid.len())
        && sid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// Estadísticas acumuladas de un transcript de subagente.
#[derive(Default, Clone)]
pub struct AgentStats {
    /// Ids recientes de `message.id` (acotados: solo deduplican).
    message_ids: IdsRecientes,
    turns: u32,
    pub tokens: u64,
    pub started_at: Option<String>,
    pub ended: bool,
}

impl AgentStats {
    /// Incorpora una línea cruda del JSONL.
    pub fn feed(&mut self, v: &Value) {
        if self.started_at.is_none() {
            if let Some(ts) = v.get("timestamp").and_then(Value::as_str) {
                self.started_at = Some(ts.to_string());
            }
        }
        match v.get("type").and_then(Value::as_str) {
            Some("assistant") => {}
            // Tras el último `end_turn` no se escribe nada: una línea posterior
            // significa que el agente se reanudó (`SendMessage`).
            Some("user" | "api-request") => {
                self.ended = false;
                return;
            }
            _ => return,
        }
        let Some(msg) = v.get("message") else { return };
        let id = msg.get("id").and_then(Value::as_str).unwrap_or("");
        if self.message_ids.insertar(id) {
            self.turns = self.turns.saturating_add(1);
            self.tokens += msg
                .pointer("/usage/output_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
        }
        self.ended = msg.get("stop_reason").and_then(Value::as_str) == Some("end_turn");
    }

    pub fn turns(&self) -> u32 {
        self.turns
    }
}

/// Metadatos de `agent-<id>.meta.json` (tipo y descripción).
pub fn read_meta(dir: &Path, agent_id: &str) -> (String, String) {
    let path = dir.join(format!("agent-{agent_id}.meta.json"));
    let v: Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let s = |k: &str| {
        v.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let agent_type = s("agentType");
    (
        if agent_type.is_empty() {
            "subagente".to_string()
        } else {
            agent_type
        },
        s("description"),
    )
}

/// `maxTurns` del frontmatter YAML (entre las dos líneas `---` iniciales).
fn max_turns_de(texto: &str) -> Option<u32> {
    let mut lineas = texto.lines();
    if lineas.next()?.trim() != "---" {
        return None;
    }
    lineas
        .take_while(|l| l.trim() != "---")
        .find_map(|l| l.trim().strip_prefix("maxTurns:"))
        .and_then(|v| v.trim().trim_matches(['"', '\'']).parse().ok())
}

/// `maxTurns` del agente `<tipo>.md` de `dir`. Un tipo que no es un nombre
/// simple (`plugin:agente`, rutas) no tiene fichero aquí: `None`.
pub fn max_turns_en(dir: &Path, agent_type: &str) -> Option<u32> {
    if !es_sid_simple(agent_type) {
        return None;
    }
    let texto = std::fs::read_to_string(dir.join(format!("{agent_type}.md"))).ok()?;
    max_turns_de(&texto)
}

type CacheTopes = Mutex<HashMap<String, (Instant, Option<u32>)>>;

fn topes() -> &'static CacheTopes {
    static C: OnceLock<CacheTopes> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `maxTurns` de `~/.claude/agents/<tipo>.md`, con caché de un minuto: el
/// seguidor rehace los nodos en cada pasada y no debe leer el disco cada vez.
pub fn max_turns(agent_type: &str) -> Option<u32> {
    let ahora = Instant::now();
    let vigente = topes().lock().ok().and_then(|c| {
        c.get(agent_type)
            .filter(|(leido, _)| ahora.saturating_duration_since(*leido) < MAX_TURNS_TTL)
            .map(|(_, v)| *v)
    });
    if let Some(v) = vigente {
        return v;
    }
    let dir = dirs::home_dir()?.join(".claude").join("agents");
    let v = max_turns_en(&dir, agent_type);
    if let Ok(mut c) = topes().lock() {
        c.insert(agent_type.to_string(), (ahora, v));
    }
    v
}

/// `agent-<id>.jsonl` → `<id>`.
pub fn agent_id_from_file(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let id = name.strip_prefix("agent-")?.strip_suffix(".jsonl")?;
    (!id.is_empty()).then(|| id.to_string())
}

/// Subdirectorio donde Claude Code guarda los agentes de cada `Workflow`:
/// `subagents/workflows/<runId>/agent-<id>.jsonl`.
const WORKFLOWS: &str = "workflows";

fn agent_files_in(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    rd.flatten()
        .map(|e| e.path())
        .filter_map(|p| agent_id_from_file(&p).map(|id| (id, p)))
        .collect()
}

/// Directorios `workflows/<runId>` (solo un nivel; sin seguir enlaces).
fn workflow_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir.join(WORKFLOWS)) else {
        return Vec::new();
    };
    rd.flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect()
}

/// Ficheros de subagente del directorio y de los `Workflow` de la sesión.
pub fn list_agent_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out = agent_files_in(dir);
    for wf in workflow_dirs(dir) {
        out.extend(agent_files_in(&wf));
    }
    out
}

/// Transcript de un subagente: directo en `subagents/` o dentro de un
/// `Workflow`. `agent_id` ya validado por el llamante.
pub fn agent_file(dir: &Path, agent_id: &str) -> PathBuf {
    let name = format!("agent-{agent_id}.jsonl");
    let direct = dir.join(&name);
    if direct.is_file() {
        return direct;
    }
    workflow_dirs(dir)
        .into_iter()
        .map(|wf| wf.join(&name))
        .find(|p| p.is_file())
        .unwrap_or(direct)
}

/// Directorio que contiene el `.meta.json` de un transcript de subagente.
pub fn meta_dir<'a>(dir: &'a Path, path: &'a Path) -> &'a Path {
    path.parent().unwrap_or(dir)
}

fn is_stale(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|d| d > STALE_AFTER)
}

fn ms_desde_epoca(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

pub fn ahora_ms() -> u64 {
    ms_desde_epoca(SystemTime::now())
}

fn ultima_escritura_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(ms_desde_epoca)
        .unwrap_or(0)
}

/// `<runId>` si el transcript está en `workflows/<runId>/`.
fn workflow_run_de(path: &Path) -> Option<String> {
    let run = path.parent()?;
    if run.parent()?.file_name()?.to_str()? != WORKFLOWS {
        return None;
    }
    Some(run.file_name()?.to_str()?.to_string())
}

pub fn node_from(
    agent_id: &str,
    meta: &(String, String),
    stats: &AgentStats,
    path: &Path,
) -> AgentNode {
    let status = if stats.ended {
        "done"
    } else if is_stale(path) {
        "stale"
    } else {
        "running"
    };
    AgentNode {
        agent_id: agent_id.to_string(),
        parent_agent_id: None,
        agent_type: meta.0.clone(),
        description: meta.1.clone(),
        status: status.to_string(),
        started_at: stats.started_at.clone().unwrap_or_default(),
        turns: stats.turns(),
        tokens: stats.tokens,
        max_turns: max_turns(&meta.0),
        workflow_run: workflow_run_de(path),
        last_write_ms: ultima_escritura_ms(path),
        ended_at_ms: 0,
    }
}

/// Lectura completa del directorio de subagentes (comando `sesiones_agents`).
pub fn scan(dir: &Path) -> Vec<AgentNode> {
    let mut out: Vec<AgentNode> = list_agent_files(dir)
        .into_iter()
        .map(|(id, path)| {
            let mut stats = AgentStats::default();
            if let Ok(text) = std::fs::read_to_string(&path) {
                for line in text.lines() {
                    if let Ok(v) = serde_json::from_str::<Value>(line) {
                        stats.feed(&v);
                    }
                }
            }
            node_from(&id, &read_meta(meta_dir(dir, &path), &id), &stats, &path)
        })
        .collect();
    out.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    out
}

/// Poda los agentes del puente: si hay más de `max`, quita los terminados
/// más antiguos (los que siguen en marcha no se tocan).
pub fn podar_vivos(live: &mut HashMap<String, AgentNode>, max: usize) {
    if live.len() <= max {
        return;
    }
    let mut terminados: Vec<(String, String)> = live
        .values()
        .filter(|n| n.status != "running")
        .map(|n| (n.started_at.clone(), n.agent_id.clone()))
        .collect();
    terminados.sort();
    let sobran = live.len() - max;
    for (_, id) in terminados.into_iter().take(sobran) {
        live.remove(&id);
    }
}

type CacheNodos = Mutex<HashMap<String, Vec<AgentNode>>>;

fn cache() -> &'static CacheNodos {
    static C: OnceLock<CacheNodos> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Nodos del disco de la sesión `id` según el seguidor.
pub fn guardar_nodos(id: &str, nodos: Vec<AgentNode>) {
    if let Ok(mut c) = cache().lock() {
        c.insert(id.to_string(), nodos);
    }
}

/// Nodos en caché de la sesión (vacío si el seguidor aún no la recorrió).
pub fn nodos_en_cache(id: &str) -> Vec<AgentNode> {
    cache()
        .lock()
        .ok()
        .and_then(|c| c.get(id).cloned())
        .unwrap_or_default()
}

pub fn olvidar_nodos(id: &str) {
    if let Ok(mut c) = cache().lock() {
        c.remove(id);
    }
}

/// true si el transcript se escribió después del fin que notificó el puente: el
/// agente se reanudó y ese `done` ya no vale. Un `error` del puente siempre manda.
fn reanudado_tras_el_fin(disco: &AgentNode, vivo: &AgentNode) -> bool {
    vivo.status == "done"
        && disco.status == "running"
        && disco.last_write_ms > vivo.ended_at_ms.saturating_add(MARGEN_FIN_MS)
}

/// Une los agentes del disco con los notificados por el puente. El puente
/// manda en el estado (lo sabe antes) salvo que el agente se haya reanudado, y
/// aporta los que aún no tienen fichero.
pub fn merge(disk: Vec<AgentNode>, live: &HashMap<String, AgentNode>) -> Vec<AgentNode> {
    let mut out = disk;
    for node in &mut out {
        if let Some(l) = live.get(&node.agent_id) {
            if l.status != "running" && !reanudado_tras_el_fin(node, l) {
                node.status = l.status.clone();
            }
            if node.parent_agent_id.is_none() {
                node.parent_agent_id = l.parent_agent_id.clone();
            }
            if node.max_turns.is_none() {
                node.max_turns = l.max_turns;
            }
        }
    }
    let known: HashSet<String> = out.iter().map(|n| n.agent_id.clone()).collect();
    let mut extra: Vec<AgentNode> = live
        .values()
        .filter(|l| !known.contains(&l.agent_id))
        .cloned()
        .collect();
    extra.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    out.extend(extra);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUB: &str = include_str!("fixtures/subagente.jsonl");

    #[test]
    fn estadisticas_de_subagente() {
        let mut st = AgentStats::default();
        for l in SUB.lines() {
            st.feed(&serde_json::from_str(l).expect("fixture válido"));
        }
        assert_eq!(st.turns(), 2);
        assert_eq!(st.tokens, 40 + 25);
        assert!(st.ended);
        assert_eq!(st.started_at.as_deref(), Some("2026-01-02T10:00:00.000Z"));
    }

    #[test]
    fn los_turnos_se_cuentan_aunque_los_ids_se_poden() {
        let mut st = AgentStats::default();
        let n = crate::sesiones::transcript::IDS_RECIENTES + 10;
        for i in 0..n {
            let v = serde_json::json!({"type":"assistant","message":{"id":format!("m{i}"),
                "usage":{"output_tokens":1}}});
            st.feed(&v);
            st.feed(&v);
        }
        assert_eq!(st.turns() as usize, n, "cada mensaje cuenta una vez");
        assert_eq!(st.tokens as usize, n);
    }

    fn nodo(id: &str, status: &str, started_at: &str) -> AgentNode {
        AgentNode {
            agent_id: id.into(),
            parent_agent_id: None,
            agent_type: "Explore".into(),
            description: String::new(),
            status: status.into(),
            started_at: started_at.into(),
            turns: 0,
            tokens: 0,
            max_turns: None,
            workflow_run: None,
            last_write_ms: 0,
            ended_at_ms: 0,
        }
    }

    #[test]
    fn un_agente_reanudado_tras_end_turn_sigue_vivo() {
        let fin = serde_json::json!({"type":"assistant",
            "message":{"id":"m1","stop_reason":"end_turn","usage":{"output_tokens":1}}});
        let mut st = AgentStats::default();
        st.feed(&fin);
        assert!(st.ended, "el último mensaje es el fin de turno");

        st.feed(&serde_json::json!({"type":"attachment"}));
        assert!(st.ended, "una línea ajena no reanuda");

        st.feed(&serde_json::json!({"type":"api-request"}));
        assert!(
            !st.ended,
            "una petición nueva tras el fin es una reanudación"
        );

        st.feed(&fin);
        st.feed(&serde_json::json!({"type":"user"}));
        assert!(!st.ended, "un mensaje nuevo tras el fin es una reanudación");
    }

    fn transcript_con_edad(dir: &Path, edad: Duration) -> PathBuf {
        std::fs::create_dir_all(dir).expect("dir");
        let path = dir.join("agent-a1.jsonl");
        let f = std::fs::File::create(&path).expect("transcript");
        f.set_modified(SystemTime::now() - edad).expect("mtime");
        path
    }

    #[test]
    fn un_transcript_callado_no_se_pinta_como_terminado() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let meta = ("Explore".to_string(), String::new());
        let viejo = transcript_con_edad(tmp.path(), STALE_AFTER + Duration::from_secs(60));

        let callado = node_from("a1", &meta, &AgentStats::default(), &viejo);
        assert_eq!(callado.status, "stale");

        let cerrado = AgentStats {
            ended: true,
            ..AgentStats::default()
        };
        assert_eq!(node_from("a1", &meta, &cerrado, &viejo).status, "done");

        let reciente = transcript_con_edad(&tmp.path().join("r"), Duration::from_secs(1));
        assert_eq!(
            node_from("a1", &meta, &AgentStats::default(), &reciente).status,
            "running"
        );
    }

    #[test]
    fn el_nodo_sabe_a_que_workflow_pertenece() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let meta = ("Explore".to_string(), String::new());
        let suelto = transcript_con_edad(tmp.path(), Duration::ZERO);
        assert_eq!(
            node_from("a1", &meta, &AgentStats::default(), &suelto).workflow_run,
            None
        );
        let en_run = transcript_con_edad(&tmp.path().join(WORKFLOWS).join("wf_1"), Duration::ZERO);
        assert_eq!(
            node_from("a1", &meta, &AgentStats::default(), &en_run)
                .workflow_run
                .as_deref(),
            Some("wf_1")
        );
    }

    #[test]
    fn un_done_del_puente_anterior_a_la_reanudacion_no_manda() {
        let mut disco = nodo("a1", "running", "1");
        disco.last_write_ms = 100_000;
        let live_con = |status: &str, ended_at_ms: u64| {
            let mut vivo = nodo("a1", status, "1");
            vivo.ended_at_ms = ended_at_ms;
            HashMap::from([("a1".to_string(), vivo)])
        };

        let reanudado = merge(vec![disco.clone()], &live_con("done", 1_000));
        assert_eq!(reanudado[0].status, "running");

        let recien_acabado = merge(vec![disco.clone()], &live_con("done", 99_000));
        assert_eq!(
            recien_acabado[0].status, "done",
            "dentro de la holgura manda el puente"
        );

        let con_error = merge(vec![disco], &live_con("error", 1_000));
        assert_eq!(con_error[0].status, "error", "un error siempre manda");
    }

    #[test]
    fn la_poda_de_vivos_quita_los_terminados_mas_antiguos() {
        let mut live: HashMap<String, AgentNode> = HashMap::new();
        for (id, st, t) in [
            ("a", "done", "1"),
            ("b", "running", "0"),
            ("c", "error", "2"),
            ("d", "done", "3"),
        ] {
            live.insert(id.into(), nodo(id, st, t));
        }
        podar_vivos(&mut live, 4);
        assert_eq!(live.len(), 4, "dentro del tope no se toca");
        podar_vivos(&mut live, 2);
        let mut quedan: Vec<&str> = live.keys().map(String::as_str).collect();
        quedan.sort_unstable();
        assert_eq!(
            quedan,
            ["b", "d"],
            "el que corre se queda aunque sea el más antiguo"
        );
        podar_vivos(&mut live, 0);
        assert_eq!(live.keys().collect::<Vec<_>>(), ["b"]);
    }

    #[test]
    fn la_cache_de_nodos_se_guarda_y_se_olvida() {
        let id = format!("cache-{}", uuid::Uuid::new_v4());
        assert!(nodos_en_cache(&id).is_empty());
        let n = AgentNode {
            agent_id: "a1".into(),
            parent_agent_id: None,
            agent_type: "Explore".into(),
            description: String::new(),
            status: "running".into(),
            started_at: "1".into(),
            turns: 0,
            tokens: 0,
            max_turns: None,
            workflow_run: None,
            last_write_ms: 0,
            ended_at_ms: 0,
        };
        guardar_nodos(&id, vec![n.clone()]);
        assert_eq!(nodos_en_cache(&id), vec![n]);
        olvidar_nodos(&id);
        assert!(nodos_en_cache(&id).is_empty());
    }

    #[test]
    fn max_turns_sale_del_frontmatter_del_agente() {
        let dir = tempfile::tempdir().expect("tempdir");
        let md = "---
name: impl
model: claude-opus-5-5
maxTurns: 200
---

maxTurns: 7
";
        std::fs::write(dir.path().join("impl.md"), md).expect("escribe");
        std::fs::write(
            dir.path().join("sin-tope.md"),
            "---
name: x
---
maxTurns: 9
",
        )
        .expect("escribe");
        std::fs::write(
            dir.path().join("sin-frontmatter.md"),
            "maxTurns: 5
",
        )
        .expect("escribe");
        assert_eq!(max_turns_en(dir.path(), "impl"), Some(200));
        assert_eq!(
            max_turns_en(dir.path(), "sin-tope"),
            None,
            "fuera del frontmatter no cuenta"
        );
        assert_eq!(max_turns_en(dir.path(), "sin-frontmatter"), None);
        assert_eq!(max_turns_en(dir.path(), "no-existe"), None);
    }

    #[test]
    fn max_turns_no_sale_del_directorio_de_agentes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dentro = dir.path().join("agents");
        std::fs::create_dir(&dentro).expect("crea");
        std::fs::write(
            dir.path().join("fuera.md"),
            "---
maxTurns: 3
---
",
        )
        .expect("escribe");
        assert_eq!(max_turns_en(&dentro, "../fuera"), None);
        assert_eq!(max_turns_en(&dentro, "plugin:fuera"), None);
    }

    #[test]
    fn merge_toma_el_tope_del_puente_si_el_disco_no_lo_tiene() {
        let mut d = nodo("a1", "running", "1");
        d.max_turns = None;
        let mut l = d.clone();
        l.max_turns = Some(120);
        let live = HashMap::from([("a1".to_string(), l)]);
        assert_eq!(merge(vec![d], &live)[0].max_turns, Some(120));
    }

    #[test]
    fn los_agentes_de_un_workflow_se_listan_y_se_resuelven() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sub = dir.path();
        std::fs::write(sub.join("agent-a1.jsonl"), "").expect("directo");
        let wf = sub.join(WORKFLOWS).join("wf_123-abc");
        std::fs::create_dir_all(&wf).expect("workflow");
        std::fs::write(wf.join("agent-b2.jsonl"), "").expect("jsonl");
        std::fs::write(
            wf.join("agent-b2.meta.json"),
            r#"{"agentType":"rust-engineer","description":"WP-PTY"}"#,
        )
        .expect("meta");

        let mut ids: Vec<String> = list_agent_files(sub)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["a1", "b2"]);
        assert_eq!(agent_file(sub, "b2"), wf.join("agent-b2.jsonl"));
        assert_eq!(agent_file(sub, "a1"), sub.join("agent-a1.jsonl"));
        // Sin fichero en ningún sitio: la ruta directa (el lector da página vacía).
        assert_eq!(agent_file(sub, "zz"), sub.join("agent-zz.jsonl"));

        let nodos = scan(sub);
        let b2 = nodos.iter().find(|n| n.agent_id == "b2").expect("b2");
        assert_eq!(b2.agent_type, "rust-engineer");
        assert_eq!(b2.description, "WP-PTY");
    }

    #[test]
    fn id_desde_nombre_de_fichero() {
        assert_eq!(
            agent_id_from_file(Path::new("x/agent-a1b2c3.jsonl")).as_deref(),
            Some("a1b2c3")
        );
        assert!(agent_id_from_file(Path::new("x/agent-a1b2c3.meta.json")).is_none());
    }

    #[test]
    fn merge_anade_vivos_y_respeta_estado_del_puente() {
        let disk = vec![AgentNode {
            agent_id: "a1".into(),
            parent_agent_id: None,
            agent_type: "Explore".into(),
            description: "d".into(),
            status: "running".into(),
            started_at: "1".into(),
            turns: 1,
            tokens: 1,
            max_turns: None,
            workflow_run: None,
            last_write_ms: 0,
            ended_at_ms: 0,
        }];
        let mut live = HashMap::new();
        let mut a1 = disk[0].clone();
        a1.status = "error".into();
        live.insert("a1".to_string(), a1);
        let mut a2 = disk[0].clone();
        a2.agent_id = "a2".into();
        live.insert("a2".to_string(), a2);
        let out = merge(disk, &live);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].status, "error");
        assert_eq!(out[1].agent_id, "a2");
    }
}
