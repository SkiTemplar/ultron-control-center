// Nodo del árbol de subagentes de una sesión (§ AgentNode de CONTRATO.md).

export interface AgentNode {
  agentId: string;
  parentAgentId: string | null;
  type: string;
  description: string;
  /** `stale`: transcript sin escrituras ni fin de turno; puede seguir con una orden larga. */
  status: "running" | "done" | "error" | "stale";
  startedAt: string;
  turns: number;
  tokens: number;
  /** Run de `Workflow` al que pertenece; `null` o ausente si es un subagente suelto. */
  workflowRun?: string | null;
  /** `maxTurns` del frontmatter de `~/.claude/agents/<tipo>.md`; `null` si no lo declara. */
  maxTurns?: number | null;
}
