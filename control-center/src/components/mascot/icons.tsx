// Mascota — iconos de los tres botones (dibujos propios, no logotipos).

export type AgentId = "claude" | "codex" | "antigravity";

export const AGENTS: { id: AgentId; label: string; color: string }[] = [
  { id: "claude", label: "Claude", color: "#D97757" },
  { id: "codex", label: "Codex", color: "#1F1F1F" },
  { id: "antigravity", label: "Antigravity", color: "#4285F4" },
];

export function AgentIcon({ id, size = 18 }: { id: AgentId; size?: number }) {
  if (id === "claude") {
    // Estallido de 8 rayos.
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
        {[0, 45, 90, 135].map((a) => (
          <rect key={a} x="9" y="2" width="2" height="16" rx="1" fill="#FFF7F0" transform={`rotate(${a} 10 10)`} />
        ))}
      </svg>
    );
  }
  if (id === "codex") {
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
        <path d="M4 6 L9 10 L4 14" stroke="#FFFFFF" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="10" y="13" width="7" height="2.2" rx="1" fill="#FFFFFF" />
      </svg>
    );
  }
  // Antigravity: flecha que sube.
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
      <path d="M10 3 L16 11 H12 V17 H8 V11 H4 Z" fill="#FFFFFF" />
    </svg>
  );
}

export function agentBackground(id: AgentId): string {
  if (id === "antigravity") return "linear-gradient(135deg, #4285F4 0%, #34A853 55%, #FBBC05 100%)";
  return AGENTS.find((a) => a.id === id)?.color ?? "#333";
}
