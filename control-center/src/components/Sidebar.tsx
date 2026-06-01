import { Fragment, useEffect, useState } from "react";
import type { GlobalStatus } from "../types";
import { statusColor, statusLabel } from "../lib/status";
import { useFeatures, type Features } from "../lib/features";

export type Tab =
  | "dashboard"
  | "mcps"
  | "library"
  | "skills"
  | "agents"
  | "rules"
  | "projects"
  | "notes"
  | "plans"
  | "changelog"
  | "notifications"
  | "sessions"
  | "usage"
  | "system"
  | "settings";

type Item = {
  id: Tab;
  label: string;
  available: boolean;
  /**
   * If set, this item is hidden when features[featureKey] === false.
   * Items without a featureKey are always shown (dashboard, usage,
   * notifications, sessions, system, settings).
   */
  featureKey?: keyof Features;
  /**
   * v15.3 — Sidebar reduction (17 → 12 visible).
   * Items marked tier "more" render inside the collapsible "More" group
   * at the bottom. Nothing is dropped or de-routed: every tab is still
   * reachable via the command palette, in-app shortcuts, and a single
   * click after expanding "More". This gives the new-user surface
   * area 12 primary items (per review's telemetry-driven verdict)
   * without breaking workflows that currently land on, e.g., Personal
   * (Tio Gilito) or Changelog.
   *
   * Tiering rationale (~/.ultron/sessions/<date>/routing.jsonl, 21 days):
   *   primary  — Dashboard, Usage, Notifications, System, MCPs, Skills,
   *              Agents, Memory, Sessions, Projects, Plans, Personal,
   *              Settings.
   *   more     — Changelog (drawer-style, only opened on releases),
   *              News (off by default in features.example), Gaming
   *              (gated), Stats/SelfImprove (≤1.2% of invocations).
   *   hidden   — Logs (available=false, lives inside System now).
   *
   * Default omitted = "primary" so we don't break unrelated callers.
   */
  tier?: "primary" | "more";
};

const SECTIONS: { heading: string; items: Item[] }[] = [
  {
    heading: "Overview",
    items: [
      { id: "dashboard", label: "Dashboard", available: true },
      { id: "usage", label: "Usage", available: true, featureKey: "usage" },
      // v2.5.1: Changelog dropped from sidebar (user does not need it).
      // Still reachable via command palette "Go to Changelog" since the
      // Tab union still includes it and App.tsx still routes it.
      // Notifications moved to footer block (anchored at bottom like Settings).
    ],
  },
  {
    heading: "System",
    items: [
      { id: "system", label: "System", available: true },
      { id: "mcps", label: "MCPs", available: true, featureKey: "mcps" },
      // v2.1: Skills + Agents + Rules collapsed into one Library tab with
      // sub-navigation. The 3 individual tab ids remain reachable via the
      // command palette and deep-links — App.tsx routes them all to
      // <Library initial="..." /> so deep-linking still feels native.
      { id: "library", label: "Library", available: true, featureKey: "skills" },
      // v2.6 (card-v26-fb-005): cross-project markdown notes at
      // ~/.ultron/cockpit/notes/. Memory tab removed (fullize 2026-06-01) —
      // the brain is backend-only now. Inbox removed entirely.
      { id: "notes", label: "Notes", available: true },
    ],
  },
  {
    heading: "Workspace",
    items: [
      { id: "sessions", label: "Sessions", available: true, featureKey: "sessions" },
      { id: "projects", label: "Projects", available: true, featureKey: "projects" },
      // v2.5: Plans tab removed from sidebar (per user). Per-project kanban
      // lives inside Projects -> Board. Workdays removed (fullize 2026-06-01).
    ],
  },
  // v2.1: "Gaming" and "Personal" tabs deleted (old ULTRON persona stack).
  // "Hooks" lives inside System as a sub-tab since v15.2.
  // v2.6 (card-v26-fb-015): Settings moved out of SECTIONS — rendered as
  // a footer block so it anchors at the bottom of the sidebar instead of
  // floating in the middle on tall screens.
];

