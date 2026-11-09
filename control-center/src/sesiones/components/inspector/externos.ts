// Delegaciones de Claude en otras IAs por Bash (Codex, Antigravity, Gemini CLI):
// no pasan por Motores ni dejan transcript de subagente, así que el árbol de
// Agentes las saca de los `toolUse` de Bash y de su `toolResult`.
//
// Una delegación interrumpida (Esc, proceso muerto, reinicio) puede no dejar
// `toolResult` nunca. No se usa un plazo de reloj: el Bash en primer plano no
// pasa de 10 min, pero un plazo exigiría un temporizador y la marca de tiempo
// del transcript. Se usan dos señales que ya están en el estado: un turno
// posterior del mismo hilo (prompt nuevo o aviso de interrupción) y la sesión
// parada (`idle` o `exited`), en la que ningún Bash en primer plano sigue vivo.

import { opensTurn } from "../../timeline";
import type { ChatMessage, EngineId, SessionStatus } from "../../types";

export type ExternalStatus = "running" | "done" | "error" | "background" | "expired";

export interface ExternalRun {
  id: string;
  engine: EngineId;
  label: string;
  description: string;
  status: ExternalStatus;
}

/** Tope de filas: una sesión larga acumula muchas revisiones. */
export const EXTERNAL_MAX = 8;

// Inicio de orden: principio, tras `;`, `&&`, `|`, `(` o un `timeout N`.
const START = String.raw`(?:^|[;&|(]\s*|\btimeout\s+\S+\s+)`;

/**
 * Solo invocaciones que delegan trabajo: `codex --version`, `agy models` o un
 * `grep codex` no cuentan.
 */
const RULES: { engine: EngineId; label: string; re: RegExp }[] = [
  { engine: "codex", label: "Codex", re: /codex-companion\.mjs["']?\s+(?:task|review|adversarial-review|rescue)\b/ },
  { engine: "codex", label: "Codex", re: new RegExp(String.raw`${START}codex(?:\.exe|\.cmd)?\s+(?:exec|e|review)\b`) },
  { engine: "gemini", label: "AGY", re: new RegExp(String.raw`${START}(?:\S*[\\/])?agy(?:\.exe)?\s(?:.*\s)?(?:-p|--print)\b`) },
  { engine: "gemini", label: "Gemini", re: new RegExp(String.raw`${START}gemini(?:\.cmd)?\s(?:.*\s)?(?:-p|--prompt)\b`) },
  { engine: "opencode", label: "OpenCode", re: new RegExp(String.raw`${START}(?:\S*[\\/])?opencode(?:\.exe|\.cmd)?\s+run\b`) },
];

function matchRule(command: string) {
  return RULES.find((r) => command.split("\n").some((line) => r.re.test(line.trim()))) ?? null;
}

function bashInput(input: unknown): { command: string; description: string; background: boolean } | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.command !== "string") return null;
  return {
    command: o.command,
    description: typeof o.description === "string" && o.description.trim() ? o.description : o.command,
    background: o.run_in_background === true,
  };
}

/** Sesión sin turno en curso: un Bash sin resultado ya no va a terminar. */
const STOPPED: ReadonlySet<SessionStatus> = new Set(["idle", "exited"]);

const INTERRUPTED = /^\[Request interrupted by user/;

/** El hilo siguió después del índice `from`: el turno de la llamada acabó. */
function turnEndedAfter(messages: readonly ChatMessage[], from: number): boolean {
  const agentId = messages[from].agentId;
  for (let i = from + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.agentId !== agentId) continue;
    if (m.kind === "interrupted" || opensTurn(m)) return true;
    if (m.blocks.some((b) => b.kind === "text" && INTERRUPTED.test(b.text.trim()))) return true;
  }
  return false;
}

function statusOf(result: { isError: boolean } | undefined, background: boolean, isExpired: () => boolean): ExternalStatus {
  if (!result) return isExpired() ? "expired" : "running";
  if (result.isError) return "error";
  return background ? "background" : "done";
}

/**
 * Delegaciones a otras IAs en los mensajes cargados, de la más antigua a la
 * más reciente. `sessionStatus` permite caducar las que no tendrán resultado.
 */
export function externalRuns(messages: readonly ChatMessage[], sessionStatus?: SessionStatus): ExternalRun[] {
  const isStopped = sessionStatus !== undefined && STOPPED.has(sessionStatus);
  const results = new Map<string, { isError: boolean }>();
  for (const m of messages) {
    for (const b of m.blocks) if (b.kind === "toolResult") results.set(b.toolUseId, { isError: b.isError });
  }
  const runs: ExternalRun[] = [];
  messages.forEach((m, index) => {
    for (const b of m.blocks) {
      if (b.kind !== "toolUse" || b.name !== "Bash") continue;
      const input = bashInput(b.input);
      const rule = input && matchRule(input.command);
      if (!input || !rule) continue;
      runs.push({
        id: b.id,
        engine: rule.engine,
        label: rule.label,
        description: input.description,
        status: statusOf(results.get(b.id), input.background, () => isStopped || turnEndedAfter(messages, index)),
      });
    }
  });
  return runs.slice(-EXTERNAL_MAX);
}
