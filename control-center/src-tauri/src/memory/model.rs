// ULTRON Control Center — Canonical memory domain model (MEMORY KERNEL · Fase A)
//
// The single, governed, auditable representation of a memory. This replaces the
// anemic `MemoryHit` (id/text/score/source) as the source-of-truth type. It is
// persisted in `~/.ultron/brain.db` (see `sqlite_store.rs`) and indexed in
// Qdrant (Fase B). Every mutation emits a `MemoryEvent` (append-only audit).
//
// Controlled vocabularies are modeled as small string enums via the `str_enum!`
// macro: they serialize to/from the exact snake_case strings stored in SQLite,
// so the DB stays human-readable and the Rust side stays type-safe.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// str_enum! — generates a TEXT-backed enum with as_str/parse/Display + serde
// ---------------------------------------------------------------------------

macro_rules! str_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $s:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum $name { $($variant),+ }

        impl $name {
            #[must_use]
            pub fn as_str(&self) -> &'static str {
                match self { $(Self::$variant => $s),+ }
            }
            #[must_use]
            pub fn parse(s: &str) -> Option<Self> {
                match s { $($s => Some(Self::$variant),)+ _ => None }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = String::deserialize(d)?;
                Self::parse(&s).ok_or_else(|| {
                    serde::de::Error::custom(format!("invalid {}: {s}", stringify!($name)))
                })
            }
        }
    };
}

str_enum! {
    /// What kind of knowledge a memory captures.
    MemoryType {
        Preference => "preference",
        Fact => "fact",
        Decision => "decision",
        Constraint => "constraint",
        Task => "task",
        CodebaseFact => "codebase_fact",
        Skill => "skill",
        AgentNote => "agent_note",
        SessionSummary => "session_summary",
        ErrorResolution => "error_resolution",
        Architecture => "architecture",
        UserProfile => "user_profile",
    }
}

str_enum! {
    /// The blast radius / applicability of a memory.
    Scope {
        Global => "global",
        User => "user",
        Project => "project",
        Repo => "repo",
        Branch => "branch",
        Session => "session",
        Workflow => "workflow",
        Agent => "agent",
        Skill => "skill",
    }
}

str_enum! {
    /// Lifecycle state. Only `Active` is injected into prompts by default.
    Status {
        Pending => "pending",
        Active => "active",
        Rejected => "rejected",
        Stale => "stale",
        Deprecated => "deprecated",
        Quarantined => "quarantined",
        Archived => "archived",
    }
}

str_enum! {
    Stability {
        Temporary => "temporary",
        Durable => "durable",
        Permanent => "permanent",
    }
}

str_enum! {
    Sensitivity {
        Public => "public",
        Internal => "internal",
        Private => "private",
        Secret => "secret",
    }
}

str_enum! {
    /// Where a memory came from. `imported_*` marks one-shot ETL provenance.
    Source {
        UserExplicit => "user_explicit",
        AssistantInferred => "assistant_inferred",
        ToolObserved => "tool_observed",
        CodeObserved => "code_observed",
        WorkflowGenerated => "workflow_generated",
        ImportedEcc => "imported_ecc",
        ImportedKg => "imported_kg",
        ImportedSessions => "imported_sessions",
        ImportedVault => "imported_vault",
        ManualUi => "manual_ui",
    }
}

str_enum! {
    /// Append-only audit event types.
    EventType {
        Created => "created",
        Updated => "updated",
        Approved => "approved",
        Rejected => "rejected",
        Edited => "edited",
        Merged => "merged",
        Split => "split",
        Deprecated => "deprecated",
        Restored => "restored",
        Contradicted => "contradicted",
        Retrieved => "retrieved",
        Injected => "injected",
        Exported => "exported",
        Imported => "imported",
    }
}

str_enum! {
    /// Who performed an action.
    Actor {
        User => "user",
        MemoryAgent => "memory_agent",
        WorkflowAgent => "workflow_agent",
        System => "system",
        Migration => "migration",
    }
}

