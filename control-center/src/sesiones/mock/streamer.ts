// Simulador de turnos para el modo demo y el e2e, con el orden real del backend
// (§5.3, §5.4): dos pasos con su (step, block), la herramienta en vivo con
// `start` → mensaje con el `tool_use` → `end`, el mensaje del transcript de cada
// paso (con su `streamKey`) que llega ANTES del último delta, y el evento `turn`
// con el `usage` al cerrar. Interrumpir cierra el turno como `aborted`.

import type { Ask, AskAnswer, ChatMessage, SesionesEventName, SesionesEvents, SessionId, Usage } from "../types";

interface Deps {
  emit<K extends SesionesEventName>(event: K, payload: SesionesEvents[K]): void;
  addMessages(id: SessionId, list: ChatMessage[]): void;
  uid(prefix: string): string;
}

export interface ReplyOptions {
  chunkMs: number;
  tool?: { name: string; summary: string };
  /** Salida de la herramienta (por defecto, el resumen de vitest). */
  toolOutput?: string;
  onDone?: () => void;
  onAbort?: () => void;
  /** Se llama con el turnId al abrir el turno. */
  onStart?: (turnId: string) => void;
}

interface Running {
  timer: number;
  turnId: string;
  startedAt: string;
  sent: string;
  opts: ReplyOptions;
}

const USAGE: Usage = { input: 2400, output: 380, cacheRead: 96000, cacheWrite: 1800, cacheWrite5m: 0, cacheWrite1h: 1800 };
const SUB_USAGE: Usage = { input: 900, output: 210, cacheRead: 12000, cacheWrite: 0 };

