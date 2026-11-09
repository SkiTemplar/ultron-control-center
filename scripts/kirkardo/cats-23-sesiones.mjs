// kirkardo/cats-23-sesiones.mjs — categoria 23: Sessions, el producto
// principal (2026-10-28, P2 de docs/audits/audit-2026-10-28-kirkardo-criterio.md,
// huecos H1, H2 y H3). Hasta esta ronda Sessions no tenia ningun check propio:
// sus tests de Rust y de vitest entraban diluidos en 7.5.
//
// Suelos (minPassed / minTests) medidos el 2026-10-28: 836 #[test] en
// src-tauri/src/sesiones, 778 tests de vitest en src/sesiones. Un test
// borrado, marcado #[ignore] o sacado de compilacion tambien da rojo, no solo
// un test en rojo.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as R2 from "./predicates-r2.mjs";
import * as R3 from "./predicates-r3.mjs";
import { cargoTestCheck } from "./cargo.mjs";
import { CC, COCKPIT, REPO, cat, run } from "./core.mjs";

const SESSIONS_RS_FLOOR = 800;
const SESSIONS_VITEST_FLOOR = 770;
const E2E_SPECS = ["e2e/smoke.spec.ts", "e2e/sesiones.spec.ts", "e2e/sesiones-chat.spec.ts"];
const APP_EXE = join(CC, "src-tauri", "target", "release", "control-center.exe");

function noNodeModules() {
  return existsSync(join(CC, "node_modules")) ? null : { manual: true, detail: "sin control-center/node_modules: no se puede ejecutar aqui" };
}

/** Combina varios veredictos de cargoTestCheck: manual si alguno lo es; verde si todos. */
function allOf(verdicts) {
  const manual = verdicts.find((v) => v.manual);
  if (manual) return manual;
  return { pass: verdicts.every((v) => v.pass), detail: verdicts.map((v) => v.detail).join(" | ") };
}

cat(23, "Sessions (nucleo, front, e2e, persistencia y binario)", [
  {
    id: "23.1",
    desc: `backend de Sessions: cargo test sesiones:: en verde con >= ${SESSIONS_RS_FLOOR} tests (maquina, cola, persistencia, recuperacion, puente)`,
    auto: true,
    check() {
      return cargoTestCheck("sesiones::", { minPassed: SESSIONS_RS_FLOOR });
    },
  },
  {
    id: "23.2",
    desc: "seguridad del puente de Sessions con id propio: tests_puente_seguridad (>= 16) y tests_puente_limites (>= 4) en verde",
    auto: true,
    check() {
      // El modulo de seguridad cuelga de tests_puente_v2 (#[path] mod seguridad).
      return allOf([
        cargoTestCheck("sesiones::tests_puente_v2::seguridad::", { minPassed: 16 }),
        cargoTestCheck("sesiones::puente::tests_limites::", { minPassed: 4 }),
      ]);
    },
  },
  {
    id: "23.3",
    desc: `front de Sessions: vitest de src/sesiones en verde, sin errores no capturados y con >= ${SESSIONS_VITEST_FLOOR} tests`,
    auto: true,
    check() {
      const nm = noNodeModules();
      if (nm) return nm;
      const r = run("npx vitest run src/sesiones --silent 2>&1", { cwd: CC, timeout: 600000 });
      return R2.vitestVerdict({ code: r.code, output: r.stdout + r.stderr }, { minTests: SESSIONS_VITEST_FLOOR });
    },
  },
  {
    id: "23.4",
    desc: "e2e de Sessions con mocks (Playwright): smoke, sesiones y sesiones-chat en verde (sustituye a 18.3; el arranque real sigue siendo manual)",
    auto: true,
    check() {
      const nm = noNodeModules();
      if (nm) return nm;
      if (!existsSync(join(CC, "playwright.config.ts"))) return { pass: false, detail: "no medible: falta playwright.config.ts" };
      const r = run(`npx playwright test ${E2E_SPECS.join(" ")} --reporter=line 2>&1`, { cwd: CC, timeout: 900000 });
      const out = r.stdout + r.stderr;
      if (/Executable doesn't exist|npx playwright install/.test(out)) return { manual: true, detail: "Playwright sin navegadores instalados (npx playwright install)" };
      return R3.playwrightVerdict({ code: r.code, output: out }, { minPassed: 10 });
    },
  },
  {
    id: "23.5",
    desc: "persistencia viva de Sessions: cockpit/sesiones/abiertas.json parsea y no hay *.json.bad de los ultimos 7 dias (corrupcion detectada por persistencia.rs)",
    auto: true,
    check() {
      const dir = join(COCKPIT, "sesiones");
      const file = join(dir, "abiertas.json");
      let parses = false;
      if (existsSync(file)) {
        try { JSON.parse(readFileSync(file, "utf8")); parses = true; } catch { parses = false; }
      }
      const bads = existsSync(dir)
        ? readdirSync(dir).filter((n) => n.endsWith(".json.bad")).map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
        : [];
      return R3.sessionsPersistenceVerdict({ file: { exists: existsSync(file), parses }, bads }, Date.now());
    },
  },
  {
    id: "23.6",
    desc: "binario de la app fresco (mandamiento 3): target/release/control-center.exe lleva el sello build_stamp::APP_STAMP con dirty=false y sin commits posteriores en control-center/",
    auto: true,
    check() {
      if (!existsSync(APP_EXE)) return { pass: false, detail: "no medible: control-center.exe sin compilar (npm run build:local)" };
      const head = run("git rev-parse --short HEAD", { cwd: REPO, timeout: 10000 }).stdout.trim();
      let lat;
      try { lat = readFileSync(APP_EXE).toString("latin1"); } catch (e) { return { pass: false, detail: `no medible: no se pudo leer el .exe: ${e.message}` }; }
      const stamp = R3.parseAppStamp(lat);
      let commitsSince = null;
      if (stamp && stamp.sha !== "unknown") {
        const c = run(`git rev-list --count ${stamp.sha}..HEAD -- control-center/src control-center/src-tauri/src control-center/src-tauri/Cargo.toml`, { cwd: REPO, timeout: 20000 });
        commitsSince = c.ok ? Number(c.stdout.trim()) : null;
      }
      return R3.binaryFreshnessVerdict({ stamp, headSha: head, commitsSince });
    },
  },
  {
    id: "23.7",
    desc: "relevo de motores y OpenCode: cargo test sesiones::relevo (>= 19), sesiones::opencode (>= 28) y sesiones::uso_externo (>= 6) en verde",
    auto: true,
    check() {
      return allOf([
        cargoTestCheck("sesiones::relevo", { minPassed: 19 }),
        cargoTestCheck("sesiones::opencode", { minPassed: 28 }),
        cargoTestCheck("sesiones::uso_externo", { minPassed: 6 }),
      ]);
    },
  },
]);
