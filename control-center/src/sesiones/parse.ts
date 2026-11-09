// Utilidades puras sobre mensajes normalizados: agrupación para pintar,
// índice de resultados de herramientas, estadísticas de diff y estimación
// del reparto del contexto.

import type { Block, ChatMessage } from "./types";

export type ToolUseBlock = Extract<Block, { kind: "toolUse" }>;
export type ToolResultBlock = Extract<Block, { kind: "toolResult" }>;

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "image"; block: Extract<Block, { kind: "image" }> }
  | { kind: "tools"; tools: ToolUseBlock[] };

/** Agrupa los bloques de un mensaje: herramientas consecutivas van juntas. */
export function segmentBlocks(blocks: readonly Block[]): Segment[] {
  const out: Segment[] = [];
  for (const b of blocks) {
    if (b.kind === "toolResult") continue;
    if (b.kind === "toolUse") {
      const last = out[out.length - 1];
      if (last && last.kind === "tools") {
        out[out.length - 1] = { kind: "tools", tools: [...last.tools, b] };
      } else {
        out.push({ kind: "tools", tools: [b] });
      }
      continue;
    }
    if (b.kind === "image") out.push({ kind: "image", block: b });
    else out.push({ kind: b.kind, text: b.text });
  }
  return out;
}

export function buildResultIndex(messages: readonly ChatMessage[]): Map<string, ToolResultBlock> {
  const index = new Map<string, ToolResultBlock>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind === "toolResult") index.set(b.toolUseId, b);
    }
  }
  return index;
}

/** Un mensaje de usuario que solo trae resultados de herramientas no se pinta como burbuja. */
export function isToolResultOnly(m: ChatMessage): boolean {
  return m.blocks.length > 0 && m.blocks.every((b) => b.kind === "toolResult");
}

export function visibleMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => !isToolResultOnly(m) && m.blocks.length > 0);
}

/** Fusiona mensajes por uuid sin duplicar y respetando el orden de llegada. */
export function mergeMessages(prev: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return prev as ChatMessage[];
  const seen = new Map(prev.map((m, i) => [m.uuid, i]));
  const next = [...prev];
  for (const m of incoming) {
    const at = seen.get(m.uuid);
    if (at === undefined) {
      seen.set(m.uuid, next.length);
      next.push(m);
    } else {
      next[at] = m;
    }
  }
  return next;
}

/** El texto en vivo llega en deltas (contrato, cambios del backend): se acumula. */
export function mergeStreamText(prev: string, incoming: string): string {
  return incoming ? prev + incoming : prev;
}

// ---------------------------------------------------------------------------
// Herramientas
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function lineCount(s: string): number {
  if (!s) return 0;
  return s.replace(/\n$/, "").split("\n").length;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function toolDiffStats(name: string, input: unknown): DiffStats | null {
  const i = asRecord(input);
  if (name === "Edit") return { added: lineCount(str(i.new_string)), removed: lineCount(str(i.old_string)) };
  if (name === "Write") return { added: lineCount(str(i.content)), removed: 0 };
  if (name === "MultiEdit" && Array.isArray(i.edits)) {
    return i.edits.reduce<DiffStats>(
      (acc, e) => {
        const r = asRecord(e);
        return { added: acc.added + lineCount(str(r.new_string)), removed: acc.removed + lineCount(str(r.old_string)) };
      },
      { added: 0, removed: 0 },
    );
  }
  return null;
}

export type DiffLine = { kind: "add" | "del" | "ctx" | "hunk"; text: string };

export function toolDiffLines(name: string, input: unknown): DiffLine[] {
  const i = asRecord(input);
  const pairs: { o: string; n: string }[] = [];
  if (name === "Edit") pairs.push({ o: str(i.old_string), n: str(i.new_string) });
  else if (name === "Write") pairs.push({ o: "", n: str(i.content) });
  else if (name === "MultiEdit" && Array.isArray(i.edits)) {
    for (const e of i.edits) pairs.push({ o: str(asRecord(e).old_string), n: str(asRecord(e).new_string) });
  }
  const out: DiffLine[] = [];
  pairs.forEach((p, idx) => {
    if (pairs.length > 1) out.push({ kind: "hunk", text: `@@ edición ${idx + 1} @@` });
    if (p.o) p.o.replace(/\n$/, "").split("\n").forEach((t) => out.push({ kind: "del", text: t }));
    if (p.n) p.n.replace(/\n$/, "").split("\n").forEach((t) => out.push({ kind: "add", text: t }));
  });
  return out;
}

/** Resumen de una línea para la fila de herramienta cuando el backend no lo trae. */
export function toolSummary(name: string, input: unknown): string {
  const i = asRecord(input);
  const candidates = [i.file_path, i.path, i.command, i.pattern, i.url, i.description, i.prompt];
  const first = candidates.find((c) => typeof c === "string" && c.length > 0);
  if (typeof first === "string") return first.split("\n")[0];
  return name;
}

// ---------------------------------------------------------------------------
// Contexto
// ---------------------------------------------------------------------------

export interface ContextSlice {
  key: "system" | "reads" | "tools" | "messages" | "thinking";
  label: string;
  tokens: number;
}

const CHARS_PER_TOKEN = 4;

/**
 * Estimación del reparto del contexto por categoría. El total real viene del
 * puente (`contextTokens`); las proporciones salen del texto del transcript y
 * el resto se atribuye a sistema, CLAUDE.md y skills.
 */
export function estimateContext(messages: readonly ChatMessage[], totalTokens: number): ContextSlice[] {
  const toolNames = new Map<string, string>();
  const acc = { reads: 0, tools: 0, messages: 0, thinking: 0 };
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind === "toolUse") {
        toolNames.set(b.id, b.name);
        acc.tools += JSON.stringify(b.input ?? "").length / CHARS_PER_TOKEN;
      } else if (b.kind === "toolResult") {
        const t = b.text.length / CHARS_PER_TOKEN;
        if (toolNames.get(b.toolUseId) === "Read") acc.reads += t;
        else acc.tools += t;
      } else if (b.kind === "text") acc.messages += b.text.length / CHARS_PER_TOKEN;
      else if (b.kind === "thinking") acc.thinking += b.text.length / CHARS_PER_TOKEN;
    }
  }
  const counted = acc.reads + acc.tools + acc.messages + acc.thinking;
  const scale = counted > totalTokens && counted > 0 ? totalTokens / counted : 1;
  const r = (n: number) => Math.round(n * scale);
  const parts = { reads: r(acc.reads), tools: r(acc.tools), messages: r(acc.messages), thinking: r(acc.thinking) };
  const system = Math.max(0, totalTokens - parts.reads - parts.tools - parts.messages - parts.thinking);
  return [
    { key: "system", label: "Sistema, skills y no desglosado", tokens: system },
    { key: "reads", label: "Lecturas de ficheros", tokens: parts.reads },
    { key: "tools", label: "Herramientas y salidas", tokens: parts.tools },
    { key: "messages", label: "Mensajes", tokens: parts.messages },
    { key: "thinking", label: "Razonamiento", tokens: parts.thinking },
  ];
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

export function formatAgo(iso: string, now: number = Date.now()): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "";
  const min = Math.round((now - d) / 60000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const days = Math.round(h / 24);
  return days === 1 ? "ayer" : `hace ${days} días`;
}