// v15.3 — persisted toggle for the "More" group. Defaults closed so the
// new-user surface stays at 12 primary tabs. Stored in localStorage so
// power users who keep it expanded don't have to re-open every relaunch.
const MORE_OPEN_KEY = "ultron.cc.sidebar.more_open.v1";
function loadMoreOpen(): boolean {
  try {
    return localStorage.getItem(MORE_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}
function saveMoreOpen(open: boolean) {
  try {
    localStorage.setItem(MORE_OPEN_KEY, open ? "1" : "0");
  } catch {}
}

/** Tabs that should redirect to dashboard if disabled while active. */
const FEATURE_TAB_TO_KEY: Partial<Record<Tab, keyof Features>> = {
  mcps: "mcps",
  library: "skills",
  skills: "skills",
  agents: "skills",
  rules: "skills",
  projects: "projects",
  plans: "plans",
  // hooks: gating moved inside System tab — no top-level redirect needed.
};

type Props = {
  active: Tab;
  onSelect: (t: Tab) => void;
  globalStatus: GlobalStatus;
  lastProjectCtx?: { title: string; subTab: string } | null;
  onGoBack?: () => void;
};

// v15.3 — extracted button so both the primary sections and the
// collapsible "More" group render identical chrome. Disabled items
// still render with the "soon" hint exactly like before.
//
// v15.5.16optional `badgeCount` renders a small notification
// chip on the top-right (red when >0, hidden when 0). Used by the
// Dashboard tab to surface the pending-items count without forcing the
// user to open the tab first.
function SidebarButton({
  item,
  active,
  onSelect,
  badgeCount,
}: {
  item: Item;
  active: boolean;
  onSelect: (t: Tab) => void;
  badgeCount?: number;
}) {
  const dim = false;
  const showBadge = typeof badgeCount === "number" && badgeCount > 0;
  return (
    <button
      key={item.id}
      type="button"
      disabled={dim}
      onClick={() => item.available && onSelect(item.id)}
      className="flex w-full items-center justify-between rounded-md px-3 py-2.5 text-[16.5px] transition-colors"
      style={{
        background: active ? "var(--color-surface-3)" : "transparent",
        color: active
          ? "var(--color-text)"
          : dim
            ? "var(--color-text-faint)"
            : "var(--color-text-secondary)",
        cursor: dim ? "default" : "pointer",
      }}
      onMouseEnter={(e) => {
        if (!dim && !active)
          (e.currentTarget as HTMLButtonElement).style.background =
            "var(--color-surface-2)";
      }}
      onMouseLeave={(e) => {
        if (!active)
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
      title={showBadge ? `${badgeCount} pending item${badgeCount === 1 ? "" : "s"}` : undefined}
    >
      <span>{item.label}</span>
      {showBadge && (
        <span
          className="ml-2 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums"
          style={{
            background: "var(--color-danger)",
            color: "#fff",
            lineHeight: 1,
          }}
        >
          {badgeCount > 99 ? "99+" : badgeCount}
        </span>
      )}
      {dim && !showBadge && (
        <span
          className="text-[10px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          soon
        </span>
      )}
    </button>
  );
}


// ---------------------------------------------------------------------------
// Quota dot — listens to quota:updated / quota:critical / quota:reset events
// and renders a colored indicator in the Sidebar footer next to the global
// status. Green < 80 %, amber 80-98 %, red >= 98 % (critical).
// ---------------------------------------------------------------------------

type QuotaDotStatus = {
  claude_pct_used: number;
  claude_critical: boolean;
};

function useQuotaDot(): QuotaDotStatus {
  const [quota, setQuota] = useState<QuotaDotStatus>({
    claude_pct_used: 0,
    claude_critical: false,
  });

  useEffect(() => {
    // Fetch initial state.
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<QuotaDotStatus>("quota_get_status")
        .then((s) => setQuota({ claude_pct_used: s.claude_pct_used, claude_critical: s.claude_critical }))
        .catch(() => {/* watchdog not yet registered */});
    });
  }, []);

  useEffect(() => {
    let u1: (() => void) | null = null;
    let u2: (() => void) | null = null;
    let u3: (() => void) | null = null;

    import("@tauri-apps/api/event").then(({ listen }) => {
      const handler = (e: { payload: QuotaDotStatus }) =>
        setQuota({ claude_pct_used: e.payload.claude_pct_used, claude_critical: e.payload.claude_critical });
      listen<QuotaDotStatus>("quota:updated", handler).then((u) => { u1 = u; });
      listen<QuotaDotStatus>("quota:critical", handler).then((u) => { u2 = u; });
      listen<QuotaDotStatus>("quota:reset", handler).then((u) => { u3 = u; });
    });

    return () => { u1?.(); u2?.(); u3?.(); };
  }, []);

  return quota;
}

function QuotaDot() {
  const { claude_pct_used: pct, claude_critical: critical } = useQuotaDot();

  const color = critical
    ? "var(--color-danger)"
    : pct >= 80
      ? "var(--color-warn)"
      : "var(--color-success)";

  const label = critical
    ? `Claude quota CRITICAL (${pct.toFixed(0)}%) — fallback activo`
    : `Claude quota: ${pct.toFixed(0)}%`;

  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] tabular-nums"
      style={{ color: "var(--color-text-faint)" }}
      title={label}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: color, flexShrink: 0 }}
      />
      {pct.toFixed(0)}%
    </span>
  );
}

