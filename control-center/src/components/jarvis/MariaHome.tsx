// mar.ia — pantalla principal.
//
// El orbe manda: ocupa el centro y todo lo demas orbita a su alrededor, como
// el HUD de Iron Man. No es una ventana aparte ni un adorno del rail — es la
// pagina a la que se vuelve siempre.
//
// Composicion:
//   centro   blob WebGL + anillos del reactor + estado y ultima frase
//   radial   accesos a los paneles, colocados en circulo con trigonometria
//   izq/der  telemetria REAL (CPU, RAM, disco, GPU, sesiones vivas)
//   abajo    linea de comando escrita, para cuando no quieres hablar
//
// Ninguna cifra es inventada: si el backend no la da, se pinta un guion.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../Sidebar";
import { Reactor, type ReactorState } from "./Reactor";
import { BotonMicrofono } from "./BotonMicrofono";
import { useHistorialEnviados } from "../../lib/useHistorialEnviados";
import { FRAG_SRC, ORB_STATE, VERT_SRC } from "../maria/blobShader";

type Gpu = {
  name: string;
  util_pct: number | null;
  mem_used_mb: number | null;
  mem_total_mb: number | null;
  temp_c: number | null;
};

/** Telemetria nativa (maria_sysinfo). No lanza PowerShell: `rich_system_info`
 *  si lo hacia y, al pedirlo cada pocos segundos, abria y cerraba consolas. */
type SystemInfo = {
  cpu_pct: number | null;
  ram_used_gb: number;
  ram_total_gb: number;
  ram_pct: number;
  disk_free_gb: number;
  disk_total_gb: number;
  disk_pct: number;
  gpus: Gpu[];
};

/** Estado del modelo local (`maria_local_status`). */
type EstadoLocal = {
  server_up: boolean;
  model: string;
  model_loaded: boolean;
  installed: boolean;
};

type SessionInfo = {
  session_id: string;
  project_name: string;
  status: string;
  context_pct: number;
  is_subagent: boolean;
};

/** Accesos que orbitan el reactor. El orden es el del circulo, empezando
 *  arriba y girando a la derecha. */
const ORBIT: Array<{ tab: Tab; label: string }> = [
  { tab: "chat", label: "chat" },
  { tab: "conversations", label: "conversaciones" },
  { tab: "terminals", label: "terminales" },
  { tab: "mosaic", label: "mosaico" },
  { tab: "memory", label: "memoria" },
  { tab: "agents", label: "agentes" },
  { tab: "skills", label: "skills" },
  { tab: "mcps", label: "mcps" },
  { tab: "ai-router", label: "router" },
  { tab: "sessions", label: "sesiones" },
  { tab: "projects", label: "proyectos" },
  { tab: "system", label: "sistema" },
  { tab: "settings", label: "ajustes" },
];

const STATE_TEXT: Record<ReactorState, string> = {
  offline: "voz apagada",
  idle: "di «maría» o pulsa ctrl+espacio",
  listening: "te escucho",
  thinking: "pensando",
  speaking: "hablando",
};

function num(v: number | null | undefined, suffix = "", digits = 0): string {
  return typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(digits)}${suffix}` : "—";
}

/** Consumo de la ventana movil (maria_quota). */
type WindowUsage = {
  provider: string;
  window_hours: number;
  tokens: number;
  turns: number;
  observed_ceiling: number | null;
  pct: number | null;
};

/** Tokens en formato corto: 1.2 M, 340 k. */
function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} k`;
  return String(n);
}

/** Ultimo resultado de cada proveedor (maria_relay). */
type ProviderState = { status: string; detail: string; at: string; answered: number };

/** Como se lee cada estado. Las CLI de suscripcion no publican cuota: lo unico
 *  medible es si contestaron, si se quedaron sin cuota o si fallaron. */
const PROVIDER_STATUS: Record<string, string> = {
  ok: "disponible",
  cuota: "sin cuota",
  error: "error",
  desactivado: "apagado",
};

/** "hace 4 min" a partir de un ISO. */
function hace(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const min = Math.floor((Date.now() - t) / 60_000);
  if (min < 1) return "ahora";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

/** Blob del reactor: el mismo shader del orbe, aqui a tamaño grande. */
function BlobCanvas({ state, amp }: { state: ReactorState; amp: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  const ampRef = useRef(amp);
  stateRef.current = state;
  ampRef.current = amp;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false });
    if (!gl) return; // sin WebGL quedan los anillos SVG: la pantalla no se rompe

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    const program = gl.createProgram();
    if (!vs || !fs || !program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const loc = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const uRes = gl.getUniformLocation(program, "uRes");
    const uTime = gl.getUniformLocation(program, "uTime");
    const uAmp = gl.getUniformLocation(program, "uAmp");
    const uState = gl.getUniformLocation(program, "uState");
    const t0 = performance.now();
    let raf = 0;
    let smooth = 0;

    const frame = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.floor(canvas.clientWidth * dpr);
      const h = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      smooth += (ampRef.current - smooth) * 0.15;
      const s = stateRef.current;
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, (performance.now() - t0) / 1000);
      gl.uniform1f(uAmp, smooth);
      gl.uniform1f(uState, ORB_STATE[s === "offline" ? "idle" : s]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      gl.deleteProgram(program);
      gl.deleteBuffer(buf);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
    />
  );
}

