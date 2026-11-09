/**
 * statusline-tone.selftest.mjs — el tono vuelve a la statusline en modo ligero.
 *
 * Contrato (2026-10-03): con memory-orchestrate en modo ligero (el de por
 * defecto), cada prompt deja su tono en session-tone.jsonl y la statusline lo
 * pinta con su verbo de tone-status.json. Antes, el modo ligero no escribía
 * nada y la statusline se quedaba sin tono.
 *
 * Usa logs y verbos temporales (ULTRON_SESSION_TONE_LOG,
 * ULTRON_STATUSLINE_ORCH_LOG, ULTRON_STATUSLINE_TONE_STATUS): no toca los reales.
 * El tono por defecto sale de un HOME temporal con un personality.json minimo
 * (hooks/scripts/tests/fixture-personality.js): el real no se versiona y en el
 * runner del CI no existe.
 *
 * Uso: node scripts/statusline-tone.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORCHESTRATE = join(ROOT, "hooks", "scripts", "memory-orchestrate.js");
const STATUSLINE = join(ROOT, "cockpit", "statusline.js");

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const require = createRequire(import.meta.url);
const { makeFixtureHome, fixtureHomeEnv } = require("../hooks/scripts/tests/fixture-personality.js");

const dir = mkdtempSync(join(tmpdir(), "ultron-statusline-"));
const home = makeFixtureHome();
const env = {
  ...process.env,
  ...fixtureHomeEnv(home),
  ULTRON_ORCHESTRATE: "",
  ULTRON_SESSION_TONE_LOG: join(dir, "session-tone.jsonl"),
  ULTRON_STATUSLINE_ORCH_LOG: join(dir, "orchestrate.jsonl"),
  ULTRON_STATUSLINE_TONE_STATUS: join(dir, "tone-status.json"),
};
writeFileSync(env.ULTRON_STATUSLINE_TONE_STATUS, JSON.stringify({ ultron: "Procesando", cani: "Petándolo" }));

const run = (script, input) =>
  spawnSync(process.execPath, [script], { input: JSON.stringify(input), env, encoding: "utf8", timeout: 30_000 });
// Quita los códigos ANSI para comparar texto.
const plain = (s) => String(s || "").replace(/\x1b\[[0-9;]*m/g, "");
const statusline = (sessionId) => plain(run(STATUSLINE, { session_id: sessionId, cwd: ROOT, model: { display_name: "Opus" } }).stdout);

try {
  const hook = run(ORCHESTRATE, { prompt: "revisa el build", session_id: "st-ligero", cwd: ROOT, hook_event_name: "UserPromptSubmit" });
  A(hook.status === 0, "memory-orchestrate en modo ligero termina bien", hook.stderr);
  const line = statusline("st-ligero");
  A(/ULTRON·PROCESANDO/.test(line), "la statusline pinta el tono por defecto con su verbo", line);

  // Un prompt posterior con otro tono manda sobre el anterior.
  appendFileSync(env.ULTRON_SESSION_TONE_LOG, JSON.stringify({ session_id: "st-ligero", tone: { id: "cani", is_default: false } }) + "\n");
  A(/CANI·PETÁNDOLO/.test(statusline("st-ligero")), "gana el tono del último prompt", statusline("st-ligero"));

  // Otra sesión sin entradas no hereda el tono (caso negativo).
  A(!/ULTRON·|CANI·/.test(statusline("st-otra")), "una sesión sin prompts no pinta tono", statusline("st-otra"));

  // Sin log ligero, sigue leyendo el del modo completo.
  writeFileSync(env.ULTRON_STATUSLINE_ORCH_LOG, JSON.stringify({ session_id: "st-completo", tone: { id: "cani" } }) + "\n");
  A(/CANI·PETÁNDOLO/.test(statusline("st-completo")), "el modo completo sigue funcionando", statusline("st-completo"));
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log(fail === 0 ? "\nSELFTEST STATUSLINE-TONE: VERDE" : `\nSELFTEST STATUSLINE-TONE: ${fail} FALLO(S)`);
process.exit(fail === 0 ? 0 : 1);
