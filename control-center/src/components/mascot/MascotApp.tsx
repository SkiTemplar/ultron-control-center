// Mascota — raíz de la ventana «mascot» (transparente, siempre encima, del
// tamaño del área de trabajo). Ver src-tauri/src/mascot/mod.rs.
//
// Bucle por fotograma:
//   1. pregunta el cursor GLOBAL (la ventana ignora el ratón casi siempre),
//   2. decide si la ventana debe recibir el ratón (cursor sobre la mascota,
//      sus botones o un bocadillo) y se lo dice a Rust solo si cambia,
//   3. avanza el motor y pinta,
//   4. recoloca botones y bocadillos junto a la cabeza.
// Las ventanas del escritorio se refrescan 4 veces por segundo y el área
// de trabajo cada pocos segundos (barra de tareas movida, resolución…).

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_SETTINGS, MascotEngine, type ChatState, type MascotSettings } from "./engine";
import { renderFrame, type Dirty } from "./render";
import type { WinRect } from "./world";
import { AGENTS, AgentIcon, agentBackground, type AgentId } from "./icons";
import "./mascot.css";

interface Env {
  origin_x: number;
  origin_y: number;
  width: number;
  height: number;
  scale_factor: number;
  supported: boolean;
}

interface CursorState {
  x: number;
  y: number;
  ctrl: boolean;
  lbutton: boolean;
}

interface NativeWin {
  id: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  title: string;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
}

type ChatView =
  | { phase: "closed" }
  | { phase: "input"; agent: AgentId }
  | { phase: "thinking"; agent: AgentId; question: string }
  | { phase: "reply"; agent: AgentId; text: string; via: string }
  | { phase: "error"; agent: AgentId; text: string };

type DrivePayload =
  | { phase: "start" }
  | { phase: "act"; kind: string; x: number; y: number }
  | { phase: "end" };

const I32_MIN = -2147483648;

function chatStateOf(c: ChatView): ChatState {
  switch (c.phase) {
    case "input":
      return "listen";
    case "thinking":
      return "think";
    case "reply":
    case "error":
      return "talk";
    default:
      return "none";
  }
}

function inside(r: DOMRect | null, x: number, y: number, pad = 0): boolean {
  return !!r && r.width > 0 && x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
}

function agentLabel(id: AgentId): string {
  return AGENTS.find((a) => a.id === id)?.label ?? id;
}

