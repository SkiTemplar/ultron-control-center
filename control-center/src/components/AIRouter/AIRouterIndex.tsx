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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

// ---------------------------------------------------------------------------
// Proxy free-tier types (mirror del enum Rust ProxyStatus)
// ---------------------------------------------------------------------------

type ProxyStatus = "running" | "starting" | "stopped" | "binary_missing" | "error";

interface ProxyHealth {
  status: ProxyStatus;
  message: string | null;
  searched_paths: string[];
}

// Ruta del archivo de estado del proxy (leida/escrita atomicamente por Rust).
// El frontend solo lee este archivo a traves de comandos Tauri — no accede
// directamente al FS.

// ---------------------------------------------------------------------------
// Free-tier panel helpers
// ---------------------------------------------------------------------------

const STATUS_DOT: Record<ProxyStatus, string> = {
  running: "var(--color-success, #4ade80)",
  starting: "var(--color-warn, #facc15)",
  stopped: "var(--color-text-faint, #555)",
  binary_missing: "var(--color-danger, #f87171)",
  error: "var(--color-danger, #f87171)",
};

const STATUS_LABEL: Record<ProxyStatus, string> = {
  running: "Activo",
  starting: "Arrancando…",
  stopped: "Detenido",
  binary_missing: "Binario no encontrado",
  error: "Error",
};

