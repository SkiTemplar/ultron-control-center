// mar.ia — chat con relevo de proveedores.
//
// Una CONVERSACION es un hilo que dura hasta que se cierra, no una pregunta.
// Dentro de ella pueden contestar Claude, Codex, Gemini o el modelo local:
// quien atiende lo decide mar.ia (el modelo local) mirando la peticion, y si
// el elegido se queda sin cuota se releva al siguiente. Cada turno lleva la
// marca de quien lo contesto, y cuando hay relevo se dice por que.
//
// El hilo es de mar.ia (jsonl en ~/.maria/cockpit/maria/threads). Ningun
// proveedor lee la sesion del otro: se les traspasa el contexto. Ver el
// modulo Rust `maria_relay` para el limite exacto.
//
// La barra lateral y los comandos de barra viven en `ThreadSidebar.tsx` y
// `chatCommands.ts`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BotonMicrofono } from "./BotonMicrofono";
import { BotonCopiar } from "./BotonCopiar";
import { useHistorialEnviados } from "../../lib/useHistorialEnviados";
import { useVoice } from "./HudFrame";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ThreadSidebar, type ThreadMeta } from "./ThreadSidebar";
import { HudSelect } from "./HudSelect";
import {
  COMMANDS,
  ESFUERZOS,
  helpText,
  parseEsfuerzo,
  parseLine,
  parseProvider,
  suggestFor,
  type Esfuerzo,
  type Provider,
} from "./chatCommands";

type Turn = {
  ts: string;
  role: string;
  provider: string;
  /** Modelo concreto que contesto. Vacio en turnos anteriores a que se
   *  guardara, y en los del usuario. */
  model?: string;
  effort?: string;
  text: string;
};

/** Catalogo de modelos que sirve el backend (`maria_models_catalog`). */
type ModeloInfo = { id: string; label: string; para: string };
type CatalogoProveedor = {
  provider: string;
  models: ModeloInfo[];
  default_model: string;
  effort_mode: string;
};
type Catalogo = { providers: CatalogoProveedor[]; efforts: string[] };

/** Como se controla el esfuerzo en cada proveedor. Se enseña tal cual para no
 *  fingir un mando que esa CLI no tiene. */
const EFFORT_MODE_LABEL: Record<string, string> = {
  Bandera: "control real",
  EnElPrompt: "se pide en el mensaje",
  Razonamiento: "razonar sí/no",
  SinControl: "sin control",
};

type SkipReason = { provider: string; kind: string; detail: string };

