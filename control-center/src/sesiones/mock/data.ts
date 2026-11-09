// Datos de ejemplo de la demo: tres sesiones vivas, historial con markdown,
// herramientas con diff, árbol de subagentes y git (v0.2 en data-v2.ts).

import type {
  AgentNode,
  Ask,
  ChatMessage,
  GitCommitInfo,
  GitRepoSnapshot,
  PastSession,
  PermissionMode,
  SessionInfo,
  StatusPayload,
} from "../types";
import { ANSWER_CAUSE, PRACTICA_ANSWER, REVIEW_ANSWER, USAGE_IMAGE } from "./texts";

const now = Date.now();
export const ago = (min: number): string => new Date(now - min * 60000).toISOString();

/** Campos v3 de `SessionInfo` (§1.1) de una sesión libre con puente v2. */
export function liveFields(permissionMode: PermissionMode): LiveFields {
  return {
    waiting: null, stalled: null, workingSince: null, lastActivityAt: ago(0), turnId: null, screen: "prompt",
    permissionMode, launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
  };
}

type LiveFields = Pick<
  SessionInfo,
  "waiting" | "stalled" | "workingSince" | "lastActivityAt" | "turnId" | "screen" | "permissionMode" | "launchPermissionMode" | "exitCode" | "bridgeProtocol"
>;

export const CWD_ULTRON = "D:\\proyectos\\ultron";
export const CWD_RENDER = "C:\\demo\\render-lab";

export const SESSIONS: SessionInfo[] = [
  {
    id: "s-mods", projectId: "skills-ultron", projectName: "skills-ultron", cwd: CWD_ULTRON,
    title: "Mods de flujo", claudeSessionId: "6f1c2a90-1d1e-4b51-9a0e-2f0d3e6b8c11",
    status: "working", model: "claude-opus-5-5", startedAt: ago(42), bridgeConnected: true,
    ...liveFields("auto"), workingSince: ago(1), turnId: "turn-mods-1", screen: "busy",
  },
  {
    id: "s-review", projectId: "ultron", projectName: "ultron", cwd: CWD_ULTRON,
    title: "Revisión adversarial PR #41", claudeSessionId: "0b9e7c44-5a51-4c0c-b0a4-6b8a2c7d9e02",
    status: "waiting", model: "claude-opus-5-5", startedAt: ago(18), bridgeConnected: true,
    ...liveFields("plan"), workingSince: ago(2), turnId: "turn-review-1",
    waiting: { kind: "permission", askId: "ask-review-1", label: "permiso Bash", since: ago(1) },
  },
  {
    id: "s-practica", projectId: "render-lab", projectName: "render-lab", cwd: CWD_RENDER,
    title: "Práctica 7 · sombras", claudeSessionId: "93aa01d2-77f4-4e0f-8d0b-1c3b5e9f7a43",
    status: "idle", model: "claude-sonnet-5-5", startedAt: ago(130), bridgeConnected: true,
    ...liveFields("default"),
  },
];

export const PAST: PastSession[] = [
  { claudeSessionId: "p-1", cwd: CWD_ULTRON, projectName: "ultron", preview: "Jurado A/B de la memoria: 21 casos", lastActivity: ago(60 * 20) },
  { claudeSessionId: "p-2", cwd: "D:\\proyectos\\explored", projectName: "explored", preview: "Build rota de Explored tras subir el motor", lastActivity: ago(60 * 26) },
  { claudeSessionId: "p-3", cwd: CWD_RENDER, projectName: "render-lab", preview: "Shadow mapping con PCF y sesgo adaptativo", lastActivity: ago(60 * 50) },
  { claudeSessionId: "p-4", cwd: CWD_ULTRON, projectName: "skills-ultron", preview: "Routing de subagentes por frases completas", lastActivity: ago(60 * 75) },
];

const OPUS = "claude-opus-5-5";

/** Salida larga y verosímil para que el reparto del contexto tenga peso real. */
function longOutput(lines: number, make: (i: number) => string): string {
  return Array.from({ length: lines }, (_, i) => make(i + 1)).join("\n");
}
const VIEW_SOURCE = longOutput(2600, (i) => `${String(i).padStart(4)}  ${i % 9 === 0 ? "" : "  "}const fila${i} = h(Box, { width: anchoColumna(e.props.bodyColumns, ${i % 40}) }, etiqueta)`);
const TEST_OUTPUT = longOutput(900, (i) => `  ✓ narrow · caso ${i}: cabe en ${60 + (i % 120)} columnas (${(i % 7) + 1} ms)`);
const usage = (input: number, output: number) => ({ input, output, cacheRead: input * 6, cacheWrite: 900 });

