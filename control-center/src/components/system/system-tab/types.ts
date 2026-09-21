// Tipos y textos compartidos por las sub-pestañas de Sistema.

export type SystemSubTab = "diagnostics" | "tasks";

export const CONTEXT_HINTS: Record<SystemSubTab, string> = {
  diagnostics:
    "Diagnóstico del PC bajo demanda: cuando Claude Code no arranca, la terminal no abre o aparecen errores de permisos. Incluye arreglos de un clic sobre el registro de eventos.",
  tasks:
    "Tareas programadas de mar.ia (vigilante de Qdrant, copias, diagnóstico diario): último resultado, próxima ejecución, ejecutar ahora, editar el disparador o eliminarlas.",
};
