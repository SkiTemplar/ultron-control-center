// Datos de ejemplo de los comandos v0.2: ajustes, historial, catálogo de
// comandos, mods, bitácora, motores e intervenciones.

import type { Bitacora, CommandDef, EngineStatus, EngineTask, SessionSettings } from "../types";
import { CWD_ULTRON, ago } from "./data";

export const SETTINGS: Record<string, SessionSettings> = {
  "s-mods": { model: "claude-opus-5-5", effort: "high", permissionMode: "auto", socratic: "light", projectId: "skills-ultron", launchPermissionMode: "bypassPermissions" },
  "s-review": { model: "claude-opus-5-5", effort: "xhigh", permissionMode: "plan", socratic: "strict", projectId: "ultron", launchPermissionMode: "bypassPermissions" },
  "s-practica": { model: "claude-sonnet-5-5", effort: "medium", permissionMode: "default", socratic: "uni", projectId: "render-lab", launchPermissionMode: "bypassPermissions" },
};

export const PROMPT_HISTORY: string[] = [
  "¿Y en 80 columnas cómo queda? Enséñamelo.",
  "El panel de uso se corta en la terminal estrecha. Mira la captura y arréglalo sin tocar el cálculo del ritmo.",
  "Haz una revisión adversarial del PR #41 y arregla lo que sea HIGH.",
  "Añade un test de 40 columnas en mods/ultron-uso/tests/narrow.test.ts que falle sin el fix",
  "Explícame por qué el FTS5 se desincroniza con INSERT OR REPLACE",
  "/compact",
  "Las sombras tienen acné en el suelo. ¿Qué sesgo uso?",
  "Prepara el commit con conventional commits y enséñame el diff antes",
  "Revisa el contrato v2 de Sessions y dime qué falta en el backend",
  "Pasa el build:local y dime si hay warnings de cargo",
  "¿Qué subagente uso para auditar el routing de skills?",
];

export const COMMANDS: CommandDef[] = [
  { name: "compact", description: "Compacta el contexto de la conversación", argHint: "[instrucciones]", source: "builtin", kind: "prompt", needsArgs: false, immediate: false },
  { name: "clear", description: "Empieza una conversación limpia", source: "builtin", kind: "local", needsArgs: false, immediate: false },
  { name: "model", description: "Cambia el modelo de la sesión", argHint: "<modelo>", source: "builtin", kind: "panel", panel: "model", needsArgs: false, immediate: false },
  { name: "context", description: "Muestra el uso del contexto", source: "builtin", kind: "panel", panel: "context", needsArgs: false, immediate: false },
  { name: "review", description: "Revisa los cambios pendientes", source: "builtin", kind: "prompt", needsArgs: false, immediate: false },
  { name: "cost", description: "Coste y duración de la sesión", source: "builtin", kind: "panel", panel: "usage", needsArgs: false, immediate: false },
  { name: "mejorar", description: "Reescribe el borrador con contexto del proyecto", argHint: "<borrador>", source: "mod", origin: "ultron-mejorar", kind: "prompt", needsArgs: true, immediate: false },
  { name: "relevo", description: "Prepara el relevo para otra sesión", source: "mod", origin: "ultron-relevo", kind: "local", needsArgs: false, immediate: false },
  { name: "compilar", description: "Compila el proyecto con su receta", source: "mod", origin: "ultron-flujo", kind: "local", needsArgs: false, immediate: true },
  { name: "probar", description: "Ejecuta los tests del proyecto", source: "mod", origin: "ultron-flujo", kind: "local", needsArgs: false, immediate: true },
  { name: "arrancar", description: "Arranca la app del proyecto", source: "mod", origin: "ultron-flujo", kind: "local", needsArgs: false, immediate: true },
  { name: "uso", description: "Panel de uso del plan con ritmo semanal", source: "mod", origin: "ultron-uso", kind: "panel", panel: "uso", needsArgs: false, immediate: true },
  { name: "commit", description: "Commit con conventional commits y diff validado", source: "skill", origin: "commit", kind: "prompt", needsArgs: false, immediate: false },
  { name: "codex:rescue", description: "Segunda opinión de Codex ante un bug que resiste", argHint: "[--model]", source: "user", kind: "prompt", needsArgs: false, immediate: false },
  { name: "sesiones-capturas", description: "Regenera las capturas de ULTRON Sessions", source: "project", kind: "prompt", needsArgs: false, immediate: false },
];

export const BITACORA: Bitacora = {
  resumen: "ULTRON Sessions v0.2: interfaz de terminal, HUD, paleta de comandos y motores mezclados en el hilo. Backend de comandos nuevos en paralelo.",
  pendientes: ["Verificar sesiones_set_effort contra Claude Code real", "Gemini por agy: prompt por fichero (ENAMETOOLONG)", "build:local con ULTRON cerrado"],
  decisiones: ["Claude Code es el conductor; Codex y Gemini intervienen sin entrar en su contexto hasta «Traer»", "Desplegables propios en vez de <select> nativo"],
  gotchas: ["El .exe no se relinka con ULTRON abierto", "sesiones.html sin estilos inline: la CSP con nonce los bloquea"],
  updatedAt: ago(45),
};

export function engineStatus(withoutGemini: boolean): EngineStatus[] {
  return [
    { id: "codex", available: true, version: "codex-cli 0.48.0" },
    withoutGemini
      ? { id: "gemini", available: false, reason: "No se encontró agy ni gemini en el PATH" }
      : { id: "gemini", available: true, version: "agy 1.4.2" },
    { id: "opencode", available: true, version: "opencode 1.19.4", note: "Proveedores con key: DeepSeek, OpenRouter, Groq" },
  ];
}

export const ENGINE_TASKS: EngineTask[] = [
  {
    id: "cx-1", engine: "codex", kind: "opinion", mode: "local", cwd: CWD_ULTRON, sessionId: "s-mods",
    prompt: "Segunda opinión sobre el diff de view.tsx", status: "running", startedAt: ago(3),
    events: [
      { kind: "command", text: "rg -n bodyColumns mods/" },
      { kind: "message", text: "El cálculo de ancho es correcto; reviso el caso de 0 columnas." },
      { kind: "command", text: "npx vitest run mods/ultron-uso" },
    ],
  },
  {
    id: "gm-1", engine: "gemini", kind: "opinion", mode: "local", cwd: CWD_ULTRON, sessionId: "s-mods", contextChars: 18400,
    prompt: "Segunda opinión sobre la causa del corte", status: "done", startedAt: ago(32), finishedAt: ago(31),
    events: [{ kind: "message", text: "Leído el transcript: 3 turnos, 18 400 caracteres." }],
    summary: "De acuerdo con la causa. Riesgo: con `bodyColumns < 62` el `Math.max(20, …)` deja la columna en 20 y el porcentaje se parte; añade un caso de **60 columnas** al test.",
  },
  {
    id: "cx-0", engine: "codex", kind: "task", mode: "cloud", cwd: CWD_ULTRON, sessionId: "s-review",
    prompt: "Auditar el parser de JSONL con transcripts grandes", status: "done", startedAt: ago(95), finishedAt: ago(71), cloudTaskId: "task_e_6a1f",
    events: [
      { kind: "command", text: "cargo test -p sesiones parser" },
      { kind: "patch", text: "src/sesiones/jsonl.rs · +18 −4" },
      { kind: "message", text: "Líneas truncadas a mitad de escritura: ahora se reintentan en la siguiente lectura." },
    ],
    summary: "Corrige la lectura de líneas a medio escribir en el seguidor de JSONL (+18 −4) y añade dos tests.",
  },
];
