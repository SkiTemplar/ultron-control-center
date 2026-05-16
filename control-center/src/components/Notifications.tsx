import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AlertEntry } from "../types";
import { getUltronRoot } from "../lib/paths";

type Props = {
  alerts: AlertEntry[];
  /** Parent should re-`invoke("read_alerts", ...)` and update its state.
   *  Called after a successful destructive op (delete from alerts.jsonl).
   *  If omitted, the component falls back to `window.location.reload()`
   *  so the UI never lies about the disk state. */
  onDeleted?: () => void | Promise<void>;
};

// ---------------------------------------------------------------------------
// Severity styling
// ---------------------------------------------------------------------------

type SevWeight = 0 | 1 | 2;
type SevKey = "info" | "warn" | "critical";

type SevStyle = {
  color: string;
  bg: string;
  ring: string;
  label: string;
  key: SevKey;
  weight: SevWeight;
};

function severityStyle(sev: string): SevStyle {
  switch (sev) {
    case "critical":
    case "blocking":
      return {
        color: "var(--color-danger)",
        bg: "rgba(248, 81, 73, 0.06)",
        ring: "rgba(248, 81, 73, 0.20)",
        label: "critical",
        key: "critical",
        weight: 2,
      };
    case "warn":
      return {
        color: "var(--color-warn)",
        bg: "rgba(210, 153, 34, 0.05)",
        ring: "rgba(210, 153, 34, 0.18)",
        label: "warn",
        key: "warn",
        weight: 1,
      };
    case "info":
    default:
      return {
        color: "var(--color-text-tertiary)",
        bg: "transparent",
        ring: "var(--color-border)",
        label: "info",
        key: "info",
        weight: 0,
      };
  }
}

// ---------------------------------------------------------------------------
// Date filters
// ---------------------------------------------------------------------------

type DateFilter = "1h" | "24h" | "7d" | "all";

const DATE_LABEL: Record<DateFilter, string> = {
  "1h": "Last hour",
  "24h": "Last 24h",
  "7d": "Last 7 days",
  "all": "All",
};

function passesDateFilter(ts: string, filter: DateFilter): boolean {
  if (filter === "all") return true;
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (isNaN(t)) return false;
  const delta = Date.now() - t;
  switch (filter) {
    case "1h":
      return delta <= 3600_000;
    case "24h":
      return delta <= 86_400_000;
    case "7d":
      return delta <= 7 * 86_400_000;
  }
}

// ---------------------------------------------------------------------------
// Dedupe: collapse identical alerts into a single row with count.
// ---------------------------------------------------------------------------

type Grouped = {
  source: string;
  message: string;
  severity: string;
  count: number;
  first_ts: string;
  last_ts: string;
};

function fingerprint(a: AlertEntry): string {
  const msg = (a.message ?? "").trim().replace(/\s+/g, " ");
  return `${a.source}::${msg.slice(0, 80)}`;
}

function getTs(a: AlertEntry): string {
  return a.timestamp ?? a.ts ?? "";
}

function dedupe(alerts: AlertEntry[]): Grouped[] {
  const map = new Map<string, Grouped>();
  for (const a of alerts) {
    const fp = fingerprint(a);
    const ts = getTs(a);
    const ex = map.get(fp);
    if (ex) {
      ex.count += 1;
      if (ts && (!ex.last_ts || ts > ex.last_ts)) ex.last_ts = ts;
      if (ts && (!ex.first_ts || ts < ex.first_ts)) ex.first_ts = ts;
    } else {
      map.set(fp, {
        source: a.source,
        message: a.message,
        severity: a.severity,
        count: 1,
        first_ts: ts,
        last_ts: ts,
      });
    }
  }
  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const MUTE_KEY = "ultron.cc.muted_sources.v1";
const DISMISSED_KEY = "ultron.cc.dismissed_fingerprints.v1";
const TOAST_KEY = "ultron.cc.toast_enabled.v1";

function loadToastEnabled(): boolean {
  try {
    const raw = localStorage.getItem(TOAST_KEY);
    if (raw === null) return true;
    return raw === "1";
  } catch {
    return true;
  }
}
function saveToastEnabled(v: boolean) {
  try {
    localStorage.setItem(TOAST_KEY, v ? "1" : "0");
  } catch {}
}

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}
function saveDismissed(d: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(d)));
  } catch {}
}
const SEV_KEY = "ultron.cc.sev_filters.v1";
const DATE_KEY = "ultron.cc.date_filter.v1";

