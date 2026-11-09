// Espacio de trabajo: barra de pestañas y rejilla de hasta 2×2 paneles.
// Arrastrar una pestaña a un borde de la rejilla la «junta» en un panel nuevo.

import { useState } from "react";
import { lastUsedProfile, newSessionHere, newSessionTitle, useLaunchProfiles } from "../launch-profiles";
import { useApi } from "../context";
import { ENGINE_LABEL } from "../engines";
import { useStore } from "../store";
import type { SessionId } from "../types";
import {
  MAX_PANES,
  closeTabToNeighbor,
  showInFocused,
  splitWith,
  updateWorkspace,
  useWorkspace,
  type Edge,
} from "../workspace";
import { useUnread } from "../unread";
import { IconClose, IconPlus, IconSplit } from "./icons";
import { UnreadDot } from "./UnreadDot";
import { PaneView, PopOutButton, paneHasHead } from "./Pane";
import { SessionDot } from "./SessionDot";

export const DRAG_MIME = "application/x-ultron-sesion";
const EDGES: { edge: Edge; label: string }[] = [
  { edge: "left", label: "Juntar a la izquierda" },
  { edge: "right", label: "Juntar a la derecha" },
  { edge: "top", label: "Juntar arriba" },
  { edge: "bottom", label: "Juntar abajo" },
];

function TabUnread({ id }: { id: SessionId }) {
  return useUnread(id) ? <UnreadDot /> : null;
}

function Tabs({ onDrag }: { onDrag: (on: boolean) => void }) {
  const api = useApi();
  const ws = useWorkspace();
  const sessions = useStore((s) => s.sessions);
  const focusedId = ws.panes[ws.focused]?.sessionId ?? null;
  const newTitle = newSessionTitle(lastUsedProfile(useLaunchProfiles()));
  const tabs = ws.tabs.map((id) => sessions.find((s) => s.id === id)).filter((s) => s !== undefined);
  const nextForSplit = sessions.find((s) => !ws.panes.some((p) => p.sessionId === s.id))?.id ?? focusedId;
  // Sin cabecera de panel (un solo panel con la sesión principal), «Sacar a ventana» vive aquí.
  const only = ws.panes.length === 1 ? ws.panes[0] : null;
  const popOut = only?.sessionId && !paneHasHead(only, 1) ? only.sessionId : null;

  return (
    <div className="tabbar" role="tablist" aria-label="Sesiones abiertas">
      {tabs.map((s, tabIdx) => {
        const paneIdx = ws.panes.findIndex((p) => p.sessionId === s.id);
        const inSplit = paneIdx >= 0 && ws.panes.length > 1;
        return (
          <div
            key={s.id}
            role="tab"
            // Patrón de pestañas: solo la activa entra en el orden de Tab; ←/→ recorren el resto.
            tabIndex={s.id === focusedId || (!focusedId && tabIdx === 0) ? 0 : -1}
            aria-selected={s.id === focusedId}
            data-tab-index={tabIdx}
            className="tab"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_MIME, s.id);
              e.dataTransfer.effectAllowed = "move";
              onDrag(true);
            }}
            onDragEnd={() => onDrag(false)}
            onClick={() => updateWorkspace((w) => showInFocused(w, s.id))}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                updateWorkspace((w) => showInFocused(w, s.id));
              } else if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End") {
                e.preventDefault();
                const n = tabs.length;
                const next = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (tabIdx + (e.key === "ArrowRight" ? 1 : n - 1)) % n;
                const bar = e.currentTarget.parentElement;
                updateWorkspace((w) => showInFocused(w, tabs[next].id));
                window.requestAnimationFrame(() => bar?.querySelector<HTMLElement>(`[data-tab-index="${next}"]`)?.focus());
              }
            }}
            title="Arrastra a un borde para dividir"
          >
            <SessionDot session={s} />
            {s.engine && <span className={`dd-dot ${s.engine}`} role="img" aria-label={`Sesión de ${ENGINE_LABEL[s.engine]}`} title={`Sesión de ${ENGINE_LABEL[s.engine]}`} />}
            <span className="tl">{s.title}</span>
            <TabUnread id={s.id} />
            {inSplit && <span className="k">{paneIdx + 1}</span>}
            {/* Con paneles divididos, la sesión que está en un panel se cierra desde
                la cabecera de ese panel: un solo × por sesión a la vista. */}
            {!inSplit && <button
              className="x"
              aria-label={`Cerrar pestaña ${s.title}`}
              onClick={(e) => {
                e.stopPropagation();
                updateWorkspace((w) => closeTabToNeighbor(w, s.id));
              }}
            >
              <IconClose />
            </button>}
          </div>
        );
      })}
      <div className="tab-tools">
        <button className="tbtn" onClick={() => void newSessionHere(api, focusedId)} title={newTitle} aria-label="Sesión nueva">
          <IconPlus />
        </button>
        <button
          className="tbtn"
          disabled={ws.panes.length >= MAX_PANES}
          onClick={() => updateWorkspace((w) => splitWith(w, nextForSplit, w.panes.length === 2 ? "bottom" : "right"))}
          title="Dividir: añade un panel (máximo 2×2)"
        >
          <IconSplit /> Dividir
        </button>
        {popOut && <PopOutButton sessionId={popOut} index={0} compact />}
      </div>
    </div>
  );
}

function DropZones({ active, onDone }: { active: boolean; onDone: () => void }) {
  const [over, setOver] = useState<Edge | null>(null);
  const full = useWorkspace().panes.length >= MAX_PANES;
  if (!active || full) return null;
  return (
    <div className="dropzones on" onDragLeave={() => setOver(null)}>
      {EDGES.map(({ edge, label }) => (
        <div
          key={edge}
          className={`dz ${edge}`}
          data-over={over === edge}
          data-edge={edge}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(edge);
          }}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData(DRAG_MIME) as SessionId;
            if (id) updateWorkspace((w) => splitWith(w, id, edge));
            setOver(null);
            onDone();
          }}
        >
          {over === edge ? label : ""}
        </div>
      ))}
    </div>
  );
}

export function Workspace() {
  const ws = useWorkspace();
  const [dragging, setDragging] = useState(false);
  return (
    <main className="work">
      <Tabs onDrag={setDragging} />
      <div className="grid" data-n={ws.panes.length} data-split={ws.split}>
        {ws.panes.map((p, i) => (
          <PaneView key={p.key} pane={p} index={i} focused={i === ws.focused} count={ws.panes.length} />
        ))}
        <DropZones active={dragging} onDone={() => setDragging(false)} />
      </div>
    </main>
  );
}
