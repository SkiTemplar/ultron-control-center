'use strict';
/**
 * _accuracy_at3.js — Reproducible accuracy@1 / accuracy@3 harness for the
 * deterministic skill/agent/persona router (rankCandidates in v2, reused by v3).
 *
 * It runs a small labelled set of representative prompts (ES + EN) through
 * rankCandidates() and reports:
 *   - accuracy@1: fraction of prompts where the expected id is the top result.
 *   - accuracy@3: fraction where the expected id is among the top 3.
 *
 * It prints the percentages and an itemized list of failures (with what the
 * router actually returned in the top 3) so regressions are diagnosable.
 *
 * This harness is READ-ONLY: it never mutates routing rules. It exercises the
 * SAME deterministic engine the live hook uses, so its numbers track the real
 * routing accuracy of the dispatcher. Exit code 0 if accuracy@3 == 100%, else 1.
 *
 * Run:  node cockpit/skill-lazy/_accuracy_at3.js
 */

const router = require('./routing-dispatcher.v3.js');

/**
 * Labelled evaluation set. Each case: { prompt, expectedId }.
 * Mix of Spanish + English, across personas / plugins / agents.
 * Expected ids reference the canonical ids in the v2 PERSONAS/PLUGINS/AGENTS tables.
 * @type {Array<{prompt: string, expectedId: string, lang: string}>}
 */
const CASES = [
  // --- Personas (ES) ---
  { prompt: 'activa don claudio para el netcode de ue5',          expectedId: 'don-claudio',     lang: 'ES' },
  { prompt: 'tio gilito, anade un gasto a mi presupuesto',        expectedId: 'tio-gilito',      lang: 'ES' },
  { prompt: 'modo tolkien, escribe el siguiente capitulo',        expectedId: 'tolkien',         lang: 'ES' },
  { prompt: 'jordan, necesito un pitch para inversores b2b',      expectedId: 'jordan-belfort',  lang: 'ES' },
  { prompt: 'mike tyson, revisa la jerarquia visual del landing', expectedId: 'mike-tyson',      lang: 'ES' },
  { prompt: 'alfred, mata el proceso y limpia la carpeta local',  expectedId: 'alfred',          lang: 'ES' },

  // --- Agents (ES) ---
  { prompt: 'arregla los tipos de typescript en este componente react', expectedId: 'typescript-pro', lang: 'ES' },
  { prompt: 'optimiza el uso de memoria en rust con tokio',       expectedId: 'rust-engineer',   lang: 'ES' },
  { prompt: 'audita la seguridad: posible sql injection y owasp', expectedId: 'security-auditor', lang: 'ES' },
  { prompt: 'tengo un stack trace y un panic, encuentra la causa raiz', expectedId: 'debugger',  lang: 'ES' },

  // --- Plugins / skills (ES) ---
  { prompt: 'haz tdd con red green refactor antes de implementar', expectedId: 'superpowers:test-driven-development', lang: 'ES' },
  { prompt: 'haz un security scan del repositorio buscando cve',   expectedId: 'security-scan',   lang: 'ES' },
  { prompt: 'consolida memoria y ordena el index de .ultron',      expectedId: 'consolidate-memory', lang: 'ES' },

  // --- Agents / plugins (EN) ---
  { prompt: 'revisa el pr buscando problemas de calidad de codigo', expectedId: 'pr-review-toolkit:code-reviewer', lang: 'ES' },
  { prompt: 'review this pull request for code quality issues',    expectedId: 'code-reviewer', lang: 'EN' },
  { prompt: 'profile the hot path, there is an n+1 query bottleneck', expectedId: 'performance-engineer', lang: 'EN' },
  { prompt: 'design a kubernetes helm chart for the cluster',      expectedId: 'kubernetes-specialist', lang: 'EN' },
  { prompt: 'write a rag pipeline with a vector db and embeddings', expectedId: 'ai-engineer',    lang: 'EN' },
  { prompt: 'set up a github actions ci cd pipeline',              expectedId: 'devops-engineer', lang: 'EN' },
  { prompt: 'merge a postgresql schema migration with zero-downtime', expectedId: 'database-migrations', lang: 'EN' },
  { prompt: 'systematic debugging, I cannot find the intermittent bug', expectedId: 'superpowers:systematic-debugging', lang: 'EN' },
];

const TOP_K = 3;

let hitsAt1 = 0;
let hitsAt3 = 0;
const failures = [];

for (const tc of CASES) {
  const ranked = router.rankCandidates(tc.prompt) || [];
  const topIds = ranked.slice(0, TOP_K).map(function (c) { return c.id; });

  const at1 = topIds[0] === tc.expectedId;
  const at3 = topIds.indexOf(tc.expectedId) !== -1;

  if (at1) hitsAt1++;
  if (at3) hitsAt3++;

  if (!at3) {
    failures.push({
      lang: tc.lang,
      prompt: tc.prompt,
      expected: tc.expectedId,
      got_top3: ranked.slice(0, TOP_K).map(function (c) {
        return c.id + '(' + c.kind + ',' + Math.round((c.confidence || 0) * 100) + '%)';
      }),
    });
  }
}

const total = CASES.length;
const pct = function (n) { return ((n / total) * 100).toFixed(1) + '%'; };

console.log('=== accuracy@3 harness (deterministic router) ===');
console.log('  cases     :', total, '(ES:', CASES.filter(function (c) { return c.lang === 'ES'; }).length,
  '/ EN:', CASES.filter(function (c) { return c.lang === 'EN'; }).length + ')');
console.log('  accuracy@1:', pct(hitsAt1), '(' + hitsAt1 + '/' + total + ')');
console.log('  accuracy@3:', pct(hitsAt3), '(' + hitsAt3 + '/' + total + ')');

if (failures.length > 0) {
  console.log('\n=== failures (' + failures.length + ') ===');
  for (const f of failures) {
    console.log('  [' + f.lang + '] "' + f.prompt + '"');
    console.log('       expected:', f.expected);
    console.log('       got top3:', JSON.stringify(f.got_top3));
  }
} else {
  console.log('\n  no failures — all cases hit within top 3.');
}

// Non-zero exit only if any case missed the top-3 window.
process.exitCode = hitsAt3 === total ? 0 : 1;
