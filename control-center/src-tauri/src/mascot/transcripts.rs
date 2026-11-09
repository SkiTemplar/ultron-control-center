// Mascota — builds en rojo leídos de los transcripts de Claude Code.
//
// Recorre ~/.claude/projects/<proyecto>/<sesión>.jsonl (los de Sessions y
// los de la CLI suelta) y lee solo los bytes nuevos de cada uno. Empareja
// cada tool_use Bash/PowerShell con un comando de build (build_detect.rs)
// con su tool_result: «Exit code N» con N ≠ 0 es un fallo.
//
// Regla de asentamiento: los agentes rompen y arreglan builds a mitad de
// turno, así que un fallo solo se vuelve aviso al CERRAR el turno
// (stop_reason «end_turn» o la línea system «turn_duration») si el último
// resultado de ese tipo en el turno es un fallo, o tras IDLE_SETTLE_MS sin
// actividad en el fichero. Un éxito posterior del mismo tipo lo retira
// («cleared»). Nada de avisos históricos: la primera vuelta anota la
// longitud de TODOS los .jsonl (también los viejos) y cada fichero se lee
// desde ahí; uno creado después de esa vuelta se lee desde el principio.
// Así una sesión antigua retomada no pierde las primeras líneas nuevas
// aunque llevara más de RECENT sin tocarse. El estado de un fichero sin
// actividad durante EVICT_MS se descarta (queda solo su longitud).
//
// Fuera a propósito: los subagentes (carpeta subagents/ y líneas
// isSidechain), porque un indicador de subagentes en Pupus está descartado
// y sería ruido. Codex no está cubierto.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::Value;

use super::alerts::RawAlert;
use super::build_detect::{build_kind, exit_code, summarize_failure};

/// Sin actividad en el fichero durante este tiempo, el turno se asienta.
pub const IDLE_SETTLE_MS: u64 = 120_000;
/// Solo se miran los ficheros tocados en este margen.
const RECENT: Duration = Duration::from_secs(15 * 60);
const MAX_PENDING: usize = 256;
/// Sin actividad durante este tiempo, se suelta el estado del fichero.
const EVICT_MS: u64 = 60 * 60 * 1000;
/// Tope de lectura por vuelta y fichero (un volcado enorme no bloquea).
const MAX_CHUNK: u64 = 4 * 1024 * 1024;

/// Último resultado de un tipo de build dentro del turno.
#[derive(Debug, Clone)]
struct Outcome {
    failed: bool,
    detail: String,
    cwd: String,
    session_id: Option<String>,
}

#[derive(Default)]
struct FileState {
    offset: u64,
    last_activity_ms: u64,
    /// tool_use_id → tipo de build.
    pending: HashMap<String, &'static str>,
    turn: HashMap<&'static str, Outcome>,
    /// Se está saltando una línea mayor que MAX_CHUNK hasta su '\n'.
    discarding: bool,
}

#[derive(Default)]
pub struct Tailer {
    files: HashMap<PathBuf, FileState>,
    /// Longitud conocida de los ficheros sin estado: la de la primera
    /// vuelta o la de un estado ya descartado. Se lee desde ahí.
    known: HashMap<PathBuf, u64>,
    /// Ya se hizo la primera vuelta: un fichero nuevo se lee desde 0.
    baselined: bool,
    /// (cwd, tipo) con un aviso de fallo vigente.
    alerted: HashSet<(String, &'static str)>,
}

fn is_subagent_path(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == "subagents")
}