export function Sidebar({ active, onSelect, globalStatus, lastProjectCtx, onGoBack }: Props) {
  const { features } = useFeatures();
  const [moreOpen, setMoreOpen] = useState<boolean>(loadMoreOpen());

  // v15.5.16poll the same detect_gaps source the Dashboard
  // PendingItemsPanel uses, then surface the count as a red chip on the
  // v2.0: detect_gaps removed. Placeholder until P4 wires this to the
  // Kanban Backlog column count for the active project.
  const pendingCount = 0;

  // v15.3 — auto-expand "More" if the active tab lives inside it, otherwise
  // selecting a more-tier item via the command palette would visually flag
  // the wrong (collapsed) chrome. Persist that expansion so subsequent
  // sessions don't collapse it again.
  useEffect(() => {
    const moreIds = new Set(
      SECTIONS.flatMap((s) => s.items)
        .filter((it) => it.tier === "more")
        .map((it) => it.id),
    );
    if (moreIds.has(active) && !moreOpen) {
      setMoreOpen(true);
      saveMoreOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function toggleMore() {
    setMoreOpen((prev) => {
      const next = !prev;
      saveMoreOpen(next);
      return next;
    });
  }

  // If the user disables the currently-active tab (via the modal or by
  // editing features.json on disk), bounce them to the dashboard so we
  // never render a component the user just declared off-limits.
  useEffect(() => {
    const key = FEATURE_TAB_TO_KEY[active];
    if (key && features[key] === false) {
      onSelect("dashboard");
    }
  }, [active, features, onSelect]);

  return (
    <aside
      className="flex w-64 shrink-0 flex-col border-r"
      style={{
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
      }}
    >
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-5 py-4">
        <div
          className="flex h-6 w-6 items-center justify-center rounded text-[12px] font-semibold"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          U
        </div>
        <div className="text-[13.5px] font-medium leading-none">ULTRON</div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 pb-2">
        {SECTIONS.map((section, si) => {
          // v15.3 — split each section into primary + more so the rendered
          // sidebar stays the same shape for primary items while the more
          // group gets aggregated under a single collapsible footer.
          const visibleItems = section.items
            .filter((item) => item.available)
            .filter(
              (item) => !item.featureKey || features[item.featureKey] !== false,
            );
          const primary = visibleItems.filter((it) => (it.tier ?? "primary") === "primary");
          if (primary.length === 0) return null;
          return (
            <div key={si} className="mb-6">
              {section.heading && (
                <div
                  className="px-2.5 pb-2 text-[12px] font-medium uppercase tracking-[0.08em]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {section.heading}
                </div>
              )}
              <div className="space-y-1">
                {primary.map((item) => (
                  <Fragment key={item.id}>
                    <SidebarButton
                      item={item}
                      active={active === item.id}
                      onSelect={onSelect}
                      badgeCount={item.id === "dashboard" ? pendingCount : undefined}
                    />
                    {item.id === "projects" && lastProjectCtx && onGoBack && (
                      <button
                        type="button"
                        onClick={onGoBack}
                        className="flex w-full items-center gap-1.5 truncate rounded px-3 py-1 text-[11px] transition-colors"
                        style={{ color: "var(--color-text-tertiary)", background: "transparent" }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--color-surface-2)"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                        title={`Volver a ${lastProjectCtx.title} / ${lastProjectCtx.subTab}`}
                      >
                        <span aria-hidden>↩</span>
                        <span className="truncate">{lastProjectCtx.title} / {lastProjectCtx.subTab.charAt(0).toUpperCase() + lastProjectCtx.subTab.slice(1)}</span>
                      </button>
                    )}
                  </Fragment>
                ))}
              </div>
            </div>
          );
        })}

        {/* v15.3 — "More" group: collects the low-traffic tabs into a
            single collapsible row so the primary surface stays at ≤12
            items per review's telemetry verdict. Auto-expanded if the
            active tab lives inside it. */}
        {(() => {
          const moreItems = SECTIONS.flatMap((s) => s.items)
            .filter((it) => it.available && it.tier === "more")
            .filter(
              (it) => !it.featureKey || features[it.featureKey] !== false,
            );
          if (moreItems.length === 0) return null;
          return (
            <div className="mb-4">
              <button
                type="button"
                onClick={toggleMore}
                className="flex w-full items-center justify-between rounded px-2 py-1 text-[11.5px] font-medium uppercase tracking-[0.08em] transition-colors"
                style={{
                  background: "transparent",
                  color: "var(--color-text-tertiary)",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "var(--color-surface-2)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "transparent";
                }}
                aria-expanded={moreOpen}
                title={`Show/hide ${moreItems.length} secondary tab${moreItems.length === 1 ? "" : "s"}`}
              >
                <span>More ({moreItems.length})</span>
                <span aria-hidden="true">{moreOpen ? "▾" : "▸"}</span>
              </button>
              {moreOpen && (
                <div className="mt-1 space-y-px">
                  {moreItems.map((item) => (
                    <SidebarButton
                      key={item.id}
                      item={item}
                      active={active === item.id}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* v15.4 — the standalone "Features" modal was deduplicated. The
            same toggles live in Settings → Features (richer UI with
            descriptions per toggle). */}
      </nav>

      {/* v2.6 (card-v26-fb-015): Settings + Notifications anchored at the
          bottom of the sidebar. Separated from the scrollable nav so the
          user always sees them without scrolling on tall screens. */}
      <div
        className="border-t px-3 py-2 space-y-1"
        style={{ borderColor: "var(--color-border)" }}
      >
        {features.notifications !== false && (
          <SidebarButton
            item={{ id: "notifications", label: "Notifications", available: true }}
            active={active === "notifications"}
            onSelect={onSelect}
          />
        )}
        <SidebarButton
          item={{ id: "settings", label: "Settings", available: true }}
          active={active === "settings"}
          onSelect={onSelect}
        />
      </div>

      {/* Status footer */}
      <div
        className="flex items-center gap-2 border-t px-4 py-3 text-[11.5px]"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: statusColor(globalStatus) }}
        />
        <span style={{ color: "var(--color-text-secondary)" }}>
          {statusLabel(globalStatus)}
        </span>
        {/* Quota dot — green/amber/red reflecting Claude subscription usage */}
        <span className="ml-auto">
          <QuotaDot />
        </span>
      </div>

    </aside>
  );
}

// v15.4: FeaturesModal removed — the same toggles now live in
// Settings → Features (richer UI with per-feature descriptions).
// FEATURE_LABELS lived here for the deleted modal; gone with it.
