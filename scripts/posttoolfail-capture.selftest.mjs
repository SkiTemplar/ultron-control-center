/**
 * posttoolfail-capture.selftest.mjs — check conductual del detector (casilla 3.9).
 *
 * Verifica que `detectError` reconoce las DOS clases de fallo que sus dos eventos
 * traen, y que NO marca fallo en éxito (caso negativo, mand. 7):
 *   - PostToolUseFailure: payload con `error` top-level (la tool ni ejecutó).
 *   - PostToolUse: tool_response con is_error / status=error / success=false / exit_code!=0.
 *   - éxito: tool_response ok -> null (no propone -> no ensucia el inbox).
 *
 * Uso: node scripts/posttoolfail-capture.selftest.mjs   (exit 0 = verde)
 */
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { detectError } = require(join(__dirname, "..", "hooks", "scripts", "posttoolfail-capture.js"));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

// PostToolUseFailure — fallo de harness: payload con error top-level, sin tool_response.
const e1 = detectError({ tool_name: "Bash", tool_input: {}, error: "permission denied" });
A(e1 === "permission denied", "PostToolUseFailure: error top-level detectado", JSON.stringify(e1));

// PostToolUse — fallo con resultado: is_error.
const e2 = detectError({ tool_name: "Bash", tool_response: { is_error: true, stderr: "boom" } });
A(e2 === "boom", "PostToolUse: tool_response.is_error detectado", JSON.stringify(e2));

// PostToolUse — exit code no-cero.
const e3 = detectError({ tool_response: { exit_code: 2, stderr: "exit 2" } });
A(e3 === "exit 2", "PostToolUse: exit_code!=0 detectado", JSON.stringify(e3));

// Caso NEGATIVO (mand. 7): éxito -> null (no propone).
const e4 = detectError({ tool_name: "Read", tool_response: { is_error: false, content: "ok" } });
A(e4 === null, "éxito -> null (no ensucia el inbox)", JSON.stringify(e4));

// Caso NEGATIVO: sin señales de error -> null.
const e5 = detectError({ tool_name: "Grep", tool_response: { matches: [] } });
A(e5 === null, "sin señal de error -> null", JSON.stringify(e5));

console.log(fail === 0 ? "\nSELFTEST 3.9 (posttoolfail): VERDE" : `\nSELFTEST 3.9 (posttoolfail): ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
