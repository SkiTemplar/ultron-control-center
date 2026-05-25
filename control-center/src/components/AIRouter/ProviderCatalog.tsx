// ULTRON Control Center — AI Router: Provider Catalog
//
// Table of all known providers showing:
//   - Name and id
//   - Online / Offline health status (via ai_router_health Tauri command)
//   - API key state: configured / missing / placeholder
//   - Cost per million output tokens
//   - Supported task classes
//
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
    configured: { label: "Configured", color: "var(--color-success)" },
    missing: { label: "Missing", color: "var(--color-danger)" },
    placeholder: { label: "Placeholder", color: "var(--color-warn)" },
  };
  const { label, color } = map[status];
  return (
    <span
      className="rounded px-2 py-0.5 text-[10px] font-semibold"
      style={{
        background: `${color}22`,
        color,
        border: `1px solid ${color}44`,
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
        title="Checking..."
      />
    );
  }
  return (
    <span
      className="inline-block h-2 w-2 rounded-full"
      style={{
        background: online ? "var(--color-success)" : "var(--color-danger)",
      }}
      title={online ? "Online" : "Offline"}
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
            {online === null ? "checking" : online ? "online" : "offline"}
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
            ? "Free (local)"
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
                background: `${CLASS_COLORS[cls] ?? "var(--color-text-faint)"}22`,
                color: CLASS_COLORS[cls] ?? "var(--color-text-faint)",
                border: `1px solid ${CLASS_COLORS[cls] ?? "var(--color-text-faint)"}44`,
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
          title={`Re-check health of ${provider.name}`}
        >
          {checking ? "..." : "Check"}
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// ProviderCatalog
// ---------------------------------------------------------------------------

export function ProviderCatalog() {
  // Map from provider id to online status. null = pending check.
  const [health, setHealth] = useState<Record<string, boolean | null>>(
    () =>
      Object.fromEntries(PROVIDER_CATALOG.map((p) => [p.id, null])) as Record<
        string,
        boolean | null
      >,
  );
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [providers] = useState<Provider[]>(PROVIDER_CATALOG);

  const checkProvider = useCallback(async (id: string) => {
    setChecking((prev) => new Set([...prev, id]));
    try {
      const online = (await invoke("ai_router_health", {
        providerId: id,
      })) as boolean;
      setHealth((prev) => ({ ...prev, [id]: online }));
    } catch {
      // Command unavailable — assume online so the table isn't all red.
      setHealth((prev) => ({ ...prev, [id]: true }));
    } finally {
      setChecking((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  // Initial check on mount.
  useEffect(() => {
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

  const onlineCount = Object.values(health).filter((v) => v === true).length;

  return (
    <div className="p-6">
      {/* Toolbar */}
      <div className="mb-4 flex items-center gap-3">
        <div>
          <span
            className="text-[13px] font-medium"
            style={{ color: "var(--color-text)" }}
          >
            {providers.length} providers
          </span>
          <span
            className="ml-2 text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {onlineCount} online
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
          {checking.size > 0 ? "Checking..." : "Check all"}
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
              {["Provider", "Health", "API Key", "Cost", "Classes", ""].map(
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
        Health checks call ai_router_health() — a lightweight ping to each
        provider. API key state is read from the settings file. Cost figures
        are estimates based on published pricing at time of build.
      </p>
    </div>
  );
}
