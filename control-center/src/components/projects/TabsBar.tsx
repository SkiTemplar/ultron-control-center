// ULTRON Control Center 2.0 — Projects browser-style tab strip
//
// Renders the fixed "Projects" home tab + N project tabs. Supports drag-reorder
// (HTML5 DnD), middle-click close, and `×` close. (La confirmación por PTYs
// vivos se retiró con el terminal embebido — las pestañas cierran directo.)

import { useCallback, useState } from "react";
import { Folder, Home, X } from "./icons";
import { useProjectsTabs } from "../../state/ProjectsTabsContext";
import type { OpenTab } from "../../types";

export default function TabsBar() {
  const { tabs, currentId, select, close, reorder } = useProjectsTabs();
  const [dragId, setDragId] = useState<string | null>(null);

  const onDragStart = useCallback((e: React.DragEvent, id: string) => {
    if (id === "home") {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/x-ultron-tab", id);
    setDragId(id);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("text/x-ultron-tab")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent, beforeId: string) => {
      const id = e.dataTransfer.getData("text/x-ultron-tab");
      if (!id || id === beforeId) return;
      reorder(id, beforeId);
      setDragId(null);
    },
    [reorder],
  );

  const onDropEnd = useCallback(
    (e: React.DragEvent) => {
      const id = e.dataTransfer.getData("text/x-ultron-tab");
      if (!id) return;
      reorder(id, null);
      setDragId(null);
    },
    [reorder],
  );

  const requestClose = useCallback(
    (tab: OpenTab) => {
      if (tab.id === "home") return;
      close(tab.id);
    },
    [close],
  );

  const onTabMouseDown = useCallback(
    (e: React.MouseEvent, tab: OpenTab) => {
      if (e.button === 1) {
        e.preventDefault();
        requestClose(tab);
      }
    },
    [requestClose],
  );

  return (
    <div
      className="flex items-end gap-0.5 border-b border-[var(--color-border)] bg-[var(--color-surface-0)] px-2 pt-2"
      onDragOver={onDragOver}
      onDrop={onDropEnd}
    >
      {tabs.map((tab) => {
        const active = tab.id === currentId;
        const dragging = dragId === tab.id;
        return (
          <div
            key={tab.id}
            draggable={tab.id !== "home"}
            onDragStart={(e) => onDragStart(e, tab.id)}
            onDragOver={onDragOver}
            onDrop={(e) => onDrop(e, tab.id)}
            onMouseDown={(e) => onTabMouseDown(e, tab)}
            onClick={() => select(tab.id)}
            className={[
              "group flex cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-xs select-none",
              active
                ? "border-[var(--color-border)] bg-[var(--color-surface-1)] text-[var(--color-text)]"
                : "border-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-surface-1)]",
              dragging ? "opacity-50" : "",
            ].join(" ")}
            data-tab-id={tab.id}
            title={tab.title}
          >
            {tab.kind === "home" ? (
              <Home size={12} className="shrink-0" />
            ) : (
              <Folder size={12} className="shrink-0" />
            )}
            <span className="max-w-[160px] truncate">{tab.title}</span>
            {tab.id !== "home" && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  requestClose(tab);
                }}
                className="ml-1 rounded p-0.5 opacity-60 hover:bg-[var(--color-surface-2)] hover:opacity-100"
                aria-label="Close tab"
              >
                <X size={11} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
