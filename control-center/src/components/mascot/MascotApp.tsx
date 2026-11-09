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
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { DEFAULT_SETTINGS, MascotEngine, type ChatState, type MascotSettings } from "./engine";
import { CanvasPainter, emptyDecor } from "./render";
import { AGENTS, AgentIcon, agentBackground, type AgentId } from "./icons";
import {
  ApprovalCard,
  AttachmentChips,
  Linkified,
  PetMenu,
  ThinkingDots,
  baseName,
  type Approval,
  type ApprovalDecision,
  type MenuAction,
} from "./bubble";
import { useApprovals } from "./useApprovals";
import { MascotInputRow } from "./MascotInputRow";
import { Navigator, type RawCursor } from "./navigator";
import { effectiveSettings, isInteractive } from "./gameMode";
import { CursorPrank } from "./prank";
import type { Env } from "./screens";
import { prepareMascotDocument } from "./mascotDocument";
import { pressHandlers, type Press } from "./pointerPress";
import { NoticeBubble, useDeskAlerts } from "./useDeskAlerts";
import { useDesktopWindows } from "./useDesktopWindows";
import { useForeground } from "./useForeground";
import { useMediaSense } from "./useMediaSense";
import { useMcpDrive } from "./useMcpDrive";
import { useSessionsWatch } from "./useSessionsWatch";
import { useTaskbar } from "./useTaskbar";
import { useVitality } from "./useVitality";
import { PetRectPublisher, toPhysRect } from "./petRect";
import { actionErrorText, approvalFailureWhat, copyText, runAction } from "./mascotActions";
import { ChatHead, ChatTranscript } from "./ChatHead";
import {
  appendExchange,
  archiveConversation,
  modelHistory,
  saveConversation,
  useSavedChat,
  type Turn,
} from "./chatLog";
import "./mascot.css";

/** Margen (en píxeles de sprite) alrededor de Pupus donde se le puede soltar un fichero. */
const DROP_PAD = 10;

// Antes de que React pinte nada (main.tsx importa este módulo antes de
// createRoot): sin el fondo negro global ni un solo fotograma.
prepareMascotDocument(window.location.pathname);

type ChatView =
  | { phase: "closed" }
  | { phase: "input"; agent: AgentId }
  | { phase: "thinking"; agent: AgentId; question: string }
  | { phase: "reply"; agent: AgentId; text: string; via: string; tainted: boolean }
  | { phase: "error"; agent: AgentId; text: string; retry: Retry };

/** Lo enviado, para que «reintentar» lo devuelva al cuadro de texto. */
interface Retry {
  draft: string;
  files: string[];
}

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