function loadMutes(): Set<string> {
  try {
    const raw = localStorage.getItem(MUTE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}
function saveMutes(m: Set<string>) {
  try { localStorage.setItem(MUTE_KEY, JSON.stringify(Array.from(m))); } catch {}
}

function loadSevFilters(): Set<SevKey> {
  try {
    const raw = localStorage.getItem(SEV_KEY);
    if (!raw) return new Set(["info", "warn", "critical"]);
    return new Set(JSON.parse(raw));
  } catch {
    return new Set(["info", "warn", "critical"]);
  }
}
function saveSevFilters(s: Set<SevKey>) {
  try { localStorage.setItem(SEV_KEY, JSON.stringify(Array.from(s))); } catch {}
}

function loadDateFilter(): DateFilter {
  try {
    const raw = localStorage.getItem(DATE_KEY) as DateFilter | null;
    if (raw && ["1h", "24h", "7d", "all"].includes(raw)) return raw;
  } catch {}
  return "all";
}
function saveDateFilter(d: DateFilter) {
  try { localStorage.setItem(DATE_KEY, d); } catch {}
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

// Build the seed prompt the user pastes into the spawned Claude/Codex session.
// Kept in module scope (not inside Row) so tests can target it later without
// rendering React. The wording is deliberately verbose: the LLM benefits from
// the full source/severity/count tuple plus pointer hints to the most likely
// repos involved (scripts/ for python tooling, control-center/ for the UI).
function buildFixPrompt(g: Grouped): string {
  return [
    "I just got a CRITICAL ULTRON notification:",
    "",
    `Source: ${g.source}`,
    `Severity: ${g.severity}`,
    `Count: ${g.count} occurrence(s)`,
    `First seen: ${g.first_ts}`,
    `Last seen: ${g.last_ts}`,
    "",
    "Message:",
    g.message,
    "",
    "Please investigate the root cause and propose a fix. The relevant files",
    "are likely under ~/.ultron/scripts/ or ~/.ultron/control-center/. If this",
    "is a security scan blocking a skill, check the skill's SKILL.md frontmatter",
    "and the security ruleset at ~/.ultron/scripts/cockpit/skill_sync_security.py.",
  ].join("\n");
}

type FixProvider = "claude" | "codex";

// Bulk version of buildFixPrompt: consolidates every actionable group
// (critical+warn) into a single mega-prompt. Pure function so it can be
// unit-tested without React. Truncation policy: if the rendered prompt
// exceeds MAX_PROMPT_CHARS, we keep the head (header + most-recent items)
// and drop the oldest entries, replacing them with a one-line marker so
// the LLM knows the list was cropped (instead of silently lying).
const MAX_PROMPT_CHARS = 30_000;

export function buildBulkFixPrompt(groups: Grouped[]): string {
  // Split by severity bucket. Critical/blocking first, warn second.
  // Info is intentionally excluded — those are not worth a spawn.
  const critical: Grouped[] = [];
  const warn: Grouped[] = [];
  for (const g of groups) {
    const w = severityStyle(g.severity).weight;
    if (w === 2) critical.push(g);
    else if (w === 1) warn.push(g);
  }
  // Newest-first inside each bucket so truncation drops the oldest.
  const byLastDesc = (a: Grouped, b: Grouped) =>
    (b.last_ts || "").localeCompare(a.last_ts || "");
  critical.sort(byLastDesc);
  warn.sort(byLastDesc);

  const fmt = (g: Grouped, i: number) => {
    const head =
      g.count > 1
        ? `${i + 1}. [source: ${g.source}] (×${g.count}, last ${g.last_ts || "?"})`
        : `${i + 1}. [source: ${g.source}] (${g.last_ts || "?"})`;
    // Single-line message preview keeps the block compact; the LLM gets
    // the full text via the alerts.jsonl pointer in the footer.
    const msg = (g.message ?? "").replace(/\s+/g, " ").trim();
    return `${head}\n   ${msg}`;
  };

  const buildFrom = (
    critSlice: Grouped[],
    warnSlice: Grouped[],
    omittedCrit: number,
    omittedWarn: number,
  ): string => {
    const parts: string[] = [
      "I'm getting multiple ULTRON notifications. Please investigate ALL of them",
      "and propose fixes. Group related ones if applicable, prioritize critical",
      "over warn.",
      "",
    ];
    if (critSlice.length > 0) {
      parts.push(`=== CRITICAL (${critSlice.length}${omittedCrit ? ` of ${critSlice.length + omittedCrit}` : ""}) ===`);
      critSlice.forEach((g, i) => parts.push(fmt(g, i)));
      if (omittedCrit > 0) {
        parts.push(`[... ${omittedCrit} more older critical alerts omitted ...]`);
      }
      parts.push("");
    }
    if (warnSlice.length > 0) {
      parts.push(`=== WARN (${warnSlice.length}${omittedWarn ? ` of ${warnSlice.length + omittedWarn}` : ""}) ===`);
      warnSlice.forEach((g, i) => parts.push(fmt(g, i)));
      if (omittedWarn > 0) {
        parts.push(`[... ${omittedWarn} more older warn alerts omitted ...]`);
      }
      parts.push("");
    }
    parts.push(
      "Please:",
      "1. Identify the root cause(s) — are these symptoms of one underlying issue?",
      "2. Propose a coordinated fix sequence.",
      "3. Start by reading scripts/cockpit/skill_sync_security.py if security warns",
      "   are involved, and ~/.ultron/alerts.jsonl for the full context.",
    );
    return parts.join("\n");
  };

  // Optimistic full render first.
  let critSlice = critical;
  let warnSlice = warn;
  let omittedCrit = 0;
  let omittedWarn = 0;
  let out = buildFrom(critSlice, warnSlice, omittedCrit, omittedWarn);
  // Drop oldest warn entries first (they are lower priority), then oldest
  // critical entries. Iterative shrink — each pass re-renders so the
  // truncation footer is accounted for in the size check.
  while (out.length > MAX_PROMPT_CHARS && warnSlice.length > 0) {
    warnSlice = warnSlice.slice(0, -1);
    omittedWarn += 1;
    out = buildFrom(critSlice, warnSlice, omittedCrit, omittedWarn);
  }
  while (out.length > MAX_PROMPT_CHARS && critSlice.length > 1) {
    critSlice = critSlice.slice(0, -1);
    omittedCrit += 1;
    out = buildFrom(critSlice, warnSlice, omittedCrit, omittedWarn);
  }
  return out;
}

function Row({ g }: { g: Grouped }) {
  const s = severityStyle(g.severity);
  const subtle = s.weight === 0;
  // The Fix button is only meaningful for severity buckets that severityStyle
  // maps to weight 2 ("critical" or "blocking"). Warn/info show nothing —
  // the user explicitly didn't want noise on those.
  const isCritical = s.weight === 2;

  // Per-row spawn state. Local state (not lifted) because each card spawns
  // independently — two simultaneous Fix clicks on different cards should
  // both work without one stomping the other's status.
  const [fixBusy, setFixBusy] = useState<FixProvider | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [fixToast, setFixToast] = useState<string | null>(null);

  async function openFixSession(provider: FixProvider) {
    if (fixBusy) return;
    setFixBusy(provider);
    setFixError(null);
    setFixToast(null);
    try {
      const prompt = buildFixPrompt(g);
      // cwd = ~/.ultron so the spawned shell starts where the relevant
      // scripts, hooks, alerts.jsonl and logs live — diagnosing a system
      // alert from C:\Users\<user>\ has zero context.
      const cwd = await getUltronRoot().catch(() => null);
      await invoke("spawn_session", {
        provider,
        prompt,
        cwd,
        // paste_only = true → wrapper copies the prompt to the clipboard and
        // opens the terminal. The user pastes with Ctrl+V and hits Enter.
        // Mirrors the F1.9 Diagnose flow so behaviour is consistent.
        flags: { dangerouslySkipPermissions: false, pasteOnly: true },
      });
      const label = provider === "claude" ? "Claude" : "Codex";
      setFixToast(`${label} session opened — paste prompt with Ctrl+V`);
      // Auto-clear the toast after a few seconds so the card returns to its
      // resting state. The error path intentionally does not auto-clear.
      window.setTimeout(() => setFixToast(null), 5000);
    } catch (e) {
      setFixError(String(e));
    } finally {
      setFixBusy(null);
    }
  }

  return (
    <div
      className="flex items-start gap-3 rounded p-3"
      style={{
        background: s.bg,
        border: `1px solid ${s.ring}`,
      }}
    >
      <span
        className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: s.color }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className="text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: s.color }}
          >
            {s.label}
          </span>
          <span
            className="text-[11px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {g.source}
          </span>
          {g.count > 1 && (
            <span
              className="rounded px-1.5 py-px text-[10px] font-medium tabular-nums"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-secondary)",
              }}
            >
              ×{g.count}
            </span>
          )}
          {g.last_ts && (
            <span
              className="ml-auto text-[10.5px] tabular-nums"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {g.last_ts.slice(0, 16).replace("T", " ")}
            </span>
          )}
        </div>
        <div
          className="mt-1 text-[12.5px] leading-snug"
          style={{
            color: subtle ? "var(--color-text-secondary)" : "var(--color-text)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
          title={g.message}
        >
          {g.message}
        </div>
        {isCritical && (
          <div className="mt-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => openFixSession("claude")}
              disabled={fixBusy !== null}
              title="Spawn an interactive Claude session with this error pre-loaded on the clipboard. Paste with Ctrl+V to start the fix."
              className="rounded px-2 py-0.5 text-[11px] transition-colors disabled:opacity-40"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {fixBusy === "claude" ? "Opening…" : "Fix with Claude"}
            </button>
            <button
              type="button"
              onClick={() => openFixSession("codex")}
              disabled={fixBusy !== null}
              title="Same flow, but spawn a Codex session instead. Useful when you want a second opinion or Claude is rate-limited."
              className="rounded px-2 py-0.5 text-[11px] transition-colors disabled:opacity-40"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {fixBusy === "codex" ? "Opening…" : "Fix with Codex"}
            </button>
            {fixToast && (
              <span
                className="text-[10.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {fixToast}
              </span>
            )}
            {fixError && (
              <span
                className="text-[10.5px]"
                style={{ color: "var(--color-danger)" }}
                title={fixError}
              >
                Failed to open session: {fixError.slice(0, 80)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter pill
// ---------------------------------------------------------------------------

function Pill({
  active,
  label,
  count,
  onClick,
  color,
}: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[11.5px] transition-colors"
      style={{
        background: active ? "var(--color-surface-3)" : "transparent",
        color: active ? "var(--color-text)" : "var(--color-text-tertiary)",
        border: `1px solid ${active ? "var(--color-border-strong)" : "var(--color-border)"}`,
      }}
    >
      {color && (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: color, opacity: active ? 1 : 0.4 }}
        />
      )}
      <span>{label}</span>
      {typeof count === "number" && (
        <span
          className="tabular-nums"
          style={{ color: active ? "var(--color-text-secondary)" : "var(--color-text-faint)" }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function Notifications({ alerts, onDeleted }: Props) {
  const [mutes, setMutes] = useState<Set<string>>(() => loadMutes());
  const [sevFilters, setSevFilters] = useState<Set<SevKey>>(() => loadSevFilters());
  const [dateFilter, setDateFilter] = useState<DateFilter>(() => loadDateFilter());
  const [showMuteList, setShowMuteList] = useState(false);
  // Client-side "I've already seen this" set. Used as an immediate visual
  // mask while the disk delete is in flight (and as a soft hide for
  // alerts the backend couldn't physically remove — e.g. malformed lines
  // whose fingerprint we can't reproduce). The authoritative source is
  // always `~/.ultron/alerts.jsonl`.
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());
  const [deleting, setDeleting] = useState(false);
  // Windows toast toggle. localStorage is the canonical UI state; the
  // backend mirror (~/.ultron/.tmp/toast-enabled.flag) is what the Rust
  // emitter consults. We keep them in sync via `set_toast_enabled`.
  const [toastEnabled, setToastEnabled] = useState<boolean>(() => loadToastEnabled());
  // Bulk "Fix all" state. Lifted to the parent because the buttons live
  // in the global toolbar, not inside a Row. Mirrors the per-card flow:
  // {busy:provider} during spawn, {toast} on success, {error} on failure.
  const [bulkFixBusy, setBulkFixBusy] = useState<FixProvider | null>(null);
  const [bulkFixToast, setBulkFixToast] = useState<string | null>(null);
  const [bulkFixError, setBulkFixError] = useState<string | null>(null);

  useEffect(() => saveMutes(mutes), [mutes]);
  useEffect(() => saveSevFilters(sevFilters), [sevFilters]);
  useEffect(() => saveDateFilter(dateFilter), [dateFilter]);
  useEffect(() => saveDismissed(dismissed), [dismissed]);
  // On mount, reconcile localStorage with the backend flag — if the flag
  // file was edited externally (or this is a first run on a new install),
  // the backend value wins.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const remote = (await invoke("get_toast_enabled")) as boolean;
        if (!cancelled && remote !== toastEnabled) {
          setToastEnabled(remote);
          saveToastEnabled(remote);
        }
      } catch {
        /* backend cmd unavailable in legacy builds — keep localStorage */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Persist + push to backend whenever the toggle changes.
  useEffect(() => {
    saveToastEnabled(toastEnabled);
    invoke("set_toast_enabled", { enabled: toastEnabled }).catch(() => {
      /* swallow — UI already updated, backend will catch up next save */
    });
  }, [toastEnabled]);

  // Stats per severity (after date filter, before dedupe — counts raw alerts)
  const dateFiltered = useMemo(
    () => alerts.filter((a) => passesDateFilter(getTs(a), dateFilter)),
    [alerts, dateFilter],
  );

  const sevCounts = useMemo(() => {
    let info = 0,
      warn = 0,
      crit = 0;
    for (const a of dateFiltered) {
      const w = severityStyle(a.severity).weight;
      if (w === 0) info++;
      else if (w === 1) warn++;
      else crit++;
    }
    return { info, warn, critical: crit };
  }, [dateFiltered]);

  const allGroups = useMemo(() => dedupe(dateFiltered), [dateFiltered]);

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const g of allGroups) set.add(g.source);
    return Array.from(set).sort();
  }, [allGroups]);

  // Compute group fingerprint the same way dedupe does so dismissed-set
  // lookups line up.
  const groupKey = (g: { source: string; message: string }) =>
    `${g.source}::${(g.message ?? "").trim().replace(/\s+/g, " ").slice(0, 80)}`;

  const visibleGroups = useMemo(
    () =>
      allGroups
        .filter((g) => sevFilters.has(severityStyle(g.severity).key))
        .filter((g) => !mutes.has(g.source))
        .filter((g) => !dismissed.has(groupKey(g)))
        .sort(
          (a, b) =>
            severityStyle(b.severity).weight - severityStyle(a.severity).weight ||
            b.count - a.count,
        ),
    [allGroups, sevFilters, mutes, dismissed],
  );

  const visibleTotal = visibleGroups.reduce((acc, g) => acc + g.count, 0);

  // "Actionable" = severity that the LLM can do something about.
  // Mirrors the per-row Row component, which only renders Fix buttons
  // when severityStyle.weight === 2 (critical/blocking). We also include
  // warn here because the user explicitly asked for warn in the mega-
  // prompt — bulk mode is more aggressive than per-row mode.
  const actionableGroups = useMemo(
    () =>
      visibleGroups.filter((g) => {
        const w = severityStyle(g.severity).weight;
        return w === 2 || w === 1;
      }),
    [visibleGroups],
  );

  async function openBulkFixSession(provider: FixProvider) {
    if (bulkFixBusy || actionableGroups.length === 0) return;
    setBulkFixBusy(provider);
    setBulkFixError(null);
    setBulkFixToast(null);
    try {
      const prompt = buildBulkFixPrompt(actionableGroups);
      // cwd = ~/.ultron so the spawned shell starts where the relevant
      // scripts, hooks, alerts.jsonl and logs live — diagnosing a system
      // alert from C:\Users\<user>\ has zero context.
      const cwd = await getUltronRoot().catch(() => null);
      await invoke("spawn_session", {
        provider,
        prompt,
        cwd,
        // paste_only mirrors the per-row Fix flow: the prompt lands on
        // the clipboard so the user controls when the session actually
        // starts answering (avoids accidental autoruns of multi-issue
        // fixes).
        flags: { dangerouslySkipPermissions: false, pasteOnly: true },
      });
      const label = provider === "claude" ? "Claude" : "Codex";
      setBulkFixToast(
        `${label} session opened — paste prompt with Ctrl+V to fix ${actionableGroups.length} issue${actionableGroups.length === 1 ? "" : "s"}`,
      );
      window.setTimeout(() => setBulkFixToast(null), 6000);
    } catch (e) {
      setBulkFixError(String(e));
    } finally {
      setBulkFixBusy(null);
    }
  }

  function toggleSev(key: SevKey) {
    const next = new Set(sevFilters);
    if (next.has(key)) {
      if (next.size > 1) next.delete(key);
    } else {
      next.add(key);
    }
    setSevFilters(next);
  }
  function toggleMute(src: string) {
    const next = new Set(mutes);
    if (next.has(src)) next.delete(src);
    else next.add(src);
    setMutes(next);
  }

  const dateFilters: DateFilter[] = ["1h", "24h", "7d", "all"];

  return (
    <div className="px-10 py-8">
      <header className="mb-6">
        <h1 className="text-[20px] font-semibold leading-tight">Notifications</h1>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
          {visibleGroups.length} unique · {visibleTotal} total {DATE_LABEL[dateFilter].toLowerCase()}
        </p>
      </header>

      {/* Severity filters */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Pill
          label="Critical"
          color="var(--color-danger)"
          active={sevFilters.has("critical")}
          count={sevCounts.critical}
          onClick={() => toggleSev("critical")}
        />
        <Pill
          label="Warn"
          color="var(--color-warn)"
          active={sevFilters.has("warn")}
          count={sevCounts.warn}
          onClick={() => toggleSev("warn")}
        />
        <Pill
          label="Info"
          color="var(--color-text-tertiary)"
          active={sevFilters.has("info")}
          count={sevCounts.info}
          onClick={() => toggleSev("info")}
        />

        <div className="mx-2 h-4 w-px" style={{ background: "var(--color-border-strong)" }} />

        {/* Date filters */}
        {dateFilters.map((d) => (
          <Pill
            key={d}
            label={DATE_LABEL[d]}
            active={dateFilter === d}
            onClick={() => setDateFilter(d)}
          />
        ))}

        <div className="ml-auto flex items-center gap-2">
          {(() => {
            const infoVisible = visibleGroups.filter(
              (g) => severityStyle(g.severity).key === "info",
            );
            return (
              <button
                type="button"
                onClick={async () => {
                  if (infoVisible.length === 0 || deleting) return;
                  const fps = infoVisible.map((g) => groupKey(g));
                  // Optimistic hide so the row disappears before the
                  // backend round-trip finishes. The dismissed set is
                  // ignored for fingerprints that no longer exist on
                  // disk after the reload — they just stop showing up.
                  const masked = new Set(dismissed);
                  for (const fp of fps) masked.add(fp);
                  setDismissed(masked);
                  setDeleting(true);
                  try {
                    await invoke("delete_alert_entries", { fingerprints: fps });
                    if (onDeleted) {
                      await onDeleted();
                    } else {
                      // Fallback: parent didn't wire the callback, so we
                      // brute-force a fresh read of alerts.jsonl by
                      // reloading the webview. Ugly but correct.
                      window.location.reload();
                    }
                  } catch (e) {
                    // Roll back the optimistic mask on failure so the
                    // user can retry — the disk file is unchanged.
                    const rollback = new Set(dismissed);
                    setDismissed(rollback);
                    console.error("delete_alert_entries failed:", e);
                  } finally {
                    setDeleting(false);
                  }
                }}
                disabled={infoVisible.length === 0 || deleting}
                title="Elimina permanentemente las notificaciones info visibles de ~/.ultron/alerts.jsonl"
                className="text-[11px] transition-colors disabled:opacity-30"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {deleting ? "Deleting…" : `Delete info (${infoVisible.length})`}
              </button>
            );
          })()}
          {/* Clear all — wipes EVERY visible group (info + warn + critical).
              Same backend (delete_alert_entries) + same optimistic hide as
              Delete info, just no severity filter. Confirms first since
              critical alerts shouldn't disappear by accident. */}
          {visibleGroups.length > 0 && (
            <button
              type="button"
              onClick={async () => {
                if (deleting || visibleGroups.length === 0) return;
                const ok = window.confirm(
                  `Eliminar permanentemente ${visibleGroups.length} notificacion${visibleGroups.length === 1 ? "" : "es"} (incluyendo critical y warn)?`
                );
                if (!ok) return;
                const fps = visibleGroups.map((g) => groupKey(g));
                const masked = new Set(dismissed);
                for (const fp of fps) masked.add(fp);
                setDismissed(masked);
                setDeleting(true);
                try {
                  await invoke("delete_alert_entries", { fingerprints: fps });
                  if (onDeleted) {
                    await onDeleted();
                  } else {
                    window.location.reload();
                  }
                } catch (e) {
                  setDismissed(new Set(dismissed));
                  console.error("delete_alert_entries (all) failed:", e);
                } finally {
                  setDeleting(false);
                }
              }}
              disabled={deleting}
              title="Borra TODAS las notificaciones visibles (info + warn + critical) del archivo alerts.jsonl. Pide confirmación primero."
              className="text-[11px] transition-colors disabled:opacity-30"
              style={{ color: "var(--color-danger)" }}
            >
              {deleting ? "Deleting…" : `Clear all (${visibleGroups.length})`}
            </button>
          )}
          {dismissed.size > 0 && (
            <button
              type="button"
              onClick={() => setDismissed(new Set())}
              title="Restaura todas las notificaciones descartadas"
              className="text-[11px] transition-colors"
              style={{ color: "var(--color-text-faint)" }}
            >
              Undo ({dismissed.size})
            </button>
          )}
          <label
            className="flex cursor-pointer items-center gap-1.5 text-[11px] transition-colors"
            style={{ color: "var(--color-text-tertiary)" }}
            title="When on, critical/blocking alerts also fire a native Windows toast."
          >
            <input
              type="checkbox"
              checked={toastEnabled}
              onChange={(e) => setToastEnabled(e.target.checked)}
              className="h-3 w-3 cursor-pointer"
            />
            Show Windows toasts for critical alerts
          </label>

          {/* Bulk "Fix all" buttons. Visible only when there is at least
              one actionable (critical/warn) group — otherwise we'd be
              spawning a session with nothing to fix. The buttons are
              deliberately larger than the surrounding pill controls
              (px-3 py-1 vs px-2.5 py-1) because they trigger an
              external process and we want them to feel weightier than
              the in-tab filters. */}
          {actionableGroups.length > 0 && (
            <>
              <div
                className="mx-1 h-4 w-px"
                style={{ background: "var(--color-border-strong)" }}
              />
              <button
                type="button"
                onClick={() => openBulkFixSession("claude")}
                disabled={bulkFixBusy !== null}
                title={`Spawn a Claude session pre-loaded with ALL ${actionableGroups.length} actionable notification${actionableGroups.length === 1 ? "" : "s"}. The mega-prompt lands on the clipboard — paste with Ctrl+V.`}
                className="rounded px-3 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                {bulkFixBusy === "claude"
                  ? "Opening…"
                  : `Fix all with Claude (${actionableGroups.length})`}
              </button>
              <button
                type="button"
                onClick={() => openBulkFixSession("codex")}
                disabled={bulkFixBusy !== null}
                title={`Same flow, Codex instead of Claude. Useful for a second opinion across all ${actionableGroups.length} notification${actionableGroups.length === 1 ? "" : "s"}.`}
                className="rounded px-3 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                {bulkFixBusy === "codex" ? "Opening…" : `Fix all with Codex (${actionableGroups.length})`}
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => setShowMuteList(!showMuteList)}
            className="text-[11px] transition-colors"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {showMuteList ? "Hide mute list" : `Mute sources (${mutes.size})`}
          </button>
        </div>
      </div>

      {/* Bulk-fix status line. Rendered outside the toolbar so wide
          success/error text doesn't push the buttons off-screen. */}
      {(bulkFixToast || bulkFixError) && (
        <div
          className="mb-3 text-[11.5px]"
          style={{
            color: bulkFixError ? "var(--color-danger)" : "var(--color-text-tertiary)",
          }}
          title={bulkFixError ?? undefined}
        >
          {bulkFixError
            ? `Failed to open bulk session: ${bulkFixError.slice(0, 160)}`
            : bulkFixToast}
        </div>
      )}

      {/* Mute list panel */}
      {showMuteList && sources.length > 0 && (
        <div
          className="mb-6 rounded p-3"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div
            className="mb-2 text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Mute by source
          </div>
          <div className="flex flex-wrap gap-1.5">
            {sources.map((src) => {
              const muted = mutes.has(src);
              return (
                <button
                  key={src}
                  type="button"
                  onClick={() => toggleMute(src)}
                  className="rounded px-2 py-0.5 text-[11px] transition-colors"
                  style={{
                    background: muted ? "transparent" : "var(--color-surface-3)",
                    color: muted ? "var(--color-text-faint)" : "var(--color-text-secondary)",
                    border: `1px solid ${muted ? "var(--color-border)" : "var(--color-border-strong)"}`,
                    textDecoration: muted ? "line-through" : "none",
                  }}
                >
                  {src}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {visibleGroups.length === 0 && (
        <div
          className="rounded p-6 text-center text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          {alerts.length === 0
            ? "No notifications. System is quiet."
            : "No notifications match the current filters."}
        </div>
      )}

      <div className="space-y-2">
        {visibleGroups.map((g, i) => (
          <Row key={`${g.source}-${i}`} g={g} />
        ))}
      </div>
    </div>
  );
}
