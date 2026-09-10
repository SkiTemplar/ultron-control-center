/**
 * fast-lane.selftest.mjs — check del carril de doble velocidad (lib/fast-lane.js).
 *
 * Hermetico: el estado por sesion se inyecta en `decide` (no toca .tmp) salvo
 * el bloque de markPrompt, que usa una sesion sintetica y la borra al acabar.
 *
 * Uso: node hooks/scripts/fast-lane.selftest.mjs   (exit 0 = verde)
 */
import { rmSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lane = require("./lib/fast-lane.js");

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

// --- classify ---------------------------------------------------------------
const acks = ["ok", "vale", "dale", "sí", "1", "1 y 2", "Debe ser 1.", "fb: si", "sigue con el F1.7", "hazlo", "perfecto, adelante", "continúa"];
for (const p of acks) A(lane.classify(p) === "ack", `classify ack: ${JSON.stringify(p)}`, lane.classify(p));

const status = ["¿Qué teníamos pendiente?", "status en memoria", "cómo va", "resumen", "qué falta", "estado del kanban"];
for (const p of status) A(lane.classify(p) === "status", `classify status: ${JSON.stringify(p)}`, lane.classify(p));

const other = [
  "arregla el test",                                   // señal técnica
  "vale, pero mide primero",                           // orden dentro del ack
  "¿por qué falla?",                                   // interrogación
  "1 y 2 ahora, con el log del daemon primero",        // contenido nuevo
  "pushea y sigue con la doble velocidad",             // tarea nombrada fuera del set
  "sigue con el refactor del modulo de recall y luego los tests", // continuación larga
  "",
];
for (const p of other) A(lane.classify(p) === "other", `classify other (NEGATIVO): ${JSON.stringify(p)}`, lane.classify(p));

// --- decide -----------------------------------------------------------------
const now = 1_000_000_000;
const warm = { prompts: 3, fast_streak: 0, last_full_ms: now - 60_000 };

A(lane.decide({ prompt: "ok", sessionId: "s", state: { prompts: 0, fast_streak: 0, last_full_ms: 0 }, now }).lane === "full",
  "primer prompt de la sesion SIEMPRE completo aunque sea un ack");
A(lane.decide({ prompt: "ok", sessionId: null, state: warm, now }).lane === "full", "sin session_id -> completo");
A(lane.decide({ prompt: "ok", sessionId: "s", state: warm, now }).lane === "fast", "ack con sesion caliente -> rapido");
A(lane.decide({ prompt: "sigue con el F1.7", sessionId: "s", state: warm, now }).lane === "fast", "continuacion corta -> rapido");
A(lane.decide({ prompt: "¿qué teníamos pendiente?", sessionId: "s", state: warm, now }).lane === "full", "pregunta de estado corta -> completo (NEGATIVO del carril)");
A(lane.decide({ prompt: "arregla el test", sessionId: "s", state: warm, now }).lane === "full", "orden tecnica -> completo");
A(lane.decide({ prompt: "ok", sessionId: "s", state: { ...warm, fast_streak: lane.FAST_STREAK_MAX }, now }).lane === "full",
  `racha de ${lane.FAST_STREAK_MAX} rapidos -> el siguiente completo (red de seguridad)`);
A(lane.decide({ prompt: "ok", sessionId: "s", state: { ...warm, last_full_ms: now - lane.FAST_STREAK_MAX_MS - 1 }, now }).lane === "full",
  "ultimo completo hace mas de 15 min -> completo");

// --- markPrompt (estado real, sesion sintetica) -------------------------------
const SID = "selftest-fast-lane";
rmSync(lane.statePath(SID), { force: true });
A(lane.readState(SID).prompts === 0, "sesion nueva: 0 prompts");
let st = lane.markPrompt(SID, { full: true, now });
A(st.prompts === 1 && st.fast_streak === 0 && st.last_full_ms === now, "markPrompt full: prompts=1, racha 0", JSON.stringify(st));
st = lane.markPrompt(SID, { full: false, now: now + 1 });
st = lane.markPrompt(SID, { full: false, now: now + 2 });
A(st.prompts === 3 && st.fast_streak === 2 && st.last_full_ms === now, "dos rapidos: racha 2, last_full intacto", JSON.stringify(st));
A(lane.readState(SID).fast_streak === 2, "el estado persiste en disco");
st = lane.markPrompt(SID, { full: true, now: now + 3 });
A(st.fast_streak === 0 && st.last_full_ms === now + 3, "un completo resetea la racha", JSON.stringify(st));
rmSync(lane.statePath(SID), { force: true });

console.log(fail === 0 ? "\nSELFTEST fast-lane: VERDE" : `\nSELFTEST fast-lane: ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
