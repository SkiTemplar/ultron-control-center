import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Settings > Pupus > URL del calendario de la uni (ICS). Es una URL de
// capacidad privada: se guarda en ~/.ultron/.env (fuera de git) con
// `mascot_calendar_set_url`, el campo nunca se precarga y ni la UI ni el
// backend la vuelven a enseñar. Los errores ya llegan redactados de Rust y,
// por si acaso, aquí se vuelve a quitar lo tecleado.

export interface CalendarStatus {
  configured: boolean;
  lastFetch: string | null;
  lastError: string | null;
  upcoming: number;
}

const input: React.CSSProperties = {
  background: "var(--color-surface-1)",
  border: "1px solid var(--color-border-strong)",
  color: "var(--color-text)",
  fontFamily: "var(--font-mono)",
};

const button: React.CSSProperties = {
  background: "var(--color-surface-3)",
  color: "var(--color-text)",
  border: "1px solid var(--color-border-strong)",
};

/** «Configurada · última descarga 14:05 · 2 entregas próximas». */
export function statusLine(s: CalendarStatus): string {
  if (!s.configured) return "Sin URL configurada.";
  const parts = ["Configurada"];
  if (s.lastFetch) {
    const d = new Date(s.lastFetch);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    parts.push(`última descarga ${hhmm}`);
  } else parts.push("aún sin descargar");
  parts.push(`${s.upcoming} ${s.upcoming === 1 ? "entrega próxima" : "entregas próximas"}`);
  return parts.join(" · ");
}

/** Quita del mensaje cualquier rastro de lo tecleado. */
function scrub(msg: string, secret: string): string {
  return secret.trim() ? msg.split(secret.trim()).join("[calendario]") : msg;
}

function Btn({ label, off, onClick }: { label: string; off: boolean; onClick: () => void }) {
  return (
    <button type="button" className="rounded px-2 py-1" style={button} disabled={off} onClick={onClick}>
      {label}
    </button>
  );
}

export function MascotCalendarField({ disabled }: { disabled?: boolean }) {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => invoke<CalendarStatus>("mascot_calendar_status").then(setStatus);
  useEffect(() => void load().catch((e) => setError(String(e))), []);

  const run = async (cmd: string, args?: Record<string, unknown>) => {
    const secret = draft;
    setBusy(true);
    setError(null);
    try {
      setStatus(await invoke<CalendarStatus>(cmd, args));
      setDraft("");
    } catch (e) {
      setError(scrub(String(e), secret));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 flex flex-col gap-1.5 pl-6 text-[12px]" style={{ opacity: disabled ? 0.5 : 1 }}>
      <div className="flex items-center gap-2">
        <input
          type="password"
          autoComplete="off"
          aria-label="URL del calendario (ICS)"
          placeholder={status?.configured ? "Nueva URL (la actual no se muestra)" : "https://… o webcal://… (.ics)"}
          value={draft}
          disabled={disabled || busy}
          onChange={(e) => setDraft(e.target.value)}
          className="min-w-0 flex-1 rounded px-2 py-1"
          style={input}
        />
        <Btn label="Guardar" off={!!disabled || busy || !draft.trim()} onClick={() => void run("mascot_calendar_set_url", { url: draft })} />
        <Btn label="Comprobar ahora" off={!!disabled || busy || !status?.configured} onClick={() => void run("mascot_calendar_refresh")} />
        {status?.configured && <Btn label="Quitar" off={busy} onClick={() => void run("mascot_calendar_set_url", { url: "" })} />}
      </div>
      <span style={{ color: "var(--color-text-tertiary)" }}>
        {status ? statusLine(status) : "Cargando…"}
        {status?.lastError && <span style={{ color: "var(--color-danger)" }}> · {status.lastError}</span>}
      </span>
      {error && <span style={{ color: "var(--color-danger)" }}>{error}</span>}
    </div>
  );
}
