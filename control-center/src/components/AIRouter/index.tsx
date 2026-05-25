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

export function AIRouter() {
  const [subTab, setSubTab] = useState<RouterSubTab>("zones");

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

        {/* Sub-tab strip */}
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
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Body                                                                */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 overflow-auto">
        {subTab === "zones" && <AIRouterIndex />}
        {subTab === "providers" && <ProviderCatalog />}
        {subTab === "metrics" && <RouterMetrics />}
      </div>
    </div>
  );
}
