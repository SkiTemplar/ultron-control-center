import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type AuthEntry = {
  provider: string;
  logged_in: boolean;
  credential_path: string;
  last_modified: string | null;
  age_days: number | null;
  binary_present: boolean;
  binary_path: string | null;
  note: string | null;
};

export type AuthReport = {
  entries: AuthEntry[];
};

const META: Record<
  string,
  { label: string; color: string; loginHint: string }
> = {
  claude: {
    label: "Claude",
    // Nota: el color aquí es el color de la etiqueta del proveedor,
    // no el del badge de estado. El badge de estado se calcula por separado.
    color: "var(--color-success)",
    loginHint: "Inicia una sesión `claude` y escribe `/login`.",
  },
  codex: {
    label: "Codex",
    color: "#a875ff",
    loginHint: "Ejecuta `codex login` en una terminal.",
  },
  gemini: {
    label: "Gemini",
    color: "var(--color-warn)",
    loginHint: "Ejecuta `gemini auth login` en una terminal.",
  },
};

function formatRelativeIso(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function AuthStatus() {
  const [report, setReport] = useState<AuthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // audit verify-audit-2 rank8: useCallback con deps [] para que el effect
  // de abajo tenga referencia estable y el linter no pida suprimir la dep.
  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = (await invoke("auth_status")) as AuthReport;
      setReport(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          Authentication
        </h3>
        <button
          type="button"
          onClick={load}
          disabled={refreshing}
          className="text-[11.5px] transition-colors disabled:opacity-50"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {refreshing ? "Checking…" : "Recheck"}
        </button>
      </div>
      <p
        className="text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Estado de los tres CLIs. Solo se verifica presencia y antigüedad del fichero
        de credenciales — los tokens nunca se leen ni se validan contra la API.
      </p>

      {error && (
        <div
          className="rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      <div className="space-y-2">
        {report?.entries.map((e) => {
          const m = META[e.provider] ?? {
            label: e.provider,
            color: "var(--color-text-secondary)",
            loginHint: "",
          };
          const stale = e.age_days != null && e.age_days > 60;

          // HONESTIDAD: el backend solo verifica que el fichero de credenciales
          // existe y lee su mtime. NO valida el token contra la API. Un token
          // caducado o revocado con el fichero en disco se reporta como
          // logged_in=true. Por eso:
          //   - logged_in=false → rojo (fichero ausente, definitivamente no logueado)
          //   - logged_in=true, stale → ámbar (credenciales antiguas, mayor riesgo)
          //   - logged_in=true, reciente → ámbar tenue (fichero presente, token sin verificar)
          // Nunca usamos verde rotundo porque no tenemos validación real del token.
          const dot = !e.logged_in
            ? "var(--color-danger)"
            : "var(--color-warn)";

          // Tooltip que aclara la limitación al hacer hover sobre el dot.
          const dotTooltip = e.logged_in
            ? stale
              ? `Fichero de credenciales presente pero con ${e.age_days} días de antigüedad. Validez del token no verificada.`
              : `Fichero de credenciales presente (${formatRelativeIso(e.last_modified)}). Validez del token no verificada.`
            : "Fichero de credenciales no encontrado.";

          const stateLabel = !e.logged_in
            ? "sin credenciales"
            : stale
              ? `credenciales antiguas · ${e.age_days}d`
              : `credenciales presentes · ${formatRelativeIso(e.last_modified)}`;
          return (
            <div
              key={e.provider}
              className="rounded p-3"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <div className="flex items-baseline gap-2">
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: dot }}
                  title={dotTooltip}
                />
                <span
                  className="text-[12.5px] font-medium"
                  style={{ color: "var(--color-text)" }}
                >
                  {m.label}
                </span>
                <span
                  className="ml-auto text-[10.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                  title={dotTooltip}
                >
                  {stateLabel}
                </span>
              </div>
              {e.logged_in && (
                <p
                  className="mt-1 text-[10.5px] leading-relaxed"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  Fichero de credenciales presente; validez del token no verificada.
                </p>
              )}
              <div
                className="mt-1 truncate text-[10.5px]"
                style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-faint)" }}
                title={e.credential_path}
              >
                {e.credential_path}
              </div>
              {!e.binary_present && (
                <div
                  className="mt-2 text-[11.5px]"
                  style={{ color: "var(--color-warn)" }}
                >
                  Binary not found in PATH.
                </div>
              )}
              {e.note && (
                <p
                  className="mt-2 text-[11.5px] leading-relaxed"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {e.note}
                </p>
              )}
              {!e.logged_in && (
                <p
                  className="mt-1 text-[11.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  → {m.loginHint}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
