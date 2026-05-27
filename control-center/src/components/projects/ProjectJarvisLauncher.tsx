// ULTRON Control Center 2.0 — ProjectJarvisLauncher
//
// Workflow tipo Jarvis al abrir un proyecto: el usuario elige su intención de
// trabajo y el componente emite un JarvisIntent listo para ser inyectado como
// prompt seed en una sesión PTY o disparado como workflow multi-agente.
//
// Intenciones disponibles (grid 2×3):
//   fix          → diagnóstico + fix de errores conocidos
//   new-feature  → TDD + planning desde cero
//   recall       → contexto del último workday
//   team         → dispatch multi-agent (review + sec + arch)
//   free         → sesión Claude vanilla sin preset
//   research     → WebSearch + WebFetch + docs lookup

import React, { useState } from "react";

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export type JarvisIntentId =
  | "fix"
  | "new-feature"
  | "recall"
  | "team"
  | "free"
  | "research";

export type JarvisIntent = {
  id: JarvisIntentId;
  label: string;
  provider: "claude" | "codex" | "gemini";
  initial_prompt: string;
  spawn_kind: "pty" | "workflow";
};

export type ProjectJarvisLauncherProps = {
  projectId: string;
  projectPath: string | null;
  projectName: string;
  onIntentSelected: (intent: JarvisIntent) => void;
};

// ---------------------------------------------------------------------------
// Datos de cada intent
// ---------------------------------------------------------------------------

type IntentConfig = JarvisIntent & {
  description: string;
  Icon: React.FC<IconProps>;
  accentRgb: string; // RGB sin alpha, usado para bg, border y glow
};

type IconProps = { size?: number };

const INTENTS: IntentConfig[] = [
  {
    id: "fix",
    label: "Corregir errores",
    description: "Diagnóstico + fix de errores conocidos del proyecto",
    provider: "claude",
    spawn_kind: "pty",
    initial_prompt:
      "Analiza errores conocidos del proyecto. Empieza por: leer CLAUDE.md, git log -10, lint/typecheck si aplica. Reporta top 3 issues a priorizar.",
    accentRgb: "239,68,68",
    Icon: IconBug,
  },
  {
    id: "new-feature",
    label: "Desarrollar desde 0",
    description: "Iniciar feature nueva con TDD + planning",
    provider: "claude",
    spawn_kind: "pty",
    initial_prompt:
      "Vamos a desarrollar una feature nueva. Usa la skill brainstorming primero — necesito refinar la idea antes de tocar código. ¿Qué feature tienes en mente?",
    accentRgb: "6,182,212",
    Icon: IconSparkles,
  },
  {
    id: "recall",
    label: "Recuperar de ayer",
    description: "Spawn Claude con context recall del último workday",
    provider: "claude",
    spawn_kind: "pty",
    initial_prompt:
      "Recupera el contexto del último workday. Lee mem0 search query=cwd últimas 24h, git log --since=24h, kanban In Progress. Resume y propón siguiente acción.",
    accentRgb: "245,158,11",
    Icon: IconHistory,
  },
  {
    id: "team",
    label: "Equipo de subagentes",
    description: "Dispatch multi-agent workflow (review + tests + docs)",
    provider: "claude",
    spawn_kind: "workflow",
    initial_prompt:
      "Dispatch multi-agent: code-reviewer + security-auditor + architect-reviewer en paralelo sobre cambios uncommitted. Sintetiza findings.",
    accentRgb: "139,92,246",
    Icon: IconUsers,
  },
  {
    id: "free",
    label: "Free prompt",
    description: "Sesión Claude vanilla sin preset",
    provider: "claude",
    spawn_kind: "pty",
    initial_prompt: "",
    accentRgb: "132,204,22",
    Icon: IconMessageSquare,
  },
  {
    id: "research",
    label: "Investigar",
    description: "WebSearch + WebFetch + docs lookup",
    provider: "claude",
    spawn_kind: "pty",
    initial_prompt:
      "Necesito investigar algo. ¿Sobre qué tema? Voy a usar WebSearch + WebFetch + Context7 + Exa.",
    accentRgb: "59,130,246",
    Icon: IconSearch,
  },
];

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

export default function ProjectJarvisLauncher({
  projectName,
  onIntentSelected,
}: ProjectJarvisLauncherProps) {
  const [hovered, setHovered] = useState<JarvisIntentId | null>(null);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        minHeight: "100%",
        padding: "40px 32px 48px",
        background: "#000000",
        overflowY: "auto",
      }}
    >
      {/* ------------------------------------------------------------------ */}
      {/* Hero greeting                                                        */}
      {/* ------------------------------------------------------------------ */}
      <div
        style={{
          textAlign: "center",
          marginBottom: 40,
          maxWidth: 520,
        }}
      >
        <p
          style={{
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.30)",
            marginBottom: 10,
          }}
        >
          ULTRON Control Center
        </p>
        <h1
          style={{
            fontSize: 24,
            fontWeight: 700,
            lineHeight: 1.25,
            color: "var(--color-text, #f0f0f0)",
            margin: "0 0 10px",
            letterSpacing: "-0.01em",
          }}
        >
          Hola, USER.
        </h1>
        <p
          style={{
            fontSize: 15,
            color: "rgba(255,255,255,0.50)",
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          ¿Qué quieres hacer hoy en{" "}
          <span
            style={{
              color: "var(--color-accent, #a78bfa)",
              fontWeight: 600,
            }}
          >
            {projectName}
          </span>
          ?
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Grid 2×3 de IntentCards                                             */}
      {/* ------------------------------------------------------------------ */}
      <div
        role="list"
        aria-label="Opciones de inicio de sesión"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 14,
          width: "100%",
          maxWidth: 680,
        }}
      >
        {INTENTS.map((intent) => {
          const isHovered = hovered === intent.id;
          return (
            <IntentCard
              key={intent.id}
              intent={intent}
              isHovered={isHovered}
              onMouseEnter={() => setHovered(intent.id)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => {
                const { Icon: _Icon, description: _desc, accentRgb: _rgb, ...payload } = intent;
                onIntentSelected(payload);
              }}
            />
          );
        })}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Footer hint                                                          */}
      {/* ------------------------------------------------------------------ */}
      <p
        style={{
          marginTop: 32,
          fontSize: 11,
          color: "rgba(255,255,255,0.18)",
          textAlign: "center",
        }}
      >
        Puedes cambiar el prompt antes de iniciar la sesión.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IntentCard — card individual con hover lift + glow sutil
