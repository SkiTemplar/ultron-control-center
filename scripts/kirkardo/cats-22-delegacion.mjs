// kirkardo/cats-22-delegacion.mjs — categoria 22 reconvertida (2026-10-28, P6
// de docs/audits/audit-2026-10-28-kirkardo-criterio.md, huecos H5 y H6):
// "Delegacion multimotor y relevo". La delegacion real (scripts/delegate.mjs,
// ai_router/delegation*.rs y la pestana AI Router -> Delegacion) y los
// proveedores personalizados no tenian ningun check. El relevo de motores de
// Sessions se mide en 23.7 (area Sessions).
//
// Fuera de alcance aqui (uncovered_surfaces): D5, aislamiento del motor falso,
// porque crearia ramas delegate/<id> en el repo vivo.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as P from "./predicates.mjs";
import * as R2 from "./predicates-r2.mjs";
import * as R3 from "./predicates-r3.mjs";
import { cargoTestCheck } from "./cargo.mjs";
import { CC, CC_TAURI, REPO, extendCat, invokeCallsites, readJSON, run, spawnTracked } from "./core.mjs";

const AI_ROUTER_CFG = join(REPO, "cockpit", "ai-router");
const DEFAULT_CFG = join(AI_ROUTER_CFG, "delegation.default.json");
const DELEGATE = join(REPO, "scripts", "delegate.mjs");

function nodeRun(script, args, env = {}, timeout = 300000) {
  const r = spawnTracked(process.execPath, [script, ...args], {
    cwd: REPO, encoding: "utf8", timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env },
  }, script.split(/[\\/]/).pop());
  return { code: r.status, stdout: r.stdout ?? "", output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** status --json de delegate.mjs con una configuracion de usuario concreta (inexistente = la por defecto). */
function delegateStatus(configPath) {
  const r = nodeRun(DELEGATE, ["status", "--json"], { ULTRON_DELEGATE_CONFIG: configPath }, 60000);
  try { return JSON.parse(r.stdout.trim()); } catch { return null; }
}

extendCat(22, [
  {
    id: "22.8",
    desc: "configuracion de delegacion en Rust: cargo test ai_router::delegation (>= 16) en verde (validate rechaza cadenas y tiers invalidos)",
    auto: true,
    check() {
      return cargoTestCheck("ai_router::delegation", { minPassed: 16 });
    },
  },
  {
    id: "22.9",
    desc: "delegate.mjs con id propio: delegate.selftest.mjs en verde (motor falso ULTRON_DELEGATE_FAKE_ENGINE, sin red) con >= 50 casos",
    auto: true,
    check() {
      const st = join(REPO, "scripts", "delegate.selftest.mjs");
      if (!existsSync(st)) return { pass: false, detail: "no medible: falta scripts/delegate.selftest.mjs" };
      return R3.okFallosVerdict(nodeRun(st, []), { minOk: 50 });
    },
  },
  {
    id: "22.10",
    desc: "paridad JS/Rust de la delegacion: status --json sin delegation.json ensena la cadena de delegation.default.json (la que incrusta Rust) y un delegation.json con un tier sin start no se adopta",
    auto: true,
    check() {
      const def = readJSON(DEFAULT_CFG);
      if (!def) return { pass: false, detail: "no medible: delegation.default.json ausente o ilegible" };
      const dir = mkdtempSync(join(tmpdir(), "kirkardo-deleg-"));
      try {
        const js = delegateStatus(join(dir, "no-existe.json"));
        const badFixtureChain = ["codex"];
        const bad = join(dir, "delegation.json");
        writeFileSync(bad, JSON.stringify({ version: 1, chain: badFixtureChain, tiers: { complex: {} } }));
        const badStatus = delegateStatus(bad);
        return R3.delegationParityVerdict(js, def, { badChain: badStatus?.chain ?? null, badFixtureChain });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    id: "22.11",
    desc: "el historial de delegaciones se consume (mandamiento 12): ai_router_delegation_ledger registrado con invoke real, y vitest de src/components/AIRouter en verde (>= 45)",
    auto: true,
    check() {
      const handlers = join(CC_TAURI, "handlers.rs");
      const gh = existsSync(handlers) ? P.parseGenerateHandler(readFileSync(handlers, "utf8")) : null;
      if (!gh) return { pass: false, detail: "no medible: generate_handler! no encontrado en handlers.rs" };
      const wired = R2.commandsWiredVerdict(["ai_router_delegation_ledger", "ai_router_delegation_status"], gh.registered, (c) => invokeCallsites(c).length);
      if (!existsSync(join(CC, "node_modules"))) return { manual: true, detail: `sin node_modules para vitest; cableado: ${wired.detail}` };
      const r = run("npx vitest run src/components/AIRouter --silent 2>&1", { cwd: CC, timeout: 300000 });
      const vt = R2.vitestVerdict({ code: r.code, output: r.stdout + r.stderr }, { minTests: 45 });
      return { pass: wired.pass && vt.pass, detail: `${wired.detail} | vitest: ${vt.detail}` };
    },
  },
  {
    id: "22.12",
    desc: "proveedores personalizados y descubrimiento: cargo test ai_router::custom (>= 11), ai_router::discover (>= 6) y provider_overlay (>= 6) en verde",
    auto: true,
    check() {
      const vs = [
        cargoTestCheck("ai_router::custom", { minPassed: 11 }),
        cargoTestCheck("ai_router::discover", { minPassed: 6 }),
        cargoTestCheck("provider_overlay", { minPassed: 6 }),
      ];
      const manual = vs.find((v) => v.manual);
      if (manual) return manual;
      return { pass: vs.every((v) => v.pass), detail: vs.map((v) => v.detail).join(" | ") };
    },
  },
  {
    id: "22.13",
    desc: "0 claves en claro en la configuracion versionada del router y la delegacion (cockpit/ai-router/providers*.json, zones.json, delegation*.json)",
    auto: true,
    check() {
      if (!existsSync(AI_ROUTER_CFG)) return { pass: false, detail: "no medible: cockpit/ai-router ausente" };
      const names = readdirSync(AI_ROUTER_CFG).filter((n) => /^(providers.*|zones|delegation.*)\.json$/.test(n));
      if (!names.length) return { pass: false, detail: "no medible: 0 ficheros de configuracion del router" };
      const files = names.map((name) => ({ name, text: readFileSync(join(AI_ROUTER_CFG, name), "utf8") }));
      const hits = R3.configSecretHits(files);
      return { pass: hits.length === 0, detail: `${files.length} ficheros (${names.join(",")}); con clave en claro=${hits.length}${hits.length ? `: ${hits.join(",")}` : ""}` };
    },
  },
]);
