// Catalog sub-tab — v2.9.5 (P1 AI-driven install).
//
// Changes vs v2.6.2:
//   - "Install" button renamed to "Install via AI". Triggers library_install_via_ai
//     (backend: clone → read files → AI Router analysis → JSON report).
//   - Pre-execution modal: shows the InstallReport (compatible, steps,
//     copy_files, warnings) + dry-run checkbox + Confirm/Cancel buttons.
//   - If AI Router has no usable provider, falls back to clipboard-copy with
//     a visible warning banner ("AI unavailable — URL copied").
//   - All previous search/tab/trending behaviour is preserved unchanged.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  Bot,
  Check,
  Clipboard,
  Compass,
  ExternalLink,
  Github,
  Loader,
  Search,
  Sparkles,
  X,
} from "./icons";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RepoHit = {
  full_name: string;
  owner: string;
  name: string;
  description: string | null;
  stars: number;
  language: string | null;
  html_url: string | null;
  updated_at: string | null;
  topics: string[];
};

type SearchTab = "trending" | "skills" | "agents" | "rules" | "mcps" | "repos";

/** One shell step returned by the AI report. */
type InstallStep = { cmd: string; cwd: string };

/** One file copy returned by the AI report. */
type CopyFile = { from: string; to: string };

/** Structured JSON report that the AI produces. */
type InstallReport = {
  compatible: boolean;
  reason: string;
  install_type: string;
  steps: InstallStep[];
  copy_files: CopyFile[];
  warnings: string[];
};

/** Full result from `library_install_via_ai`. */
type AiInstallResult = {
  ai_available: boolean;
  report: InstallReport | null;
  executed: boolean;
  installed_paths: string[];
  errors: string[];
};

