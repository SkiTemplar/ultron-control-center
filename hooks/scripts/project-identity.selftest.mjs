/**
 * project-identity.selftest.mjs — escritura del registro de identidades.
 *
 * Contrato (2026-10-03): `writeRegistry` reemplaza el registro con un rename
 * atómico; si el rename falla (en Windows, EPERM mientras otro hook tiene el
 * fichero abierto) reintenta y, si no lo consigue, borra el temporal en vez de
 * dejar `project-identity.json.tmp.<pid>` en `cockpit/`.
 *
 * Usa un registro temporal vía ULTRON_PROJECT_IDENTITY_PATH: nunca toca el real.
 *
 * Uso: node hooks/scripts/project-identity.selftest.mjs   (exit 0 = verde)
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const dir = mkdtempSync(join(tmpdir(), "ultron-identity-"));
const target = join(dir, "project-identity.json");
process.env.ULTRON_PROJECT_IDENTITY_PATH = target;
const identity = require(join(__dirname, "lib", "project-identity.js"));
const leftovers = () => readdirSync(dir).filter((f) => f.includes(".tmp."));

try {
  const reg = identity.writeRegistry((r) => { r.selftest = true; });
  const written = JSON.parse(readFileSync(target, "utf8"));
  A(reg !== null && written.selftest === true, "escribe el registro", JSON.stringify(written).slice(0, 120));
  A(leftovers().length === 0, "sin temporales tras una escritura correcta", leftovers().join(", "));

  // Rename que falla siempre: tres intentos y el temporal borrado.
  let calls = 0;
  const tmp = `${target}.tmp.prueba`;
  require("node:fs").writeFileSync(tmp, "{}");
  const replaced = identity.replaceFile(tmp, target, () => { calls++; throw new Error("EPERM"); });
  A(replaced === false && calls === 3, "reintenta tres veces y avisa del fallo", `replaced=${replaced} calls=${calls}`);
  A(!existsSync(tmp), "borra el temporal si no puede reemplazar (caso negativo)", leftovers().join(", "));

  // Fallo real del sistema de ficheros: el destino es un directorio.
  rmSync(target);
  mkdirSync(target);
  const failed = identity.writeRegistry((r) => { r.otra = true; });
  A(failed === null, "writeRegistry devuelve null si no puede escribir", String(failed));
  A(leftovers().length === 0, "y no deja project-identity.json.tmp.<pid>", leftovers().join(", "));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail === 0 ? "\nSELFTEST PROJECT-IDENTITY: VERDE" : `\nSELFTEST PROJECT-IDENTITY: ${fail} FALLO(S)`);
process.exit(fail === 0 ? 0 : 1);
