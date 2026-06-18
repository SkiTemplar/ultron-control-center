import type { SessionProvider } from "../../types";
import type { Presets, ProviderMeta } from "./types";

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const PRESETS_KEY = "ultron.cc.session_presets.v1";

export const DEFAULT_PRESETS: Presets = {
  dangerouslySkipPermissions: false,
  effort: "",
};

// ---------------------------------------------------------------------------
// Workspace CWD persistence key
// ---------------------------------------------------------------------------

export const WORKSPACE_KEY = "ultron.cc.session.cwd.v1";

// ---------------------------------------------------------------------------
// Provider catalogue
// ---------------------------------------------------------------------------

export const PROVIDERS: Record<SessionProvider, ProviderMeta> = {
  claude: {
    label: "Claude",
    accent: "var(--color-success)",
    acceptsModel: true,
    models: [
      { id: "", label: "default (account current)" },
      { id: "claude-opus-4-7", label: "Opus 4.7 · best quality" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6 · balanced" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 · fast" },
    ],
    defaultModel: "",
  },
  gemini: {
    label: "Gemini",
    accent: "var(--color-warn)",
    acceptsModel: true,
    models: [
      { id: "gemini-3.1-pro-preview", label: "3.1 Pro · best quality" },
      { id: "gemini-3.1-flash-lite", label: "3.1 Flash Lite · fast" },
      { id: "gemini-2.5-pro", label: "2.5 Pro · stable" },
      { id: "gemini-2.5-flash", label: "2.5 Flash · stable fast" },
    ],
    defaultModel: "gemini-3.1-pro-preview",
  },
  codex: {
    label: "Codex",
    accent: "#a875ff",
    acceptsModel: true,
    models: [
      { id: "", label: "default (gpt-5.5)" },
      { id: "gpt-5.5", label: "gpt-5.5" },
      { id: "gpt-5.5-thinking", label: "gpt-5.5 thinking" },
    ],
    defaultModel: "",
  },
};

// ---------------------------------------------------------------------------
// Grouping threshold
// ---------------------------------------------------------------------------

export const GROUP_THRESHOLD = 5;