const agentLabel = (id: AgentId): string => AGENTS.find((a) => a.id === id)?.label ?? id;

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
  const petRectRef = useRef(new PetRectPublisher());
  const chatRef = useRef<ChatView>({ phase: "closed" });
  const historyRef = useRef<Record<AgentId, Turn[]>>({
    claude: [],
    codex: [],
    antigravity: [],
  });
  const reqRef = useRef(0);
  const replyDeadlineRef = useRef(0);
  const quietRef = useRef(false); // silencio de juego (useForeground.ts)
  const pressRef = useRef<Press | null>(null);
  const showButtonsRef = useRef(false);
  const lastHoverRef = useRef(0);
  const rawCursorRef = useRef<RawCursor | null>(null);
  const fileArrivedRef = useRef<(path: string) => void>(() => {});
  const openChatRef = useRef<(agent: AgentId, files?: string[]) => void>(() => {});
  const navRef = useRef<Navigator | null>(null);
  const prankRef = useRef(new CursorPrank());
  const menuRef = useRef<HTMLDivElement>(null);
  const menuOpenRef = useRef(false);
  const attachmentsRef = useRef<string[]>([]);
  const taintedRef = useRef<Record<AgentId, boolean>>({ claude: false, codex: false, antigravity: false });
  // Un turno trajo web o ficheros: el freno marca la conversación (chat_gate.rs).
  const gateTaintedRef = useRef<Record<AgentId, boolean>>({ claude: false, codex: false, antigravity: false });
  const showErrorRef = useRef<(text: string) => void>(() => {}); // = desk.showError, más abajo

  const [ready, setReady] = useState(false);
  const [showButtons, setShowButtons] = useState(false);
  const [chat, setChatState] = useState<ChatView>({ phase: "closed" });
  /** Última respuesta: el bocadillo se cierra solo y el menú la vuelve a enseñar. */
  const lastReplyRef = useRef<Extract<ChatView, { phase: "reply" }> | null>(null);
  const [draft, setDraft] = useState("");
  /** «ver chat»: la conversación entera desplegada (ChatHead.tsx). */
  const [showLog, setShowLog] = useState(false);
  const [menuOpen, setMenuOpenState] = useState(false);
  const [attachments, setAttachmentsState] = useState<string[]>([]);
  const [decor] = useState(emptyDecor); // disfraz y flecha (render.ts)

  const setMenuOpen = useCallback((open: boolean) => {
    menuOpenRef.current = open;
    setMenuOpenState(open);
  }, []);

  const setAttachments = useCallback((files: string[]) => {
    attachmentsRef.current = files;
    setAttachmentsState(files);
    if (!files.length && engineRef.current) engineRef.current.carrying = null;
  }, []);

  /** Lanza una acción del backend y, si falla, lo dice en el bocadillo de avisos. */
  const act = (cmd: string, args: Record<string, unknown> | undefined, what: string) =>
    void runAction(invoke, cmd, args, what).then((err) => err && showErrorRef.current(err));

  const answerApproval = (a: Approval, decision: ApprovalDecision) => {
    const { cmd, args } = take(a, decision);
    // Un clic tras el plazo no puede parecer aceptado.
    act(cmd, args, approvalFailureWhat(decision !== "deny"));
  };

  const setChat = useCallback((c: ChatView) => {
    const prev = chatRef.current;
    // Cerrar la conversación devuelve a la mascota a su color.
    if (c.phase === "closed" && prev.phase !== "closed") engineRef.current?.chatEnded();
    chatRef.current = c;
    setChatState(c);
    if (c.phase === "reply") lastReplyRef.current = c;
    if (c.phase === "reply" || c.phase === "error") {
      const len = c.text.length;
      replyDeadlineRef.current = performance.now() + Math.min(60_000, Math.max(9_000, len * 70));
    }
  }, []);

  // Nada del menú nativo de la webview (clic derecho = menú de Pupus).
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
  }, []);

  // Soltar ficheros o fotos encima de Pupus: mientras el arrastre está sobre
  // él, se prepara para cogerlo; al soltar, se los come y pregunta qué hacer.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((e) => {
      const eng = engineRef.current;
      const env = envRef.current;
      if (!eng || !env) return;
      const ev = e.payload;
      if (ev.type === "leave") {
        eng.dropHover(null);
        return;
      }
      const x = ev.position.x / env.scale_factor;
      const y = ev.position.y / env.scale_factor;
      const b = eng.bounds(DROP_PAD * eng.S);
      const over = x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
      if (ev.type !== "drop") {
        eng.dropHover(over && !quietRef.current ? { x, y } : null);
        return;
      }
      eng.dropHover(null);
      if (!over || !ev.paths.length) return;
      eng.grab(baseName(ev.paths[0]));
      openChatRef.current("claude", ev.paths);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const toCss = useCallback((px: number, py: number) => {
    const e = envRef.current;
    if (!e) return { x: px, y: py };
    return {
      x: (px - e.origin_x) / e.scale_factor,
      y: (py - e.origin_y) / e.scale_factor,
    };
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

    const applyEnv = (env: Env) => {
      envRef.current = env;
      engineRef.current?.setArea(env.width / env.scale_factor, env.height / env.scale_factor);
      // Al mudarse de monitor cambian tamaño y escala: repintar el canvas.
      window.dispatchEvent(new Event("resize"));
    };

    const loadEnv = async () => {
      try {
        const env = await invoke<Env>("mascot_env");
        envRef.current = env;
        const W = env.width / env.scale_factor;
        const H = env.height / env.scale_factor;
        if (!navRef.current) {
          navRef.current = new Navigator({
            engine: () => engineRef.current,
            env: () => envRef.current,
            applyEnv,
            onFileArrived: (path) => fileArrivedRef.current(path),
            quiet: () => quietRef.current,
          });
        }
        // El ánimo y la memoria se recuperan en useVitality.
        if (!engineRef.current) engineRef.current = new MascotEngine(W, H, settingsRef.current);
        else engineRef.current.setArea(W, H);
        await navRef.current.refreshScreens();
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
      engineRef.current?.setSettings(effectiveSettings(settingsRef.current, quietRef.current));
    })();

    const envTimer = window.setInterval(loadEnv, 4000);

    void listen<MascotSettings>("mascot:settings", (e) => {
      settingsRef.current = { ...DEFAULT_SETTINGS, ...e.payload };
      engineRef.current?.setSettings(effectiveSettings(settingsRef.current, quietRef.current));
    }).then((u) => unlisten.push(u));

    // «Llamar»: Rust ya ha mudado la ventana al monitor del cursor (o de
    // ULTRON) y dice en qué X caer.
    void listen<{ env: Env | null; x: number | null } | null>("mascot:summon", (e) => {
      const p = e.payload;
      if (p?.env) {
        applyEnv(p.env);
        void navRef.current?.refreshScreens();
      }
      engineRef.current?.summon(p?.x ?? undefined);
    }).then((u) => unlisten.push(u));

    return () => {
      alive = false;
      window.clearInterval(envTimer);
      unlisten.forEach((u) => u());
    };
  }, []);

  // Gorro, disfraz de juego y «no molestar» según lo que tienes delante.
  const fg = useForeground({ ready, engineRef, settingsRef, quietRef, replyDeadlineRef, decor, toCss });
  useDesktopWindows(ready, engineRef, settingsRef, toCss, fg.gameHwndRef);
  useVitality({ ready, engineRef, fgRef: fg.fgRef, quietRef, settingsRef }); // ánimo, memoria y contexto
  useMediaSense(ready, engineRef, settingsRef, quietRef); // ¿suena música? (para bailar)
  // MCP de escritorio y avisos de Sessions (clic en Pupus = ir allí).
  const cancelPress = useCallback(() => void (pressRef.current = null), []);
  const hoverGuardRef = useMcpDrive({ engineRef, driveRef, interactiveRef, cursorRef, cancelPress, toCss });
  const pointAt = useTaskbar({ ready, engineRef, envRef, navRef, decor, quietRef, settingsRef });
  const sessionsWatch = useSessionsWatch(ready, engineRef, hitRef, { quietRef, fgRef: fg.fgRef, pointAt });
  const desk = useDeskAlerts({ ready, engineRef, navRef, decor, quietRef, settingsRef, sessionsBusy: sessionsWatch.hasPending });
  const { approvals, approvalsRef, take } = useApprovals(ready); // freno, terminal y Sessions
  showErrorRef.current = desk.showError;
  useSavedChat(ready, historyRef, taintedRef, gateTaintedRef, showErrorRef);

  // ---------------------------------------------------------------------------
  // Bucle de fotogramas
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let dpr = window.devicePixelRatio || 1;
    const painter = new CanvasPainter(undefined, decor);
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      ctx.imageSmoothingEnabled = false;
      painter.reset();
    };
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
        invoke<RawCursor | null>("mascot_cursor")
          .then((c) => {
            rawCursorRef.current = c;
            if (c) {
              const p = toCss(c.x, c.y);
              cursorRef.current = { x: p.x, y: p.y, ctrl: c.ctrl };
            }
          })
          .catch(() => {
            /* sondeo por fotograma: se queda el último cursor y el siguiente lo vuelve a pedir */
          })
          .finally(() => {
            cursorBusy = false;
          });
      }

      const cur = cursorRef.current;
      const chatNow = chatRef.current;
      const S = eng.S;
      // Recién soltado el cursor del MCP, ese hover no es tuyo (driveHover.ts).
      const petHot =
        !!cur &&
        !hoverGuardRef.current.muted(now, cur) &&
        (() => {
          const b = eng.bounds(2 * S);
          return cur.x >= b.x && cur.x <= b.x + b.w && cur.y >= b.y && cur.y <= b.y + b.h;
        })();
      const btnRect = showButtonsRef.current ? (buttonsRef.current?.getBoundingClientRect() ?? null) : null;
      const panelRect = panelRef.current?.getBoundingClientRect() ?? null;
      const asking = approvalsRef.current.length > 0;
      const onButtons = !!cur && inside(btnRect, cur.x, cur.y, 6);
      const onPanel = !!cur && inside(panelRect, cur.x, cur.y, 4);
      const menuRect = menuOpenRef.current ? (menuRef.current?.getBoundingClientRect() ?? null) : null;
      const onMenu = !!cur && inside(menuRect, cur.x, cur.y, 6);
      const dragging = !!pressRef.current;

      // Ctrl+Alt+clic, mudanzas de monitor y llegada con un fichero.
      navRef.current?.tick(rawCursorRef.current, petHot || onButtons || onPanel || onMenu);

      // Si la ventana se mudó a mitad de arrastre, el puntero puede soltarse
      // fuera de ella: soltar también cuando el botón GLOBAL se levanta.
      const raw = rawCursorRef.current;
      if (pressRef.current?.dragging && raw && !raw.lbutton) {
        pressRef.current = null;
        eng.endDrag(raw.ctrl);
      }
      // Travesura con el cursor (el motor decide cuándo; aquí se tira de él).
      const prank = eng.takePrank();
      if (prank && raw && envRef.current) prankRef.current.start(raw, prank, envRef.current, now);
      prankRef.current.tick(raw, now);

      // El menú se cierra solo al alejarse.
      if (menuOpenRef.current && !onMenu && !petHot && raw?.lbutton) setMenuOpen(false);

      // Botones: aparecen al pasar por encima y aguantan un momento (no con
      // un bocadillo abierto: se taparían; «responder» ya está en él).
      if (petHot || onButtons) lastHoverRef.current = now;
      const wantButtons =
        !driveRef.current &&
        chatNow.phase === "closed" &&
        !asking &&
        !menuOpenRef.current &&
        !dragging &&
        eng.mode !== "drag" &&
        now - lastHoverRef.current < 900;
      if (wantButtons !== showButtonsRef.current) {
        showButtonsRef.current = wantButtons;
        setShowButtons(wantButtons);
      }

      // Una confirmación pendiente tiene que poder clicarse aunque Claude
      // esté «conduciendo» el ratón (espera parado a tu respuesta).
      setInteractive(
        isInteractive(
          quietRef.current,
          (asking && onPanel) || (!driveRef.current && (dragging || petHot || onButtons || onPanel || onMenu)),
        ),
      );

      // El bocadillo se va solo, salvo mientras lo estás leyendo.
      if ((chatNow.phase === "reply" || chatNow.phase === "error") && !driveRef.current) {
        if (onPanel || quietRef.current) replyDeadlineRef.current = Math.max(replyDeadlineRef.current, now + 3000);
        if (now > replyDeadlineRef.current) setChat({ phase: "closed" });
      }

      const chatState = chatStateOf(chatNow);
      eng.update({
        dt,
        cursor: cur,
        hovered: petHot || onButtons || onPanel,
        petHover: petHot && !dragging,
        chat: chatState,
      });
      painter.paint(ctx, eng, chatState, dpr);

      // Zona de clic sobre la mascota.
      const hit = hitRef.current;
      if (hit) {
        const b = eng.bounds(S);
        hit.style.transform = `translate(${b.x}px, ${b.y}px)`;
        hit.style.width = `${b.w}px`;
        hit.style.height = `${b.h}px`;
      }

      // Dónde soltarle ficheros (mascot/drop_assist.rs). Mismo margen que la
      // comprobación del drop, para que todo lo que Rust acepte llegue aquí.
      const envNow = envRef.current;
      const canDrop = !!envNow && !quietRef.current && !driveRef.current;
      petRectRef.current.publish(canDrop ? toPhysRect(eng.bounds(DROP_PAD * S), envNow) : null, now);

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
      const menu = menuRef.current;
      if (menu && menuOpenRef.current) {
        const w = menu.offsetWidth;
        let x = headX + eng.halfW + 10;
        if (x + w > W - 6) x = headX - eng.halfW - 10 - w;
        const y = Math.min(Math.max(headY - menu.offsetHeight / 2, 6), window.innerHeight - menu.offsetHeight - 6);
        menu.style.transform = `translate(${x}px, ${y}px)`;
      }
      const panel = panelRef.current;
      if (panel) {
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
  }, [ready, setChat, setInteractive, setMenuOpen, toCss, hoverGuardRef, decor]);

  // Ratón sobre la mascota (pointerPress.ts). Clic sin arrastrar: primero los
  // avisos pendientes (Sessions, builds); si no, saltito.
  const press = pressHandlers({
    pressRef,
    engineRef,
    driveRef,
    cursorRef,
    onClick: (eng) => {
      if (!sessionsWatch.takeClick() && !desk.takeClick()) eng.poke();
    },
  });

  // ---------------------------------------------------------------------------
  // Conversación
  // ---------------------------------------------------------------------------
  const openChat = (agent: AgentId, files: string[] = []) => {
    if (files.length) setAttachments([...new Set([...attachmentsRef.current, ...files])]);
    // Elegir a GPT o a Gemini le da celos (y se disfraza de su color).
    engineRef.current?.chooseAgent(agent);
    setChat({ phase: "input", agent });
    invoke("mascot_focus")
      .catch((e: unknown) =>
        showErrorRef.current(actionErrorText("No pude coger el teclado (haz clic en el cuadro de texto)", e)),
      )
      .finally(() => window.setTimeout(() => inputRef.current?.focus(), 30));
  };

  const send = async () => {
    const c = chatRef.current;
    const files = attachmentsRef.current;
    const retry: Retry = { draft: draft.trim(), files };
    const text = retry.draft || (files.length ? "¿Qué es esto? Resúmemelo." : "");
    if (c.phase !== "input" || !text) return;
    const agent = c.agent;
    // Una conversación que ha tocado un fichero adjunto queda marcada hasta
    // «nueva»: su historial podría arrastrar instrucciones inyectadas. Claude
    // y Codex conservan sus permisos y el prompt les avisa de que el fichero
    // es dato; Antigravity solo lee; los enlaces de la respuesta no se abren.
    if (files.length) taintedRef.current[agent] = true;
    const withFiles = taintedRef.current[agent];
    const history = historyRef.current[agent];
    const id = ++reqRef.current;
    const message = files.length
      ? `${text}\n\nFicheros adjuntos (rutas locales; léelos con Read):\n${files.map((f) => `- ${f}`).join("\n")}`
      : text;
    setDraft("");
    setAttachments([]);
    setChat({ phase: "thinking", agent, question: text });
    try {
      const r = await invoke<{ text: string; via: string; tainted: boolean }>("mascot_ask", {
        agent,
        history: modelHistory(history),
        message,
        // Con ficheros adjuntos (inyección de prompt: chat.rs).
        withFiles,
        tainted: gateTaintedRef.current[agent],
      });
      // Solo entra en el historial si la conversación sigue siendo la misma
      // (si pulsaste «nueva» mientras tanto, una respuesta sobre un fichero
      // no puede colarse en el historial limpio de la siguiente).
      if (historyRef.current[agent] === history) {
        const turns = appendExchange(history, text, r.text);
        historyRef.current[agent] = turns;
        if (withFiles) taintedRef.current[agent] = true;
        if (r.tainted) gateTaintedRef.current[agent] = true;
        const marks = { tainted: taintedRef.current[agent], gateTainted: gateTaintedRef.current[agent] };
        saveConversation({ agent, ...marks, turns }).catch((err) =>
          desk.showError(`No pude guardar el chat: ${String(err)}`),
        );
      }
      if (id === reqRef.current) {
        engineRef.current?.replyArrived(agent);
        setChat({ phase: "reply", agent, text: r.text, via: r.via, tainted: withFiles });
      }
    } catch (err) {
      if (id === reqRef.current) setChat({ phase: "error", agent, text: String(err), retry });
    }
  };

  const close = () => {
    reqRef.current++;
    setAttachments([]);
    setChat({ phase: "closed" });
  };

  openChatRef.current = openChat;

  // Ha llegado hasta un fichero (Ctrl+Alt+clic) o se lo han soltado encima:
  // lo coge y abre el chat con Claude, que es quien puede leerlo.
  fileArrivedRef.current = (path: string) => {
    engineRef.current?.grab(baseName(path));
    openChat("claude", [path]);
  };

  const onMenuPick = (action: MenuAction) => {
    setMenuOpen(false);
    if (action === "lastReply" && lastReplyRef.current) setChat(lastReplyRef.current);
    if (action === "agenda") desk.askAgenda();
    if (action === "settings") act("mascot_open_settings", undefined, "No se pudieron abrir los ajustes");
    if (action === "hide") act("mascot_set_hidden", { hidden: true }, "No me pude esconder");
    if (action === "close") {
      act("mascot_save_settings", { settings: { ...settingsRef.current, enabled: false } }, "No me pude apagar");
    }
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
  const asking = approvals.length > 0;
  // Mientras piensa, solo un minibocadillo con puntitos (clic = dejar de esperar).
  const mini = chat.phase === "thinking" && !asking;
  const showPanel = agentOf !== null || asking;

  return (
    <div className="mascot-layer">
      <canvas ref={canvasRef} className="mascot-canvas" />
      <NoticeBubble notice={desk.notice} engineRef={engineRef} />
      <div
        ref={hitRef}
        className="mascot-hit"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
        {...press}
      />

      {showButtons && (
        <div ref={buttonsRef} className="mascot-buttons">
          {AGENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              className="mascot-btn"
              style={{ background: agentBackground(a.id) }}
              aria-label={`Hablar con ${a.label}`}
              onClick={() => openChat(a.id)}
            >
              <AgentIcon id={a.id} />
            </button>
          ))}
        </div>
      )}

      {menuOpen && (
        <div ref={menuRef} className="mascot-menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
          <PetMenu onPick={onMenuPick} note={engineRef.current?.acts.catchSummary()} canReplay={lastReplyRef.current !== null} />
        </div>
      )}

      {showPanel && (
        <div
          ref={panelRef}
          className={mini ? "mascot-panel mascot-panel--mini" : "mascot-panel"}
          onClick={mini ? close : undefined}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {mini && <ThinkingDots />}

          {agentOf && !mini && (
            <ChatHead
              agent={agentOf}
              label={agentLabel(agentOf)}
              tainted={taintedRef.current[agentOf]}
              guarded={gateTaintedRef.current[agentOf]}
              turns={historyRef.current[agentOf].length}
              canReset={chat.phase === "input"}
              showLog={showLog}
              onToggleLog={() => setShowLog(!showLog)}
              onReset={() => {
                const agent = agentOf;
                historyRef.current[agent] = [];
                taintedRef.current[agent] = false;
                gateTaintedRef.current[agent] = false;
                setShowLog(false);
                setChat({ phase: "input", agent });
                archiveConversation(agent).catch((err) => desk.showError(`No pude archivar el chat: ${String(err)}`));
              }}
              onClose={close}
            />
          )}

          {showLog && agentOf && !mini && historyRef.current[agentOf].length > 0 && (
            <ChatTranscript turns={historyRef.current[agentOf]} linksEnabled={!taintedRef.current[agentOf]} />
          )}

          {approvals.map((a) => (
            <ApprovalCard key={a.id} a={a} onAnswer={(decision) => answerApproval(a, decision)} />
          ))}

          {chat.phase === "input" && (
            <>
              <AttachmentChips
                files={attachments}
                onRemove={(f) => setAttachments(attachments.filter((x) => x !== f))}
              />
              <MascotInputRow
                inputRef={inputRef}
                draft={draft}
                setDraft={setDraft}
                placeholder={
                  attachments.length
                    ? `¿Qué hago con ${attachments.length === 1 ? baseName(attachments[0]) : "esto"}? (Enter: resumirlo)`
                    : `Escribe a ${agentLabel(chat.agent)}… (Enter envía)`
                }
                canSend={!!draft.trim() || attachments.length > 0}
                onSend={() => void send()}
                onKeyDown={onKeyDown}
              />
            </>
          )}

          {chat.phase === "thinking" && asking && (
            <div className="mascot-thinking">
              esperando tu respuesta
              <span className="mascot-dots" />
            </div>
          )}

          {chat.phase === "reply" && (
            <>
              {!showLog && (
                <div className="mascot-reply">
                  <Linkified text={chat.text} linksEnabled={!chat.tainted} />
                </div>
              )}
              <div className="mascot-foot">
                <span className="mascot-via" title={chat.via}>
                  vía {chat.via}
                </span>
                <button
                  type="button"
                  className="mascot-link"
                  onClick={() => void copyText(navigator.clipboard, chat.text).then((err) => err && desk.showError(err))}
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
                <button
                  type="button"
                  className="mascot-link"
                  title="Vuelve a abrir el cuadro con el mismo mensaje y los mismos ficheros"
                  onClick={() => {
                    setDraft(chat.retry.draft);
                    openChat(chat.agent, chat.retry.files);
                  }}
                >
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