// ---------------------------------------------------------------------------
// Local storage key for the dismissable explainer banner
// ---------------------------------------------------------------------------

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
    try {
      return localStorage.getItem(HELP_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  // --- Free-tier proxy state ---
  const [freeTierEnabled, setFreeTierEnabled] = useState<boolean>(false);
  const [proxyHealth, setProxyHealth] = useState<ProxyHealth>({
    status: "stopped",
    message: null,
    searched_paths: [],
  });
  const [proxyBusy, setProxyBusy] = useState(false);
  const healthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Persiste el estado del toggle en proxy-state.json via comando Tauri.
  // El backend lo escribe atomicamente; los spawns lo leen en sessions.rs.
  // IMPORTANTE: propaga el error si proxy_start falla (p.ej. binario ausente)
  // para que el caller pueda decidir si actualizar el estado UI o no.
  const persistProxyState = useCallback(async (enabled: boolean): Promise<void> => {
    if (enabled) {
      // Lanza si Rust devuelve Err — el caller debe capturar y NO setear enabled=true.
      await invoke<ProxyHealth>("proxy_start");
    } else {
      try {
        await invoke<void>("proxy_stop");
      } catch (e) {
        console.error("[free-tier] proxy_stop error:", e);
        // stop puede fallar si ya estaba detenido; no es critico.
      }
    }
  }, []);

  // Refresca el health cada 5 s mientras el panel esta visible y el toggle activo.
  const refreshHealth = useCallback(async () => {
    try {
      const h = await invoke<ProxyHealth>("proxy_health");
      setProxyHealth(h);
    } catch {
      // Backend no disponible — no cambiamos el estado.
    }
  }, []);

  // Carga inicial: hidrata el toggle desde el estado persistido en el backend
  // (rank1 fix) y refresca el health. Si proxy_state_enabled falla, deja false.
  useEffect(() => {
    (async () => {
      try {
        const enabled = await invoke<boolean>("proxy_state_enabled");
        setFreeTierEnabled(enabled);
      } catch {
        // Backend no disponible o comando no implementado — deja false.
      }
      void refreshHealth();
    })();
  }, [refreshHealth]);

  // Poll de health cuando el proxy esta activo.
  useEffect(() => {
    if (freeTierEnabled) {
      healthPollRef.current = setInterval(() => void refreshHealth(), 5_000);
    } else {
      if (healthPollRef.current !== null) {
        clearInterval(healthPollRef.current);
        healthPollRef.current = null;
      }
    }
    return () => {
      if (healthPollRef.current !== null) {
        clearInterval(healthPollRef.current);
        healthPollRef.current = null;
      }
    };
  }, [freeTierEnabled, refreshHealth]);

  // Refs que almacenan las funciones unlisten para evitar leaks entre renders.
  // Se usan refs (no estado) para que el cleanup siempre tenga acceso a la
  // promesa resuelta aunque el componente se desmonte antes de que el IIFE
  // async termine.
  const unlistenCriticalRef = useRef<Promise<() => void> | null>(null);
  const unlistenResetRef = useRef<Promise<() => void> | null>(null);

  // Escucha el evento quota:critical del backend para activar el toggle automaticamente.
  // El effect se monta una sola vez (deps vacías) para evitar re-suscripciones
  // en cada cambio de freeTierEnabled. Los callbacks leen el estado actual via
  // setFreeTierEnabled con la forma funcional, que no captura el valor al
  // momento del mount.
  useEffect(() => {
    unlistenCriticalRef.current = listen("quota:critical", async () => {
      // rank4 fix: solo activar el toggle si proxy_start tiene EXITO.
      // Leemos el estado actual via getter funcional para evitar captura stale,
      // pero la decision de setear true se toma fuera del setter (async seguro).
      setFreeTierEnabled((prev) => {
        if (prev) return prev; // ya activo, nada que hacer
        // Lanzamos el start en background; el resultado determina si seteamos.
        void (async () => {
          try {
            await persistProxyState(true);
            setFreeTierEnabled(true);
          } catch (e) {
            // proxy_start fallo (binario ausente u otro error) —
            // NO persistimos enabled=true, el routing sigue directo a Anthropic.
            console.error("[free-tier] quota:critical auto-ON failed:", e);
          } finally {
            void refreshHealth();
          }
        })();
        return prev; // no cambiar estado aqui; lo cambia el bloque async si tiene exito
      });
    });

    unlistenResetRef.current = listen("quota:reset", async () => {
      // quota:reset: apagamos el proxy. proxy_stop no es critico si falla
      // (proceso ya muerto), asi que siempre ponemos enabled=false.
      void persistProxyState(false).catch((e: unknown) => {
        console.error("[free-tier] quota:reset proxy_stop error:", e);
      }).finally(() => {
        setFreeTierEnabled(false);
        void refreshHealth();
      });
    });

    return () => {
      void unlistenCriticalRef.current?.then((fn) => fn());
      void unlistenResetRef.current?.then((fn) => fn());
      unlistenCriticalRef.current = null;
      unlistenResetRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFreeTierToggle = useCallback(async () => {
    const next = !freeTierEnabled;
    setProxyBusy(true);
    try {
      // rank4 fix: al encender, SOLO persistir enabled=true si proxy_start
      // tiene EXITO. Si falla (binario ausente), el estado queda en false
      // y el routing continua directo a Anthropic sin romper sesiones.
      await persistProxyState(next);
      // Solo llegamos aqui si persistProxyState no lanzó.
      setFreeTierEnabled(next);
      await refreshHealth();
    } catch (e: unknown) {
      // proxy_start fallo — no cambiamos el estado UI.
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[free-tier] toggle failed:", msg);
      // Refleja el estado real del proxy tras el fallo.
      await refreshHealth().catch(() => undefined);
    } finally {
      setProxyBusy(false);
    }
  }, [freeTierEnabled, persistProxyState, refreshHealth]);

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
      {/* Free-tier proxy toggle                                              */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="mb-5 rounded-lg border p-4"
        style={{
          background: freeTierEnabled
            ? "color-mix(in srgb, var(--color-warn, #facc15) 8%, var(--color-surface-2))"
            : "var(--color-surface-2)",
          borderColor: freeTierEnabled
            ? "var(--color-warn, #facc15)"
            : "var(--color-border)",
        }}
      >
        <div className="flex items-center justify-between gap-4">
          {/* Left: info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span
                className="text-[13px] font-semibold"
                style={{ color: "var(--color-text)" }}
              >
                Rutar sesiones por free-tier (NVIDIA NIM)
              </span>
              {/* Health dot */}
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: STATUS_DOT[proxyHealth.status],
                  flexShrink: 0,
                }}
                title={STATUS_LABEL[proxyHealth.status]}
              />
              <span
                className="text-[11px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {STATUS_LABEL[proxyHealth.status]}
              </span>
            </div>
            <p
              className="text-[11.5px] leading-relaxed"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Cuando esta activo, las sesiones nuevas usaran el proxy local
              (puerto 8082) en lugar de la API de Anthropic. Modelos NVIDIA
              NIM / OpenRouter como fallback.{" "}
              <span style={{ color: "var(--color-warn, #facc15)", fontWeight: 600 }}>
                Aviso: el free-tier puede degradar la calidad de respuesta.
                Red de seguridad, no reemplazo permanente.
              </span>
            </p>
            {proxyHealth.status === "binary_missing" && (
              <p
                className="mt-1.5 text-[11px]"
                style={{ color: "var(--color-danger, #f87171)" }}
              >
                Binario no encontrado. Ver{" "}
                <code className="font-mono">~/.ultron/proxy/HOWTO.md</code>{" "}
                para instrucciones de instalacion. El toggle funcionara como
                &ldquo;light mode&rdquo; (setea ANTHROPIC_BASE_URL) si corres
                el proxy manualmente.
              </p>
            )}
            {proxyHealth.message && proxyHealth.status !== "binary_missing" && (
              <p
                className="mt-1 text-[10.5px] font-mono truncate"
                style={{ color: "var(--color-text-faint)" }}
                title={proxyHealth.message}
              >
                {proxyHealth.message}
              </p>
            )}
          </div>

          {/* Right: toggle button */}
          <button
            type="button"
            onClick={() => void handleFreeTierToggle()}
            disabled={proxyBusy}
            className="shrink-0 rounded-full px-4 py-1.5 text-[12px] font-semibold transition-colors"
            style={{
              background: freeTierEnabled
                ? "var(--color-warn, #facc15)"
                : "var(--color-surface-3)",
              color: freeTierEnabled ? "#1a1a00" : "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
              opacity: proxyBusy ? 0.6 : 1,
              cursor: proxyBusy ? "not-allowed" : "pointer",
              minWidth: 80,
            }}
          >
            {proxyBusy ? "…" : freeTierEnabled ? "ON" : "OFF"}
          </button>
        </div>
      </div>

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
