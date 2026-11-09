// kirkardo/cats-24-pupus.mjs — categoria 24: Pupus, la mascota (2026-10-28,
// hueco H7 de docs/audits/audit-2026-10-28-kirkardo-criterio.md). Antes solo
// la median 14.8 y 14.9, que ahora puntuan en esta area (areas.mjs,
// CHECK_AREA). Suelos medidos el 2026-10-28: 224 #[test] en src-tauri/src/mascot
// y 470 tests de vitest en src/components/mascot.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import * as R2 from "./predicates-r2.mjs";
import * as R3 from "./predicates-r3.mjs";
import { cargoTestCheck } from "./cargo.mjs";
import { CC, HOOKS_SCRIPTS, ULTRON, cat, hookSandbox, run } from "./core.mjs";

const PUPUS_HOOK = join(HOOKS_SCRIPTS, "pupus-permission.js");
const PERMISSION_INPUT = {
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "git push" },
  session_id: "kirkardo-probe",
  cwd: ULTRON,
};

/** Lanza un hook sin bloquear el bucle de eventos (el puente falso vive en este proceso). */
function spawnHookAsync(script, input, env, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stdout = "";
    let settled = false;
    const child = spawn(process.execPath, [script], { env, cwd: ULTRON, windowsHide: true });
    const done = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...res, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => {
      child.kill();
      done({ code: null, stdout, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("error", (e) => done({ code: null, stdout, error: e }));
    child.on("close", (code) => done({ code, stdout }));
    child.stdin.end(JSON.stringify(input));
  });
}

function listen(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

async function freePort() {
  const srv = await listen(() => {});
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/** Tres escenarios de pupus-permission.js en el HOME aislado del harness. */
async function probePupusPermission() {
  const sb = hookSandbox();
  const bridgeFile = join(sb.ultron, "cockpit", "mascot-bridge.json");
  mkdirSync(join(sb.ultron, "cockpit"), { recursive: true });
  // Sin ULTRON_SESION_ID ni opt-outs heredados: el hook debe intentar preguntar.
  const env = sb.env({ extra: { ULTRON_SESION_ID: undefined, CLAUDE_NO_HOOKS: undefined, PUPUS_PERMISSION_DISABLED: undefined } });
  const decided = (r) => ({ code: r.code, ms: r.ms, got: R3.hookDecision(r.stdout), error: r.error });
  rmSync(bridgeFile, { force: true });
  const noBridge = decided(await spawnHookAsync(PUPUS_HOOK, PERMISSION_INPUT, env));
  writeFileSync(bridgeFile, JSON.stringify({ port: await freePort(), token: "kirkardo" }));
  const deadBridge = decided(await spawnHookAsync(PUPUS_HOOK, PERMISSION_INPUT, env));
  const srv = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "kirkardo" } } }));
    });
  });
  try {
    writeFileSync(bridgeFile, JSON.stringify({ port: srv.address().port, token: "kirkardo" }));
    const denyBridge = decided(await spawnHookAsync(PUPUS_HOOK, PERMISSION_INPUT, env));
    return { noBridge, deadBridge, denyBridge };
  } finally {
    srv.close();
    rmSync(bridgeFile, { force: true });
  }
}

cat(24, "Pupus (mascota)", [
  {
    id: "24.1",
    desc: "backend de Pupus: cargo test mascot:: en verde con >= 220 tests (chat, puente, permisos, guardarrail, entregas)",
    auto: true,
    check() {
      return cargoTestCheck("mascot::", { minPassed: 220 });
    },
  },
  {
    id: "24.2",
    desc: "front de Pupus: vitest de src/components/mascot en verde, sin errores no capturados y con >= 460 tests",
    auto: true,
    check() {
      if (!existsSync(join(CC, "node_modules"))) return { manual: true, detail: "sin control-center/node_modules: vitest no se puede ejecutar aqui" };
      const r = run("npx vitest run src/components/mascot --silent 2>&1", { cwd: CC, timeout: 600000 });
      return R2.vitestVerdict({ code: r.code, output: r.stdout + r.stderr }, { minTests: 460 });
    },
  },
  {
    id: "24.3",
    desc: "PermissionRequest nunca bloquea: pupus-permission.js sin puente y con el puente caido sale con exit 0, sin decision y en < 2 s; con un puente que deniega devuelve deny (control positivo)",
    auto: true,
    async check() {
      // Si el hook denegara o se colgara con ULTRON cerrado, congelaria todas
      // las sesiones de terminal (M2 de la auditoria).
      if (!existsSync(PUPUS_HOOK)) return { pass: false, detail: "no medible: falta hooks/scripts/pupus-permission.js" };
      const probes = await probePupusPermission();
      const spawnErr = [probes.noBridge, probes.deadBridge, probes.denyBridge].find((p) => p.error);
      if (spawnErr) return { manual: true, detail: `no ejecutable (infraestructura): no se pudo lanzar node (${spawnErr.error.code ?? spawnErr.error.message})` };
      return R3.pupusPermissionVerdict(probes);
    },
  },
]);
