// ---------------------------------------------------------------------------
// Control Center 2.0 (P3): embedded PTY (portable-pty + xterm.js).
// ---------------------------------------------------------------------------

export type PtyStatus =
  | { kind: "running" }
  | { kind: "exited"; value: number }
  | { kind: "killed" };

export type PtySessionSummary = {
  id: string;
  project_id: string;
  card_id: string | null;
  provider: string;
  started_at: string;
  status: PtyStatus;
};

export type PtyDataEvent = { data: string };
export type PtyExitEvent = { exit_code: number };

// ---------------------------------------------------------------------------
// Qdrant semantic recall (v2.9.5 — KIRKARDO Round 7 #2)
// Mirrors `qdrant::QdrantHit` on the Rust side.
// payload keys: text, kind, importance, project, date, sha_head, session_id
// ---------------------------------------------------------------------------

/** Known `kind` values stored in Qdrant payloads. */
export type QdrantHitKind =
  | "decision"
  | "bug"
  | "feature"
  | "todo"
  | "file"
  | string;

/** A single result from `invoke("recall_semantic", { query, k })`. */
export type QdrantHit = {
  /** Qdrant point id (normalised to string). */
  id: string;
  /** Cosine similarity score in [0, 1]. */
  score: number;
  /** Arbitrary JSON payload stored alongside the vector.
   *  Known keys: text, kind, importance, project, date, sha_head, session_id */
  payload: {
    text?: string;
    kind?: QdrantHitKind;
    importance?: string | number;
    project?: string;
    date?: string;
    sha_head?: string;
    session_id?: string;
    [key: string]: unknown;
  };
};

/** Return type of `invoke("recall_semantic", ...)`. */
export type RecallSemanticResult = QdrantHit[];

/**
 * Result of `recall_last_session` / `recall_last_session_global`. Built from
 * the most recent Claude Code JSONL transcript for the chosen project (or
 * globally), with a mem0 fallback when no local JSONL matches.
 *
 * Backend: `src-tauri/src/recall.rs::RecallResult`.
 */
export type RecallResult = {
  /** True when either a JSONL transcript or mem0 returned content. */
  found: boolean;
  /** UUID of the matched session (file stem). Null when falling back to mem0
   *  or when nothing was found. */
  session_id: string | null;
  /** ISO 8601 mtime of the matched JSONL. */
  last_active_iso: string | null;
  /** Markdown summary the dialog renders verbatim. */
  summary_md: string;
  /** Paste-ready first prompt for a fresh session. */
  suggested_prompt: string;
  /** "jsonl" | "mem0" | "none". */
  source: string;
};