const EDIT_OLD = `  const width = 38
  return h(Box, { width }, label)`;
const EDIT_NEW = `  const width = Math.min(38, Math.max(20,
    e.props.bodyColumns - 42))
  return h(Box, { width, flexWrap: "wrap" }, label)`;

export const MODS_MESSAGES: ChatMessage[] = [
  {
    uuid: "m1", role: "user", timestamp: ago(40), agentId: null,
    blocks: [
      { kind: "text", text: "El panel de uso se corta en la terminal estrecha. Mira la captura y arréglalo sin tocar el cálculo del ritmo." },
      { kind: "image", mediaType: "image/svg+xml", dataUrl: USAGE_IMAGE, path: "~/.ultron/adjuntos/2026-10-07/captura-uso.png" },
    ],
  },
  {
    uuid: "m2", role: "assistant", timestamp: ago(39), agentId: null, model: OPUS, usage: usage(4200, 380),
    blocks: [
      { kind: "thinking", text: "La captura muestra la tercera barra desbordando a la derecha. Probablemente un ancho fijo en la vista; miro view.tsx y quién usa bodyColumns." },
      { kind: "toolUse", id: "t1", name: "Read", input: { file_path: "mods/ultron-uso/hooks/view.tsx" }, summary: "mods/ultron-uso/hooks/view.tsx" },
      { kind: "toolUse", id: "t2", name: "Grep", input: { pattern: "bodyColumns", path: "mods/" }, summary: "bodyColumns · mods/" },
    ],
  },
  {
    uuid: "m3", role: "user", timestamp: ago(39), agentId: null,
    blocks: [
      { kind: "toolResult", toolUseId: "t1", isError: false, text: VIEW_SOURCE },
      { kind: "toolResult", toolUseId: "t2", isError: false, text: "mods/ultron-uso/hooks/view.tsx:58\nmods/ultron-uso/hooks/layout.ts:12\nmods/ultron-relevo/hooks/panel.tsx:31" },
    ],
  },
  {
    uuid: "m4", role: "assistant", timestamp: ago(37), agentId: null, model: OPUS, usage: usage(5100, 920),
    blocks: [
      { kind: "text", text: "El ancho de la columna está fijado a 38. Lo hago depender de `bodyColumns` y pruebo." },
      { kind: "toolUse", id: "t3", name: "Edit", input: { file_path: "mods/ultron-uso/hooks/view.tsx", old_string: EDIT_OLD, new_string: EDIT_NEW }, summary: "mods/ultron-uso/hooks/view.tsx" },
      { kind: "toolUse", id: "t4", name: "Write", input: { file_path: "mods/ultron-uso/tests/narrow.test.ts", content: "import { render } from \"../test-utils\"\n\nfor (const cols of [80, 120, 180]) {\n  test(`cabe en ${cols} columnas`, () => {\n    expect(render(cols).overflow).toBe(false)\n  })\n}\n" }, summary: "mods/ultron-uso/tests/narrow.test.ts" },
      { kind: "toolUse", id: "t5", name: "Bash", input: { command: "claude plugin test ~/.ultron/mods/ultron-uso" }, summary: "claude plugin test ~/.ultron/mods/ultron-uso" },
      { kind: "toolUse", id: "t6", name: "Task", input: { description: "Revisa view.tsx: ancho y salto de línea", subagent_type: "code-reviewer" }, summary: "code-reviewer · Revisa view.tsx: ancho y salto de línea" },
    ],
  },
  {
    uuid: "m5", role: "user", timestamp: ago(35), agentId: null,
    blocks: [
      { kind: "toolResult", toolUseId: "t3", isError: false, text: "Fichero actualizado." },
      { kind: "toolResult", toolUseId: "t4", isError: false, text: "Fichero creado (8 líneas)." },
      { kind: "toolResult", toolUseId: "t5", isError: false, text: `${TEST_OUTPUT}\n\n9 passed, 0 failed (1,2 s)` },
      { kind: "toolResult", toolUseId: "t6", isError: false, text: "Revisión en curso (subagente lanzado en segundo plano)." },
    ],
  },
  { uuid: "m6", role: "assistant", timestamp: ago(33), agentId: null, model: OPUS, usage: usage(6900, 1400), blocks: [{ kind: "text", text: ANSWER_CAUSE }] },
  { uuid: "m7", role: "user", timestamp: ago(2), agentId: null, blocks: [{ kind: "text", text: "¿Y en 80 columnas cómo queda? Enséñamelo." }] },
];

