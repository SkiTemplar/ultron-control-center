// mar.ia — chat con relevo de proveedores.
//
// Un unico hilo que van contestando Claude, Codex, Gemini o el modelo local,
// en ese orden, saltando al siguiente cuando el anterior se queda sin cuota.
// Cada turno lleva la marca de quien lo contesto, y cuando hay relevo se dice
// por que: "claude — cuota agotada" en vez de un cambio silencioso.
//
// El hilo es de mar.ia (jsonl en ~/.ultron/cockpit/maria/threads). Ningun
// proveedor lee la sesion del otro: se les traspasa el contexto. Ver el
// modulo Rust `maria_relay` para el limite exacto.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Turn = {
  ts: string;
  role: string;
  provider: string;
  text: string;
};

type SkipReason = { provider: string; kind: string; detail: string };

type RelayAnswer = {
  thread_id: string;
  provider: string;
  text: string;
  skipped: SkipReason[];
  /** Proveedor que propuso el modelo local para esta tarea. */
  chosen_by_local: string | null;
};

type RelayConfig = { order: string[]; disabled: string[] };

/** Etiqueta legible de cada proveedor. */
const PROVIDER_LABEL: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  local: "local",
};

/** Motivo del salto, en castellano. */
const SKIP_LABEL: Record<string, string> = {
  cuota: "cuota agotada",
  error: "error",
  desactivado: "desactivado",
  sin_cli: "CLI no instalada",
  timeout: "sin respuesta",
};

/** Hilo activo. Uno por dia: agrupa el trabajo sin acumular un fichero eterno. */
function todayThreadId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `hilo-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export function MariaChat() {
  const [threadId] = useState(todayThreadId);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSkips, setLastSkips] = useState<SkipReason[]>([]);
  const [lastChoice, setLastChoice] = useState<string | null>(null);
  const [config, setConfig] = useState<RelayConfig | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void invoke<Turn[]>("maria_relay_thread", { threadId })
      .then((t) => setTurns(Array.isArray(t) ? t : []))
      .catch((e) => setError(String(e)));
    void invoke<RelayConfig>("maria_relay_config")
      .then(setConfig)
      .catch(() => setConfig(null));
  }, [threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns, busy]);

  async function send() {
    const texto = prompt.trim();
    if (!texto || busy) return;
    setBusy(true);
    setError(null);
    setLastSkips([]);
    setLastChoice(null);
    // Optimista: el turno del usuario se ve al instante; el backend lo
    // persiste igualmente, asi que al recargar el hilo no se duplica.
    setTurns((prev) => [
      ...prev,
      { ts: new Date().toISOString(), role: "user", provider: "", text: texto },
    ]);
    setPrompt("");
    try {
      const ans = await invoke<RelayAnswer>("maria_relay_ask", {
        threadId,
        prompt: texto,
      });
      setLastSkips(ans.skipped ?? []);
      setLastChoice(ans.chosen_by_local ?? null);
      setTurns((prev) => [
        ...prev,
        {
          ts: new Date().toISOString(),
          role: "assistant",
          provider: ans.provider,
          text: ans.text,
        },
      ]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col px-6 py-4">
      <header className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h1 className="hud-label" style={{ fontSize: 12 }}>
            chat · relevo de proveedores
          </h1>
          <p className="mt-1 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
            hilo <span className="font-mono">{threadId}</span>
            {config && (
              <>
                {" · orden "}
                <span className="font-mono">{config.order.join(" → ")}</span>
              </>
            )}
          </p>
        </div>
      </header>

      <div className="hud-panel hud-brackets min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
        {turns.length === 0 && !busy && (
          <p className="hud-label">
            hilo vacío. escribe abajo: contesta el primer proveedor disponible.
          </p>
        )}

        <div className="mx-auto w-full max-w-[820px]">
          {turns.map((t, i) => (
            <article key={`${t.ts}-${i}`} className="mb-3">
              <div className="mb-1 flex items-center gap-2">
                <span
                  className="hud-label"
                  style={{
                    color:
                      t.role === "user" ? "var(--color-text-secondary)" : "var(--color-accent)",
                  }}
                >
                  {t.role === "user" ? "tú" : (PROVIDER_LABEL[t.provider] ?? t.provider ?? "asistente")}
                </span>
                <span className="hud-label" style={{ letterSpacing: "0.06em" }}>
                  {new Date(t.ts).toLocaleTimeString("es-ES", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
              <div
                className="rounded-none px-3 py-2 text-[12px]"
                style={{
                  background:
                    t.role === "user" ? "var(--color-surface-3)" : "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text)",
                  overflowWrap: "anywhere",
                }}
              >
                <div className="cc-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{t.text}</ReactMarkdown>
                </div>
              </div>
            </article>
          ))}

          {busy && (
            <p className="hud-label hud-pulse py-2">consultando a los proveedores…</p>
          )}

          {lastChoice && (
            <p className="hud-label py-1">
              el modelo local eligió <span style={{ color: "var(--color-accent)" }}>{lastChoice}</span>{" "}
              para esta tarea
            </p>
          )}

          {lastSkips.length > 0 && (
            <p className="hud-label py-1" style={{ color: "var(--color-warn)" }}>
              relevo:{" "}
              {lastSkips
                .map((s) => `${s.provider} (${SKIP_LABEL[s.kind] ?? s.kind})`)
                .join(" · ")}
            </p>
          )}

          {error && (
            <p
              className="my-2 px-3 py-2 text-[12px]"
              style={{
                border: "1px solid var(--color-danger)",
                color: "var(--color-danger)",
                background: "rgba(255,77,94,0.08)",
              }}
            >
              {error}
            </p>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <span className="hud-label">&gt;</span>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={busy ? "esperando respuesta…" : "escribe y pulsa Enter…"}
          aria-label="mensaje"
          disabled={busy}
          className="hud-panel flex-1 px-3 py-2 text-[12px]"
          style={{
            color: "var(--color-text)",
            fontFamily: "var(--font-mono)",
            outline: "none",
            opacity: busy ? 0.6 : 1,
          }}
        />
      </form>
    </div>
  );
}
