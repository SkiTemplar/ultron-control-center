// ULTRON Control Center — Session auto-tag engine.
//
// Persists a simple JSONL store at
//   ~/.ultron/cockpit/sessions-tags.jsonl
// Each line is one TagEntry. The only Tauri command is
//
//   sessions_bulk_auto_tag(requests)
//       — tags sessions in a loop («Etiquetar todo») on the blocking pool and
//         returns one AutoTagOutcome (tagged / skipped / failed + cause) per
//         request.
//
// Nothing reads the store back into the UI yet: tags are written, not shown.
// The AI call uses the "summarize" zone (Groq free tier, Gemini fallback); a
// router failure is reported per session instead of being hidden.
//
// Schema (sessions-tags.jsonl):
//   { "session_id": "<uuid>", "tags": ["rust", "tauri", "ui-redesign"],
//     "generated_at": "2026-05-27T10:00:00Z" }

use std::fs;
use std::io::{BufRead, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::ultron_root;

// ---------------------------------------------------------------------------
// Process-wide write lock
// ---------------------------------------------------------------------------
//
// `upsert_tag` does a load-all → filter → push → full-rewrite. Without a lock,
// two concurrent callers (e.g. `sessions_bulk_auto_tag` looping while a
// background auto-tag fires) both read the same baseline and the second writer
// clobbers the first writer's addition — entries vanish silently. The lock is
// held across the whole read-modify-write so it is atomic from the caller's
// point of view. Pure reads
// (`sessions_tags_load`) are excluded.
static SESSIONS_TAGS_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn sessions_tags_lock() -> &'static Mutex<()> {
    SESSIONS_TAGS_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

/// Upper bound on a session_id. UUIDs are 36 chars; anything beyond this is a
/// malformed/hostile frontend input and is rejected before it can fill disk.
const MAX_SESSION_ID_LEN: usize = 256;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagEntry {
    pub session_id: String,
    pub tags: Vec<String>,
    pub generated_at: String,
    /// Project slug this session belongs to, derived from its cwd
    /// (card-vis-auto-tag-cwd, sessions-tags schema v2). Optional +
    /// skip-when-none so old entries (schema v1) read and re-serialise
    /// unchanged — the backward-compatible half of the v2.14 schema change
    /// declared in `migration.rs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

/// Minimal descriptor passed from the frontend when requesting auto-tagging
/// for a batch of sessions. The frontend already knows the first_prompt from
/// the `ClaudeSession.preview` field — we reuse it to avoid a second disk
/// scan in the backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoTagRequest {
    pub session_id: String,
    pub first_prompt: Option<String>,
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

fn tags_path() -> Result<PathBuf, String> {
    let dir = ultron_root()?.join("cockpit");
    fs::create_dir_all(&dir).map_err(|e| format!("create cockpit dir: {}", e))?;
    Ok(dir.join("sessions-tags.jsonl"))
}

/// Read all entries from a specific JSONL path. Path-parameterised so the
/// read-modify-write logic can be exercised against a temp file in tests
/// without touching the real `~/.ultron/cockpit/sessions-tags.jsonl`.
fn load_tags_at(path: &Path) -> Result<Vec<TagEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = fs::File::open(path).map_err(|e| format!("open sessions-tags.jsonl: {}", e))?;
    let reader = std::io::BufReader::new(file);
    let mut out = Vec::new();
    for line in reader.lines() {
        let l = line.map_err(|e| format!("read line: {}", e))?;
        if l.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<TagEntry>(&l) {
            Ok(entry) => out.push(entry),
            Err(_) => {
                // Malformed line — skip silently (resilience > crash).
            }
        }
    }
    Ok(out)
}

/// Append or upsert a tag entry. If a record with the same session_id already
/// exists it is removed from the in-memory set and the updated version is
/// appended at the end (JSONL append-only with in-memory upsert).
fn upsert_tag(entry: TagEntry) -> Result<(), String> {
    let path = tags_path()?;
    upsert_tag_at(&path, entry)
}

/// Lock-guarded read-modify-write against a specific path. The
/// `SESSIONS_TAGS_WRITE_LOCK` is held across the whole load → filter → push →
/// write so concurrent callers cannot interleave and lose entries. Writes go
/// to a temp file then `rename` over the target so a crash mid-write never
/// leaves a truncated store (atomic-replace, same as kanban/kg/decisions).
fn upsert_tag_at(path: &Path, entry: TagEntry) -> Result<(), String> {
    // Reject pathological session_id (unvalidated frontend input) before any
    // lock or disk work — guards against a disk-fill DoS via a giant id.
    if entry.session_id.len() > MAX_SESSION_ID_LEN {
        return Err(format!(
            "session_id too long: {} > {}",
            entry.session_id.len(),
            MAX_SESSION_ID_LEN
        ));
    }
    let _guard = sessions_tags_lock()
        .lock()
        .map_err(|e| format!("sessions-tags lock poisoned: {}", e))?;

    // Load existing, filter out old record for this session. A read error
    // aborts: rewriting from an empty baseline would wipe the whole store.
    let mut existing = load_tags_at(path)?;
    existing.retain(|e| e.session_id != entry.session_id);
    existing.push(entry);

    // Serialise to a temp sibling, then atomically rename over the target.
    // File is small (one entry per session) so a full rewrite is fine.
    // SAFETY: tmp lives next to the target (same dir => same volume), so the
    // rename below is an atomic replace on Windows (MoveFileEx). Moving tmp to
    // another volume would degrade to copy+delete = non-atomic.
    let tmp = path.with_extension("jsonl.tmp");
    {
        let file =
            fs::File::create(&tmp).map_err(|e| format!("create sessions-tags tmp: {}", e))?;
        let mut writer = BufWriter::new(file);
        for e in &existing {
            let line =
                serde_json::to_string(e).map_err(|e| format!("serialize tag entry: {}", e))?;
            writeln!(writer, "{}", line).map_err(|e| format!("write sessions-tags tmp: {}", e))?;
        }
        writer
            .flush()
            .map_err(|e| format!("flush sessions-tags tmp: {}", e))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("rename sessions-tags.jsonl: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// ISO timestamp without external deps (mirrors the helper in claude_sessions.rs)
// ---------------------------------------------------------------------------

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Re-use the format_iso logic inline rather than exposing it from
    // claude_sessions (it's pub(crate) there but we keep this self-contained).
    let mut days = (secs / 86_400) as i64;
    let secs_in_day = (secs % 86_400) as u32;
    let h = secs_in_day / 3600;
    let m = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;
    let mut year = 1970i32;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let yd: i64 = if leap { 366 } else { 365 };
        if days < yd {
            break;
        }
        days -= yd;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mdays: [i64; 12] = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] {
        days -= mdays[month];
        month += 1;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month + 1,
        days + 1,
        h,
        m,
        s
    )
}

// ---------------------------------------------------------------------------
// AI tag generation
// ---------------------------------------------------------------------------

const TAG_SYSTEM_PROMPT: &str = "\
You are a session tagger. Given a brief description of an AI coding session, \
generate 3-5 short descriptive tags in kebab-case (e.g. \"rust-backend\", \
\"ui-redesign\", \"auth-bugfix\"). Output ONLY a JSON array of strings, \
nothing else. Example: [\"tauri-backend\",\"file-io\",\"sessions-redesign\"]";

fn parse_tags_from_response(response: &str) -> Vec<String> {
    // Attempt to parse as JSON array directly.
    let trimmed = response.trim();
    if let Ok(tags) = serde_json::from_str::<Vec<String>>(trimmed) {
        return tags
            .into_iter()
            .map(|t| t.trim().to_lowercase().replace(' ', "-"))
            .filter(|t| !t.is_empty())
            .take(5)
            .collect();
    }
    // Fallback: extract anything between brackets.
    if let Some(start) = trimmed.find('[') {
        if let Some(end) = trimmed.rfind(']') {
            let slice = &trimmed[start..=end];
            if let Ok(tags) = serde_json::from_str::<Vec<String>>(slice) {
                return tags
                    .into_iter()
                    .map(|t| t.trim().to_lowercase().replace(' ', "-"))
                    .filter(|t| !t.is_empty())
                    .take(5)
                    .collect();
            }
        }
    }
    Vec::new()
}

/// Tope del primer mensaje que sale al proveedor. Debe coincidir con
/// `AUTO_TAG_MAX_CHARS` de `src/components/Sessions.tsx`, que lo anuncia en la
/// confirmación.
const MAX_TAG_PROMPT_CHARS: usize = 400;

/// Primer mensaje tal como sale a Groq/Gemini (seguridad MEDIUM de la auditoría
/// 2026-10-17): recortado a `MAX_TAG_PROMPT_CHARS`, sin secretos y sin el nombre
/// de la cuenta en las rutas. Se redacta antes de recortar: recortar primero
/// podría dejar medio secreto por debajo del largo mínimo que reconoce el
/// detector y enviarlo en claro.
fn outbound_first_message(text: &str) -> String {
    crate::memory::redaction::redact_outbound(text)
        .chars()
        .take(MAX_TAG_PROMPT_CHARS)
        .collect()
}

/// Generate tags for a single session. An empty first prompt yields
/// `Ok(None)` (nothing to tag); a router failure comes back as `Err` with its
/// cause so the caller reports it instead of faking "no tags".
fn generate_tags(
    session_id: &str,
    first_prompt: Option<&str>,
) -> Result<Option<Vec<String>>, String> {
    let prompt_text = first_prompt.unwrap_or("").trim();
    if prompt_text.is_empty() {
        return Ok(None);
    }

    // Build a compact prompt for the AI — we don't send the whole transcript,
    // just the first human message which is the most descriptive signal.
    let user_prompt = format!(
        "Session ID: {}\nFirst user message: {}",
        session_id,
        outbound_first_message(prompt_text)
    );

    // `route()` does not take a separate system prompt and the summarize zone
    // has none, so ours goes inline as the only instruction.
    let full_prompt = format!("{}\n\n{}", TAG_SYSTEM_PROMPT, user_prompt);

    // "summarize" zone uses Groq (free) → Gemini fallback.
    crate::ai_router::route("summarize", &full_prompt)
        .map(|response| Some(parse_tags_from_response(&response)))
}

// ---------------------------------------------------------------------------
// Bulk tagging core (generic over its two side effects so it is testable)
// ---------------------------------------------------------------------------

/// Result of tagging one session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AutoTagStatus {
    /// Tags generated and persisted.
    Tagged,
    /// No first prompt to tag from: nothing was sent nor written.
    Skipped,
    /// The router or the write to `sessions-tags.jsonl` failed; see `error`.
    Failed,
}

/// Per-session outcome returned to the UI, in request order.
#[derive(Debug, Clone, Serialize)]
pub struct AutoTagOutcome {
    pub session_id: String,
    pub status: AutoTagStatus,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AutoTagOutcome {
    fn new(
        session_id: String,
        status: AutoTagStatus,
        tags: Vec<String>,
        error: Option<String>,
    ) -> Self {
        Self {
            session_id,
            status,
            tags,
            error,
        }
    }
}

/// Tag one request: generate, then persist. Every failure is reported with
/// its cause instead of being turned into an empty tag list.
fn tag_one<G, P>(req: AutoTagRequest, generate: &G, persist: &P) -> AutoTagOutcome
where
    G: Fn(&str, Option<&str>) -> Result<Option<Vec<String>>, String>,
    P: Fn(TagEntry) -> Result<(), String>,
{
    let id = req.session_id;
    let tags = match generate(&id, req.first_prompt.as_deref()) {
        Ok(Some(tags)) => tags,
        Ok(None) => return AutoTagOutcome::new(id, AutoTagStatus::Skipped, Vec::new(), None),
        Err(e) => {
            let cause = Some(format!("router: {e}"));
            return AutoTagOutcome::new(id, AutoTagStatus::Failed, Vec::new(), cause);
        }
    };
    let entry = TagEntry {
        session_id: id.clone(),
        tags: tags.clone(),
        generated_at: now_iso(),
        project: None,
    };
    match persist(entry) {
        Ok(()) => AutoTagOutcome::new(id, AutoTagStatus::Tagged, tags, None),
        Err(e) => {
            let cause = Some(format!("guardar: {e}"));
            AutoTagOutcome::new(id, AutoTagStatus::Failed, tags, cause)
        }
    }
}

/// Sequential batch (no parallelism, to avoid hammering the provider). One
/// failure never aborts the batch; it is reported in its own outcome.
fn tag_batch<G, P>(requests: Vec<AutoTagRequest>, generate: G, persist: P) -> Vec<AutoTagOutcome>
where
    G: Fn(&str, Option<&str>) -> Result<Option<Vec<String>>, String>,
    P: Fn(TagEntry) -> Result<(), String>,
{
    requests
        .into_iter()
        .map(|req| tag_one(req, &generate, &persist))
        .collect()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Bulk auto-tag («Etiquetar todo»). Up to one blocking `route()` per session
/// (HTTP with a 10 s cap per attempt), so it runs on the blocking pool and
/// never on the main thread that pumps the window. One outcome per request.
#[tauri::command]
pub async fn sessions_bulk_auto_tag(
    requests: Vec<AutoTagRequest>,
) -> Result<Vec<AutoTagOutcome>, String> {
    tauri::async_runtime::spawn_blocking(move || tag_batch(requests, generate_tags, upsert_tag))
        .await
        .map_err(|e| format!("sessions_bulk_auto_tag: la tarea de fondo falló: {e}"))
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primer_mensaje_saliente_recortado_y_redactado() {
        let token = format!("ghp_{}", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
        let text = format!(
            "arregla C:\\Users\\cuenta\\app con {token} {}",
            "x".repeat(1_000)
        );
        let out = outbound_first_message(&text);
        assert_eq!(out.chars().count(), MAX_TAG_PROMPT_CHARS);
        assert!(!out.contains("cuenta"), "la cuenta no sale: {out}");
        assert!(!out.contains(&token), "el token no sale: {out}");
        assert!(out.starts_with("arregla ~\\app con [REDACTED:"));
        // Caso negativo: un texto corto y limpio sale igual.
        assert_eq!(outbound_first_message("revisa el login"), "revisa el login");
    }

    #[test]
    fn primer_mensaje_saliente_no_deja_medio_secreto_en_el_corte() {
        let token = format!("ghp_{}", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
        // El token cruza el tope: redactar antes de recortar evita mandar su prefijo.
        let text = format!("{}{token}", "a ".repeat((MAX_TAG_PROMPT_CHARS - 10) / 2));
        let out = outbound_first_message(&text);
        assert!(
            !out.contains("ghp_ABCD"),
            "no sale ningún trozo del token: {out}"
        );
    }

    #[test]
    fn parse_tags_clean_json_array() {
        let input = r#"["rust-backend","tauri","ui-redesign"]"#;
        let tags = parse_tags_from_response(input);
        assert_eq!(tags, vec!["rust-backend", "tauri", "ui-redesign"]);
    }

    #[test]
    fn parse_tags_with_surrounding_text() {
        let input = r#"Here are the tags: ["auth-bugfix","sessions","api-design"] done."#;
        let tags = parse_tags_from_response(input);
        assert_eq!(tags, vec!["auth-bugfix", "sessions", "api-design"]);
    }

    #[test]
    fn parse_tags_empty_prompt_returns_empty() {
        let input = "[]";
        let tags = parse_tags_from_response(input);
        assert!(tags.is_empty());
    }

    #[test]
    fn parse_tags_normalises_spaces_to_dashes() {
        let input = r#"["rust backend","UI redesign"]"#;
        let tags = parse_tags_from_response(input);
        assert_eq!(tags, vec!["rust-backend", "ui-redesign"]);
    }

    #[test]
    fn parse_tags_caps_at_five() {
        let input = r#"["a","b","c","d","e","f","g"]"#;
        let tags = parse_tags_from_response(input);
        assert_eq!(tags.len(), 5);
    }

    #[test]
    fn now_iso_looks_like_iso8601() {
        let ts = now_iso();
        // Minimal shape check: YYYY-MM-DDTHH:MM:SSZ
        assert_eq!(ts.len(), 20);
        assert!(ts.ends_with('Z'));
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[7..8], "-");
        assert_eq!(&ts[10..11], "T");
    }

    // ---- bulk outcome (calidad-rust-1 de la auditoría 2026-10-23) ---------

    fn req(id: &str, prompt: Option<&str>) -> AutoTagRequest {
        AutoTagRequest {
            session_id: id.to_string(),
            first_prompt: prompt.map(str::to_string),
        }
    }

    #[test]
    fn bulk_reporta_fallo_del_router_con_su_causa() {
        let generate = |id: &str, _: Option<&str>| match id {
            "ok" => Ok(Some(vec!["rust".to_string()])),
            "vacia" => Ok(None),
            _ => Err("groq: 429; gemini: sin clave".to_string()),
        };
        let reqs = vec![
            req("ok", Some("a")),
            req("mal", Some("b")),
            req("vacia", None),
        ];
        let out = tag_batch(reqs, generate, |_| Ok(()));

        let ids: Vec<&str> = out.iter().map(|o| o.session_id.as_str()).collect();
        assert_eq!(ids, ["ok", "mal", "vacia"], "conserva el orden");
        assert_eq!(out[0].status, AutoTagStatus::Tagged);
        assert_eq!(out[0].tags, ["rust"]);
        // Caso negativo: antes un Err del router salía como «sin etiquetas».
        assert_eq!(out[1].status, AutoTagStatus::Failed);
        assert!(out[1].error.as_deref().unwrap().contains("429"));
        assert_eq!(out[2].status, AutoTagStatus::Skipped);
        assert!(out[2].error.is_none());
    }

    #[test]
    fn bulk_reporta_fallo_al_guardar() {
        let generate = |_: &str, _: Option<&str>| Ok(Some(vec!["ui".to_string()]));
        let out = tag_batch(vec![req("s", Some("x"))], generate, |_| {
            Err("disco lleno".to_string())
        });
        assert_eq!(out[0].status, AutoTagStatus::Failed);
        assert!(out[0].error.as_deref().unwrap().contains("disco lleno"));
    }

    #[test]
    fn generate_tags_sin_texto_no_llama_al_router() {
        assert_eq!(generate_tags("s", None), Ok(None));
        assert_eq!(generate_tags("s", Some("   ")), Ok(None));
    }

    #[test]
    fn outcome_serializa_estado_en_minusculas() {
        let o = AutoTagOutcome::new("s".into(), AutoTagStatus::Failed, vec![], Some("x".into()));
        let v = serde_json::to_value(&o).unwrap();
        assert_eq!(v["status"], "failed");
        let ok = AutoTagOutcome::new("s".into(), AutoTagStatus::Tagged, vec![], None);
        assert!(serde_json::to_value(&ok).unwrap().get("error").is_none());
    }

    #[test]
    fn upsert_no_vacia_el_almacen_si_no_se_puede_leer() {
        let path = unique_temp_tags_path();
        let good = r#"{"session_id":"a","tags":["x"],"generated_at":"2026-01-01T00:00:00Z"}"#;
        let mut bytes = format!("{good}\n").into_bytes();
        bytes.extend_from_slice(&[0xff, 0xfe, b'\n']); // UTF-8 inválido: read_line falla
        fs::write(&path, &bytes).unwrap();

        let entry = TagEntry {
            session_id: "b".into(),
            tags: vec![],
            generated_at: now_iso(),
            project: None,
        };
        // Caso negativo: antes la lectura fallida se tomaba como almacén vacío
        // y la reescritura borraba la entrada «a».
        assert!(upsert_tag_at(&path, entry).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes, "el almacén queda intacto");
        let _ = fs::remove_file(&path);
    }

    // ---- write-lock / concurrency (card-data-sessions-tags-write-lock) -----

    /// Unique temp path per test invocation so parallel `cargo test` runs do
    /// not collide and the real cockpit store is never touched.
    fn unique_temp_tags_path() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "ultron_sessions_tags_test_{}_{}.jsonl",
            std::process::id(),
            n
        ))
    }

    #[test]
    fn upsert_tag_at_roundtrips_and_upserts_same_session() {
        let path = unique_temp_tags_path();
        let _ = fs::remove_file(&path);

        let mk = |id: &str, tag: &str| TagEntry {
            session_id: id.to_string(),
            tags: vec![tag.to_string()],
            generated_at: "2026-05-29T00:00:00Z".to_string(),
            project: None,
        };

        upsert_tag_at(&path, mk("s1", "alpha")).unwrap();
        upsert_tag_at(&path, mk("s2", "beta")).unwrap();
        // Re-tag s1 — should replace, not duplicate.
        upsert_tag_at(&path, mk("s1", "gamma")).unwrap();

        let all = load_tags_at(&path).unwrap();
        assert_eq!(
            all.len(),
            2,
            "upsert must not duplicate the same session_id"
        );
        let s1 = all.iter().find(|e| e.session_id == "s1").unwrap();
        assert_eq!(
            s1.tags,
            vec!["gamma"],
            "upsert must overwrite previous tags"
        );

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn schema_v1_without_project_reads_none_and_v2_preserved() {
        let path = unique_temp_tags_path();
        let _ = fs::remove_file(&path);
        let v1 = r#"{"session_id":"old","tags":["a"],"generated_at":"2026-01-01T00:00:00Z"}"#;
        let v2 = r#"{"session_id":"new","tags":["b"],"generated_at":"2026-05-29T00:00:00Z","project":"ultron"}"#;
        fs::write(&path, format!("{v1}\n{v2}\n")).unwrap();

        let all = load_tags_at(&path).unwrap();
        assert_eq!(all.len(), 2);
        let old = all.iter().find(|e| e.session_id == "old").unwrap();
        assert_eq!(old.project, None, "v1 entry (no project) -> None");
        let new = all.iter().find(|e| e.session_id == "new").unwrap();
        assert_eq!(
            new.project.as_deref(),
            Some("ultron"),
            "v2 project preserved"
        );
        // None must be skipped on re-serialise so a rollback to a v1 reader
        // never trips over an unexpected null.
        let s = serde_json::to_string(old).unwrap();
        assert!(
            !s.contains("project"),
            "None project must skip serialisation"
        );

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn upsert_tag_at_preserves_all_entries_under_contention() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let path = unique_temp_tags_path();
        let _ = fs::remove_file(&path);

        // Many threads upserting distinct sessions at once. Without the write
        // lock the read-all → rewrite races and entries are lost (len < N).
        // With the lock every entry survives.
        const N: usize = 24;
        let barrier = Arc::new(Barrier::new(N));
        let mut handles = Vec::with_capacity(N);
        for i in 0..N {
            let p = path.clone();
            let b = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                b.wait();
                let entry = TagEntry {
                    session_id: format!("session-{i}"),
                    tags: vec![format!("tag-{i}")],
                    generated_at: "2026-05-29T00:00:00Z".to_string(),
                    project: None,
                };
                upsert_tag_at(&p, entry).unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        let all = load_tags_at(&path).unwrap();
        assert_eq!(
            all.len(),
            N,
            "lost entries to a write race — the lock is not protecting upsert"
        );

        let _ = fs::remove_file(&path);
    }
}
