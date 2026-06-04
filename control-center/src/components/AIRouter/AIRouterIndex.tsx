// ULTRON Control Center — AI Router: Models (zone) index
//
// Lists every operational zone with its current provider + model assignment.
// Clicking a zone opens the ZoneEditor modal. This is the "Modelos" sub-tab:
// which model handles which kind of task, with an ordered fallback chain.
//
// Simplified 2026-06-01: the category filter was removed (per user) and the
// free-tier proxy toggle was extracted to its own ProxyControl component.
//
// Data source: ai_router_list_zones() Tauri command. Falls back to
// DEFAULT_ZONES when the backend is unavailable so the UI is always usable.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Provider, Zone } from "./types";
import { DEFAULT_ZONES, PROVIDER_CATALOG } from "./types";
import { ZoneEditor } from "./ZoneEditor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLASS_COLORS: Record<string, string> = {
  trivial: "var(--color-success)",
  light: "var(--color-warn)",
  medium: "#a875ff",
  heavy: "var(--color-danger)",
};

function classLabel(c: string): string {
  return c.charAt(0).toUpperCase() + c.slice(1);
}

function providerName(id: string, providers: Provider[]): string {
  return providers.find((p) => p.id === id)?.name ?? id;
}

function modelShort(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-/g, " ");
}

// ---------------------------------------------------------------------------
// Zone card
// ---------------------------------------------------------------------------

function ZoneCard({
  zone,
  onEdit,
  providers,
}: {
  zone: Zone;
  onEdit: (z: Zone) => void;
  providers: Provider[];
}) {
  const classColor = CLASS_COLORS[zone.task_class] ?? "var(--color-text-secondary)";
  const primaryLabel = `${providerName(zone.primary.provider_id, providers)} · ${modelShort(zone.primary.model) || "default"}`;

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border p-4 transition-colors"
      style={{ background: "var(--color-surface-2)", borderColor: "var(--color-border)" }}
    >
      <div className="flex items-start justify-between gap-2">
        <code className="break-all text-[11px] leading-snug" style={{ color: "var(--color-text-secondary)" }}>
          {zone.id}
        </code>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{ background: `${classColor}22`, color: classColor, border: `1px solid ${classColor}44` }}
        >
          {classLabel(zone.task_class)}
        </span>
      </div>

      <p className="text-[13px] font-medium leading-tight" style={{ color: "var(--color-text)" }}>
        {zone.label}
      </p>

      <div className="flex items-center gap-1.5">
        <span className="text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
          Primary
        </span>
        <span
          className="rounded px-2 py-0.5 text-[11px] font-medium"
          style={{ background: "var(--color-surface-3)", color: "var(--color-text)" }}
        >
          {primaryLabel}
        </span>
        {zone.primary.max_tokens > 0 && (
          <span className="text-[10px]" style={{ color: "var(--color-text-faint)" }}>
            {zone.primary.max_tokens.toLocaleString()} tok
          </span>
        )}
      </div>

      {zone.fallbacks.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
            Fallbacks
          </span>
          {zone.fallbacks.map((fb, i) => (
            <span
              key={i}
              className="rounded px-1.5 py-0.5 text-[10px]"
              style={{
                background: "var(--color-surface-1)",
                color: "var(--color-text-secondary)",
                border: "1px solid var(--color-border)",
              }}
            >
              {i + 1}. {providerName(fb.provider_id, providers)} · {modelShort(fb.model) || "default"}
            </span>
          ))}
        </div>
      )}

      <div className="mt-1 flex justify-end">
        <button
          type="button"
          onClick={() => onEdit(zone)}
          className="rounded px-3 py-1 text-[11px] font-medium transition-colors"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--color-text)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--color-text-secondary)";
          }}
        >
          Edit
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AIRouterIndex
// ---------------------------------------------------------------------------

const HELP_DISMISSED_KEY = "ultron.ai-router.help-dismissed";

export function AIRouterIndex() {
  const [zones, setZones] = useState<Zone[]>(DEFAULT_ZONES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editZone, setEditZone] = useState<Zone | null>(null);
  const [providers, setProviders] = useState<Provider[]>(PROVIDER_CATALOG);
  const [helpDismissed, setHelpDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HELP_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  function dismissHelp() {
    setHelpDismissed(true);
    try {
      localStorage.setItem(HELP_DISMISSED_KEY, "1");
    } catch {
      /* banner reappears next session */
    }
  }

  const loadZones = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = (await invoke("ai_router_list_zones")) as Zone[];
      setZones(result.length > 0 ? result : DEFAULT_ZONES);
    } catch {
      setZones(DEFAULT_ZONES);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const list = (await invoke("ai_router_list_providers")) as Provider[];
        if (list.length > 0) setProviders(list);
      } catch {
        /* static catalog stays */
      }
    })();
  }, []);

  useEffect(() => {
    void loadZones();
  }, [loadZones]);

  function handleSaved(updated: Zone) {
    setZones((prev) => prev.map((z) => (z.id === updated.id ? updated : z)));
    setEditZone(null);
  }

  return (
    <div className="p-6">
      {!helpDismissed && (
        <div
          className="mb-5 rounded-lg border p-4"
          style={{ background: "var(--color-surface-2)", borderColor: "var(--color-border)" }}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="flex-1 text-[12px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
              Cada <strong>zona</strong> es una tarea de ULTRON. Tiene un proveedor + modelo{" "}
              <strong>primario</strong> y una <strong>cadena de fallback</strong> ordenada: si el
              primario falla, se prueba el siguiente. La clase (trivial / light / medium / heavy) es
              una sugerencia de complejidad. Pulsa <strong>Edit</strong> para reasignar.
            </p>
            <button
              type="button"
              onClick={dismissHelp}
              className="shrink-0 rounded px-2 py-1 text-[11px] transition-colors"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border)",
              }}
            >
              Ocultar
            </button>
          </div>
        </div>
      )}

      <div className="mb-5 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
          Zonas de routing
        </h3>
        <span className="ml-auto text-[11px]" style={{ color: "var(--color-text-faint)" }}>
          {loading ? "Cargando…" : `${zones.length} zona${zones.length === 1 ? "" : "s"}`}
        </span>
        <button
          type="button"
          onClick={() => void loadZones()}
          className="rounded px-2.5 py-1 text-[11px] transition-colors"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border)",
          }}
          title="Recargar zonas desde el backend"
        >
          Reload
        </button>
      </div>

      {error && (
        <div
          className="mb-4 rounded p-3 text-[12px]"
          style={{
            background: "var(--color-danger-bg, #3a1a1a)",
            color: "var(--color-danger)",
            border: "1px solid var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {zones.map((zone) => (
          <ZoneCard key={zone.id} zone={zone} onEdit={setEditZone} providers={providers} />
        ))}
      </div>

      {zones.length === 0 && !loading && (
        <p className="mt-10 text-center text-[13px]" style={{ color: "var(--color-text-faint)" }}>
          No hay zonas configuradas.
        </p>
      )}

      {editZone !== null && (
        <ZoneEditor zone={editZone} onClose={() => setEditZone(null)} onSaved={handleSaved} />
      )}
    </div>
  );
}
