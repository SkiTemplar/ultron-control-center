/**
 * last-session.selftest.mjs — seleccion del resumen de la sesion anterior
 * (lib/last-session.js#latestSummary).
 *
 * Caso real 2026-09-23: el 22-09 a las 20:41 se resumieron en lote sesiones
 * antiguas (la 27d05dcf era del 02-09); su summary.md paso a ser el de mtime
 * mas reciente y el arranque siguiente inyecto como "sesion anterior" un
 * resumen de tres semanas antes. La sesion anterior es la que TERMINO mas
 * tarde (fin del campo `rango:`), no la que se resumio mas tarde.
 *
 * Hermetico: LAST_SESSION_PROJECTS_DIR apunta a un fixture temporal.
 * Uso: node hooks/scripts/last-session.selftest.mjs   (exit 0 = verde)
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const ROOT = mkdtempSync(join(tmpdir(), "last-session-selftest-"));
process.env.LAST_SESSION_PROJECTS_DIR = ROOT;
const { latestSummary } = require(join(__dirname, "lib", "last-session.js"));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const PROJECT = "proyecto-selftest";

function writeSummary(sessionId, rango, mtimeIso) {
  const dir = join(ROOT, PROJECT, "sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "summary.md");
  const front = rango ? `---\nsession_id: ${sessionId}\nrango: ${rango}\n---\n\n` : "";
  writeFileSync(file, `${front}## Pendientes\n- algo de ${sessionId}\n`);
  const t = new Date(mtimeIso);
  utimesSync(file, t, t);
}

try {
  // La sesion reciente se resumio ANTES que la antigua (lote de relleno).
  writeSummary("reciente", "2026-09-22T20:26:36.046Z .. 2026-09-22T21:33:08.117Z", "2026-09-22T21:34:00Z");
  writeSummary("antigua", "2026-09-02T18:07:48.892Z .. 2026-09-02T19:19:07.531Z", "2026-09-23T10:00:00Z");

  let got = latestSummary(PROJECT, "actual");
  A(got && got.sessionId === "reciente", "elige la sesion que termino mas tarde, no el summary escrito mas tarde", got && got.sessionId);

  got = latestSummary(PROJECT, "reciente");
  A(got && got.sessionId === "antigua", "excludeSessionId sigue excluyendo la sesion actual", got && got.sessionId);

  // sinceMs filtra por mtime: solo cuenta lo escrito tras el inicio de la espera.
  got = latestSummary(PROJECT, "actual", { sinceMs: Date.parse("2026-09-23T00:00:00Z") });
  A(got && got.sessionId === "antigua", "sinceMs sigue filtrando por mtime (entrega diferida)", got && got.sessionId);

  // Sin frontmatter `rango:` cae al mtime.
  writeSummary("sin-rango", null, "2026-09-24T00:00:00Z");
  got = latestSummary(PROJECT, "actual", { sinceMs: Date.parse("2026-09-23T12:00:00Z") });
  A(got && got.sessionId === "sin-rango", "summary sin rango: fallback al mtime", got && got.sessionId);

  // Rango ilegible tampoco rompe: cae al mtime.
  writeSummary("rango-roto", "ayer .. mañana", "2026-09-25T00:00:00Z");
  got = latestSummary(PROJECT, "actual", { sinceMs: Date.parse("2026-09-24T12:00:00Z") });
  A(got && got.sessionId === "rango-roto", "rango ilegible: fallback al mtime sin excepcion", got && got.sessionId);

  A(latestSummary("proyecto-inexistente", "x") === null, "proyecto sin sesiones devuelve null", "no null");
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAIL` : "\nOK");
process.exit(fail ? 1 : 0);
