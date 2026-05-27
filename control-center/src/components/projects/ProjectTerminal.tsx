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
import { providerLabel } from "./terminal/provider-labels";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { History, Plus, Terminal as TerminalIcon, X } from "./icons";
import SplitPane from "./terminal/SplitPane";
import BatchDropdown, { type BatchToast } from "./BatchDropdown";
import RecallSessionDialog from "./terminal/RecallSessionDialog";
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

type Props = {
  projectId: string;
  /** Absolute path of the project on disk. When non-null it is passed as the
   * `cwd` for every `pty_spawn` call so sessions open in the project folder
   * instead of in the Tauri process working directory (System32 on Windows).
   * Falls back to `"."` when null so legacy callers without a path still work.
   */
  projectPath: string | null;
};

const SAVE_DEBOUNCE_MS = 400;

export default function ProjectTerminal({ projectId, projectPath }: Props) {
  const [layout, setLayout] = useState<ProjectTerminalLayout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batchToast, setBatchToast] = useState<BatchToast | null>(null);
  const [recallOpen, setRecallOpen] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const hydrated = useRef(false);

  // Auto-fade batch toast after 6s so it doesn't clutter the terminal area.
  useEffect(() => {
    if (!batchToast) return;
    const t = window.setTimeout(() => setBatchToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [batchToast]);

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
          // Use the project's absolute path so the session opens in the
          // project folder, not in the Tauri process CWD (System32 on Windows).
          cwd: projectPath ?? ".",
          prompt: null,
        })) as string;

        // v2.6.1: also auto-name the upper tab if its label is still the
        // default "Tab N" placeholder. The leaf chrome already auto-names
        // the *pane*; this completes the experience for the tab row at the
        // top of the terminal, per the user's request. For tabs that already
        // host another provider (split-pane scenario) we keep the existing
        // label so the user isn't surprised by a rename on every new spawn.
        setLayout((prev) => {
          if (!prev) return prev;
          const activeId = prev.active_tab_id;
          if (!activeId) return prev;
          return {
            ...prev,
            tabs: prev.tabs.map((t) => {
              if (t.id !== activeId) return t;
              const next = setLeafPty(t.root, leafId, id);
              const isDefaultLabel = /^Tab\s+\d+$/i.test(t.label.trim());
              const label = isDefaultLabel ? providerLabel(provider) : t.label;
              const defaultProvider = t.default_provider ?? provider;
              return { ...t, label, default_provider: defaultProvider, root: next };
            }),
          };
        });
      } catch (e) {
        setError(String(e));
      }
    },
    [projectId, projectPath],
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
  // Recall — spawn a fresh Claude PTY in a new tab and seed it with the
  // suggested prompt. We add a Tab labelled "Recall", spawn Claude in its
  // root leaf, then `pty_write` the prompt followed by a CR so Claude
  // sees it as the user's first message. The prompt is sent base64 to
  // match the existing pty_write convention (binary-safe).
  // ------------------------------------------------------------------
  const spawnRecallSession = useCallback(
    async (prompt: string) => {
      const id = (await invoke("pty_spawn", {
        projectId,
        cardId: null,
        provider: "claude",
        agent: null,
        // Same fix as handleSpawnPty: use the project's absolute path.
        cwd: projectPath ?? ".",
        prompt: null,
      })) as string;

      // Create a fresh tab hosting this new PTY. We mutate the placeholder
      // leaf's pty_id via setLeafPty (using its own id as the target) so the
      // pane reattaches to the spawned session on first render.
      setLayout((prev) => {
        if (!prev) return prev;
        const tab = makeTab("Recall");
        const leafId =
          tab.root.kind === "leaf" ? tab.root.id : "";
        const root = leafId ? setLeafPty(tab.root, leafId, id) : tab.root;
        return {
          ...prev,
          tabs: [...prev.tabs, { ...tab, root, default_provider: "claude" }],
          active_tab_id: tab.id,
        };
      });

      // Seed the prompt. We wait a beat so Claude's TUI has finished its
      // initial paint and is ready to receive keystrokes; otherwise the
      // first characters get eaten by the splash screen. Encode each
      // chunk as base64 — pty_write::data is decoded by the backend with
      // base64::STANDARD.
      const encodePart = (s: string): string => {
        let bin = "";
        for (let i = 0; i < s.length; i++) {
          bin += String.fromCharCode(s.charCodeAt(i) & 0xff);
        }
        return btoa(bin);
      };
      const encoded = encodePart(prompt);
      window.setTimeout(() => {
        void invoke("pty_write", { sessionId: id, data: encoded }).catch(
          (e) => setError(`pty_write: ${e}`),
        );
      }, 1500);
    },
    [projectId, projectPath],
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
        onBatchResult={setBatchToast}
        onRecall={() => setRecallOpen(true)}
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
      {batchToast && (
        <div
          className="border-t px-3 py-2 text-xs"
          style={{
            borderColor: batchToast.kind === "ok"
              ? "var(--color-success, #22c55e)"
              : "var(--color-danger, #ef4444)",
            background: "var(--color-surface-2)",
            color: batchToast.kind === "ok"
              ? "var(--color-success, #22c55e)"
              : "var(--color-danger, #ef4444)",
          }}
          title={batchToast.body}
        >
          <strong>{batchToast.title}</strong>
          {batchToast.body && (
            <span className="ml-2" style={{ color: "var(--color-text-secondary)" }}>
              {batchToast.body.slice(0, 200)}
              {batchToast.body.length > 200 ? "…" : ""}
            </span>
          )}
        </div>
      )}
      {error && (
        <div className="border-t border-[var(--color-error)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}
      {recallOpen && (
        <RecallSessionDialog
          projectId={projectId}
          onClose={() => setRecallOpen(false)}
          onSpawn={spawnRecallSession}
        />
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
  onBatchResult: (toast: BatchToast) => void;
  /** Opens the Recall Last Session dialog. */
  onRecall: () => void;
};

function TabsBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onRename,
  onAddTab,
  onBatchResult,
  onRecall,
}: TabsBarProps) {
  // v2.6.1: double-click an upper tab → inline rename. The previous build
  // used `window.prompt`, which is blocking, ugly in a Tauri window, and the
  // user explicitly asked for the *tabs* (not the leaf pane chrome) to be
  // renameable inline.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>("");

  const startEdit = (id: string, current: string) => {
    setEditingId(id);
    setDraft(current);
  };
  const commit = () => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim());
    setEditingId(null);
    setDraft("");
  };
  const cancel = () => {
    setEditingId(null);
    setDraft("");
  };

  return (
    <div className="flex items-center gap-0.5 border-b border-[var(--color-border)] bg-[var(--color-surface-0)] px-2">
      {tabs.map((t) => {
        const isActive = t.id === activeId;
        const isEditing = editingId === t.id;
        return (
          <div
            key={t.id}
            onClick={() => {
              if (!isEditing) onSelect(t.id);
            }}
            onDoubleClick={() => startEdit(t.id, t.label)}
            className={[
              "group flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs",
              isActive
                ? "border-[var(--color-accent)] bg-[var(--color-surface-1)] text-[var(--color-text)]"
                : "border-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-surface-1)] hover:text-[var(--color-text)]",
            ].join(" ")}
            title={`${t.label} (double-click to rename)`}
          >
            <TerminalIcon size={11} />
            {isEditing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancel();
                  }
                }}
                className="h-5 w-28 rounded border border-[var(--color-accent)] bg-[var(--color-surface-0)] px-1 font-mono text-[11px] text-[var(--color-text)] outline-none"
              />
            ) : (
              <span className="font-mono">{t.label}</span>
            )}
            {tabs.length > 1 && !isEditing && (
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
      <button
        onClick={onRecall}
        className="ml-1 flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        title="Recall last session — recover context and spawn a fresh Claude with a paste-ready prompt"
      >
        <History size={11} /> Recall
      </button>
      <div className="ml-auto flex items-center pr-1">
        <BatchDropdown onResult={onBatchResult} />
      </div>
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
