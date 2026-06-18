// Constants, color helpers, and name-derivation utilities for Hooks viewer.

export const EVENT_OPTIONS: readonly string[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "Notification",
] as const;

export const DEFAULT_PAYLOAD = `{
  "tool_name": "Bash",
  "tool_input": { "command": "echo hello" }
}`;

// ---------------------------------------------------------------------------
// Per-event color tokens — used for the category sidebar accent, card ribbon,
// and event badges. NO global amber overlay anymore.
// ---------------------------------------------------------------------------

export type EventColors = {
  ribbon: string;       // top card ribbon + sidebar active bg
  ribbonBorder: string; // card active border + sidebar chip border
  chipBg: string;       // event badge bg
  chipFg: string;       // event badge text
  chipBorder: string;   // event badge border
  sidebarActive: string;// sidebar row active background
};

export function eventColors(event: string): EventColors {
  switch (event) {
    case "PreToolUse":
      return {
        ribbon: "rgba(56, 189, 248, 0.55)",
        ribbonBorder: "rgba(56, 189, 248, 0.55)",
        chipBg: "rgba(56, 189, 248, 0.14)",
        chipFg: "#67e8f9",
        chipBorder: "rgba(56, 189, 248, 0.45)",
        sidebarActive: "rgba(56, 189, 248, 0.12)",
      };
    case "PostToolUse":
      return {
        ribbon: "rgba(167, 139, 250, 0.55)",
        ribbonBorder: "rgba(167, 139, 250, 0.55)",
        chipBg: "rgba(167, 139, 250, 0.14)",
        chipFg: "#c4b5fd",
        chipBorder: "rgba(167, 139, 250, 0.45)",
        sidebarActive: "rgba(167, 139, 250, 0.12)",
      };
    case "UserPromptSubmit":
      return {
        ribbon: "rgba(251, 191, 36, 0.55)",
        ribbonBorder: "rgba(251, 191, 36, 0.55)",
        chipBg: "rgba(251, 191, 36, 0.14)",
        chipFg: "#fcd34d",
        chipBorder: "rgba(251, 191, 36, 0.45)",
        sidebarActive: "rgba(251, 191, 36, 0.10)",
      };
    case "SessionStart":
      return {
        ribbon: "rgba(132, 204, 22, 0.55)",
        ribbonBorder: "rgba(132, 204, 22, 0.55)",
        chipBg: "rgba(132, 204, 22, 0.14)",
        chipFg: "#bef264",
        chipBorder: "rgba(132, 204, 22, 0.45)",
        sidebarActive: "rgba(132, 204, 22, 0.10)",
      };
    case "SessionEnd":
      return {
        ribbon: "rgba(45, 212, 191, 0.55)",
        ribbonBorder: "rgba(45, 212, 191, 0.55)",
        chipBg: "rgba(45, 212, 191, 0.14)",
        chipFg: "#5eead4",
        chipBorder: "rgba(45, 212, 191, 0.45)",
        sidebarActive: "rgba(45, 212, 191, 0.10)",
      };
    case "Stop":
      return {
        ribbon: "rgba(248, 113, 113, 0.55)",
        ribbonBorder: "rgba(248, 113, 113, 0.55)",
        chipBg: "rgba(248, 113, 113, 0.14)",
        chipFg: "#fca5a5",
        chipBorder: "rgba(248, 113, 113, 0.45)",
        sidebarActive: "rgba(248, 113, 113, 0.10)",
      };
    case "SubagentStop":
      return {
        ribbon: "rgba(248, 113, 113, 0.40)",
        ribbonBorder: "rgba(248, 113, 113, 0.40)",
        chipBg: "rgba(248, 113, 113, 0.10)",
        chipFg: "#fca5a5",
        chipBorder: "rgba(248, 113, 113, 0.35)",
        sidebarActive: "rgba(248, 113, 113, 0.08)",
      };
    case "PreCompact":
      return {
        ribbon: "rgba(244, 114, 182, 0.55)",
        ribbonBorder: "rgba(244, 114, 182, 0.55)",
        chipBg: "rgba(244, 114, 182, 0.14)",
        chipFg: "#f9a8d4",
        chipBorder: "rgba(244, 114, 182, 0.45)",
        sidebarActive: "rgba(244, 114, 182, 0.10)",
      };
    case "Notification":
      return {
        ribbon: "rgba(96, 165, 250, 0.55)",
        ribbonBorder: "rgba(96, 165, 250, 0.55)",
        chipBg: "rgba(96, 165, 250, 0.14)",
        chipFg: "#93c5fd",
        chipBorder: "rgba(96, 165, 250, 0.45)",
        sidebarActive: "rgba(96, 165, 250, 0.10)",
      };
    default:
      return {
        ribbon: "var(--color-border-strong)",
        ribbonBorder: "var(--color-border-strong)",
        chipBg: "var(--color-surface-3)",
        chipFg: "var(--color-text-secondary)",
        chipBorder: "var(--color-border)",
        sidebarActive: "var(--color-surface-3)",
      };
  }
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "...";
}

/**
 * Derive a readable name from a hook's command when no explicit name exists.
 *
 * Strategy: find the script the command runs (the first path-like token whose
 * basename has a script extension), strip directory + extension, and format the
 * basename (kebab/snake/camel → Title Case). Falls back to the first bare verb
 * token. Returns undefined only when nothing usable can be extracted, so the
 * caller can still drop to the raw id.
 */
const SCRIPT_EXT_RE = /\.(ps1|sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|bat|cmd|exe)$/i;

export function deriveNameFromCommand(command: string): string | undefined {
  const raw = command.trim();
  if (!raw) return undefined;

  // Tokenise on whitespace but keep quoted paths intact enough to grab a basename.
  const tokens = raw.match(/[^\s"']+|"[^"]*"|'[^']*'/g) ?? [];

  // 1. Prefer a token that looks like a script path with a known extension.
  for (const tokenRaw of tokens) {
    const token = tokenRaw.replace(/^["']|["']$/g, "");
    // Skip flags and env assignments.
    if (token.startsWith("-") || token.includes("=")) continue;
    const base = token.split(/[\\/]/).pop() ?? token;
    if (SCRIPT_EXT_RE.test(base)) {
      const stem = base.replace(SCRIPT_EXT_RE, "");
      const formatted = formatNameStem(stem);
      if (formatted) return formatted;
    }
  }

  // 2. Otherwise use the first token that is not a known shell/interpreter
  //    wrapper, formatted as a fallback label.
  const WRAPPERS = new Set([
    "powershell", "pwsh", "bash", "sh", "zsh", "cmd", "node", "python",
    "python3", "py", "npx", "deno", "bun", "uv", "ruby", "perl", "cmd.exe",
    "powershell.exe", "&", "$env:claude_project_dir",
  ]);
  for (const tokenRaw of tokens) {
    const token = tokenRaw.replace(/^["']|["']$/g, "");
    if (token.startsWith("-") || token.includes("=")) continue;
    const base = (token.split(/[\\/]/).pop() ?? token).toLowerCase();
    if (WRAPPERS.has(base)) continue;
    const formatted = formatNameStem(token.split(/[\\/]/).pop() ?? token);
    if (formatted) return formatted;
  }

  return undefined;
}

/** Turn a kebab/snake/camel basename stem into a Title Case label. */
export function formatNameStem(stem: string): string | undefined {
  const cleaned = stem
    // camelCase / PascalCase → spaced
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // separators → spaces
    .replace(/[-_.]+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  return words
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}