str_enum! {
    /// Recommended disposition for a candidate awaiting validation.
    CandidateAction {
        Approve => "approve",
        Reject => "reject",
        Edit => "edit",
        Merge => "merge",
        Supersede => "supersede",
        Quarantine => "quarantine",
    }
}

str_enum! {
    CandidateStatus {
        Pending => "pending",
        Approved => "approved",
        Rejected => "rejected",
        Edited => "edited",
        Merged => "merged",
        Quarantined => "quarantined",
    }
}

// ---------------------------------------------------------------------------
// MemoryItem — the canonical, governed memory record
// ---------------------------------------------------------------------------

/// A single governed memory. Persisted in `memory_items`, indexed in Qdrant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryItem {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: MemoryType,
    pub scope: Scope,

    pub project_id: Option<String>,
    pub repo_id: Option<String>,
    pub branch: Option<String>,
    pub workflow_id: Option<String>,
    pub agent_id: Option<String>,
    pub skill_id: Option<String>,

    pub title: Option<String>,
    /// Compact form injected into prompts.
    pub summary: Option<String>,
    /// Full detail, lazy-loaded only on demand.
    pub content: Option<String>,
    pub content_json: Option<String>,
    pub tags: Vec<String>,

    pub status: Status,
    pub confidence: f32,
    pub importance: f32,
    pub stability: Stability,
    pub sensitivity: Sensitivity,
    pub source: Source,
    pub source_session_id: Option<String>,

    pub created_at: i64,
    pub updated_at: i64,
    pub expires_at: Option<i64>,

    pub supersedes: Option<String>,
    pub superseded_by: Option<String>,
    pub contradicts: Vec<String>,
    pub derived_from: Option<String>,

    /// Temporal validity (bitemporal-lite). `valid_from` is when this assertion
    /// started being true (defaults to `created_at`); `valid_to` is when it
    /// stopped (set by `supersede`). `valid_to == None` means STILL VIGENTE.
    /// Recall prefers items whose `valid_to` is NULL or in the future. ADDITIVE —
    /// legacy rows keep `valid_from = created_at` and `valid_to = NULL` so nothing
    /// historical is filtered out by default.
    #[serde(default)]
    pub valid_from: Option<i64>,
    #[serde(default)]
    pub valid_to: Option<i64>,

    pub qdrant_point_id: Option<String>,
    pub token_estimate: i64,
    pub access_count: i64,
    pub last_accessed_at: Option<i64>,
    pub last_injected_at: Option<i64>,
    pub validated_by_user: bool,
    pub validated_at: Option<i64>,
    /// User-elevated: always considered for recall + Session Resume, regardless
    /// of recency/score. Distinct from `stability` (expected lifetime).
    pub pinned: bool,
    /// OLA B: stable FNV-1a hash of the normalized searchable text (dedupe /
    /// idempotency key, see memory/texthash.rs). `None` only for legacy rows
    /// not yet backfilled.
    #[serde(default)]
    pub content_hash: Option<String>,
    /// OLA B: lowercased, whitespace-collapsed searchable text (hash input +
    /// cheap near-dup compare). `None` for legacy rows not yet backfilled.
    #[serde(default)]
    pub normalized_text: Option<String>,
    /// OLA B: schema generation that produced this row.
    #[serde(default = "default_schema_version")]
    pub schema_version: i64,

    // -- Code-location capture (2026-06-05, ADDITIVE) --------------------------
    // Populated only for code-derived memories (PostToolUse symbol capture). All
    // `serde(default)` so older brain.db rows (and older JSON) deserialize as
    // `None` — fully backward-compatible.
    /// Identity key for a captured symbol, "file_path:symbol" (e.g.
    /// "src/auth/jwt.rs:validate_token"). Indexed for O(1) dedupe on re-capture.
    #[serde(default)]
    pub symbol: Option<String>,
    /// Repo-relative (or absolute) path of the source file the memory describes.
    #[serde(default)]
    pub file_path: Option<String>,
    /// Line of the definition (single line, or the start of a range).
    #[serde(default)]
    pub line: Option<i64>,
    /// First line of the definition — its signature (e.g. the `fn` header).
    #[serde(default)]
    pub signature: Option<String>,
    /// Capture provenance: posttooluse_symbol | posttooluse_arch | stop_capture |
    /// userprompt | manual. Distinct from `source` (the controlled enum) — this is
    /// the finer-grained capture channel. `None` for rows predating capture.
    #[serde(default, rename = "capture_source")]
    pub capture_source: Option<String>,
}