// ---------------------------------------------------------------------------

type IntentCardProps = {
  intent: IntentConfig;
  isHovered: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClick: () => void;
};

function IntentCard({
  intent,
  isHovered,
  onMouseEnter,
  onMouseLeave,
  onClick,
}: IntentCardProps) {
  const { label, description, Icon, accentRgb, spawn_kind } = intent;

  return (
    <button
      role="listitem"
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      aria-label={`${label}: ${description}`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 10,
        padding: "18px 20px",
        borderRadius: 10,
        border: `1px solid ${
          isHovered
            ? `rgba(${accentRgb},0.40)`
            : "rgba(255,255,255,0.08)"
        }`,
        background: isHovered
          ? `rgba(${accentRgb},0.06)`
          : "rgba(255,255,255,0.03)",
        cursor: "pointer",
        textAlign: "left",
        transition: "border-color 140ms ease, background 140ms ease, transform 140ms ease, box-shadow 140ms ease",
        transform: isHovered ? "translateY(-2px)" : "translateY(0)",
        boxShadow: isHovered
          ? `0 4px 24px rgba(${accentRgb},0.12), 0 1px 4px rgba(0,0,0,0.40)`
          : "0 1px 3px rgba(0,0,0,0.30)",
        outline: "none",
      }}
    >
      {/* Icon badge */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 36,
          height: 36,
          borderRadius: 8,
          background: `rgba(${accentRgb},0.12)`,
          border: `1px solid rgba(${accentRgb},0.20)`,
          color: `rgb(${accentRgb})`,
          flexShrink: 0,
          transition: "background 140ms ease, border-color 140ms ease",
        }}
        aria-hidden
      >
        <Icon size={18} />
      </div>

      {/* Text block */}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 4,
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: isHovered
                ? `rgb(${accentRgb})`
                : "var(--color-text, #f0f0f0)",
              transition: "color 140ms ease",
              letterSpacing: "-0.01em",
            }}
          >
            {label}
          </span>
          {spawn_kind === "workflow" && (
            <SpawnBadge />
          )}
        </div>
        <p
          style={{
            fontSize: 11.5,
            color: "rgba(255,255,255,0.40)",
            margin: 0,
            lineHeight: 1.45,
          }}
        >
          {description}
        </p>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// SpawnBadge — chip pequeño para cards de tipo workflow
// ---------------------------------------------------------------------------

function SpawnBadge() {
  return (
    <span
      style={{
        fontSize: 9.5,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        padding: "1px 5px",
        borderRadius: 4,
        background: "rgba(139,92,246,0.15)",
        border: "1px solid rgba(139,92,246,0.30)",
        color: "rgb(167,139,250)",
        lineHeight: 1.6,
      }}
    >
      multi-agent
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inline SVG icons — mismo patrón que projects/icons.tsx
// (evitamos lucide-react para mantener bundle reducido)
// ---------------------------------------------------------------------------

const svgBase = (size = 18) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24" as const,
  fill: "none" as const,
  stroke: "currentColor" as const,
  strokeWidth: 2 as const,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
});

function IconBug({ size }: IconProps) {
  return (
    <svg {...svgBase(size)}>
      <path d="M8 2c0 0 1.5 2 4 2s4-2 4-2" />
      <path d="M9 9h6" />
      <path d="M10 13h4" />
      <path d="M5 8l-2-2" />
      <path d="M19 8l2-2" />
      <path d="M3 14h2" />
      <path d="M19 14h2" />
      <path d="M5 20l-1 2" />
      <path d="M19 20l1 2" />
      <rect x="8" y="6" width="8" height="14" rx="4" />
    </svg>
  );
}

function IconSparkles({ size }: IconProps) {
  return (
    <svg {...svgBase(size)}>
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" />
      <path d="M19 3l.75 2.25L22 6l-2.25.75L19 9l-.75-2.25L16 6l2.25-.75z" />
      <path d="M5 15l.6 1.8L7.4 17.4l-1.8.6L5 20l-.6-1.8L2.6 17.4l1.8-.6z" />
    </svg>
  );
}

function IconHistory({ size }: IconProps) {
  return (
    <svg {...svgBase(size)}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <polyline points="3 3 3 8 8 8" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function IconUsers({ size }: IconProps) {
  return (
    <svg {...svgBase(size)}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconMessageSquare({ size }: IconProps) {
  return (
    <svg {...svgBase(size)}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconSearch({ size }: IconProps) {
  return (
    <svg {...svgBase(size)}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