type RelayAnswer = {
  thread_id: string;
  provider: string;
  /** Modelo concreto que atendio el turno. */
  model: string;
  effort: string;
  /** "local" si lo decidio mar.ia, "manual" si lo fijo el usuario. */
  decided_by: string;
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
  antigravity: "antigravity (agy)",
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

/** Para qué sirve cada proveedor, en una línea. Se lee dentro del desplegable:
 *  elegir a ciegas entre cuatro nombres no ayuda a nadie. */
const PROVEEDOR_HINT: Record<string, string> = {
  claude: "programar en un proyecto, arquitectura, textos largos",
  codex: "scripts sueltos y automatización",
  antigravity: "los modelos de Google (Gemini) por la suscripción",
  local: "gratis y sin cuota; lo trivial y las órdenes del PC",
};

/** Qué significa cada nivel de esfuerzo. El control real depende del
 *  proveedor (ver la línea de debajo de los selectores). */
const ESFUERZO_HINT: Record<string, string> = {
  bajo: "responde directo, sin desarrollar",
  medio: "lo normal",
  alto: "analiza a fondo antes de contestar; tarda más",
};

type Props = {
  /** Conversacion a abrir. Solo la usa el mosaico: la pestana Chat elige ella
   *  misma la ultima abierta. */
  hiloInicial?: string;
  /** true en un panel del mosaico: sin barra lateral, la lista de
   *  conversaciones ya esta en su propia pestana y en un panel estrecho solo
   *  robaria la mitad del ancho. */
  compacto?: boolean;
  /** Avisa de la conversacion activa para que el mosaico la recuerde. */
  onHilo?: (id: string) => void;
};

export function MariaChat({ hiloInicial, compacto = false, onHilo }: Props = {}) {
  // Estado de la voz, para el botón de micrófono de abajo.
  const { state: voiceState, mic } = useVoice();
  // Historial de lo enviado, recuperable con las flechas.
  const historial = useHistorialEnviados("chat");
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [threadId, setThreadId] = useState(hiloInicial ?? "");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [avisos, setAvisos] = useState<Aviso[]>([]);
  const [lastSkips, setLastSkips] = useState<SkipReason[]>([]);
  const [lastChoice, setLastChoice] = useState<string | null>(null);
  const [config, setConfig] = useState<RelayConfig | null>(null);
  /** Proveedor forzado con /migrar. null = decide mar.ia. */
  const [forzado, setForzado] = useState<Provider | null>(null);
  /** Modelo y esfuerzo fijados a mano. null = los decide mar.ia. */
  const [modeloFijo, setModeloFijo] = useState<string | null>(null);
  const [esfuerzoFijo, setEsfuerzoFijo] = useState<Esfuerzo | null>(null);
  const [catalogo, setCatalogo] = useState<Catalogo | null>(null);
  /** Lo que mar.ia decidio en el ultimo turno (para pintarlo en la cabecera). */
  const [ultimo, setUltimo] = useState<{ model: string; effort: string } | null>(null);
  const [query, setQuery] = useState("");
  const [sugerido, setSugerido] = useState(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const sugerencias = suggestFor(prompt);
  const activa = useMemo(
    () => threads.find((t) => t.id === threadId) ?? null,
    [threads, threadId],
  );

  /** Modelos del proveedor fijado. Sin proveedor fijado no se ofrece ninguno:
   *  un modelo sin saber de quien es no se puede mandar a nadie. */
  const modelosDe = useCallback(
    (p: string | null): ModeloInfo[] =>
      (p && catalogo?.providers.find((c) => c.provider === p)?.models) || [],
    [catalogo],
  );

  const modoEsfuerzoDe = useCallback(
    (p: string): string =>
      catalogo?.providers.find((c) => c.provider === p)?.effort_mode ?? "",
    [catalogo],
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
      // Con hilo indicado (mosaico) se respeta ese y no se abre otro.
      if (hiloInicial) {
        setThreadId(hiloInicial);
        return;
      }
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
    void invoke<Catalogo>("maria_models_catalog")
      .then(setCatalogo)
      .catch(() => setCatalogo(null));
  }, [recargarLista, hiloInicial]);

  // El mosaico guarda que conversacion tiene cada panel para reabrirla igual.
  useEffect(() => {
    if (threadId) onHilo?.(threadId);
  }, [threadId, onHilo]);

  // El proveedor pegado viaja CON la conversacion, no con la pantalla: al
  // cambiar de hilo (o al recargar) el desplegable tiene que enseñar el que
  // esa conversacion tiene fijado. Antes vivia solo en el estado de este
  // componente y se perdia, que es por lo que el mensaje siguiente volvia al
  // modelo general (reportado el 2026-09-21).
  useEffect(() => {
    const ficha = threads.find((t) => t.id === threadId);
    setForzado((ficha?.provider || null) as Provider | null);
  }, [threadId, threads]);

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
    setModeloFijo(null);
    setEsfuerzoFijo(null);
    setUltimo(null);
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
          avisar(
            `«${arg || "(vacío)"}» no es un proveedor: claude, codex, antigravity o local`,
            "error",
          );
          return;
        }
        setForzado(p);
        avisar(`a partir de ahora contesta ${p}. /analizar devuelve la decisión a mar.ia`);
        return;
      }
      case "/analizar":
        setForzado(null);
        setModeloFijo(null);
        setEsfuerzoFijo(null);
        avisar("mar.ia vuelve a elegir proveedor, modelo y esfuerzo según lo que escribas");
        return;
      case "/modelo": {
        const disponibles = modelosDe(forzado);
        if (disponibles.length === 0) {
          avisar("primero elige proveedor: /migrar claude", "error");
          return;
        }
        const elegido = disponibles.find((m) => m.id.toLowerCase() === arg.trim().toLowerCase());
        if (!elegido) {
          avisar(
            `«${arg || "(vacío)"}» no está en ${forzado}: ${disponibles
              .map((m) => m.id)
              .join(", ")}`,
            "error",
          );
          return;
        }
        setModeloFijo(elegido.id);
        avisar(`modelo fijado a ${elegido.id}`);
        return;
      }
      case "/esfuerzo": {
        const nivel = parseEsfuerzo(arg);
        if (!nivel) {
          avisar(`«${arg || "(vacío)"}» no es un nivel: ${ESFUERZOS.join(", ")}`, "error");
          return;
        }
        setEsfuerzoFijo(nivel);
        const modo = forzado ? modoEsfuerzoDe(forzado) : "";
        avisar(
          modo
            ? `esfuerzo ${nivel} (en ${forzado}: ${EFFORT_MODE_LABEL[modo] ?? modo})`
            : `esfuerzo fijado a ${nivel}`,
        );
        return;
      }
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
        const orden = config?.order ?? ["claude", "codex", "antigravity", "local"];
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
        model: modeloFijo,
        effort: esfuerzoFijo,
      });
      setLastSkips(ans.skipped ?? []);
      setLastChoice(ans.chosen_by_local ?? null);
      setUltimo({ model: ans.model ?? "", effort: ans.effort ?? "" });
      setTurns((prev) => [
        ...prev,
        {
          ts: new Date().toISOString(),
          role: "assistant",
          provider: ans.provider,
          model: ans.model,
          effort: ans.effort,
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
    // Al historial ANTES de limpiar la caja: si el envio falla, lo escrito
    // sigue recuperable con la flecha arriba.
    historial.recordar(linea);
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
    // Las flechas navegan por lo que has enviado, como en una terminal. Solo
    // cuando NO hay lista de comandos desplegada: ahi las flechas eligen
    // sugerencia, y robarselas dejaria la lista sin poder recorrerse.
    if (sugerencias.length === 0) {
      historial.manejarTecla(e, prompt, setPrompt);
      return;
    }
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
      {!compacto && (
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
      )}

      <div
        className={
          compacto
            ? "flex min-w-0 flex-1 flex-col px-3 py-2"
            : "flex min-w-0 flex-1 flex-col px-6 py-4"
        }
      >
        <header className="mb-3">
          <h1 className="hud-label" style={{ fontSize: 12 }}>
            {activa?.title || "chat"} {activa?.closed ? "· cerrada" : ""}
          </h1>

          {/* Quien va a contestar y con que. Los tres selectores en "auto"
              significan que decide mar.ia; en cuanto tocas uno, manda el
              usuario y se dice explicitamente. */}
          <div className="mt-2 flex flex-wrap items-end gap-3 text-[12px]">
            <HudSelect
              etiqueta="proveedor"
              valor={forzado ?? ""}
              vacio="auto · decide mar.ia"
              ancho={168}
              titulo="quién contesta"
              opciones={(config?.order ?? []).map((p) => ({
                id: p,
                label: p,
                hint: PROVEEDOR_HINT[p],
              }))}
              onChange={(v) => {
                const p = v ? parseProvider(v) : null;
                setForzado(p);
                // El modelo pertenece a un proveedor: al cambiar de proveedor,
                // mantener "opus" seleccionado mandaria un modelo que la otra
                // CLI no tiene.
                setModeloFijo(null);
              }}
            />
            <HudSelect
              etiqueta="modelo"
              valor={modeloFijo ?? ""}
              vacio={forzado ? "auto · el que elija mar.ia" : "elige antes proveedor"}
              ancho={176}
              titulo="qué modelo concreto contesta"
              opciones={modelosDe(forzado).map((m) => ({
                id: m.id,
                label: m.label,
                hint: m.para,
              }))}
              onChange={(v) => setModeloFijo(v || null)}
            />
            <HudSelect
              etiqueta="esfuerzo"
              valor={esfuerzoFijo ?? ""}
              vacio="auto"
              ancho={140}
              titulo="cuánto debe pensar antes de contestar"
              opciones={(catalogo?.efforts ?? [...ESFUERZOS]).map((e) => ({
                id: e,
                label: e,
                hint: ESFUERZO_HINT[e],
              }))}
              onChange={(v) => setEsfuerzoFijo((v as Esfuerzo) || null)}
            />
            {(forzado || modeloFijo || esfuerzoFijo) && (
              <button
                type="button"
                onClick={() => {
                  setForzado(null);
                  setModeloFijo(null);
                  setEsfuerzoFijo(null);
                }}
                className="hud-panel px-3 text-[12px]"
                style={{
                  minHeight: 38,
                  color: "var(--color-warn)",
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
                }}
                title="vuelve a dejar que mar.ia elija (igual que /analizar)"
              >
                volver a auto
              </button>
            )}
            <span className="pb-2" style={{ color: "var(--color-text-tertiary)" }}>
              {forzado || modeloFijo || esfuerzoFijo ? (
                <span style={{ color: "var(--color-warn)" }}>fijado a mano</span>
              ) : (
                "lo decide mar.ia"
              )}
              {ultimo?.model && (
                <>
                  {" · último: "}
                  <span className="font-mono">{ultimo.model}</span>
                  {ultimo.effort ? ` (${ultimo.effort})` : ""}
                </>
              )}
            </span>
          </div>

          <p className="mt-1 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
            {config && (
              <>
                relevo <span className="font-mono">{config.order.join(" → ")}</span>
              </>
            )}
            {forzado && modoEsfuerzoDe(forzado) && (
              <>
                {" · esfuerzo en "}
                {forzado}: {EFFORT_MODE_LABEL[modoEsfuerzoDe(forzado)] ?? modoEsfuerzoDe(forzado)}
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
                  {t.role !== "user" && t.model && (
                    <span
                      className="px-2 py-0.5 text-[11px]"
                      style={{
                        border: "1px solid var(--color-border)",
                        background: "var(--color-surface-3)",
                        color: "var(--color-text-secondary)",
                        fontFamily: "var(--font-mono)",
                      }}
                      title="modelo y esfuerzo con los que se contestó"
                    >
                      {t.model}
                      {t.effort ? ` · ${t.effort}` : ""}
                    </span>
                  )}
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
                  {/* Copiar el mensaje, el tuyo o el suyo. Va dentro de la
                      burbuja y alineado a la derecha, como en Claude. */}
                  <div className="mt-1.5 flex justify-end">
                    <BotonCopiar texto={t.text} />
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
            {/* Micrófono a la vista, en la parte de abajo del chat: era la
                única forma de encender o apagar la escucha sin adivinar
                (pedido el 2026-09-21). */}
            <BotonMicrofono micOn={mic} voz={voiceState} onError={(m) => avisar(m, "error")} />
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
