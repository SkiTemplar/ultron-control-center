// Barrel — re-exports every type from the domain modules.
// Importers using `from "./types"` or `from "../types"` resolve here
// via TypeScript's directory index resolution, so NO existing import
// needs to change.

export * from "./core";
export * from "./usage";
export * from "./settings";
export * from "./system";
export * from "./ai-router";
export * from "./skills-agents";
export * from "./mcp";
export * from "./auth";
export * from "./projects";
export * from "./kanban";
export * from "./library";
export * from "./diagnostics";
export * from "./memory";
