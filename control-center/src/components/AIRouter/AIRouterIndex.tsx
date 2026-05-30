// ULTRON Control Center — AI Router: Zone Index
//
// Lists all operational zones with their current provider + model assignment.
// Clicking a zone opens the ZoneEditor modal.
//
// Layout:
//   - Category filter pill row at the top
//   - Grid of zone cards, each showing:
//       zone id (monospace), label, task_class badge,
//       primary provider + model pill, fallback chain chips
//   - Edit button opens ZoneEditor modal
//
// Data source: ai_router_list_zones() Tauri command.
// Falls back to DEFAULT_ZONES (from types.ts) when the command is
// unavailable (backend not yet wired) so the UI is always usable.

import { useCallback, useEffect, useMemo, useState } from "react";
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
      style={{
        background: "var(--color-surface-2)",
        borderColor: "var(--color-border)",
      }}
    >
      {/* Top row: id + class badge */}
      <div className="flex items-start justify-between gap-2">
        <code
          className="break-all text-[11px] leading-snug"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {zone.id}
        </code>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{
            background: `${classColor}22`,
            color: classColor,
            border: `1px solid ${classColor}44`,
          }}
        >
          {classLabel(zone.task_class)}
        </span>
      </div>

      {/* Label */}
      <p
        className="text-[13px] font-medium leading-tight"
        style={{ color: "var(--color-text)" }}
      >
        {zone.label}
      </p>

      {/* Primary assignment */}
      <div className="flex items-center gap-1.5">
        <span
          className="text-[11px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Primary
        </span>
        <span
          className="rounded px-2 py-0.5 text-[11px] font-medium"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
          }}
        >
          {primaryLabel}
        </span>
        {zone.primary.max_tokens > 0 && (
          <span
            className="text-[10px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            {zone.primary.max_tokens.toLocaleString()} tok
          </span>
        )}
      </div>

      {/* Fallback chain */}
      {zone.fallbacks.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span
            className="text-[11px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
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

      {/* Edit button */}
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
            (e.currentTarget as HTMLButtonElement).style.color =
              "var(--color-text)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color =
              "var(--color-text-secondary)";
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

// Local storage key for the dismissable explainer banner. Once a user hides
// the help text, we don't bring it back — they know what zones are.
const HELP_DISMISSED_KEY = "ultron.ai-router.help-dismissed";

export function AIRouterIndex() {
  const [zones, setZones] = useState<Zone[]>(DEFAULT_ZONES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [editZone, setEditZone] = useState<Zone | null>(null);
  // Runtime provider list from backend — used for display names in zone cards.
  const [providers, setProviders] = useState<Provider[]>(PROVIDER_CATALOG);
  const [helpDismissed, setHelpDismissed] = useState<boolean>(() => {
    // Defensive read: localStorage can throw in privacy modes / Tauri webviews
    // with storage disabled. We default to "show help" on any failure.
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
      // Ignore — banner will just reappear next session.
    }
  }

  const loadZones = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = (await invoke("ai_router_list_zones")) as Zone[];
      setZones(result.length > 0 ? result : DEFAULT_ZONES);
    } catch {
      // Backend command not yet implemented — silently fall back to defaults.
      setZones(DEFAULT_ZONES);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load real provider list for display names in zone cards.
  useEffect(() => {
    (async () => {
      try {
        const list = (await invoke("ai_router_list_providers")) as Provider[];
        if (list.length > 0) setProviders(list);
      } catch {
        // Backend unavailable — static catalog stays as fallback.
      }
    })();
  }, []);

  useEffect(() => {
    void loadZones();
  }, [loadZones]);

  const categories = useMemo(() => {
    const cats = new Set(zones.map((z) => z.category));
    return ["all", ...Array.from(cats).sort()];
  }, [zones]);

  const filtered = useMemo(
    () =>
      categoryFilter === "all"
        ? zones
        : zones.filter((z) => z.category === categoryFilter),
    [zones, categoryFilter],
  );

  function handleSaved(updated: Zone) {
    setZones((prev) =>
      prev.map((z) => (z.id === updated.id ? updated : z)),
    );
    setEditZone(null);
  }

  return (
    <div className="p-6">
      {/* ------------------------------------------------------------------ */}
      {/* Explainer banner — shown once until dismissed                       */}
      {/* ------------------------------------------------------------------ */}
      {!helpDismissed && (
        <div
          className="mb-5 rounded-lg border p-4"
          style={{
            background: "var(--color-surface-2)",
            borderColor: "var(--color-border)",
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <p
                className="text-[12.5px] font-semibold"
                style={{ color: "var(--color-text)" }}
              >
                How the router works
              </p>
              <p
                className="mt-1.5 text-[12px] leading-relaxed"
                style={{ color: "var(--color-text-secondary)" }}
              >
                A <strong>zone</strong> is one operational task in ULTRON
                (refresh usage stats, fix an alert, consolidate memory, review
                code…). Each zone has a <strong>primary</strong> provider +
                model and an ordered <strong>fallback chain</strong>: if the
                primary fails or is unavailable, the router tries fallback 1,
                then 2, then 3 before surfacing an error. Task class
                (trivial / light / medium / heavy) is a suggestion, not a
                hard limit — pick whatever provider you trust for the job.
              </p>
            </div>
            <button
              type="button"
              onClick={dismissHelp}
              className="shrink-0 rounded px-2 py-1 text-[11px] transition-colors"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border)",
              }}
              title="Hide this help banner"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Toolbar                                                             */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {categories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setCategoryFilter(cat)}
            className="rounded-full px-3 py-1 text-[11px] font-medium transition-colors"
            style={{
              background:
                categoryFilter === cat
                  ? "var(--color-accent)"
                  : "var(--color-surface-2)",
              color:
                categoryFilter === cat
                  ? "var(--color-accent-text)"
                  : "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
            }}
          >
            {cat === "all" ? "All categories" : cat}
          </button>
        ))}
        <span
          className="ml-auto text-[11px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          {loading ? "Loading..." : `${filtered.length} zone${filtered.length === 1 ? "" : "s"}`}
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
          title="Reload zones from backend"
        >
          Reload
        </button>
      </div>

      {/* Error banner */}
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

      {/* ------------------------------------------------------------------ */}
      {/* Zone grid                                                           */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((zone) => (
          <ZoneCard key={zone.id} zone={zone} onEdit={setEditZone} providers={providers} />
        ))}
      </div>

      {filtered.length === 0 && !loading && (
        <p
          className="mt-10 text-center text-[13px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          No zones in this category.
        </p>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Edit modal                                                          */}
      {/* ------------------------------------------------------------------ */}
      {editZone !== null && (
        <ZoneEditor
          zone={editZone}
          onClose={() => setEditZone(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
