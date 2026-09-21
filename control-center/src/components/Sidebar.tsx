import { Fragment, useEffect } from "react";
import { Reactor } from "./jarvis/Reactor";
import type { GlobalStatus } from "../types";
import { statusColor, statusLabel } from "../lib/status";
import { useFeatures, type Features } from "../lib/features";

export type Tab =
  | "home"
  | "chat"
  | "terminals"
  | "mosaic"
  | "mcps"
  | "library"
  | "skills"
  | "agents"
  | "rules"
  | "projects"
  | "memory"
  | "notifications"
  | "conversations"
  | "sessions"
  | "usage"
  | "ai-router"
  | "system"
  | "settings";

type Item = {
  id: Tab;
  label: string;
  /** Si se indica, la entrada se oculta cuando features[featureKey] === false. */
  featureKey?: keyof Features;
};

// Tres bloques, sin grupo plegable: todo lo que aparece aqui se usa. Lo que
// no superaba ese liston (Panel, Notas, Planes, Aprender, Laboratorio,
// Novedades, Finanzas) se retiro en la reestructuracion de 2026-09-21; ver
// docs/AUDITORIA.md.
const SECTIONS: { heading: string; items: Item[] }[] = [
  {
    heading: "Asistente",
    items: [
      { id: "home", label: "mar.ia" },
      { id: "chat", label: "Chat" },
      { id: "conversations", label: "Conversaciones", featureKey: "sessions" },
      { id: "terminals", label: "Terminales" },
      { id: "mosaic", label: "Mosaico" },
    ],
  },
  {
    heading: "Cerebro",
    items: [
      { id: "memory", label: "Memoria" },
      { id: "library", label: "Skills y agentes", featureKey: "skills" },
      { id: "mcps", label: "MCPs", featureKey: "mcps" },
      { id: "ai-router", label: "Router" },
    ],
  },
  {
    heading: "Trabajo",
    items: [
      { id: "projects", label: "Proyectos", featureKey: "projects" },
      { id: "sessions", label: "Sesiones", featureKey: "sessions" },
      { id: "usage", label: "Consumo", featureKey: "usage" },
      { id: "system", label: "Sistema" },
    ],
  },
];

/** Pestañas que devuelven a inicio si se desactivan estando abiertas. */
const FEATURE_TAB_TO_KEY: Partial<Record<Tab, keyof Features>> = {
  mcps: "mcps",
  library: "skills",
  skills: "skills",
  agents: "skills",
  rules: "skills",
  projects: "projects",
  // Conversations comparte el flag de Sessions (mismo dato: los transcripts
  // de ~/.claude/projects), asi que tambien tiene que redirigir si se apaga.
  conversations: "sessions",
  // hooks: gating moved inside System tab — no top-level redirect needed.
};

type Props = {
  active: Tab;
  onSelect: (t: Tab) => void;
  globalStatus: GlobalStatus;
  /** Por que el estado no es "Operativo"; se enseña al pasar el raton. */
  statusMotivo?: string;
  lastProjectCtx?: { title: string; subTab: string } | null;
  onGoBack?: () => void;
};