/// Canonical schema generation for `memory_items`. Bump on backfill-relevant
/// shape changes: 1 = base (pre-OLA B), 2 = + content_hash/normalized_text.
pub const SCHEMA_VERSION: i64 = 2;

fn default_schema_version() -> i64 {
    SCHEMA_VERSION
}

impl MemoryItem {
    /// Construct a new memory with sensible defaults. The caller sets `status`
    /// (typically `Pending` for candidates, `Active` for direct/imported writes).
    #[must_use]
    pub fn new(kind: MemoryType, scope: Scope, source: Source, status: Status) -> Self {
        let now = now_millis();
        let content = String::new();
        Self {
            id: new_id(),
            kind,
            scope,
            project_id: None,
            repo_id: None,
            branch: None,
            workflow_id: None,
            agent_id: None,
            skill_id: None,
            title: None,
            summary: None,
            content: None,
            content_json: None,
            tags: Vec::new(),
            status,
            confidence: 0.5,
            importance: 0.5,
            stability: Stability::Durable,
            sensitivity: Sensitivity::Internal,
            source,
            source_session_id: None,
            created_at: now,
            updated_at: now,
            expires_at: None,
            supersedes: None,
            superseded_by: None,
            contradicts: Vec::new(),
            derived_from: None,
            // Default validity: vigente from creation, no end. supersede() sets
            // valid_to on the superseded item.
            valid_from: Some(now),
            valid_to: None,
            qdrant_point_id: None,
            token_estimate: estimate_tokens(&content),
            access_count: 0,
            last_accessed_at: None,
            last_injected_at: None,
            validated_by_user: false,
            validated_at: None,
            pinned: false,
            content_hash: None,
            normalized_text: None,
            schema_version: SCHEMA_VERSION,
            symbol: None,
            file_path: None,
            line: None,
            signature: None,
            capture_source: None,
        }
    }

    /// The text used for embedding/FTS: title + summary + content, de-duplicated.
    ///
    /// **Contextual Retrieval (CR)** — opt-in via `ULTRON_CR=1`:
    /// when active, the passage is prefixed with a one-line context header so
    /// that embeddings from different projects/types are separated in the vector
    /// space, reducing cross-project recall collisions:
    ///
    /// ```text
    /// Proyecto: ultron. Tipo: decision.
    /// {title}\n{summary}\n{content}
    /// ```
    ///
    /// With the flag **off** (default), the output is byte-for-byte identical
    /// to the previous behaviour: `"{title}\n{summary}\n{content}"`.
    /// Only the passage changes — the query embedding (`embed_e5(query, true)`)
    /// is never modified by this flag.
    #[must_use]
    pub fn searchable_text(&self) -> String {
        let mut parts: Vec<&str> = Vec::new();
        if let Some(t) = &self.title {
            parts.push(t);
        }
        if let Some(s) = &self.summary {
            parts.push(s);
        }
        if let Some(c) = &self.content {
            parts.push(c);
        }
        let body = parts.join("\n");
        if crate::qdrant::cr_enabled() {
            let project = self.project_id.as_deref().unwrap_or("global");
            let tipo = self.kind.as_str();
            format!("Proyecto: {project}. Tipo: {tipo}.\n{body}")
        } else {
            body
        }
    }
}

