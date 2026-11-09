// ULTRON Control Center — AI Router (top-level page)
//
// Two sub-tabs as of 2026-06-07:
//
//   Dashboard  — savings + per-model usage + proxy toggle (RouterDashboard)
//   Providers  — provider catalog: health + key state + cost (ProviderCatalog)
//   Zones      — primary → fallbacks per zone (ZoneEditor)
//   Delegation — chain of the multi-engine delegator (DelegationPanel, 2026-10-26)
//
// Removed tabs:
//   Zones  — "no aportan nada, fatal" (2026-06-06). Backend logic untouched.
//   Keys   — moved to Settings (handled by the Settings agent).
//   Proxy  — folded into Dashboard as an inline card.
//
// Tauri commands consumed live inside the sub-components; see each file.

import { useState } from "react";
import { ProviderCatalog } from "./ProviderCatalog";
import { RouterDashboard } from "./RouterDashboard";
import { ZoneEditor } from "./ZoneEditor";
import { DelegationPanel } from "./DelegationPanel";
import { AIRouterErrorBoundary } from "./AIRouterErrorBoundary";

// Re-export shared types so callers can import from the barrel.
export type {
  ProviderClass,
  Provider,
  ZoneAssignment,
  Zone,
  RouterMetrics as RouterMetricsData,
  TestResult,
} from "./types";

type RouterSubTab = "dashboard" | "providers" | "zones" | "delegation";

const SUB_TABS: { id: RouterSubTab; label: string; hint: string }[] = [
  { id: "dashboard", label: "Panel", hint: "Ahorro, uso por modelo y proxy" },
  { id: "providers", label: "Proveedores", hint: "Salud, coste y estado de las keys" },
  { id: "zones", label: "Zonas", hint: "Ver y editar la cadena primary → fallbacks por zona" },
  {
    id: "delegation",
    label: "Delegación",
    hint: "Cadena de motores del delegador: nivel → motor de entrada, relevo, estado e historial",
  },
];

export function AIRouterPage() {
  const [subTab, setSubTab] = useState<RouterSubTab>("dashboard");
  const active = SUB_TABS.find((t) => t.id === subTab) ?? SUB_TABS[0];

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--color-bg)" }}>
      {/* Header */}
      <div
        className="border-b px-6 py-4"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-1)" }}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[17px] font-semibold" style={{ color: "var(--color-text)" }}>
              Router de IA
            </h1>
            <p className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
              {active.hint}
            </p>
            <p className="mt-1 text-[11px]" style={{ color: "var(--color-warning, #b58900)" }}>
              {subTab === "delegation"
                ? "Alcance: configura scripts/delegate.mjs (cockpit/ai-router/delegation.json). No cambia las zonas del router ni el modelo de las sesiones de Claude Code."
                : "Alcance: el router solo afecta a las llamadas de esta app (zonas). Las sesiones de Claude Code CLI hablan directamente con Anthropic y NO pasan por aquí."}
            </p>
          </div>
          <div
            className="inline-flex shrink-0 flex-nowrap rounded p-0.5"
            style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border-strong)" }}
          >
            {SUB_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSubTab(t.id)}
                className="whitespace-nowrap rounded px-4 py-1.5 text-[12px] font-medium transition-colors"
                style={{
                  background: subTab === t.id ? "var(--color-surface-3)" : "transparent",
                  color: subTab === t.id ? "var(--color-text)" : "var(--color-text-tertiary)",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        <AIRouterErrorBoundary>
          {subTab === "dashboard" && <RouterDashboard />}
          {subTab === "providers" && <ProviderCatalog />}
          {subTab === "zones" && <ZoneEditor />}
          {subTab === "delegation" && <DelegationPanel />}
        </AIRouterErrorBoundary>
      </div>
    </div>
  );
}
