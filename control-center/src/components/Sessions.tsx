// ULTRON Control Center — Sessions tab.
//
// Redesigned as a workspace picker. The previous version led with a Codex
// fallback button, a provider matrix and a long flat list of sessions —
// most of which the user never touched. The new layout puts what USER
// asked for first: pick a recent workspace and start a fresh session.
//
//   1. "Recent workspaces" — auto-detected from `~/.claude/projects/`,
//      enriched with `projects.json` names where the cwd matches.
//      Each card has: New session · Custom · Send Context (modals).
//   2. "All Claude sessions" — the old flat list, kept for power users.
//      Collapsed by default so it stops dominating the page.
//
// v2.6 (feedback round 2):
//   - "Continue" button removed (user: "no me sirve").
//   - Custom and Send-Context popovers became MODAL overlays — no more
//     inline expansion that grows the card.
//   - Workspace cards stopped showing the session id / epoch. The headline
//     is the project name or a derived workspace name, and the secondary
//     line is the cwd. Anything machine-readable lives on hover.
//   - New sub-tab "Workdays" (skeleton). Concept: a "jornada de trabajo"
//      aggregates Claude/Codex/Gemini sessions + kanban activity + agents
//      used into a single day-level entry with computed duration. Full
//      implementation tracked under card-v27-inv-workdays.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  ClaudeSession,
  ProjectInfo,
  SessionProvider,
  SpawnFlags,
  WorkspaceSummary,
} from "../types";
import {
  Plus,
  History,
  RefreshCw,
} from "./projects/icons";

// Session presets — persisted across launches in localStorage. Keep the keys
// stable so existing users don't lose their preferred config when the app
// updates.
const PRESETS_KEY = "ultron.cc.session_presets.v1";

type Presets = {
  dangerouslySkipPermissions: boolean;
  effort: "" | "low" | "medium" | "high" | "xhigh" | "max";
};

const DEFAULT_PRESETS: Presets = {
  dangerouslySkipPermissions: false,
  effort: "",
};

function loadPresets(): Presets {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return DEFAULT_PRESETS;
    const p = JSON.parse(raw) as Partial<Presets>;
    return { ...DEFAULT_PRESETS, ...p };
  } catch {
    return DEFAULT_PRESETS;
  }
}
function savePresets(p: Presets) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(p));
  } catch {}
}

