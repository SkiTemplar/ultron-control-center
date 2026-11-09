// ULTRON Control Center — AI Router: Proxy free-tier control (unified)
//
// Single source of truth for the free-tier proxy toggle. Previously this lived
// duplicated in two places (AIRouterIndex + Usage's ProxyControlCard); both are
// now retired in favour of this component, mounted in the AI Router "Proxy"
// sub-tab.
//
// Responsibilities:
//   - Toggle ON/OFF via proxy_set_enabled (persists intent, never errors on a
//     missing binary — falls back to "light mode").
//   - Hydrate from proxy_state_enabled on mount.
//   - Poll proxy_health every 5s while enabled.
//   - (Quota auto-enable/disable removed in cbb2d5c — manual toggle only.)
//   - When running, best-effort fetch the proxy's own /health to show which
//     backend (NVIDIA NIM / OpenRouter / Groq) and model are active.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirror del enum Rust ProxyStatus.
type ProxyStatus = "running" | "starting" | "stopped" | "binary_missing" | "error";

interface ProxyHealth {
  status: ProxyStatus;
  message: string | null;
  searched_paths: string[];
}

// Mirror de proxy::ProxySetResult. proxy_set_enabled NUNCA falla por ausencia
// del binario: devuelve mode="light" en vez de un Err bloqueante.
type ProxyMode = "managed" | "light" | "off";

interface ProxySetResult {
  enabled: boolean;
  mode: ProxyMode;
  binary_present: boolean;
  port_8082_up: boolean;
  base_url: string;
  message: string | null;
}

const STATUS_LABEL: Record<ProxyStatus, string> = {
  running: "Activo",
  starting: "Arrancando…",
  stopped: "Detenido",
  binary_missing: "No instalado",
  error: "Error",
};

// El panel no puede leer el `/health` del proxy: la CSP de la app solo deja
// `connect-src` a IPC, y `proxy_health` no devuelve backend, modelo ni key. El
// `fetch` de antes fallaba siempre y dejaba mudos el modelo y el aviso de key.
const PROXY_SELF_HEALTH_URL = "http://127.0.0.1:8082/health";

