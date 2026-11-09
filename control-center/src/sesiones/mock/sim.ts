// Backend simulado de la demo y del e2e, alineado con el real (SC-18, F17):
// la sesión solo cambia de estado por lo que pasaría en la CLI. Un `/cost` no
// abre turno; Esc solo pone idle si había turno; las preguntas no se reenvían
// solas (se recuperan con `pending_asks`); la cola vive aquí, una por sesión,
// idempotente por `clientId`, y se drena de uno en uno al terminar cada turno.
// Escenarios por palabra clave del prompt: «permiso», «edición» (permiso de Edit con diff), «plan», «pregunta»,
// «varias», «menú», «colgado», «falla» (escritura fallida al drenar) y
// «herramienta larga» (un Bash en primer plano que «Segundo plano» mueve).

import type {
  Ask, ChatMessage, CommandOutcome, QueueItem, QueueItemInput, RecoverAction, RecoverOutcome, SesionesEventName, SesionesEvents, SessionId, SessionInfo, WaitInfo,
} from "../types";
import { createMenus } from "./menus";
import { createStreamer } from "./streamer";
import { replyFor } from "./texts";

export interface SimDeps {
  emit<K extends SesionesEventName>(event: K, payload: SesionesEvents[K]): void;
  addMessages(id: SessionId, list: ChatMessage[]): void;
  uid(prefix: string): string;
  sessions(): SessionInfo[];
  patch(id: SessionId, change: Partial<SessionInfo>): void;
  asks: Map<string, Ask>;
  emitPty?(id: SessionId, text: string): void;
}

function now(): string {
  return new Date().toISOString();
}

