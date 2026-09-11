/**
 * research-ranking.selftest.mjs — check hermetico (sin red, sin daemon) del
 * ranking por RELEVANCIA de merge.js::rankAndFilter, con 3 queries
 * etiquetadas a mano sobre datos reales de OpenAlex/Semantic Scholar
 * (__fixtures__/ranking-cases.json). Reproduce el bug reportado (un survey
 * generico muy citado tapando al paper pertinente) y el caso negativo (una
 * consulta sin relacion no debe inventar relevancia). RESEARCH_DISABLE_SEMANTIC
 * fuerza el camino sin daemon: el pool de 2 papers por caso ya cae bajo el
 * umbral minimo de dispersion (ver merge.js::embedCandidates), pero se
 * desactiva explicitamente para no depender de ese detalle interno.
 * Uso: node hooks/scripts/research-ranking.selftest.mjs   (exit 0 = verde)
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.RESEARCH_DISABLE_SEMANTIC = '1';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LIB = join(__dirname, 'lib', 'research');

const { rankAndFilter, lexicalMatch } = require(join(LIB, 'merge.js'));
const { cases } = require(join(LIB, '__fixtures__', 'ranking-cases.json'));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

function byId(list, doi) {
  return list.find((p) => p.doi === doi);
}

async function main() {
  // --- casos A y B: el paper pertinente debe superar al survey generico -----
  for (const c of cases.filter((c) => c.genericSurveyDoi && c.pertinentDoi !== null)) {
    const { results: ranked } = await rankAndFilter(c.papers, { query: c.query });
    const pertinent = byId(ranked, c.pertinentDoi);
    const survey = byId(ranked, c.genericSurveyDoi);
    A(pertinent.rankScore > survey.rankScore, `[${c.id}] el paper pertinente supera al survey generico muy citado`, `pertinente=${pertinent.rankScore.toFixed(3)} survey=${survey.rankScore.toFixed(3)}`);
    A(ranked[0].doi === c.pertinentDoi, `[${c.id}] el pertinente queda en el top (aqui, top-1 de 2)`, ranked[0].doi);
  }

  // caso B: el pertinente no tiene DOI (viene solo de Semantic Scholar) -> se localiza por titulo
  {
    const c = cases.find((x) => x.id === 'B-sim-to-real-object-detection');
    const { results: ranked } = await rankAndFilter(c.papers, { query: c.query });
    const pertinent = ranked.find((p) => p.doi === null);
    const survey = byId(ranked, c.genericSurveyDoi);
    A(pertinent.rankScore > survey.rankScore, '[B] "Bridging the Sim-to-Real Gap..." (solo S2, sin DOI) supera al survey generico', `pertinente=${pertinent.rankScore.toFixed(3)} survey=${survey.rankScore.toFixed(3)}`);
    A(ranked[0] === pertinent, '[B] el pertinente queda #1, el survey generico NO por encima', JSON.stringify(ranked.map((p) => p.title)));
  }

  // --- caso C: consulta sin relacion -> no se inventa relevancia ------------
  {
    const c = cases.find((x) => x.id === 'C-sin-coincidencias');
    const { results: ranked, warnings } = await rankAndFilter(c.papers, { query: c.query });
    A(ranked.every((p) => p.rankScore === 0), '[C] sin relevance_score/rank/lexico/citas/semantico -> rankScore exactamente 0 (nada inventado)', JSON.stringify(ranked.map((p) => p.rankScore)));
    A(warnings.some((w) => w.includes('semantico')), '[C] avisa explicitamente que el semantico no aporto senal (RESEARCH_DISABLE_SEMANTIC)', JSON.stringify(warnings));
    for (const p of c.papers) {
      const lex = lexicalMatch(c.query, p);
      A(lex.score === 0, `[C] lexicalMatch da 0 para "${p.title.slice(0, 30)}..." (sin terminos en comun con la query)`, JSON.stringify(lex));
    }
  }

  // --- lexicalMatch: unidad directa ------------------------------------------
  const droneRacing = cases[0].papers[0];
  A(lexicalMatch('domain randomization synthetic images drone detection', droneRacing).exactPhrase === null, 'lexicalMatch: frase completa no aparece literal (no inventa un match que no existe)', 'ok');
  A(lexicalMatch('domain randomization', droneRacing).exactPhrase === 'titulo', 'lexicalMatch: detecta frase exacta "domain randomization" en el titulo', 'ok');
  A(lexicalMatch('', droneRacing).score === 0, 'lexicalMatch: query vacia -> score 0 explicito (total=0, no NaN)', JSON.stringify(lexicalMatch('', droneRacing)));

  console.log(fail === 0 ? '\nSELFTEST RESEARCH-RANKING: VERDE' : `\nSELFTEST RESEARCH-RANKING: ROJO (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