/// Texto de un tool_result (cadena o lista de bloques de texto).
fn result_text(v: &Value) -> String {
    match v.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|i| i.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn content_items(line: &Value) -> &[Value] {
    line.pointer("/message/content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn is_end_of_turn(line: &Value) -> bool {
    let kind = line.get("type").and_then(Value::as_str);
    let stop = line.pointer("/message/stop_reason").and_then(Value::as_str);
    let subtype = line.get("subtype").and_then(Value::as_str);
    (kind == Some("assistant") && stop == Some("end_turn"))
        || (kind == Some("system") && subtype == Some("turn_duration"))
}

impl FileState {
    fn note_tool_uses(&mut self, line: &Value) {
        for item in content_items(line) {
            if item.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let name = item.get("name").and_then(Value::as_str).unwrap_or("");
            if !matches!(name, "Bash" | "PowerShell") {
                continue;
            }
            let cmd = item
                .pointer("/input/command")
                .and_then(Value::as_str)
                .unwrap_or("");
            let (Some(kind), Some(id)) = (build_kind(cmd), item.get("id").and_then(Value::as_str))
            else {
                continue;
            };
            if self.pending.len() >= MAX_PENDING {
                self.pending.clear();
            }
            self.pending.insert(id.to_string(), kind);
        }
    }

    fn note_results(&mut self, line: &Value) {
        let cwd = line
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let session_id = line
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string);
        for item in content_items(line) {
            let id = item
                .get("tool_use_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            let Some(kind) = self.pending.remove(id) else {
                continue;
            };
            let text = result_text(item);
            let is_error = item
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let failed = match (is_error, exit_code(&text)) {
                (false, _) => false,
                (true, Some(code)) if code != 0 => true,
                // Error sin código (cortado, bloqueado por un hook): no cuenta.
                _ => continue,
            };
            let code = exit_code(&text).unwrap_or(0);
            let detail = if failed {
                summarize_failure(&text, code)
            } else {
                String::new()
            };
            self.turn.insert(
                kind,
                Outcome {
                    failed,
                    detail,
                    cwd: cwd.clone(),
                    session_id: session_id.clone(),
                },
            );
        }
    }
}

impl Tailer {
    /// Cierra el turno de un fichero: avisos de fallo y retiradas.
    fn settle(&mut self, path: &Path) -> Vec<RawAlert> {
        let Some(st) = self.files.get_mut(path) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let mut turn: Vec<_> = st.turn.drain().collect();
        turn.sort_by_key(|(k, _)| *k);
        for (kind, o) in turn {
            let key = (o.cwd.clone(), kind);
            let emit = if o.failed {
                self.alerted.insert(key);
                true
            } else {
                self.alerted.remove(&key)
            };
            if emit {
                out.push(RawAlert {
                    source: "build",
                    failed: o.failed,
                    what: kind.to_string(),
                    detail: o.detail,
                    cwd: o.cwd,
                    session_id: o.session_id,
                });
            }
        }
        out
    }

    /// Procesa una línea JSONL de `path`.
    pub fn feed_line(&mut self, path: &Path, raw: &str, now_ms: u64) -> Vec<RawAlert> {
        let Ok(line) = serde_json::from_str::<Value>(raw) else {
            return Vec::new();
        };
        if line.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return Vec::new();
        }
        let st = self.files.entry(path.to_path_buf()).or_default();
        st.last_activity_ms = now_ms;
        match line.get("type").and_then(Value::as_str) {
            Some("assistant") => st.note_tool_uses(&line),
            Some("user") => st.note_results(&line),
            _ => {}
        }
        if is_end_of_turn(&line) {
            return self.settle(path);
        }
        Vec::new()
    }

    /// Desde dónde se lee un fichero sin estado: su longitud conocida; si no
    /// la hay, 0 tras la primera vuelta (fichero nuevo) o su final antes.
    fn first_offset(&mut self, path: &Path, len: u64) -> u64 {
        match self.known.remove(path) {
            Some(known) => known.min(len),
            None if self.baselined => 0,
            None => len,
        }
    }

    /// Lee los bytes nuevos de `path` (hasta el último salto de línea). Sin
    /// estado previo empieza donde dice `first_offset`.
    pub fn feed_file(&mut self, path: &Path, now_ms: u64) -> Vec<RawAlert> {
        if is_subagent_path(path) {
            return Vec::new();
        }
        let Ok(len) = std::fs::metadata(path).map(|m| m.len()) else {
            return Vec::new();
        };
        if !self.files.contains_key(path) {
            let offset = self.first_offset(path, len);
            let st = FileState {
                offset,
                last_activity_ms: now_ms,
                ..Default::default()
            };
            self.files.insert(path.to_path_buf(), st);
        }
        let Some(st) = self.files.get_mut(path) else {
            return Vec::new();
        };
        if len < st.offset {
            st.offset = len; // truncado o reescrito: se sigue desde el final
            st.discarding = false;
        }
        if len == st.offset {
            return Vec::new();
        }
        let (from, discarding) = (st.offset, st.discarding);
        let Some(buf) = read_chunk(path, from, len) else {
            return Vec::new();
        };
        let cut = cut_chunk(&buf, discarding, buf.len() as u64 == MAX_CHUNK);
        if let Some(st) = self.files.get_mut(path) {
            st.offset = from + cut.consumed;
            st.discarding = cut.discarding;
        }
        let text = String::from_utf8_lossy(&buf[cut.start..cut.end]).into_owned();
        text.lines()
            .flat_map(|l| self.feed_line(path, l, now_ms))
            .collect()
    }

    /// Asienta los turnos que llevan IDLE_SETTLE_MS sin actividad.
    pub fn settle_idle(&mut self, now_ms: u64) -> Vec<RawAlert> {
        let idle: Vec<PathBuf> = self
            .files
            .iter()
            .filter(|(_, st)| {
                !st.turn.is_empty() && now_ms.saturating_sub(st.last_activity_ms) >= IDLE_SETTLE_MS
            })
            .map(|(p, _)| p.clone())
            .collect();
        idle.iter().flat_map(|p| self.settle(p)).collect()
    }

    /// Descarta el estado de los ficheros sin actividad durante EVICT_MS
    /// (con el turno ya asentado) y conserva solo su longitud leída.
    fn evict_stale(&mut self, now_ms: u64) {
        let stale: Vec<PathBuf> = self
            .files
            .iter()
            .filter(|(_, st)| {
                st.turn.is_empty() && now_ms.saturating_sub(st.last_activity_ms) >= EVICT_MS
            })
            .map(|(p, _)| p.clone())
            .collect();
        for p in stale {
            if let Some(st) = self.files.remove(&p) {
                self.known.insert(p, st.offset);
            }
        }
    }

    /// Primera vuelta: anota la longitud de todos los .jsonl, recientes o no.
    fn baseline(&mut self, projects_dir: &Path) {
        for (path, len) in transcripts(projects_dir, None) {
            self.known.insert(path, len);
        }
        self.baselined = true;
    }

    /// Una vuelta completa sobre ~/.claude/projects.
    pub fn scan(&mut self, projects_dir: &Path, now_ms: u64) -> Vec<RawAlert> {
        if !self.baselined {
            self.baseline(projects_dir);
        }
        let mut out = Vec::new();
        for (path, _) in transcripts(projects_dir, Some(RECENT)) {
            out.extend(self.feed_file(&path, now_ms));
        }
        out.extend(self.settle_idle(now_ms));
        self.evict_stale(now_ms);
        out
    }
}

