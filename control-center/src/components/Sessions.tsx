import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  ClaudeSession,
  ProjectInfo,
  SessionProvider,
  SpawnFlags,
} from "../types";

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
// Workspace chip
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

  // Close on outside click.
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

  // Filter projects by search; show last_active first (already sorted in Rust).
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
            className="truncate text-[11px]"
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
            className="text-[11px]"
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
                      className="truncate text-[10.5px]"
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
              className="text-[11px]"
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
// Main panel
// ---------------------------------------------------------------------------

export function Sessions() {
  const [provider, setProvider] = useState<SessionProvider>("claude");
  const [model, setModel] = useState<string>(PROVIDERS["claude"].defaultModel);
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState<string>(() => loadCwd());
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [presets, setPresets] = useState<Presets>(() => loadPresets());
  const [history, setHistory] = useState<ClaudeSession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [showInline, setShowInline] = useState(false);

  useEffect(() => saveCwd(cwd), [cwd]);
  useEffect(() => savePresets(presets), [presets]);

  // Load Claude session history once when the tab mounts. We cap at 25
  // entries so the panel doesn't drown in old transcripts.
  useEffect(() => {
    if (provider !== "claude") return;
    let cancelled = false;
    setHistoryLoading(true);
    invoke<ClaudeSession[]>("list_claude_sessions", { limit: 25 })
      .then((list) => {
        if (!cancelled) setHistory(list);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  // When provider changes, default the model to the provider's default.
  useEffect(() => {
    setModel(PROVIDERS[provider].defaultModel);
  }, [provider]);

  useEffect(() => {
    invoke<ProjectInfo[]>("list_projects")
      .then((list) => setProjects(list))
      .catch(() => setProjects([]));
  }, []);


  function flagsForProvider(extra: Partial<SpawnFlags> = {}): SpawnFlags | null {
    if (provider !== "claude") return null;
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


  const meta = PROVIDERS[provider];

  return (
    <div className="px-10 py-8">
      <header className="mb-6">
        <h1 className="text-[20px] font-semibold leading-tight">Sessions</h1>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
          Abre una sesión Claude/Gemini/Codex en el workspace activo, o reanuda
          una anterior. Los botones primarios están abajo, dentro del bloque
          de presets.
        </p>
      </header>

      <section
        className="rounded p-5"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        {/* Provider tabs + workspace + model */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ProviderTabs active={provider} onChange={setProvider} />
          <WorkspacePicker cwd={cwd} onChange={setCwd} projects={projects} />
        </div>

        {meta.acceptsModel && (
          <div className="mt-4 flex items-center gap-3">
            <label
              className="text-[11px]"
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

        {/* Session presets — only relevant for claude. Other providers ignore. */}
        {provider === "claude" && (
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
              Presets · se aplican al lanzar y se recuerdan entre sesiones
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
                    className="mt-0.5 text-[11px]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Saltar todas las confirmaciones de herramientas. Solo en
                    entornos de confianza.
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

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4"
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
                title={`Lanza una sesión Claude limpia en ${cwd || "(no workspace)"}`}
              >
                New Session
              </button>
              <button
                type="button"
                onClick={() => {
                  document
                    .getElementById("session-history")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className="rounded px-4 py-2 text-[13px] font-semibold transition-colors"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
                title="Salta a la lista de sesiones existentes en este workspace"
              >
                Resume Session
              </button>
              <span
                className="ml-auto text-[10.5px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                cwd: {cwd || "(none)"}
              </span>
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setShowInline(!showInline)}
            className="text-[11px] transition-colors"
            style={{ color: "var(--color-text-tertiary)" }}
            title="Modo inline: ejecuta un prompt batch sin abrir terminal — útil para queries one-shot"
          >
            {showInline ? "Hide quick prompt" : "Show quick prompt"}
          </button>
        </div>

        {showInline && (<>
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
              className="rounded px-2 py-1.5 text-[11px] transition-colors"
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

        {error && (
          <p className="mt-3 text-[11.5px]" style={{ color: "var(--color-danger)" }}>
            {error}
          </p>
        )}

        </>)}
      </section>

      {/* Recent Claude sessions — resumable. Auto-filtered to the selected
       * workspace cwd when there is one, otherwise shows everything. */}
      {provider === "claude" && (() => {
        const normalisedCwd = cwd ? cwd.replace(/\\/g, "/").toLowerCase() : "";
        const filteredHistory = !normalisedCwd
          ? history
          : history.filter((s) =>
              s.project_label
                .replace(/\\/g, "/")
                .toLowerCase()
                .startsWith(normalisedCwd),
            );
        return (
        <section
          id="session-history"
          className="mt-6 rounded p-5"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div className="mb-3 flex items-baseline justify-between">
            <div>
              <h2 className="text-[14px] font-semibold leading-tight">
                Sessions {normalisedCwd ? "in this workspace" : "across all workspaces"}
              </h2>
              <p
                className="mt-0.5 text-[11.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {filteredHistory.length} / {history.length} listadas · click Resume para reanudar (claude -r &lt;id&gt;)
              </p>
            </div>
            {historyLoading && (
              <span className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
                Loading…
              </span>
            )}
          </div>

          {!historyLoading && filteredHistory.length === 0 && (
            <div
              className="rounded p-6 text-center text-[12.5px]"
              style={{
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-tertiary)",
              }}
            >
              {normalisedCwd
                ? "No hay sesiones registradas para este workspace. Pulsa New Session para abrir una."
                : "Aún no hay sesiones registradas. Abre una con Claude y volverá a listarse aquí."}
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
                    className="truncate text-[11px]"
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
                    className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium transition-colors"
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
                <div
                  className="mt-1 truncate text-[10px]"
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-text-faint)",
                  }}
                >
                  {s.id}
                </div>
              </div>
            ))}
          </div>
        </section>
        );
      })()}
    </div>
  );
}
