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
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { BotonMicrofono } from "./BotonMicrofono";
import { BotonCopiar } from "./BotonCopiar";
import { useHistorialEnviados } from "../../lib/useHistorialEnviados";
import { useVoice } from "./HudFrame";
import { Markdown, artefactosDe, type ArtefactoRef } from "./Markdown";
import { PanelLateral, type PanelId } from "./PanelLateral";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ThreadSidebar, type Coincidencia, type ThreadMeta } from "./ThreadSidebar";
import { HudSelect, opcionDeModelo } from "./HudSelect";
// El catalogo de modelos tiene UN tipo, en terminalCore.ts. Importado como
// tipo: no arrastra el xterm de ese modulo a esta pantalla.
import type { Catalogo, ModeloInfo } from "./terminalCore";
import { publicarAccionesChat } from "../../lib/accionesChat";
import { ACCIONES_CHAT, decidirEscape, type AccionChat } from "./chatAcciones";
import {
  COMMANDS,
  ESFUERZOS,
  helpText,
  parseEsfuerzo,
  parseLine,
  parseProvider,
  suggestFor,
  scrollParaVer,
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
  /** Lo que costó el turno, según lo que dé cada proveedor (`maria/cli.rs`).
   *  Vacío = no lo da: se escribe «sin dato», nunca una cifra inventada.
   *  Claude da tokens y coste; Codex y el modelo local solo tokens; agy, nada.
   *  El tiempo lo mide mar.ia, así que lo hay siempre. */
  tokens_in?: number | null;
  tokens_out?: number | null;
  coste_usd?: number | null;
  ms?: number | null;
  /** Punto de control tomado ANTES de que el proveedor corriera (`maria/puntos.rs`),
   *  guardado en el turno del asistente. Vacío cuando la conversación no tiene
   *  proyecto, el árbol era demasiado grande o la foto falló: entonces no hay
   *  «volver» que ofrecer, y no se ofrece. */
  punto?: string | null;
  /** Modelo concreto que contestó, cuando el proveedor lo dice. Con el alias
   *  `opus` la etiqueta «opus» no decía qué Opus era (2026-09-23). */
  modelo_real?: string | null;
};

/** Un punto de control, tal y como lo sirve `maria_puntos_listar`. */
type Punto = { sha: string; ts: string; etiqueta: string };

/** Lo que devuelve `maria_punto_volver`. `antes` es el punto que se toma justo
 *  antes de restaurar: volver también se deshace. */
type Restaurado = {
  ficheros: number;
  antes: string;
  turnos: number;
  /** Repositorios anidados que la foto NO cubre: lo que un agente tocara ahí
   *  no vuelve. Opcional para no romper con un backend anterior. */
  anidados?: string[];
};

/** Qué se devuelve al punto. Mismos nombres que espera el comando Tauri. */
type ModoVuelta = "codigo" | "conversacion" | "todo";

/** Diálogo de «volver a antes de esta respuesta» abierto ahora mismo. */
type Vuelta = {
  sha: string;
  /**
   * Turnos que quedarían si se trunca la conversación, igual que en «editar»:
   * el índice del mensaje TUYO que provocó la respuesta. null = esta vuelta no
   * puede tocar la conversación (un encargo, o el atajo), así que ahí solo se
   * ofrece el código en vez de fingir una opción que no haría nada.
   */
  conservar: number | null;
  /** De dónde salió, para que el diálogo diga a qué se vuelve. */
  desde: string;
};

