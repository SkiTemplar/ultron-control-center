// ULTRON Control Center 2.0 — Per-project terminal with Dorothy-style splits
//
// Layout model: a per-project array of TerminalTab; each tab owns a binary
// tree of LayoutNode (leaf | split-h | split-v). Splits have a draggable
// sash; leaves host one PTY (or an empty placeholder with spawn buttons).
//
// Persistence: `~/.ultron/cockpit/projects/<projectId>/terminal-layout.json`
// via `project_terminal_layout_load` / `project_terminal_layout_save`.
// Debounced 400ms on every mutation.
//
// Reattach-on-load: after `tabs_load` and `pty_list`, dead pty_ids on leaves
// are nulled out so the leaf renders an empty placeholder; alive pty_ids
// reattach by re-mounting <EmbeddedTerminal sessionId={pty_id}/>.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Plus, Terminal as TerminalIcon, X } from "./icons";
import SplitPane from "./terminal/SplitPane";
import {
  closeLeaf,
  collectLeaves,
  defaultLayout,
  makeTab,
  setLeafPty,
  setSplitRatio,
  splitLeaf,
  type LayoutNode,
  type ProjectTerminalLayout,
  type Provider,
  type SplitDirection,
  type TerminalTab,
} from "./terminal/layout-types";
import type { PtySessionSummary } from "../../types";

type Props = { projectId: string };

const SAVE_DEBOUNCE_MS = 400;

