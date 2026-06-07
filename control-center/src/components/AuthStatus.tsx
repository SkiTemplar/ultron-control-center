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
  /** Real validity from the credential file's expiry timestamp. null = the
   *  file carries no expiry, so validity is genuinely unverified (amber). */
  expires_at?: string | null;
  expired?: boolean | null;
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

type AuthStatusProps = {
  /** Called after a successful reauth spawn so the parent can refresh its own
   *  state (e.g. the Settings component re-checks whether auth is fresh). */
  onRecheck?: () => void;
};

export function AuthStatus({ onRecheck }: AuthStatusProps = {}) {
  const [report, setReport] = useState<AuthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [recheckCountdown, setRecheckCountdown] = useState<number | null>(null);

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

  // Lanza la reautenticación abriendo el CLI del proveedor en una terminal.
  //   claude → abre `claude` con `/login` en el portapapeles (pégalo y envía).
  //   codex / gemini → abre el CLI, que dispara su propio flujo de login (OAuth)
  //     cuando no hay credenciales válidas. El comando manual está en el hint.
  //
  // After spawning, we schedule an automatic re-check after 5 s so the status
  // badge updates once the CLI has had time to write its credential file.
  // The countdown label keeps the user informed instead of showing a stale state.
  const reauth = useCallback(async (provider: string) => {
    try {
      const prompt = provider === "claude" ? "/login" : null;
      const flags = provider === "claude" ? { paste_only: true } : undefined;
      await invoke("spawn_session", { provider, prompt, cwd: null, flags });
      setError(null);
      // Show countdown, then re-check auth state.
      setRecheckCountdown(5);
      const tick = setInterval(() => {
        setRecheckCountdown((prev) => {
          if (prev === null || prev <= 1) {
            clearInterval(tick);
            void load().then(() => { onRecheck?.(); });
            return null;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (e) {
      setError(String(e));
    }
  }, [load, onRecheck]);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          Authentication
        </h3>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="text-[11.5px] transition-colors disabled:opacity-50"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {recheckCountdown !== null
            ? `Re-checking in ${recheckCountdown}s…`
            : refreshing
              ? "Checking…"
              : "Recheck"}
        </button>
      </div>
      <p
        className="text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Estado de los tres CLIs. Solo se verifica presencia y antigüedad del fichero
        de credenciales — los tokens nunca se leen ni se validan contra la API. Para
        reautenticarte, pulsa <b>Reautenticar</b>: abre el CLI en una terminal (Claude
        con <code style={{ fontFamily: "var(--font-mono)" }}>/login</code> listo para
        pegar; Codex y Gemini lanzan su propio login).
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

          // El backend ahora lee el timestamp de expiración DENTRO del fichero
          // de credenciales (sin tocar el token). Por eso:
          //   - logged_in=false            → rojo (no hay fichero)
          //   - expired=true               → rojo (token caducado, verificado)
          //   - expired=false              → verde (token válido, verificado)
          //   - expired=null (sin campo)   → ámbar (presente, validez no verificable)
          const expired = e.expired; // true | false | null/undefined
          const dot = !e.logged_in
            ? "var(--color-danger)"
            : expired === true
              ? "var(--color-danger)"
              : expired === false
                ? "var(--color-success)"
                : "var(--color-warn)";

          // Tooltip que refleja el estado real (o la limitación cuando no hay
          // campo de expiración).
          const dotTooltip = !e.logged_in
            ? "Fichero de credenciales no encontrado."
            : expired === true
              ? `Token caducado el ${e.expires_at}. Reautentícate.`
              : expired === false
                ? `Token válido hasta ${e.expires_at} (verificado por la expiración del fichero de credenciales).`
                : stale
                  ? `Credenciales de ${e.age_days} días sin campo de expiración. Validez del token no verificada.`
                  : `Fichero de credenciales presente (${formatRelativeIso(e.last_modified)}) sin campo de expiración. Validez del token no verificada.`;

          const stateLabel = !e.logged_in
            ? "sin credenciales"
            : expired === true
              ? "token caducado"
              : expired === false
                ? "token válido"
                : stale
                  ? `sin expiración · ${e.age_days}d`
                  : "validez no verificada";
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
                  {expired === true
                    ? `Token caducado el ${e.expires_at}.`
                    : expired === false
                      ? `Token válido hasta ${e.expires_at}.`
                      : "Fichero de credenciales presente; sin campo de expiración, validez no verificada."}
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
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => void reauth(e.provider)}
                  className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                  title={`Abrir ${m.label} en una terminal para iniciar sesión`}
                >
                  Reautenticar
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
