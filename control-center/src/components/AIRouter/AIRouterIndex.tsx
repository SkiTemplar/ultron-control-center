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

// Mirror de `proxy::ProxySetResult` (Rust). proxy_set_enabled NUNCA falla por
// ausencia del binario: devuelve mode="light" en vez de un Err bloqueante.
type ProxyMode = "managed" | "light" | "off";

interface ProxySetResult {
  enabled: boolean;
  mode: ProxyMode;
  binary_present: boolean;
  port_8082_up: boolean;
  base_url: string;
  message: string | null;
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
  // Ultimo resultado de proxy_set_enabled — fuente de verdad del modo (managed
  // vs light) cuando el binario no esta instalado. proxy_health solo refleja el
  // proceso GESTIONADO; el modo light se sostiene en este resultado.
  const [proxyResult, setProxyResult] = useState<ProxySetResult | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);
  const healthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Activa/desactiva el ruteo free-tier via `proxy_set_enabled`, que PERSISTE
  // la intencion en proxy-state.json y NUNCA falla por ausencia del binario:
  // sin binario devuelve mode="light" (proxy manual en :8082) en vez de un Err.
  // Los spawns leen el flag persistido en sessions.rs.
  //
  // Devuelve el ProxySetResult para que el caller pinte el modo. Solo lanza
  // ante un fallo REAL (FS no escribible, backend caido), no por binario ausente.
  const persistProxyState = useCallback(
    async (enabled: boolean): Promise<ProxySetResult> => {
      const result = await invoke<ProxySetResult>("proxy_set_enabled", { enabled });
      setProxyResult(result);
      return result;
    },
    [],
  );

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
  // Cuando el toggle ya estaba ON, derivamos un ProxySetResult inicial sondeando
  // el binario + puerto via proxy_set_enabled(true) (idempotente: re-persiste
  // true y reporta el modo actual), para que la UI muestre managed vs light al
  // montar sin esperar a que el usuario toque el toggle.
  useEffect(() => {
    (async () => {
      let enabled = false;
      try {
        enabled = await invoke<boolean>("proxy_state_enabled");
        setFreeTierEnabled(enabled);
      } catch {
        // Backend no disponible o comando no implementado — deja false.
      }
      if (enabled) {
        try {
          // Re-afirma la intencion y obtiene el modo real (managed/light) sin
          // tratar binario ausente como error.
          const result = await invoke<ProxySetResult>("proxy_set_enabled", {
            enabled: true,
          });
          setProxyResult(result);
        } catch {
          // Si incluso esto falla (FS/back caido), no bloqueamos el toggle.
        }
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
      // Al llegar a cuota critica activamos el toggle. Con proxy_set_enabled el
      // routing free-tier se aplica SIEMPRE que la intencion se persista, sea en
      // modo managed (binario presente) o light (proxy manual en :8082) — ya no
      // depende de que el binario exista. Leemos el estado via getter funcional
      // para evitar captura stale; la decision se toma en el bloque async.
      setFreeTierEnabled((prev) => {
        if (prev) return prev; // ya activo, nada que hacer
        void (async () => {
          try {
            await persistProxyState(true);
            // proxy_set_enabled solo lanza ante fallo REAL (FS/back); el binario
            // ausente devuelve light, no Err. Si llegamos aqui, la intencion
            // quedo persistida → activamos el toggle.
            setFreeTierEnabled(true);
          } catch (e) {
            // Fallo real de persistencia — el routing sigue directo a Anthropic.
            console.error("[free-tier] quota:critical auto-ON failed:", e);
          } finally {
            void refreshHealth();
          }
        })();
        return prev; // lo cambia el bloque async si la persistencia tiene exito
      });
    });

    unlistenResetRef.current = listen("quota:reset", async () => {
      // quota:reset: apagamos el proxy. proxy_set_enabled(false) hace stop
      // best-effort + persiste enabled=false; siempre ponemos enabled=false.
      void persistProxyState(false).catch((e: unknown) => {
        console.error("[free-tier] quota:reset proxy_set_enabled(false) error:", e);
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
      // Al encender, proxy_set_enabled(true) persiste la intencion y devuelve el
      // modo: "managed" si el binario existe y arranco, "light" si no (proxy
      // manual en :8082). En AMBOS casos el routing free-tier queda activo, asi
      // que el toggle pasa a ON. Solo NO cambiamos el estado ante un fallo REAL
      // (FS no escribible / backend caido), que proxy_set_enabled propaga como Err.
      await persistProxyState(next);
      setFreeTierEnabled(next);
      await refreshHealth();
    } catch (e: unknown) {
      // Fallo real de persistencia — no cambiamos el estado UI.
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[free-tier] toggle failed:", msg);
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

  // --- Derived proxy display state ---
  // "Light mode" = el binario gestionado no existe (proxyResult.mode === "light"
  // o proxy_health reporta binary_missing). En ese caso el toggle NO es un
  // blocker: opera como proxy manual en :8082. Preferimos proxyResult (fuente de
  // verdad tras un set) y caemos a proxyHealth en el arranque frio.
  const isLightMode =
    proxyResult?.mode === "light" ||
    (proxyResult == null && proxyHealth.status === "binary_missing");
  // ¿Hay algo escuchando en :8082? proxyResult lo sondea en cada set; health
  // "running" tambien implica puerto arriba.
  const port8082Up =
    proxyResult?.port_8082_up === true || proxyHealth.status === "running";

  // Etiqueta + color del indicador de estado. En modo light sustituimos el
  // crudo "Binario no encontrado" por una etiqueta clara de modo light.
  const statusLabel = isLightMode
    ? freeTierEnabled
      ? port8082Up
        ? "Modo light · proxy en :8082"
        : "Modo light · esperando :8082"
      : "Modo light (proxy manual)"
    : STATUS_LABEL[proxyHealth.status];
  const statusDot = isLightMode
    ? port8082Up
      ? "var(--color-success, #4ade80)"
      : "var(--color-warn, #facc15)"
    : STATUS_DOT[proxyHealth.status];

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
                  background: statusDot,
                  flexShrink: 0,
                }}
                title={statusLabel}
              />
              <span
                className="text-[11px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {statusLabel}
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
            {/* Modo light: el binario no esta instalado pero el toggle SIGUE
                funcionando como "proxy manual en :8082". NO es un error
                bloqueante — es un modo de operacion valido. */}
            {isLightMode && (
              <div
                className="mt-1.5 rounded p-2 text-[11px] leading-relaxed"
                style={{
                  background: "var(--color-surface-3)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-secondary)",
                }}
              >
                <span style={{ fontWeight: 600, color: "var(--color-text)" }}>
                  Modo light (proxy manual en :8082).
                </span>{" "}
                El binario gestionado no esta instalado, pero el ruteo free-tier
                funciona igual: las sesiones nuevas apuntaran{" "}
                <code className="font-mono">ANTHROPIC_BASE_URL</code> al proxy
                local cuando corras uno manualmente. Guia:{" "}
                <code className="font-mono">~/.ultron/proxy/HOWTO.md</code>.
                <span
                  className="mt-1 flex items-center gap-1.5"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: port8082Up
                        ? "var(--color-success, #4ade80)"
                        : "var(--color-text-faint, #555)",
                    }}
                  />
                  {port8082Up
                    ? "Proxy detectado escuchando en 127.0.0.1:8082."
                    : "Sin proxy en 127.0.0.1:8082 todavia — arranca el tuyo."}
                </span>
              </div>
            )}
            {proxyHealth.message && !isLightMode && (
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
