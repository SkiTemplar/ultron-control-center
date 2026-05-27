// ULTRON Control Center — AI Router tab (barrel + Tab container)
//
// Exposes the full AI Router UI as a single top-level component.
// Wire up in Sidebar.tsx (System section) and App.tsx.
//
// Sub-components:
//   AIRouterIndex    — zone list with category filter + assignment summary
//   ZoneEditor       — modal for editing a zone (provider/model/fallbacks)
//   ProviderCatalog  — table of providers with health + API key state
//   RouterMetrics    — token savings + class distribution dashboard
//
// Tauri commands consumed (to be implemented in src-tauri/src/ai_router.rs):
//   ai_router_list_zones()              -> Zone[]
//   ai_router_get_zone(zone_id)         -> Zone
//   ai_router_update_zone(zone)         -> ()
//   ai_router_list_providers()          -> Provider[]
//   ai_router_health(provider_id)       -> bool
//   ai_router_metrics()                 -> RouterMetrics
//   ai_router_test(zone_id, prompt)     -> TestResult

import { useState } from "react";
import { AIRouterIndex } from "./AIRouterIndex";
import { ProviderCatalog } from "./ProviderCatalog";
import { RouterMetrics } from "./RouterMetrics";
import { AIRouterErrorBoundary } from "./AIRouterErrorBoundary";

// Re-export all shared types so callers can import from the barrel.
export type {
  ProviderClass,
  Provider,
  ZoneAssignment,
  Zone,
  RouterMetrics as RouterMetricsData,
  TestResult,
} from "./types";

type RouterSubTab = "zones" | "providers" | "metrics";

const SUB_TABS: { id: RouterSubTab; label: string }[] = [
  { id: "zones", label: "Zones" },
  { id: "providers", label: "Providers" },
  { id: "metrics", label: "Metrics" },
];

/**
 * Props for the AIRouter container.
 *
 * `embedded` — set to true when this component is rendered as a sub-tab of
 * another panel (e.g. Settings). Suppresses the outer "AI Router" title and
 * background fill, leaving just the sub-tab strip + body so it sits cleanly
 * beneath the host's own header. Defaults to false for backwards compat
 * with any direct top-level usage.
 */
export type AIRouterProps = {
  embedded?: boolean;
};

export function AIRouter({ embedded = false }: AIRouterProps = {}) {
  const [subTab, setSubTab] = useState<RouterSubTab>("zones");

  // Sub-tab strip is identical in both modes — extracted so we don't duplicate
  // the JSX between the standalone and embedded layouts.
  const subTabStrip = (
    <div
      className="inline-flex rounded p-0.5"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border-strong)",
      }}
    >
      {SUB_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => setSubTab(t.id)}
          className="rounded px-4 py-1.5 text-[12px] font-medium transition-colors"
          style={{
            background:
              subTab === t.id ? "var(--color-surface-3)" : "transparent",
            color:
              subTab === t.id
                ? "var(--color-text)"
                : "var(--color-text-tertiary)",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );

  const body = (
    <AIRouterErrorBoundary>
      {subTab === "zones" && <AIRouterIndex />}
      {subTab === "providers" && <ProviderCatalog />}
      {subTab === "metrics" && <RouterMetrics />}
    </AIRouterErrorBoundary>
  );

  // ---------------------------------------------------------------------
  // Embedded mode — used inside Settings. No full-height flex container,
  // no top-level title (Settings already shows one), no fixed background.
  // The host controls page padding, so we only add internal spacing.
  // ---------------------------------------------------------------------
  if (embedded) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2
              className="text-[14px] font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              AI Router
            </h2>
            <p
              className="mt-0.5 text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Route each operational zone to a provider and model, with an
              ordered fallback chain when the primary fails.
            </p>
          </div>
          {subTabStrip}
        </div>
        <div>{body}</div>
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // Standalone mode — kept for direct top-level mounting if ever needed.
  // ---------------------------------------------------------------------
  return (
    <div className="flex h-full flex-col" style={{ background: "var(--color-bg)" }}>
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                              */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="flex items-center justify-between border-b px-6 py-4"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
      >
        <div>
          <h1
            className="text-[17px] font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            AI Router
          </h1>
          <p
            className="mt-0.5 text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Assign providers and models to each operational zone
          </p>
        </div>
        {subTabStrip}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Body                                                                */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 overflow-auto">{body}</div>
    </div>
  );
}
