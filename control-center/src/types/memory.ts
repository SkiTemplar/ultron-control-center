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
