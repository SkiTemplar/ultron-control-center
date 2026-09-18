// mar.ia — chat con relevo de proveedores.
//
// Una CONVERSACION es un hilo que dura hasta que se cierra, no una pregunta.
// Dentro de ella pueden contestar Claude, Codex, Gemini o el modelo local:
// quien atiende lo decide mar.ia (el modelo local) mirando la peticion, y si
// el elegido se queda sin cuota se releva al siguiente. Cada turno lleva la
// marca de quien lo contesto, y cuando hay relevo se dice por que.
//
// El hilo es de mar.ia (jsonl en ~/.ultron/cockpit/maria/threads). Ningun
// proveedor lee la sesion del otro: se les traspasa el contexto. Ver el
// modulo Rust `maria_relay` para el limite exacto.
//
// La barra lateral y los comandos de barra viven en `ThreadSidebar.tsx` y
// `chatCommands.ts`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ThreadSidebar, type ThreadMeta } from "./ThreadSidebar";
import {
  COMMANDS,
  helpText,
  parseLine,
  parseProvider,
  suggestFor,
  type Provider,
} from "./chatCommands";

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

type ProviderState = { status: string; detail: string; at: string; answered: number };

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

/** Aviso del propio chat (no es un turno: no se guarda en el hilo). */
type Aviso = { ts: number; text: string; tono: "info" | "error" };

