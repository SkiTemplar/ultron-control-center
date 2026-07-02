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
const { detectError, buildCandidate } = require(join(__dirname, "..", "hooks", "scripts", "posttoolfail-capture.js"));

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

// ---------------------------------------------------------------------------
// (a) 2026-07-02 — fix del falso positivo HTTP-status-como-exit-code.
// El bug real: WebFetch devuelve `code: 200` (status HTTP) y el detector lo leia
// como exit code != 0 -> 4 copias de "Error en WebFetch: tool exit code 200"
// llegaron a brain.db como memorias activas.
// ---------------------------------------------------------------------------

// `code` en una tool NO-shell es un status HTTP, no un exit code -> null.
const e6 = detectError({ tool_name: "WebFetch", tool_response: { code: 200 } });
A(e6 === null, "WebFetch code:200 -> null (no es un error)", JSON.stringify(e6));

// Ni siquiera un status de fallo HTTP se trata como exit code a ciegas: sin
// is_error/error explicito del harness, un `code` suelto no-shell no se captura.
const e7 = detectError({ tool_name: "WebFetch", tool_response: { code: 404 } });
A(e7 === null, "WebFetch code:404 suelto -> null (conservador)", JSON.stringify(e7));

// En tools de shell, `code` SI es exit code (comportamiento previo preservado).
const e8 = detectError({ tool_name: "Bash", tool_response: { code: 1, stderr: "cmd not found" } });
A(e8 === "cmd not found", "Bash code:1 -> sigue detectandose", JSON.stringify(e8));

// `exit_code` explicito se respeta en cualquier tool (nombre inequivoco).
const e9 = detectError({ tool_name: "WebFetch", tool_response: { exit_code: 3, stderr: "net fail" } });
A(e9 === "net fail", "exit_code explicito -> detectado aun sin ser shell", JSON.stringify(e9));

// ---------------------------------------------------------------------------
// (a) 2026-07-02 — gate de informatividad + contexto del input en la captura.
// Una memoria "tool exit code 1" sin stderr ni contexto no ayuda a nadie.
// ---------------------------------------------------------------------------

A(typeof buildCandidate === "function", "buildCandidate exportado", typeof buildCandidate);

// Fallo real pero SIN sustancia (solo el marcador generico) -> no se propone.
const c1 = buildCandidate && buildCandidate({ tool_name: "Bash", tool_response: { is_error: true } });
A(c1 === null, "fallo generico sin detalle -> null (gate de informatividad)", JSON.stringify(c1));

// Fallo informativo -> candidato con QUE se intento (input=) y QUE fallo (error=).
const c2 = buildCandidate && buildCandidate({
  tool_name: "Bash",
  tool_input: { command: "npm run biuld" },
  tool_response: { code: 1, stderr: "npm ERR! missing script: biuld" },
});
A(!!c2 && c2.content.includes("input=npm run biuld"), "candidato incluye el input que fallo", JSON.stringify(c2));
A(!!c2 && c2.content.includes("npm ERR! missing script"), "candidato incluye el error real", JSON.stringify(c2));
A(!!c2 && c2.summary.includes("npm run biuld"), "summary lleva el gist del input", JSON.stringify(c2));

// Exito -> null tambien via buildCandidate (paridad con detectError).
const c3 = buildCandidate && buildCandidate({ tool_name: "Read", tool_response: { content: "ok" } });
A(c3 === null, "exito -> buildCandidate null", JSON.stringify(c3));

// ---------------------------------------------------------------------------
// Provenance episodica (feedback 2026-07-02): el candidato lleva la sesion de
// origen (emit.rs la mapea a source_session_id; `provenance --id` la resuelve
// al transcript real). Caso negativo: sin session_id en el payload -> null,
// no se inventa procedencia.
// ---------------------------------------------------------------------------

const c4 = buildCandidate && buildCandidate({
  tool_name: "Bash",
  session_id: "1a333f26-3721-4b76-b975-7e9dbbab15a7",
  tool_input: { command: "cargo build" },
  tool_response: { code: 101, stderr: "error[E0308]: mismatched types" },
});
A(!!c4 && c4.session_id === "1a333f26-3721-4b76-b975-7e9dbbab15a7",
  "candidato lleva session_id (provenance episodica)", JSON.stringify(c4));

const c5 = buildCandidate && buildCandidate({
  tool_name: "Bash",
  tool_input: { command: "cargo build" },
  tool_response: { code: 101, stderr: "error[E0308]: mismatched types" },
});
A(!!c5 && c5.session_id === null,
  "sin session_id en payload -> null (no se inventa origen)", JSON.stringify(c5));

console.log(fail === 0 ? "\nSELFTEST 3.9 (posttoolfail): VERDE" : `\nSELFTEST 3.9 (posttoolfail): ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
