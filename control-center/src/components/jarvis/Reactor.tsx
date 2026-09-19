// mar.ia — el reactor.
//
// Anillos concentricos contrarrotantes con marcas de tick alrededor de un
// nucleo brillante: el motivo central del HUD de Iron Man (Prologue Films,
// 2008). SVG y CSS, sin lienzo ni dependencias: se usa a 28 px en el rail y a
// 240 px en la pantalla de inicio, y tiene que escalar sin pixelarse.
//
// El color y la velocidad los decide `state`, que es el mismo vocabulario que
// habla el sidecar de voz.

import type { CSSProperties } from "react";

export type ReactorState = "idle" | "listening" | "thinking" | "speaking" | "offline";

/** Color del nucleo por estado. Ambar = atencion, violeta = trabajando. */
const STATE_COLOR: Record<ReactorState, string> = {
  idle: "var(--color-accent)",
  listening: "#7ef2ff",
  thinking: "#b388ff",
  // Verde-cian: el acento normal ya lo usa el reposo, y hablar tiene que
  // distinguirse de un vistazo.
  speaking: "#6ff5d0",
  offline: "var(--color-text-faint)",
};

/** Marcas de tick del anillo exterior, como una escala de instrumento. */
function ticks(count: number, r1: number, r2: number, width = 1) {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return (
      <line
        key={i}
        x1={50 + cos * r1}
        y1={50 + sin * r1}
        x2={50 + cos * r2}
        y2={50 + sin * r2}
        stroke="currentColor"
        strokeWidth={width}
        // Un tick de cada cuatro mas marcado: da lectura de escala.
        opacity={i % 4 === 0 ? 0.85 : 0.35}
      />
    );
  });
}

export function Reactor({
  size = 28,
  state = "idle",
  style,
}: {
  size?: number;
  state?: ReactorState;
  style?: CSSProperties;
}) {
  const color = STATE_COLOR[state];
  const still = state === "offline";
  const hablando = state === "speaking";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={`reactor: ${state}`}
      style={{ color, filter: `drop-shadow(0 0 ${size / 6}px ${color})`, ...style }}
    >
      {/* Anillo exterior: discontinuo y lento. */}
      <g className={still ? undefined : "hud-ring-slow"}>
        <circle
          cx="50" cy="50" r="46"
          fill="none" stroke="currentColor" strokeWidth="1.5"
          strokeDasharray="10 6" opacity="0.55"
        />
      </g>
      {/* Escala de ticks, girando al reves. */}
      <g className={still ? undefined : "hud-ring-back"} opacity="0.8">
        {ticks(36, 36, 41)}
      </g>
      {/* Anillo interior rapido, con un hueco: la parte que "procesa". */}
      <g className={still ? undefined : "hud-ring-fast"}>
        <circle
          cx="50" cy="50" r="29"
          fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeDasharray="120 62" strokeLinecap="round" opacity="0.9"
        />
      </g>
      {/* Al hablar: dos ondas que salen del nucleo. Sin esto, hablar y
          escuchar se veian igual — solo cambiaba el color, y el acento es el
          mismo en los dos. */}
      {hablando && (
        <g fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="50" cy="50" r="20" className="hud-onda" opacity="0.7" />
          <circle cx="50" cy="50" r="20" className="hud-onda hud-onda-2" opacity="0.5" />
        </g>
      )}
      {/* Nucleo. */}
      <circle cx="50" cy="50" r="17" fill="currentColor" opacity="0.18" />
      <circle
        cx="50" cy="50" r="10" fill="currentColor"
        className={still ? undefined : hablando ? "hud-pulse-rapido" : "hud-pulse"}
      />
      <circle cx="50" cy="50" r="4.5" fill="#ffffff" opacity="0.9" />
    </svg>
  );
}
