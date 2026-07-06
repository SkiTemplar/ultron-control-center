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

/** A single Qdrant point hit (id + score + payload). */
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

/** Array of Qdrant point hits (legacy alias, kept for type consumers). */
export type RecallSemanticResult = QdrantHit[];

/**
 * Result of `recall_last_session` / `recall_last_session_global`. Built from
 * the most recent Claude Code JSONL transcript for the chosen project (or
 * globally).
 *
 * Backend: `src-tauri/src/recall.rs::RecallResult`.
 */
export type RecallResult = {
  /** True when a JSONL transcript returned content. */
  found: boolean;
  /** UUID of the matched session (file stem). Null when nothing was found. */
  session_id: string | null;
  /** ISO 8601 mtime of the matched JSONL. */
  last_active_iso: string | null;
  /** Markdown summary the dialog renders verbatim. */
  summary_md: string;
  /** Paste-ready first prompt for a fresh session. */
  suggested_prompt: string;
  /** "jsonl" | "none". */
  source: string;
};