export function createSim(deps: SimDeps) {
  const streamer = createStreamer(deps);
  const queues = new Map<SessionId, QueueItem[]>();
  const failOnce = new Set<string>();
  const info = (id: SessionId) => deps.sessions().find((s) => s.id === id);

  function emitQueue(id: SessionId): QueueItem[] {
    const items = [...(queues.get(id) ?? [])];
    deps.emit("sesiones://queue", { id, items });
    return items;
  }

  function setItem(id: SessionId, clientId: string, change: Partial<QueueItem>): void {
    queues.set(id, (queues.get(id) ?? []).map((q) => (q.clientId === clientId ? { ...q, ...change } : q)));
    emitQueue(id);
  }

  function idle(id: SessionId): void {
    deps.patch(id, { status: "idle", waiting: null, stalled: null, turnId: null, workingSince: null, screen: "prompt" });
    window.setTimeout(() => drain(id), 300);
  }

  function working(id: SessionId, turnId: string | null): void {
    const s = info(id);
    deps.patch(id, { status: "working", waiting: null, turnId, screen: "busy", workingSince: s?.workingSince ?? now() });
  }

  function wait(id: SessionId, waiting: WaitInfo, screen: SessionInfo["screen"] = "prompt"): void {
    deps.patch(id, { status: "waiting", waiting, screen });
  }

  function openAsk(id: SessionId, prompt: string): boolean {
    const lower = prompt.toLowerCase();
    let ask: Ask | null = null;
    if (lower.includes("plan")) {
      ask = { askId: deps.uid("ask"), id, kind: "plan", plan: "## Plan\n\n1. Extraer `ResizeObserver` a un hook.\n2. Recalcular columnas con `fit()`.\n3. Tests de 80, 120 y 180 columnas." };
    } else if (/pregunta|opci[oó]n|elige|varias/.test(lower)) {
      ask = {
        askId: deps.uid("ask"), id, kind: "question",
        questions: [{
          question: "¿Qué hago con el ritmo por debajo de 72 columnas?", header: "Ritmo", multiSelect: lower.includes("varias"),
          options: [{ label: "Ocultarlo", description: "Solo barra y porcentaje" }, { label: "Segunda línea", description: "Como ahora en 80 columnas" }, { label: "Abreviarlo", description: "«1,4 %/h» sin texto" }],
        }],
      };
    } else if (lower.includes("edición") || lower.includes("edicion")) {
      ask = {
        askId: deps.uid("ask"), id, kind: "permission", tool: "Edit", agentId: null,
        input: {
          file_path: "src/render/shadows.cpp",
          old_string: "float bias = 0.005f;\nfloat shadow = texture(shadowMap, uv).r;",
          new_string: "float bias = max(0.05f * (1.0f - dot(n, l)), 0.005f);\nfloat shadow = pcf(shadowMap, uv, bias);\n// PCF 3x3: suaviza el borde",
        },
        summary: "src/render/shadows.cpp",
        reason: "Edit quiere modificar src/render/shadows.cpp",
      };
    } else if (lower.includes("permiso")) {
      ask = {
        askId: deps.uid("ask"), id, kind: "permission", tool: "Bash", agentId: null,
        input: { command: "git commit -m \"fix(mods): /uso se adapta a terminales estrechas\"" },
        summary: "git commit -m \"fix(mods): /uso se adapta a terminales estrechas\"",
        reason: `Bash quiere ejecutar en ${info(id)?.cwd ?? "el proyecto"}`,
      };
    }
    if (!ask) return false;
    deps.asks.set(ask.askId, ask);
    wait(id, { kind: ask.kind, askId: ask.askId, label: ask.kind === "permission" ? `permiso ${ask.tool}` : ask.kind, since: now() });
    deps.emit("sesiones://ask", { ...ask, createdAt: now() });
    return true;
  }

  /** Bash en primer plano sin fin propio: solo lo cierran «Segundo plano» o Interrumpir. */
  function longTool(id: SessionId): void {
    const tool = { toolUseId: deps.uid("tool"), name: "Bash", since: now(), backgroundable: true };
    deps.emit("sesiones://tool", { id, agentId: null, toolUseId: tool.toolUseId, name: tool.name, summary: "Start-Sleep 600", phase: "start" });
    deps.patch(id, { foregroundTool: tool });
  }

  /** Ctrl+B simulado: la herramienta sale del primer plano y Claude sigue con el turno. */
  function backgroundTool(id: SessionId): void {
    const tool = info(id)?.foregroundTool;
    if (!tool) return;
    deps.emit("sesiones://tool", { id, agentId: null, toolUseId: tool.toolUseId, name: tool.name, summary: "Start-Sleep 600", phase: "end", isError: false });
    deps.patch(id, { foregroundTool: null });
    streamer.reply(id, "Sigue en segundo plano.\n\nTe aviso cuando termine.", { chunkMs: 28, onStart: (turnId) => working(id, turnId), onDone: () => idle(id) });
  }

  function startTurn(id: SessionId, prompt: string): void {
    const lower = prompt.toLowerCase();
    working(id, null);
    if (lower.includes("herramienta larga")) {
      window.setTimeout(() => longTool(id), 300);
      return;
    }
    if (lower.includes("colgado")) {
      window.setTimeout(() => deps.patch(id, { stalled: { reason: "noEvents", since: new Date(Date.now() - 130000).toISOString(), detail: "" } }), 400);
      return;
    }
    if (lower.includes("menú") || lower.includes("menu") || lower.includes("diálogo")) {
      window.setTimeout(() => menus.open(id, "Diálogo de la TUI", [{ index: 0, label: "Sí", selected: true }, { index: 1, label: "No", selected: false }]), 500);
      return;
    }
    window.setTimeout(() => {
      streamer.reply(id, replyFor(prompt), {
        chunkMs: 28,
        tool: { name: "Bash", summary: "npm test -- --run sesiones" },
        toolOutput: lower.includes("salida larga") ? Array.from({ length: 200 }, (_, i) => `  ✓ caso ${i + 1}`).join("\n") : undefined,
        onStart: (turnId) => working(id, turnId),
        onDone: () => (openAsk(id, prompt) ? undefined : idle(id)),
      });
    }, 350);
  }

  /** Escribe un elemento: el mensaje del usuario lleva su `clientId` (emparejado por la cola). */
  function deliver(id: SessionId, item: QueueItem): void {
    setItem(id, item.clientId, { state: "sending", sentAt: now() });
    const blocks: ChatMessage["blocks"] = [{ kind: "text", text: item.text }];
    item.attachments.forEach((p) => blocks.push({ kind: "image", mediaType: "image/png", path: p }));
    window.setTimeout(() => {
      const uuid = deps.uid("u");
      deps.addMessages(id, [{ uuid, role: "user", kind: "prompt", timestamp: now(), agentId: null, blocks, clientId: item.clientId }]);
      setItem(id, item.clientId, { state: "delivered", messageUuid: uuid });
      startTurn(id, item.text);
    }, 120);
  }

  /** Un elemento por turno (decisión 2); un fallo de escritura lo deja en `failed` y para el drenaje. */
  function drain(id: SessionId): void {
    const s = info(id);
    if (s?.status !== "idle") return;
    const next = (queues.get(id) ?? []).find((q) => q.state === "queued");
    if (!next) return;
    if (next.text.toLowerCase().includes("falla") && !failOnce.has(next.clientId)) {
      failOnce.add(next.clientId);
      setItem(id, next.clientId, { state: "failed", error: "La escritura en el PTY falló (simulado)" });
      deps.emit("sesiones://notice", { id, level: "warn", text: "La cola se ha parado: un envío falló. Reinténtalo o edítalo." });
      return;
    }
    if (next.kind === "command") {
      setItem(id, next.clientId, { state: "delivered" });
      const [name, ...rest] = next.text.replace(/^\//, "").split(/\s+/);
      runCommand(id, name, rest.join(" "), next.clientId);
      return;
    }
    deliver(id, next);
  }

  function enqueue(id: SessionId, input: QueueItemInput): QueueItem[] {
    const list = queues.get(id) ?? [];
    if (!list.some((q) => q.clientId === input.clientId)) {
      queues.set(id, [...list, { ...input, origin: "ultron", state: "queued", createdAt: now() }]);
    }
    const items = emitQueue(id);
    drain(id);
    return items;
  }

  /** Cola nativa de la CLI: se absorbe a mitad de turno y no abre turno (§5.1 `queued`). */
  function absorb(id: SessionId, item: QueueItem): void {
    setItem(id, item.clientId, { state: "cliQueued", sentAt: now() });
    window.setTimeout(() => {
      setItem(id, item.clientId, { state: "absorbed" });
      const uuid = deps.uid("u");
      deps.addMessages(id, [{ uuid, role: "user", kind: "prompt", queued: true, timestamp: now(), agentId: null, blocks: [{ kind: "text", text: item.text }], clientId: item.clientId }]);
      setItem(id, item.clientId, { state: "delivered", messageUuid: uuid });
    }, 500);
  }

  const menus = createMenus({ ...deps, idle, wait, startTurn });
  const commands = menus.commands;

  function cancelAsks(id: SessionId, reason: "interrupted" | "sessionExited" | "restart"): void {
    for (const [askId, ask] of deps.asks) {
      if (ask.id !== id) continue;
      deps.asks.delete(askId);
      deps.emit("sesiones://ask-resolved", { askId, id, outcome: "cancelled", reason });
    }
  }

  /** Salida del proceso (AC-13): lo que estaba saliendo falla con el motivo; lo encolado se conserva. */
  function processExit(id: SessionId, code: number): void {
    cancelAsks(id, "sessionExited");
    queues.set(id, (queues.get(id) ?? []).map((q) => (q.state === "sending" ? { ...q, state: "failed" as const, error: "la sesión terminó" } : q)));
    emitQueue(id);
    deps.patch(id, { status: "exited", exitCode: code, waiting: null, stalled: null, turnId: null, workingSince: null, screen: "unknown", bridgeConnected: false });
  }

  const SPECIAL: Record<string, (id: SessionId) => void> = {
    exit: (id) => window.setTimeout(() => processExit(id, 0), 300),
    clear: (id) => {
      const sid = deps.uid("conv");
      deps.patch(id, { claudeSessionId: sid });
      deps.emit("sesiones://reset", { id, claudeSessionId: sid });
    },
  };

  function runCommand(id: SessionId, command: string, args: string, clientId: string): CommandOutcome {
    const s = info(id);
    if (!s || s.status === "exited") throw new Error("la sesión terminó");
    if (s.status !== "idle") {
      enqueue(id, { clientId, text: `/${command}${args ? ` ${args}` : ""}`, attachments: [], delegate: false, kind: "command" });
      return { disposition: "queued" };
    }
    const special = SPECIAL[command];
    if (special) {
      special(id);
      return { disposition: "written" };
    }
    return commands.run(id, command, args);
  }

  function interrupt(id: SessionId): RecoverOutcome {
    const s = info(id);
    const status = s?.status ?? "exited";
    if (s?.status === "working" || (s?.status === "waiting" && s.waiting?.kind !== "menu")) {
      const streamed = streamer.interrupt(id);
      // El abort cierra la pregunta en el mod (modAborted); el turno sale como aborted.
      cancelAsks(id, "interrupted");
      if (!streamed) deps.emit("sesiones://turn", { id, turnId: s.turnId ?? deps.uid("turn"), startedAt: s.workingSince ?? now(), endedAt: now(), durationMs: 1, reason: "aborted" });
      deps.patch(id, { status: "idle", waiting: null, stalled: null, turnId: null, workingSince: null, screen: "prompt", foregroundTool: null });
      return { ok: true, action: "interrupt", steps: ["turn.abort"], status: "idle" };
    }
    return { ok: false, action: "interrupt", steps: ["sinTurno"], status };
  }

  function recover(id: SessionId, action: RecoverAction): RecoverOutcome {
    if (action === "interrupt") return interrupt(id);
    if (action === "exitMenu") {
      const ok = menus.key(id, "\x1b");
      return { ok, action, steps: ok ? ["escape"] : ["sinMenú"], status: info(id)?.status ?? "exited" };
    }
    cancelAsks(id, "restart");
    // Como el backend: el proceso relanzado no tiene puente hasta su hello.
    deps.patch(id, { status: "starting", exitCode: null, waiting: null, stalled: null, screen: "unknown", bridgeConnected: false, bridgeProtocol: 0 });
    window.setTimeout(() => {
      deps.patch(id, { bridgeConnected: true, bridgeProtocol: 2 });
      idle(id);
    }, 900);
    return { ok: true, action, steps: ["kill", "resume"], status: "starting" };
  }

  return {
    streamer, queues, emitQueue, setItem, idle, working, wait, startTurn, deliver, drain, enqueue, absorb, menus, commands, openAsk, runCommand, recover,
    processExit, cancelAsks, backgroundTool,
  };
}

export type Sim = ReturnType<typeof createSim>;
