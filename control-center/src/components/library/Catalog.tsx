// Catalog sub-tab — v2.9.8 (card-1779825112840: filters + compat + bulk install).
//
// Changes vs v2.9.5:
//   - Filter bar (sticky in header): min-stars input, topic multi-select,
//     language multi-select, "Show compatible only" toggle.
//   - "Analyze compatibility" button: calls analyze_catalog_compat backend,
//     computes compat_score per item, caches 1 h.
//   - "Install compatible (N)" bulk button: confirm modal with per-item
//     checkboxes, calls library_install_via_ai sequentially with 500 ms delay,
//     progress bar + inline log, individual errors don't abort the run.
//   - All previous search/tab/AI-install behaviour preserved unchanged.

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

type InstallStep = { cmd: string; cwd: string };
type CopyFile = { from: string; to: string };

type InstallReport = {
  compatible: boolean;
  reason: string;
  install_type: string;
  steps: InstallStep[];
  copy_files: CopyFile[];
  warnings: string[];
};

type AiInstallResult = {
  ai_available: boolean;
  report: InstallReport | null;
  executed: boolean;
  installed_paths: string[];
  errors: string[];
};

type InstallModalState =
  | { phase: "idle" }
  | { phase: "analysing"; repoUrl: string }
  | { phase: "preview"; repoUrl: string; result: AiInstallResult }
  | { phase: "executing"; repoUrl: string }
  | { phase: "done"; repoUrl: string; result: AiInstallResult };

// --- Compat types (v2.9.8) ---

type CompatReport = {
  item_id: string;
  compat_score: number;
  reasons: string[];
  blocked_by: string | null;
};

type CompatState =
  | { phase: "idle" }
  | { phase: "analysing" }
  | { phase: "done"; reports: Map<string, CompatReport> };

// --- Bulk install (v2.9.8) ---

type BulkItem = {
  hit: RepoHit;
  selected: boolean;
  compat_score: number;
};

type BulkPhase = "idle" | "confirm" | "running" | "done";

type BulkLog = {
  full_name: string;
  ok: boolean;
  message: string;
};

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

const BULK_COMPAT_THRESHOLD = 0.7;

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function scoreColor(score: number): string {
  if (score >= 0.7) return "var(--color-success)";
  if (score >= 0.4) return "var(--color-warning, #d29922)";
  return "var(--color-text-tertiary)";
}

// ---------------------------------------------------------------------------
// FilterBar (v2.9.8)
// ---------------------------------------------------------------------------

type FilterState = {
  minStars: number;
  topics: string[];
  languages: string[];
  compatOnly: boolean;
};

type FilterBarProps = {
  filters: FilterState;
  allTopics: string[];
  allLanguages: string[];
  compatAnalysed: boolean;
  onFiltersChange: (f: FilterState) => void;
};