// ---------------------------------------------------------------------------
// MemoryEvent — append-only audit record
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEvent {
    pub id: String,
    pub event_type: EventType,
    pub memory_id: Option<String>,
    pub before_json: Option<String>,
    pub after_json: Option<String>,
    pub actor: Actor,
    pub source_session_id: Option<String>,
    pub source_turn_id: Option<String>,
    pub reason: Option<String>,
    pub confidence: Option<f32>,
    pub created_at: i64,
}

impl MemoryEvent {
    #[must_use]
    pub fn new(event_type: EventType, memory_id: Option<String>, actor: Actor) -> Self {
        Self {
            id: new_id(),
            event_type,
            memory_id,
            before_json: None,
            after_json: None,
            actor,
            source_session_id: None,
            source_turn_id: None,
            reason: None,
            confidence: None,
            created_at: now_millis(),
        }
    }

    #[must_use]
    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }

    #[must_use]
    pub fn with_after(mut self, after_json: impl Into<String>) -> Self {
        self.after_json = Some(after_json.into());
        self
    }

    #[must_use]
    pub fn with_before(mut self, before_json: impl Into<String>) -> Self {
        self.before_json = Some(before_json.into());
        self
    }
}

// ---------------------------------------------------------------------------
// MemoryCandidate — proposed memory awaiting human/auto validation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryCandidate {
    pub id: String,
    pub proposed_type: MemoryType,
    pub proposed_scope: Scope,
    /// Project the promoted item belongs to (e.g. "tortunabo", "bank"). Optional
    /// so older candidates / session captures stay project-agnostic. `serde(default)`
    /// keeps deserialization of pre-existing candidates in brain.db backward-compatible.
    #[serde(default)]
    pub proposed_project_id: Option<String>,
    pub proposed_title: Option<String>,
    pub proposed_summary: Option<String>,
    pub proposed_content: Option<String>,
    pub proposed_content_json: Option<String>,
    pub proposed_tags: Vec<String>,
    pub source_event_ids: Vec<String>,
    pub source_session_id: Option<String>,
    pub confidence: f32,
    pub importance: f32,
    pub risk_level: String,
    pub duplicate_candidates: Vec<String>,
    pub contradiction_candidates: Vec<String>,
    pub recommended_action: CandidateAction,
    pub status: CandidateStatus,
    pub created_at: i64,

    // -- Code-location capture (2026-06-05, ADDITIVE, all serde(default)) -------
    /// "file_path:symbol" identity key (see `MemoryItem::symbol`).
    #[serde(default)]
    pub proposed_symbol: Option<String>,
    /// Source file path the candidate describes.
    #[serde(default)]
    pub proposed_file_path: Option<String>,
    /// Definition line (single, or range start).
    #[serde(default)]
    pub proposed_line: Option<i64>,
    /// Signature / first line of the definition.
    #[serde(default)]
    pub proposed_signature: Option<String>,
    /// Capture channel (posttooluse_symbol | posttooluse_arch | stop_capture | …).
    #[serde(default)]
    pub capture_source: Option<String>,
}

impl MemoryCandidate {
    #[must_use]
    pub fn new(proposed_type: MemoryType, proposed_scope: Scope) -> Self {
        Self {
            id: new_id(),
            proposed_type,
            proposed_scope,
            proposed_project_id: None,
            proposed_title: None,
            proposed_summary: None,
            proposed_content: None,
            proposed_content_json: None,
            proposed_tags: Vec::new(),
            source_event_ids: Vec::new(),
            source_session_id: None,
            confidence: 0.5,
            importance: 0.5,
            risk_level: "low".to_string(),
            duplicate_candidates: Vec::new(),
            contradiction_candidates: Vec::new(),
            recommended_action: CandidateAction::Approve,
            status: CandidateStatus::Pending,
            created_at: now_millis(),
            proposed_symbol: None,
            proposed_file_path: None,
            proposed_line: None,
            proposed_signature: None,
            capture_source: None,
        }
    }

