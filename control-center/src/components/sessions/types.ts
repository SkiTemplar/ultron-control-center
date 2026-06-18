import type { SessionProvider, WorkspaceSummary } from "../../types";

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export type Presets = {
  dangerouslySkipPermissions: boolean;
  effort: "" | "low" | "medium" | "high" | "xhigh" | "max";
};

// ---------------------------------------------------------------------------
// Provider catalogue
// ---------------------------------------------------------------------------

export type ProviderMeta = {
  label: string;
  accent: string;
  models: { id: string; label: string }[];
  defaultModel: string;
  acceptsModel: boolean;
};

// ---------------------------------------------------------------------------
// LauncherModal props
// ---------------------------------------------------------------------------

export type LauncherModalProps = {
  mode: "custom" | "send-context";
  workspace: WorkspaceSummary;
  busy: boolean;
  onClose: () => void;
  onLaunch: (opts: { provider: SessionProvider; model: string }) => void;
};

// ---------------------------------------------------------------------------
// WorkspaceCard props
// ---------------------------------------------------------------------------

export type WorkspaceCardProps = {
  ws: WorkspaceSummary;
  busy: boolean;
  onNew: (ws: WorkspaceSummary) => void;
  onCustom: (ws: WorkspaceSummary) => void;
  onSendContext: (ws: WorkspaceSummary) => void;
  onCreateProject: (ws: WorkspaceSummary) => void;
  creatingProject: boolean;
};
