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
const { detectError, buildFailure, buildResolutionCandidate, inputSimilarity } = require(join(__dirname, "..", "hooks", "scripts", "posttoolfail-capture.js"));

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

A(typeof buildFailure === "function" && typeof buildResolutionCandidate === "function",
  "buildFailure y buildResolutionCandidate exportados", typeof buildFailure);

// Fallo real pero SIN sustancia (solo el marcador generico) -> no se aparca.
const f1 = buildFailure({ tool_name: "Bash", tool_response: { is_error: true } });
A(f1 === null, "fallo generico sin detalle -> null (gate de informatividad)", JSON.stringify(f1));

// Sonda de exploracion que falla -> no se aparca.
const f2 = buildFailure({ tool_name: "Bash", tool_input: { command: "ls nope" }, tool_response: { code: 2, stderr: "No such file" } });
A(f2 === null, "sonda ls fallida -> null", JSON.stringify(f2));

// Exito -> no es un fallo.
const f3 = buildFailure({ tool_name: "Read", tool_response: { content: "ok" } });
A(f3 === null, "exito -> buildFailure null", JSON.stringify(f3));

// ---------------------------------------------------------------------------
// SOLO FALLO + ARREGLO (2026-09-27): el candidato nace del acierto posterior de
// la misma tool con un input parecido, y lleva fallo, error y arreglo.
// ---------------------------------------------------------------------------

const bashFail = buildFailure({
  tool_name: "Bash",
  tool_input: { command: "cd app/src && cat components/PhotoFocus.tsx" },
  tool_response: { code: 1, stderr: "cd: app/src: No such file or directory" },
});
A(!!bashFail && bashFail.input.includes("PhotoFocus") && bashFail.error.includes("No such file"),
  "buildFailure guarda input y error", JSON.stringify(bashFail));

const SID = "1a333f26-3721-4b76-b975-7e9dbbab15a7";
const fix = {
  tool_name: "Bash",
  session_id: SID,
  tool_input: { command: "cat src/components/PhotoFocus.tsx" },
  tool_response: { code: 0, stdout: "..." },
};
const c1 = buildResolutionCandidate(bashFail, fix, bashFail.ts + 1000);
A(!!c1 && c1.content.includes("fallo=cd app/src") && c1.content.includes("arreglo=cat src/components/PhotoFocus.tsx"),
  "candidato lleva el input que fallo y el que funciono", JSON.stringify(c1));
A(!!c1 && c1.content.includes("error=cd: app/src"), "candidato lleva el error real", JSON.stringify(c1));
A(!!c1 && c1.type === "error_resolution" && c1.title === "Fallo de Bash resuelto",
  "tipo error_resolution y titulo de resolucion", JSON.stringify(c1));
A(!!c1 && c1.session_id === SID, "candidato lleva session_id (provenance episodica)", JSON.stringify(c1));

// Casos NEGATIVOS: nada de esto es un arreglo.
const otherTool = buildResolutionCandidate(bashFail, { ...fix, tool_name: "PowerShell" }, bashFail.ts + 1000);
A(otherTool === null, "acierto de otra tool -> null", JSON.stringify(otherTool));

const unrelated = buildResolutionCandidate(bashFail, { ...fix, tool_input: { command: "git status --short" } }, bashFail.ts + 1000);
A(unrelated === null, "comando sin parecido -> null", JSON.stringify(unrelated));

const retry = buildResolutionCandidate(bashFail, { ...fix, tool_input: { command: bashFail.input } }, bashFail.ts + 1000);
A(retry === null, "mismo input (reintento) -> null", JSON.stringify(retry));

const late = buildResolutionCandidate(bashFail, fix, bashFail.ts + 11 * 60 * 1000);
A(late === null, "acierto pasados 10 min -> null", JSON.stringify(late));

const noSid = buildResolutionCandidate(bashFail, { ...fix, session_id: undefined }, bashFail.ts + 1000);
A(!!noSid && noSid.session_id === null, "sin session_id en payload -> null (no se inventa origen)", JSON.stringify(noSid));

A(inputSimilarity("a b", "") === 0 && inputSimilarity("cat foo.ts", "cat foo.ts") === 1,
  "inputSimilarity: vacio 0, identico 1", "");

console.log(fail === 0 ? "\nSELFTEST 3.9 (posttoolfail): VERDE" : `\nSELFTEST 3.9 (posttoolfail): ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
