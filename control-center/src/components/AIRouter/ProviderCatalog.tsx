// ULTRON Control Center — AI Router: Provider Catalog
//
// Table of all known providers showing:
//   - Name and id
//   - Online / Offline health status (via ai_router_health Tauri command)
//   - API key state: configured / missing / placeholder (real, from backend)
//   - Cost per million output tokens (real, from backend)
//   - Supported task classes
//
// Provider list is hydrated from `ai_router_list_providers` on mount.
// Health checks run once on mount, then every 30 s.
// Individual re-check buttons allow manual refresh per provider.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Provider } from "./types";
import { PROVIDER_CATALOG } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLASS_COLORS: Record<string, string> = {
  trivial: "var(--color-success)",
  light: "var(--color-warn)",
  medium: "#a875ff",
  heavy: "var(--color-danger)",
};

function ApiKeyBadge({
  status,
}: {
  status: Provider["api_key_status"];
}) {
  const map: Record<
    Provider["api_key_status"],
    { label: string; color: string }
  > = {
    configured: { label: "Configurada", color: "var(--color-success)" },
    missing: { label: "No encontrada", color: "var(--color-danger)" },
    placeholder: { label: "De ejemplo", color: "var(--color-warn)" },
  };
  const { label, color } = map[status];
  return (
    <span
      className="rounded px-2 py-0.5 text-[10px] font-semibold"
      style={{
        background: `color-mix(in srgb, ${color} 13%, transparent)`,
        color,
        border: `1px solid color-mix(in srgb, ${color} 27%, transparent)`,
      }}
    >
      {label}
    </span>
  );
}

function HealthDot({ online }: { online: boolean | null }) {
  if (online === null) {
    return (
      <span
        className="inline-block h-2 w-2 rounded-full animate-pulse"
        style={{ background: "var(--color-text-faint)" }}
        title="Comprobando…"
      />
    );
  }
  return (
    <span
      className="inline-block h-2 w-2 rounded-full"
      style={{
        background: online ? "var(--color-success)" : "var(--color-danger)",
      }}
      title={online ? "En línea" : "Sin conexión"}
    />
  );
}

// ---------------------------------------------------------------------------
// Provider row
// ---------------------------------------------------------------------------

function ProviderRow({
  provider,
  online,
  onCheck,
  checking,
}: {
  provider: Provider;
  online: boolean | null;
  onCheck: (id: string) => void;
  checking: boolean;
}) {
  return (
    <tr
      style={{
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      {/* Name */}
      <td className="py-3 pl-4 pr-3">
        <div
          className="text-[13px] font-medium"
          style={{ color: "var(--color-text)" }}
        >
          {provider.name}
        </div>
        <code
          className="text-[10px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          {provider.id}
        </code>
      </td>

      {/* Health */}
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <HealthDot online={online} />
          <span
            className="text-[11px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {online === null ? "comprobando" : online ? "en línea" : "sin conexión"}
          </span>
        </div>
      </td>

      {/* API key */}
      <td className="px-3 py-3">
        <ApiKeyBadge status={provider.api_key_status} />
      </td>

      {/* Cost */}
      <td className="px-3 py-3">
        <span
          className="text-[12px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {provider.cost_per_mtok === 0
            ? "Gratis (local)"
            : `$${provider.cost_per_mtok.toFixed(2)}/Mtok`}
        </span>
      </td>

      {/* Supported classes */}
      <td className="px-3 py-3">
        <div className="flex flex-wrap gap-1">
          {provider.supports.map((cls) => (
            <span
              key={cls}
              className="rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{
                background: `color-mix(in srgb, ${CLASS_COLORS[cls] ?? "var(--color-text-faint)"} 13%, transparent)`,
                color: CLASS_COLORS[cls] ?? "var(--color-text-faint)",
                border: `1px solid color-mix(in srgb, ${CLASS_COLORS[cls] ?? "var(--color-text-faint)"} 27%, transparent)`,
              }}
            >
              {cls}
            </span>
          ))}
        </div>
      </td>

      {/* Actions */}
      <td className="py-3 pl-3 pr-4">
        <button
          type="button"
          onClick={() => onCheck(provider.id)}
          disabled={checking}
          className="rounded px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color =
              "var(--color-text)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color =
              "var(--color-text-secondary)";
          }}
          title={`Volver a comprobar la salud de ${provider.name}`}
        >
          {checking ? "…" : "Comprobar"}
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// ProviderCatalog
// ---------------------------------------------------------------------------