/// Lee de `from` a `len`, como mucho MAX_CHUNK bytes.
fn read_chunk(path: &Path, from: u64, len: u64) -> Option<Vec<u8>> {
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::new();
    f.take((len - from).min(MAX_CHUNK))
        .read_to_end(&mut buf)
        .ok()?;
    Some(buf)
}

/// Recorte de un bloque leído: `buf[start..end]` son líneas completas y
/// `consumed` es lo que avanza el offset.
#[derive(Debug, PartialEq)]
struct Cut {
    start: usize,
    end: usize,
    consumed: u64,
    discarding: bool,
}

/// Se queda hasta el último '\n' (una línea a medio escribir se lee en la
/// vuelta siguiente). Si se venía saltando una línea enorme, descarta hasta
/// su '\n'. Un bloque lleno (`full`) sin ningún '\n' es una línea mayor que
/// MAX_CHUNK: se consume entero y se sigue saltando, porque si no el offset
/// no avanzaría nunca y el resto del transcript quedaría sin leer.
fn cut_chunk(buf: &[u8], discarding: bool, full: bool) -> Cut {
    let all = buf.len() as u64;
    let start = match (discarding, buf.iter().position(|b| *b == b'\n')) {
        (false, _) => 0,
        (true, Some(i)) => i + 1,
        (true, None) => {
            return Cut {
                start: 0,
                end: 0,
                consumed: all,
                discarding: true,
            }
        }
    };
    match buf[start..].iter().rposition(|b| *b == b'\n') {
        Some(j) => Cut {
            start,
            end: start + j + 1,
            consumed: (start + j + 1) as u64,
            discarding: false,
        },
        None if full && start == 0 => Cut {
            start: 0,
            end: 0,
            consumed: all,
            discarding: true,
        },
        None => Cut {
            start,
            end: start,
            consumed: start as u64,
            discarding: false,
        },
    }
}

