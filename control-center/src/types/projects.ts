// Project info, launcher items, sessions, and spawn types.

export type SpawnFlags = {
  dangerouslySkipPermissions?: boolean;
  continueLast?: boolean;
  forkSession?: boolean;
  model?: string | null;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  name?: string | null;
  resumeId?: string | null;
  /** Optional subagent slug (filename stem under `~/.claude/agents/`).
   *  When set, the Rust backend prepends `[USE AGENT: <slug>]` to the
   *  prompt before the Claude session starts. v2.0: pass it explicitly
   *  per call-site (no AI Router). */
  agent?: string | null;
  /** When true, the wrapper script copies the prompt to the clipboard
   *  and opens the CLI without auto-submitting. Mirrors the Rust
   *  `paste_only` flag. */
  pasteOnly?: boolean;
  /** When true, the wrapper script will NOT overwrite the clipboard.
   *  Used by callers that primed the clipboard themselves (news pipeline). */
  respectClipboard?: boolean;
};

export type ClaudeSession = {
  id: string;
  project_slug: string;
  project_label: string;
  preview: string | null;
  size_bytes: number;
  last_activity: string | null;
  line_count: number;
};

/** Aggregated view of one workspace folder under `~/.claude/projects/`.
 *  Mirrors `claude_sessions::WorkspaceSummary` on the Rust side. The
 *  Sessions tab uses this for the "Recent workspaces" grid: each card
 *  resumes `latest_session_id` or spawns a new session in `cwd`. */
export type WorkspaceSummary = {
  cwd: string;
  project_id: string | null;
  project_name: string | null;
  last_activity: string | null;
  session_count: number;
  latest_session_id: string | null;
  /** Nearest ancestor that contains `.git/`, when distinct from `cwd`.
   *  When non-null, the workspace card surfaces a "Use git root" chip so the
   *  user can spawn the next session at the repo root instead of in the
   *  subfolder Claude originally recorded. Fixes the .ultron/control-center
   *  vs .ultron friction. */
  git_root: string | null;
};

export type SpawnResult = {
  launched: boolean;
  provider: string;
};

export type SessionProvider = "claude" | "codex";

/** Kind of a launcher item inside a project's `items[]`.
 *
 * v15.4.11 — el dropdown del UI expone 3 kinds principales (folder /
 * ide / session) más `exe` como avanzado. Los kinds legacy
 * `claude` / `codex` siguen siendo válidos en el backend (proyectos
 * existentes los usan) y se renderizan como built-in chips exactamente
 * como antes. Internamente: `session` = consolidación, distinguida por
 * el campo `provider`. `ide` = abrir el path en el IDE preferido.
 * Nota: `gemini` fue eliminado 2026-06-19 (Google cortó el free-tier
 * OAuth). La normalización "gemini"→"claude" aplica solo al campo
 * `default_provider`/`provider` del proyecto (vía `normalise_provider`
 * en Rust); el campo `kind` de un item no se normaliza en carga.
 */
export type LauncherItemKind =
  | "exe"
  | "folder"
  | "claude"
  | "codex"
  | "ide"
  | "session";

/** A single thing to launch from a project. The Rust side dispatches on
 *  `kind`; the other fields are payload-shaped:
 *   - exe     → `path` (absolute) + optional `args[]`
 *   - folder  → `path` (absolute directory)
 *   - claude/codex → `cwd` (absolute directory)  [legacy kinds]
 *   - session → `cwd` (absolute) + `provider` field elige el binario.
 *   - ide     → resuelve el path del proyecto y abre el preferred_ide.
 *  `label` is free text shown in the row chip (falls back to a derived
 *  string built from the path tail). */
export type LauncherItem = {
  kind: LauncherItemKind | string;
  path?: string | null;
  cwd?: string | null;
  args?: string[] | null;
  label?: string | null;
  /** v15.4.11 — solo aplica cuando kind === "session". Uno de
   *  claude/codex. */
  provider?: SessionProvider | null;
};

/** fb-016 — allowed values for `Project.default_shell`. Mirrors the Rust
 *  `VALID_SHELLS` allowlist. */
export type ProjectShell =
  | "powershell"
  | "powershell-admin"
  | "cmd"
  | "bash";

// v2.6.2 — per-project executables for Quick Launch in Project Home.
// Persisted on the project registry entry as an `executables[]` array.
export type ProjectExecutable = {
  name: string;
  path: string;
  args?: string[] | null;
  icon?: string | null;
};

export type ProjectInfo = {
  id: string;
  name: string | null;
  path: string | null;
  ide: string | null;
  language: string | null;
  type_: string | null;
  status: string | null;
  last_active: string | null;
  tags: string[];
  /** Launch group items. When the registry omits this array but supplies a
   *  `path`, the backend synthesises a default
   *  `[folder(path), claude(path)]` pair so old-style entries keep working
   *  without an on-disk migration. */
  items?: LauncherItem[] | null;
  /** Preferred session provider for this project. Always one of
   *  "claude" | "codex" — the Rust loader normalises legacy entries
   *  (missing field / typos / "gemini") to "claude" before returning,
   *  so the UI can safely read it without a null check. */
  default_provider?: SessionProvider | null;
  /** fb-016 — preferred shell for non-AI terminals spawned in this
   *  project's workspace. One of "powershell" | "powershell-admin" |
   *  "cmd" | "bash". `null`/missing = use the global default. */
  default_shell?: ProjectShell | null;
  /** fb-016 — override the cwd terminals open in. When set, takes
   *  precedence over the project's `path`. Useful when work happens in a
   *  sub-directory of the repo. */
  parent_folder_override?: string | null;
  /** fb-016 — free-form project notes (markdown / plain text). Distinct
   *  from the standalone Notes tab — these live next to the project
   *  registry entry. */
  notes?: string | null;
  /** v2.6.2 — list of bound executables surfaced as Quick Launch buttons in
   *  the Project Home. Distinct from `items[]` launcher chips: these are
   *  edited via the Project Edit modal and rendered with a separate UI. */
  executables?: ProjectExecutable[] | null;
};

export type ProjectActionResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
};

export type CreateProjectResult = {
  success: boolean;
  id: string;
  message: string;
};

// v2.6.2 — kanban archive types. Done cards can be moved into named archive
// groups under ~/.ultron/cockpit/projects/<project_id>/archives/<name>.json.
// The list summary keeps the body slim (no cards) so the toolbar grid renders
// quickly; the full payload is fetched on box click.
export type KanbanArchiveSummary = {
  name: string;
  archived_at: string;
  card_count: number;
};

export type KanbanArchive = {
  name: string;
  archived_at: string;
  cards: Array<{
    id: string;
    title: string;
    description: string;
    tags: string[];
    column_name: string;
    archived_from_column_id: string;
  }>;
};