export const REVIEWER_MESSAGES: ChatMessage[] = [
  { uuid: "r1", role: "user", timestamp: ago(34), agentId: "a-reviewer", blocks: [{ kind: "text", text: "Revisa el cambio de `view.tsx`: ancho adaptable y salto de línea. Severidad CRITICAL/HIGH bloquea." }] },
  {
    uuid: "r2", role: "assistant", timestamp: ago(33), agentId: "a-reviewer", model: OPUS,
    blocks: [
      { kind: "toolUse", id: "rt1", name: "Bash", input: { command: "git diff -- mods/ultron-uso" }, summary: "git diff -- mods/ultron-uso" },
      { kind: "toolUse", id: "rt2", name: "Task", input: { description: "Genera casos límite de ancho", subagent_type: "test-automator" }, summary: "test-automator · casos límite de ancho" },
    ],
  },
  { uuid: "r3", role: "assistant", timestamp: ago(30), agentId: "a-reviewer", model: OPUS, blocks: [{ kind: "text", text: "Sin hallazgos CRITICAL ni HIGH. Espero los casos límite de `test-automator` (anchos 40 y 60) antes de cerrar." }] },
];

export const REVIEW_MESSAGES: ChatMessage[] = [
  { uuid: "v1", role: "user", timestamp: ago(17), agentId: null, blocks: [{ kind: "text", text: "Haz una revisión adversarial del PR #41 y arregla lo que sea HIGH." }] },
  { uuid: "v2", role: "assistant", timestamp: ago(12), agentId: null, model: OPUS, usage: usage(8800, 2100), blocks: [{ kind: "text", text: REVIEW_ANSWER }] },
];

const RICH_ANSWER = [
  "## Pipeline de sombras",
  "",
  "> [!TIP]",
  "> El sesgo depende de la pendiente: $b = \\max(0{,}05 \\cdot (1 - \\vec{n} \\cdot \\vec{l}),\\ 0{,}005)$.",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Pase de profundidad] --> B[Shadow map 2048²]",
  "  B --> C{PCF 3x3}",
  "  C -->|visible| D[Iluminación]",
  "  C -->|sombra| E[Ambiente]",
  "```",
  "",
  "| Resolución | Tiempo | Acné |",
  "|---|---|---|",
  "| 1024 | 0,42 ms | sí ✗ |",
  "| 2048 | 0,95 ms | no ✓ |",
  "| 4096 | 3,10 ms | no ✓ |",
  "",
  "```chart",
  '{"data":{"values":[{"res":"1024","ms":0.42},{"res":"2048","ms":0.95},{"res":"4096","ms":3.1}]},"mark":"bar","encoding":{"x":{"field":"res","type":"nominal","title":"Resolución"},"y":{"field":"ms","type":"quantitative","title":"ms"}}}',
  "```",
  "",
  "```dot",
  "digraph { rankdir=LR; depth -> shadowmap -> pcf -> lit; }",
  "```",
  "",
  "```diff src/shaders/shadow.frag",
  "@@ -12,3 +12,3 @@",
  "-float bias = 0.005;",
  "+float bias = max(0.05 * (1.0 - dot(n, l)), 0.005);",
  "```",
  "",
  "Cambio en `src/shaders/shadow.frag:14`; pulsa <kbd>F5</kbd> para recompilar.",
  "",
  "<details><summary>Por qué no basta un sesgo fijo</summary>",
  "",
  "Con superficies casi paralelas a la luz el error de muestreo crece con la tangente del ángulo.",
  "",
  "</details>",
].join("\n");