function formatRel(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

/** Derive a readable headline from a cwd when the workspace is not
 *  registered in `projects.json`. We use the tail directory name. */
function deriveWorkspaceName(cwd: string): string {
  const cleaned = cwd.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  if (idx < 0) return cleaned || cwd;
  const tail = cleaned.slice(idx + 1);
  return tail || cleaned;
}

// ---------------------------------------------------------------------------
// Provider catalogue
// ---------------------------------------------------------------------------

type ProviderMeta = {
  label: string;
  accent: string;
  models: { id: string; label: string }[];
  defaultModel: string;
  acceptsModel: boolean;
};

const PROVIDERS: Record<SessionProvider, ProviderMeta> = {
  claude: {
    label: "Claude",
    accent: "var(--color-success)",
    acceptsModel: true,
    models: [
      { id: "", label: "default (account current)" },
      { id: "claude-opus-4-7", label: "Opus 4.7 · best quality" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6 · balanced" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 · fast" },
    ],
    defaultModel: "",
  },
  gemini: {
    label: "Gemini",
    accent: "var(--color-warn)",
    acceptsModel: true,
    models: [
      { id: "gemini-3.1-pro-preview", label: "3.1 Pro · best quality" },
      { id: "gemini-3.1-flash-lite", label: "3.1 Flash Lite · fast" },
      { id: "gemini-2.5-pro", label: "2.5 Pro · stable" },
      { id: "gemini-2.5-flash", label: "2.5 Flash · stable fast" },
    ],
    defaultModel: "gemini-3.1-pro-preview",
  },
  codex: {
    label: "Codex",
    accent: "#a875ff",
    acceptsModel: true,
    models: [
      { id: "", label: "default (gpt-5.5)" },
      { id: "gpt-5.5", label: "gpt-5.5" },
      { id: "gpt-5.5-thinking", label: "gpt-5.5 thinking" },
    ],
    defaultModel: "",
  },
};

const PROVIDER_LIST: SessionProvider[] = ["claude", "gemini", "codex"];

// ---------------------------------------------------------------------------
// Provider tab control
// ---------------------------------------------------------------------------

function ProviderTabs({
  active,
  onChange,
}: {
  active: SessionProvider;
  onChange: (p: SessionProvider) => void;
}) {
  return (
    <div
      className="inline-flex rounded p-0.5"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border-strong)",
      }}
    >
      {PROVIDER_LIST.map((p) => {
        const m = PROVIDERS[p];
        const isActive = p === active;
        return (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            className="flex items-center gap-1.5 rounded px-3 py-1 text-[12px] font-medium transition-colors"
            style={{
              background: isActive ? "var(--color-surface-3)" : "transparent",
              color: isActive ? "var(--color-text)" : "var(--color-text-tertiary)",
            }}
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: m.accent, opacity: isActive ? 1 : 0.5 }}
            />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace chip (advanced launch flow)
// ---------------------------------------------------------------------------

const WORKSPACE_KEY = "ultron.cc.session.cwd.v1";

function loadCwd(): string {
  try {
    return localStorage.getItem(WORKSPACE_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveCwd(v: string) {
  try {
    if (v) localStorage.setItem(WORKSPACE_KEY, v);
    else localStorage.removeItem(WORKSPACE_KEY);
  } catch {}
}

function WorkspacePicker({
  cwd,
  onChange,
  projects,
}: {
  cwd: string;
  onChange: (v: string) => void;
  projects: ProjectInfo[];
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function pickCustom() {
    setBusy(true);
    try {
      const path = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose a workspace directory",
      });
      if (typeof path === "string" && path) {
        onChange(path);
        setOpen(false);
      }
    } catch {
      // dialog cancelled — ignore
    } finally {
      setBusy(false);
    }
  }

  function pickProject(p: ProjectInfo) {
    if (p.path) {
      onChange(p.path);
      setOpen(false);
    }
  }

  function clear() {
    onChange("");
  }

  const q = search.trim().toLowerCase();
  const filteredProjects = q
    ? projects.filter(
        (p) =>
          p.id.toLowerCase().includes(q) ||
          (p.name ?? "").toLowerCase().includes(q) ||
          (p.path ?? "").toLowerCase().includes(q),
      )
    : projects;

  const currentLabel = cwd
    ? projects.find((p) => p.path === cwd)?.id ?? cwd
    : null;

  return (
    <div className="relative flex flex-wrap items-center gap-2" ref={popRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="rounded px-2.5 py-1 text-[11.5px] transition-colors"
        style={{
          background: "var(--color-surface-3)",
          color: "var(--color-text-secondary)",
          border: "1px solid var(--color-border-strong)",
        }}
        title="Pick from registered projects or choose any directory"
      >
        {cwd ? "Change workspace" : "Choose workspace"}
      </button>
      {cwd && (
        <>
          <span
            className="truncate text-[11.5px]"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--color-text-secondary)",
              maxWidth: 380,
            }}
            title={cwd}
          >
            {currentLabel}
          </span>
          <button
            type="button"
            onClick={clear}
            className="text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            clear
          </button>
        </>
      )}

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-2 w-[420px] rounded shadow-lg"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
          }}
        >
          <div
            className="border-b px-3 py-2"
            style={{ borderColor: "var(--color-border)" }}
          >
            <input
              type="text"
              placeholder="Search projects…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
              className="w-full rounded px-2 py-1 text-[12px]"
              style={{
                background: "var(--color-surface-1)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
              }}
            />
          </div>

          <div className="max-h-72 overflow-auto px-2 py-2">
            <div
              className="px-2 pb-1 text-[10px] font-medium uppercase tracking-[0.06em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Registered projects {projects.length > 0 && `(${projects.length})`}
            </div>
            {filteredProjects.length === 0 && (
              <div
                className="px-2 py-3 text-[11.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {projects.length === 0
                  ? "No projects in registry. Run `ultron scan`."
                  : "No match."}
              </div>
            )}
            {filteredProjects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => pickProject(p)}
                disabled={!p.path}
                className="flex w-full items-baseline gap-3 rounded px-2 py-1.5 text-left transition-colors disabled:opacity-50"
                style={{
                  background: cwd === p.path ? "var(--color-surface-3)" : "transparent",
                }}
                onMouseEnter={(e) => {
                  if (cwd !== p.path)
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "var(--color-surface-2)";
                }}
                onMouseLeave={(e) => {
                  if (cwd !== p.path)
                    (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }}
              >
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-[12.5px] font-medium"
                    style={{ color: "var(--color-text)" }}
                  >
                    {p.id}
                  </div>
                  {p.path && (
                    <div
                      className="truncate text-[11.5px]"
                      style={{
                        fontFamily: "var(--font-mono)",
                        color: "var(--color-text-faint)",
                      }}
                    >
                      {p.path}
                    </div>
                  )}
                </div>
                {p.ide && (
                  <span
                    className="shrink-0 text-[10px]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {p.ide}
                  </span>
                )}
                {p.last_active && (
                  <span
                    className="shrink-0 tabular-nums text-[10px]"
                    style={{ color: "var(--color-text-faint)" }}
                  >
                    {p.last_active}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div
            className="flex items-center justify-between border-t px-3 py-2"
            style={{ borderColor: "var(--color-border)" }}
          >
            <button
              type="button"
              onClick={pickCustom}
              disabled={busy}
              className="rounded px-2 py-1 text-[11.5px] transition-colors disabled:opacity-50"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-secondary)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {busy ? "Opening…" : "Choose custom directory…"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider/model picker modal — shared by Custom and Send-Context flows
// ---------------------------------------------------------------------------

type LauncherModalProps = {
  /** "custom" launches a clean session; "send-context" pre-seeds a prompt
   *  asking the new session to continue from the prior session id. */
  mode: "custom" | "send-context";
  workspace: WorkspaceSummary;
  busy: boolean;
  onClose: () => void;
  onLaunch: (opts: { provider: SessionProvider; model: string }) => void;
};

function LauncherModal({
  mode,
  workspace,
  busy,
  onClose,
  onLaunch,
}: LauncherModalProps) {
  const [provider, setProvider] = useState<SessionProvider>("claude");
  const [model, setModel] = useState<string>(PROVIDERS.claude.defaultModel);

  // Close on Escape — matches the CardEditorModal pattern.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const headline = workspace.project_name ?? deriveWorkspaceName(workspace.cwd);
  const title =
    mode === "custom" ? "Custom launch" : "Send context to a new session";
  const launchLabel =
    mode === "custom" ? "Launch" : "Launch with context";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        // Click on backdrop closes; clicks inside the card stop here.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex w-full max-w-xl flex-col rounded-lg shadow-xl"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        <div
          className="flex items-center justify-between border-b px-4 py-2.5"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">{title}</div>
            <div
              className="mt-0.5 truncate text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
              title={workspace.cwd}
            >
              {headline}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="p-4">
          {mode === "send-context" && (
            <div
              className="mb-3 rounded p-2.5 text-[11.5px] leading-relaxed"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
              }}
            >
              Spawns a new session in this workspace seeded with a reference
              to{" "}
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "var(--color-text)",
                }}
              >
                {workspace.latest_session_id?.slice(0, 8) ?? "—"}
              </span>
              . The new session will receive a prompt asking it to load and
              continue context from that session.
            </div>
          )}

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2 text-[12px]">
              <span style={{ color: "var(--color-text-tertiary)" }}>Provider</span>
              <select
                value={provider}
                onChange={(e) => {
                  const p = e.target.value as SessionProvider;
                  setProvider(p);
                  setModel(PROVIDERS[p].defaultModel);
                }}
                className="rounded px-2 py-1 text-[12px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="gemini">Gemini</option>
              </select>
            </div>
            <div className="flex items-center gap-2 text-[12px]">
              <span style={{ color: "var(--color-text-tertiary)" }}>Model</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="rounded px-2 py-1 text-[12px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                {PROVIDERS[provider].models.map((m) => (
                  <option key={m.id || "default"} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div
          className="flex items-center justify-end gap-2 border-t px-4 py-2.5"
          style={{ borderColor: "var(--color-border)" }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1 text-[11.5px]"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onLaunch({ provider, model })}
            disabled={busy}
            className="rounded px-3 py-1 text-[11.5px] font-medium disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {launchLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace card — the headline UI
// ---------------------------------------------------------------------------

type WorkspaceCardProps = {
  ws: WorkspaceSummary;
  busy: boolean;
  onNew: (ws: WorkspaceSummary) => void;
  onCreateProject: (ws: WorkspaceSummary) => void;
  onCustom: (ws: WorkspaceSummary) => void;
  onSendContext: (ws: WorkspaceSummary) => void;
};

function WorkspaceCard({
  ws,
  busy,
  onNew,
  onCreateProject,
  onCustom,
  onSendContext,
}: WorkspaceCardProps) {
  const headline = ws.project_name ?? deriveWorkspaceName(ws.cwd);
  const canSendContext = !!ws.latest_session_id;

  return (
    <div
      className="flex h-full flex-col rounded-lg p-5 transition-colors"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <h3
            className="truncate text-[16px] font-semibold leading-tight"
            style={{ color: "var(--color-text)" }}
            title={headline}
          >
            {headline}
          </h3>
          {/* v2.5.2: provider badge — for now every workspace surfaced here
              is sourced from `~/.claude/projects/`, so the last provider is
              Claude. Future work can derive this from a per-workspace
              provider history. Colour is the Claude accent. */}
          <span
            className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border)",
            }}
            title="Last provider used in this workspace"
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: PROVIDERS.claude.accent }}
            />
            claude
          </span>
          {ws.project_id && (
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border)",
              }}
              title={`Registered as ${ws.project_id}`}
            >
              registered
            </span>
          )}
        </div>
        {/* v2.6 round 2: secondary line is the cwd only — the session id /
            epoch the user explicitly asked us to remove no longer appears. */}
        <div
          className="mt-1 truncate text-[11.5px]"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--color-text-faint)",
          }}
          title={ws.cwd}
        >
          {ws.cwd}
        </div>
        <div
          className="mt-2 flex items-center gap-3 text-[10.5px] tabular-nums"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          <span>{formatRel(ws.last_activity)}</span>
          <span>·</span>
          <span>
            {ws.session_count} session{ws.session_count === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {/* v2.6 round 2: "Continue" removed entirely — USER: "no me
            sirve". `claude -r <id>` resume lives in the All Sessions list. */}
        <button
          type="button"
          onClick={() => onNew(ws)}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
          title={`New Claude session in ${ws.cwd}`}
        >
          <Plus size={12} />
          New
        </button>
        {/* v2.6 round 2: Custom opens a MODAL — the card no longer grows
            inline with extra rows. */}
        <button
          type="button"
          onClick={() => onCustom(ws)}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Custom launch (provider + model) in this workspace"
        >
          Custom
        </button>
        {/* v2.6 round 2: Send Context also opens a MODAL. Disabled when
            there is no previous session id to reference. */}
        <button
          type="button"
          onClick={() => onSendContext(ws)}
          disabled={busy || !canSendContext}
          className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title={
            canSendContext
              ? `Start a new session pre-seeded with a reference to the latest session in this workspace`
              : "Need at least one prior session to send context from"
          }
        >
          Send Context →
        </button>
        {!ws.project_id && (
          <button
            type="button"
            onClick={() => onCreateProject(ws)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-[11.5px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Register this workspace as a project"
          >
            + Create Project
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workdays sub-tab (skeleton)
// ---------------------------------------------------------------------------

/** Shape mirrors `commands::workdays::Workday` on the Rust side. The
 *  backend currently returns an empty Vec — the UI renders a "Coming soon"
 *  state so USER can review the concept before we wire the aggregator. */
type Workday = {
  id: string;
  date: string;
  kind: string;
  project_id: string | null;
  title: string;
  minutes: number;
  session_count: number;
  agents_used: string[];
  kanban_changes: number;
  summary: string;
};

function WorkdaysPanel() {
  const [items, setItems] = useState<Workday[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    invoke<Workday[]>("workday_list", { limit: 50 })
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn("[Workdays] workday_list failed", e);
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div
        className="mb-4 rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div className="text-[13px] font-semibold">
          What is a "Workday"?
        </div>
        <p
          className="mt-1 text-[12px] leading-relaxed"
          style={{ color: "var(--color-text-secondary)" }}
        >
          A focused block of work in a single local day. ULTRON aggregates
          your Claude / Codex / Gemini sessions, the kanban cards you
          touched, the agents you invoked and the project you were on into
          one Workday entry — with computed duration, work kind
          (coding / research / admin / meeting / mixed) and a short summary.
        </p>
        <ul
          className="mt-3 grid grid-cols-1 gap-1.5 text-[11.5px] md:grid-cols-2"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          <li>
            <strong style={{ color: "var(--color-text-secondary)" }}>
              Time invested
            </strong>{" "}
            — derived from session transcript timestamps.
          </li>
          <li>
            <strong style={{ color: "var(--color-text-secondary)" }}>
              Project
            </strong>{" "}
            — inferred from the most-used cwd of the day.
          </li>
          <li>
            <strong style={{ color: "var(--color-text-secondary)" }}>
              Agents used
            </strong>{" "}
            — Terry, Don Claudio, Tolkien… counted per workday.
          </li>
          <li>
            <strong style={{ color: "var(--color-text-secondary)" }}>
              Kanban changes
            </strong>{" "}
            — cards created, moved or completed during the day.
          </li>
        </ul>
      </div>

      <div
        className="rounded p-6 text-center"
        style={{
          background: "var(--color-surface-2)",
          border: "1px dashed var(--color-border-strong)",
          color: "var(--color-text-tertiary)",
        }}
      >
        <div className="text-[13px] font-semibold">
          Coming soon · backend in research
        </div>
        <p className="mt-1 text-[12px]">
          {loading
            ? "Loading…"
            : items.length === 0
              ? "No workdays yet — the aggregator ships in a follow-up sprint (see card-v27-inv-workdays in the Investigar column)."
              : `Loaded ${items.length} workday${items.length === 1 ? "" : "s"}.`}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function Sessions() {
  const [tab, setTab] = useState<"sessions" | "workdays">("sessions");
  const [provider, setProvider] = useState<SessionProvider>("claude");
  const [model, setModel] = useState<string>(PROVIDERS["claude"].defaultModel);
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState<string>(() => loadCwd());
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [presets, setPresets] = useState<Presets>(() => loadPresets());
  const [history, setHistory] = useState<ClaudeSession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [showInline, setShowInline] = useState(false);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [search, setSearch] = useState("");
  const [busyCwd, setBusyCwd] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // v2.6 round 2: Custom + Send-Context modals live at the panel level so
  // only one is open at a time and the workspace card stays compact.
  const [modal, setModal] = useState<
    | { mode: "custom"; ws: WorkspaceSummary }
    | { mode: "send-context"; ws: WorkspaceSummary }
    | null
  >(null);

  // Toasts auto-dismiss after 3s. Single channel — newer messages replace
  // older ones, which is fine for the low-frequency operations on this page.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => saveCwd(cwd), [cwd]);
  useEffect(() => savePresets(presets), [presets]);

  // Load Claude session history once when the tab mounts. We cap at 50
  // entries — enough for the collapsible "All sessions" list without
  // dragging in the entire archive.
  function reloadHistory() {
    setHistoryLoading(true);
    invoke<ClaudeSession[]>("list_claude_sessions", { limit: 50 })
      .then((list) => {
        setHistory(list);
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn("[Sessions] list_claude_sessions failed", e);
        setHistory([]);
      })
      .finally(() => setHistoryLoading(false));
  }

  function reloadWorkspaces() {
    setWorkspacesLoading(true);
    invoke<WorkspaceSummary[]>("list_workspaces")
      .then((list) => {
        setWorkspaces(list);
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn("[Sessions] list_workspaces failed", e);
        setWorkspaces([]);
      })
      .finally(() => setWorkspacesLoading(false));
  }

  useEffect(() => {
    reloadHistory();
    reloadWorkspaces();
  }, []);

  // When provider changes, default the model to the provider's default.
  useEffect(() => {
    setModel(PROVIDERS[provider].defaultModel);
  }, [provider]);

  useEffect(() => {
    invoke<ProjectInfo[]>("list_projects")
      .then((list) => setProjects(list))
      .catch(() => setProjects([]));
  }, []);

  function flagsForProvider(extra: Partial<SpawnFlags> = {}): SpawnFlags {
    return {
      dangerouslySkipPermissions: presets.dangerouslySkipPermissions,
      effort: presets.effort ? presets.effort : null,
      model: model || null,
      ...extra,
    };
  }

  async function openSession(withPrompt: boolean) {
    setError(null);
    try {
      await invoke("spawn_session", {
        provider,
        prompt: withPrompt && prompt.trim() ? prompt : null,
        cwd: cwd || null,
        flags: flagsForProvider(),
      });
    } catch (e) {
      setError(String(e));
    }
  }

  async function resumeSession(s: ClaudeSession) {
    setError(null);
    try {
      // Sessions belong to a specific cwd (Claude indexes by it). We use the
      // recovered project_label as cwd so the new wt.exe tab lands in the
      // same directory before -r resolves the session.
      await invoke("spawn_session", {
        provider: "claude",
        prompt: null,
        cwd: s.project_label,
        flags: flagsForProvider({ resumeId: s.id }),
      });
    } catch (e) {
      setError(String(e));
    }
  }

  // -------------------------------------------------------------------------
  // Workspace card actions
  // -------------------------------------------------------------------------

  async function newInWorkspace(ws: WorkspaceSummary) {
    setBusyCwd(ws.cwd);
    setError(null);
    try {
      await invoke("spawn_session", {
        provider: "claude",
        prompt: null,
        cwd: ws.cwd,
        flags: {},
      });
      setToast(`New session in ${deriveWorkspaceName(ws.cwd)}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyCwd(null);
    }
  }

  // v2.6 round 2: custom launch from MODAL.
  async function customInWorkspace(
    ws: WorkspaceSummary,
    opts: { provider: SessionProvider; model: string },
  ) {
    setBusyCwd(ws.cwd);
    setError(null);
    try {
      await invoke("spawn_session", {
        provider: opts.provider,
        prompt: null,
        cwd: ws.cwd,
        flags: { model: opts.model || null },
      });
      const modelLabel = opts.model ? ` (${opts.model})` : "";
      setToast(
        `${opts.provider}${modelLabel} session in ${deriveWorkspaceName(ws.cwd)}`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyCwd(null);
    }
  }

  // v2.5.2: spawn a new session in the workspace seeded with a prompt
  // that references the previous session id. The backend doesn't (yet)
  // support `--context-from-session=<id>` natively, so this is the simple
  // version: pass a textual prompt asking the assistant to load and
  // continue context from the named session.
  async function sendContextFromWorkspace(
    ws: WorkspaceSummary,
    opts: { provider: SessionProvider; model: string },
  ) {
    if (!ws.latest_session_id) return;
    setBusyCwd(ws.cwd);
    setError(null);
    try {
      const seed = [
        `Continuing context from session: ${ws.latest_session_id}.`,
        `Workspace: ${ws.cwd}.`,
        `Please load the prior transcript (look under ~/.claude/projects/) and continue from where it left off.`,
      ].join(" ");
      await invoke("spawn_session", {
        provider: opts.provider,
        prompt: seed,
        cwd: ws.cwd,
        flags: { model: opts.model || null },
      });
      const modelLabel = opts.model ? ` (${opts.model})` : "";
      setToast(
        `Sent context to new ${opts.provider}${modelLabel} session in ${deriveWorkspaceName(ws.cwd)}`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyCwd(null);
    }
  }

  async function createProjectFromWorkspace(ws: WorkspaceSummary) {
    // Navigate to Projects tab or simply register via invoke.
    // For now we open the Projects tab so the user can fill in the form.
    setToast(`Go to Projects tab to register "${deriveWorkspaceName(ws.cwd)}"`);
  }

  // -------------------------------------------------------------------------
  // Search / filtering
  // -------------------------------------------------------------------------

  const normalisedSearch = search.trim().toLowerCase();
  const filteredWorkspaces = useMemo(() => {
    if (!normalisedSearch) return workspaces;
    return workspaces.filter((w) => {
      const name = (w.project_name ?? deriveWorkspaceName(w.cwd)).toLowerCase();
      return (
        name.includes(normalisedSearch) ||
        w.cwd.toLowerCase().includes(normalisedSearch) ||
        (w.project_id ?? "").toLowerCase().includes(normalisedSearch)
      );
    });
  }, [workspaces, normalisedSearch]);

  // v2.5.2: group workspaces by registered project id when possible, and
  // by the cwd parent directory tail otherwise. Only collapse groups that
  // hold >5 cards — small groups stay flat so the grid still feels like
  // one continuous wall of recent work.
  const GROUP_THRESHOLD = 5;
  const grouped = useMemo(() => {
    const groups = new Map<string, { label: string; items: WorkspaceSummary[] }>();
    for (const ws of filteredWorkspaces) {
      let key: string;
      let label: string;
      if (ws.project_id) {
        const head = ws.project_id.split(/[-_]/, 1)[0] ?? ws.project_id;
        key = `project:${head}`;
        label = head;
      } else {
        const cleaned = ws.cwd.replace(/[\\/]+$/, "");
        const parts = cleaned.split(/[\\/]/).filter(Boolean);
        const tail = parts[parts.length - 2] ?? parts[parts.length - 1] ?? ws.cwd;
        key = `cwd:${tail.toLowerCase()}`;
        label = tail;
      }
      const entry = groups.get(key) ?? { label, items: [] };
      entry.items.push(ws);
      groups.set(key, entry);
    }
    const ungrouped: WorkspaceSummary[] = [];
    const collapsible: { key: string; label: string; items: WorkspaceSummary[] }[] = [];
    for (const [key, value] of groups) {
      if (value.items.length > GROUP_THRESHOLD) {
        collapsible.push({ key, label: value.label, items: value.items });
      } else {
        ungrouped.push(...value.items);
      }
    }
    return { ungrouped, collapsible };
  }, [filteredWorkspaces]);

  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const filteredHistory = useMemo(() => {
    if (!normalisedSearch) return history;
    return history.filter((s) => {
      return (
        s.project_label.toLowerCase().includes(normalisedSearch) ||
        s.id.toLowerCase().includes(normalisedSearch) ||
        (s.preview ?? "").toLowerCase().includes(normalisedSearch)
      );
    });
  }, [history, normalisedSearch]);

  const meta = PROVIDERS[provider];

  return (
    <div className="px-10 py-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">
            Workspaces &amp; sessions
          </h1>
          <p
            className="mt-1 text-[13px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Pick a recent workspace to start a fresh Claude session — or
            switch to Workdays to see your day-level activity.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tab === "sessions" && (
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter workspaces & sessions…"
              className="rounded px-3 py-1.5 text-[12px]"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
                width: 280,
              }}
            />
          )}
          <button
            type="button"
            onClick={() => {
              reloadWorkspaces();
              reloadHistory();
            }}
            className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-[11.5px] transition-colors"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Refresh workspaces and session list"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>
      </header>

      {/* v2.6 round 2: sub-tab switch (Sessions / Workdays). */}
      <div
        className="mb-5 inline-flex rounded p-0.5"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        {(["sessions", "workdays"] as const).map((t) => {
          const isActive = tab === t;
          const label = t === "sessions" ? "Sessions" : "Workdays";
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className="rounded px-3 py-1 text-[12px] font-medium transition-colors"
              style={{
                background: isActive ? "var(--color-surface-3)" : "transparent",
                color: isActive
                  ? "var(--color-text)"
                  : "var(--color-text-tertiary)",
              }}
            >
              {label}
              {t === "workdays" && (
                <span
                  className="ml-2 rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-text-tertiary)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  preview
                </span>
              )}
            </button>
          );
        })}
      </div>

      {toast && (
        <div
          className="fixed bottom-6 right-6 z-[80] rounded px-3 py-2 text-[12px] shadow-lg"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {toast}
        </div>
      )}

      {error && (
        <div
          className="mb-4 rounded px-3 py-2 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.08)",
            border: "1px solid rgba(248, 81, 73, 0.32)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {tab === "workdays" && <WorkdaysPanel />}

      {tab === "sessions" && (
        <>
          {/* ------------------------------------------------------------------
              Section 1 — Recent workspaces (the new headline)
              ------------------------------------------------------------------ */}
          <section className="mb-6">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-[14px] font-semibold leading-tight">
                Recent workspaces
              </h2>
              <span
                className="text-[11.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {workspacesLoading
                  ? "Loading…"
                  : `${filteredWorkspaces.length} of ${workspaces.length}`}
              </span>
            </div>

            {!workspacesLoading && workspaces.length === 0 && (
              <div
                className="rounded p-6 text-center text-[12.5px]"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-tertiary)",
                }}
              >
                No Claude workspaces yet. Open a Claude session in any folder and
                it will appear here automatically.
              </div>
            )}

            {!workspacesLoading && workspaces.length > 0 && filteredWorkspaces.length === 0 && (
              <div
                className="rounded p-6 text-center text-[12.5px]"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-tertiary)",
                }}
              >
                No workspace matches "{search}".
              </div>
            )}

            {grouped.ungrouped.length > 0 && (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {grouped.ungrouped.map((ws) => (
                  <WorkspaceCard
                    key={ws.cwd}
                    ws={ws}
                    busy={busyCwd === ws.cwd}
                    onNew={newInWorkspace}
                    onCustom={(w) => setModal({ mode: "custom", ws: w })}
                    onSendContext={(w) =>
                      setModal({ mode: "send-context", ws: w })
                    }
                    onCreateProject={createProjectFromWorkspace}
                  />
                ))}
              </div>
            )}

            {grouped.collapsible.map((g) => {
              const isOpen = openGroups.has(g.key);
              return (
                <div key={g.key} className="mt-4">
                  <button
                    type="button"
                    onClick={() => {
                      setOpenGroups((prev) => {
                        const next = new Set(prev);
                        if (next.has(g.key)) next.delete(g.key);
                        else next.add(g.key);
                        return next;
                      });
                    }}
                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors"
                    style={{
                      background: "var(--color-surface-2)",
                      border: "1px solid var(--color-border)",
                    }}
                  >
                    <span
                      className="inline-block text-[12px]"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {isOpen ? "▾" : "▸"}
                    </span>
                    <span className="text-[12.5px] font-semibold">{g.label}</span>
                    <span
                      className="text-[11.5px]"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {g.items.length} workspaces
                    </span>
                    <span
                      className="ml-auto text-[11.5px]"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {isOpen ? "hide" : "show"}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                      {g.items.map((ws) => (
                        <WorkspaceCard
                          key={ws.cwd}
                          ws={ws}
                          busy={busyCwd === ws.cwd}
                          onNew={newInWorkspace}
                          onCustom={(w) =>
                            setModal({ mode: "custom", ws: w })
                          }
                          onSendContext={(w) =>
                            setModal({ mode: "send-context", ws: w })
                          }
                          onCreateProject={createProjectFromWorkspace}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </section>

          {/* ------------------------------------------------------------------
              Section 2 — Collapsible: All Claude sessions
              Kept hidden by default (toggled via internal state, not shown
              in the UI for now). Power-user resume lives here.
              ------------------------------------------------------------------ */}
          <section className="mb-6" style={{ display: "none" }}>
            <button
              type="button"
              onClick={() => setShowAllSessions(!showAllSessions)}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <History size={13} />
              <span className="text-[12.5px] font-semibold">
                All Claude sessions
              </span>
              <span
                className="text-[11.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {historyLoading
                  ? "loading…"
                  : `${filteredHistory.length} of ${history.length}`}
              </span>
              <span
                className="ml-auto text-[11.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {showAllSessions ? "hide" : "show"}
              </span>
            </button>

            {showAllSessions && (
              <div
                className="mt-2 rounded p-4"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {!historyLoading && filteredHistory.length === 0 && (
                  <div
                    className="rounded p-4 text-center text-[12px]"
                    style={{
                      background: "var(--color-surface-1)",
                      border: "1px solid var(--color-border)",
                      color: "var(--color-text-tertiary)",
                    }}
                  >
                    {history.length === 0
                      ? "No sessions recorded yet."
                      : `No session matches "${search}".`}
                  </div>
                )}
                <div className="space-y-1.5">
                  {filteredHistory.map((s) => (
                    <div
                      key={`${s.project_slug}-${s.id}`}
                      className="rounded p-3 transition-colors"
                      style={{
                        background: "var(--color-surface-1)",
                        border: "1px solid var(--color-border)",
                      }}
                    >
                      <div className="flex items-baseline gap-3">
                        <span
                          className="truncate text-[11.5px]"
                          style={{
                            fontFamily: "var(--font-mono)",
                            color: "var(--color-text-tertiary)",
                          }}
                          title={s.project_label}
                        >
                          {s.project_label}
                        </span>
                        <span
                          className="ml-auto shrink-0 tabular-nums text-[10.5px]"
                          style={{ color: "var(--color-text-faint)" }}
                        >
                          {formatRel(s.last_activity)} · {s.line_count} turns ·{" "}
                          {formatBytes(s.size_bytes)}
                        </span>
                        <button
                          type="button"
                          onClick={() => resumeSession(s)}
                          className="shrink-0 rounded px-2 py-0.5 text-[11.5px] font-medium transition-colors"
                          style={{
                            background: "var(--color-accent)",
                            color: "var(--color-accent-text)",
                          }}
                          title={`claude -r ${s.id}`}
                        >
                          Resume
                        </button>
                      </div>
                      {s.preview && (
                        <div
                          className="mt-1 line-clamp-2 text-[12px] leading-relaxed"
                          style={{ color: "var(--color-text-secondary)" }}
                        >
                          {s.preview}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* ------------------------------------------------------------------
              Section 3 — Advanced launch (hidden, retained for future use)
              ------------------------------------------------------------------ */}
          <section style={{ display: "none" }}>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <span className="text-[12.5px] font-semibold">
                Advanced launch
              </span>
              <span
                className="text-[11.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                provider · model · presets · quick prompt
              </span>
              <span
                className="ml-auto text-[11.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {showAdvanced ? "hide" : "show"}
              </span>
            </button>

            {showAdvanced && (
              <section
                className="mt-2 rounded p-5"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                }}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <ProviderTabs active={provider} onChange={setProvider} />
                  <WorkspacePicker
                    cwd={cwd}
                    onChange={setCwd}
                    projects={projects}
                  />
                </div>

                {meta.acceptsModel && (
                  <div className="mt-4 flex items-center gap-3">
                    <label
                      className="text-[11.5px]"
                      style={{ color: "var(--color-text-tertiary)" }}
                      htmlFor="provider-model"
                    >
                      Model
                    </label>
                    <select
                      id="provider-model"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="rounded px-2 py-1 text-[12px]"
                      style={{
                        background: "var(--color-surface-1)",
                        color: "var(--color-text)",
                        border: "1px solid var(--color-border-strong)",
                      }}
                    >
                      {meta.models.map((m) => (
                        <option key={m.id || "default"} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div
                  className="mt-4 rounded p-4"
                  style={{
                    background: "var(--color-surface-1)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  <div
                    className="text-[10px] font-medium uppercase tracking-[0.06em]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Presets · applied on launch and remembered across sessions
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                    <label
                      className="flex items-start gap-2 rounded p-2.5 transition-colors"
                      style={{
                        background: presets.dangerouslySkipPermissions
                          ? "rgba(248, 81, 73, 0.06)"
                          : "var(--color-surface-2)",
                        border: `1px solid ${
                          presets.dangerouslySkipPermissions
                            ? "rgba(248, 81, 73, 0.22)"
                            : "var(--color-border)"
                        }`,
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={presets.dangerouslySkipPermissions}
                        onChange={(e) =>
                          setPresets({
                            ...presets,
                            dangerouslySkipPermissions: e.target.checked,
                          })
                        }
                        className="mt-0.5 h-3.5 w-3.5"
                      />
                      <div className="min-w-0">
                        <div
                          className="text-[12.5px] font-medium"
                          style={{
                            color: presets.dangerouslySkipPermissions
                              ? "var(--color-danger)"
                              : "var(--color-text)",
                          }}
                        >
                          --dangerously-skip-permissions
                        </div>
                        <div
                          className="mt-0.5 text-[11.5px]"
                          style={{ color: "var(--color-text-tertiary)" }}
                        >
                          Skip every tool confirmation. Only in trusted
                          environments.
                        </div>
                      </div>
                    </label>

                    <div>
                      <label
                        className="block text-[10px] uppercase tracking-wide"
                        style={{ color: "var(--color-text-tertiary)" }}
                        htmlFor="effort-select"
                      >
                        --effort
                      </label>
                      <select
                        id="effort-select"
                        value={presets.effort}
                        onChange={(e) =>
                          setPresets({
                            ...presets,
                            effort: e.target.value as Presets["effort"],
                          })
                        }
                        className="mt-1 w-full rounded px-2 py-1 text-[12px]"
                        style={{
                          background: "var(--color-surface-2)",
                          color: "var(--color-text)",
                          border: "1px solid var(--color-border-strong)",
                        }}
                      >
                        <option value="">default</option>
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                        <option value="xhigh">xhigh</option>
                        <option value="max">max</option>
                      </select>
                    </div>
                  </div>

                  <div
                    className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    <button
                      type="button"
                      onClick={() => openSession(false)}
                      className="rounded px-4 py-2 text-[13px] font-semibold transition-colors"
                      style={{
                        background: "var(--color-accent)",
                        color: "var(--color-accent-text)",
                      }}
                      title={`Launch a clean ${meta.label} session in ${cwd || "(no workspace)"}`}
                    >
                      New Session
                    </button>
                    <span
                      className="ml-auto text-[11.5px]"
                      style={{ color: "var(--color-text-faint)" }}
                    >
                      cwd: {cwd || "(none)"}
                    </span>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setShowInline(!showInline)}
                    className="text-[11.5px] transition-colors"
                    style={{ color: "var(--color-text-tertiary)" }}
                    title="Inline mode: run a batch prompt without opening a terminal"
                  >
                    {showInline ? "Hide quick prompt" : "Show quick prompt"}
                  </button>
                </div>

                {showInline && (
                  <>
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder={`Prompt for ${meta.label}…  (Ctrl+Enter to open session with prompt)`}
                      rows={6}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                          e.preventDefault();
                          if (prompt.trim()) openSession(true);
                        }
                      }}
                      className="mt-3 w-full rounded px-3 py-2 text-[12.5px] leading-relaxed"
                      style={{
                        background: "var(--color-surface-1)",
                        color: "var(--color-text)",
                        border: "1px solid var(--color-border-strong)",
                        fontFamily: "var(--font-mono)",
                        outline: "none",
                        resize: "vertical",
                      }}
                    />

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => openSession(true)}
                        disabled={!prompt.trim()}
                        className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
                        style={{
                          background: "var(--color-accent)",
                          color: "var(--color-accent-text)",
                        }}
                        title="Open a new terminal session pre-populated with this prompt"
                      >
                        Open session with prompt
                      </button>
                      <div className="ml-auto flex gap-2">
                        <button
                          type="button"
                          onClick={() => setPrompt("")}
                          className="rounded px-2 py-1.5 text-[11.5px] transition-colors"
                          style={{
                            background: "transparent",
                            color: "var(--color-text-tertiary)",
                            border: "1px solid var(--color-border-strong)",
                          }}
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </section>
            )}
          </section>
        </>
      )}

      {/* v2.6 round 2: Custom / Send-Context modal — single instance at the
          panel level. Cards delegate via setModal(...). */}
      {modal && (
        <LauncherModal
          mode={modal.mode}
          workspace={modal.ws}
          busy={busyCwd === modal.ws.cwd}
          onClose={() => setModal(null)}
          onLaunch={(opts) => {
            const ws = modal.ws;
            const m = modal.mode;
            setModal(null);
            if (m === "custom") {
              void customInWorkspace(ws, opts);
            } else {
              void sendContextFromWorkspace(ws, opts);
            }
          }}
        />
      )}
    </div>
  );
}