/** UI state for the install modal. */
type InstallModalState =
  | { phase: "idle" }
  | { phase: "analysing"; repoUrl: string }
  | { phase: "preview"; repoUrl: string; result: AiInstallResult }
  | { phase: "executing"; repoUrl: string }
  | { phase: "done"; repoUrl: string; result: AiInstallResult };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABS: { id: SearchTab; label: string; hint: string }[] = [
  { id: "trending", label: "Trending", hint: "Recent claude-flavoured repos" },
  { id: "skills", label: "Skills", hint: "topic:claude-skill" },
  { id: "agents", label: "Agents", hint: "topic:claude-agent" },
  { id: "rules", label: "Rules", hint: "topic:claude-rules" },
  { id: "mcps", label: "MCPs", hint: "topic:mcp-server" },
  { id: "repos", label: "Repos", hint: "Free-text repo search" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

function queryForTab(tab: SearchTab, raw: string): string {
  const q = raw.trim();
  switch (tab) {
    case "skills":
      return q ? `${q} topic:claude-skill` : "topic:claude-skill stars:>5 sort:updated";
    case "agents":
      return q ? `${q} topic:claude-agent` : "topic:claude-agent stars:>5 sort:updated";
    case "rules":
      return q ? `${q} topic:claude-rules` : "topic:claude-rules stars:>1 sort:updated";
    case "mcps":
      return q ? `${q} topic:mcp-server` : "topic:mcp-server stars:>10 sort:updated";
    case "repos":
      return q || "claude-code stars:>20 sort:updated";
    case "trending":
      return q;
  }
}

function repoUrl(hit: RepoHit): string {
  return hit.html_url ?? `https://github.com/${hit.full_name}`;
}

// ---------------------------------------------------------------------------
// InstallModal
// ---------------------------------------------------------------------------

type InstallModalProps = {
  state: InstallModalState;
  onConfirm: (dryRun: boolean) => void;
  onClose: () => void;
};

function InstallModal({ state, onConfirm, onClose }: InstallModalProps) {
  const [dryRun, setDryRun] = useState(false);

  if (state.phase === "idle") return null;

  const report = "result" in state ? state.result?.report : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative mx-4 flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border shadow-xl"
        style={{
          background: "var(--color-surface)",
          borderColor: "var(--color-border-strong)",
          color: "var(--color-text)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b px-4 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <Bot size={14} />
            Install via AI
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:opacity-70"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 text-[12.5px]">
          {/* Analysing */}
          {state.phase === "analysing" && (
            <div
              className="flex items-center gap-2"
              style={{ color: "var(--color-text-secondary)" }}
            >
              <Loader size={13} className="animate-spin" />
              Cloning repo and analysing with AI…
            </div>
          )}

          {/* Executing */}
          {state.phase === "executing" && (
            <div
              className="flex items-center gap-2"
              style={{ color: "var(--color-text-secondary)" }}
            >
              <Loader size={13} className="animate-spin" />
              Executing install steps…
            </div>
          )}

          {/* Preview */}
          {state.phase === "preview" && state.result && (
            <PreviewBody result={state.result} dryRun={dryRun} onToggleDryRun={setDryRun} />
          )}

          {/* Done */}
          {state.phase === "done" && state.result && (
            <DoneBody result={state.result} />
          )}
        </div>

        {/* Footer */}
        {(state.phase === "preview" || state.phase === "done") && (
          <div
            className="flex items-center justify-end gap-2 border-t px-4 py-3"
            style={{ borderColor: "var(--color-border)" }}
          >
            {state.phase === "preview" && (
              <>
                <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] select-none"
                  style={{ color: "var(--color-text-secondary)" }}>
                  <input
                    type="checkbox"
                    checked={dryRun}
                    onChange={(e) => setDryRun(e.target.checked)}
                    className="h-3 w-3"
                  />
                  Dry-run only
                </label>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border px-3 py-1.5 text-[12px]"
                  style={{
                    borderColor: "var(--color-border-strong)",
                    background: "var(--color-surface-2)",
                    color: "var(--color-text)",
                  }}
                >
                  Cancel
                </button>
                {report?.compatible !== false && (
                  <button
                    type="button"
                    onClick={() => onConfirm(dryRun)}
                    className="rounded-md px-3 py-1.5 text-[12px] font-medium"
                    style={{
                      background: "var(--color-accent)",
                      color: "var(--color-accent-text)",
                    }}
                  >
                    {dryRun ? "Preview steps" : "Confirm install"}
                  </button>
                )}
              </>
            )}
            {state.phase === "done" && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border px-3 py-1.5 text-[12px]"
                style={{
                  borderColor: "var(--color-border-strong)",
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                }}
              >
                Close
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PreviewBody — shown in the modal before execution
// ---------------------------------------------------------------------------

type PreviewBodyProps = {
  result: AiInstallResult;
  dryRun: boolean;
  onToggleDryRun: (v: boolean) => void;
};

function PreviewBody({ result }: PreviewBodyProps) {
  const { report } = result;

  if (!result.ai_available) {
    return (
      <div
        className="rounded-md border p-3"
        style={{
          background: "rgba(248,81,73,0.06)",
          borderColor: "rgba(248,81,73,0.22)",
          color: "var(--color-danger)",
        }}
      >
        <div className="mb-1 flex items-center gap-2 font-medium">
          <AlertTriangle size={13} />
          AI Router unavailable
        </div>
        <p style={{ color: "var(--color-text-secondary)" }}>
          No AI provider with a valid API key is configured. The URL has been
          copied to your clipboard — you can install manually.
        </p>
        {result.errors.length > 0 && (
          <ul className="mt-2 list-disc pl-4 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
            {result.errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        )}
      </div>
    );
  }

  if (!report) {
    return (
      <p style={{ color: "var(--color-text-secondary)" }}>
        No report received from AI.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* Compatibility badge */}
      <div
        className="flex items-center gap-2 rounded-md border px-3 py-2"
        style={{
          background: report.compatible
            ? "rgba(63,185,80,0.07)"
            : "rgba(248,81,73,0.07)",
          borderColor: report.compatible
            ? "rgba(63,185,80,0.25)"
            : "rgba(248,81,73,0.25)",
          color: report.compatible ? "var(--color-success)" : "var(--color-danger)",
        }}
      >
        {report.compatible ? <Check size={13} /> : <AlertTriangle size={13} />}
        <span className="font-medium">
          {report.compatible ? "Compatible" : "Incompatible"}
        </span>
        <span
          className="rounded px-1.5 py-0.5 text-[10px]"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text-secondary)",
          }}
        >
          {report.install_type}
        </span>
      </div>

      {/* Reason */}
      {report.reason && (
        <p style={{ color: "var(--color-text-secondary)" }}>{report.reason}</p>
      )}

      {/* Incompatible — no point showing steps */}
      {!report.compatible && (
        <p className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Installation will not proceed.
        </p>
      )}

      {/* Steps */}
      {report.compatible && report.steps.length > 0 && (
        <Section title="Shell steps">
          <ol className="space-y-1">
            {report.steps.map((s, i) => (
              <li key={i} className="flex flex-col gap-0.5">
                <code
                  className="rounded px-2 py-1 text-[11px]"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {s.cmd}
                </code>
                <span
                  className="pl-2 text-[10.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  in {s.cwd}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {/* File copies */}
      {report.compatible && report.copy_files.length > 0 && (
        <Section title="Files to copy">
          <ul className="space-y-1">
            {report.copy_files.map((f, i) => (
              <li
                key={i}
                className="flex items-center gap-1 text-[11px]"
                style={{
                  color: "var(--color-text-secondary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                <span style={{ color: "var(--color-text-tertiary)" }}>{f.from}</span>
                <span className="mx-1" style={{ color: "var(--color-text-tertiary)" }}>→</span>
                <span>{f.to}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Warnings */}
      {report.warnings.length > 0 && (
        <Section title="Warnings">
          <ul className="space-y-1">
            {report.warnings.map((w, i) => (
              <li
                key={i}
                className="flex items-start gap-1.5 text-[11.5px]"
                style={{ color: "var(--color-warning, #d29922)" }}
              >
                <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                {w}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DoneBody — shown after execution completes
// ---------------------------------------------------------------------------

function DoneBody({ result }: { result: AiInstallResult }) {
  const hasErrors = result.errors.length > 0;

  return (
    <div className="space-y-3">
      {result.executed ? (
        <div
          className="flex items-center gap-2 rounded-md border px-3 py-2"
          style={{
            background: "rgba(63,185,80,0.07)",
            borderColor: "rgba(63,185,80,0.25)",
            color: "var(--color-success)",
          }}
        >
          <Check size={13} />
          <span className="font-medium">Install complete</span>
        </div>
      ) : (
        <div
          className="flex items-center gap-2 rounded-md border px-3 py-2"
          style={{
            background: "rgba(130,80,255,0.07)",
            borderColor: "rgba(130,80,255,0.25)",
            color: "var(--color-accent)",
          }}
        >
          <Check size={13} />
          <span className="font-medium">Dry-run complete — no files changed</span>
        </div>
      )}

      {result.installed_paths.length > 0 && (
        <Section title="Installed files">
          <ul className="space-y-0.5">
            {result.installed_paths.map((p, i) => (
              <li
                key={i}
                className="text-[11px]"
                style={{
                  color: "var(--color-text-secondary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {p}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {hasErrors && (
        <Section title="Warnings / errors">
          <ul className="space-y-1">
            {result.errors.map((e, i) => (
              <li
                key={i}
                className="flex items-start gap-1.5 text-[11.5px]"
                style={{ color: "var(--color-danger)" }}
              >
                <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                {e}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small helper component for labelled sections inside the modal
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p
        className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {title}
      </p>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Catalog component
// ---------------------------------------------------------------------------

export function Catalog() {
  // Search engine state
  const [tab, setTab] = useState<SearchTab>("trending");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RepoHit[]>([]);
  const [hitsLoading, setHitsLoading] = useState(false);
  const [hitsError, setHitsError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<Record<string, "copied">>({});
  const [refreshTick, setRefreshTick] = useState(0);

  // Install modal state
  const [modal, setModal] = useState<InstallModalState>({ phase: "idle" });
  // dryRun lives here because the modal re-mounts on phase changes; we pass
  // it down from the confirm handler rather than from inner state.
  const pendingDryRunRef = useRef(false);

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  const runSearch = useCallback(async () => {
    setHitsLoading(true);
    setHitsError(null);
    try {
      if (tab === "trending") {
        const results = (await invoke("github_search_trending", {
          kind: null,
          limit: 30,
        })) as RepoHit[];
        setHits(results);
      } else {
        const composed = queryForTab(tab, query);
        const results = (await invoke("github_search_repos", {
          query: composed,
          limit: 30,
        })) as RepoHit[];
        setHits(results);
      }
    } catch (e) {
      setHitsError(String(e));
      setHits([]);
    } finally {
      setHitsLoading(false);
    }
  }, [tab, query]);

  useEffect(() => {
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, refreshTick]);

  // ---------------------------------------------------------------------------
  // Repo actions
  // ---------------------------------------------------------------------------

  async function openRepo(hit: RepoHit) {
    const url = repoUrl(hit);
    try {
      await openPath(url);
    } catch {
      void copyToClipboard(hit);
    }
  }

  async function copyToClipboard(hit: RepoHit) {
    const url = repoUrl(hit);
    try {
      await navigator.clipboard.writeText(url);
      setCopyState((s) => ({ ...s, [hit.full_name]: "copied" }));
      setTimeout(() => {
        setCopyState((s) => {
          const next = { ...s };
          delete next[hit.full_name];
          return next;
        });
      }, 1500);
    } catch {
      /* no-op */
    }
  }

  // ---------------------------------------------------------------------------
  // AI install flow
  // ---------------------------------------------------------------------------

  async function startAiInstall(hit: RepoHit) {
    const url = repoUrl(hit);
    setModal({ phase: "analysing", repoUrl: url });

    try {
      const result = (await invoke("library_install_via_ai", {
        args: {
          repo_url: url,
          target_scope: "global",
          dry_run: true, // always dry-run first so the user sees the plan
        },
      })) as AiInstallResult;

      // If AI is unavailable, fall back to clipboard silently
      if (!result.ai_available) {
        await navigator.clipboard.writeText(url).catch(() => {});
        setModal({ phase: "preview", repoUrl: url, result });
        return;
      }

      setModal({ phase: "preview", repoUrl: url, result });
    } catch (e) {
      setModal({
        phase: "preview",
        repoUrl: url,
        result: {
          ai_available: false,
          report: null,
          executed: false,
          installed_paths: [],
          errors: [String(e)],
        },
      });
    }
  }

  async function confirmInstall(dryRun: boolean) {
    if (modal.phase !== "preview") return;
    const url = modal.repoUrl;
    pendingDryRunRef.current = dryRun;

    setModal({ phase: "executing", repoUrl: url });

    try {
      const result = (await invoke("library_install_via_ai", {
        args: {
          repo_url: url,
          target_scope: "global",
          dry_run: dryRun,
        },
      })) as AiInstallResult;

      setModal({ phase: "done", repoUrl: url, result });
    } catch (e) {
      setModal({
        phase: "done",
        repoUrl: url,
        result: {
          ai_available: true,
          report: null,
          executed: false,
          installed_paths: [],
          errors: [String(e)],
        },
      });
    }
  }

  function closeModal() {
    setModal({ phase: "idle" });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col">
      {/* HEADER */}
      <div
        className="border-b px-6 py-4"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-center gap-3">
          <Compass size={18} className="shrink-0" />
          <div className="relative flex-1">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runSearch();
              }}
              placeholder="Search GitHub repos, skills, agents, rules, MCPs…"
              className="w-full rounded-md border py-2.5 pl-9 pr-3 text-sm outline-none"
              style={{
                background: "var(--color-surface-2)",
                borderColor: "var(--color-border-strong)",
                color: "var(--color-text)",
              }}
            />
          </div>
          <button
            type="button"
            onClick={() => void runSearch()}
            disabled={hitsLoading}
            className="inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {hitsLoading ? (
              <>
                <Loader size={13} className="animate-spin" /> Searching
              </>
            ) : (
              <>
                <Search size={13} /> Search
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setRefreshTick((n) => n + 1)}
            disabled={hitsLoading}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs disabled:opacity-60"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
            title="Re-fetch current tab"
          >
            Refresh
          </button>
        </div>
        {/* TAB STRIP */}
        <div className="mt-3 flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className="rounded-md px-3 py-1.5 text-[12.5px] transition-colors"
              style={{
                background: tab === t.id ? "var(--color-surface-3)" : "transparent",
                color:
                  tab === t.id ? "var(--color-text)" : "var(--color-text-secondary)",
                border: `1px solid ${
                  tab === t.id ? "var(--color-border-strong)" : "var(--color-border)"
                }`,
              }}
              title={t.hint}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* BODY */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {hitsError && (
          <div
            className="mb-3 rounded-md border p-3 text-[12.5px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              borderColor: "rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            <div className="mb-1 flex items-center gap-2 font-medium">
              <AlertTriangle size={13} /> GitHub search failed
            </div>
            <div
              className="text-[11.5px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {hitsError}
            </div>
          </div>
        )}

        {hitsLoading && hits.length === 0 && (
          <div
            className="flex items-center gap-2 text-[12.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            <Loader size={13} className="animate-spin" />
            Loading {TABS.find((t) => t.id === tab)?.label.toLowerCase()}…
          </div>
        )}

        {!hitsLoading && hits.length === 0 && !hitsError && (
          <p className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            No results for this tab. Try a different keyword or hit Refresh.
          </p>
        )}

        {hits.length > 0 && (
          <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {hits.map((hit) => {
              const copied = copyState[hit.full_name] === "copied";
              return (
                <li
                  key={hit.full_name}
                  className="rounded-md border p-3 text-[12px]"
                  style={{
                    background: "var(--color-surface-2)",
                    borderColor: "var(--color-border-strong)",
                    color: "var(--color-text)",
                  }}
                >
                  {/* Card header */}
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Github size={12} className="shrink-0 text-[var(--color-text-tertiary)]" />
                    <span className="font-medium">{hit.name}</span>
                    <span
                      className="text-[10.5px]"
                      style={{
                        color: "var(--color-text-tertiary)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {hit.owner}
                    </span>
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px]"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text-secondary)",
                      }}
                      title="Stars"
                    >
                      ★ {formatStars(hit.stars)}
                    </span>
                    {hit.language && (
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px]"
                        style={{
                          background: "var(--color-surface-3)",
                          color: "var(--color-text-tertiary)",
                        }}
                      >
                        {hit.language}
                      </span>
                    )}
                  </div>

                  {/* Description */}
                  {hit.description && (
                    <p
                      className="mb-2 text-[11.5px] leading-snug"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      {hit.description}
                    </p>
                  )}

                  {/* Topics */}
                  {hit.topics.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1">
                      {hit.topics.slice(0, 6).map((t) => (
                        <span
                          key={t}
                          className="rounded px-1.5 py-0.5 text-[9.5px]"
                          style={{
                            background: "var(--color-surface-3)",
                            color: "var(--color-text-tertiary)",
                            border: "1px solid var(--color-border)",
                          }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Footer row */}
                  <div
                    className="flex items-center justify-between text-[10.5px]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    <span style={{ fontFamily: "var(--font-mono)" }}>
                      {hit.full_name}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {/* Open on GitHub */}
                      <button
                        type="button"
                        onClick={() => void openRepo(hit)}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5"
                        style={{
                          color: "var(--color-text)",
                          background: "var(--color-surface-3)",
                        }}
                        title="Open repo on GitHub"
                      >
                        <ExternalLink size={11} />
                      </button>

                      {/* Copy URL (clipboard fallback, legacy UX) */}
                      <button
                        type="button"
                        onClick={() => void copyToClipboard(hit)}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5"
                        style={{
                          color: copied ? "var(--color-success)" : "var(--color-text)",
                          background: copied
                            ? "rgba(63, 185, 80, 0.12)"
                            : "var(--color-surface-3)",
                          border: copied
                            ? "1px solid rgba(63, 185, 80, 0.30)"
                            : "1px solid var(--color-border)",
                        }}
                        title="Copy repo URL"
                      >
                        {copied ? <Check size={11} /> : <Clipboard size={11} />}
                      </button>

                      {/* Install via AI — primary action */}
                      <button
                        type="button"
                        onClick={() => void startAiInstall(hit)}
                        disabled={modal.phase === "analysing" || modal.phase === "executing"}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium disabled:opacity-50"
                        style={{
                          background: "var(--color-accent)",
                          color: "var(--color-accent-text)",
                          border: "1px solid var(--color-border-strong)",
                          fontSize: "10.5px",
                        }}
                        title="Analyse README + install with AI"
                      >
                        <Sparkles size={10} />
                        Install via AI
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Modal — rendered outside the scroll area so it overlays correctly */}
      <InstallModal state={modal} onConfirm={confirmInstall} onClose={closeModal} />
    </div>
  );
}

export default Catalog;