export function ProxyControl() {
  const [enabled, setEnabled] = useState(false);
  const [health, setHealth] = useState<ProxyHealth>({
    status: "stopped",
    message: null,
    searched_paths: [],
  });
  const [result, setResult] = useState<ProxySetResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const persist = useCallback(async (next: boolean): Promise<ProxySetResult> => {
    const r = await invoke<ProxySetResult>("proxy_set_enabled", { enabled: next });
    setResult(r);
    return r;
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const h = await invoke<ProxyHealth>("proxy_health");
      setHealth(h);
    } catch {
      /* backend unavailable — keep last */
    }
  }, []);

  // Hydrate from persisted state on mount.
  useEffect(() => {
    (async () => {
      let on = false;
      try {
        on = await invoke<boolean>("proxy_state_enabled");
        setEnabled(on);
      } catch {
        /* not wired */
      }
      if (on) {
        try {
          setResult(await invoke<ProxySetResult>("proxy_set_enabled", { enabled: true }));
        } catch {
          /* ignore */
        }
      }
      void refreshHealth();
    })();
  }, [refreshHealth]);

  // Poll health while enabled.
  useEffect(() => {
    if (enabled) {
      pollRef.current = setInterval(() => void refreshHealth(), 5_000);
    } else if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [enabled, refreshHealth]);

  // Quota auto-enable/disable removed (DR-11): the Claude-quota watchdog backend
  // was deleted in cbb2d5c (false signal), so `quota:critical` / `quota:reset`
  // are never emitted. The proxy is now toggled manually only.

  const toggle = useCallback(async () => {
    const next = !enabled;
    setBusy(true);
    setToggleError(null);
    try {
      await persist(next);
      setEnabled(next);
      await refreshHealth();
    } catch (e) {
      setToggleError(`No se pudo cambiar el proxy: ${String(e)}`);
      await refreshHealth().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [enabled, persist, refreshHealth]);

  // Derived display state.
  const isLightMode =
    result?.mode === "light" || (result == null && health.status === "binary_missing");
  const port8082Up = result?.port_8082_up === true || health.status === "running";

  const statusLabel = isLightMode
    ? enabled
      ? port8082Up
        ? "Modo ligero · proxy en :8082"
        : "Modo ligero · esperando :8082"
      : "Modo ligero (proxy manual)"
    : STATUS_LABEL[health.status];

  const statusDot = isLightMode
    ? port8082Up
      ? "var(--color-success, #4ade80)"
      : "var(--color-warn, #facc15)"
    : health.status === "running"
      ? "var(--color-success, #4ade80)"
      : health.status === "starting"
        ? "var(--color-warn, #facc15)"
        : health.status === "stopped"
          ? "var(--color-text-faint, #555)"
          : "var(--color-danger, #f87171)";

  return (
    <div>
      <div
        className="rounded-lg border p-5"
        style={{
          background: enabled
            ? "color-mix(in srgb, var(--color-warn, #facc15) 8%, var(--color-surface-2))"
            : "var(--color-surface-2)",
          borderColor: enabled ? "var(--color-warn, #facc15)" : "var(--color-border)",
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
                Proxy de nivel gratuito
              </span>
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
              <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                {statusLabel}
              </span>
            </div>
            <p className="text-[12px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
              Cuando está activo, las sesiones nuevas de Claude Code usan el proxy local
              (<span style={{ fontFamily: "var(--font-mono)" }}>:8082</span>) que traduce la API
              de Anthropic a un backend de nivel gratuito (NVIDIA NIM / OpenRouter / Groq). El
              interruptor es manual (la activación automática por cuota se retiró en DR-11).{" "}
              <span style={{ color: "var(--color-warn, #facc15)", fontWeight: 600 }}>
                Degrada la calidad: es una red de seguridad, no un reemplazo permanente.
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={busy}
            className="shrink-0 rounded-full px-5 py-2 text-[13px] font-semibold transition-colors"
            style={{
              background: enabled ? "var(--color-warn, #facc15)" : "var(--color-surface-3)",
              color: enabled ? "#1a1a00" : "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
              opacity: busy ? 0.6 : 1,
              cursor: busy ? "not-allowed" : "pointer",
              minWidth: 112,
            }}
          >
            {busy ? "…" : enabled ? "Activado" : "Desactivado"}
          </button>
        </div>

        {result?.message && (
          <p className="mt-2.5 text-[11px]" style={{ color: "var(--color-text-faint)" }}>
            {result.message}
          </p>
        )}

        {toggleError && (
          <p role="alert" className="mt-2.5 text-[11px]" style={{ color: "var(--color-danger)" }}>
            {toggleError}
          </p>
        )}

        {enabled && port8082Up && (
          <p className="mt-2.5 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
            Este panel no puede ver qué backend y modelo usa el proxy ni si tiene key: la política
            de seguridad de la app bloquea esa petición. Compruébalo en{" "}
            <code className="font-mono">{PROXY_SELF_HEALTH_URL}</code>.
          </p>
        )}

        {/* Light mode explainer. */}
        {isLightMode && (
          <div
            className="mt-3 rounded p-2.5 text-[11.5px] leading-relaxed"
            style={{
              background: "var(--color-surface-3)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-secondary)",
            }}
          >
            <span style={{ fontWeight: 600, color: "var(--color-text)" }}>Modo ligero.</span> El
            binario gestionado no está disponible y no se pudo lanzar el script. Arranca el proxy
            manualmente: <code className="font-mono">node ~/.ultron/proxy/ultron-proxy.mjs</code>.
            Guía completa en <code className="font-mono">~/.ultron/proxy/HOWTO.md</code>.
          </div>
        )}
      </div>

      <p className="mt-3 text-[11px]" style={{ color: "var(--color-text-faint)" }}>
        Estado en <code className="font-mono">~/.ultron/cockpit/proxy-state.json</code>.
        Las sesiones nuevas aplican <code className="font-mono">ANTHROPIC_BASE_URL</code>.
        Logs en <code className="font-mono">~/.ultron/proxy/proxy.log</code>.
      </p>
    </div>
  );
}