export default function ProjectTerminal({ projectId }: Props) {
  const [layout, setLayout] = useState<ProjectTerminalLayout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const hydrated = useRef(false);

  // ------------------------------------------------------------------
  // Load + reattach on mount
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = (await invoke("project_terminal_layout_load", {
          projectId,
        })) as ProjectTerminalLayout;
        const sessions = (await invoke("pty_list", {
          projectId,
        })) as PtySessionSummary[];
        const aliveIds = new Set(
          sessions
            .filter((s) => s.status.kind === "running")
            .map((s) => s.id),
        );
        // Clear pty_id on every leaf whose PTY is no longer alive.
        const sanitized: ProjectTerminalLayout = {
          ...loaded,
          tabs: loaded.tabs.map((t) => ({
            ...t,
            root: sanitizeTree(t.root, aliveIds),
          })),
        };
        if (cancelled) return;
        setLayout(sanitized);
        hydrated.current = true;
      } catch (e) {
        if (cancelled) return;
        setError(String(e));
        // Fall back to a default layout so the UI is still usable.
        setLayout(defaultLayout());
        hydrated.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // ------------------------------------------------------------------
  // Debounced persist
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!hydrated.current || !layout) return;
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
    }
    const snapshot = layout;
    saveTimer.current = window.setTimeout(() => {
      void invoke("project_terminal_layout_save", {
        projectId,
        layout: snapshot,
      }).catch((e) => setError(String(e)));
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, [layout, projectId]);

  // ------------------------------------------------------------------
  // PTY exit listener — when a PTY dies, clear pty_id on its leaf.
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!layout) return;
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    (async () => {
      const ptys = new Set<string>();
      for (const t of layout.tabs) {
        for (const l of collectLeaves(t.root)) {
          if (l.pty_id) ptys.add(l.pty_id);
        }
      }
      for (const id of ptys) {
        const un = await listen(`pty:exit:${id}`, () => {
          if (cancelled) return;
          setLayout((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              tabs: prev.tabs.map((t) => ({
                ...t,
                root: clearPtyByPtyId(t.root, id),
              })),
            };
          });
        });
        unlisteners.push(un);
      }
    })();
    return () => {
      cancelled = true;
      for (const un of unlisteners) un();
    };
  }, [layout]);

  // ------------------------------------------------------------------
  // Tab helpers
  // ------------------------------------------------------------------
  const updateActiveTab = useCallback(
    (mut: (tab: TerminalTab) => TerminalTab) => {
      setLayout((prev) => {
        if (!prev) return prev;
        const activeId = prev.active_tab_id;
        if (!activeId) return prev;
        return {
          ...prev,
          tabs: prev.tabs.map((t) => (t.id === activeId ? mut(t) : t)),
        };
      });
    },
    [],
  );

  const updateActiveRoot = useCallback(
    (mut: (root: LayoutNode) => LayoutNode) => {
      updateActiveTab((tab) => ({ ...tab, root: mut(tab.root) }));
    },
    [updateActiveTab],
  );

  const addTab = useCallback(() => {
    setLayout((prev) => {
      if (!prev) return prev;
      const tab = makeTab(`Tab ${prev.tabs.length + 1}`);
      return { ...prev, tabs: [...prev.tabs, tab], active_tab_id: tab.id };
    });
  }, []);

  const selectTab = useCallback((id: string) => {
    setLayout((prev) => (prev ? { ...prev, active_tab_id: id } : prev));
  }, []);

  const closeTab = useCallback((id: string) => {
    setLayout((prev) => {
      if (!prev) return prev;
      if (prev.tabs.length <= 1) return prev; // keep at least one
      const tabs = prev.tabs.filter((t) => t.id !== id);
      const activeId =
        prev.active_tab_id === id ? tabs[tabs.length - 1].id : prev.active_tab_id;
      return { ...prev, tabs, active_tab_id: activeId };
    });
  }, []);

  const renameTab = useCallback((id: string, label: string) => {
    setLayout((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        tabs: prev.tabs.map((t) => (t.id === id ? { ...t, label } : t)),
      };
    });
  }, []);

  // ------------------------------------------------------------------
  // Leaf operations — split / close / spawn / kill / ratio.
  // ------------------------------------------------------------------
  const handleSplit = useCallback(
    (leafId: string, direction: SplitDirection) => {
      updateActiveRoot((root) => splitLeaf(root, leafId, direction));
    },
    [updateActiveRoot],
  );

  const handleClose = useCallback(
    (leafId: string) => {
      updateActiveRoot((root) => closeLeaf(root, leafId));
    },
    [updateActiveRoot],
  );

  const handleSpawnPty = useCallback(
    async (leafId: string, provider: Provider) => {
      try {
        const id = (await invoke("pty_spawn", {
          projectId,
          cardId: null,
          provider,
          agent: null,
          cwd: ".",
          prompt: null,
        })) as string;
        updateActiveRoot((root) => setLeafPty(root, leafId, id));
      } catch (e) {
        setError(String(e));
      }
    },
    [projectId, updateActiveRoot],
  );

  const handleAttachExisting = useCallback(
    (leafId: string, ptyId: string) => {
      updateActiveRoot((root) => setLeafPty(root, leafId, ptyId));
    },
    [updateActiveRoot],
  );

  const handleKillPty = useCallback(
    async (leafId: string, ptyId: string) => {
      try {
        await invoke("pty_kill", { sessionId: ptyId });
      } catch (e) {
        setError(String(e));
      }
      updateActiveRoot((root) => setLeafPty(root, leafId, null));
    },
    [updateActiveRoot],
  );

  const handleRatioChange = useCallback(
    (splitChildId: string, ratio: number) => {
      updateActiveRoot((root) => setSplitRatio(root, splitChildId, ratio));
    },
    [updateActiveRoot],
  );

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  if (!layout) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[var(--color-text-muted)]">
        <TerminalIcon size={14} />
        <span className="ml-2">Loading terminal layout…</span>
      </div>
    );
  }

  const activeTab =
    layout.tabs.find((t) => t.id === layout.active_tab_id) ?? layout.tabs[0];

  return (
    <div className="flex h-full flex-col">
      <TabsBar
        tabs={layout.tabs}
        activeId={activeTab.id}
        onSelect={selectTab}
        onClose={closeTab}
        onRename={renameTab}
        onAddTab={addTab}
      />
      <div className="flex-1 overflow-hidden">
        <SplitPane
          node={activeTab.root}
          projectId={projectId}
          onSplit={handleSplit}
          onClose={handleClose}
          onSpawnPty={handleSpawnPty}
          onAttachExisting={handleAttachExisting}
          onKillPty={handleKillPty}
          onRatioChange={handleRatioChange}
        />
      </div>
      {error && (
        <div className="border-t border-[var(--color-error)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs bar (terminal-level tabs, separate from the workspace-level tabs)
// ---------------------------------------------------------------------------

type TabsBarProps = {
  tabs: TerminalTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onAddTab: () => void;
};

function TabsBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onRename,
  onAddTab,
}: TabsBarProps) {
  return (
    <div className="flex items-center gap-0.5 border-b border-[var(--color-border)] bg-[var(--color-surface-0)] px-2">
      {tabs.map((t) => {
        const isActive = t.id === activeId;
        return (
          <div
            key={t.id}
            onClick={() => onSelect(t.id)}
            onDoubleClick={() => {
              const next = window.prompt("Rename tab", t.label);
              if (next && next.trim()) onRename(t.id, next.trim());
            }}
            className={[
              "group flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs",
              isActive
                ? "border-[var(--color-accent)] bg-[var(--color-surface-1)] text-[var(--color-text)]"
                : "border-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-surface-1)] hover:text-[var(--color-text)]",
            ].join(" ")}
            title={`${t.label} (double-click to rename)`}
          >
            <TerminalIcon size={11} />
            <span className="font-mono">{t.label}</span>
            {tabs.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
                className="rounded p-0.5 opacity-60 hover:bg-[var(--color-surface-2)] hover:opacity-100"
                aria-label="Close tab"
                title="Close tab"
              >
                <X size={10} />
              </button>
            )}
          </div>
        );
      })}
      <button
        onClick={onAddTab}
        className="ml-1 flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        title="New tab"
      >
        <Plus size={11} /> Tab
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree sanitizers for reattach + exit handling.
// ---------------------------------------------------------------------------

function sanitizeTree(node: LayoutNode, aliveIds: Set<string>): LayoutNode {
  if (node.kind === "leaf") {
    if (node.pty_id && !aliveIds.has(node.pty_id)) {
      return { ...node, pty_id: null };
    }
    return node;
  }
  const left = sanitizeTree(node.left, aliveIds);
  const right = sanitizeTree(node.right, aliveIds);
  if (left === node.left && right === node.right) return node;
  return { ...node, left, right };
}

function clearPtyByPtyId(node: LayoutNode, ptyId: string): LayoutNode {
  if (node.kind === "leaf") {
    if (node.pty_id === ptyId) return { ...node, pty_id: null };
    return node;
  }
  const left = clearPtyByPtyId(node.left, ptyId);
  const right = clearPtyByPtyId(node.right, ptyId);
  if (left === node.left && right === node.right) return node;
  return { ...node, left, right };
}
