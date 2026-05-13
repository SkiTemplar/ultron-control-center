import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { InlineResult, ProjectInfo, SessionProvider } from "../types";

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
  const [output, setOutput] = useState<InlineResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);

  useEffect(() => saveCwd(cwd), [cwd]);

  // When provider changes, default the model to the provider's default.
  useEffect(() => {
    setModel(PROVIDERS[provider].defaultModel);
    setOutput(null);
  }, [provider]);

  useEffect(() => {
    invoke<ProjectInfo[]>("list_projects")
      .then((list) => setProjects(list))
      .catch(() => setProjects([]));
  }, []);

  async function runInline() {
    if (!prompt.trim()) return;
    setRunning(true);
    setError(null);
    setOutput(null);
    try {
      const r = (await invoke("run_inline", {
        provider,
        model: model || null,
        prompt,
      })) as InlineResult;
      setOutput(r);
    } catch (e) {
      setOutput({
        success: false,
        stdout: "",
        stderr: String(e),
        exit_code: null,
      });
    } finally {
      setRunning(false);
    }
  }

  async function openSession(withPrompt: boolean) {
    setError(null);
    try {
      await invoke("spawn_session", {
        provider,
        prompt: withPrompt && prompt.trim() ? prompt : null,
        cwd: cwd || null,
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
          Quick prompts inline · open interactive CLI session with optional workspace
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

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={`Prompt for ${meta.label}…  (Ctrl+Enter to run inline)`}
          rows={6}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              runInline();
            }
          }}
          className="mt-4 w-full rounded px-3 py-2 text-[12.5px] leading-relaxed"
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
            onClick={runInline}
            disabled={running || !prompt.trim()}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {running ? "Running…" : "Run inline"}
          </button>
          <button
            type="button"
            onClick={() => openSession(true)}
            disabled={!prompt.trim()}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Open a new terminal session pre-populated with this prompt"
          >
            Open session with prompt
          </button>
          <button
            type="button"
            onClick={() => openSession(false)}
            className="rounded px-3 py-1.5 text-[12px] transition-colors"
            style={{
              background: "transparent",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Open an empty interactive session (no prompt sent)"
          >
            Open empty session
          </button>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => {
                setPrompt("");
                setOutput(null);
              }}
              disabled={running}
              className="rounded px-2 py-1.5 text-[11px] transition-colors"
              style={{
                background: "transparent",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              Clear
            </button>
            {output && output.stdout && (
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(output.stdout)}
                className="rounded px-2 py-1.5 text-[11px] transition-colors"
                style={{
                  background: "transparent",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                Copy output
              </button>
            )}
          </div>
        </div>

        {error && (
          <p className="mt-3 text-[11.5px]" style={{ color: "var(--color-danger)" }}>
            {error}
          </p>
        )}

        {output && (
          <pre
            className="mt-4 max-h-[420px] overflow-auto rounded p-3 text-[11.5px] leading-relaxed"
            style={{
              background: "var(--color-surface-1)",
              border: `1px solid ${output.success ? "var(--color-border)" : "rgba(248, 81, 73, 0.22)"}`,
              fontFamily: "var(--font-mono)",
              color: output.success ? "var(--color-text)" : "var(--color-danger)",
              whiteSpace: "pre-wrap",
            }}
          >
            {output.stdout || output.stderr || "(no output)"}
            {output.exit_code !== null && output.exit_code !== 0 && (
              <div className="mt-2" style={{ color: "var(--color-text-tertiary)" }}>
                — exit {output.exit_code}
              </div>
            )}
          </pre>
        )}
      </section>
    </div>
  );
}