/// (ruta, longitud) de <proyecto>/*.jsonl; con `recent`, solo los tocados
/// en ese margen (no baja a subagents/).
fn transcripts(projects_dir: &Path, recent: Option<Duration>) -> Vec<(PathBuf, u64)> {
    let Ok(projects) = std::fs::read_dir(projects_dir) else {
        return Vec::new();
    };
    let now = SystemTime::now();
    projects
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| std::fs::read_dir(e.path()).ok())
        .flat_map(|dir| dir.flatten())
        .filter(|f| f.path().extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|f| {
            let meta = f.metadata().ok()?;
            let fresh = match recent {
                None => true,
                Some(r) => meta
                    .modified()
                    .is_ok_and(|t| now.duration_since(t).unwrap_or_default() < r),
            };
            fresh.then(|| (f.path(), meta.len()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const FIXTURE: &str = include_str!("fixtures/transcript-build.jsonl");

    fn tool_use(id: &str, cmd: &str) -> String {
        serde_json::json!({"type":"assistant","isSidechain":false,"message":{"content":[
            {"type":"tool_use","id":id,"name":"Bash","input":{"command":cmd}}]}})
        .to_string()
    }

    fn tool_result(id: &str, error: bool, text: &str) -> String {
        serde_json::json!({"type":"user","cwd":"C:\\demo\\Proyecto","sessionId":"s-1","message":{"content":[
            {"type":"tool_result","tool_use_id":id,"is_error":error,"content":text}]}})
        .to_string()
    }

    fn end_turn() -> String {
        serde_json::json!({"type":"assistant","message":{"stop_reason":"end_turn","content":[]}})
            .to_string()
    }

    fn feed(t: &mut Tailer, lines: &[String], now: u64) -> Vec<RawAlert> {
        let p = Path::new("C:/x/p/s.jsonl");
        lines.iter().flat_map(|l| t.feed_line(p, l, now)).collect()
    }

    #[test]
    fn un_fallo_al_cerrar_el_turno_da_un_aviso() {
        let mut t = Tailer::default();
        let p = Path::new("C:/x/p/s.jsonl");
        let out: Vec<_> = FIXTURE.lines().flat_map(|l| t.feed_line(p, l, 0)).collect();
        assert_eq!(out.len(), 1);
        assert!(out[0].failed);
        assert_eq!(out[0].what, "cargo check");
        assert_eq!(out[0].detail, "error[E0308]: mismatched types");
        assert_eq!(out[0].cwd, "C:\\demo\\Proyecto");
        assert_eq!(out[0].session_id.as_deref(), Some("s-1"));
    }

    #[test]
    fn un_fallo_arreglado_en_el_mismo_turno_no_avisa() {
        let mut t = Tailer::default();
        let lines = [
            tool_use("a", "cargo check"),
            tool_result("a", true, "Exit code 101\nerror[E0308]: x"),
            tool_use("b", "cargo check"),
            tool_result("b", false, "Finished"),
            end_turn(),
        ];
        assert!(feed(&mut t, &lines, 0).is_empty());
    }

    #[test]
    fn sin_fin_de_turno_espera_a_la_inactividad() {
        let mut t = Tailer::default();
        let lines = [
            tool_use("a", "npx tsc --noEmit"),
            tool_result("a", true, "Exit code 2\nx.ts(1,1): error TS1005: ';'"),
        ];
        assert!(feed(&mut t, &lines, 1_000).is_empty());
        assert!(
            t.settle_idle(1_000 + IDLE_SETTLE_MS - 1).is_empty(),
            "aún no"
        );
        let out = t.settle_idle(1_000 + IDLE_SETTLE_MS);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].what, "tsc");
    }

    #[test]
    fn un_exito_posterior_retira_el_aviso() {
        let mut t = Tailer::default();
        feed(
            &mut t,
            &[
                tool_use("a", "cargo test"),
                tool_result("a", true, "Exit code 101"),
                end_turn(),
            ],
            0,
        );
        let out = feed(
            &mut t,
            &[
                tool_use("b", "cargo test"),
                tool_result("b", false, "ok"),
                end_turn(),
            ],
            5,
        );
        assert_eq!(out.len(), 1);
        assert!(!out[0].failed, "cleared");
        // Un segundo éxito ya no emite nada.
        let again = feed(
            &mut t,
            &[
                tool_use("c", "cargo test"),
                tool_result("c", false, "ok"),
                end_turn(),
            ],
            9,
        );
        assert!(again.is_empty());
    }

    #[test]
    fn las_lineas_de_subagente_y_los_comandos_normales_no_cuentan() {
        let mut t = Tailer::default();
        let side = serde_json::json!({"type":"assistant","isSidechain":true,"message":{"content":[
            {"type":"tool_use","id":"a","name":"Bash","input":{"command":"cargo build"}}]}})
        .to_string();
        let lines = [
            side,
            tool_result("a", true, "Exit code 1"),
            tool_use("b", "git status"),
            tool_result("b", true, "Exit code 1"),
            end_turn(),
        ];
        assert!(feed(&mut t, &lines, 0).is_empty());
    }

    #[test]
    fn la_primera_lectura_empieza_al_final_y_luego_lee_lo_nuevo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(&path, FIXTURE).unwrap();
        let mut t = Tailer::default();
        assert!(t.feed_file(&path, 0).is_empty(), "nada histórico");
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(FIXTURE.as_bytes()).unwrap();
        assert_eq!(t.feed_file(&path, 1).len(), 1);
    }

    /// Proyecto con un transcript que lleva más de RECENT sin tocarse.
    fn old_transcript(dir: &Path) -> PathBuf {
        let proj = dir.join("C--demo-Proyecto");
        std::fs::create_dir_all(&proj).unwrap();
        let path = proj.join("vieja.jsonl");
        std::fs::write(&path, FIXTURE).unwrap();
        let old = SystemTime::now() - RECENT - Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old)
            .unwrap();
        path
    }

    fn append_fixture(path: &Path) {
        let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        f.write_all(FIXTURE.as_bytes()).unwrap();
    }

    #[test]
    fn una_sesion_vieja_retomada_avisa_de_su_primer_fallo() {
        let dir = tempfile::tempdir().unwrap();
        let path = old_transcript(dir.path());
        let mut t = Tailer::default();
        assert!(t.scan(dir.path(), 0).is_empty(), "nada histórico");
        // Se retoma: las líneas nuevas traen el tool_use del build roto.
        append_fixture(&path);
        let out = t.scan(dir.path(), 1);
        assert_eq!(out.len(), 1, "{out:?}");
        assert!(out[0].failed);
    }

    #[test]
    fn un_fichero_creado_tras_la_primera_vuelta_se_lee_entero() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = Tailer::default();
        assert!(t.scan(dir.path(), 0).is_empty());
        let proj = dir.path().join("C--demo-Nuevo");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("nueva.jsonl"), FIXTURE).unwrap();
        assert_eq!(t.scan(dir.path(), 1).len(), 1);
    }

    #[test]
    fn el_estado_inactivo_se_descarta_y_se_retoma_donde_iba() {
        let dir = tempfile::tempdir().unwrap();
        let path = old_transcript(dir.path());
        let mut t = Tailer::default();
        t.feed_file(&path, 0);
        t.evict_stale(EVICT_MS - 1);
        assert_eq!(t.files.len(), 1, "aún no");
        t.evict_stale(EVICT_MS);
        assert!(t.files.is_empty(), "descartado");
        // Retomado más tarde: sigue desde su longitud, sin histórico.
        append_fixture(&path);
        assert_eq!(t.feed_file(&path, EVICT_MS + 1).len(), 1);
    }

    #[test]
    fn el_recorte_salta_una_linea_mayor_que_el_bloque() {
        // Bloque lleno sin '\n': se consume entero y se sigue saltando.
        assert_eq!(
            cut_chunk(b"xxxx", false, true),
            Cut {
                start: 0,
                end: 0,
                consumed: 4,
                discarding: true
            }
        );
        // Bloque a medias sin '\n': línea en curso, se espera.
        assert_eq!(
            cut_chunk(b"xxxx", false, false),
            Cut {
                start: 0,
                end: 0,
                consumed: 0,
                discarding: false
            }
        );
        // Saltando: se descarta hasta el '\n' y se lee lo que sigue.
        assert_eq!(
            cut_chunk(b"xx\nab\ncd", true, true),
            Cut {
                start: 3,
                end: 6,
                consumed: 6,
                discarding: false
            }
        );
        // Saltando y sin '\n': todo descartado.
        assert_eq!(
            cut_chunk(b"xxxx", true, false),
            Cut {
                start: 0,
                end: 0,
                consumed: 4,
                discarding: true
            }
        );
    }

    #[test]
    fn una_linea_mayor_que_max_chunk_no_atasca_el_fichero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(&path, "").unwrap();
        let mut t = Tailer::default();
        assert!(t.feed_file(&path, 0).is_empty());
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        let huge = vec![b'x'; usize::try_from(MAX_CHUNK).unwrap() + 100];
        f.write_all(&huge).unwrap();
        f.write_all(b"\n").unwrap();
        f.write_all(FIXTURE.as_bytes()).unwrap();
        let out: Vec<_> = (1..=3).flat_map(|n| t.feed_file(&path, n)).collect();
        assert_eq!(out.len(), 1, "el build roto tras la línea enorme avisa");
        assert!(!t.files[&path].discarding);
    }

    #[test]
    fn una_ruta_de_subagents_se_ignora() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sesion").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        let path = sub.join("agent-1.jsonl");
        std::fs::write(&path, "").unwrap();
        let mut t = Tailer::default();
        t.feed_file(&path, 0);
        std::fs::write(&path, FIXTURE).unwrap();
        assert!(t.feed_file(&path, 1).is_empty());
    }
}
