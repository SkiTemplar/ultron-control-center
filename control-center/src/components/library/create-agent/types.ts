import type { TargetScope } from "../../../types";
import type { AgentModelId } from "../creatorTemplates";

export type Props = {
  defaultScope?: TargetScope;
  defaultProjectId?: string;
  projects: { id: string; name: string }[];
  onClose: () => void;
  onCreated: (writtenPath: string) => void;
};

export type Step = 1 | 2 | 3 | 4;
export type ModelChoice = AgentModelId;
