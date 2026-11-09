#!/usr/bin/env node
// hooks/scripts/tests/test-security-helpers.js
// Tests de redactSecrets: prefijos de proveedores habituales (Groq, Anthropic,
// Google, GitHub fine-grained, Supabase...) y texto normal intacto.
// Las claves se montan en tiempo de ejecucion: el fuente no lleva credenciales.
//
// Uso: node hooks/scripts/tests/test-security-helpers.js

'use strict';

const assert = require('assert');
const path = require('path');

const HELPERS = [
  path.join(__dirname, '..', 'lib', 'security-helpers.js'),
];

const TAIL = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const PREFIXES = ['gsk_', 'sk-ant-api03-', 'sk-proj-', 'AIzaSy', 'ghp_', 'github_pat_11', 'sbp_', 'hf_', 'xai-', 'npm_'];

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

for (const file of HELPERS) {
  const { redactSecrets } = require(file);
  const label = path.relative(path.join(__dirname, '..', '..', '..'), file).replace(/\\/g, '/');

  for (const prefix of PREFIXES) {
    run(`${label}: redacta ${prefix}`, () => {
      const out = redactSecrets(`401 invalid key ${prefix}${TAIL} (retry)`);
      assert.ok(!out.includes(prefix), `el prefijo escapa: ${out}`);
      assert.ok(out.includes('[REDACTED]'), out);
      assert.ok(out.endsWith(' (retry)'), out);
    });
  }

  run(`${label}: deja el texto normal y los prefijos sueltos`, () => {
    const t = 'usa gsk_ o hf_token en la doc; sbp_ y xai- sueltos';
    assert.strictEqual(redactSecrets(t), t);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
