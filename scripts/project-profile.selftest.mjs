/**
 * project-profile.selftest.mjs — check conductual del hook SessionEnd
 * `project-profile` (ULTRON 4 F1.4 / G9).
 *
 * Hermetico: repo git temporal con CLAUDE.md + package.json, cockpit temporal
 * (PROJECT_PROFILE_DIR con kanban.json, PROJECT_PROFILE_REGISTRY), daemon
 * simulado por fichero (PROJECT_PROFILE_FAKE_RESPONSE) y peticion capturada
 * (PROJECT_PROFILE_REQUEST_OUT). No toca ni daemon ni cockpit real.
 *
 * Casos:
 *   A) fuentes + perfil valido del daemon -> profile.json (source=llm, head del
 *      repo, campos normalizados); la peticion lleva CLAUDE.md, kanban y git y
 *      NO lleva el secreto (redaccion antes de salir).
 *   B) mismo HEAD, perfil reciente -> 'perfil fresco', 0 peticiones.
 *   C) FORCE + daemon sin perfil -> el anterior se conserva intacto.
 *   D) sin perfil previo + daemon caido -> perfil determinista desde CLAUDE.md
 *      y package.json.
 *   E) HEAD nuevo con perfil determinista -> se pide y se sube a llm.
 *   F) opt-out PROJECT_PROFILE_DISABLED=1 -> ni log.
 *   G) daemon caido + PROJECT_PROFILE_RELAUNCH_FAKE con relaunched=true ->
 *      perfil llm desde la respuesta del reintento simulado, log con
 *      relaunched=true y relaunch_wait_ms numerico.
 *   H) daemon caido + PROJECT_PROFILE_RELAUNCH_FAKE con relaunched=false ->
 *      se conserva el perfil anterior, log con relaunched=false.
 *
 * Uso: node scripts/project-profile.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..");
const HOOK = join(ULTRON, "hooks", "scripts", "project-profile.js");
const TMPDIR = join(ULTRON, "logs", "_selftest-project-profile");
const REPO = join(TMPDIR, "repo");
const COCKPIT = join(TMPDIR, "projects");
const REGISTRY = join(TMPDIR, "projects.json");
const LOG = join(TMPDIR, "log.jsonl");
const REQ = join(TMPDIR, "request.jsonl");
const FAKE = join(TMPDIR, "fake-response.json");
const RELAUNCH = join(TMPDIR, "relaunch-fake.json");
const PROJECT = "demo";
const PROFILE = join(COCKPIT, PROJECT, "profile.json");
const SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

rmSync(TMPDIR, { recursive: true, force: true });
mkdirSync(join(COCKPIT, PROJECT), { recursive: true });
mkdirSync(REPO, { recursive: true });

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

function git(args) {
  const r = spawnSync("git", ["-C", REPO, "-c", "user.name=selftest", "-c", "user.email=selftest@example.invalid", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function reset() {
  for (const f of [LOG, REQ]) rmSync(f, { force: true });
}
function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function readProfile() {
  return existsSync(PROFILE) ? JSON.parse(readFileSync(PROFILE, "utf8")) : null;
}
function fire(extraEnv = {}) {
  const env = {
    ...process.env,
    PROJECT_PROFILE_LOG: LOG,
    PROJECT_PROFILE_DIR: COCKPIT,
    PROJECT_PROFILE_REGISTRY: REGISTRY,
    PROJECT_PROFILE_PROJECT: PROJECT,
    PROJECT_PROFILE_REQUEST_OUT: REQ,
    PROJECT_PROFILE_FAKE_RESPONSE: FAKE,
    ...extraEnv,
  };
  const payload = { cwd: REPO, session_id: "sess-1", hook_event_name: "SessionEnd" };
  const r = spawnSync("node", [HOOK], { input: JSON.stringify(payload), env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`hook exit ${r.status}: ${r.stderr}`);
}

// ---------- fixture: repo + cockpit ----------
writeFileSync(
  join(REPO, "CLAUDE.md"),
  `# CLAUDE.md — Demo\n\nAplicación de escritorio que monta álbumes de fotos automáticamente a partir de un lote de imágenes. Tauri con núcleo en Rust y sidecar Python.\n\n## Notas\n\ntoken ${SECRET} no debería salir\n`,
  "utf8",
);
// README con primer parrafo META (habla del documento, no del proyecto): el
// perfil determinista debe saltarlo y quedarse con el parrafo real de CLAUDE.md.
writeFileSync(join(REPO, "README.md"), "# Demo\n\nInstrucciones de uso del repositorio de demo: léelas antes de tocar nada del árbol.\n", "utf8");
writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "demo-app", description: "Demo de perfil", dependencies: { react: "19", "@tauri-apps/api": "2" } }), "utf8");
git(["init", "-q"]);
git(["add", "."]);
git(["commit", "-q", "-m", "feat: primer commit del demo"]);
const HEAD1 = git(["rev-parse", "--short", "HEAD"]);
writeFileSync(
  join(COCKPIT, PROJECT, "kanban.json"),
  JSON.stringify({
    columns: [{ id: "c1", role: "todo" }, { id: "c2", role: "doing" }, { id: "c4", role: "done" }],
    cards: [
      { title: "Exportar PDF", column_id: "c1" },
      { title: "Zoom de grupos", column_id: "c2" },
      { title: "Selector de fondo", column_id: "c4" },
    ],
  }),
  "utf8",
);
writeFileSync(REGISTRY, JSON.stringify({ projects: [{ id: PROJECT, name: "Demo", path: REPO, tags: ["fotos", "tauri"] }] }), "utf8");

const PERFIL_OK = {
  profile: {
    que_es: "  Generador automático de álbumes de fotos de escritorio. ",
    stack: "Tauri, Rust, React 19, Python",
    arquitectura: "Núcleo Rust + sidecar Python de visión",
    estado: "Zoom de grupos en curso",
    decisiones_clave: ["Umbral CLIP 0.88", "  ", "Sidecar Python en vez de ONNX en Rust"],
  },
  memory_chars: 321,
};

// ---------- A: fuentes + perfil valido ----------
console.log("A — fuentes + perfil valido del daemon");
reset();
writeFileSync(FAKE, JSON.stringify(PERFIL_OK), "utf8");
fire();
{
  const reqs = readJsonl(REQ);
  A(reqs.length === 1 && reqs[0].cmd === "profile_distill" && reqs[0].project === PROJECT, "una peticion profile_distill con el proyecto", JSON.stringify(reqs).slice(0, 200));
  const prompt = reqs[0] ? reqs[0].prompt : "";
  A(prompt.includes("CLAUDE.md (cabecera)") && prompt.includes("monta álbumes"), "la peticion lleva la cabecera de CLAUDE.md", prompt.slice(0, 200));
  A(prompt.includes("package.json: name=demo-app") && prompt.includes("react"), "la peticion lleva el manifiesto con deps", prompt.slice(0, 300));
  A(prompt.includes("In Progress: Zoom de grupos") && prompt.includes("Done: 1"), "la peticion lleva el kanban", prompt);
  A(prompt.includes(`@ ${HEAD1}`) && prompt.includes("primer commit del demo"), "la peticion lleva rama, HEAD y commits", prompt);
  A(prompt.includes("tags: fotos, tauri"), "la peticion lleva el registro del Control Center", prompt);
  A(!prompt.includes(SECRET), "el secreto NO sale de la maquina", "secreto presente en la peticion");
  const p = readProfile();
  A(p && p.source === "llm" && p.project === PROJECT, "profile.json escrito con source=llm", JSON.stringify(p));
  A(p && p.head && p.head.sha === HEAD1, "el perfil lleva el HEAD del repo", JSON.stringify(p && p.head));
  A(p && p.profile.que_es === "Generador automático de álbumes de fotos de escritorio.", "campos normalizados (trim)", p && p.profile.que_es);
  A(p && p.profile.decisiones_clave.length === 2, "decisiones vacias fuera", JSON.stringify(p && p.profile.decisiones_clave));
  const log = readJsonl(LOG);
  A(log.length === 1 && log[0].written === "llm" && log[0].memory_chars === 321, "log: written=llm", JSON.stringify(log));
}

// ---------- B: perfil fresco ----------
console.log("B — mismo HEAD y perfil reciente");
reset();
fire();
{
  A(readJsonl(REQ).length === 0, "0 peticiones al daemon", "hubo peticion");
  const log = readJsonl(LOG);
  A(log.length === 1 && log[0].skipped === "perfil fresco", "log: perfil fresco", JSON.stringify(log));
}

// ---------- C: FORCE + daemon sin perfil ----------
console.log("C — FORCE con daemon sin perfil: se conserva el anterior");
reset();
const antes = readFileSync(PROFILE, "utf8");
writeFileSync(FAKE, JSON.stringify({ profile: null, skipped: "sin proveedor" }), "utf8");
fire({ PROJECT_PROFILE_FORCE: "1" });
{
  A(readJsonl(REQ).length === 1, "con FORCE si se pide", "no hubo peticion");
  A(readFileSync(PROFILE, "utf8") === antes, "profile.json intacto", "el fichero cambio");
  const log = readJsonl(LOG);
  A(log[0] && log[0].written === "conservado" && String(log[0].daemon).includes("sin proveedor"), "log: conservado + motivo", JSON.stringify(log));
}

// ---------- D: sin perfil previo + daemon caido ----------
console.log("D — sin perfil previo y daemon caido: determinista");
reset();
rmSync(PROFILE, { force: true });
rmSync(FAKE, { force: true }); // respuesta simulada ausente => null (daemon caido)
fire();
{
  const p = readProfile();
  A(p && p.source === "deterministic", "profile.json determinista", JSON.stringify(p));
  A(p && p.profile.que_es.startsWith("Aplicación de escritorio que monta álbumes"), "que_es = primer parrafo de CLAUDE.md", p && p.profile.que_es);
  A(p && p.profile.stack.includes("package.json: name=demo-app"), "stack desde el manifiesto", p && p.profile.stack);
  A(p && p.profile.estado.includes("In Progress: Zoom de grupos"), "estado desde el kanban", p && p.profile.estado);
  A(p && !JSON.stringify(p).includes(SECRET), "el determinista tampoco lleva el secreto", "secreto en profile.json");
  const log = readJsonl(LOG);
  A(log[0] && log[0].written === "deterministic" && log[0].daemon === "no responde", "log: deterministic + daemon no responde", JSON.stringify(log));
}

// ---------- E: HEAD nuevo con perfil determinista ----------
console.log("E — HEAD nuevo: el determinista no es fresco, se sube a llm");
reset();
writeFileSync(join(REPO, "NOTAS.md"), "cambio\n", "utf8");
git(["add", "."]);
git(["commit", "-q", "-m", "docs: notas"]);
const HEAD2 = git(["rev-parse", "--short", "HEAD"]);
writeFileSync(FAKE, JSON.stringify(PERFIL_OK), "utf8");
fire();
{
  A(readJsonl(REQ).length === 1, "se pide perfil", "no hubo peticion");
  const p = readProfile();
  A(p && p.source === "llm" && p.head.sha === HEAD2 && HEAD2 !== HEAD1, "perfil llm con el HEAD nuevo", JSON.stringify(p && { s: p.source, h: p.head }));
}

// ---------- F: opt-out ----------
console.log("F — opt-out");
reset();
fire({ PROJECT_PROFILE_DISABLED: "1" });
A(!existsSync(LOG) && !existsSync(REQ), "ni log ni peticion", "hubo actividad");

// ---------- G: daemon caido + relanzamiento simulado con exito ----------
// La peticion inicial no responde (FAKE ausente); PROJECT_PROFILE_RELAUNCH_FAKE
// saca al hook del "modo test" que salta el relanzamiento y sustituye por
// completo el spawn+sondeo+reintento reales -> hermetico, sin tocar el daemon.
console.log("G — daemon caido, relanzamiento simulado -> perfil desde el reintento");
reset();
writeFileSync(join(REPO, "NOTAS2.md"), "otro cambio\n", "utf8");
git(["add", "."]);
git(["commit", "-q", "-m", "docs: mas notas"]);
const HEAD3 = git(["rev-parse", "--short", "HEAD"]);
rmSync(FAKE, { force: true });
writeFileSync(RELAUNCH, JSON.stringify({ relaunched: true, retry_response: PERFIL_OK }), "utf8");
fire({ PROJECT_PROFILE_RELAUNCH_FAKE: RELAUNCH });
{
  const p = readProfile();
  A(p && p.source === "llm" && p.head.sha === HEAD3, "perfil llm escrito tras el relanzamiento simulado", JSON.stringify(p && { s: p.source, h: p.head }));
  const log = readJsonl(LOG);
  A(log[0] && log[0].relaunched === true, "log: relanzamiento registrado (relaunched=true)", JSON.stringify(log[0]));
  A(log[0] && typeof log[0].relaunch_wait_ms === "number", "log: relaunch_wait_ms numerico", JSON.stringify(log[0]));
}
rmSync(RELAUNCH, { force: true });

// ---------- H: daemon caido + relanzamiento simulado sin exito ----------
console.log("H — relanzamiento simulado fallido -> se conserva el perfil anterior");
reset();
rmSync(FAKE, { force: true });
writeFileSync(RELAUNCH, JSON.stringify({ relaunched: false }), "utf8");
// FORCE: el perfil de G quedo fresco (mismo HEAD, recien generado) y el gate
// de frescura ni llegaria a preguntar al daemon.
fire({ PROJECT_PROFILE_RELAUNCH_FAKE: RELAUNCH, PROJECT_PROFILE_FORCE: "1" });
{
  const log = readJsonl(LOG);
  A(log[0] && log[0].relaunched === false, "log: relanzamiento fallido registrado", JSON.stringify(log[0]));
  A(log[0] && log[0].written === "conservado", "perfil anterior conservado tras fallo de relanzamiento", JSON.stringify(log[0]));
}
rmSync(RELAUNCH, { force: true });

rmSync(TMPDIR, { recursive: true, force: true });
console.log(fail === 0 ? "\nproject-profile selftest: VERDE" : `\nproject-profile selftest: ${fail} FALLO(S)`);
process.exit(fail === 0 ? 0 : 1);