export function MariaChat() {
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [threadId, setThreadId] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [avisos, setAvisos] = useState<Aviso[]>([]);
  const [lastSkips, setLastSkips] = useState<SkipReason[]>([]);
  const [lastChoice, setLastChoice] = useState<string | null>(null);
  const [config, setConfig] = useState<RelayConfig | null>(null);
  /** Proveedor forzado con /migrar. null = decide mar.ia. */
  const [forzado, setForzado] = useState<Provider | null>(null);
  const [query, setQuery] = useState("");
  const [sugerido, setSugerido] = useState(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const sugerencias = suggestFor(prompt);
  const activa = useMemo(
    () => threads.find((t) => t.id === threadId) ?? null,
    [threads, threadId],
  );

  const avisar = useCallback((text: string, tono: Aviso["tono"] = "info") => {
    setAvisos((prev) => [...prev.slice(-4), { ts: Date.now(), text, tono }]);
  }, []);

  const recargarLista = useCallback(async () => {
    const lista = await invoke<ThreadMeta[]>("maria_threads_list").catch(() => []);
    setThreads(Array.isArray(lista) ? lista : []);
    return lista;
  }, []);

  // Arranque: lista de conversaciones + la activa. Si no hay ninguna abierta
  // se crea una: el chat nunca debe quedarse sin sitio donde escribir.
  useEffect(() => {
    void (async () => {
      const lista = await recargarLista();
      const abierta = lista.find((t) => !t.closed);
      if (abierta) {
        setThreadId(abierta.id);
        return;
      }
      const nueva = await invoke<ThreadMeta>("maria_thread_create", { folder: null }).catch(
        () => null,
      );
      if (nueva) {
        setThreadId(nueva.id);
        void recargarLista();
      }
    })();
    void invoke<RelayConfig>("maria_relay_config")
      .then(setConfig)
      .catch(() => setConfig(null));
  }, [recargarLista]);

  // Turnos de la conversacion activa.
  useEffect(() => {
    if (!threadId) return;
    void invoke<Turn[]>("maria_relay_thread", { threadId })
      .then((t) => setTurns(Array.isArray(t) ? t : []))
      .catch((e) => avisar(String(e), "error"));
    setLastSkips([]);
    setLastChoice(null);
  }, [threadId, avisar]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns, busy, avisos]);

  useEffect(() => {
    setSugerido(0);
  }, [prompt]);

  async function nuevaConversacion(folder?: string) {
    const nueva = await invoke<ThreadMeta>("maria_thread_create", {
      folder: folder ?? null,
    }).catch((e) => {
      avisar(String(e), "error");
      return null;
    });
    if (!nueva) return;
    setThreadId(nueva.id);
    setTurns([]);
    setForzado(null);
    await recargarLista();
    avisar(folder ? `conversación nueva en «${folder}»` : "conversación nueva");
  }

  /** Ejecuta un comando de barra. Devuelve true si consumio la linea. */
  async function ejecutarComando(name: string, arg: string): Promise<void> {
    switch (name) {
      case "/ayuda":
        avisar(helpText());
        return;
      case "/nueva":
        await nuevaConversacion(arg || undefined);
        return;
      case "/cerrar": {
        if (!threadId) return;
        avisar("cerrando y titulando con el modelo local…");
        const meta = await invoke<ThreadMeta>("maria_thread_close", { threadId }).catch((e) => {
          avisar(String(e), "error");
          return null;
        });
        if (meta) avisar(`conversación cerrada: «${meta.title}»`);
        await nuevaConversacion();
        return;
      }
      case "/migrar": {
        const p = parseProvider(arg);
        if (!p) {
          avisar(`«${arg || "(vacío)"}» no es un proveedor: claude, codex, gemini o local`, "error");
          return;
        }
        setForzado(p);
        avisar(`a partir de ahora contesta ${p}. /analizar devuelve la decisión a mar.ia`);
        return;
      }
      case "/analizar":
        setForzado(null);
        avisar("mar.ia vuelve a elegir proveedor según lo que escribas");
        return;
      case "/fijar": {
        if (!activa) return;
        await invoke("maria_thread_pin", { threadId, pinned: !activa.pinned }).catch((e) =>
          avisar(String(e), "error"),
        );
        await recargarLista();
        avisar(activa.pinned ? "conversación soltada" : "conversación fijada");
        return;
      }
      case "/titulo": {
        if (!arg) {
          avisar("dime el título: /titulo router y dns", "error");
          return;
        }
        const t = await invoke<string>("maria_thread_rename", { threadId, title: arg }).catch(
          (e) => {
            avisar(String(e), "error");
            return null;
          },
        );
        await recargarLista();
        if (t) avisar(`título: «${t}»`);
        return;
      }
      case "/carpeta": {
        await invoke("maria_thread_folder", { threadId, folder: arg }).catch((e) =>
          avisar(String(e), "error"),
        );
        await recargarLista();
        avisar(arg ? `movida a «${arg}»` : "fuera de carpetas");
        return;
      }
      case "/borrar": {
        if (!threadId) return;
        await invoke("maria_thread_delete", { threadId }).catch((e) => avisar(String(e), "error"));
        await recargarLista();
        avisar("conversación borrada");
        await nuevaConversacion();
        return;
      }
      case "/proveedores": {
        const estado = await invoke<Record<string, ProviderState>>("maria_relay_state").catch(
          () => ({}) as Record<string, ProviderState>,
        );
        const orden = config?.order ?? ["claude", "codex", "gemini", "local"];
        const lineas = orden.map((p) => {
          const e = estado[p];
          if (!e) return `${p} — sin datos todavía`;
          const cuando = e.at ? new Date(e.at).toLocaleString("es-ES") : "—";
          return `${p} — ${e.status} (${e.answered} respuestas, último ${cuando})`;
        });
        avisar(lineas.join("\n"));
        return;
      }
      default:
        avisar(`comando desconocido: ${name}`, "error");
    }
  }

  async function enviarMensaje(texto: string) {
    setBusy(true);
    setLastSkips([]);
    setLastChoice(null);
    const eraVacia = turns.length === 0;
    // Optimista: el turno del usuario se ve al instante; el backend lo
    // persiste igualmente, asi que al recargar el hilo no se duplica.
    setTurns((prev) => [
      ...prev,
      { ts: new Date().toISOString(), role: "user", provider: "", text: texto },
    ]);
    try {
      const ans = await invoke<RelayAnswer>("maria_relay_ask", {
        threadId,
        prompt: texto,
        provider: forzado,
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
      // El primer intercambio le pone nombre a la conversacion: sin esto la
      // lista se llena de filas parecidas imposibles de distinguir.
      if (eraVacia) {
        void invoke<string>("maria_thread_autotitle", { threadId })
          .then(() => recargarLista())
          .catch(() => undefined);
      } else {
        void recargarLista();
      }
    } catch (e) {
      avisar(String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const linea = prompt.trim();
    if (!linea || busy || !threadId) return;
    // Con el menu abierto, Enter COMPLETA en vez de enviar — salvo que lo
    // escrito ya sea un comando entero, en cuyo caso se ejecuta. Sin esto,
    // teclear "/pro" + Enter respondia "no conozco /pro" en lugar de
    // completar a "/proveedores", que es lo que se esta viendo en pantalla.
    const esComandoEntero = COMMANDS.some((c) => c.name === linea.split(" ")[0].toLowerCase());
    if (sugerencias.length > 0 && !esComandoEntero) {
      aceptarSugerencia();
      return;
    }
    setPrompt("");
    const parsed = parseLine(linea);
    if (parsed.kind === "unknown") {
      avisar(`no conozco ${parsed.name}. Escribe / para ver los comandos`, "error");
      return;
    }
    if (parsed.kind === "command") {
      await ejecutarComando(parsed.name, parsed.arg);
      return;
    }
    await enviarMensaje(parsed.text);
  }

  /** Completa con la sugerencia marcada. */
  function aceptarSugerencia(i = sugerido) {
    const cmd = sugerencias[i];
    if (!cmd) return;
    setPrompt(cmd.args ? `${cmd.name} ` : cmd.name);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (sugerencias.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSugerido((s) => (s + 1) % sugerencias.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSugerido((s) => (s - 1 + sugerencias.length) % sugerencias.length);
    } else if (e.key === "Tab") {
      e.preventDefault();
      aceptarSugerencia();
    } else if (e.key === "Escape") {
      setPrompt("");
    }
  }

  return (
    <div className="flex h-full min-w-0">
      <ThreadSidebar
        threads={threads}
        activeId={threadId}
        query={query}
        onQuery={setQuery}
        onSelect={setThreadId}
        onNew={() => void nuevaConversacion()}
        onPin={(id, pinned) => {
          void invoke("maria_thread_pin", { threadId: id, pinned })
            .then(() => recargarLista())
            .catch((e) => avisar(String(e), "error"));
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col px-6 py-4">
        <header className="mb-3">
          <h1 className="hud-label" style={{ fontSize: 12 }}>
            {activa?.title || "chat"} {activa?.closed ? "· cerrada" : ""}
          </h1>
          <p className="mt-1 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
            {forzado ? (
              <>
                destino fijado a <span style={{ color: "var(--color-warn)" }}>{forzado}</span>
              </>
            ) : (
              <>mar.ia elige proveedor según la petición</>
            )}
            {config && (
              <>
                {" · relevo "}
                <span className="font-mono">{config.order.join(" → ")}</span>
              </>
            )}
          </p>
        </header>

        <div className="hud-panel hud-brackets min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
          {turns.length === 0 && !busy && (
            <p className="hud-label">
              conversación vacía. escribe abajo, o «/» para ver los comandos.
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
                    {t.role === "user"
                      ? "tú"
                      : (PROVIDER_LABEL[t.provider] ?? t.provider ?? "asistente")}
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

            {busy && <p className="hud-label hud-pulse py-2">consultando a los proveedores…</p>}

            {lastChoice && (
              <p className="hud-label py-1">
                mar.ia asignó esta petición a{" "}
                <span style={{ color: "var(--color-accent)" }}>{lastChoice}</span>
              </p>
            )}

            {lastSkips.length > 0 && (
              <p className="hud-label py-1" style={{ color: "var(--color-warn)" }}>
                relevo:{" "}
                {lastSkips.map((s) => `${s.provider} (${SKIP_LABEL[s.kind] ?? s.kind})`).join(" · ")}
              </p>
            )}

            {avisos.map((a) => (
              <pre
                key={a.ts}
                className="my-1 whitespace-pre-wrap px-3 py-2 text-[11px]"
                style={{
                  border: `1px solid ${
                    a.tono === "error" ? "var(--color-danger)" : "var(--color-border)"
                  }`,
                  color: a.tono === "error" ? "var(--color-danger)" : "var(--color-text-secondary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {a.text}
              </pre>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="relative">
          {sugerencias.length > 0 && (
            <ul
              className="hud-panel hud-menu absolute bottom-full left-0 mb-1 w-full max-w-[520px] overflow-hidden py-1"
              role="listbox"
              aria-label="comandos disponibles"
            >
              {sugerencias.map((c, i) => (
                <li key={c.name}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === sugerido}
                    onMouseDown={(e) => {
                      // mousedown, no click: el input pierde el foco antes de
                      // que llegue el click y la sugerencia no se aplicaria.
                      e.preventDefault();
                      aceptarSugerencia(i);
                    }}
                    className="flex w-full items-baseline gap-2 px-3 py-1 text-left text-[11px]"
                    style={{
                      background: i === sugerido ? "var(--color-surface-3)" : "transparent",
                      color: "var(--color-text)",
                      border: "none",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    <span style={{ color: "var(--color-accent)" }}>{c.name}</span>
                    {c.args && (
                      <span style={{ color: "var(--color-text-tertiary)" }}>{c.args}</span>
                    )}
                    <span
                      className="ml-auto truncate"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {c.desc}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <span className="hud-label">&gt;</span>
            <input
              ref={inputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={busy ? "esperando respuesta…" : "escribe, o « / » para comandos…"}
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
      </div>
    </div>
  );
}
