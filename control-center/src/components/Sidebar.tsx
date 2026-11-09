import { invoke } from "@tauri-apps/api/core";
import { Fragment, useEffect, useRef, useState } from "react";
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
  | "finance"
  | "notes"
  | "plans"
  | "changelog"
  | "notifications"
  | "sessions"
  | "usage"
  | "ai-router"
  | "system"
  | "lab"
  | "settings";

export type SidebarItem = {
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
   *              Agents, Sessions, Projects, Plans, Personal,
   *              Settings.
   *   more     — Changelog (drawer-style, only opened on releases),
   *              News (toggle retirado de features.json), Gaming
   *              (gated), Stats/SelfImprove (≤1.2% of invocations).
   *   hidden   — Logs (available=false, lives inside System now).
   *
   * Default omitted = "primary" so we don't break unrelated callers.
   */
  tier?: "primary" | "more";
};

/** Exported so the command palette mirrors the sidebar order and labels. */
export const SECTIONS: { heading: string; items: SidebarItem[] }[] = [
  {
    heading: "Overview",
    items: [
      { id: "dashboard", label: "Dashboard", available: true },
      { id: "usage", label: "Usage", available: true, featureKey: "usage" },
      { id: "ai-router", label: "AI Router", available: true },
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
      // Las pestañas Memory y Learn se retiraron (2026-10-18): la memoria se
      // gestiona por hooks y por el sidecar ultron-memory.exe; su estado sigue
      // en la tarjeta "Sistema de memoria" del Panel.
      // v2.6 (card-v26-fb-005): cross-project markdown notes at
      // ~/.ultron/cockpit/notes/.
      { id: "notes", label: "Notes", available: true },
      // Lab TFG (2026-08-12): deteccion de patrones de texto IA sobre el
      // catalogo de investigacion del usuario (docs/research). Determinista.
      { id: "lab", label: "Lab", available: true },
    ],
  },
  {
    heading: "Workspace",
    items: [
      // "Monitor de sesiones" (Monitor + Lanzar) is not the ULTRON Sessions window,
      // which opens from the footer launcher; distinct names avoid mixing them.
      { id: "sessions", label: "Session Monitor", available: true, featureKey: "sessions" },
      { id: "projects", label: "Projects", available: true, featureKey: "projects" },
      // Finance: native read-only dashboard of the Bank/finanzas project
      // (Tío Gilito). Surfaces saldo/fondos/movimientos without launching the
      // separate Streamlit app; the buttons spawn a Tío Gilito CLI session.
      // Finance is a local-only feature (datos bancarios locales). Visible only when
      // built with VITE_FINANCE=1; Finance.tsx is excluded from the public repo.
      { id: "finance", label: "Finance", available: import.meta.env.VITE_FINANCE === "1" },
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

/** Human-readable name of every tab (error boundary, command palette). */
export const TAB_LABELS: Record<Tab, string> = {
  ...(Object.fromEntries(
    SECTIONS.flatMap((s) => s.items).map((it) => [it.id, it.label]),
  ) as Partial<Record<Tab, string>>),
  skills: "Skills",
  agents: "Agentes",
  rules: "Reglas",
  plans: "Planes",
  changelog: "Notas de versión",
  notifications: "Notifications",
  settings: "Settings",
} as Record<Tab, string>;

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
  item: SidebarItem;
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
      aria-current={active ? "page" : undefined}
      disabled={dim}
      onClick={() => item.available && onSelect(item.id)}
      className="flex w-full items-center justify-between rounded-md px-3 py-2 text-[15px] transition-colors"
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
      title={showBadge ? `${badgeCount} pendiente${badgeCount === 1 ? "" : "s"}` : undefined}
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
          pronto
        </span>
      )}
    </button>
  );
}


/** Abre (o enfoca) la ventana ULTRON Sessions; no es una pestaña del Control Center. */
function SessionsLauncher() {
  const [error, setError] = useState<string | null>(null);
  return (
    <button
      type="button"
      onClick={() => {
        setError(null);
        invoke("sesiones_open_window", { projectId: null }).catch((e) => setError(String(e)));
      }}
      className="flex w-full items-center justify-between rounded-md px-3 py-2 text-[15px] transition-colors hover:bg-[var(--color-surface-2)]"
      style={{ color: error ? "var(--color-danger)" : "var(--color-text-secondary)" }}
      title={error ?? "Abrir ULTRON Sessions"}
    >
      <span>ULTRON Sessions</span>
      <span aria-hidden="true">↗</span>
    </button>
  );
}

// Quota % UI removed (DR-10): the Claude-quota watchdog backend was deleted in
// cbb2d5c (false signal). The old QuotaDot invoked the now-missing
// `quota_get_status` and failed silently to a green 0% — removed entirely.

export function Sidebar({ active, onSelect, globalStatus, lastProjectCtx, onGoBack }: Props) {
  const { features } = useFeatures();
  const [moreOpen, setMoreOpen] = useState<boolean>(loadMoreOpen());
  const navRef = useRef<HTMLElement | null>(null);

  // On short windows the nav scrolls: keep the active entry visible when it
  // changes (palette, shortcuts, "back to project").
  useEffect(() => {
    const current = navRef.current?.querySelector<HTMLElement>("[aria-current='page']");
    if (current && typeof current.scrollIntoView === "function") {
      current.scrollIntoView({ block: "nearest" });
    }
  }, [active]);

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
        <div className="text-[15px] font-medium leading-none">ULTRON</div>
      </div>

      {/* Navigation */}
      <nav ref={navRef} className="flex-1 overflow-y-auto px-3 pb-2">
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
                  className="px-3 pb-1.5 text-[12px] font-medium uppercase tracking-[0.08em]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {section.heading}
                </div>
              )}
              <div className="space-y-0.5">
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
                        className="flex w-full items-center gap-1.5 truncate rounded px-3 py-1 text-[12.5px] transition-colors"
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
                className="flex w-full items-center justify-between rounded px-2 py-1 text-[12px] font-medium uppercase tracking-[0.08em] transition-colors"
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
                title={`Mostrar u ocultar ${moreItems.length} pestaña${moreItems.length === 1 ? "" : "s"} secundaria${moreItems.length === 1 ? "" : "s"}`}
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

        {/* v15.4 — the standalone "Features" modal was deduplicated. Los
            toggles se gobiernan editando ~/.ultron/cockpit/features.json
            (la sección Settings→Features nunca se construyó; dead code
            eliminado 2026-07-20, audit cat8). */}
      </nav>

      {/* v2.6 (card-v26-fb-015): Settings + Notifications anchored at the
          bottom of the sidebar. Separated from the scrollable nav so the
          user always sees them without scrolling on tall screens. */}
      <div
        className="border-t px-3 py-2 space-y-0.5"
        style={{ borderColor: "var(--color-border)" }}
      >
        <SessionsLauncher />
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
        className="flex items-center gap-2 border-t px-4 py-3 text-[12.5px]"
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

// v15.4: FeaturesModal removed. Los toggles viven en features.json (editable
// a mano); la sección Settings→Features nunca llegó a construirse.
// FEATURE_LABELS lived here for the deleted modal; gone with it.
