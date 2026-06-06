// ULTRON Control Center — Hooks viewer (v2.9 REDESIGN).
//
// the user's brief (v2.9 sprint):
//   1. Mismas categorías colapsables que Skills / Agents / Rules — sidebar
//      izquierdo con grupos por evento (PreToolUse, PostToolUse, Stop, …).
//   2. Quitar el color amarillo global. Cada categoría usa su propio color de
//      evento; el ribbon del card viene del color del evento, no amber fijo.
//   3. Auto-naming: nuevo command `analyze_hook_name` que invoca AI Router
//      (Haiku / Gemini) para dar nombre legible en kebab-case. Botón
//      "Auto-name all" en header para procesar en bulk.
//
// Implementation notes:
//   - La barra lateral izquierda lista eventos como grupos colapsables
//     (mismo patrón que TreeView en Skills). Al hacer click en un grupo se
//     expande la lista de hooks de ese evento.
//   - Clicking a card opens HookDetailPane on the right side (unchanged).
//   - El card muestra el nombre legible (del cache) si está disponible;
//     si no, el id raw con estilo `font-mono` de menor tamaño para indicar
//     que aún no se ha nombrado.
//   - Los modals (HookFormModal / TestModal / AiModal) se conservan intactos.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "../lib/dialog";
import type { HookLastFired } from "../types";
import { Plus, X } from "./library/icons";
import { BlocksView, type BlocksItem } from "./library/BlocksView";

// ---------------------------------------------------------------------------
// Types (mirror src-tauri/src/hooks_admin.rs)
// ---------------------------------------------------------------------------

type HookRecord = {
  id: string;
  event: string;
  matcher: string | null;
  command: string;
  enabled: boolean;
  source: string;
  /** Human-readable description from settings.json group entry (populated by Rust backend). */
  description: string | null;
  extra: Record<string, unknown>;
};

type HooksList = {
  hooks: HookRecord[];
  settings_path: string;
  settings_exists: boolean;
};

type HookMutationResult = {
  success: boolean;
  hook: HookRecord | null;
  backup_path: string | null;
};

type HookTestResult = {
  success: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  elapsed_ms: number;
  timed_out: boolean;
};

type HookFire = {
  timestamp: string | null;
  event: string | null;
  hook_id: string | null;
  matcher: string | null;
  exit_code: number | null;
  raw: Record<string, unknown>;
};

type HookFiresReport = {
  fires: HookFire[];
  log_path: string;
  instrumented: boolean;
};

type HookNameResult = {
  id: string;
  name: string;
  strategy: string;
  cached: boolean;
};