    /// Promote this candidate into a fresh `MemoryItem` (status set by caller).
    #[must_use]
    pub fn to_item(&self, status: Status, source: Source) -> MemoryItem {
        let mut item = MemoryItem::new(self.proposed_type, self.proposed_scope, source, status);
        // Prefer the explicit field (direct in-memory path); fall back to a
        // `project:<id>` tag, which is how the project survives a round-trip
        // through SQLite (the candidate table has no project column).
        item.project_id = self.proposed_project_id.clone().or_else(|| {
            self.proposed_tags
                .iter()
                .find_map(|t| t.strip_prefix("project:").map(str::to_string))
        });
        item.title = self.proposed_title.clone();
        item.summary = self.proposed_summary.clone();
        item.content = self.proposed_content.clone();
        item.content_json = self.proposed_content_json.clone();
        item.tags = self.proposed_tags.clone();
        item.confidence = self.confidence;
        item.importance = self.importance;
        item.source_session_id = self.source_session_id.clone();
        // Carry the code-location capture fields (all ADDITIVE / nullable).
        item.symbol = self.proposed_symbol.clone();
        item.file_path = self.proposed_file_path.clone();
        item.line = self.proposed_line;
        item.signature = self.proposed_signature.clone();
        item.capture_source = self.capture_source.clone();
        item.token_estimate = estimate_tokens(&item.searchable_text());
        item
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Stable, collision-resistant id (UUID v4) — replaces the homemade hasher id.
#[must_use]
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Current time as Unix milliseconds.
#[must_use]
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Rough token estimate (~4 chars/token) for budget accounting.
#[must_use]
pub fn estimate_tokens(text: &str) -> i64 {
    (text.chars().count() as i64 + 3) / 4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enum_roundtrips_through_string() {
        assert_eq!(Status::parse("active"), Some(Status::Active));
        assert_eq!(Status::Deprecated.as_str(), "deprecated");
        assert_eq!(
            MemoryType::parse("session_summary"),
            Some(MemoryType::SessionSummary)
        );
        assert_eq!(Scope::Project.to_string(), "project");
        assert_eq!(
            Source::parse("imported_sessions"),
            Some(Source::ImportedSessions)
        );
        assert_eq!(Status::parse("bogus"), None);
    }

    #[test]
    fn enum_serializes_as_plain_string() {
        let json = serde_json::to_string(&Status::Active).unwrap();
        assert_eq!(json, "\"active\"");
        let back: Status = serde_json::from_str("\"pending\"").unwrap();
        assert_eq!(back, Status::Pending);
    }

    #[test]
    fn new_item_has_defaults_and_unique_id() {
        let a = MemoryItem::new(
            MemoryType::Fact,
            Scope::Project,
            Source::ToolObserved,
            Status::Pending,
        );
        let b = MemoryItem::new(
            MemoryType::Fact,
            Scope::Project,
            Source::ToolObserved,
            Status::Pending,
        );
        assert_ne!(a.id, b.id, "ids must be unique");
        assert_eq!(a.status, Status::Pending);
        assert_eq!(a.confidence, 0.5);
        assert!(!a.validated_by_user);
    }

    #[test]
    fn candidate_promotes_to_item_preserving_fields() {
        let mut c = MemoryCandidate::new(MemoryType::Decision, Scope::Project);
        c.proposed_summary = Some("usar bge-m3".into());
        c.importance = 0.9;
        let item = c.to_item(Status::Active, Source::UserExplicit);
        assert_eq!(item.kind, MemoryType::Decision);
        assert_eq!(item.summary.as_deref(), Some("usar bge-m3"));
        assert_eq!(item.importance, 0.9);
        assert_eq!(item.status, Status::Active);
    }

    #[test]
    fn estimate_tokens_is_roughly_quarter_chars() {
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens(""), 0);
    }

    // -----------------------------------------------------------------------
    // Contextual Retrieval (CR) — searchable_text flag behaviour
    //
    // These tests mutate the process env var ULTRON_CR. They must NOT run in
    // parallel with each other — use CR_ENV_LOCK to serialize access so that
    // a set_var in one test isn't visible to another mid-flight.
    // -----------------------------------------------------------------------

    /// Serialises tests that touch ULTRON_CR so they don't race each other.
    /// OnceLock + Mutex — no extra deps, mirrors the `once_cell` pattern already
    /// used in qdrant.rs.
    fn cr_env_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    /// Run `f` with ULTRON_CR set to `val` (None = remove), then restore the
    /// previous value. Holds `cr_env_lock` for the entire duration.
    fn with_cr_env<F: FnOnce() -> R, R>(val: Option<&str>, f: F) -> R {
        let _guard = cr_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("ULTRON_CR").ok();
        match val {
            Some(v) => std::env::set_var("ULTRON_CR", v),
            None => std::env::remove_var("ULTRON_CR"),
        }
        let result = f();
        match prev {
            Some(v) => std::env::set_var("ULTRON_CR", v),
            None => std::env::remove_var("ULTRON_CR"),
        }
        result
    }

    /// With ULTRON_CR absent (default OFF), searchable_text must be byte-for-byte
    /// identical to the pre-CR baseline: title + "\n" + summary + "\n" + content.
    #[test]
    fn searchable_text_unchanged_when_cr_off() {
        let mut item = MemoryItem::new(
            MemoryType::Decision,
            Scope::Project,
            Source::ToolObserved,
            Status::Active,
        );
        item.project_id = Some("ultron".to_string());
        item.title = Some("usar E5-large".to_string());
        item.summary = Some("resumen".to_string());
        item.content = Some("detalle".to_string());

        let text = with_cr_env(None, || item.searchable_text());

        assert_eq!(
            text, "usar E5-large\nresumen\ndetalle",
            "with ULTRON_CR unset, searchable_text must equal title+summary+content unchanged"
        );
    }

    /// With ULTRON_CR=1, searchable_text must be prefixed with the context
    /// header "Proyecto: {project_id}. Tipo: {kind}." followed by the body.
    #[test]
    fn searchable_text_prefixes_context_when_cr_on() {
        let mut item = MemoryItem::new(
            MemoryType::Decision,
            Scope::Project,
            Source::ToolObserved,
            Status::Active,
        );
        item.project_id = Some("ultron".to_string());
        item.title = Some("usar E5-large".to_string());
        item.summary = Some("resumen".to_string());
        item.content = Some("detalle".to_string());

        let text = with_cr_env(Some("1"), || item.searchable_text());

        assert_eq!(
            text, "Proyecto: ultron. Tipo: decision.\nusar E5-large\nresumen\ndetalle",
            "with ULTRON_CR=1, searchable_text must carry the context prefix"
        );
        assert!(
            text.starts_with("Proyecto: ultron. Tipo: decision."),
            "prefix not found; got: {text:?}"
        );
    }

    /// When project_id is None, the prefix uses "global" as fallback.
    #[test]
    fn searchable_text_cr_uses_global_when_no_project() {
        let mut item = MemoryItem::new(
            MemoryType::Fact,
            Scope::Global,
            Source::UserExplicit,
            Status::Active,
        );
        // project_id deliberately left as None (the default from new()).
        item.title = Some("hecho global".to_string());

        let text = with_cr_env(Some("1"), || item.searchable_text());

        assert!(
            text.starts_with("Proyecto: global. Tipo: fact."),
            "None project_id must yield 'global'; got: {text:?}"
        );
    }
}
