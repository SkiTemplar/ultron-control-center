/**
 * kanban-update-reminder.selftest.mjs — check conductual del Stop hook de
 * cierre de kanban (cat21.1).
 *
 * Contrato bajo prueba (kirkardo-eval.mjs 21.1, revisado 2026-08-19): dado un
 * transcript con una peticion accionable, el asistente marcandola hecha Y un
 * commit reciente que matchea el titulo de una card viva, el hook debe CERRAR
 * esa card en kanban.json. Sin esa evidencia dura NO escribe nada: solo el
 * texto "RECORDATORIO". El auto-registro de cards nuevas se retiro por
 * invasivo (llenaba el board de entradas [auto] no pedidas).
 *
 * Aislamiento: usa KANBAN_REMINDER_BASE_OVERRIDE + KANBAN_REMINDER_SESSION_STATE_OVERRIDE
 * para NUNCA tocar el cockpit/projects/ real del usuario (mismo patron que
 * SUBAGENT_LIFECYCLE_LOG en subagent-lifecycle.selftest.mjs). Todo vive en un
 * fixture temporal bajo logs/_selftest-kanban-reminder/, limpiado al final.
 *
 * Casos:
 *   1) POSITIVO (cierre real por commit): repo git temporal con un commit
 *      reciente cuyo asunto matchea (Jaccard) el titulo de una card viva ->
 *      la card se mueve a Done, sin recordatorio de solo-texto.
 *   2) NEGATIVO (sin evidencia): sin commits que matcheen (root no es repo
 *      git) -> kanban INTACTO y additionalContext = solo RECORDATORIO.
 *   3) NEGATIVO: transcript sin marcador de finalizacion del asistente ->
 *      kanban INTACTO, hook no escribe nada a stdout.
 *
 * Uso: node hooks/scripts/kanban-update-reminder.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync, execFileSync } from "node:child_process";
import {
  readFileSync, writeFileSync, existsSync, rmSync, mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..", "..");
const HOOK = join(__dirname, "kanban-update-reminder.js");

const FIXTURE_ROOT = join(ULTRON, "logs", "_selftest-kanban-reminder");
const KANBAN_BASE = join(FIXTURE_ROOT, "projects");
const PROJECT = "selftest-proj";
const KANBAN_PATH = join(KANBAN_BASE, PROJECT, "kanban.json");
// Selecciona el proyecto EXPLICITAMENTE (independiente del basename del cwd
// de cada caso, que aqui apunta a repos git temporales sin relacion con el
// nombre del proyecto fixture).
const SESSION_STATE = join(FIXTURE_ROOT, "current-session.json");

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

function resetFixture() {
  if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  mkdirSync(KANBAN_BASE, { recursive: true });
  writeFileSync(SESSION_STATE, JSON.stringify({ active_project: PROJECT }), "utf8");
}

function baseBoard() {
  return {
    project_id: PROJECT,
    columns: [
      { id: "col-todo", name: "Backlog", order: 0, role: "todo" },
      { id: "col-doing", name: "In Progress", order: 1, role: "doing" },
      { id: "col-done", name: "Done", order: 2, role: "done" },
    ],
    cards: [
      {
        id: "card-live-1",
        column_id: "col-todo",
        title: "Implementar validacion de emails en el formulario de registro",
        description: "",
        agent: null,
        prompt_template: null,
        cwd: null,
        tags: [],
        order: 0,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        runs: [],
      },
    ],
  };
}

function writeBoard(board) {
  mkdirSync(dirname(KANBAN_PATH), { recursive: true });
  writeFileSync(KANBAN_PATH, JSON.stringify(board, null, 2) + "\n", "utf8");
}

function readBoard() {
  return JSON.parse(readFileSync(KANBAN_PATH, "utf8"));
}

function doneTitles(board) {
  const doneCols = new Set(board.columns.filter((c) => c.role === "done").map((c) => c.id));
  return board.cards.filter((c) => doneCols.has(c.column_id)).map((c) => c.title);
}

function makeTranscript(fixtureDir, name, userText, assistantText) {
  const p = join(fixtureDir, `${name}.jsonl`);
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: userText } }),
  ];
  if (assistantText !== null) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: assistantText }] },
      }),
    );
  }
  writeFileSync(p, lines.join("\n"), "utf8");
  return p;
}

function fireHook({ transcriptPath, cwd, sessionId }) {
  const payload = JSON.stringify({
    transcript_path: transcriptPath.replace(/\\/g, "/"),
    cwd: cwd.replace(/\\/g, "/"),
    hook_event_name: "Stop",
    session_id: sessionId,
  });
  const r = spawnSync("node", [HOOK], {
    input: payload,
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      KANBAN_REMINDER_BASE_OVERRIDE: KANBAN_BASE,
      KANBAN_REMINDER_SESSION_STATE_OVERRIDE: SESSION_STATE,
    },
  });
  return { stdout: (r.stdout || "").trim(), status: r.status, stderr: r.stderr || "" };
}

function gitInitWithCommit(dir, subject) {
  mkdirSync(dir, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "selftest@ultron.local"]);
  git(["config", "user.name", "kirkardo-selftest"]);
  git(["commit", "--allow-empty", "-q", "-m", subject]);
}

// ---------------------------------------------------------------------------
resetFixture();

// --- Caso 1: cierre real de card viva por match de commit -----------------
writeBoard(baseBoard());
const repoDir1 = join(FIXTURE_ROOT, "repo-with-commit");
gitInitWithCommit(repoDir1, "feat(auth): implementar validacion de emails en el formulario de registro");
const t1 = makeTranscript(
  FIXTURE_ROOT,
  "t1",
  "arregla el bug de validacion en el registro",
  "Listo, completado. La tarea quedo hecha.",
);
const before1 = doneTitles(readBoard());
const r1 = fireHook({ transcriptPath: t1, cwd: repoDir1, sessionId: "selftest-close" });
const board1 = readBoard();
const after1 = doneTitles(board1);

A(r1.status === 0, "caso1: hook exit 0", `status=${r1.status} stderr=${r1.stderr}`);
A(
  after1.length === before1.length + 1 && after1.some((t) => t.includes("validacion de emails")),
  "caso1: card viva cerrada por match de commit (movida a Done)",
  `before=${JSON.stringify(before1)} after=${JSON.stringify(after1)}`,
);
A(
  /BOARD ACTUALIZADO/.test(r1.stdout) && /cerradas por match con commit/.test(r1.stdout),
  "caso1: additionalContext reporta cierre real (no solo RECORDATORIO)",
  r1.stdout,
);
A(
  board1.cards.length === 1,
  "caso1: NO se creo ninguna card nueva (el hook solo mueve cards existentes)",
  `cards=${board1.cards.length}`,
);

// --- Caso 2 (NEGATIVO): sin commit que matchee -> kanban INTACTO ----------
// Antes esto registraba una card nueva ya en Done. Se retiro (2026-08-19): el
// hook solo escribe con evidencia dura de commit; sin ella, recordatorio y ya.
resetFixture();
writeBoard(baseBoard());
const nonGitDir = join(FIXTURE_ROOT, "no-git-cwd");
mkdirSync(nonGitDir, { recursive: true });
const t2 = makeTranscript(
  FIXTURE_ROOT,
  "t2",
  "implementa el sistema de notificaciones push para el movil",
  "Listo. He completado la tarea y ya esta hecha.",
);
const rawBefore2 = readFileSync(KANBAN_PATH, "utf8");
const r2 = fireHook({ transcriptPath: t2, cwd: nonGitDir, sessionId: "selftest-no-evidence" });
const rawAfter2 = readFileSync(KANBAN_PATH, "utf8");

A(r2.status === 0, "caso2: hook exit 0", `status=${r2.status} stderr=${r2.stderr}`);
A(
  rawBefore2 === rawAfter2,
  "caso2: sin commit que matchee -> kanban INTACTO (no inventa cards)",
  `antes=${rawBefore2.length}b despues=${rawAfter2.length}b`,
);
A(
  /RECORDATORIO/.test(r2.stdout) && !/BOARD ACTUALIZADO/.test(r2.stdout),
  "caso2: additionalContext = solo RECORDATORIO",
  r2.stdout,
);

// --- Caso 3 (NEGATIVO): sin marcador de finalizacion -> kanban INTACTO ----
resetFixture();
writeBoard(baseBoard());
const rawBefore3 = readFileSync(KANBAN_PATH, "utf8");
const t3 = makeTranscript(
  FIXTURE_ROOT,
  "t3",
  "implementa el sistema de notificaciones push para el movil",
  "Voy a revisar el enfoque antes de tocar nada.",
);
const r3 = fireHook({ transcriptPath: t3, cwd: nonGitDir, sessionId: "selftest-negative" });
const rawAfter3 = readFileSync(KANBAN_PATH, "utf8");

A(r3.status === 0, "caso3: hook exit 0 (nunca bloquea)", `status=${r3.status} stderr=${r3.stderr}`);
A(rawBefore3 === rawAfter3, "caso3: sin tarea-hecha -> kanban.json BYTE-IDENTICO (no-op real)", "diff detectado");
A(r3.stdout === "", "caso3: sin tarea-hecha -> ningun output (ni cierre ni recordatorio)", `stdout="${r3.stdout}"`);

// --- Caso 4: cierre por FASE compartida + marcador de cierre en el commit --
// (2026-07-13) Caso real Tortunabo: la card "Fase 4 — ..." no matcheaba por
// keys/substring/Jaccard con "docs: Fase 4.2 hecha - Fase 4 completa" y
// quedaba viva -> resume stale. La regla de fase debe cerrarla.
resetFixture();
const board4 = baseBoard();
board4.cards.push({
  id: "card-fase-4",
  column_id: "col-doing",
  title: "Fase 4 — Hardening + tests del modulo",
  description: "",
  agent: null,
  prompt_template: null,
  cwd: null,
  tags: [],
  order: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  runs: [],
});
writeBoard(board4);
const repoDir4 = join(FIXTURE_ROOT, "repo-fase-completa");
gitInitWithCommit(repoDir4, "docs: Fase 4.2 hecha - Fase 4 completa; queda solo el gate de playtest");
const t4 = makeTranscript(
  FIXTURE_ROOT,
  "t4",
  "actualiza el plan: la fase 4 esta terminada",
  "Listo, completado. La fase quedo hecha.",
);
const r4 = fireHook({ transcriptPath: t4, cwd: repoDir4, sessionId: "selftest-fase" });
const boardAfter4 = readBoard();
A(r4.status === 0, "caso4: hook exit 0", `status=${r4.status} stderr=${r4.stderr}`);
A(
  doneTitles(boardAfter4).some((t) => t.startsWith("Fase 4 —")),
  "caso4: card 'Fase 4' cerrada por fase compartida + marcador de cierre",
  `done=${JSON.stringify(doneTitles(boardAfter4))} stdout=${r4.stdout}`,
);

// --- Caso 5 (NEGATIVO): commit de fase SIN marcador de cierre NO cierra ----
resetFixture();
const board5 = baseBoard();
board5.cards.push({
  id: "card-fase-4b",
  column_id: "col-doing",
  title: "Fase 4 — Hardening + tests del modulo",
  description: "",
  agent: null,
  prompt_template: null,
  cwd: null,
  tags: [],
  order: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  runs: [],
});
writeBoard(board5);
const repoDir5 = join(FIXTURE_ROOT, "repo-fase-intermedia");
gitInitWithCommit(repoDir5, "test(chunks): Fase 4 avanza con decisiones puras y pools");
const t5 = makeTranscript(
  FIXTURE_ROOT,
  "t5",
  "avanza con la fase 4",
  "Listo, completado el paso de hoy.",
);
const r5 = fireHook({ transcriptPath: t5, cwd: repoDir5, sessionId: "selftest-fase-neg" });
const boardAfter5 = readBoard();
A(r5.status === 0, "caso5: hook exit 0", `status=${r5.status} stderr=${r5.stderr}`);
A(
  boardAfter5.cards.find((c) => c.id === "card-fase-4b").column_id === "col-doing",
  "caso5: commit intermedio de fase (sin marcador de cierre) NO cierra la card",
  `card=${JSON.stringify(boardAfter5.cards.find((c) => c.id === "card-fase-4b"))}`,
);

// --- Caso 6 (cat-code 2026-08-02): COBERTURA multi-commit --------------------
// Reproduce el caso real legacy-fc: "Deuda: trocear career.ts y events.ts" se
// resolvio en DOS commits, cada uno tocando solo un archivo -> ninguno cruza
// el Jaccard 0.5 de (1)-(3) por si solo, asi que ANTES del fix la card queda
// huerfana en Backlog para siempre (bug real que motivo este caso). El camino
// de cobertura (4) debe cerrarla comparando contra la UNION de ambos commits.
resetFixture();
const board6 = baseBoard();
board6.cards = [
  {
    id: 'card-deuda',
    column_id: 'col-todo',
    title: 'Deuda: trocear career.ts y events.ts',
    description: '',
    agent: null,
    prompt_template: null,
    cwd: null,
    tags: [],
    order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    runs: [],
  },
];
writeBoard(board6);
const repoDir6 = join(FIXTURE_ROOT, 'repo-deuda-troceo');
mkdirSync(repoDir6, { recursive: true });
{
  const git = (args) => execFileSync('git', args, { cwd: repoDir6, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'selftest@ultron.local']);
  git(['config', 'user.name', 'kirkardo-selftest']);
  git(['commit', '--allow-empty', '-q', '-m', 'refactor: trocea career.ts por fases del juego']);
  git(['commit', '--allow-empty', '-q', '-m', 'refactor: trocea events.ts en src/data/base/ por temas']);
}
const t6 = makeTranscript(
  FIXTURE_ROOT,
  't6',
  'refactoriza career.ts y events.ts en archivos mas pequenos',
  'Listo, completado. El troceo quedo hecho.',
);
const r6 = fireHook({ transcriptPath: t6, cwd: repoDir6, sessionId: 'selftest-coverage' });
const boardAfter6 = readBoard();
A(r6.status === 0, 'caso6: hook exit 0', `status=${r6.status} stderr=${r6.stderr}`);
A(
  boardAfter6.cards.find((c) => c.id === 'card-deuda').column_id === 'col-done',
  'caso6: card "Deuda: trocear career.ts y events.ts" cerrada por COBERTURA multi-commit (ningun commit solo cruzaba Jaccard 0.5)',
  `card=${JSON.stringify(boardAfter6.cards.find((c) => c.id === 'card-deuda'))} stdout=${r6.stdout}`,
);

// --- Caso 7 (NEGATIVO / guardrail): sin solape real, la cobertura NO cierra --
// Card real "Revisar generosidad del Salon de la Fama en modo Estrella" +
// asunto REAL de caaae06 (rebalanceo de trade-offs, nada que ver con el HoF).
// El camino de cobertura NO debe inventarse un cierre por azar de vocabulario.
resetFixture();
const board7 = baseBoard();
board7.cards = [
  {
    id: 'card-hof',
    column_id: 'col-todo',
    title: 'Revisar generosidad del Salón de la Fama en modo Estrella',
    description: '',
    agent: null,
    prompt_template: null,
    cwd: null,
    tags: [],
    order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    runs: [],
  },
];
writeBoard(board7);
const repoDir7 = join(FIXTURE_ROOT, 'repo-hof-guardrail');
gitInitWithCommit(
  repoDir7,
  'fix: remata la auditoría del 2026-08-01 y rebalancea los trade-offs de las escenas',
);
const t7 = makeTranscript(
  FIXTURE_ROOT,
  't7',
  'corrige la auditoria de escenas y rebalancea los trade-offs',
  'Listo, completado. Quedo hecho.',
);
const r7 = fireHook({ transcriptPath: t7, cwd: repoDir7, sessionId: 'selftest-guardrail' });
const boardAfter7 = readBoard();
A(r7.status === 0, 'caso7: hook exit 0', `status=${r7.status} stderr=${r7.stderr}`);
A(
  boardAfter7.cards.find((c) => c.id === 'card-hof').column_id === 'col-todo',
  'caso7 (guardrail): card HoF NO se cierra por azar de vocabulario contra un commit real no relacionado',
  `card=${JSON.stringify(boardAfter7.cards.find((c) => c.id === 'card-hof'))} stdout=${r7.stdout}`,
);

// --- Caso 8 (NEGATIVO, bug 2026-08-13): 'lista' sustantivo NO es marcador ----
// Bucle real de 5 recordatorios: el asistente cerraba turnos con "espero tu
// lista de personalidades" y el token 'lista' matcheaba el marker de
// finalizacion. Un assistant que solo ESPERA algo no ha completado nada.
resetFixture();
writeBoard(baseBoard());
const rawBefore8 = readFileSync(KANBAN_PATH, "utf8");
const t8 = makeTranscript(
  FIXTURE_ROOT,
  "t8",
  "implementa el sistema de personalidades del chat",
  "Quedo a la espera de tu lista de personalidades para arrancar.",
);
const r8 = fireHook({ transcriptPath: t8, cwd: nonGitDir, sessionId: "selftest-lista-noun" });
const rawAfter8 = readFileSync(KANBAN_PATH, "utf8");
A(r8.status === 0, "caso8: hook exit 0", `status=${r8.status} stderr=${r8.stderr}`);
A(
  rawBefore8 === rawAfter8 && r8.stdout === "",
  "caso8 (bug 2026-08-13): 'lista' (sustantivo) NO cuenta como finalizacion -> ni card ni recordatorio",
  `stdout="${r8.stdout}"`,
);

// --- Caso 9 (NEGATIVO, bug 2026-08-13): tool_results NO son mensajes humanos --
// El unico texto con verbo de accion ('add', del help de un CLI) viaja en un
// tool_result; el mensaje humano real es conversacional. Antes del fix, ese
// 'add' mantenia actionable=true y cada Stop re-emitia el recordatorio.
resetFixture();
writeBoard(baseBoard());
const rawBefore9 = readFileSync(KANBAN_PATH, "utf8");
const t9 = join(FIXTURE_ROOT, "t9.jsonl");
writeFileSync(
  t9,
  [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "gracias, seguimos con esto manana" },
    }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: "kanban.mjs - CRUD\n  node scripts/kanban.mjs add <proyecto> \"titulo\"\n  node scripts/kanban.mjs mv <proyecto> <id>",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Listo, completado." }] },
    }),
  ].join("\n"),
  "utf8",
);
const r9 = fireHook({ transcriptPath: t9, cwd: nonGitDir, sessionId: "selftest-toolresult" });
const rawAfter9 = readFileSync(KANBAN_PATH, "utf8");
A(r9.status === 0, "caso9: hook exit 0", `status=${r9.status} stderr=${r9.stderr}`);
A(
  rawBefore9 === rawAfter9 && r9.stdout === "",
  "caso9 (bug 2026-08-13): verbo de accion SOLO en un tool_result -> no actionable, kanban intacto",
  `stdout="${r9.stdout}"`,
);

// ---------------------------------------------------------------------------
rmSync(FIXTURE_ROOT, { recursive: true, force: true });

console.log(fail === 0 ? "\nSELFTEST cat21.1 (kanban-update-reminder): VERDE" : `\nSELFTEST cat21.1 (kanban-update-reminder): ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
