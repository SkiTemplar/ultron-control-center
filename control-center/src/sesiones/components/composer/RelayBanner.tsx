import type { RelayState, SendTarget } from "../../types";

/** Nombre visible del motor del relevo; OpenCode solo se usa con la API de Anthropic. */
export const RELAY_LABEL: Record<RelayState["activeEngine"], string> = { opencode: "Claude API", codex: "Codex", gemini: "Gemini" };

export function relayTarget(current: SendTarget, relay: RelayState | null, manuallyChosen: boolean): SendTarget {
  if (!relay || manuallyChosen) return current;
  if (relay.activeEngine === "opencode") return "opencode";
  return relay.activeEngine === "gemini" ? "gemini" : "codexLocal";
}

/** Texto de la vuelta: hora (con el día si no es hoy) o, sin hora conocida, vuelta manual. */
export function returnText(value?: string, now: Date = new Date()): string {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return "sin hora de reinicio conocida: la vuelta a Claude es manual («Volver a Claude ya»)";
  }
  const time = date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `Claude vuelve ~${time}`;
  const day = date.toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short" });
  return `Claude vuelve ~${day} ${time}`;
}

export function RelayBanner({ relay, onReturn, onGemini }: { relay: RelayState; onReturn: () => void; onGemini: () => void }) {
  const label = RELAY_LABEL[relay.activeEngine];
  return (
    <div className="relay-banner" data-testid="relay-banner">
      <div><b>Relevo: {label} sigue el trabajo</b> · {returnText(relay.returnAt)}</div>
      {relay.error && <div className="relay-error" role="alert">{relay.error}</div>}
      <div className="relay-actions">
        <button className="btn sm ghost" onClick={onReturn}>Volver a Claude ya</button>
        <button className="btn sm" disabled={relay.activeEngine === "gemini"} onClick={onGemini}>Pasar a Gemini</button>
      </div>
    </div>
  );
}
