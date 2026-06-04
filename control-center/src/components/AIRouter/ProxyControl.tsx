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

// Forma del /health que sirve el propio proxy Node.
interface ProxySelfHealth {
  ok: boolean;
  backend: string | null;
  backend_label: string | null;
  model: string | null;
  has_key: boolean;
}

const STATUS_LABEL: Record<ProxyStatus, string> = {
  running: "Activo",
  starting: "Arrancando…",
  stopped: "Detenido",
  binary_missing: "No instalado",
  error: "Error",
};

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
  const [selfHealth, setSelfHealth] = useState<ProxySelfHealth | null>(null);
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
    // Best-effort: ask the proxy itself which backend/model is live.
    try {
      const resp = await fetch(PROXY_SELF_HEALTH_URL, { method: "GET" });
      if (resp.ok) setSelfHealth((await resp.json()) as ProxySelfHealth);
    } catch {
      setSelfHealth(null);
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
    try {
      await persist(next);
      setEnabled(next);
      await refreshHealth();
    } catch (e) {
      console.error("[proxy] toggle failed:", e);
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
        ? "Modo light · proxy en :8082"
        : "Modo light · esperando :8082"
      : "Modo light (proxy manual)"
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

  const backendLine =
    enabled && port8082Up && selfHealth?.backend_label
      ? `${selfHealth.backend_label}${selfHealth.model ? ` · ${selfHealth.model}` : ""}`
      : null;

  return (
    <div className="p-6">
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
                Proxy free-tier
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
              {backendLine && (
                <span
                  className="rounded px-1.5 py-px text-[10.5px] font-medium"
                  style={{
                    fontFamily: "var(--font-mono)",
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-secondary)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  {backendLine}
                </span>
              )}
            </div>
            <p className="text-[12px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
              Cuando está activo, las sesiones nuevas de Claude Code usan el proxy local
              (<span style={{ fontFamily: "var(--font-mono)" }}>:8082</span>) que traduce la API
              de Anthropic a un backend free-tier (NVIDIA NIM / OpenRouter / Groq). Se activa
              automáticamente cuando la cuota de Claude llega al límite.{" "}
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
              minWidth: 84,
            }}
          >
            {busy ? "…" : enabled ? "ON" : "OFF"}
          </button>
        </div>

        {result?.message && (
          <p className="mt-2.5 text-[11px]" style={{ color: "var(--color-text-faint)" }}>
            {result.message}
          </p>
        )}

        {/* No key configured warning. */}
        {enabled && selfHealth && !selfHealth.has_key && (
          <div
            className="mt-3 rounded p-2.5 text-[11.5px] leading-relaxed"
            style={{
              background: "rgba(248,81,73,0.06)",
              border: "1px solid rgba(248,81,73,0.25)",
              color: "var(--color-danger)",
            }}
          >
            El proxy está vivo pero no hay ninguna key de backend configurada. Añade
            NVIDIA_NIM_API_KEY, OPENROUTER_API_KEY o GROQ_API_KEY en la pestaña <b>Keys</b>.
          </div>
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
            <span style={{ fontWeight: 600, color: "var(--color-text)" }}>Modo light.</span> El
            binario gestionado no está disponible y no se pudo lanzar el script. Arranca el proxy
            manualmente: <code className="font-mono">node ~/.ultron/proxy/ultron-proxy.mjs</code>.
            Guía completa en <code className="font-mono">~/.ultron/proxy/HOWTO.md</code>.
          </div>
        )}
      </div>

      <p className="mt-4 text-[11px]" style={{ color: "var(--color-text-faint)" }}>
        El estado se persiste en <code className="font-mono">~/.ultron/cockpit/proxy-state.json</code>.
        Las sesiones nuevas leen el flag y aplican <code className="font-mono">ANTHROPIC_BASE_URL</code>.
        Logs del proxy en <code className="font-mono">~/.ultron/proxy/proxy.log</code>.
      </p>
    </div>
  );
}
