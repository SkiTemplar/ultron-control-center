// Inline SVG icons specific to the Projects launcher chips and card actions.
// Kept separate from icons.tsx (workspace icons) to avoid name collisions.
// No lucide-react dependency — keeps the bundle small.

import type { LauncherItem } from "../../types";

// ---------------------------------------------------------------------------
// Launcher chip icons (used by ProjectRow)
// ---------------------------------------------------------------------------

export function FolderChipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function PlayChipIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}

export function ClaudeMark() {
  return (
    <span aria-hidden
      className="flex h-[18px] w-[18px] items-center justify-center rounded-[3px] text-[11.5px] font-bold leading-none"
      style={{ background: "#cc785c", color: "#fafaf7", fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)" }}
    >
      C
    </span>
  );
}

export function CodexMark() {
  return (
    <span aria-hidden
      className="flex h-[18px] w-[18px] items-center justify-center rounded-[3px] text-[11.5px] font-bold leading-none"
      style={{ background: "#10a37f", color: "#fafaf7", fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)" }}
    >
      X
    </span>
  );
}

/** Icon picked from the item for built-in chips. */
export function BuiltinIcon({ item }: { item: LauncherItem }) {
  const k = item.kind;
  if (k === "folder") return <FolderChipIcon />;
  if (k === "claude") return <ClaudeMark />;
  if (k === "codex") return <CodexMark />;
  if (k === "session") {
    const p = item.provider ?? "claude";
    if (p === "codex") return <CodexMark />;
    return <ClaudeMark />;
  }
  if (k === "ide") return <FolderChipIcon />;
  return <PlayChipIcon />;
}

// ---------------------------------------------------------------------------
// Card action icons (used by ProjectCard)
// ---------------------------------------------------------------------------

export function CardIconFolder() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function CardIconIde() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

export function CardIconSpark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v3" /><path d="M12 18v3" />
      <path d="M5.6 5.6l2.1 2.1" /><path d="M16.3 16.3l2.1 2.1" />
      <path d="M3 12h3" /><path d="M18 12h3" />
      <path d="M5.6 18.4l2.1-2.1" /><path d="M16.3 7.7l2.1-2.1" />
    </svg>
  );
}

export function CardIconTerminal() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}
