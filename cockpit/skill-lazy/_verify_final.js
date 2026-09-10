'use strict';
/**
 * Baseline routing regression guard for the skill/agent/persona dispatcher.
 *
 * Historicamente este script tambien verificaba la re-inyeccion "Option B" de
 * skills del plugin ECC (scanEccSkills/matchBestEccSkill/parseEccSkillTokens).
 * Ese subsistema se retiro (F2.5, 2026-09-10): el cache del plugin ECC del que
 * dependia (~/.claude/plugins/cache/ecc/) ya no existe, asi que el indice
 * estaba siempre vacio en produccion y el lookup era codigo muerto. Solo
 * queda el guard de regresion del routing base.
 */

const dispatcher = require('./routing-dispatcher.v2.js');

let passed = 0;
let failed = 0;

function assert(label, condition, extra) {
  if (condition) {
    console.log('  PASS:', label);
    passed++;
  } else {
    console.log('  FAIL:', label, extra !== undefined ? ('-> ' + JSON.stringify(extra)) : '');
    failed++;
  }
}

// ─────────────────────────────────────────────────────────
// 1. BASELINE ROUTING (rankCandidates must not regress)
// ─────────────────────────────────────────────────────────
console.log('\n=== 1. Baseline routing (regression guard) ===');

const BASELINE = [
  { prompt: 'arregla typescript en react',      expectedId: 'typescript-pro',                   expectedKind: 'agent'   },
  { prompt: 'activa don claudio',               expectedId: 'don-claudio',                      expectedKind: 'persona' },
  { prompt: 'optimiza memoria rust',            expectedId: 'rust-engineer',                    expectedKind: 'agent'   },
  { prompt: 'tdd con pytest para mi api',       expectedId: 'superpowers:test-driven-development', expectedKind: 'plugin' },
  { prompt: 'security scan del repositorio',    expectedId: 'security-scan',                    expectedKind: 'plugin'  },
];

for (const tc of BASELINE) {
  const ranked = dispatcher.rankCandidates(tc.prompt);
  const top = ranked[0] || null;
  assert(
    `"${tc.prompt}" -> ${tc.expectedKind}:${tc.expectedId}`,
    top && top.id === tc.expectedId && top.kind === tc.expectedKind,
    top ? { id: top.id, kind: top.kind, conf: Math.round(top.confidence * 100) + '%' } : 'no match'
  );
}

// ─────────────────────────────────────────────────────────
// 2. rankCandidates nunca produce entradas prefijadas "ecc:" — guard de
//    regresion generico: ningun candidato deberia usar ese prefijo ahora
//    que el subsistema ECC no existe.
// ─────────────────────────────────────────────────────────
console.log('\n=== 2. rankCandidates output has no ecc-prefixed entries ===');

const ranked = dispatcher.rankCandidates('make an autonomous claude code loop');
const eccInMain = ranked.some(c => c.id && c.id.startsWith('ecc:'));
assert('No ecc: prefixed entry in rankCandidates result', !eccInMain, ranked.slice(0, 3).map(c => c.id));

// ─────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────
console.log('\n=== Summary ===');
console.log('  Passed:', passed);
console.log('  Failed:', failed);
process.exitCode = failed > 0 ? 1 : 0;