export const PRACTICA_MESSAGES: ChatMessage[] = [
  { uuid: "q1", role: "user", timestamp: ago(128), agentId: null, blocks: [{ kind: "text", text: "Las sombras tienen acné en el suelo. ¿Qué sesgo uso?" }] },
  { uuid: "q2", role: "assistant", timestamp: ago(126), agentId: null, model: "claude-sonnet-5-5", blocks: [{ kind: "text", text: PRACTICA_ANSWER }] },
  { uuid: "q3", role: "user", timestamp: ago(125), agentId: null, blocks: [{ kind: "text", text: "Resúmeme el pipeline con diagrama, tabla y gráfica." }] },
  { uuid: "q4", role: "assistant", timestamp: ago(124), agentId: null, model: "claude-sonnet-5-5", blocks: [{ kind: "text", text: RICH_ANSWER }] },
];

export const MODS_AGENTS: AgentNode[] = [
  { agentId: "a-reviewer", parentAgentId: null, type: "code-reviewer", description: "Revisa view.tsx: ancho y salto de línea", status: "running", startedAt: ago(34), turns: 12, tokens: 48200, maxTurns: 100 },
  { agentId: "a-tests", parentAgentId: "a-reviewer", type: "test-automator", description: "Casos límite de ancho: 40 y 60 columnas", status: "running", startedAt: ago(31), turns: 5, tokens: 17400, maxTurns: 120 },
  { agentId: "a-explore", parentAgentId: null, type: "Explore", description: "Localizó los usos de bodyColumns · 3 ficheros", status: "done", startedAt: ago(38), turns: 6, tokens: 21100 },
];

export const STATUS: StatusPayload[] = [
  { id: "s-mods", model: OPUS, contextTokens: 168000, contextWindow: 1000000, costUsd: 3.42, mode: "auto" },
  { id: "s-review", model: OPUS, contextTokens: 186000, contextWindow: 1000000, costUsd: 1.1, mode: "plan" },
  { id: "s-practica", model: "claude-sonnet-5-5", contextTokens: 64000, contextWindow: 200000, mode: "auto" },
];

export const REVIEW_ASK: Ask = {
  askId: "ask-review-1", id: "s-review", kind: "permission", tool: "Bash", agentId: null,
  input: { command: "git commit -m \"fix(puente): compara el token en tiempo constante\"" },
  summary: "git commit -m \"fix(puente): compara el token en tiempo constante\"",
  reason: "Bash quiere ejecutar en D:\\proyectos\\ultron",
};

export const GIT: GitRepoSnapshot = {
  state: { is_repo: true, branch: "main", remote: "origin", ahead: 2, behind: 0, dirty: true, dirty_count: 3, path: CWD_ULTRON },
  changes: [
    { path: "mods/ultron-uso/hooks/view.tsx", index_status: " ", worktree_status: "M", staged: false, untracked: false },
    { path: "mods/ultron-uso/tests/narrow.test.ts", index_status: "?", worktree_status: "?", staged: false, untracked: true },
    { path: "mods/ultron-uso/README.md", index_status: "M", worktree_status: " ", staged: true, untracked: false },
  ],
};

export const GIT_LOG: GitCommitInfo[] = [
  { hash: "d4c8229aa", short: "d4c8229", author: "dev", date: ago(300), subject: "feat(mods): /uso compacto con ritmo" },
  { hash: "50e5977bb", short: "50e5977", author: "dev", date: ago(900), subject: "feat(mods): skills, codex y git en el panel" },
  { hash: "20d6e7bcc", short: "20d6e7b", author: "dev", date: ago(1500), subject: "fix(mods): permisos con lista blanca de flags" },
];

export const DIFF_VIEW = `diff --git a/mods/ultron-uso/hooks/view.tsx b/mods/ultron-uso/hooks/view.tsx
@@ -55,7 +55,9 @@ export function UsoRow(e: RowProps) {
   const label = formatLimit(e.limit)
-  const width = 38
-  return h(Box, { width }, label)
+  const width = Math.min(38, Math.max(20,
+    e.props.bodyColumns - 42))
+  return h(Box, { width, flexWrap: "wrap" }, label)
 }
`;

export const FILES = [
  "mods/ultron-uso/hooks/view.tsx", "mods/ultron-uso/hooks/layout.ts", "mods/ultron-uso/tests/narrow.test.ts",
  "mods/ultron-uso/README.md", "mods/ultron-relevo/hooks/panel.tsx", "mods/ultron-puente/index.ts",
  "control-center/src/sesiones/App.tsx", "control-center/docs/sesiones/CONTRATO.md", "CLAUDE.md",
];
