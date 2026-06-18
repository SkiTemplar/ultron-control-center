// Detail pane — 560px side panel for the selected agent.

import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { AgentEntry } from "../../types";
import { LibraryDetailPane } from "../library/LibraryDetailPane";
import { NO_CATEGORY } from "./types";
import { agentWorkspace, deriveCategory } from "./helpers";

interface AgentDetailPaneProps {
  selected: AgentEntry;
  toggleBusy: Set<string>;
  onReload: () => Promise<void>;
  onClose: () => void;
  onToggle: (a: AgentEntry) => Promise<void>;
  onError: (msg: string) => void;
}

export function AgentDetailPane({
  selected,
  toggleBusy,
  onReload,
  onClose,
  onToggle,
  onError,
}: AgentDetailPaneProps) {
  const ws = agentWorkspace(selected);
  const subtitleParts: string[] = [selected.origin];
  const cat = deriveCategory(selected);
  if (cat !== NO_CATEGORY) subtitleParts.push(cat);
  subtitleParts.push(selected.enabled ? "enabled" : "disabled");

  const handleOpen = async (path: string) => {
    try {
      await openPath(path);
    } catch (e) {
      onError(`open ${path}: ${e}`);
    }
  };

  return (
    <div className="overflow-hidden lg:w-[560px] lg:shrink-0" style={{ minWidth: 0 }}>
      <div className="flex h-full flex-col gap-2">
        <LibraryDetailPane
          kind="agent"
          name={selected.name}
          subtitle={subtitleParts.join(" · ")}
          filePath={ws.file}
          folderPath={ws.folder}
          onSave={
            selected.origin === "global"
              ? async (body: string) => {
                  await invoke("update_agent_md", { name: selected.name, content: body });
                  await onReload();
                }
              : undefined
          }
          onClose={onClose}
        />
        {/* Secondary toggle button below the detail pane — mirrors Skills.tsx */}
        {selected.origin === "global" && (
          <button
            type="button"
            onClick={() => void onToggle(selected)}
            disabled={toggleBusy.has(selected.path)}
            className="rounded-md border px-3 py-1.5 text-[11.5px] disabled:opacity-50"
            style={{
              borderColor: selected.enabled
                ? "var(--color-border-strong)"
                : "var(--color-accent)",
              background: selected.enabled
                ? "var(--color-surface-2)"
                : "var(--color-accent)",
              color: selected.enabled
                ? "var(--color-text)"
                : "var(--color-accent-text)",
            }}
          >
            {toggleBusy.has(selected.path)
              ? "Saving…"
              : selected.enabled
                ? "Disable agent"
                : "Enable agent"}
          </button>
        )}
        {/* Open in editor fallback for non-global agents */}
        {selected.origin !== "global" && (
          <button
            type="button"
            onClick={() => void handleOpen(selected.path)}
            className="rounded-md border px-3 py-1.5 text-[11.5px]"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
          >
            Open in editor
          </button>
        )}
      </div>
    </div>
  );
}