export function ProviderCatalog() {
  // Provider list hydrated from the backend. Falls back to the static catalog
  // if `ai_router_list_providers` is unavailable (backend not yet compiled).
  const [providers, setProviders] = useState<Provider[]>(PROVIDER_CATALOG);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Map from provider id to online status. null = pending check.
  const [health, setHealth] = useState<Record<string, boolean | null>>({});
  const [checking, setChecking] = useState<Set<string>>(new Set());

  // Load real provider list from backend on mount.
  useEffect(() => {
    (async () => {
      try {
        const backendProviders = (await invoke(
          "ai_router_list_providers",
        )) as Provider[];
        if (backendProviders.length > 0) {
          setProviders(backendProviders);
          // Reset health map to null (pending) for the real provider set,
          // dropping ids from the static catalog that the backend no longer lists.
          setHealth(
            Object.fromEntries(
              backendProviders.map((p) => [p.id, null]),
            ) as Record<string, boolean | null>,
          );
        }
      } catch (err) {
        // Backend unavailable — static catalog stays; surface a soft notice.
        setLoadError(
          err instanceof Error ? err.message : String(err),
        );
        setHealth(
          Object.fromEntries(
            PROVIDER_CATALOG.map((p) => [p.id, null]),
          ) as Record<string, boolean | null>,
        );
      }
    })();
  }, []);

  const checkProvider = useCallback(async (id: string) => {
    setChecking((prev) => new Set([...prev, id]));
    try {
      // FIX 3: invoke the real Tauri command (ai_router_health) with the
      // provider id. The backend handles both HTTP providers and CLI providers
      // (codex/gemini) via detect_cli — no HTTP call needed for those.
      const online = (await invoke("ai_router_health", {
        providerId: id,
      })) as boolean;
      setHealth((prev) => ({ ...prev, [id]: online }));
    } catch {
      // Command genuinely failed (backend unavailable) — mark offline rather
      // than lying as online. This surfaces real connectivity problems.
      setHealth((prev) => ({ ...prev, [id]: false }));
    } finally {
      setChecking((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  // Initial health check once providers are loaded.
  useEffect(() => {
    if (providers.length === 0) return;
    void Promise.all(providers.map((p) => checkProvider(p.id)));
  }, [providers, checkProvider]);

  // Auto-refresh every 30 s.
  useEffect(() => {
    const interval = setInterval(() => {
      void Promise.all(providers.map((p) => checkProvider(p.id)));
    }, 30_000);
    return () => clearInterval(interval);
  }, [providers, checkProvider]);

  function checkAll() {
    void Promise.all(providers.map((p) => checkProvider(p.id)));
  }

  // Solo cuentan los providers visibles: el mapa puede conservar ids del
  // catálogo estático que el backend ya no devuelve.
  const onlineCount = providers.filter((p) => health[p.id] === true).length;

  return (
    <div className="p-6">
      {/* Backend load error — soft warning, static fallback is still shown */}
      {loadError !== null && (
        <div
          className="mb-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(210,153,34,0.08)",
            color: "var(--color-warn)",
            border: "1px solid rgba(210,153,34,0.30)",
          }}
        >
          <span className="font-semibold">
            ai_router_list_providers no disponible; se muestra el catálogo estático:{" "}
          </span>
          {loadError}
        </div>
      )}

      {/* Toolbar */}
      <div className="mb-4 flex items-center gap-3">
        <div>
          <span
            className="text-[13px] font-medium"
            style={{ color: "var(--color-text)" }}
          >
            {providers.length} proveedores
          </span>
          <span
            className="ml-2 text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {onlineCount} en línea
          </span>
        </div>
        <button
          type="button"
          onClick={checkAll}
          disabled={checking.size > 0}
          className="ml-auto rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border)",
          }}
        >
          {checking.size > 0 ? "Comprobando…" : "Comprobar todos"}
        </button>
      </div>

      {/* Table */}
      <div
        className="overflow-hidden rounded-lg"
        style={{
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-2)",
        }}
      >
        <table className="w-full table-auto text-left">
          <thead>
            <tr
              style={{
                borderBottom: "1px solid var(--color-border)",
                background: "var(--color-surface-1)",
              }}
            >
              {["Proveedor", "Salud", "API key", "Coste", "Clases", ""].map(
                (h) => (
                  <th
                    key={h}
                    className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <ProviderRow
                key={p.id}
                provider={p}
                online={health[p.id] ?? null}
                onCheck={checkProvider}
                checking={checking.has(p.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Help note */}
      <p
        className="mt-4 text-[11px]"
        style={{ color: "var(--color-text-faint)" }}
      >
        La comprobación de salud llama a ai_router_health(), un ping ligero a cada
        proveedor. El estado de las API keys y los costes salen del backend
        (ai_router_list_providers) y reflejan la configuración real de
        ~/.ultron/cockpit/ai-router/providers.json.
      </p>
    </div>
  );
}
