/**
 * ai-text-warn.selftest.mjs — check conductual del hook PostToolUse de aviso
 * de texto-IA (card pp97cd, 2026-08-13).
 *
 * Contrato: Write/Edit de prosa (.md/.tex/.txt/.rst) con señales del catálogo
 * patrones-texto-ia.json → additionalContext con patrón+señal+corrección.
 * Texto humano limpio, extensión no-prosa o ruta excluida → stdout VACÍO
 * (silencio total, jamás bloquea).
 *
 * Usa el catálogo REAL del repo (docs/research/patrones-texto-ia.json) — es
 * fuente versionada y determinista, no un fixture sintético.
 *
 * Uso: node hooks/scripts/ai-text-warn.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, "ai-text-warn.js");

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

function fire(toolName, filePath, text) {
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolName === "Write"
      ? { file_path: filePath, content: text }
      : { file_path: filePath, old_string: "x", new_string: text },
  });
  const r = spawnSync("node", [HOOK], { input: payload, encoding: "utf8", timeout: 15000 });
  return { stdout: (r.stdout || "").trim(), status: r.status, stderr: r.stderr || "" };
}

// --- Caso 1 (POSITIVO): prosa .md con señales inequívocas del catálogo -------
const dirty =
  "This chapter delves into the intricate tapestry of neural networks. " +
  "El componente desempeña un papel crucial en la arquitectura del sistema.";
const r1 = fire("Write", "C:/Users/test/tfg/capitulo-3.md", dirty);
A(r1.status === 0, "caso1: hook exit 0", `status=${r1.status} stderr=${r1.stderr}`);
A(
  /detector-IA/.test(r1.stdout) && /se\u00f1al/i.test(r1.stdout),
  "caso1: Write .md con delve/tapestry/papel-crucial -> AVISO al modelo",
  `stdout="${r1.stdout.slice(0, 200)}"`,
);
A(
  /PostToolUse/.test(r1.stdout) && /additionalContext/.test(r1.stdout),
  "caso1: el aviso viaja como hookSpecificOutput.additionalContext",
  r1.stdout.slice(0, 120),
);

// --- Caso 2 (NEGATIVO): prosa humana limpia -> silencio total ----------------
const clean =
  "Hoy he probado el parser con tres archivos rotos y ha fallado en el segundo. " +
  "Mañana miro por qué el buffer se queda corto cuando la línea pasa de 4KB.";
const r2 = fire("Write", "C:/Users/test/notas/diario.md", clean);
A(r2.status === 0, "caso2: hook exit 0", `status=${r2.status}`);
A(r2.stdout === "", "caso2: texto humano limpio -> stdout VACIO (cero ruido)", `stdout="${r2.stdout.slice(0, 120)}"`);

// --- Caso 3 (NEGATIVO): extension no-prosa -> silencio aunque haya señales ---
const r3 = fire("Write", "C:/Users/test/src/main.rs", "// this delves into the intricate tapestry");
A(r3.status === 0 && r3.stdout === "", "caso3: .rs (no prosa) -> silencio aunque el texto tenga señales", `stdout="${r3.stdout.slice(0, 120)}"`);

// --- Caso 4 (NEGATIVO): ruta excluida (memoria del asistente) -> silencio ----
const r4 = fire(
  "Write",
  "C:/Users/test/.claude/projects/x/memory/nota.md",
  "This delves into the intricate tapestry of memory systems.",
);
A(r4.status === 0 && r4.stdout === "", "caso4: memoria (.claude/projects) excluida -> silencio", `stdout="${r4.stdout.slice(0, 120)}"`);

// --- Caso 5 (POSITIVO): Edit con new_string sucio tambien avisa --------------
const r5 = fire("Edit", "C:/Users/test/tfg/capitulo-3.tex", "Esto pone de manifiesto el intrincado panorama actual, un testament vibrante.");
A(
  r5.status === 0 && /detector-IA/.test(r5.stdout),
  "caso5: Edit .tex con señales -> AVISO (analiza new_string)",
  `stdout="${r5.stdout.slice(0, 160)}"`,
);

// --- Caso 6 (NEGATIVO): instrucciones del asistente -> silencio --------------
// El catalogo esta calibrado para prosa academica; sobre CLAUDE.md marcaba la
// negrita Markdown como "artefacto sin adaptar al formato destino" (2026-08-14).
const r6 = fire("Edit", "C:/Users/test/.claude/CLAUDE.md", "Responder en **Español** — con tildes, delve, tapestry.");
A(r6.status === 0 && r6.stdout === "", "caso6: CLAUDE.md (instrucciones) excluido -> silencio", `stdout="${r6.stdout.slice(0, 120)}"`);

// --- Caso 7 (POSITIVO): un .md de verdad SIGUE vigilado ----------------------
// Guarda del caso 6: excluir por basename no puede apagar el detector en prosa.
const r7 = fire("Write", "C:/Users/test/tfg/memoria.md", "Este apartado delve en el tapestry de resultados y desempena un papel crucial.");
A(
  r7.status === 0 && /detector-IA/.test(r7.stdout),
  "caso7: .md de prosa normal -> SIGUE avisando",
  `stdout="${r7.stdout.slice(0, 160)}"`,
);

// --- Caso 8 (NEGATIVO): markup nativo de Markdown en un .md -> silencio ------
const r8 = fire("Write", "C:/Users/test/tfg/notas.md", "Este apartado es **importante** — y el siguiente **tambien** — segun el analisis.");
A(r8.status === 0 && r8.stdout === "", "caso8: .md con solo negrita/em-dash -> silencio (sintaxis del formato)", `stdout="${r8.stdout.slice(0, 160)}"`);

// --- Caso 9 (POSITIVO): el mismo texto en .tex SI es artefacto ---------------
// El filtro es SOLO para destino .md: en LaTeX la negrita Markdown delata copia-pega.
const r9 = fire("Write", "C:/Users/test/tfg/cap.tex", "Este apartado es **importante** — y el siguiente **tambien** — segun el analisis.");
A(
  r9.status === 0 && /detector-IA/.test(r9.stdout),
  "caso9: mismo texto en .tex -> SIGUE avisando (ahi si es artefacto)",
  `stdout="${r9.stdout.slice(0, 160)}"`,
);

// --- Caso 10 (GUARDA): los nombres a saltar existen en el catalogo -----------
// Sin esto, renombrar un patron en patrones-texto-ia.md dejaria el filtro como
// un no-op silencioso (mandamiento 11) y nadie se enteraria.
const { loadCatalog, patternKey, MARKDOWN_NATIVE_PATTERNS } = await import("./lib/ai-text-detector.js");
const catalogKeys = loadCatalog().map((p) => patternKey(p && p.nombre));
const huerfanos = MARKDOWN_NATIVE_PATTERNS.filter((s) => !catalogKeys.some((k) => k.includes(patternKey(s))));
A(
  huerfanos.length === 0,
  "caso10: los patrones a saltar en .md existen en el catalogo (no es un no-op)",
  `sin match en el catalogo: ${JSON.stringify(huerfanos)}`,
);

console.log(fail === 0 ? "\nSELFTEST ai-text-warn: VERDE" : `\nSELFTEST ai-text-warn: ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