/** 8120 -> "8,1k". Los turnos son de miles de tokens: el número entero es ruido. */
function miles(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1).replace(".", ",")}k`;
}

/** La línea discreta de consumo de un turno, o null si no hay NADA que decir.
 *  Exportada para poder probar la regla del «sin dato» sin montar el chat. */
export function consumoDe(t: Turn): string | null {
  const partes: string[] = [];
  if (typeof t.ms === "number") {
    partes.push(t.ms < 1000 ? `${t.ms} ms` : `${(t.ms / 1000).toFixed(1).replace(".", ",")} s`);
  }
  if (typeof t.tokens_in === "number" || typeof t.tokens_out === "number") {
    const ent = typeof t.tokens_in === "number" ? miles(t.tokens_in) : "?";
    const sal = typeof t.tokens_out === "number" ? miles(t.tokens_out) : "?";
    partes.push(`${ent}↑/${sal}↓`);
  } else {
    partes.push("tokens: sin dato");
  }
  if (typeof t.coste_usd === "number") {
    partes.push(`~${t.coste_usd.toFixed(4).replace(".", ",")} $`);
  }
  return partes.length > 0 ? partes.join(" · ") : null;
}

/** Fichero adjunto ya guardado en disco: lo que viaja al relevo es la ruta. */
type Adjunto = { nombre: string; ruta: string };

/** Lo que emite el relevo mientras un proveedor escribe (`maria/flujo.rs`). */
type Trozo = { thread_id: string; provider: string; texto: string; reinicia: boolean };

/** Bytes -> base64 por bloques: `btoa(String.fromCharCode(...todo))` revienta
 *  la pila con ficheros de pocos MB. */
function aBase64(bytes: Uint8Array): string {
  let bin = "";
  const BLOQUE = 0x8000;
  for (let i = 0; i < bytes.length; i += BLOQUE) {
    bin += String.fromCharCode(...bytes.subarray(i, i + BLOQUE));
  }
  return btoa(bin);
}

/** Fecha corta ("22/09") de una marca RFC 3339, o "" si no hay o no se
 *  entiende. Se usa para decir CUANDO se supo que un modelo estaba vetado:
 *  «no lo permite tu cuenta» sin fecha no deja saber si el dato es de hoy o
 *  de hace un mes. */
function fechaCorta(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Como se controla el esfuerzo en cada proveedor. Se enseña tal cual para no
 *  fingir un mando que esa CLI no tiene. */
const EFFORT_MODE_LABEL: Record<string, string> = {
  Bandera: "control real",
  EnElPrompt: "se pide en el mensaje",
  Razonamiento: "razonar sí/no",
  SinControl: "sin control",
};

/** `accion` = qué puede hacer el usuario. La compone Rust (`relay::consejo`)
 *  para que el chat, el móvil y el log digan exactamente lo mismo. */
type SkipReason = { provider: string; kind: string; detail: string; accion?: string };

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
  /** Algo que el usuario debe saber de este turno aunque haya ido bien: hoy,
   *  que se ha contestado SIN punto de control y por qué (`puntos::del_turno`). */
  aviso?: string | null;
  /** Punto de control tomado antes de este turno (el mismo `Turn.punto`). */
  punto?: string | null;
  /** Modelo concreto que contestó ("claude-opus-5-5" para el alias `opus`). */
  modelo_real?: string | null;
  /** Consumo y tiempo del turno, lo mismo que queda en el hilo (`maria/relay.rs`). */
  tokens_in?: number | null;
  tokens_out?: number | null;
  coste_usd?: number | null;
  ms?: number | null;
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
  enfriando: "sin cuota, en espera",
  // El relevo cambiaba de modelo EN SILENCIO cuando el pedido no valía para
  // ese proveedor (relay.rs). Desde el 2026-09-22 deja este rastro, así que
  // aquí tiene que tener nombre: sin entrada, se leería «claude · modelo».
  modelo: "modelo no permitido",
};

/** Trabajo en paralelo de un proveedor para esta conversacion (`maria/encargos.rs`). */
type Encargo = {
  id: string;
  thread_id: string;
  provider: string;
  texto: string;
  estado: "en_curso" | "hecho" | "error" | "parado" | "interrumpido";
  creado: string;
  fin: string;
  resumen: string;
  /** Punto de control tomado antes de lanzarlo, si la conversación tenía
   *  proyecto (`maria/encargos.rs`). Vacío = no hay nada que deshacer. */
  punto?: string | null;
  /**
   * Por qué el encargo ha arrancado SIN punto de control (`puntos::del_turno`
   * devuelve el sha y el aviso por separado, y `encargos.rs` propaga los dos
   * desde el 2026-09-22).
   *
   * Opcional porque los `encargos.json` escritos antes de hoy no lo traen —
   * igual que en Rust, donde el campo es `Option<String>` con `serde(default)`.
   * Un agente suelto, sin supervisión y con acceso total a la carpeta, es el
   * caso en que MÁS hace falta saberlo, así que no se descarta como antes.
   */
  aviso?: string | null;
};

const ESTADO_ENCARGO: Record<Encargo["estado"], string> = {
  en_curso: "en curso",
  hecho: "hecho",
  error: "falló",
  parado: "parado",
  // Se cerró mar.ia mientras corría: el proceso murió con la app.
  interrumpido: "interrumpido",
};

/** Consumo real de un proveedor en su ventana móvil (`maria/quota.rs`).
 *  `pct` es null mientras no se haya medido el tope: entonces se dice, no se
 *  pinta un porcentaje inventado. */
type VentanaCuota = {
  provider: string;
  window_hours: number;
  tokens: number;
  pct: number | null;
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
  /** Consumo de Claude en su ventana móvil (`maria_quota_windows`, de quota.rs). */
  const [cuotaClaude, setCuotaClaude] = useState<VentanaCuota | null>(null);
  const [query, setQuery] = useState("");
  /** El menú de comandos se ha cerrado a mano (Escape) sin borrar lo escrito.
   *  Se vuelve a abrir en cuanto se toca la caja: ver el efecto de `prompt`. */
  const [menuCerrado, setMenuCerrado] = useState(false);
  /** Aciertos dentro del cuerpo de las conversaciones (`maria_threads_buscar`). */
  const [coincidencias, setCoincidencias] = useState<Coincidencia[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [hayMasAciertos, setHayMasAciertos] = useState(false);
  /** Turno al que hay que bajar en cuanto cargue el hilo. null = a ninguno. */
  const [irATurno, setIrATurno] = useState<number | null>(null);
  const [sugerido, setSugerido] = useState(0);
  /** Un nodo por sugerencia, para llevar la marcada a la vista. */
  const sugerenciaRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listaSugerenciasRef = useRef<HTMLUListElement | null>(null);
  /** Respuesta que se esta escribiendo ahora mismo (eventos del relevo). */
  const [enVivo, setEnVivo] = useState<{ provider: string; texto: string } | null>(null);
  /** Ficheros que acompañaran al proximo mensaje. */
  const [adjuntos, setAdjuntos] = useState<Adjunto[]>([]);
  const [arrastrando, setArrastrando] = useState(false);
  /** Ficheros que se estan guardando ahora mismo (arrastre o pegado). */
  const [adjuntando, setAdjuntando] = useState(0);
  /** Lo que el agente esta haciendo AHORA (herramienta, orden). No es respuesta. */
  const [actividad, setActividad] = useState<string | null>(null);
  /** Lo que se ve funcionando en el panel de la derecha. */
  const [artefacto, setArtefactoRaw] = useState<ArtefactoRef | null>(null);
  /** Pestaña abierta del panel lateral. null = cerrado. */
  const [panel, setPanel] = useState<PanelId | null>(null);
  /** Sube cuando un agente termina: cambios y ficheros se releen solos. */
  const [refresco, setRefresco] = useState(0);
  /** Proyectos registrados, para el selector de la cabecera. */
  const [proyectos, setProyectos] = useState<Array<{ name: string; path: string }>>([]);
  const setArtefacto = useCallback((a: ArtefactoRef | null) => {
    setArtefactoRaw(a);
    setPanel((p) => (a ? "artefacto" : p === "artefacto" ? null : p));
  }, []);
  /** Encargos en paralelo de esta conversacion, y lo ultimo que dice cada uno. */
  const [encargos, setEncargos] = useState<Encargo[]>([]);
  const [vivoEncargo, setVivoEncargo] = useState<Record<string, string>>({});
  /** Si no es null, el proximo envio REESCRIBE el hilo desde ese turno. */
  const [editando, setEditando] = useState<number | null>(null);
  /** Vuelta a un punto de control pendiente de confirmar. null = sin diálogo.
   *  Devolver el árbol de trabajo borra lo que el agente escribió después, así
   *  que no se hace de un clic (2026-09-22). */
  const [vuelta, setVuelta] = useState<Vuelta | null>(null);
  /** true mientras el backend restaura: el diálogo no se puede pulsar dos veces. */
  const [volviendo, setVolviendo] = useState(false);
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Un nodo por turno pintado, para poder saltar a uno concreto. */
  const turnoRefs = useRef<Array<HTMLElement | null>>([]);

  const sugerencias = menuCerrado ? [] : suggestFor(prompt);
  const activa = useMemo(
    () => threads.find((t) => t.id === threadId) ?? null,
    [threads, threadId],
  );

  /** Ficha del proveedor en el catalogo: de ahi salen sus modelos, su nota y
   *  el plan detectado de la suscripcion. */
  const fichaDe = useCallback(
    (p: string | null) => (p ? catalogo?.providers.find((c) => c.provider === p) : undefined),
    [catalogo],
  );

  /** Nombre humano de un modelo concreto ("claude-opus-5-5" -> "Opus 5.5"),
   *  sacado del catálogo; si no está, el id sin la fecha de versión, y si
   *  tampoco, el id tal cual. Nunca se inventa. */
  const nombreDeModelo = useCallback(
    (provider: string, id: string) => {
      const ms = fichaDe(provider)?.models ?? [];
      const sinFecha = id.replace(/-\d{8}$/, "");
      return (
        ms.find((m) => m.id === id)?.label ?? ms.find((m) => m.id === sinFecha)?.label ?? sinFecha
      );
    },
    [fichaDe],
  );

  /** Modelos del proveedor fijado. Sin proveedor fijado no se ofrece ninguno:
   *  un modelo sin saber de quien es no se puede mandar a nadie. */
  const modelosDe = useCallback(
    (p: string | null): ModeloInfo[] => fichaDe(p)?.models ?? [],
    [fichaDe],
  );

  const modoEsfuerzoDe = useCallback(
    (p: string): string => fichaDe(p)?.effort_mode ?? "",
    [fichaDe],
  );

  const avisar = useCallback((text: string, tono: Aviso["tono"] = "info") => {
    setAvisos((prev) => [...prev.slice(-4), { ts: Date.now(), text, tono }]);
  }, []);

  // La respuesta, segun se escribe. Un `reinicia` llega al cambiar de
  // proveedor: lo que hubiera a medias era de uno que no termino.
  useEffect(() => {
    const p = listen<Trozo>("maria://relay-trozo", (ev) => {
      const t = ev.payload;
      if (!t) return;
      // `hilo#encargo`: es un trabajo en paralelo, no la respuesta del chat.
      const [hilo, encargo] = t.thread_id.split("#");
      if (hilo !== threadIdRef.current) return;
      if (encargo) {
        setVivoEncargo((prev) => ({
          ...prev,
          [encargo]: ((t.reinicia ? "" : (prev[encargo] ?? "")) + t.texto).slice(-160),
        }));
        return;
      }
      setActividad(null);
      setEnVivo((prev) =>
        t.reinicia || !prev || prev.provider !== t.provider
          ? { provider: t.provider, texto: t.reinicia ? "" : t.texto }
          : { provider: prev.provider, texto: prev.texto + t.texto },
      );
    });
    const a = listen<{ thread_id: string; provider: string; texto: string }>(
      "maria://relay-actividad",
      (ev) => {
        const [hilo, encargo] = (ev.payload?.thread_id ?? "").split("#");
        if (hilo !== threadIdRef.current) return;
        if (encargo) {
          setVivoEncargo((prev) => ({ ...prev, [encargo]: ev.payload.texto }));
        } else {
          setActividad(`${ev.payload.provider} · ${ev.payload.texto}`);
        }
      },
    );
    const e = listen<Encargo>("maria://encargo", (ev) => {
      const en = ev.payload;
      if (!en || en.thread_id !== threadIdRef.current) return;
      setEncargos((prev) => [...prev.filter((x) => x.id !== en.id), en]);
      if (en.estado !== "en_curso") {
        setRefresco((n) => n + 1);
        // El resultado ya esta en el hilo: se relee para que aparezca.
        void invoke<Turn[]>("maria_relay_thread", { threadId: en.thread_id })
          .then((ts) => setTurns(ts ?? []))
          .catch(() => undefined);
      }
    });
    return () => {
      void p.then((off) => off());
      void a.then((off) => off());
      void e.then((off) => off());
    };
  }, []);

  useEffect(() => {
    void invoke<Array<{ name?: string; id: string; path: string }>>("list_projects")
      .then((l) =>
        setProyectos((l ?? []).map((p) => ({ name: p.name || p.id, path: p.path }))),
      )
      .catch(() => setProyectos([]));
  }, []);

  // Cuota de Claude, aquí y no solo en la pantalla de inicio: esta es la
  // pantalla donde se gasta. Cada 30 s, que es de sobra para un contador que
  // solo se mueve al terminar un turno.
  useEffect(() => {
    let vivo = true;
    const pedir = () => {
      void invoke<VentanaCuota[]>("maria_quota_windows")
        .then((v) => vivo && setCuotaClaude(v?.find((w) => w.provider === "claude") ?? null))
        .catch(() => vivo && setCuotaClaude(null));
    };
    pedir();
    const id = setInterval(pedir, 30_000);
    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, []);

  // Al cambiar de conversacion: sus encargos, y nada de la anterior a la vista.
  useEffect(() => {
    setArtefacto(null);
    setPanel(null);
    setEditando(null);
    setVuelta(null);
    setVivoEncargo({});
    if (!threadId) return;
    void invoke<Encargo[]>("maria_encargos", { threadId })
      .then((l) => setEncargos(l ?? []))
      .catch(() => setEncargos([]));
  }, [threadId]);

  /** Guarda en disco lo soltado o pegado y lo apunta como adjunto. */
  const adjuntarFicheros = useCallback(
    async (files: File[]) => {
      const hilo = threadIdRef.current;
      if (!hilo || files.length === 0) return;
      setAdjuntando((n) => n + files.length);
      for (const f of files) {
        try {
          const datos = aBase64(new Uint8Array(await f.arrayBuffer()));
          const ruta = await invoke<string>("maria_adjunto_guardar", {
            threadId: hilo,
            nombre: f.name || "pegado.png",
            datosBase64: datos,
          });
          setAdjuntos((prev) => [...prev, { nombre: f.name || "pegado.png", ruta }]);
        } catch (e) {
          avisar(`no pude adjuntar ${f.name}: ${String(e)}`, "error");
        } finally {
          setAdjuntando((n) => Math.max(0, n - 1));
        }
      }
    },
    [avisar],
  );

  /** El clip: elegir con el dialogo de Windows. Trae ruta, no hay que copiar. */
  const elegirFicheros = useCallback(async () => {
    const sel = await openDialog({ multiple: true, title: "Adjuntar al mensaje" }).catch(
      () => null,
    );
    const rutas = Array.isArray(sel) ? sel : sel ? [sel] : [];
    setAdjuntos((prev) => [
      ...prev,
      ...rutas.map((ruta) => ({ nombre: ruta.split(/[\\/]/).pop() || ruta, ruta })),
    ]);
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
    // Se vacian ANTES de pedir el hilo nuevo: la carga es asincrona y, con un
    // salto a un turno pendiente (resultado de busqueda en OTRA conversacion),
    // el render intermedio encontraba el <article> viejo del hilo anterior,
    // centraba ese y daba el salto por hecho (2026-09-22).
    setTurns([]);
    turnoRefs.current = [];
    void invoke<Turn[]>("maria_relay_thread", { threadId })
      .then((t) => setTurns(Array.isArray(t) ? t : []))
      .catch((e) => avisar(String(e), "error"));
    setLastSkips([]);
    setLastChoice(null);
  }, [threadId, avisar]);

  useEffect(() => {
    // Con un salto a un turno pendiente NO se baja al final: seria llevarse la
    // vista justo del sitio al que el usuario acaba de pedir ir.
    if (irATurno !== null) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns, busy, avisos, irATurno]);

  // Buscar DENTRO de las conversaciones. Con rebote de 250 ms porque cada
  // pulsacion abriria si no todos los jsonl de la carpeta; el backend ademas
  // trae tope de resultados y de bytes por hilo (`threads::buscar_en`).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setCoincidencias([]);
      setHayMasAciertos(false);
      setBuscando(false);
      return;
    }
    setBuscando(true);
    let vigente = true;
    const t = setTimeout(() => {
      void invoke<{ resultados: Coincidencia[]; hay_mas: boolean; recortados: string[] }>(
        "maria_threads_buscar",
        { consulta: q, tope: 40 },
      )
        .then((b) => {
          if (!vigente) return;
          setCoincidencias(b?.resultados ?? []);
          setHayMasAciertos(Boolean(b?.hay_mas));
          if (b?.recortados?.length) {
            avisar(
              `conversaciones demasiado grandes, buscadas solo en parte: ${b.recortados.join(", ")}`,
            );
          }
        })
        .catch(() => {
          if (vigente) setCoincidencias([]);
        })
        .finally(() => {
          if (vigente) setBuscando(false);
        });
    }, 250);
    return () => {
      vigente = false;
      clearTimeout(t);
    };
  }, [query, avisar]);

  // El salto al turno se hace cuando el hilo YA esta pintado: al venir de otra
  // conversacion, `turns` todavia es el de la anterior.
  useEffect(() => {
    if (irATurno === null) return;
    const nodo = turnoRefs.current[irATurno];
    if (!nodo) {
      // El hilo aun no ha llegado (o ese turno no existe ya): se espera al
      // siguiente cambio de `turns`, y si tampoco, se suelta el salto.
      if (turns.length > 0 && irATurno >= turns.length) setIrATurno(null);
      return;
    }
    nodo.scrollIntoView({ block: "center" });
    setIrATurno(null);
  }, [irATurno, turns]);

  useEffect(() => {
    setSugerido(0);
    setMenuCerrado(false);
  }, [prompt]);

  // Con «/» a secas salen TODOS los comandos (24): la lista tiene alto máximo
  // y scroll, y la marcada se trae a la vista al moverse con las flechas. Sin
  // esto la lista crecía hacia arriba por encima del chat, la primera opción
  // quedaba fuera del recorte y las flechas movían una marca invisible
  // (2026-09-23). Se desplaza SOLO la lista: `scrollIntoView` movía también el
  // chat entero hacia arriba.
  useEffect(() => {
    const lista = listaSugerenciasRef.current;
    const el = sugerenciaRefs.current[sugerido];
    if (!lista || !el) return;
    const nuevo = scrollParaVer(el.offsetTop, el.offsetHeight, lista.scrollTop, lista.clientHeight);
    if (nuevo !== null) lista.scrollTop = nuevo;
  }, [sugerido]);

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
        // El modelo existe pero la cuenta lo rechaza: decir eso y CUÁNDO se
        // supo. Antes se contestaba «no está en claude», que es mentira —
        // está, lo que no hay es suscripción que lo alcance (2026-09-22).
        if (elegido.permitido === "no") {
          const cuando = fechaCorta(elegido.visto);
          avisar(
            `«${elegido.id}» no lo permite tu cuenta de ${forzado}` +
              `${cuando ? ` (se supo el ${cuando})` : ""}` +
              `${elegido.motivo ? `: ${elegido.motivo}` : ""}` +
              "\n/modelos vuelve a preguntárselo al proveedor",
            "error",
          );
          return;
        }
        setModeloFijo(elegido.id);
        avisar(`modelo fijado a ${elegido.id}`);
        return;
      }
      case "/modelos": {
        // Los ids caducan y los planes cambian: esto vuelve a mirar lo que la
        // suscripción permite HOY en vez de creerse la lista de arranque.
        avisar("preguntando a cada proveedor qué modelos permite tu suscripción…");
        const nuevo = await invoke<Catalogo>("maria_models_refrescar").catch((e) => {
          avisar(String(e), "error");
          return null;
        });
        if (!nuevo) return;
        setCatalogo(nuevo);
        const cuenta = (nuevo.providers ?? [])
          .map((p, i) => `${p.models.length}${i === 0 ? " modelos" : ""} en ${p.provider}`)
          .join(", ");
        const planes = (nuevo.providers ?? [])
          .filter((p) => p.plan)
          .map((p) => `${p.provider}: ${p.plan}`)
          .join(", ");
        avisar(
          `catálogo actualizado: ${cuenta || "ningún proveedor"}` +
            (planes ? `\nplanes: ${planes}` : ""),
        );
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
      case "/delegar":
        await delegar(arg);
        return;
      case "/ramas":
        await verRamas();
        return;
      case "/rama":
        await volverARama(arg);
        return;
      case "/deshacer":
        deshacerUltimo();
        return;
      case "/puntos":
        await verPuntos();
        return;
      case "/proyecto":
        await fijarProyecto(arg.trim());
        return;
      case "/exportar":
        await exportar();
        return;
      case "/cambios":
        setPanel("cambios");
        return;
      case "/web":
        if (arg.trim()) localStorage.setItem("maria.panel.web.url", arg.trim());
        setPanel("web");
        return;
      case "/ficheros":
        setPanel("ficheros");
        return;
      case "/regenerar":
        await regenerar();
        return;
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
    setEnVivo(null);
    setActividad(null);
    const enviados = adjuntos;
    setAdjuntos([]);
    // Editar un mensaje: el hilo se corta ahi y sigue por el texto nuevo.
    let base = turns;
    if (editando !== null) {
      try {
        await invoke("maria_relay_truncar", { threadId, conservar: editando });
        base = turns.slice(0, editando);
        setTurns(base);
      } catch (e) {
        avisar(`no pude reescribir la conversación: ${String(e)}`, "error");
        setBusy(false);
        return;
      }
      setEditando(null);
    }
    const eraVacia = base.length === 0;
    // Optimista: el turno del usuario se ve al instante; el backend lo
    // persiste igualmente, asi que al recargar el hilo no se duplica.
    setTurns((prev) => [
      ...prev,
      {
        ts: new Date().toISOString(),
        role: "user",
        provider: "",
        text: enviados.length
          ? `${texto}\n\n_adjuntos: ${enviados.map((a) => a.nombre).join(", ")}_`
          : texto,
      },
    ]);
    try {
      const ans = await invoke<RelayAnswer>("maria_relay_ask", {
        threadId,
        prompt: texto,
        provider: forzado,
        model: modeloFijo,
        effort: esfuerzoFijo,
        adjuntos: enviados.map((a) => a.ruta),
      });
      setLastSkips(ans.skipped ?? []);
      setLastChoice(ans.chosen_by_local ?? null);
      setUltimo({
        model: ans.modelo_real ? nombreDeModelo(ans.provider, ans.modelo_real) : (ans.model ?? ""),
        effort: ans.effort ?? "",
      });
      // Un turno sin foto del proyecto no es un fallo, pero hay que saberlo
      // antes de fiarse de «volver a antes de esta respuesta» (2026-09-22).
      if (ans.aviso) avisar(ans.aviso, "error");
      setTurns((prev) => [
        ...prev,
        {
          ts: new Date().toISOString(),
          role: "assistant",
          provider: ans.provider,
          model: ans.model,
          effort: ans.effort,
          text: ans.text,
          // Sin esto la línea de consumo decía «sin dato» hasta reabrir el
          // hilo, aunque el fichero ya tuviera la cifra (2026-09-22).
          tokens_in: ans.tokens_in ?? null,
          tokens_out: ans.tokens_out ?? null,
          coste_usd: ans.coste_usd ?? null,
          ms: ans.ms ?? null,
          // Y el punto de control: sin él, «volver a antes de esta
          // respuesta» solo salía al reabrir la conversación (2026-09-22).
          punto: ans.punto ?? null,
          modelo_real: ans.modelo_real ?? null,
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
      // Parar antes de que llegue una sola palabra no es un error.
      if (String(e).includes("parado")) avisar("parado");
      else avisar(String(e), "error");
    } finally {
      setEnVivo(null);
      setActividad(null);
      setBusy(false);
      setRefresco((n) => n + 1);
    }
  }

  /** Vuelve a pedir la ultima respuesta: corta el hilo en el ultimo mensaje
   *  tuyo y lo manda otra vez. */
  async function regenerar() {
    if (busy) return;
    const i = turns.map((t) => t.role).lastIndexOf("user");
    if (i < 0) {
      avisar("no hay nada que regenerar");
      return;
    }
    const texto = turns[i].text.replace(/\n\n_adjuntos: [^\n]*_$/, "");
    try {
      await invoke("maria_relay_truncar", { threadId, conservar: i });
    } catch (e) {
      avisar(`no pude regenerar: ${String(e)}`, "error");
      return;
    }
    setTurns(turns.slice(0, i));
    await enviarMensaje(texto);
  }

  // ---------------------------------------------------------------------------
  // Puntos de control
  // ---------------------------------------------------------------------------

  /**
   * Turnos que hay que conservar para dejar la conversación justo ANTES del
   * mensaje tuyo que provocó la respuesta del turno `i`. Es el mismo número
   * que usa «editar» (`maria_relay_truncar`, `conservar`).
   *
   * Sin mensaje tuyo delante (un hilo que empieza por un resultado de encargo)
   * se corta en el propio turno: así se quita la respuesta y no se toca nada
   * anterior, en vez de vaciar el hilo entero por no encontrar el ancla.
   */
  function conservarPara(i: number): number {
    const u = turns
      .slice(0, i)
      .map((t) => t.role)
      .lastIndexOf("user");
    return u >= 0 ? u : i;
  }

  /** Abre el diálogo de confirmación. No toca nada por sí solo. */
  function pedirVuelta(v: Vuelta) {
    setVuelta(v);
  }

  /**
   * El atajo y `/deshacer`: el último punto que haya, solo el código.
   *
   * Sin ningún punto lo DICE. Un atajo que no encuentra a qué volver y se
   * queda callado deja al usuario creyendo que ha deshecho algo.
   *
   * Con una respuesta en curso NO se deshace (2026-09-22). El botón de cada
   * turno ya estaba condicionado a `!busy` y `regenerar()` también, pero esta
   * función se publica tal cual como `chat.deshacer`, así que el atajo y la
   * paleta entraban sin guarda: `read-tree -u --reset` sobre la carpeta
   * MIENTRAS la CLI escribe en ella deja el árbol mezclado (parte restaurada,
   * parte escrita después por el agente en vuelo). Y encima el punto que se
   * encuentra es el de la respuesta ANTERIOR, porque el turno en curso todavía
   * no está en `turns`. Se avisa en vez de callar: un atajo mudo deja al
   * usuario creyendo que ha deshecho algo.
   */
  function deshacerUltimo() {
    if (busy) {
      avisar(
        "hay una respuesta en curso: párala (Escape) antes de volver a un punto de control",
        "error",
      );
      return;
    }
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role !== "user" && t.punto) {
        pedirVuelta({
          sha: t.punto,
          conservar: null,
          desde: `la respuesta de ${PROVIDER_LABEL[t.provider] ?? t.provider ?? "mar.ia"} de las ${new Date(
            t.ts,
          ).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`,
        });
        return;
      }
    }
    avisar(
      "no hay ningún punto de control al que volver: se toman antes de cada respuesta y solo si la conversación tiene proyecto (/proyecto <ruta>)",
      "error",
    );
  }

  /** Lista los puntos de control de esta conversación. */
  async function verPuntos() {
    const lista = await invoke<Punto[]>("maria_puntos_listar", { threadId }).catch((e) => {
      avisar(String(e), "error");
      return null;
    });
    if (!lista) return;
    if (lista.length === 0) {
      avisar(
        "esta conversación no tiene puntos de control: se toman antes de cada respuesta y solo si hay proyecto (/proyecto <ruta>)",
      );
      return;
    }
    avisar(
      lista
        .map((p) => {
          const cuando = p.ts ? new Date(p.ts).toLocaleString("es-ES") : "—";
          return `${p.sha.slice(0, 8)} · ${cuando}${p.etiqueta ? ` · ${p.etiqueta}` : ""}`;
        })
        .join("\n") +
        "\n\nse vuelve desde la respuesta («volver a antes de esta respuesta») o con /deshacer",
    );
  }

  /** Ejecuta la vuelta ya confirmada. */
  async function volverAlPunto(v: Vuelta, modo: ModoVuelta) {
    setVolviendo(true);
    try {
      const r = await invoke<Restaurado>("maria_punto_volver", {
        threadId,
        sha: v.sha,
        modo,
        // Solo viaja cuando el modo puede tocar la conversación y se sabe
        // dónde cortar: mandar un número al azar borraría turnos de más.
        conservar: modo === "codigo" ? null : v.conservar,
      });
      setVuelta(null);
      if (modo !== "codigo") {
        // El hilo se ha acortado en disco: se relee, no se adivina.
        setTurns((await invoke<Turn[]>("maria_relay_thread", { threadId })) ?? []);
      }
      const partes: string[] = [];
      if (modo !== "conversacion") {
        partes.push(
          r.ficheros === 1 ? "1 fichero restaurado" : `${r.ficheros} ficheros restaurados`,
        );
      }
      if (modo !== "conversacion" && r.anidados && r.anidados.length > 0) {
        // Decirlo aquí, junto a «N ficheros restaurados», porque el diálogo
        // promete que volver borra lo escrito después: dentro de un repositorio
        // anidado no es verdad (2026-09-22).
        partes.push(`sin tocar ${r.anidados.join(", ")} (repositorios aparte)`);
      }
      if (modo !== "codigo") {
        // `turnos` son los que QUEDAN, no los que se han quitado (así lo
        // devuelve `relay::truncar`). Decir «quitados» sería una cifra que no
        // es (2026-09-22).
        partes.push(
          r.turnos === 1
            ? "la conversación queda en 1 turno"
            : `la conversación queda en ${r.turnos} turnos`,
        );
      }
      avisar(
        partes.join(" · ") +
          // En modo «conversación» no se fotografía nada, así que `antes` viene
          // vacío: prometer un punto que no existe sería mentir.
          (r.antes
            ? `; esto también se deshace: el punto de antes es ${r.antes.slice(0, 8)} (/puntos)`
            : "; lo que se ha quitado queda como rama (/ramas)"),
      );
      setRefresco((n) => n + 1);
    } catch (e) {
      avisar(String(e), "error");
    } finally {
      setVolviendo(false);
    }
  }

  async function fijarProyecto(ruta: string) {
    try {
      await invoke("maria_thread_project", { threadId, ruta });
      await recargarLista();
      setRefresco((n) => n + 1);
      avisar(
        ruta
          ? `esta conversación trabaja ahora sobre ${ruta}: los agentes arrancan ahí y «cambios» enseña su diff`
          : "conversación sin proyecto",
      );
    } catch (e) {
      avisar(String(e), "error");
    }
  }

  async function exportar() {
    if (turns.length === 0) {
      avisar("la conversación está vacía");
      return;
    }
    const titulo = activa?.title || "conversacion";
    const destino = await saveDialog({
      title: "Exportar la conversación",
      defaultPath: `${titulo.replace(/[\\/:*?"<>|]+/g, " ").trim() || "conversacion"}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    }).catch(() => null);
    if (!destino) return;
    try {
      const ruta = await invoke<string>("maria_relay_exportar", { threadId, titulo, destino });
      avisar(`exportada a ${ruta}`);
      void revealItemInDir(ruta).catch(() => undefined);
    } catch (e) {
      avisar(String(e), "error");
    }
  }

  async function verRamas() {
    const ramas = await invoke<Array<{ ts: string; desde: number; turnos: Turn[] }>>(
      "maria_relay_ramas",
      { threadId },
    ).catch(() => []);
    if (ramas.length === 0) {
      avisar("no hay ramas: aparecen al editar un mensaje o regenerar una respuesta");
      return;
    }
    avisar(
      ramas
        .map((r, i) => {
          const primero = r.turnos[0]?.text.replace(/\s+/g, " ").slice(0, 70) ?? "";
          return `${i + 1}. ${new Date(r.ts).toLocaleString("es-ES")} · ${r.turnos.length} turnos desde el ${r.desde + 1} · ${primero}`;
        })
        .join("\n") + "\n\n/rama <número> para volver a una",
    );
  }

  async function volverARama(arg: string) {
    const n = Number.parseInt(arg, 10);
    if (!Number.isFinite(n) || n < 1) {
      avisar("uso: /rama <número> (míralos con /ramas)", "error");
      return;
    }
    try {
      await invoke("maria_relay_rama_restaurar", { threadId, indice: n - 1 });
      setTurns((await invoke<Turn[]>("maria_relay_thread", { threadId })) ?? []);
      avisar("rama restaurada; la que tenías ha quedado guardada como rama");
    } catch (e) {
      avisar(String(e), "error");
    }
  }

  async function delegar(arg: string) {
    const [prov, ...resto] = arg.trim().split(/\s+/);
    const texto = resto.join(" ").trim();
    const p = parseProvider(prov ?? "");
    if (!p || !texto) {
      avisar("uso: /delegar <claude|codex|antigravity|local> <encargo>", "error");
      return;
    }
    try {
      const en = await invoke<Encargo>("maria_encargo_lanzar", { threadId, provider: p, texto });
      setEncargos((prev) => [...prev.filter((x) => x.id !== en.id), en]);
      avisar(`encargo ${en.id} en marcha con ${p}; puedes seguir hablando`);
      // Si ha arrancado sin foto del proyecto, se dice AQUÍ y en rojo: el
      // agente ya está suelto en la carpeta y esto es lo que hay que saber
      // antes de dejarlo trabajar (2026-09-22).
      if (en.aviso) avisar(en.aviso, "error");
    } catch (e) {
      avisar(String(e), "error");
    }
  }

  /** Quita de la lista Y del disco un encargo terminado. Desde que sobreviven
   *  al cierre (`maria/encargos.rs`), borrarlo solo de la pantalla lo devolvía
   *  al reabrir la app. */
  async function olvidarEncargo(id: string) {
    try {
      await invoke("maria_encargo_olvidar", { threadId, id });
      setEncargos((prev) => prev.filter((x) => x.id !== id));
    } catch (e) {
      avisar(String(e), "error");
    }
  }

  /** Vuelve a lanzar el mismo encargo al mismo proveedor y retira el viejo. */
  async function relanzarEncargo(en: Encargo) {
    try {
      const nuevo = await invoke<Encargo>("maria_encargo_lanzar", {
        threadId,
        provider: en.provider,
        texto: en.texto,
      });
      await invoke("maria_encargo_olvidar", { threadId, id: en.id });
      setEncargos((prev) => [...prev.filter((x) => x.id !== en.id), nuevo]);
      avisar(`encargo ${nuevo.id} relanzado con ${en.provider}`);
      // Relanzar es soltar al agente otra vez: la foto puede fallar ahora
      // aunque la primera vez saliera (2026-09-22).
      if (nuevo.aviso) avisar(nuevo.aviso, "error");
    } catch (e) {
      avisar(String(e), "error");
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
    }
    // Escape NO se trata aquí: es una acción de la lista de abajo, para que la
    // precedencia esté escrita en un sitio y no dependa del orden de los `if`.
    // En un panel del mosaico no hay quien la ejecute, así que ahí sí.
    else if (e.key === "Escape" && compacto) {
      accionEscape();
    }
  }

  // ---------------------------------------------------------------------------
  // Teclado y paleta: UNA lista de acciones
  // ---------------------------------------------------------------------------

  /** Qué hace Escape, con la precedencia de `chatAcciones.ts::decidirEscape`. */
  function accionEscape() {
    const que = decidirEscape({
      sugerenciasAbiertas: sugerencias.length > 0,
      turnoEnCurso: busy,
    });
    // Cerrar el menú NO borra lo escrito: antes `setPrompt("")` se llevaba por
    // delante el mensaje entero (2026-09-22).
    if (que === "cerrar-sugerencias") setMenuCerrado(true);
    else if (que === "parar") void invoke("maria_relay_cancel", { threadId });
  }

  /** Lo que cada acción ejecuta AHORA. Se reasigna en cada render, así que las
   *  acciones publicadas (que se registran una sola vez) nunca ven un estado
   *  viejo. */
  const manos = useRef({ run: {} as Record<string, () => void> });
  manos.current.run = {
    "chat.nueva": () => void nuevaConversacion(),
    "chat.parar": accionEscape,
    "chat.regenerar": () => void regenerar(),
    "chat.exportar": () => void exportar(),
    "chat.deshacer": deshacerUltimo,
    "chat.panel.cambios": () => setPanel((p) => (p === "cambios" ? null : "cambios")),
    "chat.panel.ficheros": () => setPanel((p) => (p === "ficheros" ? null : "ficheros")),
    "chat.panel.web": () => setPanel((p) => (p === "web" ? null : "web")),
    "chat.ramas": () => void verRamas(),
    "chat.auto": () => {
      setForzado(null);
      setModeloFijo(null);
      setEsfuerzoFijo(null);
      avisar("mar.ia vuelve a elegir proveedor, modelo y esfuerzo según lo que escribas");
    },
    "chat.delegar": () => {
      setPrompt("/delegar ");
      inputRef.current?.focus();
    },
  };

  // Publicar solo desde la pantalla de chat de verdad: en un panel del mosaico
  // (`compacto`) hay varias a la vez y no se sabría cuál manda.
  useEffect(() => {
    if (compacto) return;
    // Las etiquetas salen de `chatAcciones.ts` (ACCIONES_CHAT), que es donde
    // las lee tambien el editor de atajos: aqui solo se le pega la mano que
    // ejecuta cada una (2026-09-22).
    const lista: AccionChat[] = ACCIONES_CHAT.map((a) => ({
      ...a,
      run: () => manos.current.run[a.id]?.(),
    }));
    return publicarAccionesChat(lista);
  }, [compacto]);

  return (
    <div
      className="flex h-full min-w-0"
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          setArrastrando(true);
        }
      }}
      onDragLeave={() => setArrastrando(false)}
      onDrop={(e) => {
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        setArrastrando(false);
        void adjuntarFicheros(Array.from(e.dataTransfer.files));
      }}
      style={arrastrando ? { outline: "1px dashed var(--color-accent)", outlineOffset: -4 } : undefined}
    >
      {!compacto && !panel && (
        <ThreadSidebar
          threads={threads}
          activeId={threadId}
          query={query}
          onQuery={setQuery}
          onSelect={setThreadId}
          coincidencias={coincidencias}
          buscando={buscando}
          hayMas={hayMasAciertos}
          onAbrirTurno={(id, indice) => {
            setThreadId(id);
            setIrATurno(indice);
          }}
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="hud-label" style={{ fontSize: 12 }}>
              {activa?.title || "chat"} {activa?.closed ? "· cerrada" : ""}
            </h1>
            {/* Los paneles de la derecha, como en Claude Desktop. */}
            <div className="flex items-center gap-1.5" role="toolbar" aria-label="paneles">
              {(["cambios", "web", "ficheros"] as PanelId[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  className="cc-bloque-boton"
                  aria-pressed={panel === p}
                  style={panel === p ? { borderColor: "var(--color-accent)", color: "var(--color-text)" } : undefined}
                  onClick={() => setPanel(panel === p ? null : p)}
                >
                  {p}
                </button>
              ))}
              <button
                type="button"
                className="cc-bloque-boton"
                title="guardar la conversación en Markdown"
                onClick={() => void exportar()}
              >
                exportar
              </button>
            </div>
          </div>

          {/* Quien va a contestar y con que. Los tres selectores en "auto"
              significan que decide mar.ia; en cuanto tocas uno, manda el
              usuario y se dice explicitamente. */}
          <div className="mt-2 flex flex-wrap items-end gap-3 text-[12px]">
            <HudSelect
              etiqueta="proyecto"
              valor={activa?.project ?? ""}
              vacio="ninguno"
              ancho={190}
              titulo="carpeta sobre la que trabajan los agentes; «cambios» enseña su diff"
              opciones={[
                // Un proyecto puesto con /proyecto puede no estar entre los
                // registrados: sin esta fila el selector diria "ninguno".
                ...(activa?.project && !proyectos.some((p) => p.path === activa.project)
                  ? [
                      {
                        id: activa.project,
                        label: activa.project.split(/[\\/]/).pop() || activa.project,
                        hint: activa.project,
                      },
                    ]
                  : []),
                ...proyectos.map((p) => ({ id: p.path, label: p.name, hint: p.path })),
              ]}
              onChange={(v) => void fijarProyecto(v)}
            />
            <HudSelect
              etiqueta="proveedor"
              valor={forzado ?? ""}
              vacio="auto · decide mar.ia"
              ancho={168}
              titulo="quién contesta"
              // El plan va pegado al nombre («claude · Claude Pro»): es lo que
              // decide qué modelos hay en el desplegable de al lado, así que
              // verlo aparte no serviría de nada. Sin plan detectado no se
              // pinta nada: inventarlo sería peor que no decirlo.
              opciones={(config?.order ?? []).map((p) => {
                const plan = fichaDe(p)?.plan ?? "";
                return {
                  id: p,
                  label: plan ? `${p} · ${plan}` : p,
                  hint: PROVEEDOR_HINT[p],
                };
              })}
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
              // Los que la cuenta rechaza se siguen viendo, en gris y con el
              // motivo: así se sabe que el modelo existe y que lo que falta es
              // plan, en vez de buscarlo sin encontrarlo (2026-09-22).
              opciones={modelosDe(forzado).map(opcionDeModelo)}
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
            {/* Por qué la lista de modelos es la que es (la cuenta de ChatGPT
                gratuita solo admite los suyos, agy sirve modelos de Anthropic
                con cuota de Google…). Ya lo pintaba el panel de terminal; en
                la pantalla donde de verdad se elige modelo, no. */}
            {forzado && fichaDe(forzado)?.nota && (
              <>
                {" · "}
                <span title={fichaDe(forzado)?.plan_origen || undefined}>
                  {fichaDe(forzado)?.nota}
                </span>
              </>
            )}
            {/* Cuota de Claude en su ventana móvil. El cálculo ya existía
                (`maria_quota_windows`, de quota.rs) y lo pintaban la pantalla
                de inicio y el panel del Router — pero no la pantalla donde se
                gasta. Sin tope medido se dice, no se inventa un porcentaje. */}
            {cuotaClaude && (
              <>
                {" · claude "}
                <span
                  className="font-mono"
                  style={{
                    color:
                      cuotaClaude.pct == null
                        ? "var(--color-text-tertiary)"
                        : cuotaClaude.pct >= 90
                          ? "var(--color-danger)"
                          : cuotaClaude.pct >= 70
                            ? "var(--color-warn)"
                            : "var(--color-text-tertiary)",
                  }}
                  title={`tokens de las últimas ${cuotaClaude.window_hours} h`}
                >
                  {cuotaClaude.pct == null
                    ? "tope sin medir"
                    : `${Math.round(cuotaClaude.pct)}% de ${cuotaClaude.window_hours} h`}
                </span>
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
              <article
                key={`${t.ts}-${i}`}
                className="mb-3"
                ref={(el) => {
                  turnoRefs.current[i] = el;
                }}
              >
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
                      title={
                        t.modelo_real
                          ? `se pidió «${t.model}» y contestó ${t.modelo_real}`
                          : "modelo y esfuerzo con los que se contestó"
                      }
                    >
                      {t.modelo_real ? nombreDeModelo(t.provider, t.modelo_real) : t.model}
                      {t.effort ? ` · ${t.effort}` : ""}
                    </span>
                  )}
                  {/* Lo que costó el turno, al lado del modelo. Discreto pero
                      SIEMPRE a la vista: la queja constante contra pedir el
                      gasto a mano es justo que hay que pedirlo. */}
                  {t.role !== "user" &&
                    (() => {
                      const c = consumoDe(t);
                      return c ? (
                        <span
                          className="text-[10px]"
                          style={{
                            color: "var(--color-text-tertiary)",
                            fontFamily: "var(--font-mono)",
                          }}
                          title="tiempo, tokens y coste de este turno; «sin dato» donde el proveedor no los publica"
                        >
                          {c}
                        </span>
                      ) : null;
                    })()}
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
                  <Markdown texto={t.text} onAbrir={setArtefacto} />
                  {/* Acciones del mensaje, dentro de la burbuja y a la derecha,
                      como en Claude: editar lo tuyo, regenerar lo suyo, copiar. */}
                  <div className="mt-1.5 flex items-center justify-end gap-2">
                    {t.role === "user" && !busy && (
                      <button
                        type="button"
                        className="cc-bloque-boton"
                        title="cambiar este mensaje: la conversación sigue desde aquí"
                        onClick={() => {
                          setEditando(i);
                          setPrompt(t.text.replace(/\n\n_adjuntos: [^\n]*_$/, ""));
                          inputRef.current?.focus();
                        }}
                      >
                        editar
                      </button>
                    )}
                    {t.role !== "user" &&
                      (() => {
                        // El boton "abrir" del bloque se pierde de vista en una
                        // respuesta larga: aqui abajo siempre esta a mano.
                        const arts = artefactosDe(t.text);
                        const ultimo = arts[arts.length - 1];
                        return ultimo ? (
                          <button
                            type="button"
                            className="cc-bloque-boton"
                            title="ver el resultado funcionando en el panel de la derecha"
                            onClick={() => setArtefacto(ultimo)}
                          >
                            abrir {ultimo.tipo}
                          </button>
                        ) : null;
                      })()}
                    {t.role !== "user" && i === turns.length - 1 && !busy && (
                      <button
                        type="button"
                        className="cc-bloque-boton"
                        title="pedir otra vez esta respuesta"
                        onClick={() => void regenerar()}
                      >
                        regenerar
                      </button>
                    )}
                    {/* Deshacer lo que hizo el agente. Solo cuando HAY foto:
                        sin proyecto (o con el árbol demasiado grande) el
                        backend no toma punto y aquí no se ofrece un botón que
                        solo podría dar un error (2026-09-22). */}
                    {t.role !== "user" && t.punto && !busy && (
                      <button
                        type="button"
                        className="cc-bloque-boton"
                        title="devuelve el proyecto (y, si quieres, la conversación) a como estaban justo antes de esta respuesta"
                        onClick={() =>
                          pedirVuelta({
                            sha: t.punto as string,
                            conservar: conservarPara(i),
                            desde: "antes de esta respuesta",
                          })
                        }
                      >
                        volver a antes de esta respuesta
                      </button>
                    )}
                    <BotonCopiar texto={t.text} />
                  </div>
                </div>
              </article>
            ))}

            {busy && enVivo?.texto && (
              <article className="mb-3" aria-live="polite">
                <div className="hud-label mb-1" style={{ color: "var(--color-accent)" }}>
                  {enVivo.provider} · escribiendo…
                </div>
                <div
                  className="rounded-none px-3 py-2 text-[12px]"
                  style={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                    color: "var(--color-text)",
                    overflowWrap: "anywhere",
                  }}
                >
                  <Markdown texto={enVivo.texto} onAbrir={setArtefacto} />
                </div>
              </article>
            )}

            {busy && !enVivo?.texto && (
              <p className="hud-label hud-pulse py-2">
                {enVivo ? `esperando a ${enVivo.provider}…` : "eligiendo quién contesta…"}
              </p>
            )}

            {busy && actividad && (
              <p className="hud-label py-1" style={{ color: "var(--color-text-secondary)" }}>
                {actividad}
              </p>
            )}

            {lastChoice && (
              <p className="hud-label py-1">
                mar.ia asignó esta petición a{" "}
                <span style={{ color: "var(--color-accent)" }}>{lastChoice}</span>
              </p>
            )}

            {/* El relevo, con el siguiente paso de cada descarte. Antes ponía
                solo «agy (CLI no instalada)» y ahí se acababa: saber el motivo
                sin saber qué hacer no sirve de nada (2026-09-22). */}
            {lastSkips.length > 0 && (
              <ul className="py-1" aria-label="proveedores que se saltaron">
                {lastSkips.map((s, i) => (
                  <li key={`${s.provider}-${i}`} className="mb-0.5">
                    <span className="hud-label" style={{ color: "var(--color-warn)" }}>
                      {s.provider} · {SKIP_LABEL[s.kind] ?? s.kind}
                    </span>
                    {s.accion && (
                      <span
                        className="ml-2 text-[11px]"
                        style={{ color: "var(--color-text-tertiary)" }}
                      >
                        {s.accion}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
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
              ref={listaSugerenciasRef}
              className="hud-panel hud-menu absolute bottom-full left-0 mb-1 w-full max-w-[520px] overflow-y-auto py-1"
              style={{ maxHeight: "min(45vh, 320px)" }}
              role="listbox"
              aria-label="comandos disponibles"
            >
              {sugerencias.map((c, i) => (
                <li key={c.name}>
                  <button
                    type="button"
                    role="option"
                    ref={(el) => {
                      sugerenciaRefs.current[i] = el;
                    }}
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

          {encargos.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1" aria-label="encargos en paralelo">
              {encargos
                .slice()
                .sort((a, b) => a.creado.localeCompare(b.creado))
                .slice(-4)
                .map((en) => (
                  <li
                    key={en.id}
                    className="hud-panel flex items-center gap-2 px-2 py-1 text-[11px]"
                    style={{ fontFamily: "var(--font-mono)" }}
                    title={en.texto}
                  >
                    <span
                      className={en.estado === "en_curso" ? "hud-pulse" : undefined}
                      style={{
                        color:
                          en.estado === "hecho"
                            ? "var(--color-success)"
                            : en.estado === "en_curso"
                              ? "var(--color-accent)"
                              : "var(--color-danger)",
                      }}
                    >
                      {en.provider} · {ESTADO_ENCARGO[en.estado]}
                    </span>
                    {/* Arrancó sin foto del proyecto. Va en la tira y no solo
                        en el aviso del momento de lanzarlo: un encargo dura, y
                        el aviso se lo lleva el siguiente. Mientras esté ahí,
                        nada de lo que toque ese agente se podrá deshacer desde
                        el chat (2026-09-22). */}
                    {en.aviso && (
                      <span
                        title={en.aviso}
                        className="shrink-0"
                        style={{ color: "var(--color-danger)" }}
                      >
                        sin punto de control
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate" style={{ color: "var(--color-text-tertiary)" }}>
                      {en.estado === "en_curso" ? (vivoEncargo[en.id] ?? en.texto) : en.texto}
                    </span>
                    {en.estado === "en_curso" ? (
                      <button
                        type="button"
                        className="cc-bloque-boton"
                        onClick={() =>
                          void invoke("maria_encargo_cancelar", { threadId, id: en.id })
                        }
                      >
                        parar
                      </button>
                    ) : (
                      <>
                        {en.estado === "interrumpido" && (
                          <button
                            type="button"
                            className="cc-bloque-boton"
                            title="se cerró mar.ia mientras corría: vuelve a lanzarlo igual"
                            onClick={() => void relanzarEncargo(en)}
                          >
                            relanzar
                          </button>
                        )}
                        {/* Un encargo escribe en el proyecto igual que el chat,
                            así que también se deshace. Solo el código: el
                            encargo no ocupa turnos tuyos que cortar. */}
                        {en.punto && (
                          <button
                            type="button"
                            className="cc-bloque-boton"
                            title="devuelve el proyecto a como estaba antes de lanzar este encargo"
                            onClick={() =>
                              pedirVuelta({
                                sha: en.punto as string,
                                conservar: null,
                                desde: `antes del encargo de ${en.provider}`,
                              })
                            }
                          >
                            deshacer
                          </button>
                        )}
                        <button
                          type="button"
                          className="cc-bloque-boton"
                          aria-label="quitar de la lista"
                          onClick={() => void olvidarEncargo(en.id)}
                        >
                          ×
                        </button>
                      </>
                    )}
                  </li>
                ))}
            </ul>
          )}

          {editando !== null && (
            <p className="hud-label mt-2 flex items-center gap-2" style={{ color: "var(--color-warn)" }}>
              editando un mensaje: al enviar, la conversación continúa desde ahí y lo posterior se descarta
              <button
                type="button"
                className="cc-bloque-boton"
                onClick={() => {
                  setEditando(null);
                  setPrompt("");
                }}
              >
                cancelar
              </button>
            </p>
          )}

          {adjuntando > 0 && (
            <p className="hud-label hud-pulse mt-2">
              guardando {adjuntando} fichero{adjuntando === 1 ? "" : "s"}…
            </p>
          )}

          {adjuntos.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="ficheros adjuntos">
              {adjuntos.map((a, i) => (
                <li
                  key={`${a.ruta}-${i}`}
                  className="hud-panel flex items-center gap-1.5 px-2 py-1 text-[11px]"
                  style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}
                  title={a.ruta}
                >
                  <span className="max-w-[220px] truncate">{a.nombre}</span>
                  <button
                    type="button"
                    aria-label={`quitar ${a.nombre}`}
                    onClick={() => setAdjuntos((prev) => prev.filter((_, j) => j !== i))}
                    style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}
                  >
                    ×
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
            <button
              type="button"
              onClick={() => void elegirFicheros()}
              disabled={busy}
              className="hud-panel px-2.5 text-[12px]"
              style={{
                minHeight: 34,
                color: "var(--color-text-secondary)",
                fontFamily: "var(--font-mono)",
                cursor: busy ? "default" : "pointer",
              }}
              title="adjuntar ficheros o imágenes (también puedes arrastrarlos o pegarlos)"
              aria-label="adjuntar ficheros"
            >
              +
            </button>
            <span className="hud-label">&gt;</span>
            <input
              ref={inputRef}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData?.files ?? []);
                if (files.length > 0) {
                  e.preventDefault();
                  void adjuntarFicheros(files);
                }
              }}
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
            {busy && (
              <button
                type="button"
                onClick={() => void invoke("maria_relay_cancel", { threadId })}
                className="hud-panel px-3 text-[12px]"
                style={{
                  minHeight: 34,
                  color: "var(--color-danger)",
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
                }}
                title="para la respuesta; se conserva lo que ya hubiera escrito"
              >
                parar
              </button>
            )}
          </form>
        </div>
      </div>
      {/* Confirmación de la vuelta. No es `Confirmar.tsx` porque aquí no hay
          un sí/no: hay TRES cosas distintas que se pueden deshacer y elegir
          mal borra trabajo. El foco arranca en «cancelar» y Escape cancela,
          igual que en el resto de la app. */}
      {vuelta && (
        <VolverAlPunto
          vuelta={vuelta}
          // `busy` también bloquea (2026-09-22): el diálogo se puede quedar
          // abierto y arrancar un turno después (un encargo que termina y
          // recarga, o Enter en la caja), y confirmar entonces restauraría la
          // carpeta mientras el agente la está escribiendo.
          ocupado={volviendo || busy}
          onCancelar={() => setVuelta(null)}
          onVolver={(modo) => void volverAlPunto(vuelta, modo)}
        />
      )}

      {panel && (
        <div style={{ width: "46%", minWidth: 360, maxWidth: 900 }} className="h-full shrink-0">
          <PanelLateral
            panel={panel === "artefacto" && !artefacto ? "cambios" : panel}
            onPanel={setPanel}
            onCerrar={() => setPanel(null)}
            artefacto={artefacto}
            onArtefacto={setArtefacto}
            threadId={threadId}
            proyecto={activa?.project ?? ""}
            refresco={refresco}
            onAviso={avisar}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Diálogo de «volver a antes de esta respuesta».
 *
 * Tres opciones porque son tres cosas distintas y el usuario tiene que poder
 * decidir cuál (2026-09-22): devolver la CARPETA del proyecto no toca el hilo,
 * y acortar el HILO no devuelve un solo fichero. Lo normal tras una respuesta
 * que rompió algo es «las dos».
 *
 * Con `conservar` a null (un encargo, o el atajo) solo se ofrece el código: no
 * hay un mensaje tuyo que marque dónde cortar la conversación, y truncar por
 * un número inventado se llevaría turnos de más.
 */
function VolverAlPunto({
  vuelta,
  ocupado,
  onCancelar,
  onVolver,
}: {
  vuelta: Vuelta;
  ocupado: boolean;
  onCancelar: () => void;
  onVolver: (modo: ModoVuelta) => void;
}) {
  const cancelar = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // El foco arranca en «cancelar»: un Intro despistado no borra el trabajo.
    cancelar.current?.focus();
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancelar();
      }
    };
    document.addEventListener("keydown", tecla, true);
    return () => document.removeEventListener("keydown", tecla, true);
  }, [onCancelar]);

  type Opcion = { modo: ModoVuelta; texto: string; detalle: string };
  const soloConversacion: Opcion[] = [
    {
      modo: "conversacion",
      texto: "solo la conversación",
      detalle: "quita los turnos desde ahí; los ficheros se quedan como están",
    },
    {
      modo: "todo",
      texto: "las dos",
      detalle: "el proyecto y la conversación vuelven al mismo punto",
    },
  ];
  const opciones: Opcion[] = [
    {
      modo: "codigo",
      texto: "solo el código del proyecto",
      detalle:
        "deshace lo que el agente escribió en la carpeta; la conversación se queda entera",
    },
    ...(vuelta.conservar !== null ? soloConversacion : []),
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="volver a un punto de control"
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ background: "rgba(3,7,15,0.72)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancelar();
      }}
    >
      <div
        className="hud-panel flex w-full flex-col gap-3 p-4"
        style={{ maxWidth: 520, background: "var(--color-surface-1)" }}
      >
        <h2 className="text-[14px] font-semibold" style={{ color: "var(--color-warn)" }}>
          volver a {vuelta.desde}
        </h2>
        <p
          className="text-[12.5px]"
          style={{ color: "var(--color-text-secondary)", lineHeight: 1.5 }}
        >
          Punto <span style={{ fontFamily: "var(--font-mono)" }}>{vuelta.sha.slice(0, 8)}</span>.
          Devolver el proyecto <strong>borra lo que se escribió después</strong> en los ficheros
          que mar.ia fotografía. Antes de tocar nada se toma otro punto, así que esto también se
          deshace.
          {vuelta.conservar === null && " Desde aquí solo se puede devolver el código."}
        </p>

        <ul className="flex flex-col gap-1.5">
          {opciones.map((o) => (
            <li key={o.modo}>
              <button
                type="button"
                disabled={ocupado}
                onClick={() => onVolver(o.modo)}
                className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-[13px]"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border-strong)",
                  color: "var(--color-text)",
                  cursor: ocupado ? "default" : "pointer",
                  opacity: ocupado ? 0.6 : 1,
                }}
              >
                <span>{o.texto}</span>
                <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                  {o.detalle}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-end gap-2">
          {ocupado && <span className="hud-label hud-pulse">volviendo…</span>}
          <button
            ref={cancelar}
            type="button"
            onClick={onCancelar}
            className="px-4 text-[13px]"
            style={{
              minHeight: 38,
              background: "var(--color-surface-3)",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text)",
              cursor: "pointer",
            }}
          >
            cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