function FilterBar({
  filters,
  allTopics,
  allLanguages,
  compatAnalysed,
  onFiltersChange,
}: FilterBarProps) {
  function update(partial: Partial<FilterState>) {
    onFiltersChange({ ...filters, ...partial });
  }

  function toggleTopic(t: string) {
    const next = filters.topics.includes(t)
      ? filters.topics.filter((x) => x !== t)
      : [...filters.topics, t];
    update({ topics: next });
  }

  function toggleLang(l: string) {
    const next = filters.languages.includes(l)
      ? filters.languages.filter((x) => x !== l)
      : [...filters.languages, l];
    update({ languages: next });
  }

  const hasActive =
    filters.minStars > 0 ||
    filters.topics.length > 0 ||
    filters.languages.length > 0 ||
    filters.compatOnly;

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t px-6 py-2 text-[11.5px]"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      {/* Min stars */}
      <label className="flex items-center gap-1.5" style={{ color: "var(--color-text-secondary)" }}>
        <span className="shrink-0">Min ★</span>
        <input
          type="number"
          min={0}
          value={filters.minStars}
          onChange={(e) => update({ minStars: Math.max(0, Number(e.target.value)) })}
          className="w-16 rounded border px-1.5 py-0.5 text-[11px] outline-none"
          style={{
            background: "var(--color-surface-2)",
            borderColor: "var(--color-border-strong)",
            color: "var(--color-text)",
          }}
        />
      </label>

      {/* Language chips */}
      {allLanguages.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span style={{ color: "var(--color-text-tertiary)" }}>Lang:</span>
          {allLanguages.map((l) => {
            const active = filters.languages.includes(l);
            return (
              <button
                key={l}
                type="button"
                onClick={() => toggleLang(l)}
                className="rounded px-1.5 py-0.5 text-[10.5px] transition-colors"
                style={{
                  background: active ? "var(--color-accent)" : "var(--color-surface-3)",
                  color: active ? "var(--color-accent-text)" : "var(--color-text-secondary)",
                  border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border)"}`,
                }}
              >
                {l}
              </button>
            );
          })}
        </div>
      )}

      {/* Topic chips (top 10 to avoid overflow) */}
      {allTopics.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span style={{ color: "var(--color-text-tertiary)" }}>Topic:</span>
          {allTopics.slice(0, 10).map((t) => {
            const active = filters.topics.includes(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleTopic(t)}
                className="rounded px-1.5 py-0.5 text-[10.5px] transition-colors"
                style={{
                  background: active ? "var(--color-accent)" : "var(--color-surface-3)",
                  color: active ? "var(--color-accent-text)" : "var(--color-text-secondary)",
                  border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border)"}`,
                }}
              >
                {t}
              </button>
            );
          })}
        </div>
      )}

      {/* Compatible only toggle */}
      <label
        className="flex cursor-pointer items-center gap-1.5 select-none"
        style={{
          color: compatAnalysed ? "var(--color-text-secondary)" : "var(--color-text-tertiary)",
          opacity: compatAnalysed ? 1 : 0.5,
        }}
        title={compatAnalysed ? undefined : "Run 'Analyze compatibility' first"}
      >
        <input
          type="checkbox"
          checked={filters.compatOnly}
          disabled={!compatAnalysed}
          onChange={(e) => update({ compatOnly: e.target.checked })}
          className="h-3 w-3"
        />
        Compatible only
      </label>

      {/* Clear */}
      {hasActive && (
        <button
          type="button"
          onClick={() => onFiltersChange({ minStars: 0, topics: [], languages: [], compatOnly: false })}
          className="ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-[10.5px]"
          style={{
            color: "var(--color-text-secondary)",
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <X size={10} /> Clear filters
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BulkInstallModal (v2.9.8)
// ---------------------------------------------------------------------------

type BulkInstallModalProps = {
  phase: BulkPhase;
  items: BulkItem[];
  progress: number; // 0–100
  log: BulkLog[];
  onToggleItem: (full_name: string) => void;
  onConfirm: () => void;
  onClose: () => void;
};

function BulkInstallModal({
  phase,
  items,
  progress,
  log,
  onToggleItem,
  onConfirm,
  onClose,
}: BulkInstallModalProps) {
  if (phase === "idle") return null;

  const selectedCount = items.filter((i) => i.selected).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && phase !== "running") onClose();
      }}
    >
      <div
        className="relative mx-4 flex max-h-[80vh] w-full max-w-xl flex-col rounded-lg border shadow-xl"
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
            <Sparkles size={14} />
            Bulk install compatible items
          </div>
          {phase !== "running" && (
            <button type="button" onClick={onClose} className="rounded p-1 hover:opacity-70" aria-label="Close">
              <X size={14} />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 text-[12px]">
          {/* Confirm phase: checklist */}
          {phase === "confirm" && (
            <div className="space-y-1.5">
              <p className="mb-2 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
                Select items to install (compat score ≥ {BULK_COMPAT_THRESHOLD}). Each will be analysed and installed via AI Router.
              </p>
              {items.map((item) => (
                <label
                  key={item.hit.full_name}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 select-none hover:opacity-80"
                  style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
                >
                  <input
                    type="checkbox"
                    checked={item.selected}
                    onChange={() => onToggleItem(item.hit.full_name)}
                    className="h-3.5 w-3.5 shrink-0"
                  />
                  <span className="flex-1 font-medium">{item.hit.full_name}</span>
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold"
                    style={{
                      background: "var(--color-surface-3)",
                      color: scoreColor(item.compat_score),
                    }}
                  >
                    {Math.round(item.compat_score * 100)}%
                  </span>
                </label>
              ))}
            </div>
          )}

          {/* Running phase: progress + log */}
          {(phase === "running" || phase === "done") && (
            <div className="space-y-2">
              {/* Progress bar */}
              <div
                className="h-2 w-full overflow-hidden rounded-full"
                style={{ background: "var(--color-surface-3)" }}
              >
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${progress}%`,
                    background: phase === "done" ? "var(--color-success)" : "var(--color-accent)",
                  }}
                />
              </div>
              <p className="text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
                {phase === "running" ? `Installing… ${progress}%` : `Done — ${progress}%`}
              </p>

              {/* Log entries */}
              <div className="space-y-1">
                {log.map((entry, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 rounded px-2 py-1 text-[11px]"
                    style={{
                      background: "var(--color-surface-2)",
                      color: entry.ok ? "var(--color-success)" : "var(--color-danger)",
                    }}
                  >
                    {entry.ok ? <Check size={11} className="mt-0.5 shrink-0" /> : <AlertTriangle size={11} className="mt-0.5 shrink-0" />}
                    <span className="font-medium shrink-0">{entry.full_name}</span>
                    <span style={{ color: "var(--color-text-secondary)" }}>{entry.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 border-t px-4 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          {phase === "confirm" && (
            <>
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
              <button
                type="button"
                onClick={onConfirm}
                disabled={selectedCount === 0}
                className="rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                Install {selectedCount} item{selectedCount !== 1 ? "s" : ""}
              </button>
            </>
          )}
          {phase === "done" && (
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
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InstallModal (unchanged from v2.9.5)
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
        <div
          className="flex items-center justify-between border-b px-4 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <Bot size={14} />
            Install via AI
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 hover:opacity-70" aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 text-[12.5px]">
          {state.phase === "analysing" && (
            <div className="flex items-center gap-2" style={{ color: "var(--color-text-secondary)" }}>
              <Loader size={13} className="animate-spin" />
              Cloning repo and analysing with AI…
            </div>
          )}
          {state.phase === "executing" && (
            <div className="flex items-center gap-2" style={{ color: "var(--color-text-secondary)" }}>
              <Loader size={13} className="animate-spin" />
              Executing install steps…
            </div>
          )}
          {state.phase === "preview" && state.result && (
            <PreviewBody result={state.result} dryRun={dryRun} onToggleDryRun={setDryRun} />
          )}
          {state.phase === "done" && state.result && <DoneBody result={state.result} />}
        </div>

        {(state.phase === "preview" || state.phase === "done") && (
          <div
            className="flex items-center justify-end gap-2 border-t px-4 py-3"
            style={{ borderColor: "var(--color-border)" }}
          >
            {state.phase === "preview" && (
              <>
                <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] select-none"
                  style={{ color: "var(--color-text-secondary)" }}>
                  <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="h-3 w-3" />
                  Dry-run only
                </label>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border px-3 py-1.5 text-[12px]"
                  style={{ borderColor: "var(--color-border-strong)", background: "var(--color-surface-2)", color: "var(--color-text)" }}
                >
                  Cancel
                </button>
                {report?.compatible !== false && (
                  <button
                    type="button"
                    onClick={() => onConfirm(dryRun)}
                    className="rounded-md px-3 py-1.5 text-[12px] font-medium"
                    style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
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
                style={{ borderColor: "var(--color-border-strong)", background: "var(--color-surface-2)", color: "var(--color-text)" }}
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
// PreviewBody / DoneBody / Section (unchanged from v2.9.5)
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
        style={{ background: "rgba(248,81,73,0.06)", borderColor: "rgba(248,81,73,0.22)", color: "var(--color-danger)" }}
      >
        <div className="mb-1 flex items-center gap-2 font-medium">
          <AlertTriangle size={13} />
          AI Router unavailable
        </div>
        <p style={{ color: "var(--color-text-secondary)" }}>
          No AI provider with a valid API key is configured. The URL has been copied to your clipboard — you can install manually.
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
    return <p style={{ color: "var(--color-text-secondary)" }}>No report received from AI.</p>;
  }

  return (
    <div className="space-y-3">
      <div
        className="flex items-center gap-2 rounded-md border px-3 py-2"
        style={{
          background: report.compatible ? "rgba(63,185,80,0.07)" : "rgba(248,81,73,0.07)",
          borderColor: report.compatible ? "rgba(63,185,80,0.25)" : "rgba(248,81,73,0.25)",
          color: report.compatible ? "var(--color-success)" : "var(--color-danger)",
        }}
      >
        {report.compatible ? <Check size={13} /> : <AlertTriangle size={13} />}
        <span className="font-medium">{report.compatible ? "Compatible" : "Incompatible"}</span>
        <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--color-surface-3)", color: "var(--color-text-secondary)" }}>
          {report.install_type}
        </span>
      </div>
      {report.reason && <p style={{ color: "var(--color-text-secondary)" }}>{report.reason}</p>}
      {!report.compatible && (
        <p className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>Installation will not proceed.</p>
      )}
      {report.compatible && report.steps.length > 0 && (
        <Section title="Shell steps">
          <ol className="space-y-1">
            {report.steps.map((s, i) => (
              <li key={i} className="flex flex-col gap-0.5">
                <code className="rounded px-2 py-1 text-[11px]" style={{ background: "var(--color-surface-3)", color: "var(--color-text)", fontFamily: "var(--font-mono)" }}>
                  {s.cmd}
                </code>
                <span className="pl-2 text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>in {s.cwd}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}
      {report.compatible && report.copy_files.length > 0 && (
        <Section title="Files to copy">
          <ul className="space-y-1">
            {report.copy_files.map((f, i) => (
              <li key={i} className="flex items-center gap-1 text-[11px]" style={{ color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}>
                <span style={{ color: "var(--color-text-tertiary)" }}>{f.from}</span>
                <span className="mx-1" style={{ color: "var(--color-text-tertiary)" }}>→</span>
                <span>{f.to}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {report.warnings.length > 0 && (
        <Section title="Warnings">
          <ul className="space-y-1">
            {report.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[11.5px]" style={{ color: "var(--color-warning, #d29922)" }}>
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

function DoneBody({ result }: { result: AiInstallResult }) {
  const hasErrors = result.errors.length > 0;
  return (
    <div className="space-y-3">
      {result.executed ? (
        <div className="flex items-center gap-2 rounded-md border px-3 py-2" style={{ background: "rgba(63,185,80,0.07)", borderColor: "rgba(63,185,80,0.25)", color: "var(--color-success)" }}>
          <Check size={13} />
          <span className="font-medium">Install complete</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-md border px-3 py-2" style={{ background: "rgba(130,80,255,0.07)", borderColor: "rgba(130,80,255,0.25)", color: "var(--color-accent)" }}>
          <Check size={13} />
          <span className="font-medium">Dry-run complete — no files changed</span>
        </div>
      )}
      {result.installed_paths.length > 0 && (
        <Section title="Installed files">
          <ul className="space-y-0.5">
            {result.installed_paths.map((p, i) => (
              <li key={i} className="text-[11px]" style={{ color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}>{p}</li>
            ))}
          </ul>
        </Section>
      )}
      {hasErrors && (
        <Section title="Warnings / errors">
          <ul className="space-y-1">
            {result.errors.map((e, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[11.5px]" style={{ color: "var(--color-danger)" }}>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
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

  // Filter state (v2.9.8)
  const [filters, setFilters] = useState<FilterState>({
    minStars: 0,
    topics: [],
    languages: [],
    compatOnly: false,
  });

  // Compat analysis state (v2.9.8)
  const [compatState, setCompatState] = useState<CompatState>({ phase: "idle" });

  // Bulk install state (v2.9.8)
  const [bulkPhase, setBulkPhase] = useState<BulkPhase>("idle");
  const [bulkItems, setBulkItems] = useState<BulkItem[]>([]);
  const [bulkProgress, setBulkProgress] = useState(0);
  const [bulkLog, setBulkLog] = useState<BulkLog[]>([]);
  const bulkAbortRef = useRef(false);

  // Single-item install modal state
  const [modal, setModal] = useState<InstallModalState>({ phase: "idle" });
  const pendingDryRunRef = useRef(false);

  // ---------------------------------------------------------------------------
  // Derived filter data
  // ---------------------------------------------------------------------------

  const allTopics = Array.from(
    new Set(hits.flatMap((h) => h.topics))
  ).sort();

  const allLanguages = Array.from(
    new Set(hits.map((h) => h.language).filter((l): l is string => l !== null))
  ).sort();

  const compatMap: Map<string, CompatReport> =
    compatState.phase === "done" ? compatState.reports : new Map();

  const filteredHits = hits.filter((h) => {
    if (filters.minStars > 0 && h.stars < filters.minStars) return false;
    if (filters.languages.length > 0 && (h.language === null || !filters.languages.includes(h.language))) return false;
    if (filters.topics.length > 0 && !filters.topics.some((t) => h.topics.includes(t))) return false;
    if (filters.compatOnly) {
      const report = compatMap.get(h.full_name);
      if (!report || report.compat_score < BULK_COMPAT_THRESHOLD) return false;
    }
    return true;
  });

  const compatibleCount = compatState.phase === "done"
    ? hits.filter((h) => {
        const r = compatMap.get(h.full_name);
        return r && r.compat_score >= BULK_COMPAT_THRESHOLD;
      }).length
    : 0;

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  const runSearch = useCallback(async () => {
    setHitsLoading(true);
    setHitsError(null);
    // Reset compat state on new search — results have changed.
    setCompatState({ phase: "idle" });
    try {
      if (tab === "trending") {
        const results = (await invoke("github_search_trending", { kind: null, limit: 30 })) as RepoHit[];
        setHits(results);
      } else {
        const composed = queryForTab(tab, query);
        const results = (await invoke("github_search_repos", { query: composed, limit: 30 })) as RepoHit[];
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
  // Compat analysis (v2.9.8)
  // ---------------------------------------------------------------------------

  async function runCompatAnalysis(forceRefresh = false) {
    if (hits.length === 0) return;
    setCompatState({ phase: "analysing" });
    try {
      const reports = (await invoke("analyze_catalog_compat", {
        args: { items: hits, force_refresh: forceRefresh },
      })) as CompatReport[];
      const map = new Map(reports.map((r) => [r.item_id, r]));
      setCompatState({ phase: "done", reports: map });
    } catch (e) {
      // Analysis failure is non-fatal — reset to idle so the button is available again.
      setCompatState({ phase: "idle" });
      setHitsError(`Compat analysis failed: ${String(e)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Bulk install (v2.9.8)
  // ---------------------------------------------------------------------------

  function openBulkModal() {
    if (compatState.phase !== "done") return;
    const eligible = hits
      .map((h) => ({ hit: h, report: compatMap.get(h.full_name) }))
      .filter((x): x is { hit: RepoHit; report: CompatReport } => x.report !== undefined && x.report.compat_score >= BULK_COMPAT_THRESHOLD)
      .map(({ hit, report }) => ({
        hit,
        selected: true,
        compat_score: report.compat_score,
      }));
    setBulkItems(eligible);
    setBulkLog([]);
    setBulkProgress(0);
    setBulkPhase("confirm");
  }

  function toggleBulkItem(full_name: string) {
    setBulkItems((prev) =>
      prev.map((item) =>
        item.hit.full_name === full_name ? { ...item, selected: !item.selected } : item
      )
    );
  }

  async function runBulkInstall() {
    const selected = bulkItems.filter((i) => i.selected);
    if (selected.length === 0) return;
    setBulkPhase("running");
    setBulkLog([]);
    setBulkProgress(0);
    bulkAbortRef.current = false;

    for (let idx = 0; idx < selected.length; idx++) {
      if (bulkAbortRef.current) break;
      const item = selected[idx];
      const url = repoUrl(item.hit);
      try {
        const result = (await invoke("library_install_via_ai", {
          args: { repo_url: url, target_scope: "global", dry_run: false },
        })) as AiInstallResult;
        const ok = result.executed || result.ai_available;
        const message = result.errors.length > 0
          ? result.errors[0]
          : result.executed
            ? "Installed"
            : result.ai_available
              ? "AI unavailable — URL copied"
              : "Completed";
        setBulkLog((prev) => [...prev, { full_name: item.hit.full_name, ok, message }]);
      } catch (e) {
        setBulkLog((prev) => [
          ...prev,
          { full_name: item.hit.full_name, ok: false, message: String(e) },
        ]);
      }
      setBulkProgress(Math.round(((idx + 1) / selected.length) * 100));
      if (idx < selected.length - 1) {
        await sleep(500);
      }
    }

    setBulkPhase("done");
  }

  function closeBulkModal() {
    bulkAbortRef.current = true;
    setBulkPhase("idle");
  }

  // ---------------------------------------------------------------------------
  // Single-item AI install flow (unchanged from v2.9.5)
  // ---------------------------------------------------------------------------

  async function startAiInstall(hit: RepoHit) {
    const url = repoUrl(hit);
    setModal({ phase: "analysing", repoUrl: url });
    try {
      const result = (await invoke("library_install_via_ai", {
        args: { repo_url: url, target_scope: "global", dry_run: true },
      })) as AiInstallResult;
      if (!result.ai_available) {
        await navigator.clipboard.writeText(url).catch(() => {});
      }
      setModal({ phase: "preview", repoUrl: url, result });
    } catch (e) {
      setModal({
        phase: "preview",
        repoUrl: url,
        result: { ai_available: false, report: null, executed: false, installed_paths: [], errors: [String(e)] },
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
        args: { repo_url: url, target_scope: "global", dry_run: dryRun },
      })) as AiInstallResult;
      setModal({ phase: "done", repoUrl: url, result });
    } catch (e) {
      setModal({
        phase: "done",
        repoUrl: url,
        result: { ai_available: true, report: null, executed: false, installed_paths: [], errors: [String(e)] },
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
        className="sticky top-0 z-10 border-b"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        {/* Search row */}
        <div className="px-6 py-4">
          <div className="flex items-center gap-3">
            <Compass size={18} className="shrink-0" />
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
                placeholder="Search GitHub repos, skills, agents, rules, MCPs…"
                className="w-full rounded-md border py-2.5 pl-9 pr-3 text-sm outline-none"
                style={{ background: "var(--color-surface-2)", borderColor: "var(--color-border-strong)", color: "var(--color-text)" }}
              />
            </div>
            <button
              type="button"
              onClick={() => void runSearch()}
              disabled={hitsLoading}
              className="inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60"
              style={{ background: "var(--color-accent)", color: "var(--color-accent-text)", border: "1px solid var(--color-border-strong)" }}
            >
              {hitsLoading ? <><Loader size={13} className="animate-spin" /> Searching</> : <><Search size={13} /> Search</>}
            </button>
            <button
              type="button"
              onClick={() => setRefreshTick((n) => n + 1)}
              disabled={hitsLoading}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs disabled:opacity-60"
              style={{ borderColor: "var(--color-border-strong)", background: "var(--color-surface-2)", color: "var(--color-text)" }}
              title="Re-fetch current tab"
            >
              Refresh
            </button>
          </div>

          {/* Tab strip */}
          <div className="mt-3 flex flex-wrap gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className="rounded-md px-3 py-1.5 text-[12.5px] transition-colors"
                style={{
                  background: tab === t.id ? "var(--color-surface-3)" : "transparent",
                  color: tab === t.id ? "var(--color-text)" : "var(--color-text-secondary)",
                  border: `1px solid ${tab === t.id ? "var(--color-border-strong)" : "var(--color-border)"}`,
                }}
                title={t.hint}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Filter bar (v2.9.8) */}
        {hits.length > 0 && (
          <FilterBar
            filters={filters}
            allTopics={allTopics}
            allLanguages={allLanguages}
            compatAnalysed={compatState.phase === "done"}
            onFiltersChange={setFilters}
          />
        )}

        {/* Compat + bulk action row (v2.9.8) */}
        {hits.length > 0 && (
          <div
            className="flex items-center gap-2 border-t px-6 py-2"
            style={{ borderColor: "var(--color-border)" }}
          >
            {/* Analyze button */}
            <button
              type="button"
              onClick={() => void runCompatAnalysis(false)}
              disabled={compatState.phase === "analysing" || hitsLoading}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium disabled:opacity-60"
              style={{
                borderColor: "var(--color-border-strong)",
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
              }}
              title="Detect stack from CLAUDE.md + manifests and score each result"
            >
              {compatState.phase === "analysing" ? (
                <><Loader size={12} className="animate-spin" /> Analysing…</>
              ) : (
                <><Sparkles size={12} /> Analyze compatibility</>
              )}
            </button>

            {/* Re-analyse (force refresh) */}
            {compatState.phase === "done" && (
              <button
                type="button"
                onClick={() => void runCompatAnalysis(true)}
                className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-[11.5px] opacity-60 hover:opacity-100"
                style={{ borderColor: "var(--color-border)", background: "transparent", color: "var(--color-text-secondary)" }}
                title="Flush the 1-h cache and re-score"
              >
                Re-analyse
              </button>
            )}

            {/* Bulk install button */}
            {compatState.phase === "done" && compatibleCount > 0 && (
              <button
                type="button"
                onClick={openBulkModal}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium"
                style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
              >
                <Check size={12} />
                Install compatible ({compatibleCount})
              </button>
            )}

            {/* Score legend */}
            {compatState.phase === "done" && (
              <span className="ml-auto text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
                {compatibleCount} of {hits.length} compatible (score ≥ {Math.round(BULK_COMPAT_THRESHOLD * 100)}%)
              </span>
            )}
          </div>
        )}
      </div>

      {/* BODY */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {hitsError && (
          <div
            className="mb-3 rounded-md border p-3 text-[12.5px]"
            style={{ background: "rgba(248, 81, 73, 0.06)", borderColor: "rgba(248, 81, 73, 0.22)", color: "var(--color-danger)" }}
          >
            <div className="mb-1 flex items-center gap-2 font-medium">
              <AlertTriangle size={13} /> GitHub search failed
            </div>
            <div className="text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>{hitsError}</div>
          </div>
        )}

        {hitsLoading && hits.length === 0 && (
          <div className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            <Loader size={13} className="animate-spin" />
            Loading {TABS.find((t) => t.id === tab)?.label.toLowerCase()}…
          </div>
        )}

        {!hitsLoading && hits.length === 0 && !hitsError && (
          <p className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            No results for this tab. Try a different keyword or hit Refresh.
          </p>
        )}

        {filteredHits.length > 0 && (
          <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {filteredHits.map((hit) => {
              const copied = copyState[hit.full_name] === "copied";
              const compatReport = compatMap.get(hit.full_name);
              return (
                <li
                  key={hit.full_name}
                  className="rounded-md border p-3 text-[12px]"
                  style={{
                    background: "var(--color-surface-2)",
                    borderColor: compatReport
                      ? compatReport.compat_score >= BULK_COMPAT_THRESHOLD
                        ? "rgba(63,185,80,0.35)"
                        : compatReport.compat_score >= 0.4
                          ? "rgba(210,153,34,0.35)"
                          : "var(--color-border-strong)"
                      : "var(--color-border-strong)",
                    color: "var(--color-text)",
                  }}
                >
                  {/* Card header */}
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Github size={12} className="shrink-0 text-[var(--color-text-tertiary)]" />
                    <span className="font-medium">{hit.name}</span>
                    <span className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)" }}>
                      {hit.owner}
                    </span>
                    <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--color-surface-3)", color: "var(--color-text-secondary)" }} title="Stars">
                      ★ {formatStars(hit.stars)}
                    </span>
                    {hit.language && (
                      <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--color-surface-3)", color: "var(--color-text-tertiary)" }}>
                        {hit.language}
                      </span>
                    )}
                    {/* Compat score badge (v2.9.8) */}
                    {compatReport && (
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{
                          background: "var(--color-surface-3)",
                          color: scoreColor(compatReport.compat_score),
                        }}
                        title={compatReport.reasons.join(" · ")}
                      >
                        {Math.round(compatReport.compat_score * 100)}%
                      </span>
                    )}
                  </div>

                  {/* Description */}
                  {hit.description && (
                    <p className="mb-2 text-[11.5px] leading-snug" style={{ color: "var(--color-text-secondary)" }}>
                      {hit.description}
                    </p>
                  )}

                  {/* Blocked-by banner */}
                  {compatReport?.blocked_by && (
                    <p className="mb-2 flex items-start gap-1 text-[10.5px]" style={{ color: "var(--color-danger)" }}>
                      <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                      {compatReport.blocked_by}
                    </p>
                  )}

                  {/* Topics */}
                  {hit.topics.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1">
                      {hit.topics.slice(0, 6).map((t) => (
                        <span
                          key={t}
                          className="rounded px-1.5 py-0.5 text-[9.5px]"
                          style={{ background: "var(--color-surface-3)", color: "var(--color-text-tertiary)", border: "1px solid var(--color-border)" }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Footer row */}
                  <div className="flex items-center justify-between text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                    <span style={{ fontFamily: "var(--font-mono)" }}>{hit.full_name}</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void openRepo(hit)}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5"
                        style={{ color: "var(--color-text)", background: "var(--color-surface-3)" }}
                        title="Open repo on GitHub"
                      >
                        <ExternalLink size={11} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void copyToClipboard(hit)}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5"
                        style={{
                          color: copied ? "var(--color-success)" : "var(--color-text)",
                          background: copied ? "rgba(63, 185, 80, 0.12)" : "var(--color-surface-3)",
                          border: copied ? "1px solid rgba(63, 185, 80, 0.30)" : "1px solid var(--color-border)",
                        }}
                        title="Copy repo URL"
                      >
                        {copied ? <Check size={11} /> : <Clipboard size={11} />}
                      </button>
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

        {/* Empty-state when filters remove all results */}
        {!hitsLoading && hits.length > 0 && filteredHits.length === 0 && (
          <p className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            No items match the active filters. Adjust min-stars, language, or topic, or clear filters.
          </p>
        )}
      </div>

      {/* Modals */}
      <InstallModal state={modal} onConfirm={confirmInstall} onClose={closeModal} />
      <BulkInstallModal
        phase={bulkPhase}
        items={bulkItems}
        progress={bulkProgress}
        log={bulkLog}
        onToggleItem={toggleBulkItem}
        onConfirm={() => void runBulkInstall()}
        onClose={closeBulkModal}
      />
    </div>
  );
}

export default Catalog;