function SidebarButton({
  item,
  active,
  onSelect,
}: {
  item: Item;
  active: boolean;
  onSelect: (t: Tab) => void;
}) {
  return (
    <button
      key={item.id}
      type="button"
      onClick={() => onSelect(item.id)}
      className="relative flex w-full items-center justify-between px-3 py-2 text-[13px] uppercase transition-colors"
      style={{
        // Entrada de instrumento: sin esquinas redondeadas, con una barra de
        // luz a la izquierda cuando esta activa y tipografia de HUD.
        background: active ? "var(--color-surface-3)" : "transparent",
        color: active ? "var(--color-text)" : "var(--color-text-secondary)",
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
        letterSpacing: "0.12em",
        borderLeft: active
          ? "2px solid var(--color-accent)"
          : "2px solid transparent",
        boxShadow: active ? "inset 0 0 18px rgba(53,214,255,0.12)" : "none",
        textShadow: active ? "0 0 10px rgba(53,214,255,0.35)" : "none",
      }}
      onMouseEnter={(e) => {
        if (!active)
          (e.currentTarget as HTMLButtonElement).style.background =
            "var(--color-surface-2)";
      }}
      onMouseLeave={(e) => {
        if (!active)
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      <span>{item.label}</span>
    </button>
  );
}


export function Sidebar({
  active,
  onSelect,
  globalStatus,
  statusMotivo,
  lastProjectCtx,
  onGoBack,
}: Props) {
  const { features } = useFeatures();
  // Si se desactiva la pestaña abierta (editando features.json), se vuelve a
  // inicio: nunca se pinta algo que el usuario acaba de declarar apagado.
  useEffect(() => {
    const key = FEATURE_TAB_TO_KEY[active];
    if (key && features[key] === false) {
      onSelect("home");
    }
  }, [active, features, onSelect]);

  return (
    <aside
      className="flex w-64 shrink-0 flex-col border-r"
      style={{
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
      }}
    >
      {/* Marca: el reactor en lugar del monograma. */}
      <div className="flex items-center gap-3 px-5 py-4">
        <Reactor size={30} state="idle" />
        <div>
          <div
            className="text-[15px] font-semibold leading-none"
            style={{ color: "var(--color-text)", letterSpacing: "0.14em" }}
          >
            mar<span style={{ color: "var(--color-accent)" }}>.</span>ia
          </div>
          <div className="hud-label mt-1">sistema en linea</div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 pb-2">
        {SECTIONS.map((section, si) => {
          const primary = section.items.filter(
            (item) => !item.featureKey || features[item.featureKey] !== false,
          );
          if (primary.length === 0) return null;
          return (
            <div key={si} className="mb-6">
              {section.heading && (
                <div
                  className="px-2.5 pb-2 text-[12px] font-medium uppercase tracking-[0.08em]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {section.heading}
                </div>
              )}
              <div className="space-y-1">
                {primary.map((item) => (
                  <Fragment key={item.id}>
                    <SidebarButton
                      item={item}
                      active={active === item.id}
                      onSelect={onSelect}
                    />
                    {item.id === "projects" && lastProjectCtx && onGoBack && (
                      <button
                        type="button"
                        onClick={onGoBack}
                        className="flex w-full items-center gap-1.5 truncate rounded px-3 py-1 text-[11px] transition-colors"
                        style={{ color: "var(--color-text-tertiary)", background: "transparent" }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--color-surface-2)"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                        title={`Volver a ${lastProjectCtx.title} / ${lastProjectCtx.subTab}`}
                      >
                        <span aria-hidden>↩</span>
                        <span className="truncate">{lastProjectCtx.title} / {lastProjectCtx.subTab.charAt(0).toUpperCase() + lastProjectCtx.subTab.slice(1)}</span>
                      </button>
                    )}
                  </Fragment>
                ))}
              </div>
            </div>
          );
        })}

      </nav>

      {/* Avisos y Ajustes anclados al pie, fuera del scroll. */}
      <div
        className="border-t px-3 py-2 space-y-1"
        style={{ borderColor: "var(--color-border)" }}
      >
        {features.notifications !== false && (
          <SidebarButton
            item={{ id: "notifications", label: "Avisos" }}
            active={active === "notifications"}
            onSelect={onSelect}
          />
        )}
        <SidebarButton
          item={{ id: "settings", label: "Ajustes" }}
          active={active === "settings"}
          onSelect={onSelect}
        />
      </div>

      {/* Estado global. Es un boton: si no esta en verde, un clic lleva a
          Avisos, que es donde se ve y se descarta lo que lo causa. */}
      <button
        type="button"
        onClick={() => onSelect("notifications")}
        className="flex w-full items-center gap-2 border-t px-4 py-3 text-left text-[11.5px]"
        style={{
          borderColor: "var(--color-border)",
          background: "transparent",
          cursor: "pointer",
        }}
        title={
          statusMotivo
            ? `${statusMotivo} — clic para ver los avisos`
            : "sin avisos en las últimas horas"
        }
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: statusColor(globalStatus) }}
        />
        <span style={{ color: "var(--color-text-secondary)" }}>{statusLabel(globalStatus)}</span>
      </button>

    </aside>
  );
}
