import { useEffect, useState } from "react";
import type { GlobalStatus } from "../types";
import { statusColor, statusLabel } from "../lib/status";
import { useFeatures, type Features } from "../lib/features";

export type Tab =
  | "dashboard"
  | "mcps"
  | "skills"
  | "agents"
  | "projects"
  | "memory"
  | "plans"
  | "changelog"
  | "notifications"
  | "sessions"
  | "usage"
  | "logs"
  | "system"
  | "gaming"
  | "news"
  | "personal"
  | "self-improve"
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
   * area 12 primary items (per Kirkardo's telemetry-driven verdict)
   * without breaking workflows that currently land on, e.g., Personal
   * (Tio Gilito) or Changelog.
   *
   * Tiering rationale (~/.ultron/sessions/<date>/routing.jsonl, 21 days):
   *   primary  — Dashboard, Usage, Notifications, System, MCPs, Skills,
   *              Agents, Memory, Sessions, Projects, Plans, Settings.
   *   more     — Changelog (drawer-style, only opened on releases),
   *              News (off by default in features.example), Gaming
   *              (gated), Stats/SelfImprove (≤1.2% of invocations),
   *              Personal (≤1.2% of invocations).
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
      { id: "notifications", label: "Notifications", available: true, featureKey: "notifications" },
      { id: "changelog", label: "Changelog", available: true, tier: "more" },
      { id: "news", label: "News", available: true, featureKey: "news", tier: "more" },
    ],
  },
  {
    heading: "System",
    items: [
      { id: "system", label: "System", available: true },
      { id: "mcps", label: "MCPs", available: true, featureKey: "mcps" },
      { id: "skills", label: "Skills", available: true, featureKey: "skills" },
      { id: "agents", label: "Agents", available: true, featureKey: "skills" },
      { id: "memory", label: "Memory", available: true, featureKey: "memory" },
    ],
  },
  {
    heading: "Workspace",
    items: [
      { id: "sessions", label: "Sessions", available: true, featureKey: "sessions" },
      { id: "projects", label: "Projects", available: true, featureKey: "projects" },
      { id: "gaming", label: "Gaming", available: true, featureKey: "gaming", tier: "more" },
      { id: "plans", label: "Plans", available: true, featureKey: "plans" },
      { id: "logs", label: "Logs", available: false },
    ],
  },
  {
    heading: "Meta",
    items: [
      {
        id: "self-improve",
        label: "Stats",
        available: true,
        featureKey: "self_improve",
        tier: "more",
      },
      {
        id: "personal",
        label: "Personal",
        available: true,
        featureKey: "personal",
        tier: "more",
      },
    ],
  },
  // v15.2 F7: "Hooks" moved into System as an inner sub-tab — no longer a
  // top-level sidebar item. Hooks feature gating still applies inside System.
  {
    heading: "",
    items: [{ id: "settings", label: "Settings", available: true }],
  },
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
  news: "news",
  mcps: "mcps",
  skills: "skills",
  memory: "memory",
  projects: "projects",
  gaming: "gaming",
  plans: "plans",
  "self-improve": "self_improve",
  personal: "personal",
  // hooks: gating moved inside System tab — no top-level redirect needed.
};

type Props = {
  active: Tab;
  onSelect: (t: Tab) => void;
  globalStatus: GlobalStatus;
};

// v15.3 — extracted button so both the primary sections and the
// collapsible "More" group render identical chrome. Disabled items
// still render with the "soon" hint exactly like before.
function SidebarButton({
  item,
  active,
  onSelect,
}: {
  item: Item;
  active: boolean;
  onSelect: (t: Tab) => void;
}) {
  const dim = false;
  return (
    <button
      key={item.id}
      type="button"
      disabled={dim}
      onClick={() => item.available && onSelect(item.id)}
      className="flex w-full items-center justify-between rounded px-2 py-1 text-[13px] transition-colors"
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
    >
      <span>{item.label}</span>
      {dim && (
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

export function Sidebar({ active, onSelect, globalStatus }: Props) {
  const { features } = useFeatures();
  const [moreOpen, setMoreOpen] = useState<boolean>(loadMoreOpen());

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
      className="flex w-56 shrink-0 flex-col border-r"
      style={{
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
      }}
    >
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div
          className="flex h-6 w-6 items-center justify-center rounded text-[11px] font-semibold"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          U
        </div>
        <div className="text-[13px] font-medium leading-none">ULTRON</div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
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
            <div key={si} className="mb-4">
              {section.heading && (
                <div
                  className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-[0.08em]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {section.heading}
                </div>
              )}
              <div className="space-y-px">
                {primary.map((item) => (
                  <SidebarButton
                    key={item.id}
                    item={item}
                    active={active === item.id}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </div>
          );
        })}

        {/* v15.3 — "More" group: collects the low-traffic tabs into a
            single collapsible row so the primary surface stays at ≤12
            items per Kirkardo's telemetry verdict. Auto-expanded if the
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
                className="flex w-full items-center justify-between rounded px-2 py-1 text-[10px] font-medium uppercase tracking-[0.08em] transition-colors"
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

      {/* Status footer */}
      <div
        className="flex items-center gap-2 border-t px-4 py-3 text-[11px]"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: statusColor(globalStatus) }}
        />
        <span style={{ color: "var(--color-text-secondary)" }}>
          {statusLabel(globalStatus)}
        </span>
      </div>

    </aside>
  );
}

// v15.4: FeaturesModal removed — the same toggles now live in
// Settings → Features (richer UI with per-feature descriptions).
// FEATURE_LABELS lived here for the deleted modal; gone with it.
