/**
 * socratic-gate.selftest.mjs — check conductual del gate socratico por
 * proyecto (ULTRON 4, F4.3, decision Q5a): `socratic: strict|light|off` en
 * cockpit/projects.json; ausente = strict.
 *
 *   strict: protocolo completo en el primer prompt, recordatorio en prompts
 *           decisionales, ESCALADA ante un ack de bajo esfuerzo.
 *   light : igual pero SIN escalada (un "ok" pasa).
 *   off   : silencio absoluto.
 *
 * Hermetico: SOCRATIC_PROJECTS_OVERRIDE apunta a un registro temporal; los
 * marcadores de sesion usan ids unicos y se limpian al final.
 *
 * Uso: node hooks/scripts/socratic-gate.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..", "..");
const HOOK = join(__dirname, "socratic-gate.js");
const FIXTURE = join(ULTRON, "logs", "_selftest-socratic-gate");
const REGISTRY = join(FIXTURE, "projects.json");
const DIR_STRICT = join(FIXTURE, "proyecto-strict");
const DIR_LIGHT = join(FIXTURE, "proyecto-light");
const DIR_OFF = join(FIXTURE, "proyecto-off");
const DIR_LIBRE = join(FIXTURE, "sin-registrar");
const SESSIONS = [];

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true, force: true });
for (const d of [DIR_STRICT, DIR_LIGHT, DIR_OFF, DIR_LIBRE]) mkdirSync(join(d, "src"), { recursive: true });
writeFileSync(REGISTRY, JSON.stringify({
  projects: [
    { id: "p-strict", path: DIR_STRICT },
    { id: "p-light", path: DIR_LIGHT, socratic: "light" },
    { id: "p-off", path: DIR_OFF, socratic: "off" },
  ],
}));

let seq = 0;
function fire(prompt, cwd, sessionId) {
  const sid = sessionId || `selftest-socratic-${Date.now()}-${seq++}`;
  SESSIONS.push(sid);
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ prompt, cwd: cwd.replace(/\\/g, "/"), session_id: sid, hook_event_name: "UserPromptSubmit" }),
    encoding: "utf8", timeout: 15000,
    env: { ...process.env, SOCRATIC_PROJECTS_OVERRIDE: REGISTRY },
  });
  const out = (r.stdout || "").trim();
  let ctx = "";
  try { ctx = out ? JSON.parse(out).hookSpecificOutput.additionalContext : ""; } catch (_) { ctx = out; }
  return { status: r.status, ctx, sid };
}

// strict (por defecto, ausente en el registro)
const s1 = fire("vamos a disenar el modulo de pagos", DIR_STRICT);
A(s1.status === 0 && /Protocolo activo/.test(s1.ctx), "strict: primer prompt de la sesion -> protocolo completo", s1.ctx.slice(0, 80));
const s2 = fire("que enfoque prefieres para el cache?", DIR_STRICT, s1.sid);
A(/Decision no trivial/.test(s2.ctx), "strict: prompt decisional -> recordatorio corto", s2.ctx.slice(0, 80));
const s3 = fire("ok", DIR_STRICT, s1.sid);
A(/GATE/.test(s3.ctx) && /bajo esfuerzo/.test(s3.ctx), "strict: ack de bajo esfuerzo -> ESCALADA", s3.ctx.slice(0, 80));
const s4 = fire("arregla el typo del README", DIR_STRICT, s1.sid);
A(s4.ctx === "", "strict (NEGATIVO): orden directa sin decision -> silencio", s4.ctx.slice(0, 80));

// sin registrar -> strict
const l1 = fire("dale", DIR_LIBRE);
A(/GATE/.test(l1.ctx), "sin registrar: se aplica strict (escalada)", l1.ctx.slice(0, 80));

// light
const g1 = fire("vamos a disenar el modulo de pagos", DIR_LIGHT);
A(/Protocolo activo/.test(g1.ctx) && /modo light/.test(g1.ctx), "light: primer prompt -> protocolo completo con aviso de modo light", g1.ctx.slice(0, 120));
const g2 = fire("ok", DIR_LIGHT, g1.sid);
A(g2.ctx === "", "light: un 'ok' NO escala", g2.ctx.slice(0, 80));
const g3 = fire("que enfoque prefieres para el cache?", DIR_LIGHT, g1.sid);
A(/Decision no trivial/.test(g3.ctx), "light: prompt decisional -> recordatorio corto", g3.ctx.slice(0, 80));

// off
const o1 = fire("vamos a disenar el modulo de pagos", DIR_OFF);
const o2 = fire("ok", DIR_OFF, o1.sid);
const o3 = fire("que enfoque prefieres?", DIR_OFF, o1.sid);
A(o1.status === 0 && o1.ctx === "" && o2.ctx === "" && o3.ctx === "", "off: silencio en primer prompt, ack y decisional", JSON.stringify([o1.ctx, o2.ctx, o3.ctx].map((c) => c.slice(0, 30))));

// subcarpeta de un proyecto registrado hereda su modo
const sub = fire("ok", join(DIR_OFF, "src"));
A(sub.ctx === "", "off: una subcarpeta del proyecto hereda el modo", sub.ctx.slice(0, 80));

// turno de sistema -> nada, en cualquier modo
const sys = fire("<task-notification><task-id>x</task-id></task-notification>", DIR_STRICT, s1.sid);
A(sys.ctx === "", "strict (NEGATIVO): turno de sistema -> silencio", sys.ctx.slice(0, 80));

// valor invalido -> strict
writeFileSync(REGISTRY, JSON.stringify({ projects: [{ id: "p-raro", path: DIR_LIGHT, socratic: "loquesea" }] }));
const raro = fire("dale", DIR_LIGHT);
A(/GATE/.test(raro.ctx), "valor invalido de socratic -> strict", raro.ctx.slice(0, 80));

rmSync(FIXTURE, { recursive: true, force: true });
for (const sid of SESSIONS) {
  const m = join(tmpdir(), `ultron-socratic-${sid.replace(/[^A-Za-z0-9_-]/g, "")}`);
  if (existsSync(m)) rmSync(m, { force: true });
}
console.log(fail === 0 ? "\nSELFTEST socratic-gate: VERDE" : `\nSELFTEST socratic-gate: ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