/** Readable title + one-line summary per hook (from get_hook_descriptions). */
type HookDescription = {
  id: string;
  title: string;
  summary: string;
  source: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVENT_OPTIONS: readonly string[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "Notification",
] as const;

const DEFAULT_PAYLOAD = `{
  "tool_name": "Bash",
  "tool_input": { "command": "echo hello" }
}`;

// ---------------------------------------------------------------------------
// Per-event color tokens — used for the category sidebar accent, card ribbon,
// and event badges. NO global amber overlay anymore.
// ---------------------------------------------------------------------------

type EventColors = {
  ribbon: string;       // top card ribbon + sidebar active bg
  ribbonBorder: string; // card active border + sidebar chip border
  chipBg: string;       // event badge bg
  chipFg: string;       // event badge text
  chipBorder: string;   // event badge border
  sidebarActive: string;// sidebar row active background
};

function eventColors(event: string): EventColors {
  switch (event) {
    case "PreToolUse":
      return {
        ribbon: "rgba(56, 189, 248, 0.55)",
        ribbonBorder: "rgba(56, 189, 248, 0.55)",
        chipBg: "rgba(56, 189, 248, 0.14)",
        chipFg: "#67e8f9",
        chipBorder: "rgba(56, 189, 248, 0.45)",
        sidebarActive: "rgba(56, 189, 248, 0.12)",
      };
    case "PostToolUse":
      return {
        ribbon: "rgba(167, 139, 250, 0.55)",
        ribbonBorder: "rgba(167, 139, 250, 0.55)",
        chipBg: "rgba(167, 139, 250, 0.14)",
        chipFg: "#c4b5fd",
        chipBorder: "rgba(167, 139, 250, 0.45)",
        sidebarActive: "rgba(167, 139, 250, 0.12)",
      };
    case "UserPromptSubmit":
      return {
        ribbon: "rgba(251, 191, 36, 0.55)",
        ribbonBorder: "rgba(251, 191, 36, 0.55)",
        chipBg: "rgba(251, 191, 36, 0.14)",
        chipFg: "#fcd34d",
        chipBorder: "rgba(251, 191, 36, 0.45)",
        sidebarActive: "rgba(251, 191, 36, 0.10)",
      };
    case "SessionStart":
      return {
        ribbon: "rgba(132, 204, 22, 0.55)",
        ribbonBorder: "rgba(132, 204, 22, 0.55)",
        chipBg: "rgba(132, 204, 22, 0.14)",
        chipFg: "#bef264",
        chipBorder: "rgba(132, 204, 22, 0.45)",
        sidebarActive: "rgba(132, 204, 22, 0.10)",
      };
    case "SessionEnd":
      return {
        ribbon: "rgba(45, 212, 191, 0.55)",
        ribbonBorder: "rgba(45, 212, 191, 0.55)",
        chipBg: "rgba(45, 212, 191, 0.14)",
        chipFg: "#5eead4",
        chipBorder: "rgba(45, 212, 191, 0.45)",
        sidebarActive: "rgba(45, 212, 191, 0.10)",
      };
    case "Stop":
      return {
        ribbon: "rgba(248, 113, 113, 0.55)",
        ribbonBorder: "rgba(248, 113, 113, 0.55)",
        chipBg: "rgba(248, 113, 113, 0.14)",
        chipFg: "#fca5a5",
        chipBorder: "rgba(248, 113, 113, 0.45)",
        sidebarActive: "rgba(248, 113, 113, 0.10)",
      };
    case "SubagentStop":
      return {
        ribbon: "rgba(248, 113, 113, 0.40)",
        ribbonBorder: "rgba(248, 113, 113, 0.40)",
        chipBg: "rgba(248, 113, 113, 0.10)",
        chipFg: "#fca5a5",
        chipBorder: "rgba(248, 113, 113, 0.35)",
        sidebarActive: "rgba(248, 113, 113, 0.08)",
      };
    case "PreCompact":
      return {
        ribbon: "rgba(244, 114, 182, 0.55)",
        ribbonBorder: "rgba(244, 114, 182, 0.55)",
        chipBg: "rgba(244, 114, 182, 0.14)",
        chipFg: "#f9a8d4",
        chipBorder: "rgba(244, 114, 182, 0.45)",
        sidebarActive: "rgba(244, 114, 182, 0.10)",
      };
    case "Notification":
      return {
        ribbon: "rgba(96, 165, 250, 0.55)",
        ribbonBorder: "rgba(96, 165, 250, 0.55)",
        chipBg: "rgba(96, 165, 250, 0.14)",
        chipFg: "#93c5fd",
        chipBorder: "rgba(96, 165, 250, 0.45)",
        sidebarActive: "rgba(96, 165, 250, 0.10)",
      };
    default:
      return {
        ribbon: "var(--color-border-strong)",
        ribbonBorder: "var(--color-border-strong)",
        chipBg: "var(--color-surface-3)",
        chipFg: "var(--color-text-secondary)",
        chipBorder: "var(--color-border)",
        sidebarActive: "var(--color-surface-3)",
      };
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "...";
}

/**
 * Derive a readable name from a hook's command when no explicit name exists.
 *
 * Strategy: find the script the command runs (the first path-like token whose
 * basename has a script extension), strip directory + extension, and format the
 * basename (kebab/snake/camel → Title Case). Falls back to the first bare verb
 * token. Returns undefined only when nothing usable can be extracted, so the
 * caller can still drop to the raw id.
 */
const SCRIPT_EXT_RE = /\.(ps1|sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|bat|cmd|exe)$/i;

function deriveNameFromCommand(command: string): string | undefined {
  const raw = command.trim();
  if (!raw) return undefined;

  // Tokenise on whitespace but keep quoted paths intact enough to grab a basename.
  const tokens = raw.match(/[^\s"']+|"[^"]*"|'[^']*'/g) ?? [];

  // 1. Prefer a token that looks like a script path with a known extension.
  for (const tokenRaw of tokens) {
    const token = tokenRaw.replace(/^["']|["']$/g, "");
    // Skip flags and env assignments.
    if (token.startsWith("-") || token.includes("=")) continue;
    const base = token.split(/[\\/]/).pop() ?? token;
    if (SCRIPT_EXT_RE.test(base)) {
      const stem = base.replace(SCRIPT_EXT_RE, "");
      const formatted = formatNameStem(stem);
      if (formatted) return formatted;
    }
  }

  // 2. Otherwise use the first token that is not a known shell/interpreter
  //    wrapper, formatted as a fallback label.
  const WRAPPERS = new Set([
    "powershell", "pwsh", "bash", "sh", "zsh", "cmd", "node", "python",
    "python3", "py", "npx", "deno", "bun", "uv", "ruby", "perl", "cmd.exe",
    "powershell.exe", "&", "$env:claude_project_dir",
  ]);
  for (const tokenRaw of tokens) {
    const token = tokenRaw.replace(/^["']|["']$/g, "");
    if (token.startsWith("-") || token.includes("=")) continue;
    const base = (token.split(/[\\/]/).pop() ?? token).toLowerCase();
    if (WRAPPERS.has(base)) continue;
    const formatted = formatNameStem(token.split(/[\\/]/).pop() ?? token);
    if (formatted) return formatted;
  }

  return undefined;
}

/** Turn a kebab/snake/camel basename stem into a Title Case label. */
function formatNameStem(stem: string): string | undefined {
  const cleaned = stem
    // camelCase / PascalCase → spaced
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // separators → spaces
    .replace(/[-_.]+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  return words
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Hooks() {
  const [list, setList] = useState<HooksList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [filterText, setFilterText] = useState<string>("");

  // Selected hook id drives the detail pane
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiDescription, setAiDescription] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  const [editTarget, setEditTarget] = useState<HookRecord | null>(null);
  const [testTarget, setTestTarget] = useState<HookRecord | null>(null);

  const [fires, setFires] = useState<HookFiresReport | null>(null);
  const [lastFired, setLastFired] = useState<Record<string, HookLastFired>>({});

  // Auto-naming state
  const [namesCache, setNamesCache] = useState<Record<string, { name: string; strategy: string }>>({});
  const [namingBusy, setNamingBusy] = useState(false);
  const [namingProgress, setNamingProgress] = useState<string | null>(null);

  // Readable title + summary per hook (analysed from the script, no AI).
  const [descriptions, setDescriptions] = useState<Record<string, HookDescription>>({});

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  const fetchList = useCallback(async () => {
    try {
      const res = (await invoke("list_hooks")) as HooksList;
      setList(res);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  async function fetchFires() {
    try {
      const res = (await invoke("recent_hook_fires", { limit: 50 })) as HookFiresReport;
      setFires(res);
    } catch (e) {
      // Non-fatal
    }
  }

  async function fetchNamesCache() {
    try {
      const raw = (await invoke("get_hook_names_cache")) as Record<string, { name: string; strategy: string }>;
      setNamesCache(raw ?? {});
    } catch {
      // Non-fatal
    }
  }

  async function fetchDescriptions() {
    try {
      const list = (await invoke("get_hook_descriptions")) as HookDescription[];
      const map: Record<string, HookDescription> = {};
      for (const d of list) map[d.id] = d;
      setDescriptions(map);
    } catch {
      // Non-fatal — cards fall back to the raw id.
    }
  }

  useEffect(() => {
    fetchList();
    fetchFires();
    fetchNamesCache();
    fetchDescriptions();
  }, [fetchList]);

  // Refresh per-hook last-fired whenever the list changes
  useEffect(() => {
    const hooks = list?.hooks ?? [];
    if (hooks.length === 0) {
      setLastFired({});
      return;
    }
    let cancelled = false;
    (async () => {
      const map: Record<string, HookLastFired> = {};
      for (const h of hooks) {
        try {
          const r = (await invoke("hooks_last_fired", { id: h.id })) as HookLastFired;
          map[h.id] = r;
        } catch {
          // skip
        }
      }
      if (!cancelled) setLastFired(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [list]);

  function showFlash(msg: string) {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 4000);
  }

  // -------------------------------------------------------------------------
  // CRUD handlers
  // -------------------------------------------------------------------------

  async function handleToggle(hook: HookRecord) {
    try {
      const res = (await invoke("toggle_hook", { id: hook.id })) as HookMutationResult;
      showFlash(
        `${res.hook?.enabled ? "Enabled" : "Disabled"} hook. Backup: ${res.backup_path ?? "n/a"}`,
      );
      await fetchList();
    } catch (e) {
      showFlash(`Toggle failed: ${e}`);
    }
  }

  async function handleDelete(hook: HookRecord) {
    try {
      const res = (await invoke("delete_hook", { id: hook.id })) as HookMutationResult;
      showFlash(`Deleted hook. Backup: ${res.backup_path ?? "n/a"}`);
      if (selectedId === hook.id) setSelectedId(null);
      await fetchList();
    } catch (e) {
      showFlash(`Delete failed: ${e}`);
    }
  }

  async function submitAi() {
    const desc = aiDescription.trim();
    if (!desc) return;
    setAiBusy(true);
    try {
      const res = (await invoke("request_hook_via_ai", { description: desc })) as string;
      showFlash(res);
      setAiOpen(false);
      setAiDescription("");
    } catch (e) {
      showFlash(`AI request failed: ${e}`);
    } finally {
      setAiBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Auto-naming handlers
  // -------------------------------------------------------------------------

  async function handleAutoNameSingle(hookId: string) {
    try {
      const res = (await invoke("analyze_hook_name", { id: hookId })) as HookNameResult;
      setNamesCache((prev) => ({
        ...prev,
        [res.id]: { name: res.name, strategy: res.strategy },
      }));
    } catch (e) {
      showFlash(`Naming failed: ${e}`);
    }
  }

  async function handleAutoNameAll() {
    setNamingBusy(true);
    setNamingProgress("Analyzing hooks...");
    try {
      const results = (await invoke("bulk_analyze_hook_names")) as HookNameResult[];
      const updates: Record<string, { name: string; strategy: string }> = {};
      let newCount = 0;
      for (const r of results) {
        updates[r.id] = { name: r.name, strategy: r.strategy };
        if (!r.cached) newCount++;
      }
      setNamesCache((prev) => ({ ...prev, ...updates }));
      setNamingProgress(null);
      showFlash(`Named ${newCount} hook(s). ${results.length - newCount} already cached.`);
    } catch (e) {
      showFlash(`Auto-name failed: ${e}`);
      setNamingProgress(null);
    } finally {
      setNamingBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Derived: grouping by event for sidebar
  // -------------------------------------------------------------------------

  const q = filterText.trim().toLowerCase();

  /** Resolve the best available human-readable label for a hook, in priority order:
   *  1. analysed title from get_hook_descriptions (readable name of what it does)
   *  2. description field from settings.json (if the group declares one)
   *  3. AI-assigned name from namesCache (kebab-case)
   *  4. name derived locally from the command/script basename (no AI, no cache)
   *  5. undefined (caller renders raw id in monospace)
   */
  function resolveDisplayName(h: HookRecord): string | undefined {
    const title = descriptions[h.id]?.title;
    if (title) return title;
    if (h.description) return h.description;
    const cached = namesCache[h.id]?.name;
    if (cached) return cached;
    return deriveNameFromCommand(h.command);
  }

  const filtered = useMemo(() => {
    if (!list) return [];
    return list.hooks.filter((h) => {
      if (!q) return true;
      const displayName = resolveDisplayName(h) ?? h.id;
      const summary = descriptions[h.id]?.summary ?? "";
      const hay = `${displayName} ${summary} ${h.id} ${h.matcher ?? ""} ${h.command} ${h.event}`.toLowerCase();
      return hay.includes(q);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, q, namesCache, descriptions]);

  const selectedHook = useMemo(
    () => list?.hooks.find((h) => h.id === selectedId) ?? null,
    [list, selectedId],
  );

  const selectedFires = useMemo(() => {
    if (!fires || !selectedHook) return [];
    return fires.fires.filter((f) => f.hook_id === selectedHook.id);
  }, [fires, selectedHook]);

  // -------------------------------------------------------------------------
  // Blocks navigator (estilo Agents/Skills) — tarjetas de categoría (evento)
  // que al hacer click revelan los hooks de ese evento. NO pills arriba.
  // -------------------------------------------------------------------------

  const blockItems: BlocksItem<HookRecord>[] = useMemo(
    () =>
      filtered.map((h) => ({
        key: h.id,
        topGroup: h.event,
        subGroup: null,
        data: h,
      })),
    [filtered],
  );

  // -------------------------------------------------------------------------
  // Main card grid — renders the hook cards for a given list
  // -------------------------------------------------------------------------

  const renderCardGrid = (items: HookRecord[]) => (
    <div
      className="grid gap-3 p-4"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
    >
      {items.map((h) => {
        const isActive = selectedId === h.id;
        const colors = eventColors(h.event);
        const title = resolveDisplayName(h);
        const summary = descriptions[h.id]?.summary;
        return (
          <button
            key={h.id}
            type="button"
            onClick={() => setSelectedId(isActive ? null : h.id)}
            className="group flex h-[156px] flex-col justify-between rounded-xl p-4 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            style={{
              background: isActive ? "var(--color-surface-3)" : "var(--color-surface-2)",
              border: `1px solid ${isActive ? colors.ribbonBorder : "var(--color-border)"}`,
              // Ribbon comes purely from the event color — no amber overlay
              boxShadow: `inset 0 3px 0 ${colors.ribbon}`,
              opacity: h.enabled ? 1 : 0.55,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = colors.ribbonBorder;
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${colors.ribbon}, 0 6px 18px rgba(0,0,0,0.28)`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = isActive ? colors.ribbonBorder : "var(--color-border)";
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${colors.ribbon}`;
            }}
            title={`${h.id}\n${h.command}`}
          >
            {/* Top row: "Hook" label + event badge */}
            <div
              className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              <span style={{ color: colors.chipFg }}>Hook</span>
              <span
                className="ml-auto rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide"
                style={{
                  background: colors.chipBg,
                  color: colors.chipFg,
                  border: `1px solid ${colors.chipBorder}`,
                }}
              >
                {h.event}
              </span>
            </div>

            {/* Center: readable name + one-line summary (fallback: raw id) */}
            <div className="flex min-h-0 flex-1 flex-col justify-center gap-1 py-1">
              {title ? (
                <div
                  className="line-clamp-2 text-[15px] font-semibold leading-tight tracking-tight"
                  style={{ color: "var(--color-text)" }}
                >
                  {title}
                </div>
              ) : (
                <div
                  className="line-clamp-2 text-[12.5px] font-medium leading-tight"
                  style={{ color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}
                >
                  {h.id}
                </div>
              )}
              {summary && (
                <div
                  className="line-clamp-2 text-[11px] leading-snug"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {summary}
                </div>
              )}
            </div>

            {/* Bottom row: source, disabled badge, last fired */}
            <div
              className="flex items-center gap-1.5 text-[10px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              <span
                className="rounded px-1.5 py-px"
                style={{
                  background: colors.chipBg,
                  color: colors.chipFg,
                  border: `1px solid ${colors.chipBorder}`,
                }}
              >
                {h.source}
              </span>
              {!h.enabled && (
                <span style={{ color: "var(--color-text-faint)" }}>disabled</span>
              )}
              {lastFired[h.id]?.timestamp && (
                <span
                  className="ml-auto truncate"
                  style={{ fontFamily: "var(--font-mono)" }}
                  title={`Last fired ${lastFired[h.id].timestamp ?? ""} in ${lastFired[h.id].project ?? "?"}`}
                >
                  {(lastFired[h.id].timestamp ?? "").slice(0, 16).replace("T", " ")}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col gap-0">
      {/* Top toolbar */}
      <header
        className="flex items-center justify-between gap-2 border-b px-4 py-2"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-1)" }}
      >
        <div className="flex items-baseline gap-2">
          <h2 className="text-[14px] font-semibold">Hooks</h2>
          <span
            className="text-[11px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {filtered.length} of {list?.hooks.length ?? 0}
            {list?.settings_path && (
              <>
                {" "}·{" "}
                <code className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                  {list.settings_path}
                </code>
              </>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {namingProgress && (
            <span
              className="text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {namingProgress}
            </span>
          )}
          <button
            type="button"
            onClick={() => void handleAutoNameAll()}
            disabled={namingBusy || loading}
            className="rounded-md border px-3 py-1 text-xs disabled:opacity-50"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
            title="Assign readable names to all hooks using AI Router (Haiku/Gemini) with heuristic fallback"
          >
            {namingBusy ? "Naming…" : "Auto-name all"}
          </button>
          <button
            type="button"
            onClick={() => void fetchList()}
            className="rounded-md border px-3 py-1 text-xs"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
            title="Re-read settings.json"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setAiOpen(true)}
            className="rounded-md border px-3 py-1 text-xs"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
            title="Open a Claude session that drafts the hook JSON for you"
          >
            Add with AI
          </button>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            <Plus size={12} /> Create hook
          </button>
        </div>
      </header>

      {flash && (
        <div
          className="border-b px-4 py-1.5 text-[12px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
          }}
        >
          {flash}
        </div>
      )}

      {error && (
        <div
          className="mx-4 mt-2 rounded-md p-2 text-xs"
          style={{
            border: "1px solid rgba(248, 81, 73, 0.30)",
            background: "rgba(248, 81, 73, 0.08)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* No-settings banner */}
      {list && !list.settings_exists && (
        <div
          className="border-b px-4 py-1.5 text-[12px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
          }}
        >
          settings.json does not exist yet. Adding the first hook will create it.
        </div>
      )}

      {/* No-instrumentation notice — shown only when the log file is absent */}
      {!loading && fires && !fires.instrumented && (
        <div
          className="border-b px-4 py-1.5 text-[11.5px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-tertiary)",
          }}
        >
          Fire history not available — no hook-fires log found.
        </div>
      )}

      {loading && (
        <div className="px-4 py-3 text-[13px]" style={{ color: "var(--color-text-tertiary)" }}>
          Loading…
        </div>
      )}

      {/* Empty state */}
      {!loading && list && list.hooks.length === 0 && (
        <div className="p-4">
          <HooksEmptyState onAdd={() => setAddOpen(true)} onAi={() => setAiOpen(true)} />
        </div>
      )}

      {/* Layout estilo Agents: search + navegador de bloques por evento (grid | detail) */}
      {!loading && list && list.hooks.length > 0 && (
        <div className="flex h-full flex-col gap-3 p-4">
          {/* Search */}
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Search hooks by name, command, matcher or event…"
            className="w-full rounded-md px-3 py-2 text-sm outline-none"
            style={{
              border: "1px solid var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
          />

          {/* Navegador de bloques | detail pane */}
          <div className="flex flex-1 gap-3 overflow-hidden">
            <div
              className={selectedHook ? "min-w-0 flex-1 overflow-y-auto" : "flex-1 overflow-y-auto"}
              style={{ minWidth: 0 }}
            >
              {q ? (
                // Con búsqueda activa mostramos un grid plano de coincidencias.
                filtered.length === 0 ? (
                  <div
                    className="px-2 py-4 text-xs"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Ningún hook coincide con la búsqueda.
                  </div>
                ) : (
                  renderCardGrid(filtered)
                )
              ) : (
                // Sin búsqueda: tarjetas de categoría (evento) → click revela los hooks.
                <BlocksView<HookRecord>
                  items={blockItems}
                  noun="hook"
                  emptyLabel="No hay hooks."
                  topGroupAccent={(g) => eventColors(g).ribbon}
                  renderLeaves={(leaves) => renderCardGrid(leaves.map((l) => l.data))}
                />
              )}
            </div>

          {/* Right: detail pane */}
          {selectedHook && (
            <div
              className="overflow-hidden"
              style={{ width: 520, minWidth: 300, borderLeft: "1px solid var(--color-border)" }}
            >
              <HookDetailPane
                hook={selectedHook}
                displayName={resolveDisplayName(selectedHook)}
                lastFired={lastFired[selectedHook.id]}
                fires={selectedFires}
                firesInstrumented={fires?.instrumented ?? false}
                firesLogPath={fires?.log_path ?? null}
                onTest={() => setTestTarget(selectedHook)}
                onEdit={() => setEditTarget(selectedHook)}
                onToggle={() => void handleToggle(selectedHook)}
                onNameThis={() => void handleAutoNameSingle(selectedHook.id)}
                onDelete={async () => {
                  const ok = await confirmDialog(
                    `Delete hook?\n\nEvent: ${selectedHook.event}\nMatcher: ${selectedHook.matcher ?? "(none)"}\nCommand: ${truncate(selectedHook.command, 200)}`,
                    { title: "Delete hook", kind: "error" },
                  );
                  if (ok) await handleDelete(selectedHook);
                }}
                onClose={() => setSelectedId(null)}
              />
            </div>
          )}
          </div>
        </div>
      )}

      {addOpen && (
        <HookFormModal
          mode="add"
          onClose={() => setAddOpen(false)}
          onSaved={async (msg) => {
            setAddOpen(false);
            showFlash(msg);
            await fetchList();
          }}
        />
      )}

      {editTarget && (
        <HookFormModal
          mode="edit"
          initial={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={async (msg) => {
            setEditTarget(null);
            showFlash(msg);
            await fetchList();
          }}
        />
      )}

      {testTarget && (
        <TestModal hook={testTarget} onClose={() => setTestTarget(null)} />
      )}

      {aiOpen && (
        <AiModal
          description={aiDescription}
          busy={aiBusy}
          onChange={setAiDescription}
          onClose={() => setAiOpen(false)}
          onSubmit={submitAi}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail pane
// ---------------------------------------------------------------------------

function HookDetailPane({
  hook,
  displayName,
  lastFired,
  fires,
  firesInstrumented,
  firesLogPath,
  onTest,
  onEdit,
  onToggle,
  onNameThis,
  onDelete,
  onClose,
}: {
  hook: HookRecord;
  displayName: string | undefined;
  lastFired: HookLastFired | undefined;
  fires: HookFire[];
  firesInstrumented: boolean;
  firesLogPath: string | null;
  onTest: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onNameThis: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const colors = eventColors(hook.event);

  return (
    <aside
      className="flex h-full w-full flex-col overflow-hidden"
      style={{ background: "var(--color-surface-2)" }}
    >
      {/* Header — ribbon comes from event color */}
      <header
        className="flex items-start justify-between gap-2 border-b p-3"
        style={{
          borderColor: "var(--color-border)",
          boxShadow: `inset 0 3px 0 ${colors.ribbon}`,
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {displayName ? (
              <span
                className="truncate text-[13.5px] font-semibold"
                style={{ color: "var(--color-text)" }}
                title={hook.id}
              >
                {displayName}
              </span>
            ) : (
              <span
                className="truncate text-[12.5px] font-semibold"
                style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
                title={hook.id}
              >
                {hook.id}
              </span>
            )}
            <span
              className="rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide"
              style={{
                background: colors.chipBg,
                color: colors.chipFg,
                border: `1px solid ${colors.chipBorder}`,
              }}
            >
              {hook.event}
            </span>
          </div>
          <div
            className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px]"
            style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)" }}
          >
            {displayName && (
              <span style={{ color: "var(--color-text-tertiary)" }}>{hook.id}</span>
            )}
            <span>matcher: {hook.matcher ?? "(any)"}</span>
            <span>source: {hook.source}</span>
            <span>{hook.enabled ? "enabled" : "disabled"}</span>
            {lastFired?.timestamp && (
              <span title={`in ${lastFired.project ?? "?"}`}>
                last fired {lastFired.timestamp.slice(0, 16).replace("T", " ")}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1"
          style={{
            background: "transparent",
            color: "var(--color-text-tertiary)",
            border: "1px solid var(--color-border)",
          }}
          title="Close detail panel"
          aria-label="Close"
        >
          <X size={12} />
        </button>
      </header>

      {/* Action bar */}
      <div
        className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        <button
          type="button"
          onClick={onTest}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11.5px] font-medium"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          title="Run this hook against a mock payload in a sandboxed shell"
        >
          Test
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px]"
          style={{
            background: "var(--color-surface-3)",
            borderColor: "var(--color-border-strong)",
            color: "var(--color-text)",
          }}
          title="Edit matcher / command / extra flags"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px]"
          style={{
            background: "transparent",
            borderColor: "var(--color-border-strong)",
            color: hook.enabled ? "var(--color-text-secondary)" : colors.chipFg,
          }}
          title={hook.enabled ? "Disable this hook" : "Enable this hook"}
        >
          {hook.enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          onClick={onNameThis}
          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px]"
          style={{
            background: "transparent",
            borderColor: "var(--color-border-strong)",
            color: "var(--color-text-secondary)",
          }}
          title="Assign a readable name using AI Router (or heuristic fallback)"
        >
          Name
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="ml-auto inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px]"
          style={{
            background: "transparent",
            borderColor: "rgba(248, 81, 73, 0.30)",
            color: "var(--color-danger, #f88)",
          }}
          title="Delete this hook from settings.json"
        >
          Delete
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-4">
          <div
            className="mb-1 text-[10px] font-medium uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Command
          </div>
          <pre
            className="overflow-auto rounded border p-2 text-[11.5px]"
            style={{
              borderColor: "var(--color-border)",
              background: "var(--color-surface-1)",
              color: "var(--color-text)",
              fontFamily: "var(--font-mono)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            <code>{hook.command}</code>
          </pre>
        </div>

        {Object.keys(hook.extra).length > 0 && (
          <div className="mb-4">
            <div
              className="mb-1 text-[10px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Extra flags
            </div>
            <pre
              className="overflow-auto rounded border p-2 text-[11.5px]"
              style={{
                borderColor: "var(--color-border)",
                background: "var(--color-surface-1)",
                color: "var(--color-text)",
                fontFamily: "var(--font-mono)",
              }}
            >
              <code>{JSON.stringify(hook.extra, null, 2)}</code>
            </pre>
          </div>
        )}

        {/* Recent fires */}
        <div>
          <div
            className="mb-1 text-[10px] font-medium uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Recent fires
          </div>
          {!firesInstrumented && (
            <div
              className="rounded border px-2 py-1.5 text-[11.5px]"
              style={{
                borderColor: "var(--color-border)",
                background: "var(--color-surface-1)",
                color: "var(--color-text-tertiary)",
              }}
            >
              No fire history available.
            </div>
          )}
          {firesInstrumented && fires.length === 0 && (
            <div className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              No fires logged for this hook yet.
            </div>
          )}
          {firesInstrumented && fires.length > 0 && (
            <ul className="space-y-1">
              {fires.map((f, i) => (
                <li
                  key={i}
                  className="rounded border px-2 py-1 text-[11.5px]"
                  style={{
                    borderColor: "var(--color-border)",
                    background: "var(--color-surface-1)",
                  }}
                >
                  <div style={{ color: "var(--color-text)" }}>
                    {f.timestamp ?? "(no ts)"} · exit{" "}
                    <span
                      style={{
                        color: f.exit_code === 0 ? "var(--color-success)" : "var(--color-warn)",
                      }}
                    >
                      {f.exit_code ?? "?"}
                    </span>
                  </div>
                  <div style={{ color: "var(--color-text-tertiary)" }}>
                    {f.event ?? "?"} / {f.matcher ?? "any"}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {firesLogPath && (
            <div className="mt-2 text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
              Log:{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>{firesLogPath}</code>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function HooksEmptyState({ onAdd, onAi }: { onAdd: () => void; onAi: () => void }) {
  return (
    <div
      className="rounded p-5"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      <div className="mb-1 text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
        No hooks configured
      </div>
      <p
        className="mb-4 text-[12px] leading-relaxed"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Hooks are shell commands Claude Code runs around tool calls and session lifecycle events.
        They live in{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>~/.claude/settings.json</code> under the{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>hooks</code> key.
      </p>
      <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-3">
        {(["PreToolUse", "PostToolUse", "Stop"] as const).map((ev) => {
          const colors = eventColors(ev);
          const desc: Record<string, string> = {
            PreToolUse: "Before a tool runs. Exit 2 to block. Good for command audits and policy checks.",
            PostToolUse: "After a tool succeeds. Good for auto-format, lint, dependency updates.",
            Stop: "When Claude finishes responding. Good for end-of-session checks (debug statements, dirty git tree).",
          };
          return (
            <div
              key={ev}
              className="rounded p-2.5"
              style={{
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border)",
                boxShadow: `inset 0 3px 0 ${colors.ribbon}`,
              }}
            >
              <div
                className="mb-1 inline-block rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide"
                style={{ background: colors.chipBg, color: colors.chipFg }}
              >
                {ev}
              </div>
              <div
                className="text-[11.5px] leading-snug"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {desc[ev]}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onAdd}
          className="rounded px-3 py-1.5 text-[12px] font-medium"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
        >
          Add your first hook
        </button>
        <button
          type="button"
          onClick={onAi}
          className="rounded px-3 py-1.5 text-[12px] font-medium"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Describe what you want in plain English; Claude drafts the JSON"
        >
          Add with AI
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / Edit modal
// ---------------------------------------------------------------------------

function HookFormModal({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  initial?: HookRecord;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [event, setEvent] = useState<string>(initial?.event ?? "PreToolUse");
  const [matcher, setMatcher] = useState<string>(initial?.matcher ?? "");
  const [command, setCommand] = useState<string>(initial?.command ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!command.trim()) {
      setErr("Command cannot be empty.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      if (mode === "add") {
        const res = (await invoke("add_hook", {
          event,
          matcher: matcher.trim() || null,
          command,
        })) as HookMutationResult;
        onSaved(`Added hook. Backup: ${res.backup_path ?? "n/a"}`);
      } else if (initial) {
        const res = (await invoke("update_hook", {
          id: initial.id,
          command,
          enabled: null,
          matcher: matcher.trim() || null,
        })) as HookMutationResult;
        onSaved(`Updated hook. Backup: ${res.backup_path ?? "n/a"}`);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-[560px] rounded-md border p-5 shadow-xl"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-1)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[15px] font-semibold">
          {mode === "add" ? "Add hook" : "Edit hook"}
        </div>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Event
          </div>
          <select
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            disabled={mode === "edit"}
            className="w-full rounded px-2 py-1"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          >
            {EVENT_OPTIONS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          {mode === "edit" && (
            <div className="mt-1 text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
              Event is immutable. Delete and re-add to change it.
            </div>
          )}
        </label>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Matcher (optional regex — e.g. "Bash", "Read|Glob|Grep", "mcp__.*")
          </div>
          <input
            type="text"
            value={matcher}
            onChange={(e) => setMatcher(e.target.value)}
            className="w-full rounded px-2 py-1"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          />
        </label>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Command
          </div>
          <textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            rows={6}
            className="w-full rounded px-2 py-1 font-mono text-[11.5px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          />
        </label>

        {err && (
          <div
            className="mb-3 rounded border px-2 py-1 text-[11.5px]"
            style={{ borderColor: "var(--color-border)", color: "var(--color-danger, #f88)" }}
          >
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{ background: "var(--color-surface-2)", color: "var(--color-text-secondary)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            {saving ? "Saving..." : mode === "add" ? "Add hook" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test modal (preserved verbatim from v2.7/v2.8)
// ---------------------------------------------------------------------------

function TestModal({ hook, onClose }: { hook: HookRecord; onClose: () => void }) {
  const [payload, setPayload] = useState<string>(DEFAULT_PAYLOAD);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<HookTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      const res = (await invoke("test_hook", {
        id: hook.id,
        mockPayload: payload,
      })) as HookTestResult;
      setResult(res);
    } catch (e) {
      setErr(String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-[700px] rounded-md border p-5 shadow-xl"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-1)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[15px] font-semibold">Test hook</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[11.5px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Close
          </button>
        </div>

        <div
          className="mb-3 rounded border px-3 py-2 text-[11.5px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-tertiary)",
          }}
        >
          Runs the command in a sandboxed PowerShell with a 5s timeout. The payload is exposed
          via the <code>CLAUDE_HOOK_PAYLOAD</code> env var. Hooks that block on stdin will hit the
          timeout.
        </div>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Mock payload (JSON)
          </div>
          <textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            rows={5}
            className="w-full rounded px-2 py-1 font-mono text-[11.5px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          />
        </label>

        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            {running ? "Running..." : "Run"}
          </button>
        </div>

        {err && (
          <div
            className="mb-3 rounded border px-2 py-1 text-[11.5px]"
            style={{ borderColor: "var(--color-border)", color: "var(--color-danger, #f88)" }}
          >
            {err}
          </div>
        )}

        {result && (
          <div>
            {result.timed_out && (
              <div
                className="mb-2 rounded border px-2 py-1 text-[11.5px] font-semibold"
                style={{
                  borderColor: "var(--color-warn, #f80)",
                  background: "rgba(248,136,0,0.10)",
                  color: "var(--color-warn, #f80)",
                }}
              >
                TIMED OUT after 5s — the command likely blocked on stdin or an interactive prompt.
              </div>
            )}
            {!result.timed_out && !result.success && (
              <div
                className="mb-2 rounded border px-2 py-1 text-[11.5px] font-semibold"
                style={{
                  borderColor: "var(--color-danger, #f88)",
                  background: "rgba(248,113,113,0.10)",
                  color: "var(--color-danger, #f88)",
                }}
              >
                FAILED (exit code {result.exit_code ?? "?"})
              </div>
            )}
            {result.success && (
              <div
                className="mb-2 rounded border px-2 py-1 text-[11.5px] font-semibold"
                style={{
                  borderColor: "var(--color-success, #2da)",
                  background: "rgba(45,212,191,0.10)",
                  color: "var(--color-success, #2da)",
                }}
              >
                OK (exit 0) · {result.elapsed_ms}ms
              </div>
            )}
            {(["stdout", "stderr"] as const).map((ch) => (
              <div key={ch} className="mb-2">
                <div
                  className="mb-1 text-[10px] uppercase"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {ch}
                </div>
                <pre
                  className="max-h-48 overflow-auto rounded border p-2 text-[11.5px]"
                  style={{
                    borderColor: "var(--color-border)",
                    background: "var(--color-surface-2)",
                    color: "var(--color-text)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {result[ch] || "(empty)"}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI modal (preserved verbatim from v2.7/v2.8)
// ---------------------------------------------------------------------------

function AiModal({
  description,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  description: string;
  busy: boolean;
  onChange: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-[560px] rounded-md border p-5 shadow-xl"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-1)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[15px] font-semibold">Add hook with AI</div>

        <div className="mb-3 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Describe in plain language what the hook should do. Claude opens a new session, drafts
          the JSON, and you paste the result back into "Add hook" to confirm.
        </div>

        <textarea
          value={description}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          placeholder="e.g. Before every Bash tool call, log the command being run to ~/.ultron/.tmp/bash-audit.jsonl"
          className="mb-3 w-full rounded px-2 py-1 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border)",
          }}
        />

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{ background: "var(--color-surface-2)", color: "var(--color-text-secondary)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !description.trim()}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            {busy ? "Opening..." : "Open Claude"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Hooks;
