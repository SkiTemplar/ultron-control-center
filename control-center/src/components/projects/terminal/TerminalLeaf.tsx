// ULTRON Control Center 2.0 — Single pane in the split-pane tree
//
// When `ptyId` is set, mounts <EmbeddedTerminal>; otherwise renders the empty
// placeholder with "+ Claude / + Codex / + Gemini" spawn buttons. Always shows
// a small leaf toolbar (split-h, split-v, close, kill) along the top edge.

import { useEffect, useState } from "react";
import EmbeddedTerminal from "../../EmbeddedTerminal";
import type { Provider, SplitDirection } from "./layout-types";
import { Plus, Terminal as TerminalIcon, X } from "../icons";

type Props = {
  leafId: string;
  ptyId: string | null;
  projectId: string;
  onSplit: (leafId: string, direction: SplitDirection) => void;
  onClose: (leafId: string) => void;
  onSpawn: (leafId: string, provider: Provider) => void;
  onAttachExisting: (leafId: string, ptyId: string) => void;
  onKillPty: (leafId: string, ptyId: string) => void;
};

const PROVIDERS: Provider[] = [
  "claude",
  "codex",
  "gemini",
  "powershell",
  "powershell-admin",
];

function providerLabel(p: Provider): string {
  if (p === "claude") return "Claude";
  if (p === "codex") return "Codex";
  if (p === "gemini") return "Gemini";
  if (p === "powershell") return "PowerShell";
  if (p === "powershell-admin") return "PowerShell (admin)";
  return p;
}

function providerTint(p: Provider): string {
  if (p === "claude") return "#cc785c";
  if (p === "codex") return "#10a37f";
  if (p === "gemini") return "#4285f4";
  if (p === "powershell") return "#012456"; // PowerShell blue
  if (p === "powershell-admin") return "#d29922"; // warning amber for elevated
  return "#888";
}

export default function TerminalLeaf(props: Props) {
  const { ptyId, leafId, onSplit, onClose, onSpawn, onKillPty } = props;
  // v2.6: per-pane rename — persisted in localStorage by leafId.
  const nameKey = `terminal.leaf.name.${leafId}`;
  const [name, setName] = useState<string>(() => {
    try {
      return localStorage.getItem(nameKey) ?? "";
    } catch {
      return "";
    }
  });
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(name);
  useEffect(() => {
    try {
      if (name) localStorage.setItem(nameKey, name);
      else localStorage.removeItem(nameKey);
    } catch {
      /* ignore */
    }
  }, [name, nameKey]);

  return (
    <div className="flex h-full w-full flex-col bg-[#0d0d11]">
      <LeafToolbar
        canKill={ptyId !== null}
        name={name}
        editingName={editingName}
        draftName={draftName}
        onStartRename={() => {
          setDraftName(name);
          setEditingName(true);
        }}
        onChangeDraft={setDraftName}
        onCommitRename={() => {
          setName(draftName.trim());
          setEditingName(false);
        }}
        onCancelRename={() => {
          setDraftName(name);
          setEditingName(false);
        }}
        onSplitH={() => onSplit(leafId, "h")}
        onSplitV={() => onSplit(leafId, "v")}
        onClose={() => onClose(leafId)}
        onKill={() => {
          if (ptyId) onKillPty(leafId, ptyId);
        }}
      />
      <div className="flex-1 overflow-hidden">
        {ptyId ? (
          <EmbeddedTerminal key={ptyId} sessionId={ptyId} />
        ) : (
          <EmptyLeaf
            onSpawn={(p) => {
              // Assign the provider label as the pane name immediately so the
              // toolbar shows "Claude" / "Codex" / etc. without manual rename.
              setName(providerLabel(p));
              onSpawn(leafId, p);
            }}
          />
        )}
      </div>
    </div>
  );
}

function LeafToolbar({
  canKill,
  name,
  editingName,
  draftName,
  onStartRename,
  onChangeDraft,
  onCommitRename,
  onCancelRename,
  onSplitH,
  onSplitV,
  onClose,
  onKill,
}: {
  canKill: boolean;
  name: string;
  editingName: boolean;
  draftName: string;
  onStartRename: () => void;
  onChangeDraft: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onSplitH: () => void;
  onSplitV: () => void;
  onClose: () => void;
  onKill: () => void;
}) {
  return (
    <div className="flex h-6 items-center gap-0.5 border-b border-[var(--color-border)] bg-[var(--color-surface-0)] px-1.5 text-[10px] text-[var(--color-text-muted)]">
      <button
        onClick={onSplitH}
        title="Split horizontal (side-by-side)"
        className="flex h-5 items-center gap-1 rounded px-1.5 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
      >
        <SplitHIcon /> H
      </button>
      <button
        onClick={onSplitV}
        title="Split vertical (top/bottom)"
        className="flex h-5 items-center gap-1 rounded px-1.5 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
      >
        <SplitVIcon /> V
      </button>
      {/* v2.6: pane name — double-click to rename, Enter commit, Esc cancel. */}
      <div className="ml-2 min-w-0 flex-1">
        {editingName ? (
          <input
            autoFocus
            value={draftName}
            onChange={(e) => onChangeDraft(e.target.value)}
            onBlur={onCommitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onCommitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancelRename();
              }
            }}
            placeholder="Pane name"
            className="h-5 w-full rounded border border-[var(--color-accent)] bg-[var(--color-surface-1)] px-1 text-[10.5px] outline-none"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={onStartRename}
            onClick={onStartRename}
            className="block w-full truncate text-left text-[10.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            title="Click or double-click to rename"
          >
            {name || "Untitled pane"}
          </button>
        )}
      </div>
      <div className="ml-auto flex items-center gap-0.5">
        {canKill && (
          <button
            onClick={onKill}
            title="Kill PTY"
            className="flex h-5 items-center gap-1 rounded px-1.5 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-error)]"
          >
            Kill
          </button>
        )}
        <button
          onClick={onClose}
          title="Close pane"
          className="flex h-5 items-center rounded px-1 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        >
          <X size={10} />
        </button>
      </div>
    </div>
  );
}

function EmptyLeaf({ onSpawn }: { onSpawn: (p: Provider) => void }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-4 text-xs text-[var(--color-text-muted)]">
      <div className="flex items-center gap-2 text-[var(--color-text)]">
        <TerminalIcon size={14} />
        <span className="text-sm font-medium">Empty pane</span>
      </div>
      <p className="max-w-sm text-center">
        Spawn an AI session in this pane — xterm.js + portable-pty, full TTY.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p}
            onClick={() => onSpawn(p)}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-1.5 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          >
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: providerTint(p) }}
            />
            <Plus size={11} /> {providerLabel(p)}
          </button>
        ))}
      </div>
    </div>
  );
}

// Inline split icons (kept local to avoid touching icons.tsx).
function SplitHIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  );
}

function SplitVIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </svg>
  );
}
