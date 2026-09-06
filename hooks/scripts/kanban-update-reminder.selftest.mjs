/**
 * kanban-update-reminder.selftest.mjs — check conductual del Stop hook de
 * cierre de kanban (cat21.1).
 *
 * Contrato bajo prueba (v3.0, ULTRON 4 F4.4, 2026-09-04): el hook solo actua
 * cuando el turno tiene EVIDENCIA DE TRABAJO (un tool_use Edit/Write/
 * MultiEdit/NotebookEdit sobre un fichero del cwd de la sesion, o un
 * `git commit` lanzado por Bash). Con esa evidencia:
 *   - cierra (mueve a role=done) las cards vivas cuyo titulo matchea un
 *     commit reciente (evidencia dura) y lo anuncia como BOARD ACTUALIZADO;
 *   - si no cierra nada pero hay tarjetas In Progress (role=doing), emite UN
 *     recordatorio que las nombra, con un cooldown por sesion;
 *   - sin tarjeta In Progress, silencio.
 * Sin evidencia de trabajo en el turno: silencio absoluto, diga lo que diga el
 * asistente. Las heuristicas de verbo de accion + marcador de "hecho" (v1/v2)
 * se retiraron: producian 47 recordatorios en 29 sesiones con 0 cierres
 * reales (audit 2026-09-04).
 *
 * Aislamiento: KANBAN_REMINDER_BASE_OVERRIDE + KANBAN_REMINDER_SESSION_STATE_OVERRIDE
 * + KANBAN_REMINDER_PROJECTS_OVERRIDE para NUNCA tocar cockpit/projects/ del
 * usuario. Todo vive en un fixture temporal bajo logs/_selftest-kanban-reminder/.
 * El cooldown se desactiva (KANBAN_REMINDER_COOLDOWN_MIN=0) salvo en el caso
 * que lo prueba.
 *
 * Uso: node hooks/scripts/kanban-update-reminder.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync, execFileSync } from "node:child_process";
import {
  readFileSync, writeFileSync, existsSync, rmSync, mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..", "..");
const HOOK = join(__dirname, "kanban-update-reminder.js");

const FIXTURE_ROOT = join(ULTRON, "logs", "_selftest-kanban-reminder");
const KANBAN_BASE = join(FIXTURE_ROOT, "projects");
const PROJECT = "selftest-proj";
const KANBAN_PATH = join(KANBAN_BASE, PROJECT, "kanban.json");
const SESSION_STATE = join(FIXTURE_ROOT, "current-session.json");
const SESSION_IDS = [];

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

function resetFixture() {
  if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  mkdirSync(KANBAN_BASE, { recursive: true });
  writeFileSync(SESSION_STATE, JSON.stringify({ active_project: PROJECT }), "utf8");
}

function card(id, columnId, title) {
  return {
    id,
    column_id: columnId,
    title,
    description: "",
    agent: null,
    prompt_template: null,
    cwd: null,
    tags: [],
    order: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    runs: [],
  };
}

const TODO_TITLE = "Implementar validacion de emails en el formulario de registro";
const DOING_TITLE = "Pantalla de ajustes con tema oscuro";

function baseBoard({ withDoing = false } = {}) {
  const cards = [card("card-live-1", "col-todo", TODO_TITLE)];
  if (withDoing) cards.push(card("card-doing-1", "col-doing", DOING_TITLE));
  return {
    project_id: PROJECT,
    columns: [
      { id: "col-todo", name: "Backlog", order: 0, role: "todo" },
      { id: "col-doing", name: "In Progress", order: 1, role: "doing" },
      { id: "col-done", name: "Done", order: 2, role: "done" },
    ],
    cards,
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

function cardById(board, id) {
  return board.cards.find((c) => c.id === id);
}

// Transcript minimo con la forma real de Claude Code: mensaje humano, N
// tool_use del asistente (uno por mensaje) y texto final del asistente.
function makeTranscript(name, { user, assistant, tools = [] }) {
  const p = join(FIXTURE_ROOT, `${name}.jsonl`);
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: user } }),
  ];
  for (const t of tools) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2, 8)}`, name: t.name, input: t.input }],
        },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      }),
    );
  }
  if (assistant !== null && assistant !== undefined) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: assistant }] },
      }),
    );
  }
  writeFileSync(p, lines.join("\n"), "utf8");
  return p;
}

const editIn = (dir, file = "src/app.ts") => ({
  name: "Edit",
  input: { file_path: join(dir, file), old_string: "a", new_string: "b" },
});

function fireHook({ transcriptPath, cwd, sessionId, projectsRegistry, sessionState, cooldownMin = 0 }) {
  SESSION_IDS.push(sessionId);
  const payload = { transcript_path: transcriptPath.replace(/\\/g, "/"), hook_event_name: "Stop", session_id: sessionId };
  if (cwd !== undefined) payload.cwd = cwd.replace(/\\/g, "/");
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      KANBAN_REMINDER_BASE_OVERRIDE: KANBAN_BASE,
      KANBAN_REMINDER_SESSION_STATE_OVERRIDE: sessionState || SESSION_STATE,
      KANBAN_REMINDER_PROJECTS_OVERRIDE:
        projectsRegistry || join(FIXTURE_ROOT, "projects-registry-ausente.json"),
      KANBAN_REMINDER_COOLDOWN_MIN: String(cooldownMin),
    },
  });
  return { stdout: (r.stdout || "").trim(), status: r.status, stderr: r.stderr || "" };
}

function gitInit(dir, subjects) {
  mkdirSync(dir, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "selftest@ultron.local"]);
  git(["config", "user.name", "kirkardo-selftest"]);
  for (const s of subjects) git(["commit", "--allow-empty", "-q", "-m", s]);
}

function rawBoard() {
  return readFileSync(KANBAN_PATH, "utf8");
}

// ---------------------------------------------------------------------------
resetFixture();

// --- Caso 1: cierre real de card viva por match de commit (con Edit) --------
writeBoard(baseBoard());
const repoDir1 = join(FIXTURE_ROOT, "repo-with-commit");
gitInit(repoDir1, ["feat(auth): implementar validacion de emails en el formulario de registro"]);
const t1 = makeTranscript("t1", {
  user: "arregla el bug de validacion en el registro",
  tools: [editIn(repoDir1)],
  assistant: "Validacion — Reparada.",
});
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
  "caso1: additionalContext reporta cierre real",
  r1.stdout,
);
A(board1.cards.length === 1, "caso1: NO se creo ninguna card nueva", `cards=${board1.cards.length}`);

// --- Caso 2: sin commit que matchee, con Edit y tarjeta In Progress ---------
resetFixture();
writeBoard(baseBoard({ withDoing: true }));
const nonGitDir = join(FIXTURE_ROOT, "no-git-cwd");
mkdirSync(nonGitDir, { recursive: true });
const t2 = makeTranscript("t2", {
  user: "implementa el sistema de notificaciones push para el movil",
  tools: [editIn(nonGitDir)],
  assistant: "Notificaciones — Implementadas.",
});
const rawBefore2 = rawBoard();
const r2 = fireHook({ transcriptPath: t2, cwd: nonGitDir, sessionId: "selftest-no-evidence" });
const rawAfter2 = rawBoard();
A(r2.status === 0, "caso2: hook exit 0", `status=${r2.status} stderr=${r2.stderr}`);
A(rawBefore2 === rawAfter2, "caso2: sin commit que matchee -> kanban INTACTO (no inventa cards)", `antes=${rawBefore2.length}b despues=${rawAfter2.length}b`);
A(
  /KANBAN/.test(r2.stdout) && r2.stdout.includes(DOING_TITLE) && r2.stdout.includes("card-doing-1") && !/BOARD ACTUALIZADO/.test(r2.stdout),
  "caso2: recordatorio nombra la tarjeta In Progress (titulo + id), sin cierre",
  r2.stdout,
);
A(!r2.stdout.includes(TODO_TITLE), "caso2: el recordatorio NO lista las tarjetas de Backlog", r2.stdout);

// --- Caso 3 (NEGATIVO): turno sin Edit/Write ni commit -> silencio ---------
resetFixture();
writeBoard(baseBoard({ withDoing: true }));
const rawBefore3 = rawBoard();
const t3 = makeTranscript("t3", {
  user: "implementa el sistema de notificaciones push para el movil",
  assistant: "Listo, completado. La tarea quedo hecha y aplicada.",
});
const r3 = fireHook({ transcriptPath: t3, cwd: nonGitDir, sessionId: "selftest-sin-trabajo" });
A(r3.status === 0, "caso3: hook exit 0 (nunca bloquea)", `status=${r3.status} stderr=${r3.stderr}`);
A(rawBefore3 === rawBoard(), "caso3: sin trabajo en el turno -> kanban BYTE-IDENTICO", "diff detectado");
A(r3.stdout === "", "caso3: sin Edit/Write ni commit -> silencio aunque el asistente diga 'completado'", `stdout="${r3.stdout}"`);

// --- Caso 4: cierre por FASE compartida + marcador de cierre en el commit --
resetFixture();
const board4 = baseBoard();
board4.cards.push(card("card-fase-4", "col-doing", "Fase 4 — Hardening + tests del modulo"));
writeBoard(board4);
const repoDir4 = join(FIXTURE_ROOT, "repo-fase-completa");
gitInit(repoDir4, ["docs: Fase 4.2 hecha - Fase 4 completa; queda solo el gate de playtest"]);
const t4 = makeTranscript("t4", {
  user: "actualiza el plan: la fase 4 esta terminada",
  tools: [editIn(repoDir4, "docs/plan.md")],
  assistant: "Plan — Actualizado.",
});
const r4 = fireHook({ transcriptPath: t4, cwd: repoDir4, sessionId: "selftest-fase" });
A(r4.status === 0, "caso4: hook exit 0", `status=${r4.status} stderr=${r4.stderr}`);
A(
  doneTitles(readBoard()).some((t) => t.startsWith("Fase 4 —")),
  "caso4: card 'Fase 4' cerrada por fase compartida + marcador de cierre",
  `done=${JSON.stringify(doneTitles(readBoard()))} stdout=${r4.stdout}`,
);

// --- Caso 5 (NEGATIVO): commit de fase SIN marcador de cierre NO cierra ----
resetFixture();
const board5 = baseBoard();
board5.cards.push(card("card-fase-4b", "col-doing", "Fase 4 — Hardening + tests del modulo"));
writeBoard(board5);
const repoDir5 = join(FIXTURE_ROOT, "repo-fase-intermedia");
gitInit(repoDir5, ["test(chunks): Fase 4 avanza con decisiones puras y pools"]);
const t5 = makeTranscript("t5", {
  user: "avanza con la fase 4",
  tools: [editIn(repoDir5)],
  assistant: "Paso — Completado.",
});
const r5 = fireHook({ transcriptPath: t5, cwd: repoDir5, sessionId: "selftest-fase-neg" });
A(r5.status === 0, "caso5: hook exit 0", `status=${r5.status} stderr=${r5.stderr}`);
A(
  cardById(readBoard(), "card-fase-4b").column_id === "col-doing",
  "caso5: commit intermedio de fase (sin marcador de cierre) NO cierra la card",
  `card=${JSON.stringify(cardById(readBoard(), "card-fase-4b"))}`,
);
A(
  /KANBAN/.test(r5.stdout) && r5.stdout.includes("Fase 4 —"),
  "caso5: con tarjeta In Progress viva, el recordatorio la nombra",
  r5.stdout,
);

// --- Caso 6: COBERTURA multi-commit ----------------------------------------
resetFixture();
const board6 = baseBoard();
board6.cards = [card("card-deuda", "col-todo", "Deuda: trocear career.ts y events.ts")];
writeBoard(board6);
const repoDir6 = join(FIXTURE_ROOT, "repo-deuda-troceo");
gitInit(repoDir6, [
  "refactor: trocea career.ts por fases del juego",
  "refactor: trocea events.ts en src/data/base/ por temas",
]);
const t6 = makeTranscript("t6", {
  user: "refactoriza career.ts y events.ts en archivos mas pequenos",
  tools: [editIn(repoDir6, "src/career.ts"), editIn(repoDir6, "src/events.ts")],
  assistant: "Troceo — Hecho.",
});
const r6 = fireHook({ transcriptPath: t6, cwd: repoDir6, sessionId: "selftest-coverage" });
A(r6.status === 0, "caso6: hook exit 0", `status=${r6.status} stderr=${r6.stderr}`);
A(
  cardById(readBoard(), "card-deuda").column_id === "col-done",
  "caso6: card 'Deuda: trocear career.ts y events.ts' cerrada por COBERTURA multi-commit",
  `card=${JSON.stringify(cardById(readBoard(), "card-deuda"))} stdout=${r6.stdout}`,
);

// --- Caso 7 (guardrail): sin solape real, la cobertura NO cierra ------------
resetFixture();
const board7 = baseBoard();
board7.cards = [card("card-hof", "col-todo", "Revisar generosidad del Salón de la Fama en modo Estrella")];
writeBoard(board7);
const repoDir7 = join(FIXTURE_ROOT, "repo-hof-guardrail");
gitInit(repoDir7, ["fix: remata la auditoría del 2026-08-01 y rebalancea los trade-offs de las escenas"]);
const t7 = makeTranscript("t7", {
  user: "corrige la auditoria de escenas y rebalancea los trade-offs",
  tools: [editIn(repoDir7)],
  assistant: "Auditoria — Rematada.",
});
const r7 = fireHook({ transcriptPath: t7, cwd: repoDir7, sessionId: "selftest-guardrail" });
A(r7.status === 0, "caso7: hook exit 0", `status=${r7.status} stderr=${r7.stderr}`);
A(
  cardById(readBoard(), "card-hof").column_id === "col-todo",
  "caso7 (guardrail): card HoF NO se cierra por azar de vocabulario",
  `card=${JSON.stringify(cardById(readBoard(), "card-hof"))} stdout=${r7.stdout}`,
);

// --- Caso 8 (NEGATIVO): Edit sin tarjeta In Progress y sin commit -> silencio
resetFixture();
writeBoard(baseBoard());
const rawBefore8 = rawBoard();
const t8 = makeTranscript("t8", {
  user: "implementa el sistema de personalidades del chat",
  tools: [editIn(nonGitDir)],
  assistant: "Personalidades — Implementadas.",
});
const r8 = fireHook({ transcriptPath: t8, cwd: nonGitDir, sessionId: "selftest-sin-doing" });
A(r8.status === 0, "caso8: hook exit 0", `status=${r8.status} stderr=${r8.stderr}`);
A(
  rawBefore8 === rawBoard() && r8.stdout === "",
  "caso8: con Edit pero sin tarjeta In Progress -> ni recordatorio ni escritura",
  `stdout="${r8.stdout}"`,
);

// --- Caso 9 (NEGATIVO): Edit FUERA del cwd (p. ej. memoria) no es trabajo --
resetFixture();
writeBoard(baseBoard({ withDoing: true }));
const rawBefore9 = rawBoard();
const fueraDir = join(FIXTURE_ROOT, "otro-sitio");
mkdirSync(fueraDir, { recursive: true });
const t9 = makeTranscript("t9", {
  user: "guarda la memoria de la sesion",
  tools: [{ name: "Write", input: { file_path: join(fueraDir, "memory", "nota.md"), content: "x" } }],
  assistant: "Memoria — Guardada.",
});
const r9 = fireHook({ transcriptPath: t9, cwd: nonGitDir, sessionId: "selftest-fuera-cwd" });
A(r9.status === 0, "caso9: hook exit 0", `status=${r9.status} stderr=${r9.stderr}`);
A(
  rawBefore9 === rawBoard() && r9.stdout === "",
  "caso9: Write fuera del cwd de la sesion NO cuenta como trabajo -> silencio",
  `stdout="${r9.stdout}"`,
);

// --- Caso 10: el tablero sale de projects.json, no del basename -------------
resetFixture();
writeBoard(baseBoard({ withDoing: true }));
const registryPath = join(FIXTURE_ROOT, "projects-registrados.json");
writeFileSync(registryPath, JSON.stringify({ projects: [{ id: PROJECT, path: nonGitDir }] }), "utf8");
const t10 = makeTranscript("t10", {
  user: "arregla el sitemap",
  tools: [editIn(nonGitDir, "sitemap.xml")],
  assistant: "Sitemap — Arreglado.",
});
const sessionStateAusente = join(FIXTURE_ROOT, "current-session-ausente.json");
const r10 = fireHook({
  transcriptPath: t10,
  cwd: nonGitDir,
  sessionId: "selftest-registry",
  projectsRegistry: registryPath,
  sessionState: sessionStateAusente,
});
A(r10.status === 0, "caso10: hook exit 0", `status=${r10.status} stderr=${r10.stderr}`);
A(
  r10.stdout.includes(`KANBAN ${PROJECT}`) && !r10.stdout.includes("no-git-cwd"),
  "caso10: el tablero sale de projects.json, no del nombre de la carpeta",
  `stdout="${r10.stdout}"`,
);

// --- Caso 11 (NEGATIVO): sin registro ni tablero para el basename -> silencio
// Antes se apuntaba a `cockpit/projects/<basename>/kanban.json` aunque no
// existiera y se mandaba a "sincronizar" un tablero inexistente.
const t11 = makeTranscript("t11", {
  user: "arregla el sitemap",
  tools: [editIn(nonGitDir, "sitemap.xml")],
  assistant: "Sitemap — Arreglado.",
});
const r11 = fireHook({
  transcriptPath: t11,
  cwd: nonGitDir,
  sessionId: "selftest-sin-registro",
  sessionState: sessionStateAusente,
});
A(
  r11.status === 0 && r11.stdout === "",
  "caso11: cwd sin registro y sin tablero propio -> silencio (no cae al tablero 'ultron')",
  `stdout="${r11.stdout}"`,
);

// --- Caso 12: `git commit` por Bash en el turno es evidencia de trabajo -----
resetFixture();
writeBoard(baseBoard());
const repoDir12 = join(FIXTURE_ROOT, "repo-commit-por-bash");
gitInit(repoDir12, ["feat(auth): implementar validacion de emails en el formulario de registro"]);
const t12 = makeTranscript("t12", {
  user: "commitea lo de la validacion",
  tools: [{ name: "Bash", input: { command: 'git commit -m "feat(auth): implementar validacion de emails en el formulario de registro"' } }],
  assistant: "Commit — Hecho.",
});
const r12 = fireHook({ transcriptPath: t12, cwd: repoDir12, sessionId: "selftest-commit-bash" });
A(r12.status === 0, "caso12: hook exit 0", `status=${r12.status} stderr=${r12.stderr}`);
A(
  cardById(readBoard(), "card-live-1").column_id === "col-done" && /BOARD ACTUALIZADO/.test(r12.stdout),
  "caso12: un `git commit` por Bash (sin Edit) basta para cerrar la card por match",
  `card=${JSON.stringify(cardById(readBoard(), "card-live-1"))} stdout=${r12.stdout}`,
);

// --- Caso 13: cooldown por sesion (el recordatorio no se repite cada turno) --
resetFixture();
writeBoard(baseBoard({ withDoing: true }));
const t13 = makeTranscript("t13", {
  user: "sigue con la pantalla de ajustes",
  tools: [editIn(nonGitDir, "src/settings.tsx")],
  assistant: "Ajustes — Avanzados.",
});
const sid13 = `selftest-cooldown-${Date.now()}`;
const r13a = fireHook({ transcriptPath: t13, cwd: nonGitDir, sessionId: sid13, cooldownMin: 30 });
const r13b = fireHook({ transcriptPath: t13, cwd: nonGitDir, sessionId: sid13, cooldownMin: 30 });
A(/KANBAN/.test(r13a.stdout), "caso13: primer turno con trabajo -> recordatorio", `stdout="${r13a.stdout}"`);
A(r13b.stdout === "", "caso13: segundo turno dentro del cooldown -> silencio", `stdout="${r13b.stdout}"`);

// --- Caso 14 (NEGATIVO): payload sin cwd ni seleccion explicita -> silencio -
resetFixture();
writeBoard(baseBoard({ withDoing: true }));
const t14 = makeTranscript("t14", {
  user: "toca algo",
  tools: [editIn(nonGitDir)],
  assistant: "Algo — Tocado.",
});
const r14 = fireHook({ transcriptPath: t14, sessionId: "selftest-sin-cwd", sessionState: sessionStateAusente });
A(
  r14.status === 0 && r14.stdout === "",
  "caso14: sin cwd ni tablero seleccionado -> silencio (nunca el tablero por defecto)",
  `stdout="${r14.stdout}"`,
);

// --- Caso 15 (NEGATIVO): card reabierta tras auto-cierre NO se vuelve a cerrar
// por el MISMO commit. Visto en vivo el 2026-09-06: el hook cerro la tarjeta
// del corte por valor, el usuario la devolvio a In Progress y el siguiente
// Stop la volvio a cerrar con el mismo commit (bucle hasta que el commit
// saliera de la ventana de 18 h).
resetFixture();
writeBoard(baseBoard());
const repoDir15 = join(FIXTURE_ROOT, "repo-reabierta");
gitInit(repoDir15, ["feat(auth): implementar validacion de emails en el formulario de registro"]);
const t15 = makeTranscript("t15", {
  user: "commitea lo de la validacion",
  tools: [{ name: "Bash", input: { command: 'git commit -m "feat(auth): implementar validacion de emails"' } }],
  assistant: "Commit — Hecho.",
});
const r15a = fireHook({ transcriptPath: t15, cwd: repoDir15, sessionId: "selftest-reabierta-a" });
A(
  r15a.status === 0 && cardById(readBoard(), "card-live-1").column_id === "col-done",
  "caso15: primer Stop cierra la card por match (precondicion)",
  `stdout=${r15a.stdout} card=${JSON.stringify(cardById(readBoard(), "card-live-1"))}`,
);
// El usuario la reabre (como hace kanban.mjs mv: solo cambia column_id).
const board15 = readBoard();
board15.cards = board15.cards.map((c) => (c.id === "card-live-1" ? { ...c, column_id: "col-doing" } : c));
writeBoard(board15);
const raw15 = rawBoard();
const r15b = fireHook({ transcriptPath: t15, cwd: repoDir15, sessionId: "selftest-reabierta-b" });
A(
  r15b.status === 0 && cardById(readBoard(), "card-live-1").column_id === "col-doing",
  "caso15: card reabierta a mano NO se vuelve a cerrar por el mismo commit",
  `card=${JSON.stringify(cardById(readBoard(), "card-live-1"))} stdout=${r15b.stdout}`,
);
A(raw15 === rawBoard(), "caso15: kanban BYTE-IDENTICO tras la reapertura", "diff detectado");
A(!/BOARD ACTUALIZADO/.test(r15b.stdout), "caso15: sin anuncio de cierre repetido", `stdout="${r15b.stdout}"`);

// --- Caso 16 (NEGATIVO): el ultimo turno es de SISTEMA (system-reminder) y
// el commit ocurrio en el turno humano ANTERIOR (que ya tuvo su Stop). El
// commit no debe reprocesarse: silencio y tablero intacto.
resetFixture();
writeBoard(baseBoard());
const repoDir16 = join(FIXTURE_ROOT, "repo-turno-sistema");
gitInit(repoDir16, ["feat(auth): implementar validacion de emails en el formulario de registro"]);
const t16 = join(FIXTURE_ROOT, "t16.jsonl");
writeFileSync(t16, [
  JSON.stringify({ type: "user", message: { role: "user", content: "commitea lo de la validacion" } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_t16a", name: "Bash", input: { command: 'git commit -m "feat(auth): implementar validacion de emails"' } }] } }),
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Commit — Hecho." }] } }),
  JSON.stringify({ type: "user", message: { role: "user", content: "<system-reminder>\nStop hook additional context: BOARD ACTUALIZADO: 1 card(s) cerradas.\n</system-reminder>" } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Anotado." }] } }),
].join("\n"), "utf8");
const raw16 = rawBoard();
const r16 = fireHook({ transcriptPath: t16, cwd: repoDir16, sessionId: "selftest-turno-sistema" });
A(
  r16.status === 0 && r16.stdout === "" && raw16 === rawBoard(),
  "caso16: turno de sistema tras el commit -> silencio y kanban intacto (no reprocesa el turno anterior)",
  `stdout="${r16.stdout}" card=${JSON.stringify(cardById(readBoard(), "card-live-1"))}`,
);

// ---------------------------------------------------------------------------
rmSync(FIXTURE_ROOT, { recursive: true, force: true });
for (const sid of SESSION_IDS) {
  const marker = join(tmpdir(), `ultron-kanban-reminder-${sid}.json`);
  if (existsSync(marker)) rmSync(marker, { force: true });
}

console.log(fail === 0 ? "\nSELFTEST cat21.1 (kanban-update-reminder): VERDE" : `\nSELFTEST cat21.1 (kanban-update-reminder): ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
