// Tarjeta de un comando local (`/cost`, `/status`, `/config` cerrado…) o de un
// `!bash` (SC-10): el comando y su salida sin ANSI, desplegada por defecto y
// plegable. Nunca en crudo ni perdida.

import { formatClock } from "../../parse";
import type { ChatMessage } from "../../types";

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function commandTitle(m: ChatMessage): string {
  const c = m.command;
  if (c) return m.kind === "bash" ? `!${c.name}${c.args ? ` ${c.args}` : ""}` : `/${c.name}${c.args ? ` ${c.args}` : ""}`;
  const text = m.blocks.map((b) => (b.kind === "text" ? b.text : "")).join(" ").trim();
  return text.split("\n")[0] || (m.kind === "bash" ? "!bash" : "/comando");
}

export function CommandCard({ m }: { m: ChatMessage }) {
  const out = (m.command?.stdout ?? "").replace(ANSI, "").replace(/\s+$/, "");
  const isError = Boolean(m.command?.isError);
  return (
    <details className={`msg command${isError ? " err" : ""}`} open data-role="command" data-testid="command-card">
      <summary>
        <span className="mk prompt" aria-hidden="true">❯</span> <span className="mono">{commandTitle(m)}</span>
        {isError && <span className="err-text"> · error</span>}
        <time className="ts" dateTime={m.timestamp}>{formatClock(m.timestamp)}</time>
      </summary>
      {out ? <pre className="cmd-out">{out}</pre> : <p className="faint cmd-out">Sin salida.</p>}
    </details>
  );
}