/** Trocea en fragmentos de 2-7 caracteres para que el ritmo parezca real. */
export function chunkText(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  let n = 0;
  while (i < text.length) {
    n += 1;
    const size = 2 + ((n * 7) % 6);
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

/** Primer párrafo (paso 0) y el resto (paso 1). */
export function splitSteps(text: string): [string, string] {
  const at = text.indexOf("\n\n");
  return at === -1 ? ["", text] : [text.slice(0, at), text.slice(at + 2)];
}

export function createStreamer(deps: Deps) {
  const running = new Map<SessionId, Running>();
  const now = () => new Date().toISOString();
  const assistant = (r: Running, text: string, step: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    uuid: deps.uid("m"), role: "assistant", timestamp: now(), agentId: null, model: "claude-opus-5-5",
    blocks: text ? [{ kind: "text", text }] : [], streamKey: `${r.turnId}:main:${step}:0`, ...extra,
  });

  function closeTurn(id: SessionId, r: Running, reason: "answer" | "aborted"): void {
    window.clearInterval(r.timer);
    running.delete(id);
    deps.emit("sesiones://stream", { id, agentId: null, turnId: r.turnId, step: 1, block: 0, text: "", done: true, aborted: reason === "aborted" });
    const subagentUsage = r.opts.tool?.name === "Task" ? [SUB_USAGE] : undefined;
    deps.emit("sesiones://turn", { id, turnId: r.turnId, startedAt: r.startedAt, endedAt: now(), durationMs: Date.now() - Date.parse(r.startedAt), reason, usage: USAGE, subagentUsage });
  }

  /** Paso 0 completo: texto, herramienta en vivo, transcript del paso y fin de la herramienta. */
  function stepZero(id: SessionId, r: Running, text: string): void {
    const toolId = r.opts.tool ? deps.uid("tool") : null;
    if (text) deps.emit("sesiones://stream", { id, agentId: null, turnId: r.turnId, step: 0, block: 0, text, done: false, stepDone: true });
    if (!r.opts.tool || !toolId) {
      if (text) deps.addMessages(id, [assistant(r, text, 0)]);
      return;
    }
    const tool = r.opts.tool;
    deps.emit("sesiones://tool", { id, agentId: null, toolUseId: toolId, name: tool.name, summary: tool.summary, phase: "start" });
    window.setTimeout(() => {
      const use = assistant(r, text, 0);
      use.blocks = [...use.blocks, { kind: "toolUse", id: toolId, name: tool.name, input: { command: tool.summary }, summary: tool.summary }];
      deps.addMessages(id, [use, {
        uuid: deps.uid("m"), role: "user", timestamp: now(), agentId: null,
        blocks: [{ kind: "toolResult", toolUseId: toolId, isError: false, text: r.opts.toolOutput ?? "Test Files  4 passed (4)\n     Tests  31 passed (31)\n  Duration  1.84s" }],
      }]);
      deps.emit("sesiones://tool", { id, agentId: null, toolUseId: toolId, name: tool.name, summary: tool.summary, phase: "end", isError: false });
    }, 120);
  }

  function reply(id: SessionId, text: string, opts: ReplyOptions): void {
    if (running.has(id)) interrupt(id);
    const r: Running = { timer: 0, turnId: deps.uid("turn"), startedAt: now(), sent: "", opts };
    opts.onStart?.(r.turnId);
    const [first, rest] = splitSteps(text);
    stepZero(id, r, first);
    const chunks = chunkText(rest);
    let idx = 0;
    r.timer = window.setInterval(() => {
      if (idx === chunks.length - 1) {
        // El transcript del paso llega antes que el último delta (§5.3).
        deps.addMessages(id, [assistant(r, rest, 1)]);
      }
      if (idx >= chunks.length) {
        closeTurn(id, r, "answer");
        window.setTimeout(() => opts.onDone?.(), 60);
        return;
      }
      r.sent += chunks[idx];
      deps.emit("sesiones://stream", { id, agentId: null, turnId: r.turnId, step: 1, block: 0, text: chunks[idx], done: false });
      idx += 1;
    }, opts.chunkMs);
    running.set(id, r);
  }

  /** Corta el turno en curso: lo escrito queda en el transcript con la marca de interrupción. */
  function interrupt(id: SessionId): boolean {
    const r = running.get(id);
    if (!r) return false;
    if (r.sent) deps.addMessages(id, [assistant(r, r.sent, 1)]);
    deps.addMessages(id, [{ uuid: deps.uid("m"), role: "system", kind: "interrupted", timestamp: now(), agentId: null, blocks: [{ kind: "text", text: "[Request interrupted by user]" }] }]);
    closeTurn(id, r, "aborted");
    r.opts.onAbort?.();
    return true;
  }

  function isRunning(id: SessionId): boolean {
    return running.has(id);
  }

  function answerText(ask: Ask, answer: AskAnswer): string {
    if (answer.kind === "permission") {
      if (answer.decision === "deny") return `Entendido: no ejecuto \`${ask.kind === "permission" ? ask.summary : "la acción"}\`.${answer.reason ? ` Motivo: ${answer.reason}.` : ""}`;
      // Como el puente: solo hay regla guardada si el ask la anunciaba (`always`).
      const rules = ask.kind === "permission" && answer.decision === "allowAlways" ? ask.always?.rules ?? [] : [];
      const always = rules.length > 0 ? ` Regla guardada: ${rules.join(", ")}.` : "";
      return `Hecho.\n\nCommit creado:\n\n\`\`\`text\n[main 7c1e0a4] fix(mods): /uso se adapta a terminales estrechas\n 2 files changed, 53 insertions(+), 3 deletions(-)\n\`\`\`\n${always}`;
    }
    if (answer.kind === "question") {
      if (answer.rejected) return "Entendido.\n\nSigo sin esa respuesta.";
      const picks = Object.entries(answer.answers).map(([q, a]) => `- ${q} → **${a}**`).join("\n");
      return `Anotado:\n\n${picks}\n\nLo aplico ahora.`;
    }
    if (answer.decision === "approve") return `Plan aprobado.\n\nEmpiezo por el paso 1 en modo ${answer.mode ?? "previo"}.`;
    return `Ajusto el plan.\n\nCambios pedidos: ${answer.feedback ?? "sin detalle"}.`;
  }

  return { reply, interrupt, isRunning, answerText };
}
