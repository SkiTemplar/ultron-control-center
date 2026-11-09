/**
 * kirkardo-eval.selftest.mjs — selftest HERMETICO del medidor Kirkardo.
 *
 * No lanza el harness ni ningun hook contra la maquina: HOME y USERPROFILE
 * apuntan a un directorio temporal antes de importar nada, y cada predicado se
 * prueba como funcion pura con un caso positivo y uno negativo (fixtures).
 * Cada bloque cita el hallazgo de la auditoria del 2026-10-23 que caeria si el
 * fix se revirtiera.
 *
 *   A) runner: nombre del JSON (scoped no pisa el canonico) y retiradas por decision
 *   B) readHarnessNote (contrato con memory-session-resume.js)
 *   C) vigencia de las decisiones (dense-off, orchestrate-light, dispatcher-off)
 *   D) predicados de los checks (7.1, 7.2, 3.1, 7.5, 8.3, 2.6, 6.1, 6.2, 6.4, 8.1/10.2,
 *      gate, 12.6, 3.4, 15.3, 16.5, 21.3, 7.9, 4.9, 11.6, 11.5, 2.8, 17.5)
 *   E) sandbox de hooks: HOME aislado de verdad (un hijo ve el HOME temporal)
 *   F) importar el harness no ejecuta nada ni escribe en el HOME
 *   G) ronda 3: P1 (no arranco frente a fallo), areas ponderadas, checks nuevos
 *      de Sessions, delegacion, Pupus y hooks, control de la nota y congelado
 *      del registro (kirkardo/selftest-r3.mjs)
 *
 * Uso: node scripts/kirkardo-eval.selftest.mjs   (exit 0 = verde, 1 = rojo)
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// HOME falso ANTES de cualquier import dinamico: el harness y los hooks
// resuelven sus rutas con os.homedir() (USERPROFILE/HOME).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "kirkardo-selftest-home-"));
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;
process.env.ULTRON_MEMORY_BIN = join(FAKE_HOME, "no-existe.exe");
process.env.ULTRON_HUBS_REFRESH = "off";

let failures = 0;
const ok = (name) => console.log(`  [PASS] ${name}`);
const ko = (name, detail) => { failures++; console.log(`  [FAIL] ${name}\n         -> ${detail}`); };
function assert(cond, name, detail = "") { cond ? ok(name) : ko(name, detail); }

const P = await import(pathToFileURL(join(ROOT, "scripts", "kirkardo", "predicates.mjs")).href);
const { makeHookSandbox } = await import(pathToFileURL(join(ROOT, "scripts", "kirkardo", "sandbox.mjs")).href);

// ---------------------------------------------------------------------------
console.log("A) runner: JSON scoped aparte y retiradas por decision");
assert(P.reportFileName(true) === "kirkardo-eval.scoped.json" && P.reportFileName(false) === "kirkardo-eval.json",
  "un run --cat escribe kirkardo-eval.scoped.json, no el canonico", `${P.reportFileName(true)} / ${P.reportFileName(false)}`);
const inForce = () => ({ inForce: true, evidence: "e" });
const outForce = () => ({ inForce: false, evidence: "x" });
assert(P.classifyByDecision({ retiredBy: "d" }, inForce).kind === "retired", "retiredBy + decision en vigor -> retirado");
const back = P.classifyByDecision({ retiredBy: "d" }, outForce);
assert(back.kind === "measure" && /FUERA de vigor/.test(back.note), "retiredBy + decision fuera de vigor -> vuelve a medirse con nota", JSON.stringify(back));
assert(P.classifyByDecision({ onlyWhile: "d" }, outForce).kind === "inactive", "onlyWhile + decision fuera de vigor -> sustituto inactivo");
assert(P.classifyByDecision({ onlyWhile: "d" }, inForce).kind === "measure", "onlyWhile + decision en vigor -> sustituto medido");

// ---------------------------------------------------------------------------
console.log("B) readHarnessNote honesto (fixtures en temporal)");
const require = createRequire(import.meta.url);
const { readHarnessNote } = require(join(ROOT, "hooks", "scripts", "memory-session-resume.js"));
const fx = mkdtempSync(join(tmpdir(), "kirkardo-selftest-fx-"));
const fxScoped = join(fx, "scoped.json");
writeFileSync(fxScoped, JSON.stringify({ scoped: true, overall: 10, overall_core: 0, all_cats_pass: true, laggards: [] }));
assert(readHarnessNote(fxScoped) === "", "scoped -> nota vacia (no propaga el 10)", `devolvio: "${readHarnessNote(fxScoped)}"`);
const fxFull = join(fx, "full.json");
writeFileSync(fxFull, JSON.stringify({
  scoped: false, overall: 7.95, overall_core: 9.51, all_cats_pass: false,
  laggards: [{ cat: 20, nota: 0 }, { cat: 21, nota: 0, unmeasured: true }, { cat: 8, nota: 3.3 }],
}));
const note = readHarnessNote(fxFull);
assert(note.includes("all_cats_pass=FAIL") && note.includes("cat20=0") && note.includes("core 9.51"),
  "run completo con laggards -> FAIL + laggards + core", `nota="${note}"`);
assert(!/:\s*overall \d/.test(note), "no lidera con 'overall N'", `nota="${note}"`);
const fxPass = join(fx, "pass.json");
writeFileSync(fxPass, JSON.stringify({ scoped: false, overall: 9.8, overall_core: 9.9, all_cats_pass: true, laggards: [] }));
assert(readHarnessNote(fxPass).includes("all_cats_pass=PASS"), "run limpio -> PASS", readHarnessNote(fxPass));

// ---------------------------------------------------------------------------
console.log("C) vigencia de decisiones (fixtures)");
const H = await import(pathToFileURL(join(ROOT, "scripts", "kirkardo-eval.mjs")).href);
const OFF = { ULTRON_DENSE: "0", ULTRON_RERANK: "0" };
assert(H.denseOffStatus({ settingsEnv: OFF, userEnv: OFF, processEnv: {}, doctorDense: false }).inForce === true, "denso: config 0 + doctor dense=false -> en vigor");
assert(H.denseOffStatus({ settingsEnv: OFF, userEnv: OFF, processEnv: { ULTRON_DENSE: "1" }, doctorDense: false }).inForce === false, "denso: override del entorno -> fuera de vigor");
assert(H.denseOffStatus({ settingsEnv: {}, userEnv: OFF, processEnv: {}, doctorDense: false }).inForce === false, "denso: settings.env incompleto -> fuera de vigor");
assert(H.denseOffStatus({ settingsEnv: OFF, userEnv: OFF, processEnv: {}, doctorDense: true }).inForce === false, "denso: doctor dense=true -> fuera de vigor");
const LIGHT = { ok: true, full: false, len: 0 };
assert(H.orchestrateLightStatus({ settingsEnv: {}, userEnv: { ULTRON_ORCHESTRATE: null }, processEnv: {}, probe: LIGHT }).inForce === true, "orchestrate: sin full -> ligero en vigor");
assert(H.orchestrateLightStatus({ settingsEnv: { ULTRON_ORCHESTRATE: "full" }, userEnv: {}, processEnv: {}, probe: LIGHT }).inForce === false, "orchestrate: settings.env full -> fuera de vigor");
assert(H.orchestrateLightStatus({ settingsEnv: {}, userEnv: {}, processEnv: {}, probe: { ok: true, full: true, len: 900 } }).inForce === false, "orchestrate: hook con orchestration-context -> fuera de vigor");
const clean = JSON.stringify({ UserPromptSubmit: [{ hooks: [{ command: "node memory-orchestrate.js" }] }] });
const wired = JSON.stringify({ UserPromptSubmit: [{ hooks: [{ command: "node routing-dispatcher.v2.js" }] }] });
assert(H.dispatcherOffStatus({ sources: [{ label: "s", text: clean }, { label: "m", text: "[]" }] }).inForce === true, "dispatcher: ausente -> desconectado");
assert(H.dispatcherOffStatus({ sources: [{ label: "s", text: wired }] }).inForce === false, "dispatcher: cableado -> fuera de vigor");
assert(H.dispatcherOffStatus({ sources: [{ label: "s", text: null }] }).inForce === false, "dispatcher: ilegible -> no se presume");

// ---------------------------------------------------------------------------
console.log("D) predicados de los checks");
// 7.1 (medidor-2): un lint elevado a error no lleva codigo E y no esta al principio de la cola.
const clippyRed = "    |\n    = help: remove `return`\n    = note: `-D clippy::needless-return` implied by `-D warnings`\nerror: could not compile `control-center` (lib) due to 1 previous error\n";
assert(P.clippyVerdict({ code: 101, output: clippyRed }).pass === false, "7.1 clippy rojo (exit 101, 'error:' en la cola) -> fail");
assert(P.clippyVerdict({ code: 0, output: clippyRed }).pass === false, "7.1 linea 'error:' aunque el exit sea 0 -> fail");
assert(P.clippyVerdict({ code: null, output: "" }).pass === false, "7.1 timeout (sin exit) -> fail");
assert(P.clippyVerdict({ code: 0, output: "    Checking x\n    Finished `dev` profile\n" }).pass === true, "7.1 exit 0 sin errores -> pass");
// 7.2
assert(P.tscVerdict({ code: 2, output: "Found 9 errors in 9 files.\n\nErrors  Files\n     1  src/a.ts:3\n" }).pass === false, "7.2 tsc exit 2 con la tabla final (sin 'error TS' en la cola) -> fail");
assert(P.tscVerdict({ code: 0, output: "src/a.ts(1,1): error TS2322: x" }).pass === false, "7.2 'error TS' con exit 0 -> fail");
assert(P.tscVerdict({ code: 0, output: "" }).pass === true, "7.2 exit 0 sin errores -> pass");
// 3.1: el viejo /claude/ casaba con "command not found".
assert(P.cliVersionVerdict({ code: 127, output: "bash: claude: command not found" }).pass === false, "3.1 'claude: command not found' -> fail");
assert(P.cliVersionVerdict({ code: 0, output: "2.1.309 (Claude Code)" }).pass === true, "3.1 version semver con exit 0 -> pass");
// pipefail de verdad (si hay bash): `false | tail -1` debe salir != 0.
const bash = spawnSync("bash", ["-c", P.withPipefail("false | tail -1")], { encoding: "utf8" });
if (bash.error) console.log("  [INFO] sin bash en PATH: se omite la prueba real de pipefail");
else assert(bash.status !== 0, "run(): con pipefail, `false | tail -1` sale != 0", `status=${bash.status}`);
// 7.5
assert(P.cargoTestVerdict({ code: 0, output: "test result: ok. 10 passed; 0 failed; 1 ignored\n" }).pass === true, "7.5 ok con tests -> pass");
assert(P.cargoTestVerdict({ code: 101, output: "test result: FAILED. 9 passed; 1 failed; 0 ignored\n" }).pass === false, "7.5 FAILED -> fail");
assert(P.cargoTestVerdict({ code: 0, output: "" }).pass === false, "7.5 sin ninguna linea 'test result' -> fail (no verde vacuo)");
// 8.3 (medidor-3): el modulo es finance/mod.rs.
const has = (set) => (p) => set.has(p.replace(/\\/g, "/"));
const j = (...a) => a.join("/");
assert(P.financeSourcePresent(has(new Set(["src/finance/mod.rs"])), j, "src") === true, "8.3 finance/mod.rs cuenta como modulo presente");
assert(P.financeSourcePresent(has(new Set(["src/finance.rs"])), j, "src") === true, "8.3 finance.rs tambien");
assert(P.financeSourcePresent(has(new Set()), j, "src") === false, "8.3 sin modulo -> ausente (el check pasa a skip, no a verde)");
// 2.6 (medidor-7, codegraph-4): el numerador solo cuenta sesiones del denominador.
const tl = (...names) => names.map((n) => JSON.stringify({ message: { content: [{ type: "tool_use", name: n, input: { file_path: "a.rs" } }] } }));
assert(P.transcriptToolUsage(tl("Grep", "Read", "Glob", "mcp__codegraph__codegraph_explore")).exploreCalls === 3, "2.6 cuenta Grep/Glob/Read de codigo");
const cg = P.codegraphConsumption([{ exploreCalls: 5, usedCg: true }, { exploreCalls: 4, usedCg: false }, { exploreCalls: 0, usedCg: true }, { exploreCalls: 1, usedCg: true }]);
assert(cg.ratio === 0.5, "2.6 dos sesiones con codegraph que no exploran NO inflan el ratio (1/2, no 3/2)", JSON.stringify(cg));
assert(P.codegraphConsumption([{ exploreCalls: 3, usedCg: true }]).pass === true, "2.6 todas con codegraph -> pass");
assert(P.codegraphConsumption([{ exploreCalls: 1, usedCg: true }]).skip === true, "2.6 sin sesiones de codigo -> skip, no verde");
// 6.1 (medidor-8)
// La ruta del fixture se compone en ejecucion: escrita literal, el propio
// selftest salia como fichero con rutas personales en 6.1.
const DRIVE_PATH = ["D:", "Ultron"];
const files = [{ path: "scripts/x.ps1", content: `${DRIVE_PATH.join("\\")}\\qdrant` }, { path: "README.md", content: DRIVE_PATH.join("/") }, { path: "a.ts", content: "ok" }];
assert(JSON.stringify(P.personalPathHits(files, [/D:[/\\]Ultron/], ["README.md"])) === '["scripts/x.ps1"]', "6.1 detecta .ps1 (antes fuera) y respeta las exenciones");
assert(P.looksBinary(Buffer.from([1, 0, 2])) && !P.looksBinary(Buffer.from("texto")), "6.1 binarios fuera por NUL");
// 6.2 / 6.4
assert(P.auditHighCount("[audit-personal-data] scope=head HIGH=0 MEDIUM=179") === 0 && P.auditHighCount("Traceback ...") === null, "6.2 HIGH= de la linea resumen; sin ella, null (no medible)");
assert(P.buildLocalDocVerdict("**build:local** ... para el binario de escritorio.\n**build:app** = build publico. No usar para el escritorio local.").pass === true, "6.4 build:local+escritorio y build:app desaconsejado -> pass");
assert(P.buildLocalDocVerdict("usa npm run build:local").pass === false, "6.4 solo nombrar build:local ya no basta (antes tautologico)");
// 8.1 / 10.2: un unico parser.
const handlers = 'x\n    tauri::generate_handler![\n        commands::a::uno,\n        // comentario\n        #[cfg(feature = "finance")]\n        finance::dos,\n        commands::b::tres,\n    ]\n';
const ph = P.parseGenerateHandler(handlers);
assert(ph && [...ph.registered].join(",") === "uno,tres" && [...ph.finance].join(",") === "dos", "8.1/10.2 parser comun: registrados y finance", JSON.stringify(ph && [[...ph.registered], [...ph.finance]]));
assert(P.parseGenerateHandler("sin bloque") === null, "8.1/10.2 sin generate_handler -> null (no medible)");
assert(P.isTestPath("src/components/__tests__/X.test.tsx") && !P.isTestPath("src/components/X.tsx"), "10.2 los tests no cuentan como llamante");
assert(P.isCommentLine("  // invoke('x')") && P.isCommentLine(" * invoke('x')") && !P.isCommentLine("await invoke('x')"), "10.1 los comentarios no cuentan como llamada");
// Gate (medidor-11) e icono (medidor-14)
const g = P.gateSummary([{ cat: 1, name: "a", total: 4, pass: 4, nota: 10 }, { cat: 2, name: "b", total: 0, pass: 0, nota: 0 }, { cat: 3, name: "c", total: 5, pass: 4, nota: 8 }], 9.5);
assert(!g.allCatsPass && g.laggards.some((l) => l.cat === 2 && l.unmeasured), "gate: categoria sin checks medidos cuenta como laggard", JSON.stringify(g.laggards));
assert(P.gateSummary([{ cat: 1, name: "a", total: 2, pass: 2, nota: 10 }], 9.5).allCatsPass === true, "gate: todas >= umbral -> pass");
assert(P.reportIcon({ total: 5, nota: 8 }, 9.5) !== "OK" && P.reportIcon({ total: 5, nota: 9.6 }, 9.5) === "OK", "informe: una 8,0 ya no sale [OK]");
// 12.6
const gh = (o) => ({ ok: true, stdout: JSON.stringify([o]), stderr: "" });
assert(P.ciMainVerdict(gh({ conclusion: "success", status: "completed" })).pass === true, "12.6 success -> pass");
assert(P.ciMainVerdict(gh({ conclusion: "failure", status: "completed" })).pass === false, "12.6 failure -> fail");
assert(P.ciMainVerdict({ ok: false, stdout: "", stderr: "gh: command not found" }).skip === true, "12.6 sin gh o sin red -> skip");
assert(P.ciMainVerdict(gh({ conclusion: "", status: "in_progress" })).skip === true, "12.6 run en curso -> skip");
// 3.4 / 15.3 / 16.5: ventanas moviles (K7).
const NOW = Date.parse("2026-10-23T12:00:00Z");
assert(P.anyDateWithin(["2026-10-20"], NOW, 7) && !P.anyDateWithin(["2026-10-01"], NOW, 7), "3.4 frescura por ventana de 7 dias, no 'hoy'");
const rd = (ts, extra = {}) => JSON.stringify({ ts, zone: "chat", model: "m", provider_id: "groq", used_fallback: false, ...extra });
assert(P.routeDecisionsVerdict([rd("2026-10-22T10:00:00Z")], NOW, 7).pass === true, "15.3 decision completa reciente -> pass");
assert(P.routeDecisionsVerdict([rd("2026-09-01T10:00:00Z")], NOW, 7).pass === false, "15.3 sin decisiones en la ventana -> fail");
assert(P.routeDecisionsVerdict([rd("2026-10-22T10:00:00Z", { zone: undefined })], NOW, 7).pass === false, "15.3 decision sin zona -> fail");
const tok = (ts, v) => ({ ts, hook: "memory-orchestrate", est_tokens: v });
const burst = [tok("2026-10-22T10:00:00.000Z", 0), tok("2026-10-22T10:00:00.100Z", 0), tok("2026-10-22T10:00:00.200Z", 0)];
const real = [tok("2026-10-21T09:00:00Z", 800), tok("2026-10-21T11:00:00Z", 900)];
assert(JSON.stringify(P.realTrafficSamples([...real, ...burst], "memory-orchestrate", { nowMs: NOW, days: 14, burstMs: 500 })) === "[800,900]",
  "16.5 las rafagas del harness (< 500 ms) no cuentan como trafico real");
assert(P.realTrafficSamples([tok("2026-09-01T09:00:00Z", 5)], "memory-orchestrate", { nowMs: NOW, days: 14, burstMs: 500 }).length === 0, "16.5 fuera de la ventana -> no cuenta");
// 21.3 (medidor-9, memoria-7): control positivo.
const E = (title) => ({ title, summary: "" });
assert(P.ttlProbeVerdict([E("Tvigente")], { controlTitle: "Tvigente", expiredTitle: "Tcaducado" }).pass === true, "21.3 control si, caducado no -> pass");
assert(P.ttlProbeVerdict([E("Tvigente"), E("Tcaducado")], { controlTitle: "Tvigente", expiredTitle: "Tcaducado" }).pass === false, "21.3 sale el caducado -> fail");
assert(P.ttlProbeVerdict([], { controlTitle: "Tvigente", expiredTitle: "Tcaducado" }).pass === false, "21.3 recall vacio -> no medible (antes verde)");
// 7.9 / 9.1 (medidor-1): solo los hooks del manifest.
const man = { hooks: [{ event: "SessionStart", script: "~/.ultron/hooks/scripts/a.js" }, { event: "Stop", script: "~/.ultron/hooks/scripts/a.js" }, { event: "Stop", script: "~/.ultron/hooks/scripts/b.js" }] };
const ms = P.manifestHookScripts(man, "C:/H");
assert(ms.length === 2 && ms[0].script === "C:/H/.ultron/hooks/scripts/a.js" && ms[0].event === "SessionStart", "7.9 scripts unicos del manifest con su evento", JSON.stringify(ms));
assert(P.manifestHookScripts({}, "C:/H").length === 0, "9.1 manifest sin hooks -> 0 (el check lo da por no medible)");
// 4.9 (skills-agentes-6)
const fm = P.agentFrontmatter("---\nname: x\nmodel: claude-opus-5-5\nmaxTurns: 100\n---\nbody");
assert(fm.model === "claude-opus-5-5" && fm.maxTurns === "100", "4.9 lee model y maxTurns del frontmatter");
const ENV55 = { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5-5", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5-5" };
assert(P.agentModelVerdict([{ name: "a", model: "claude-opus-5-5", maxTurns: "1" }, { name: "b", model: "haiku", maxTurns: "1" }], ENV55).pass === true, "4.9 familia 5.5 y alias fijados -> pass");
assert(P.agentModelVerdict([{ name: "a", disabled: true, model: "claude-sonnet-5", maxTurns: "1" }], ENV55).pass === false, "4.9 un .disabled con modelo viejo -> fail");
assert(P.agentModelVerdict([{ name: "a", model: "claude-opus-5-5", maxTurns: "1" }], { ...ENV55, ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-5-5" }).pass === false, "4.9 alias haiku -> sonnet -> fail");
assert(P.agentModelVerdict([{ name: "a", model: "claude-opus-5-5", maxTurns: null }], ENV55).pass === false, "4.9 sin maxTurns -> fail");
// 11.6 (seguridad-4)
assert(JSON.stringify(P.mcpSecretHits({ gh: { env: { TOKEN: "ghp_" + "A".repeat(30) } }, ok: { command: "node" } })) === '["gh"]', "11.6 token en claro en env -> detectado");
assert(P.mcpSecretHits({ ok: { command: "npx", args: ["-y", "@x/server"] } }).length === 0, "11.6 config sin tokens -> 0");
// 11.5 (seguridad-4): la persistencia se sigue por la cadena de llamadas.
const rs = "pub fn delete_mcp_inner(n: String) -> R { servers.remove(&n); helper(&n) }\nfn helper(n: &str) -> R { store.mutate(n) }\nfn mutate(&self) -> R { write_atomic(b) }\nfn write_atomic(b: &str) -> R { fs::rename(a, b) }\n";
const path = P.persistencePath(P.rustFnBodies(rs), "delete_mcp_inner");
assert(path && path.join(">") === "delete_mcp_inner>helper>mutate>write_atomic", "11.5 cadena hasta fs::rename", JSON.stringify(path));
const rsNo = "pub fn delete_mcp_inner(n: String) -> R { servers.remove(&n); Ok(()) }\nfn other() { let s = serde_json::to_string(&x); }\n";
assert(P.persistencePath(P.rustFnBodies(rsNo), "delete_mcp_inner") === null, "11.5 un to_string suelto en el fichero ya no basta");
// 2.8 (codegraph-5)
assert(P.projectIndexVerdict([{ id: "a", codeFiles: 5, indexedFiles: 10 }, { id: "b", codeFiles: 0, indexedFiles: null }]).pass === true, "2.8 proyectos con codigo indexados -> pass");
assert(P.projectIndexVerdict([{ id: "a", codeFiles: 5, indexedFiles: 0 }]).pass === false, "2.8 indice con 0 ficheros -> fail");
assert(P.projectIndexVerdict([{ id: "b", codeFiles: 0, indexedFiles: null }]).skip === true, "2.8 sin proyectos con codigo -> skip");
// 17.5 (hooks-2): arch_delta no cuenta.
assert(P.compactContent({ decisions: [], next: [], bugs: [], arch_delta: ["abc"], machine: { facts_extracted: 0 } }).pass === false, "17.5 solo arch_delta (git log) -> sin contenido");
assert(P.compactContent({ decisions: ["d"], arch_delta: [] }).pass === true && P.compactContent({ machine: { facts_extracted: 2 } }).pass === true, "17.5 decisions o facts -> contenido");

// 12.6 ronda 2: el run tiene que ser de HEAD o posterior.
const HEAD = { sha: "abc1234def", timeMs: Date.parse("2026-10-23T10:00:00Z") };
assert(P.ciMainVerdict(gh({ conclusion: "success", status: "completed", headSha: "abc1234def999", createdAt: "2026-10-22T09:00:00Z" }), HEAD).pass === true, "12.6 success del mismo commit -> pass");
assert(P.ciMainVerdict(gh({ conclusion: "success", status: "completed", headSha: "0000000", createdAt: "2026-10-23T11:00:00Z" }), HEAD).pass === true, "12.6 success de un run posterior a HEAD -> pass");
assert(P.ciMainVerdict(gh({ conclusion: "success", status: "completed", headSha: "0000000", createdAt: "2026-10-20T11:00:00Z" }), HEAD).pass === false, "12.6 success de un commit anterior a HEAD -> fail (CI no ha visto HEAD)");
// 7.9 / 9.1 ronda 2: un worktree mide sus hooks.
const msRepo = P.manifestHookScripts(man, "C:/H", "D:\\wt");
assert(msRepo[0].script === "D:/wt/hooks/scripts/a.js", "7.9 con repo, ~/.ultron/ se resuelve en el repo medido", JSON.stringify(msRepo));

// ---------------------------------------------------------------------------
console.log("D2) predicados de la ronda 2 (predicates-r2.mjs)");
const R2 = await import(pathToFileURL(join(ROOT, "scripts", "kirkardo", "predicates-r2.mjs")).href);
// cargo test con filtro (1.11-1.13, 3.5-3.7, 13.2, 14.7, 14.8, 14.10)
const ct = (out, code = 0, extra = {}) => R2.cargoFilterVerdict({ code, output: out, ...extra }, { minPassed: 2 });
assert(ct("test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out").pass === true, "cargo filtro: 3 passed >= 2 -> pass");
assert(ct("test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 2376 filtered out").pass === false, "cargo filtro: el filtro no casa nada (0 passed, exit 0) -> fail, no verde vacuo");
assert(ct("test result: FAILED. 2 passed; 1 failed; 0 ignored", 101).pass === false, "cargo filtro: un test rojo -> fail");
assert(ct("error[E0425]: cannot find value `x`\nerror: could not compile `control-center` (lib test)", 101).manual === true, "cargo filtro: no compila -> manual con causa, nunca verde");
assert(ct("", 0, { toolchain: false }).manual === true && ct("", 0, { finance: false }).manual === true, "cargo filtro: sin toolchain o sin finance -> manual");
// 2026-11-01: el timeout pasa de manual a rojo. Un test colgado es un fallo del
// producto; la prueba antigua fijaba justo el hueco que encontro la auditoria.
assert(ct("", null).pass === false && !ct("", null).manual, "cargo filtro: timeout o test colgado -> rojo, no manual");
// 3.4 recent_outcomes
const outc = (fb, failed, prim) => ({ recent_outcomes: [...Array(fb).fill("fallback"), ...Array(failed).fill("failed"), ...Array(prim).fill("primary")] });
assert(R2.routerRecentVerdict(outc(0, 0, 20)).pass === true, "3.4 todo primary -> pass");
assert(R2.routerRecentVerdict(outc(1, 2, 17)).pass === false, "3.4 fallback+failed = 15% -> fail (los fallos totales cuentan)");
assert(R2.routerRecentVerdict({ recent_routes: [false, false] }).pass === false && /recent_outcomes/.test(R2.routerRecentVerdict({ recent_routes: [] }).detail), "3.4 solo la ventana vieja -> no medible");
assert(R2.routerRecentVerdict(outc(0, 0, 5)).pass === false, "3.4 menos de 10 rutas -> no medible");
// 13.1 / 10.6 / 14.8 referencias de codigo
assert(R2.codeRefLines("// optimize_prompt(x)\nlet p = build_prompt_plan(a, b); // optimize_prompt\n", /optimize_prompt/).length === 0, "13.1 un alias solo en comentarios no cuenta");
assert(R2.codeRefLines("let g = needs_guardrail(a).then(Guard::start);", /\bGuard::start\b/).length === 1 && R2.codeRefLines("Guard::start_at(r)", /\bGuard::start\b/).length === 0, "14.8 Guard::start cuenta, Guard::start_at (tests) no");
// 10.4 agentes que delega el codigo
const wf = 'steps: vec![ WorkflowStep { agent: "debugger".to_string(), note: None }, WorkflowStep { agent: "qa-expert".to_string(), note: None } ]';
assert(JSON.stringify(R2.workflowAgents(wf)) === '["debugger","qa-expert"]', "10.4 extrae los agentes de los WorkflowStep");
const rk = 'pub(super) fn preferred_specialists(intent: &str) -> &\'static [&\'static str] {\n match intent {\n "a" => &["debugger", "docker-expert"],\n "b" => &[],\n _ => &[] } }';
assert(JSON.stringify(R2.specialistAgents(rk)) === '["debugger","docker-expert"]' && R2.specialistAgents("fn other() {}") === null, "10.4 extrae preferred_specialists; sin la fn -> null");
const ag = { active: new Set(["debugger"]), disabled: new Set(["docker-expert", "qa-expert"]), plugin: new Set() };
assert(R2.agentRefsVerdict({ workflow: ["debugger"], specialists: ["debugger", "docker-expert"] }, ag).pass === true, "10.4 workflow activo y especialista desactivado -> pass");
assert(R2.agentRefsVerdict({ workflow: ["qa-expert"], specialists: [] }, ag).pass === false, "10.4 un paso de workflow desactivado -> fail (delegate_task no lo lanza)");
assert(R2.agentRefsVerdict({ workflow: [], specialists: ["ultron-perf"] }, ag).pass === false, "10.4 especialista inexistente -> fail");
assert(R2.agentRefsVerdict({ workflow: [], specialists: [] }, ag).pass === false, "10.4 0 nombres -> no medible (antes skip por vacuidad)");
// 4.10 referencias fantasma
const sr = R2.skillRefs("Usa `pr-review-toolkit:code-reviewer` y Agent(subagent_type: \"ultron-arch\").\n`ecc:model-route` requiere el plugin ecc, deshabilitado.\n`node:sqlite` y `w:id`\n");
assert(JSON.stringify(sr) === '{"agents":["ultron-arch"],"namespaced":["pr-review-toolkit:code-reviewer"]}', "4.10 extrae refs; ignora lineas que declaran ausencia y prefijos que no son plugins", JSON.stringify(sr));
const res = { activeAgents: new Set(["debugger"]), pluginItem: (ns, n) => ns === "pr-review-toolkit" && n === "code-reviewer" };
assert(R2.skillRefsVerdict([{ file: "s/SKILL.md", agents: ["general-purpose", "debugger"], namespaced: ["pr-review-toolkit:code-reviewer"] }], res).pass === true, "4.10 builtin, agente activo y plugin habilitado -> pass");
assert(R2.skillRefsVerdict([{ file: "s/SKILL.md", ...sr }], res).pass === false, "4.10 subagent_type inexistente -> fail");
assert(R2.skillRefsVerdict([{ file: "s/SKILL.md", agents: [], namespaced: ["design:ux-copy"] }], res).pass === false, "4.10 skill de un plugin no habilitado -> fail");
// 7.11 comandos sincronos con E/S
const cmds = "#[tauri::command]\npub fn a() -> R { let o = Command::new(\"git\").output(); }\n#[tauri::command]\npub async fn b() { Command::new(\"x\"); }\n#[tauri::command]\npub fn c() -> u32 { 1 }\n";
assert(JSON.stringify(R2.syncIoCommands(cmds)) === '["a"]', "7.11 solo el comando sincrono con Command::new", JSON.stringify(R2.syncIoCommands(cmds)));
assert(R2.syncIoCommands("#[tauri::command]\npub async fn b() { reqwest::get(u); }").length === 0, "7.11 async con E/S -> no cuenta");
assert(R2.swallowedWrites("let _ = fs::write(p, b);\nfs::write(p, b)?;\n// let _ = std::fs::write(p, b);") === 1, "7.11 cuenta let _ = fs::write fuera de comentarios");
// 12.7 / 12.8 / 14.11 / 18.5 resumenes de suites
assert(R2.suiteSummaryVerdict({ code: 0, output: "\n19/19 suites en verde." }, { noun: "suites", minTotal: 19 }).pass === true, "12.8 19/19 -> pass");
assert(R2.suiteSummaryVerdict({ code: 1, output: "\n18/19 suites en verde; fallan 1." }, { noun: "suites", minTotal: 19 }).pass === false, "12.8 una suite roja -> fail");
assert(R2.suiteSummaryVerdict({ code: 0, output: "\n12/12 suites en verde." }, { noun: "suites", minTotal: 19 }).pass === false, "12.8 menos suites que el minimo -> fail");
assert(R2.suiteSummaryVerdict({ code: 0, output: "" }, { noun: "selftests" }).pass === false, "12.7 sin resumen -> fail");
assert(R2.vitestVerdict({ code: 0, output: " Test Files  2 passed (2)\n      Tests  15 passed (15)\n" }).pass === true, "14.11 vitest verde -> pass");
assert(R2.vitestVerdict({ code: 1, output: "      Tests  1 failed | 14 passed (15)\n" }).pass === false, "14.11 un test rojo -> fail");
assert(R2.vitestVerdict({ code: 0, output: "\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m7 passed\x1b[39m\x1b[22m\x1b[90m (7)\x1b[39m\n" }).pass === true, "14.11 con colores ANSI tambien se lee el resumen");
assert(R2.nodeTestVerdict({ code: 0, output: "ℹ tests 11\nℹ pass 11\nℹ fail 0\n" }, { minPass: 11 }).pass === true, "18.5 node --test 11 pass -> pass");
assert(R2.nodeTestVerdict({ code: 1, output: "ℹ pass 10\nℹ fail 1\n" }, { minPass: 11 }).pass === false, "18.5 un caso rojo -> fail");
// 14.9 freno
assert(R2.brakeVerdict([{ command: "curl 127.1", expectRisky: true, risky: true }, { command: "git status", expectRisky: false, risky: false }]).pass === true, "14.9 sondas bien clasificadas -> pass");
assert(R2.brakeVerdict([{ command: 'c"ur"l 127.0.0.1', expectRisky: true, risky: false }, { command: "git status", expectRisky: false, risky: false }]).pass === false, "14.9 el ofuscado pasa el freno -> fail");
assert(R2.brakeVerdict([{ command: "curl 127.1", expectRisky: true, risky: true }]).pass === false, "14.9 sin sonda de control -> fail (un freno que lo para todo tambien 'acierta')");
// 2.10 / 2.11 / 2.9 CodeGraph
assert(R2.indexPendingVerdict({ code: 0, output: "\n0 de 37 proyectos necesitan indexado.\n" }).pass === true, "2.10 0 pendientes -> pass");
assert(R2.indexPendingVerdict({ code: 0, output: "\n3 de 37 proyectos necesitan indexado.\n" }).pass === false, "2.10 pendientes -> fail");
const agTools = [{ name: "debugger", tools: "Read, mcp__codegraph__codegraph_explore" }, { name: "doc-summarizer", tools: "Read, Write" }, { name: "x", tools: null }];
assert(R2.agentsCodegraphVerdict(agTools, ["doc-summarizer", "game-designer"]).pass === true, "2.11 sin codegraph solo los permitidos; sin tools: hereda -> pass");
assert(R2.agentsCodegraphVerdict([...agTools, { name: "rust-engineer", tools: "Read, Edit" }], ["doc-summarizer"]).pass === false, "2.11 un implementador sin codegraph -> fail");
const reg = new Set(["codegraph_files", "codegraph_search"]);
assert(R2.commandsWiredVerdict(["codegraph_files"], reg, () => 1).pass === true, "2.9 registrado y con invoke -> pass");
assert(R2.commandsWiredVerdict(["codegraph_files", "codegraph_neighborhood"], reg, () => 1).pass === false, "2.9 sin registrar -> fail");
assert(R2.commandsWiredVerdict(["codegraph_files"], reg, () => 0).pass === false, "2.9 sin invoke real -> fail");
// 1.14 resume sin autorizaciones de sesion
const ps = (items) => `<project-state>\nDecisiones vigentes:\n${items.map((i) => `  - ${i}`).join("\n")}\n</project-state>`;
assert(R2.resumeSessionScopedVerdict(ps(["Medidor con HOME aislado"])).pass === true, "1.14 decision de diseno -> pass");
assert(R2.resumeSessionScopedVerdict(ps(["Usuario autorizó continuar a full ultracode"])).pass === false, "1.14 autorizacion de sesion -> fail");
assert(R2.resumeSessionScopedVerdict("sin bloque").pass === false, "1.14 sin <project-state> -> no medible");
// 7.10 sello dirty
assert(R2.versionDirtyVerdict('{"version":"0.1","git_sha":"abc","dirty":false}').pass === true, "7.10 dirty=false -> pass");
assert(R2.versionDirtyVerdict('{"version":"0.1","git_sha":"abc","dirty":true}').pass === false, "7.10 dirty=true -> fail");
assert(R2.versionDirtyVerdict('{"version":"0.1","git_sha":"abc"}').pass === false, "7.10 binario sin el campo dirty -> fail (anterior al sello)");
// 5.5 retencion / 18.6 tarea vieja
const rc = R2.retentionCounts(["projects.json.bak", "projects.json.bak-1", "projects.json.tmp", "kanban.json.bak"], ["backup-2026-10-18.log", "backup-2026-10-18.robocopy.log", "backup-2026-08-23.log.gz", "hook-timing.jsonl"]);
assert(rc.bak === 2 && rc.backup === 2 && rc.robocopy === 1, "5.5 cuenta solo copias de projects.json y logs de backup fechados", JSON.stringify(rc));
assert(R2.retentionVerdict({ bak: 10, backup: 8, robocopy: 8 }).pass === true && R2.retentionVerdict({ bak: 36, backup: 2, robocopy: 2 }).pass === false, "5.5 36 copias -> fail; en el tope -> pass");
assert(R2.staleBackupTaskVerdict({ codeRefs: 0, taskRegistered: false }).pass === true, "18.6 sin referencias ni tarea -> pass");
assert(R2.staleBackupTaskVerdict({ codeRefs: 0, taskRegistered: true }).pass === false && R2.staleBackupTaskVerdict({ codeRefs: 1, taskRegistered: false }).pass === false, "18.6 tarea registrada o referencia de codigo -> fail");
assert(R2.staleBackupTaskVerdict({ codeRefs: 0, taskRegistered: null }).skip === true, "18.6 sin schtasks -> skip");

// ---------------------------------------------------------------------------
console.log("E) sandbox de hooks: HOME aislado");
const fakeUltron = mkdtempSync(join(tmpdir(), "kirkardo-selftest-ultron-"));
mkdirSync(join(fakeUltron, "cockpit", "projects", "p"), { recursive: true });
writeFileSync(join(fakeUltron, "cockpit", "projects.json"), "{}");
writeFileSync(join(fakeUltron, "cockpit", "projects", "p", "estado.json"), '{"pendientes":[]}');
mkdirSync(join(fakeUltron, "run"), { recursive: true });
writeFileSync(join(fakeUltron, "run", "orchestrate.json"), '{"port":1,"token":"t"}');
const sb = makeHookSandbox({ ultronRoot: fakeUltron, project: "p", baseEnv: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
const sbFull = makeHookSandbox({ ultronRoot: fakeUltron, project: "p", baseEnv: {}, withDaemonLock: true });
try {
  assert(existsSync(join(sb.ultron, "cockpit", "projects", "p", "estado.json")) && sb.copied.includes("cockpit/projects.json"), "copia las entradas de solo lectura", JSON.stringify(sb.copied));
  assert(!existsSync(join(sb.ultron, "run", "orchestrate.json")), "por defecto NO copia el lockfile del daemon (lleva su token)");
  assert(existsSync(join(sbFull.ultron, "run", "orchestrate.json")), "con withDaemonLock (modo completo) si lo copia");
  const env = sb.env();
  assert(env.USERPROFILE === sb.root && env.HOME === sb.root && env.ULTRON_ROOT === sb.ultron, "USERPROFILE/HOME/ULTRON_ROOT apuntan al sandbox");
  assert(!existsSync(env.ULTRON_MEMORY_BIN) && env.ULTRON_HUBS_REFRESH === "off", "sin realBin, el sidecar no existe (ni gc ni capture) y los hubs no se refrescan");
  assert(sb.env({ realBin: "C:/bin/x.exe" }).ULTRON_MEMORY_BIN === "C:/bin/x.exe", "con realBin, el hook ve el sidecar pedido");
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(require('os').homedir())"], { encoding: "utf8", env });
  assert(child.stdout === sb.root, "un hijo con sb.env() resuelve os.homedir() al sandbox", `homedir=${child.stdout}`);
  writeFileSync(join(sb.logs, "hook-errors.jsonl"), '{"a":1}\n{"b":2}\n');
  assert(sb.countLines("hook-errors.jsonl") === 2, "cuenta lineas del log del sandbox (9.3)");
} finally {
  sb.cleanup();
  sbFull.cleanup();
  rmSync(fakeUltron, { recursive: true, force: true });
}
assert(!existsSync(sb.root), "cleanup borra el sandbox");

// ---------------------------------------------------------------------------
// G) ronda 3 (2026-10-28): infraestructura frente a fallo, areas ponderadas y
// el caso negativo de cada check nuevo (scripts/kirkardo/selftest-r3.mjs).
const { runR3Selftest } = await import(pathToFileURL(join(ROOT, "scripts", "kirkardo", "selftest-r3.mjs")).href);
await runR3Selftest({ assert, ROOT });

// ---------------------------------------------------------------------------
console.log("F) importar el harness no ejecuta checks ni escribe en el HOME");
const homeEntries = readdirSync(FAKE_HOME).filter((n) => n !== "no-existe.exe");
assert(homeEntries.length === 0, "el HOME falso sigue vacio tras importar kirkardo-eval.mjs", homeEntries.join(","));

rmSync(fx, { recursive: true, force: true });
rmSync(FAKE_HOME, { recursive: true, force: true });
console.log(failures === 0 ? "\nSELFTEST kirkardo-eval: VERDE" : `\nSELFTEST kirkardo-eval: ROJO (${failures} fallo/s)`);
process.exit(failures === 0 ? 0 : 1);