export function MascotApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const engineRef = useRef<MascotEngine | null>(null);
  const envRef = useRef<Env | null>(null);
  const settingsRef = useRef<MascotSettings>(DEFAULT_SETTINGS);
  const cursorRef = useRef<{ x: number; y: number; ctrl: boolean } | null>(null);
  const interactiveRef = useRef(false);
  const driveRef = useRef(false);
  const chatRef = useRef<ChatView>({ phase: "closed" });
  const historyRef = useRef<Record<AgentId, Turn[]>>({ claude: [], codex: [], antigravity: [] });
  const reqRef = useRef(0);
  const replyDeadlineRef = useRef(0);
  const pressRef = useRef<{ x: number; y: number; t: number; dragging: boolean } | null>(null);
  const showButtonsRef = useRef(false);
  const lastHoverRef = useRef(0);

  const [ready, setReady] = useState(false);
  const [showButtons, setShowButtons] = useState(false);
  const [chat, setChatState] = useState<ChatView>({ phase: "closed" });
  const [draft, setDraft] = useState("");

  const setChat = useCallback((c: ChatView) => {
    chatRef.current = c;
    setChatState(c);
    if (c.phase === "reply" || c.phase === "error") {
      const len = c.text.length;
      replyDeadlineRef.current = performance.now() + Math.min(60_000, Math.max(9_000, len * 70));
    }
  }, []);

  // Fondo transparente: el CSS global pinta html/body con el color de la app.
  useEffect(() => {
    document.documentElement.classList.add("mascot-root");
    return () => document.documentElement.classList.remove("mascot-root");
  }, []);

  const toCss = useCallback((px: number, py: number) => {
    const e = envRef.current;
    if (!e) return { x: px, y: py };
    return { x: (px - e.origin_x) / e.scale_factor, y: (py - e.origin_y) / e.scale_factor };
  }, []);

  const setInteractive = useCallback((on: boolean) => {
    if (interactiveRef.current === on) return;
    interactiveRef.current = on;
    invoke("mascot_set_interactive", { interactive: on }).catch(() => {
      interactiveRef.current = !on;
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Arranque: ajustes, área de trabajo, eventos
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    const unlisten: (() => void)[] = [];

    const loadEnv = async () => {
      try {
        const env = await invoke<Env>("mascot_env");
        envRef.current = env;
        const W = env.width / env.scale_factor;
        const H = env.height / env.scale_factor;
        if (!engineRef.current) engineRef.current = new MascotEngine(W, H, settingsRef.current);
        else engineRef.current.setArea(W, H);
        if (alive) setReady(true);
      } catch {
        /* la ventana aún no existe o se está cerrando */
      }
    };

    (async () => {
      try {
        const s = await invoke<MascotSettings>("mascot_get_settings");
        settingsRef.current = { ...DEFAULT_SETTINGS, ...s };
      } catch {
        /* valores por defecto */
      }
      await loadEnv();
      engineRef.current?.setSettings(settingsRef.current);
    })();

    const envTimer = window.setInterval(loadEnv, 4000);

    void listen<MascotSettings>("mascot:settings", (e) => {
      settingsRef.current = { ...DEFAULT_SETTINGS, ...e.payload };
      engineRef.current?.setSettings(settingsRef.current);
    }).then((u) => unlisten.push(u));

    void listen("mascot:summon", () => engineRef.current?.summon()).then((u) => unlisten.push(u));

    void listen<DrivePayload>("mascot:drive", (e) => {
      const eng = engineRef.current;
      if (!eng) return;
      const p = e.payload;
      if (p.phase === "start") {
        driveRef.current = true;
        pressRef.current = null;
        eng.driveStart();
      } else if (p.phase === "act") {
        driveRef.current = true;
        const at = p.x === I32_MIN ? null : toCss(p.x, p.y);
        eng.driveAction(p.kind, at);
      } else {
        driveRef.current = false;
        eng.driveEnd();
      }
    }).then((u) => unlisten.push(u));

    return () => {
      alive = false;
      window.clearInterval(envTimer);
      unlisten.forEach((u) => u());
    };
  }, [toCss]);

  // Ventanas del escritorio → plataformas y paredes.
  useEffect(() => {
    if (!ready) return;
    let busy = false;
    const timer = window.setInterval(async () => {
      const s = settingsRef.current;
      const eng = engineRef.current;
      if (!eng || busy || !(s.climb_windows || s.collide_windows)) return;
      busy = true;
      try {
        const list = await invoke<NativeWin[]>("mascot_windows");
        const rects: WinRect[] = list.map((w) => {
          const a = toCss(w.left, w.top);
          const b = toCss(w.right, w.bottom);
          return { id: w.id, left: a.x, top: a.y, right: b.x, bottom: b.y };
        });
        eng.setWindows(rects.filter((r) => r.right > 0 && r.left < eng.W && r.bottom > 0 && r.top < eng.H));
      } catch {
        /* sin ventanas este ciclo */
      } finally {
        busy = false;
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [ready, toCss]);

  // ---------------------------------------------------------------------------
  // Bucle de fotogramas
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let dpr = window.devicePixelRatio || 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      ctx.imageSmoothingEnabled = false;
      dirty = null;
    };
    let dirty: Dirty | null = null;
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    let last = performance.now();
    let cursorBusy = false;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const eng = engineRef.current;
      if (!eng) return;
      const dt = (now - last) / 1000;
      last = now;

      if (!cursorBusy) {
        cursorBusy = true;
        invoke<CursorState | null>("mascot_cursor")
          .then((c) => {
            if (c) {
              const p = toCss(c.x, c.y);
              cursorRef.current = { x: p.x, y: p.y, ctrl: c.ctrl };
            }
          })
          .catch(() => {})
          .finally(() => {
            cursorBusy = false;
          });
      }

      const cur = cursorRef.current;
      const chatNow = chatRef.current;
      const S = eng.S;
      const petHot = !!cur && (() => {
        const b = eng.bounds(2 * S);
        return cur.x >= b.x && cur.x <= b.x + b.w && cur.y >= b.y && cur.y <= b.y + b.h;
      })();
      const btnRect = showButtonsRef.current ? buttonsRef.current?.getBoundingClientRect() ?? null : null;
      const panelRect = chatNow.phase !== "closed" ? panelRef.current?.getBoundingClientRect() ?? null : null;
      const onButtons = !!cur && inside(btnRect, cur.x, cur.y, 6);
      const onPanel = !!cur && inside(panelRect, cur.x, cur.y, 4);
      const dragging = !!pressRef.current;

      // Botones: aparecen al pasar por encima y aguantan un momento (no con
      // un bocadillo abierto: se taparían; «responder» ya está en él).
      if (petHot || onButtons) lastHoverRef.current = now;
      const wantButtons =
        !driveRef.current &&
        chatNow.phase === "closed" &&
        !dragging &&
        eng.mode !== "drag" &&
        now - lastHoverRef.current < 900;
      if (wantButtons !== showButtonsRef.current) {
        showButtonsRef.current = wantButtons;
        setShowButtons(wantButtons);
      }

      setInteractive(!driveRef.current && (dragging || petHot || onButtons || onPanel));

      // El bocadillo se va solo, salvo mientras lo estás leyendo.
      if ((chatNow.phase === "reply" || chatNow.phase === "error") && !driveRef.current) {
        if (onPanel) replyDeadlineRef.current = Math.max(replyDeadlineRef.current, now + 3000);
        if (now > replyDeadlineRef.current) setChat({ phase: "closed" });
      }

      const chatState = chatStateOf(chatNow);
      eng.update({ dt, cursor: cur, hovered: petHot || onButtons || onPanel, chat: chatState });
      dirty = renderFrame(ctx, eng, chatState, dpr, dirty);

      // Zona de clic sobre la mascota.
      const hit = hitRef.current;
      if (hit) {
        const b = eng.bounds(S);
        hit.style.transform = `translate(${b.x}px, ${b.y}px)`;
        hit.style.width = `${b.w}px`;
        hit.style.height = `${b.h}px`;
      }

      // Colocar botones y bocadillo junto a la cabeza.
      const headX = eng.x;
      const headY = eng.y - eng.height - 2 * S;
      const W = window.innerWidth;
      const bt = buttonsRef.current;
      if (bt && showButtonsRef.current) {
        const w = bt.offsetWidth;
        const x = Math.min(Math.max(headX - w / 2, 4), W - w - 4);
        let y = headY - bt.offsetHeight - 8;
        if (y < 4) y = eng.y + 6;
        bt.style.transform = `translate(${x}px, ${y}px)`;
      }
      const panel = panelRef.current;
      if (panel && chatNow.phase !== "closed") {
        const w = panel.offsetWidth;
        const h = panel.offsetHeight;
        let x = headX - w / 2;
        let y = headY - h - 16;
        let tail = true;
        if (y < 6) {
          // No cabe encima: al lado de la mascota.
          tail = false;
          y = Math.min(Math.max(eng.y - eng.height - h / 2, 6), window.innerHeight - h - 6);
          x = headX + eng.halfW + 14;
          if (x + w > W - 6) x = headX - eng.halfW - 14 - w;
        }
        x = Math.min(Math.max(x, 6), W - w - 6);
        panel.style.transform = `translate(${x}px, ${y}px)`;
        const tl = tailRef.current;
        if (tl) {
          tl.style.display = tail ? "block" : "none";
          tl.style.left = `${Math.min(Math.max(headX - x - 7, 14), w - 28)}px`;
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [ready, setChat, setInteractive, toCss]);

  // ---------------------------------------------------------------------------
  // Ratón sobre la mascota: clic = saltito, arrastrar = coger, soltar =
  // lanzar (con Ctrl = colgarla de una chincheta).
  // ---------------------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || driveRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pressRef.current = { x: e.clientX, y: e.clientY, t: performance.now(), dragging: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pressRef.current;
    const eng = engineRef.current;
    if (!p || !eng) return;
    const now = performance.now() / 1000;
    if (!p.dragging) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) return;
      p.dragging = true;
      eng.startDrag(p.x, p.y, p.t / 1000);
    }
    eng.dragTo(e.clientX, e.clientY, now);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pressRef.current;
    const eng = engineRef.current;
    pressRef.current = null;
    if (!p || !eng) return;
    if (p.dragging) eng.endDrag(e.ctrlKey || !!cursorRef.current?.ctrl);
    else eng.poke();
  };

  // ---------------------------------------------------------------------------
  // Conversación
  // ---------------------------------------------------------------------------
  const openChat = (agent: AgentId) => {
    setChat({ phase: "input", agent });
    invoke("mascot_focus")
      .catch(() => {})
      .finally(() => window.setTimeout(() => inputRef.current?.focus(), 30));
  };

  const send = async () => {
    const c = chatRef.current;
    const text = draft.trim();
    if (c.phase !== "input" || !text) return;
    const agent = c.agent;
    const history = historyRef.current[agent];
    const id = ++reqRef.current;
    setDraft("");
    setChat({ phase: "thinking", agent, question: text });
    try {
      const r = await invoke<{ text: string; via: string }>("mascot_ask", {
        agent,
        history,
        message: text,
      });
      historyRef.current[agent] = [
        ...history,
        { role: "user" as const, text },
        { role: "assistant" as const, text: r.text },
      ].slice(-16);
      if (id === reqRef.current) setChat({ phase: "reply", agent, text: r.text, via: r.via });
    } catch (err) {
      if (id === reqRef.current) setChat({ phase: "error", agent, text: String(err) });
    }
  };

  const close = () => {
    reqRef.current++;
    setChat({ phase: "closed" });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape") {
      close();
    }
  };

  const agentOf = chat.phase === "closed" ? null : chat.agent;

  return (
    <div className="mascot-layer">
      <canvas ref={canvasRef} className="mascot-canvas" />
      <div
        ref={hitRef}
        className="mascot-hit"
        title="Arrástrame y suéltame para lanzarme · Ctrl al soltar: me cuelgas · clic: saltito"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />

      {showButtons && (
        <div ref={buttonsRef} className="mascot-buttons">
          {AGENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              className="mascot-btn"
              style={{ background: agentBackground(a.id) }}
              title={`Hablar con ${a.label}`}
              onClick={() => openChat(a.id)}
            >
              <AgentIcon id={a.id} />
            </button>
          ))}
        </div>
      )}

      {agentOf && (
        <div ref={panelRef} className="mascot-panel" onPointerDown={(e) => e.stopPropagation()}>
          <div className="mascot-panel-head">
            <span className="mascot-dot" style={{ background: agentBackground(agentOf) }}>
              <AgentIcon id={agentOf} size={12} />
            </span>
            <span className="mascot-agent">{agentLabel(agentOf)}</span>
            {historyRef.current[agentOf].length > 0 && chat.phase === "input" && (
              <button
                type="button"
                className="mascot-link"
                title="Empezar una conversación nueva"
                onClick={() => {
                  historyRef.current[agentOf] = [];
                  setChat({ phase: "input", agent: agentOf });
                }}
              >
                nueva
              </button>
            )}
            <button type="button" className="mascot-x" title="Cerrar (Esc)" onClick={close}>
              ×
            </button>
          </div>

          {chat.phase === "input" && (
            <div className="mascot-input-row">
              <textarea
                ref={inputRef}
                className="mascot-input"
                rows={2}
                value={draft}
                placeholder={`Escribe a ${agentLabel(chat.agent)}… (Enter envía)`}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
              />
              <button type="button" className="mascot-send" disabled={!draft.trim()} onClick={() => void send()}>
                ➤
              </button>
            </div>
          )}

          {chat.phase === "thinking" && (
            <div className="mascot-thinking">
              <span className="mascot-question">«{chat.question.length > 90 ? `${chat.question.slice(0, 90)}…` : chat.question}»</span>
              <span>
                pensando<span className="mascot-dots" />
              </span>
            </div>
          )}

          {chat.phase === "reply" && (
            <>
              <div className="mascot-reply">{chat.text}</div>
              <div className="mascot-foot">
                <span className="mascot-via" title={chat.via}>
                  vía {chat.via}
                </span>
                <button
                  type="button"
                  className="mascot-link"
                  onClick={() => void navigator.clipboard?.writeText(chat.text).catch(() => {})}
                >
                  copiar
                </button>
                <button type="button" className="mascot-link" onClick={() => openChat(chat.agent)}>
                  responder
                </button>
              </div>
            </>
          )}

          {chat.phase === "error" && (
            <>
              <div className="mascot-reply mascot-error">{chat.text}</div>
              <div className="mascot-foot">
                <button type="button" className="mascot-link" onClick={() => openChat(chat.agent)}>
                  reintentar
                </button>
              </div>
            </>
          )}
          <div ref={tailRef} className="mascot-tail" />
        </div>
      )}
    </div>
  );
}
