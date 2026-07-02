/**
 * memory-bench.selftest.mjs — check hermético del EVALUADOR del benchmark
 * externo de memoria (masterplan (b), feedback 2026-07-02).
 *
 * No toca brain.db ni el sidecar: alimenta evaluateQuery/scanSecrets con
 * resultados sintéticos y verifica cada tipo de expectativa CON caso negativo
 * (mandamiento 7). Falla SIN el harness (módulo ausente o contrato roto).
 *
 * Uso: node scripts/memory-bench.selftest.mjs   (exit 0 = verde)
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

let evaluateQuery, scanSecrets;
try {
  ({ evaluateQuery, scanSecrets } = await import(
    pathToFileURL(join(__dirname, "memory-bench.mjs")).href
  ));
} catch (e) {
  ko("import de scripts/memory-bench.mjs", String(e && e.message));
  console.log(`\nSELFTEST memory-bench: ROJO (${fail} fallo/s)`);
  process.exit(1);
}

const entry = (summary, extra = {}) => ({
  title: extra.title || "t",
  summary,
  canonical_id: extra.id || "x",
  project_id: extra.project ?? null,
  dense_score: extra.dense ?? null,
  score: extra.score ?? 0.01,
});

// --- include_top3 ------------------------------------------------------------
const eIncl = [entry("el primary del router es groq"), entry("otra"), entry("otra mas"), entry("gemini en 4a posicion")];
let r = evaluateQuery({ expect: { include_top3: ["groq"] } }, { entries: eIncl, raw: "" });
A(r.pass === true, "include_top3: patron en top3 -> pass", JSON.stringify(r));
r = evaluateQuery({ expect: { include_top3: ["gemini en 4a"] } }, { entries: eIncl, raw: "" });
A(r.pass === false, "include_top3 NEGATIVO: patron solo en 4a -> fail", JSON.stringify(r));

// --- exclude_top3 ------------------------------------------------------------
r = evaluateQuery({ expect: { exclude_top3: ["9\\.31"] } }, { entries: [entry("la nota fue 9.31")], raw: "" });
A(r.pass === false, "exclude_top3 NEGATIVO: patron stale en top3 -> fail", JSON.stringify(r));
r = evaluateQuery(
  { expect: { exclude_top3: ["9\\.31"] } },
  { entries: [entry("a"), entry("b"), entry("c"), entry("la nota fue 9.31")], raw: "" },
);
A(r.pass === true, "exclude_top3: patron stale en 4a posicion -> pass", JSON.stringify(r));

// --- multihop_top8: cada patron presente y en >=2 entries distintas ----------
const hop1 = entry("recall denso usa E5-large 1024d");
const hop2 = entry("qdrant nativo vive en D:/Ultron/qdrant");
r = evaluateQuery({ expect: { multihop_top8: ["E5-large", "qdrant"] } }, { entries: [hop1, hop2], raw: "" });
A(r.pass === true, "multihop: 2 patrones en 2 entries -> pass", JSON.stringify(r));
r = evaluateQuery(
  { expect: { multihop_top8: ["E5-large", "1024d"] } },
  { entries: [hop1, entry("relleno")], raw: "" },
);
A(r.pass === false, "multihop NEGATIVO: ambos patrones en la MISMA entry -> fail", JSON.stringify(r));
r = evaluateQuery({ expect: { multihop_top8: ["E5-large", "inexistente"] } }, { entries: [hop1, hop2], raw: "" });
A(r.pass === false, "multihop NEGATIVO: patron ausente -> fail", JSON.stringify(r));

// --- abstain: DOS checks (confianza bajo floor + pack vacio) -------------------
// El read-path hoy NO tiene score-floor (P1 pendiente): el check "empty" debe
// salir rojo honesto mientras el sistema devuelva relleno para lo incontestable.
r = evaluateQuery({ expect: { abstain: true } }, { entries: [], raw: "" }, { floor: 0.845 });
A(r.pass === true, "abstain: 0 entries -> pass total", JSON.stringify(r));
r = evaluateQuery(
  { expect: { abstain: true } },
  { entries: [entry("irrelevante", { dense: 0.80 })], raw: "" },
  { floor: 0.845 },
);
A(r.pass === false, "abstain: dense bajo floor pero pack NO vacio -> fail parcial", JSON.stringify(r));
{
  const names = Object.fromEntries(r.checks.map((c) => [c.name, c.pass]));
  A(names.abstain_confidence === true, "abstain: check confianza (dense<floor) pasa", JSON.stringify(r.checks));
  A(names.abstain_empty === false, "abstain: check pack-vacio falla (sin floor en read-path)", JSON.stringify(r.checks));
}
r = evaluateQuery(
  { expect: { abstain: true } },
  { entries: [entry("confiado", { dense: 0.86 })], raw: "" },
  { floor: 0.845 },
);
{
  const names = Object.fromEntries(r.checks.map((c) => [c.name, c.pass]));
  A(
    r.pass === false && names.abstain_confidence === false && names.abstain_empty === false,
    "abstain NEGATIVO: dense sobre el floor -> ambos checks abstain fallan",
    JSON.stringify(r),
  );
}

// --- forbid_project ------------------------------------------------------------
r = evaluateQuery(
  { expect: { forbid_project: ["sairanskies"] } },
  { entries: [entry("weapon trail", { project: "sairanskies" })], raw: "" },
);
A(r.pass === false, "forbid_project NEGATIVO: fuga de otro proyecto -> fail", JSON.stringify(r));
r = evaluateQuery(
  { expect: { forbid_project: ["sairanskies"] } },
  { entries: [entry("hecho ambiente", { project: null }), entry("propio", { project: "bank" })], raw: "" },
);
A(r.pass === true, "forbid_project: solo ambiente + proyecto propio -> pass", JSON.stringify(r));

// --- scanSecrets ----------------------------------------------------------------
const leaks1 = scanSecrets('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh en el texto');
A(leaks1.length > 0, "scanSecrets caza ghp_", JSON.stringify(leaks1));
const leaks2 = scanSecrets('let k = "sk-abcdEFGH1234567890ijklmnopqrstuvwxyz1234"');
A(leaks2.length > 0, "scanSecrets caza sk-", JSON.stringify(leaks2));
const leaks3 = scanSecrets("texto normal sin credenciales, con skills y ski-pass");
A(leaks3.length === 0, "scanSecrets NEGATIVO: texto limpio -> 0", JSON.stringify(leaks3));

console.log(fail === 0 ? "\nSELFTEST memory-bench: VERDE" : `\nSELFTEST memory-bench: ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
