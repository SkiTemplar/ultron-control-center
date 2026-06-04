// ULTRON Control Center — Settings > API Keys
//
// Form para configurar las API keys de los proveedores IA. Persiste via
// `set_env_vars_keys` (backend usa `setx KEY value` en User scope, sin
// elevación). El cambio es permanente pero solo surte efecto en sesiones
// nuevas — el toast avisa al usuario que reinicie la app o abra un terminal
// nuevo.
//
// SEGURIDAD: los valores se muestran enmascarados por defecto. Nunca se
// loguean ni se serializan fuera del invoke hacia el backend.

import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

type ProviderKeyDef = {
  envVar: string;
  label: string;
  docsUrl: string;
  placeholder: string;
};

type EnvKeysSaveResult = {
  saved: string[];
  skipped: string[];
  errors: Record<string, string>;
};

type FieldState = {
  value: string;
  visible: boolean;
};

// Mirrors crate::env_keys::EnvKeyStatus.
type EnvKeyStatus = {
  env_var: string;
  active: boolean;
  configured: boolean;
  masked: string | null;
};

// ------------------------------------------------------------------
// Provider catalog (mirrors ai_router seed_providers)
// ------------------------------------------------------------------

const PROVIDER_KEYS: ProviderKeyDef[] = [
  {
    envVar: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    docsUrl: "https://console.anthropic.com/settings/keys",
    placeholder: "sk-ant-…",
  },
  {
    envVar: "OPENAI_API_KEY",
    label: "OpenAI",
    docsUrl: "https://platform.openai.com/api-keys",
    placeholder: "sk-…",
  },
  {
    envVar: "GEMINI_API_KEY",
    label: "Google Gemini",
    docsUrl: "https://aistudio.google.com/app/apikey",
    placeholder: "AIza…",
  },
  {
    envVar: "GROQ_API_KEY",
    label: "Groq",
    docsUrl: "https://console.groq.com/keys",
    placeholder: "gsk_…",
  },
  {
    envVar: "DEEPSEEK_API_KEY",
    label: "DeepSeek",
    docsUrl: "https://platform.deepseek.com/api_keys",
    placeholder: "sk-…",
  },
  {
    envVar: "NVIDIA_NIM_API_KEY",
    label: "NVIDIA NIM (free-tier proxy)",
    docsUrl: "https://build.nvidia.com",
    placeholder: "nvapi-…",
  },
  {
    envVar: "OPENROUTER_API_KEY",
    label: "OpenRouter (free-tier proxy)",
    docsUrl: "https://openrouter.ai/keys",
    placeholder: "sk-or-…",
  },
];

// ------------------------------------------------------------------
// Eye icon (inline, no lucide dependency)
// ------------------------------------------------------------------

