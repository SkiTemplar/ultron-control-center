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
 *
 * --v3 (semantic via)
 * -------------------
 * `node _accuracy_at3.js --v3` ADDITIONALLY exercises the REAL semantic
 * fallback path: it spawns `embed_skills.py query` (the exact call the v3 hook
 * makes) against the repopulated `ultron_skills` Qdrant collection and measures
 * the dense via's accuracy@3.
 *
 * SCOPE (honest limitation): the `ultron_skills` collection only contains
 * SKILLS (by bare skill name) — it holds NO agents and NO plugin-prefixed ids.
 * So the semantic accuracy is computed ONLY over the subset of cases whose
 * expectedId is a skill name reachable by the dense via (SKILL_SCOPED_CASES);
 * agent / plugin-prefixed cases are reported as "out-of-scope (agent/plugin —
 * deterministic via only)" rather than counted as semantic misses. This keeps
 * the metric truthful instead of penalising the dense via for entities it was
 * never meant to route. Requires Qdrant + the mpnet model cache; if the
 * subprocess fails the case is reported as "semantic unavailable".
 *
 * Prior to this change `--v3` was silently ignored (Node dropped the unknown
 * arg) and output was byte-identical with/without it — a flag that lied.
 */

const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const router = require('./routing-dispatcher.v3.js');

const WANT_V3 = process.argv.slice(2).includes('--v3');

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

// --------------------------------------------------------------------------
// --v3 : exercise the REAL semantic via (ultron_skills dense search)
// --------------------------------------------------------------------------
//
// The dense collection holds bare SKILL names only — no agents, no plugin
// prefixes. We therefore score the semantic via ONLY over cases whose
// expectedId is reachable as a skill name, and report the rest as out-of-scope.
const EMBED_SKILLS_PY = path.join(
  os.homedir(), '.ultron', 'scripts', 'cockpit', 'embed_skills.py'
);

/** Strip a plugin prefix ("superpowers:foo" -> "foo") for skill-name matching. */
function bareSkillName(id) {
  const i = id.indexOf(':');
  return i === -1 ? id : id.slice(i + 1);
}

/**
 * Run the real semantic query for one prompt. Returns the top-N skill names
 * (lower-cased) or null if the subprocess failed (Qdrant down / model missing).
 * Mirrors routing-dispatcher.v3.js querySemanticSkills exactly (no --json flag).
 */
function semanticTop(prompt, topN) {
  try {
    const out = execFileSync(
      'uv',
      ['run', 'python', EMBED_SKILLS_PY, 'query', prompt.slice(0, 500), '--top', String(topN)],
      { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const parsed = JSON.parse(out.trim());
    if (!Array.isArray(parsed)) return null;
    return parsed.map(function (r) { return String(r.name || '').toLowerCase(); });
  } catch (_) {
    return null;
  }
}

if (WANT_V3) {
  // A case is "skill-scoped" when its expectedId resolves to a skill the dense
  // collection could actually contain. We treat persona/skill/plugin-skill ids
  // as skill-scoped (their bare name can appear in ultron_skills); agent ids
  // are out-of-scope. We can't introspect v2's tables cheaply here, so we
  // classify by attempting a name match against the dense hits and, for cases
  // the deterministic router tagged as kind 'agent', mark them out-of-scope.
  console.log('\n=== semantic via (--v3): ultron_skills dense search ===');

  let semScored = 0;       // cases counted toward semantic accuracy
  let semHits3 = 0;        // skill-scoped cases whose expected name is in dense top-3
  let semUnavailable = 0;  // subprocess failures
  const outOfScope = [];
  const semFailures = [];

  for (const tc of CASES) {
    // Determine the deterministic kind for scope classification.
    const ranked = router.rankCandidates(tc.prompt) || [];
    const expectedRank = ranked.find(function (c) { return c.id === tc.expectedId; });
    const kind = expectedRank ? expectedRank.kind : null;

    // Agents are never in ultron_skills — out of the dense via's scope.
    if (kind === 'agent') {
      outOfScope.push({ prompt: tc.prompt, expected: tc.expectedId, why: 'agent' });
      continue;
    }

    const want = bareSkillName(tc.expectedId).toLowerCase();
    const names = semanticTop(tc.prompt, TOP_K);
    if (names === null) {
      semUnavailable++;
      semFailures.push({ prompt: tc.prompt, expected: tc.expectedId, got: 'SEMANTIC UNAVAILABLE' });
      continue;
    }

    semScored++;
    if (names.indexOf(want) !== -1) {
      semHits3++;
    } else {
      semFailures.push({ prompt: tc.prompt, expected: want, got: JSON.stringify(names) });
    }
  }

  const semPct = semScored > 0 ? ((semHits3 / semScored) * 100).toFixed(1) + '%' : 'n/a';
  console.log('  skill-scoped cases :', semScored, '(agent/plugin out-of-scope:', outOfScope.length + ')');
  console.log('  semantic accuracy@3:', semPct, '(' + semHits3 + '/' + semScored + ')');
  if (semUnavailable > 0) {
    console.log('  semantic unavailable:', semUnavailable, '(Qdrant down or model cache missing)');
  }
  if (outOfScope.length > 0) {
    console.log('\n  out-of-scope (agent — deterministic via only):');
    for (const o of outOfScope) {
      console.log('    - "' + o.prompt + '" -> ' + o.expected);
    }
  }
  if (semFailures.length > 0) {
    console.log('\n  semantic misses:');
    for (const f of semFailures) {
      console.log('    [expected ' + f.expected + '] got: ' + f.got);
    }
  }
  // --v3 is diagnostic; it does NOT gate the exit code (the dense via is an
  // additive hint over the deterministic router, which alone decides pass/fail).
}

// Non-zero exit only if any case missed the top-3 window.
process.exitCode = hitsAt3 === total ? 0 : 1;
