// kirkardo/selftest-r3.mjs — bloque G del selftest del medidor (ronda 3,
// 2026-10-28). Lo invoca scripts/kirkardo-eval.selftest.mjs con su assert; no
// es un *.selftest.mjs propio. Cada check nuevo tiene aqui su caso negativo:
// el predicado falla cuando la feature se rompe.

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function runR3Selftest({ assert, ROOT }) {
  const imp = (rel) => import(pathToFileURL(join(ROOT, "scripts", "kirkardo", rel)).href);
  const R3 = await imp("predicates-r3.mjs");
  const R2 = await imp("predicates-r2.mjs");
  const A = await imp("areas.mjs");
  const core = await imp("core.mjs");
  const D = await imp("decisions.mjs");

  console.log("G) ronda 3: infraestructura, areas y checks nuevos");
  // P1 · run() distingue "no arranco" de "fallo"
  assert(R3.spawnInfraCause({ status: 3221225794 })?.includes("0xC0000142"), "P1 0xC0000142 sin signo -> infraestructura");
  assert(R3.spawnInfraCause({ status: -1073741502 })?.includes("0xC0000142"), "P1 0xC0000142 con signo -> infraestructura");
  // Sustituye a "sin codigo de salida -> infraestructura" (2026-11-01): ese caso es
  // un proceso que arranco y murio, y la auditoria demostro que asi una sonda
  // colgada dejaba el gate en PASS.
  assert(R3.spawnInfraCause({ status: null, signal: "SIGTERM" }) === null, "P1 sin codigo de salida: el proceso arranco -> no es infraestructura");
  assert(R3.spawnInfraCause({ status: null, error: { code: "ETIMEDOUT" } }) === null, "P1 timeout: el proceso arranco -> no es infraestructura (caso negativo)");
  assert(R3.spawnInfraCause({ status: 3221225477 }) === null && R3.spawnInfraCause({ status: -1073741819 }) === null, "P1 crash 0xC0000005 -> no es infraestructura (caso negativo)");
  assert(R3.spawnInfraCause({ status: null, error: { code: "ENOENT" } })?.includes("ENOENT"), "P1 spawn fallido -> infraestructura");
  assert(R3.spawnInfraCause({ status: null, error: { code: "ENOBUFS" } }) === null, "P1 salida sobre el tope: el proceso corria -> no es infraestructura");
  assert(/timeout/.test(R3.spawnProductFault({ status: null, error: { code: "ETIMEDOUT" } })) && /0xC0000005/.test(R3.spawnProductFault({ status: 3221225477 })) && R3.spawnProductFault({ status: 1 }) === null && R3.spawnProductFault({ status: 3221225794 }) === null,
    "P1 fallo del producto: timeout y crash se nombran; exit propio y no-arranque, no");
  assert(R3.spawnInfraCause({ status: 1 }) === null, "P1 exit 1 es un fallo del check, no infraestructura");
  assert(R3.isRetryableInfra({ status: 3221225794 }) && !R3.isRetryableInfra({ status: null, error: { code: "ETIMEDOUT" } }), "P1 se reintenta el 0xC0000142, no el timeout");
  const infraFail = R3.applyInfra({ pass: false, detail: "x" }, ["git: 0xC0000142"]);
  assert(infraFail.manual === true && infraFail.pass === undefined, "P1 rojo con proceso que no arranco -> manual con causa, nunca verde", JSON.stringify(infraFail));
  assert(R3.applyInfra({ pass: false, detail: "x" }, []).pass === false, "P1 rojo sin infraestructura sigue rojo (caso negativo)");
  assert(R3.applyInfra({ pass: true }, ["c"]).pass === true, "P1 un verde con un proceso auxiliar caido se respeta");
  const hung = R3.applyInfra({ pass: false, detail: "x" }, [], ["hook: timeout"]);
  assert(hung.pass === false && !hung.manual && /timeout/.test(hung.detail), "P1 rojo con un proceso colgado sigue rojo y lo dice en el detalle", JSON.stringify(hung));
  assert(R3.nextInfraLog(["a: 0xC0000142"], "b", null).length === 0, "P1 la causa debe venir del ultimo proceso: otro que arranca despues la vacia");
  assert(R3.nextInfraLog(["a: x"], "b", "y").length === 2 && R3.nextInfraLog([], "b", "y")[0] === "b: y", "P1 otro que tampoco arranca se acumula");
  const cuelgue = core.spawnTracked(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { encoding: "utf8", timeout: 800 }, "colgado");
  const cuelgueLog = core.takeInfraLog();
  const cuelgueFaults = core.takeFaultLog();
  const cuelgueVerdict = R3.applyInfra({ pass: false, detail: "sonda" }, cuelgueLog, cuelgueFaults);
  assert(cuelgue.infra === null && cuelgueLog.length === 0 && cuelgueVerdict.pass === false && !cuelgueVerdict.manual, "P1 proceso real colgado: rojo, no manual", JSON.stringify(cuelgueVerdict));
  // Solo en Windows: en otros sistemas el exit se trunca a 8 bits y no hay NTSTATUS.
  if (process.platform === "win32") {
    const crash = core.spawnTracked(process.execPath, ["-e", "process.exit(3221225477)"], { encoding: "utf8", timeout: 20000 }, "crash");
    assert(crash.infra === null && core.takeInfraLog().length === 0 && core.takeFaultLog().some((f) => f.includes("0xC0000005")), "P1 proceso real con 0xC0000005: rojo, no manual", JSON.stringify(crash.status));
  }
  // La simulacion de la auditoria: una sonda colgada no deja el gate en PASS.
  const areaOk = (n) => Array(n).fill({ area: "h", status: "pass" });
  const conSondaColgada = R3.areaSummary([...areaOk(13), { area: "h", status: cuelgueVerdict.manual ? "manual" : "fail" }], [{ id: "h", name: "H", weight: 12 }]);
  assert(conSondaColgada.overall < 10 && conSondaColgada.gate.length === 1, "P1 una sonda colgada baja la nota y deja el area laggard", JSON.stringify(conSondaColgada.gate));
  const cargoColgado = R2.cargoFilterVerdict({ code: null, output: "" });
  assert(cargoColgado.pass === false && !cargoColgado.manual, "P1 cargo test colgado -> rojo, no manual");
  core.beginInfraLog();
  const okSpawn = core.spawnTracked(process.execPath, ["-e", "process.exit(3)"], { encoding: "utf8", timeout: 20000 }, "node exit 3");
  const badSpawn = core.spawnTracked(join(ROOT, "no-existe-kirkardo.exe"), [], { encoding: "utf8", timeout: 5000 }, "fantasma");
  const log = core.takeInfraLog();
  assert(okSpawn.status === 3 && okSpawn.infra === null, "spawnTracked: un exit propio no es infraestructura", JSON.stringify(okSpawn.infra));
  assert(badSpawn.infra && log.length === 1 && log[0].startsWith("fantasma"), "spawnTracked: un binario que no arranca queda anotado", JSON.stringify(log));

  // P3 · areas ponderadas
  const mk = (area, pass, fail) => [...Array(pass).fill({ area, status: "pass" }), ...Array(fail).fill({ area, status: "fail" })];
  const AREAS = [{ id: "s", name: "S", weight: 25 }, { id: "m", name: "M", weight: 20 }, { id: "h", name: "H", weight: 0 }];
  const base = [...mk("s", 7, 0), ...mk("m", 10, 0), ...mk("h", 5, 0)];
  const green = R3.areaSummary(base, AREAS);
  assert(green.overall === 10 && green.gate.length === 0, "areas: todo verde -> 10 y gate limpio", JSON.stringify(green.gate));
  const sessFail = R3.areaSummary([...mk("s", 6, 1), ...mk("m", 10, 0), ...mk("h", 5, 0)], AREAS);
  assert(sessFail.gate.some((g) => g.area === "s") && sessFail.overall < green.overall, "areas: un rojo en Sessions la deja laggard y baja la nota (caso negativo)", JSON.stringify(sessFail));
  const hygFail = R3.areaSummary([...mk("s", 7, 0), ...mk("m", 10, 0), ...mk("h", 4, 1)], AREAS);
  assert(hygFail.overall === 10 && hygFail.gate.length === 0 && hygFail.informative.length === 1, "areas: un rojo de higiene (bootstrap.ps1) no mueve la nota ni gatea; sale como informativo");
  const thin = R3.areaSummary([...mk("s", 4, 0), ...mk("m", 10, 0)], AREAS, { minChecks: 5 });
  assert(thin.gate.some((g) => g.area === "s" && g.unmeasured) && thin.overall < 10, "areas: < 5 checks medidos -> sin medir, laggard y 0 en la media");
  assert(A.areaOf({ id: "14.8" }, 14) === "pupus" && A.areaOf({ id: "23.1" }, 23) === "sessions" && A.areaOf({ id: "x", area: "hooks" }, 22) === "hooks",
    "areas: excepciones por check y campo area");
  assert(A.AREAS.reduce((s, a) => s + a.weight, 0) === 100, "areas: los pesos suman 100");
  // 2026-11-01: la metrica del pilar 2 pesa, y una fuga de datos personales gatea.
  assert(A.areaOf({ id: "2.6" }, 2) === "codegraph-skills" && A.areaWeight(A.areaOf({ id: "2.6" }, 2)) > 0, "2.6 consumo real de CodeGraph puntua en un area con peso");
  assert(A.areaOf({ id: "6.1" }, 6) === "hooks" && A.areaOf({ id: "6.2" }, 6) === "hooks", "6.1 y 6.2 (mandamiento 9) puntuan en hooks y seguridad");
  const guards = ["3.1", "10.1", "10.3", "10.5", "11.5", "12.2", "12.4", "13.1", "14.1", "14.2", "14.5", "17.1", "17.2", "18.1", "18.2", "18.4"];
  assert(guards.every((id) => A.areaWeight(A.CHECK_AREA[id]) === 0), "los checks de existencia o texto pesan 0", guards.filter((id) => A.areaWeight(A.CHECK_AREA[id]) !== 0).join(","));
  assert(A.areaOf({ id: "10.8" }, 10) === "ui" && A.areaOf({ id: "23.1" }, 23) === "sessions", "los checks de comportamiento siguen en su area (caso negativo)");

  // Suelos de cargo (23.1, 23.2, 23.7, 22.8, 22.12, 24.1): un test borrado o ignorado da rojo.
  assert(R2.cargoFilterVerdict({ code: 0, output: "test result: ok. 799 passed; 0 failed; 20 ignored" }, { minPassed: 800 }).pass === false, "23.1 bajo el suelo (tests ignorados) -> rojo");
  assert(R2.cargoFilterVerdict({ code: 101, output: "test result: FAILED. 815 passed; 1 failed;" }, { minPassed: 800 }).pass === false, "23.1 un test de sesiones:: en rojo -> rojo");
  // vitest (23.3, 24.2, 22.11, 10.8): errores no capturados con todo en verde.
  const vErr = "      Tests  778 passed (778)\n     Errors  2 errors\nTypeError: Cannot read properties of undefined (reading 'map')";
  assert(R2.vitestVerdict({ code: 1, output: vErr }, { minTests: 770 }).pass === false, "23.3 vitest con errores no capturados -> rojo");
  assert(R2.vitestVerdict({ code: 0, output: "      Tests  778 passed (778)" }, { minTests: 770 }).pass === true, "23.3 vitest limpio sobre el suelo -> verde");
  // 23.4 Playwright
  const pwRed = "\u001b[1A\u001b[2K  3 failed\n  36 passed (2.5m)\n  1) e2e\\sesiones.spec.ts:176:1 › el HUD cambia el modelo\n";
  assert(R3.playwrightVerdict({ code: 1, output: pwRed }).pass === false, "23.4 e2e con 3 fallos (reporter line con cursores) -> rojo");
  assert(R3.playwrightVerdict({ code: 0, output: "  39 passed (2.4m)" }, { minPassed: 10 }).pass === true, "23.4 e2e en verde -> verde");
  assert(R3.playwrightVerdict({ code: 1, output: "Error: webServer exited" }).pass === false, "23.4 sin resumen -> rojo");
  // 23.5 persistencia
  const now = Date.parse("2026-10-28T12:00:00Z");
  const fileOk = { exists: true, parses: true };
  assert(R3.sessionsPersistenceVerdict({ file: fileOk, bads: [{ name: "abiertas.1761.json.bad", mtimeMs: now - 3600e3 }] }, now).pass === false, "23.5 .json.bad de hoy -> rojo");
  assert(R3.sessionsPersistenceVerdict({ file: fileOk, bads: [{ name: "abiertas.json.bad", mtimeMs: now - 30 * 86400e3 }] }, now).pass === true, "23.5 .json.bad viejo -> verde");
  assert(R3.sessionsPersistenceVerdict({ file: { exists: true, parses: false }, bads: [] }, now).pass === false, "23.5 abiertas.json corrupto -> rojo");
  // 23.6 binario fresco
  const stampOf = (dirty) => ({ sha: "4ca0043b", dirty });
  assert(JSON.stringify(R3.parseAppStamp("\0\0ULTRON_BUILD_STAMP:sha=4ca0043b;dirty=false;\0")) === JSON.stringify(stampOf(false)), "23.6 lee el sello de los bytes");
  assert(R3.parseAppStamp("xxULTRON_BUILD_STAMP:sha=4ca0043b;dirty=true;")?.dirty === true && R3.parseAppStamp("ULTRON_BUILD_STAMP:sha=unknown;dirty=unknown;")?.dirty === null, "23.6 lee dirty=true y desconocido");
  assert(R3.parseAppStamp("4ca0043b suelto en el binario") === null && R3.parseAppStamp("ULTRON_BUILD_STAMP:sha=") === null, "23.6 un SHA suelto no es un sello (caso negativo)");
  assert(R3.binaryFreshnessVerdict({ stamp: stampOf(false), headSha: "abc", commitsSince: 2 }).pass === false, "23.6 commit en control-center/ sin recompilar -> rojo");
  assert(R3.binaryFreshnessVerdict({ stamp: null, headSha: "abc", commitsSince: null }).pass === false, "23.6 sin sello -> rojo");
  assert(R3.binaryFreshnessVerdict({ stamp: stampOf(true), headSha: "4ca0043b", commitsSince: 0 }).pass === false, "23.6 dirty=true -> rojo, igual que 7.10");
  assert(R3.binaryFreshnessVerdict({ stamp: stampOf(null), headSha: "4ca0043b", commitsSince: 0 }).pass === false, "23.6 dirty desconocido no se da por limpio");
  assert(R3.binaryFreshnessVerdict({ stamp: { sha: "unknown", dirty: false }, headSha: "4ca0043b", commitsSince: null }).pass === false, "23.6 sha=unknown -> rojo");
  assert(R3.binaryFreshnessVerdict({ stamp: stampOf(false), headSha: "4ca0043b", commitsSince: 0 }).pass === true, "23.6 binario limpio de HEAD -> verde");

  // 9.6-9.9 sondas de hooks
  const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
  const ask = JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask" } });
  assert(R3.hookDecision(deny) === "deny" && R3.hookDecision("") === null && R3.hookDecision(ask) === "ask", "hookDecision lee deny/ask/nada");
  const probes = (gotPos, gotCtl) => [{ label: "pos", expect: "deny", got: gotPos, code: 0 }, { label: "ctl", expect: "pass", got: gotCtl, code: 0 }];
  assert(R3.hookProbesVerdict(probes("deny", null)).pass === true, "9.x sonda positiva denegada y control libre -> verde");
  assert(R3.hookProbesVerdict(probes(null, null)).pass === false, "9.x el hook deja pasar la sonda positiva -> rojo (caso negativo)");
  assert(R3.hookProbesVerdict(probes("deny", "deny")).pass === false, "9.x el hook deniega el control -> rojo");
  assert(R3.hookProbesVerdict([{ label: "env", expect: "block", got: "ask", code: 0 }, { label: "ok", expect: "pass", got: null, code: 0 }]).pass === true, "9.6 block acepta ask (.env pide permiso)");
  assert(R3.hookProbesVerdict([{ label: "p", expect: "deny", got: "ask", code: 0 }, { label: "c", expect: "pass", got: null, code: 0 }]).pass === false, "9.7 deny estricto no acepta ask");
  // 24.3 pupus-permission
  const quiet = { code: 0, got: null, ms: 60 };
  assert(R3.pupusPermissionVerdict({ noBridge: quiet, deadBridge: quiet, denyBridge: { code: 0, got: "deny", ms: 80 } }).pass === true, "24.3 sin puente callado y puente que deniega -> verde");
  assert(R3.pupusPermissionVerdict({ noBridge: { code: 0, got: "deny", ms: 60 }, deadBridge: quiet, denyBridge: { got: "deny" } }).pass === false, "24.3 deniega sin puente -> rojo");
  assert(R3.pupusPermissionVerdict({ noBridge: quiet, deadBridge: { code: 0, got: null, ms: 5000 }, denyBridge: { got: "deny" } }).pass === false, "24.3 se cuelga con el puente caido -> rojo");
  assert(R3.pupusPermissionVerdict({ noBridge: quiet, deadBridge: quiet, denyBridge: { got: null } }).pass === false, "24.3 sin control positivo (no transmite el deny) -> rojo");

  // 10.7 referencias sin trackear
  const rs = 'const D: &str = include_str!("../../cockpit/x.json");\n#[path = "a_tests.rs"]\nmod tests;\nmod nuevo;\n// mod comentado;\n';
  const t = R3.rustRefTargets(rs);
  assert(t.length === 3 && t.some((x) => x.kind === "include") && t.some((x) => x.kind === "path" && x.target === "a_tests.rs") && t.some((x) => x.kind === "mod" && x.target === "nuevo"),
    "10.7 extrae include_str!, #[path] y mod x; (no el comentado ni el mod del #[path])", JSON.stringify(t));
  assert(R3.tsImportTargets('import { a } from "./a";\nimport type { B } from "./b";\nconst c = import("../c");').join(",") === "./a,../c", "10.7 imports relativos sin los de tipo puro");
  const refs = [{ from: "src/mod.rs", to: "src/nuevo.rs" }, { from: "src/mod.rs", to: "control-center/src-tauri/vendor/tao/x.rs" }];
  assert(R3.untrackedRefsVerdict(refs, new Set(["src/nuevo.rs"])).pass === false, "10.7 fichero nuevo referenciado sin git add -> rojo");
  assert(R3.untrackedRefsVerdict(refs.slice(1), new Set(["control-center/src-tauri/vendor/tao/x.rs"]), { exclude: ["control-center/src-tauri/vendor/"] }).pass === true, "10.7 vendor/ de terceros excluido");
  // 5.6 lapidas
  const tomb = [{ id: "mem0", re: /mem0/i, in: ["hooks"] }, { id: "hw", re: /headroom wrap/ }];
  assert(R3.tombstonesVerdict([{ label: "hooks", text: "require('mem0')" }], tomb).pass === false, "5.6 mem0 reintroducido en hooks -> rojo");
  assert(R3.tombstonesVerdict([{ label: "CLAUDE.md", text: "Mem0 no se usa" }], tomb).pass === true, "5.6 mem0 nombrado para prohibirlo fuera de hooks -> verde");
  // 22.13 secretos y 22.10 paridad
  assert(R3.configSecretHits([{ name: "providers.json", text: `{"key":"gsk_${"A".repeat(24)}"}` }, { name: "zones.json", text: "{}" }]).join() === "providers.json", "22.13 clave en claro en la configuracion -> detectada");
  const def = { chain: ["a", "b"], tiers: { complex: { start: "a" } } };
  assert(R3.delegationParityVerdict({ chain: ["a", "b"] }, def, { badChain: ["a", "b"], badFixtureChain: ["codex"] }).pass === true, "22.10 cadena igual y config invalida rechazada -> verde");
  assert(R3.delegationParityVerdict({ chain: ["b", "a"] }, def).pass === false, "22.10 cadena JS distinta de la de Rust -> rojo");
  assert(R3.delegationParityVerdict({ chain: ["a", "b"] }, def, { badChain: ["codex"], badFixtureChain: ["codex"] }).pass === false, "22.10 JS adopta una config que Rust rechaza -> rojo");
  // 22.9 resumen del selftest de delegate
  assert(R3.okFallosVerdict({ code: 1, output: "53 ok, 1 fallos" }).pass === false && R3.okFallosVerdict({ code: 0, output: "54 ok, 0 fallos" }, { minOk: 50 }).pass === true, "22.9 un fallo del selftest de delegate -> rojo");
  // 6.6 rutas citadas en documentos
  const md = "Ver `control-center/src/App.tsx` y `memory/migrations.rs:12`.\nNo es ruta: `npm run`, `~/.ultron/x.js`, `a/*.rs`, `<id>/x.md`.\nSe retiro `memory/viejo.rs` el 10-10.\n`serve/protocol.rs::handle_request`\n";
  const cited = R3.citedPaths(md);
  assert(cited.join() === "control-center/src/App.tsx,memory/migrations.rs,serve/protocol.rs", "6.6 extrae rutas inequivocas; no comandos, ~/, globs, placeholders ni lineas de retirada", cited.join());
  assert(R3.citedPaths("`.claude/relevos/` y `_disabled/` y `.github/workflows/ci.yml`").join() === ".github/workflows/ci.yml", "6.6 las rutas de la maquina del usuario no cuentan; las del repo con punto, si");
  const docsFix = [{ name: "README.md", paths: ["a/b.rs", "c/d.rs"] }];
  assert(R3.citedPathsVerdict(docsFix, () => true).pass === true, "6.6 todas existen -> verde");
  const rotos = R3.citedPathsVerdict(docsFix, (p) => p !== "c/d.rs");
  assert(rotos.pass === false && rotos.detail.includes("README.md: c/d.rs"), "6.6 una ruta citada que no existe -> rojo con el documento (caso negativo)", rotos.detail);
  assert(R3.citedPathsVerdict([{ name: "x", paths: [] }], () => true).pass === false, "6.6 0 rutas extraidas -> no medible, no verde");

  // Control del medidor (auditoria 2026-11-01)
  const Pv = await imp("provenance.mjs");
  const rowOf = (overall, fp = "p1", h = "h1") => ({ overall, product_fingerprint: fp, harness_hash: h, git_sha: "abc", generated_at: "t" });
  assert(Pv.scoreWatch(null, rowOf(8)).status === "sin_referencia", "control: sin corrida anterior lo declara");
  const riseMeter = Pv.scoreWatch(rowOf(8), rowOf(9, "p1", "h2"));
  assert(riseMeter.status === "nota_sube_sin_cambios_en_producto" && riseMeter.harness_changed === true && /medidor/.test(riseMeter.detail), "control: la nota sube con el producto intacto y el medidor cambiado -> aviso", JSON.stringify(riseMeter));
  const riseLive = Pv.scoreWatch(rowOf(8), rowOf(9));
  assert(riseLive.status === "nota_sube_sin_cambios_en_producto" && riseLive.harness_changed === false && /estado vivo/.test(riseLive.detail), "control: nada cambia y la nota sube -> aviso por estado vivo", JSON.stringify(riseLive));
  assert(Pv.scoreWatch(rowOf(8), rowOf(9, "p2")).status === "ok", "control: la nota sube y el producto cambio -> sin aviso (caso negativo)");
  assert(Pv.scoreWatch(rowOf(9), rowOf(8, "p1", "h2")).status === "ok", "control: la nota baja -> sin aviso (caso negativo)");
  assert(Pv.scoreWatch(rowOf(8), { ...rowOf(9), product_fingerprint: null }).status === "no_comparable", "control: sin huella no compara, no dice ok");
  const effAreas = [{ id: "s", weight: 50 }, { id: "m", weight: 50 }, { id: "h", weight: 0 }];
  const effChecks = [...mk("s", 4, 0), ...mk("m", 4, 0), ...mk("h", 4, 0), { id: "1.1", area: "s", status: "retired" }, { id: "5.1", area: "h", status: "retired" }];
  const eff = Pv.retiredEffect(effChecks, effAreas);
  assert(eff.retired === 2 && eff.overall_drop_if_all_fail === 1 && eff.checks.find((c) => c.id === "1.1").overall_drop_if_fail === 1, "control: efecto de un retirado de un area con peso (10 -> 8 en s, peso 50 %, -1)", JSON.stringify(eff));
  assert(eff.checks.find((c) => c.id === "5.1").overall_drop_if_fail === 0, "control: un retirado de un area de peso 0 no compra nota");
  const provOk = Pv.collectProvenance(ROOT);
  assert(provOk.error === undefined && /^[0-9a-f]{4,}$/.test(provOk.git_sha) && typeof provOk.dirty === "boolean" && /^[0-9a-f]{16}$/.test(provOk.product_fingerprint) && /^[0-9a-f]{16}$/.test(provOk.harness_hash), "control: procedencia real con SHA, dirty y hashes", JSON.stringify(provOk));
  const provBad = Pv.collectProvenance(join(ROOT, "no-existe-kirkardo"));
  assert(provBad.git_sha === null && typeof provBad.error === "string", "control: un fallo de git se declara (caso negativo)", JSON.stringify(provBad));
  const histDir = mkdtempSync(join(tmpdir(), "kirkardo-history-"));
  try {
    assert(Pv.lastHistoryRow(histDir) === null, "control: sin historial -> null");
    Pv.appendHistoryRow(histDir, rowOf(8));
    Pv.appendHistoryRow(histDir, rowOf(9));
    assert(Pv.lastHistoryRow(histDir).overall === 9, "control: lee la ultima fila del historial");
    appendFileSync(join(histDir, "kirkardo-history.jsonl"), "{corrupta\n");
    assert(Pv.lastHistoryRow(histDir).overall === 9, "control: una linea corrupta no borra la referencia");
  } finally {
    rmSync(histDir, { recursive: true, force: true });
  }
  assert(Pv.isMeterPath("scripts/kirkardo/areas.mjs") && Pv.isMeterPath("scripts/kirkardo-eval.mjs") && !Pv.isMeterPath("scripts/delegate.mjs") && !Pv.isMeterPath("hooks/scripts/a.js"), "control: el medidor no es producto, el resto si");

  // Congelado del registro: un cambio de ids, retiradas, pesos o suelos exige
  // regenerar registry.lock.json, que queda visible en el diff.
  const L = await imp("registry-lock.mjs");
  const lockFile = JSON.parse(readFileSync(L.LOCK_FILE, "utf8"));
  const lockDiff = L.snapshotDiff(lockFile, await L.liveSnapshot());
  assert(lockDiff.length === 0, "lock: el registro vivo coincide con registry.lock.json (si el cambio es deliberado: node scripts/kirkardo/registry-lock.mjs --write)", lockDiff.slice(0, 8).join(" | "));
  const tampered = JSON.parse(JSON.stringify(lockFile));
  tampered.areas.hygiene = 50;
  assert(L.snapshotDiff(lockFile, tampered).join() === "areas.hygiene: 0 -> 50", "lock: un peso cambiado se detecta (caso negativo)");
  const retiredTamper = { ...lockFile, checks: { ...lockFile.checks, "23.1": { ...lockFile.checks["23.1"], retiredBy: "x" } } };
  assert(L.snapshotDiff(lockFile, retiredTamper).some((d) => d.startsWith("checks.23.1")), "lock: retirar un check se detecta (caso negativo)");
  assert(L.floorsIn('const X_FLOOR = 800; f({ minPassed: 16 }); minTests: 460').join() === "X_FLOOR=800,minPassed=16,minTests=460", "lock: extrae los suelos literales");

  // Retiradas de la ronda 3: el original vuelve si se borra su sustituto.
  const subs = new Set(Object.values(D.SUPERSEDED));
  assert(D.supersededStatus(subs).inForce === true, "medidor-r3 en vigor con todos los sustitutos registrados");
  const minus = new Set([...subs].filter((id) => id !== "23.4"));
  assert(D.supersededStatus(minus).inForce === false, "medidor-r3 fuera de vigor si falta un sustituto (18.3 vuelve a medirse)");
}