/** Panel de cristal con corchetes y titulo de HUD. */
function Panel({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`hud-panel hud-brackets p-3 ${className}`}>
      <h2 className="hud-label mb-2">{title}</h2>
      {children}
    </section>
  );
}

/** Fila etiqueta/valor con barra de nivel opcional. */
function Row({ k, v, pct }: { k: string; v: string; pct?: number | null }) {
  return (
    <div className="mb-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="hud-label" style={{ letterSpacing: "0.1em" }}>{k}</span>
        <span className="hud-value text-[11px] tabular-nums">{v}</span>
      </div>
      {typeof pct === "number" && Number.isFinite(pct) && (
        <div style={{ height: 3, background: "rgba(53,214,255,0.12)", marginTop: 3 }}>
          <div
            style={{
              height: "100%",
              width: `${Math.max(0, Math.min(100, pct))}%`,
              background:
                pct > 85 ? "var(--color-danger)" : pct > 65 ? "var(--color-warn)" : "var(--color-accent)",
              boxShadow: "0 0 8px currentColor",
            }}
          />
        </div>
      )}
    </div>
  );
}


export function MariaHome({
  voiceState,
  caption,
  captionParcial = false,
  mic = false,
  amp,
  onNavigate,
}: {
  voiceState: ReactorState;
  caption: string;
  /** El microfono esta abierto. Lo pinta el botón de abajo. */
  mic?: boolean;
  /** El subtitulo todavia se esta formando (Vosk en vivo), no es definitivo. */
  captionParcial?: boolean;
  amp: number;
  onNavigate: (t: Tab) => void;
}) {
  // Dictado: lo que mar.ia va entendiendo se escribe en la caja de la orden
  // segun hablas. El usuario lo pidio el 2026-09-19 ("que salga la
  // transcripcion en vivo de lo que voy diciendo, que se escriba en el chat"):
  // sin verlo, no hay forma de saber si te ha entendido o si no te oye.
  useEffect(() => {
    if (!caption) return;
    if (captionParcial) {
      // Solo si la caja esta libre o ya la lleva el dictado.
      if (dictando.current || prompt === "") {
        dictando.current = true;
        setPrompt(caption);
      }
    } else if (dictando.current) {
      // Llego algo que NO es un parcial: o la transcripcion definitiva o ya la
      // respuesta de mar.ia. La caja se suelta. Sin esto, la respuesta acababa
      // escrita en el sitio donde se escriben las ordenes, que confunde: parece
      // pendiente de enviar. La frase definitiva se lee bajo el orbe.
      dictando.current = false;
      setPrompt("");
    }
    // `prompt` a proposito fuera de las dependencias: este efecto reacciona a
    // lo que se oye, no a lo que se teclea.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caption, captionParcial]);

  // Al terminar el turno la caja se limpia: lo dictado ya lo ha respondido la
  // voz, y dejarlo ahi haria creer que esta pendiente de enviar.
  useEffect(() => {
    if (voiceState === "idle" && dictando.current) {
      dictando.current = false;
      setPrompt("");
    }
  }, [voiceState]);

  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [prompt, setPrompt] = useState("");
  // Lo que hay en la caja lo escribio el dictado, no el usuario. Sirve para
  // no pisar algo que el estuviera tecleando.
  const dictando = useRef(false);
  // Historial propio: la linea de ordenes del orbe no comparte el del chat.
  const historial = useHistorialEnviados("orbe");
  const [relayState, setRelayState] = useState<Record<string, ProviderState>>({});
  const [relayOrder, setRelayOrder] = useState<string[]>([]);
  const [claudeWindow, setClaudeWindow] = useState<WindowUsage | null>(null);
  /** Estado real del modelo local: servidor arriba y si ocupa VRAM ahora. */
  const [local, setLocal] = useState<EstadoLocal | null>(null);
  /** Ultimo problema de la linea de comando. Se pinta: un Enter que no hace
   *  nada y no explica por que es peor que no tener la linea. */
  const [cmdError, setCmdError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = () => {
      void invoke<SystemInfo>("maria_telemetry")
        .then((d) => alive && setSys(d ?? null))
        .catch(() => alive && setSys(null));
      void invoke<SessionInfo[]>("list_active_sessions")
        .then((d) => alive && setSessions(Array.isArray(d) ? d : []))
        .catch(() => alive && setSessions([]));
      void invoke<EstadoLocal>("maria_local_status")
        .then((d) => alive && setLocal(d ?? null))
        .catch(() => alive && setLocal(null));
      void invoke<Record<string, ProviderState>>("maria_relay_state")
        .then((d) => alive && setRelayState(d ?? {}))
        .catch(() => alive && setRelayState({}));
      void invoke<{ order: string[] }>("maria_relay_config")
        .then((d) => alive && setRelayOrder(d?.order ?? []))
        .catch(() => alive && setRelayOrder([]));
      void invoke<WindowUsage[]>("maria_quota_windows")
        .then((d) => alive && setClaudeWindow(d?.find((w) => w.provider === "claude") ?? null))
        .catch(() => alive && setClaudeWindow(null));
    };
    pull();
    const id = setInterval(pull, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const gpu = sys?.gpus?.[0];
  const vivas = useMemo(
    () => sessions.filter((s) => !s.is_subagent && s.status !== "dead"),
    [sessions],
  );

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      {/* --- columnas de telemetria -------------------------------------
          En rejilla, no superpuestas: con posicion absoluta los accesos se
          montaban encima de los paneles en cuanto la ventana bajaba de
          ~1400 px (visto a 1116 px). Las columnas se ocultan por debajo de
          1100 px para que el reactor nunca quede aplastado. */}
      <div className="flex min-h-0 flex-1 items-stretch gap-4 px-5 py-4">
        <div className="hidden w-[210px] shrink-0 space-y-3 self-center md:block">
          <Panel title="sistema">
            <Row k="cpu" v={num(sys?.cpu_pct, "%")} pct={sys?.cpu_pct ?? null} />
            <Row
              k="ram"
              v={sys ? `${num(sys.ram_used_gb, "", 1)} / ${num(sys.ram_total_gb, " GB", 0)}` : "—"}
              pct={sys?.ram_pct ?? null}
            />
            <Row k="disco c:" v={sys ? `${num(sys.disk_free_gb, " GB libres", 0)}` : "—"} pct={sys?.disk_pct ?? null} />
          </Panel>
          <Panel title="gpu">
            {gpu ? (
              <>
                <Row k={gpu.name.slice(0, 22)} v={num(gpu.util_pct, "%")} pct={gpu.util_pct ?? null} />
                <Row
                  k="vram"
                  v={
                    gpu.mem_used_mb != null && gpu.mem_total_mb != null
                      ? `${(gpu.mem_used_mb / 1024).toFixed(1)} / ${(gpu.mem_total_mb / 1024).toFixed(0)} GB`
                      : "—"
                  }
                  pct={
                    gpu.mem_used_mb != null && gpu.mem_total_mb != null
                      ? (gpu.mem_used_mb / gpu.mem_total_mb) * 100
                      : null
                  }
                />
                <Row k="temp" v={num(gpu.temp_c, " °C")} />
              </>
            ) : (
              <p className="hud-label">sin datos de gpu</p>
            )}
          </Panel>
        </div>

        {/* --- centro: reactor + estado + dock de accesos ----------------- */}
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center">
          <div className="relative" style={{ width: 340, height: 340 }}>
            <BlobCanvas state={voiceState} amp={amp} />
            <Reactor size={340} state={voiceState} style={{ position: "absolute", inset: 0 }} />
          </div>

          <p className="hud-label mt-5" style={{ fontSize: 11 }}>{STATE_TEXT[voiceState]}</p>
          {caption && (
            /* Mientras hablas se ve lo que va entendiendo, en gris y en
               cursiva; al soltar, la transcripcion buena lo sustituye en
               firme. Asi se sabe SIEMPRE que ha oido, que era justo lo que
               fallaba: el usuario hablaba y no aparecia nada. */
            <p
              className="mt-1 max-w-[520px] text-center text-[12px]"
              style={{
                color: captionParcial
                  ? "var(--color-text-tertiary)"
                  : "var(--color-text-secondary)",
                fontStyle: captionParcial ? "italic" : "normal",
                overflowWrap: "anywhere",
              }}
            >
              {caption}
              {captionParcial && "…"}
            </p>
          )}

          {/* Dock: los accesos en fila, como los widgets del Mark II. */}
          <nav className="mt-6 flex max-w-[640px] flex-wrap justify-center gap-2">
            {ORBIT.map((item) => (
              <button
                key={item.tab}
                onClick={() => onNavigate(item.tab)}
                className="hud-panel px-2.5 py-1 text-[11px] transition-colors"
                style={{
                  fontFamily: "var(--font-mono)",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--color-text-secondary)",
                  whiteSpace: "nowrap",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--color-accent)";
                  e.currentTarget.style.borderColor = "var(--color-border-strong)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--color-text-secondary)";
                  e.currentTarget.style.borderColor = "var(--color-border)";
                }}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="hidden w-[210px] shrink-0 space-y-3 self-center md:block">
          <Panel title={`sesiones · ${vivas.length}`}>
            {vivas.length === 0 && <p className="hud-label">ninguna activa</p>}
            {vivas.slice(0, 5).map((s) => (
              <Row
                key={s.session_id}
                k={s.project_name.slice(0, 18)}
                v={s.status}
                pct={s.context_pct}
              />
            ))}
          </Panel>
          <Panel title="proveedores">
            {/* Consumo REAL de la ventana movil de Claude, sumado de los
                transcripts. El tope no lo publica Anthropic: se aprende la
                primera vez que contesta "sin cuota", y hasta entonces se
                muestran los tokens sin porcentaje. */}
            {claudeWindow && (
              <Row
                k={`claude · ${claudeWindow.window_hours} h`}
                v={
                  claudeWindow.pct != null
                    ? `${Math.round(claudeWindow.pct)}% · ${fmtTokens(claudeWindow.tokens)}`
                    : `${fmtTokens(claudeWindow.tokens)} · tope sin medir`
                }
                pct={claudeWindow.pct ?? null}
              />
            )}
            {relayOrder.length === 0 && <p className="hud-label">sin configurar</p>}
            {relayOrder.map((p) => {
              const st = relayState[p];
              return (
                <Row
                  key={p}
                  k={p}
                  v={
                    st
                      ? `${PROVIDER_STATUS[st.status] ?? st.status}${
                          st.at ? ` · ${hace(st.at)}` : ""
                        }`
                      : "sin usar"
                  }
                />
              );
            })}
            <p className="hud-label mt-2" style={{ lineHeight: 1.5 }}>
              relevo automático al agotarse
            </p>
          </Panel>
          <Panel title="voz · ia local">
            <Row k="voz" v={voiceState} />
            <Row
              k="servidor"
              v={
                local === null
                  ? "—"
                  : local.server_up
                    ? "arriba"
                    : local.installed
                      ? "caído"
                      : "sin ollama"
              }
            />
            <Row k="modelo" v={local?.model || "—"} />
            <Row k="en vram" v={local === null ? "—" : local.model_loaded ? "sí" : "no"} />
            <p className="hud-label mt-2" style={{ lineHeight: 1.5 }}>
              el servidor arranca con mar.ia; el modelo se carga al preguntar y se
              descarga al responder
            </p>
          </Panel>
        </div>
      </div>

      {/* --- linea de comando escrita ------------------------------------ */}
      <form
        className="relative z-10 mx-auto mb-5 flex w-[min(620px,80%)] items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const texto = prompt.trim();
          if (!texto) return;
          historial.recordar(texto);
          setPrompt("");
          setCmdError(null);
          // Misma entrada que la voz: el modelo local decide y la app ejecuta.
          // Si el sidecar no esta levantado se levanta AQUI y se reintenta:
          // antes el Enter no hacia absolutamente nada y no habia forma de
          // saber por que (reportado por el usuario el 2026-09-18).
          void (async () => {
            try {
              await invoke("maria_voice_ask", { text: texto });
            } catch {
              try {
                await invoke("maria_voice_start");
                await invoke("maria_voice_ask", { text: texto });
              } catch (e2) {
                setCmdError(String(e2));
              }
            }
          })();
        }}
      >
        <BotonMicrofono micOn={mic} voz={voiceState} onError={setCmdError} />
        <span className="hud-label">&gt;</span>
        <input
          value={prompt}
          onChange={(e) => {
            dictando.current = false;
            setPrompt(e.target.value);
          }}
          onKeyDown={(e) => {
            // Flechas: recupera lo que has mandado antes, como en una
            // terminal. Al navegar se sale del dictado.
            if (historial.manejarTecla(e, prompt, setPrompt)) {
              dictando.current = false;
            }
          }}
          placeholder={voiceState === "listening" ? "te escucho…" : "escribe una orden…"}
          aria-label="orden escrita"
          className="hud-panel flex-1 px-3 py-2 text-[12px]"
          style={{
            color: "var(--color-text)",
            fontFamily: "var(--font-mono)",
            outline: "none",
          }}
        />
      </form>
      {cmdError && (
        <p
          className="relative z-10 mx-auto mb-4 w-[min(620px,80%)] px-3 py-2 text-[11px]"
          style={{
            border: "1px solid var(--color-danger)",
            color: "var(--color-danger)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {cmdError}
        </p>
      )}
    </div>
  );
}