function EyeIcon({ crossed }: { crossed: boolean }) {
  return crossed ? (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ) : (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export function ApiKeysSection() {
  const [fields, setFields] = useState<Record<string, FieldState>>(() =>
    Object.fromEntries(
      PROVIDER_KEYS.map((p) => [p.envVar, { value: "", visible: false }]),
    ),
  );

  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<EnvKeysSaveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, EnvKeyStatus>>({});

  const loadStatuses = useCallback(async () => {
    try {
      const rows = await invoke<EnvKeyStatus[]>("get_env_keys_status");
      setStatuses(Object.fromEntries(rows.map((r) => [r.env_var, r])));
    } catch {
      // Best-effort: si falla, simplemente no mostramos los badges.
    }
  }, []);

  useEffect(() => {
    void loadStatuses();
  }, [loadStatuses]);

  const handleChange = useCallback((envVar: string, value: string) => {
    setFields((prev) => ({
      ...prev,
      [envVar]: { ...prev[envVar], value },
    }));
    // Clear stale result when the user starts editing again.
    setResult(null);
    setError(null);
  }, []);

  const toggleVisible = useCallback((envVar: string) => {
    setFields((prev) => ({
      ...prev,
      [envVar]: { ...prev[envVar], visible: !prev[envVar].visible },
    }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setResult(null);
    setError(null);

    // Only send keys that have a non-empty value.
    const payload: Record<string, string> = {};
    for (const [envVar, state] of Object.entries(fields)) {
      if (state.value.trim()) {
        payload[envVar] = state.value.trim();
      }
    }

    if (Object.keys(payload).length === 0) {
      setError("No hay valores para guardar. Rellena al menos una key.");
      setSaving(false);
      return;
    }

    try {
      const r = await invoke<EnvKeysSaveResult>("set_env_vars_keys", {
        keys: payload,
      });
      setResult(r);
      // Refrescar el estado para que los badges reflejen lo recién guardado.
      void loadStatuses();
      // Clear fields that were saved successfully so they don't linger.
      setFields((prev) => {
        const next = { ...prev };
        for (const envVar of r.saved) {
          if (next[envVar]) {
            next[envVar] = { ...next[envVar], value: "" };
          }
        }
        return next;
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [fields]);

  const savedCount = result?.saved.length ?? 0;
  const errorCount = Object.keys(result?.errors ?? {}).length;

  return (
    <div className="max-w-[560px]">
      {/* Section header */}
      <div className="mb-5">
        <h2 className="text-[15px] font-semibold">API Keys</h2>
        <p
          className="mt-1 text-[12.5px] leading-relaxed"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Las keys se guardan como variables de entorno de usuario Windows via{" "}
          <code
            className="rounded px-1 py-px text-[11px]"
            style={{
              fontFamily: "var(--font-mono)",
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border)",
            }}
          >
            setx
          </code>
          . Se activan al instante en esta sesión (y quedan guardadas para las
          futuras). Los campos vacíos se omiten.
        </p>
      </div>

      {/* Provider rows */}
      <ul className="flex flex-col gap-3">
        {PROVIDER_KEYS.map((def) => {
          const state = fields[def.envVar];
          const st = statuses[def.envVar];
          return (
            <li key={def.envVar}>
              <label
                className="mb-1 flex items-center justify-between text-[12px] font-medium"
                htmlFor={`apikey-${def.envVar}`}
              >
                <span className="flex items-center gap-2">
                  {def.label}
                  {st?.configured ? (
                    <span
                      className="rounded px-1.5 py-px text-[10px] font-medium tabular-nums"
                      style={{
                        fontFamily: "var(--font-mono)",
                        background: st.active
                          ? "rgba(63, 185, 80, 0.10)"
                          : "rgba(248, 140, 0, 0.10)",
                        color: st.active
                          ? "var(--color-success)"
                          : "var(--color-warning, #f8a000)",
                        border: `1px solid ${st.active ? "rgba(63,185,80,0.30)" : "rgba(248,140,0,0.30)"}`,
                      }}
                      title={
                        st.active
                          ? "Configurada y activa en esta sesión"
                          : "Configurada — reinicia la app para activarla"
                      }
                    >
                      {st.active ? "configurada" : "configurada · reinicia"}
                    </span>
                  ) : (
                    <span
                      className="rounded px-1.5 py-px text-[10px]"
                      style={{
                        background: "var(--color-surface-1)",
                        color: "var(--color-text-tertiary)",
                        border: "1px solid var(--color-border)",
                      }}
                    >
                      sin configurar
                    </span>
                  )}
                </span>
                <a
                  href={def.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10.5px] transition-colors"
                  style={{ color: "var(--color-accent)" }}
                  tabIndex={-1}
                >
                  Obtener key ↗
                </a>
              </label>
              <div className="flex items-center gap-1.5">
                <div
                  className="relative flex-1"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  <input
                    id={`apikey-${def.envVar}`}
                    type={state.visible ? "text" : "password"}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    value={state.value}
                    onChange={(e) => handleChange(def.envVar, e.target.value)}
                    placeholder={
                      st?.configured
                        ? "ya configurada — escribe para reemplazar"
                        : def.placeholder
                    }
                    className="w-full rounded px-2.5 py-1.5 text-[12px] outline-none transition-colors"
                    style={{
                      background: "var(--color-surface-1)",
                      border: "1px solid var(--color-border-strong)",
                      color: "var(--color-text)",
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor =
                        "var(--color-accent)";
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor =
                        "var(--color-border-strong)";
                    }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => toggleVisible(def.envVar)}
                  title={state.visible ? "Ocultar" : "Mostrar"}
                  className="flex shrink-0 items-center justify-center rounded p-1.5 transition-colors"
                  style={{
                    background: "var(--color-surface-1)",
                    border: "1px solid var(--color-border-strong)",
                    color: "var(--color-text-secondary)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "var(--color-text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color =
                      "var(--color-text-secondary)";
                  }}
                >
                  <EyeIcon crossed={state.visible} />
                </button>
                {/* Env var name badge */}
                <span
                  className="shrink-0 rounded px-1.5 py-px text-[10px] tabular-nums"
                  style={{
                    fontFamily: "var(--font-mono)",
                    background: "var(--color-surface-1)",
                    border: "1px solid var(--color-border)",
                    color: "var(--color-text-tertiary)",
                  }}
                >
                  {def.envVar}
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Actions */}
      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded px-4 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {saving ? "Guardando…" : "Save all"}
        </button>
        <span
          className="text-[11.5px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          Solo se envían los campos con valor.
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div
          className="mt-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* Success / partial result banner */}
      {result && (
        <div
          className="mt-4 rounded p-3 text-[12px]"
          style={{
            background:
              errorCount > 0
                ? "rgba(248, 140, 0, 0.06)"
                : "rgba(63, 185, 80, 0.06)",
            border: `1px solid ${errorCount > 0 ? "rgba(248,140,0,0.30)" : "rgba(63,185,80,0.22)"}`,
            color:
              errorCount > 0
                ? "var(--color-warning, #f8a000)"
                : "var(--color-success)",
          }}
        >
          {savedCount > 0 && (
            <p>
              {savedCount === 1
                ? `1 key guardada: ${result.saved[0]}`
                : `${savedCount} keys guardadas: ${result.saved.join(", ")}`}
            </p>
          )}
          {errorCount > 0 && (
            <p className="mt-1">
              Errores:{" "}
              {Object.entries(result.errors)
                .map(([k, v]) => `${k} — ${v}`)
                .join("; ")}
            </p>
          )}
          {savedCount > 0 && errorCount === 0 && (
            <p className="mt-1 text-[11px] opacity-80">
              Listo — activas al instante. El proxy free-tier las usará al
              activarlo en AI Router → Proxy.
            </p>
          )}
        </div>
      )}

      {/* Divider + alternative */}
      <div
        className="mt-6 border-t pt-4"
        style={{ borderColor: "var(--color-border)" }}
      >
        <p
          className="text-[11.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Alternativa: ejecuta{" "}
          <code
            className="rounded px-1 py-px"
            style={{
              fontFamily: "var(--font-mono)",
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border)",
              fontSize: 11,
            }}
          >
            ~/.ultron/batches/set-api-keys.ps1
          </code>{" "}
          desde la pestaña Projects &rsaquo; Run batch.
        </p>
      </div>
    </div>
  );
}
