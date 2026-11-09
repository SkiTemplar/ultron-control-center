/**
 * hardening-config.mjs - configuracion del delegador: `tiers.X.start` fuera de
 * `chain`, fichero del usuario frente a delegation.default.json y forma del
 * default versionado. Lo ejecuta hardening.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAFE_MODEL, ULTRON_HOME } from '../config.mjs';
import { BRIEF, CONFIG_JSON, ROOT, delegate, run } from './harness.mjs';

export async function configTests() {
  await run('tiers.X.start fuera de chain -> exit 3 con motivo claro (no arranca en chain[0])', () => {
    const cfg = join(ROOT, 'bad-tier.json');
    writeFileSync(cfg, JSON.stringify({ ...CONFIG_JSON, tiers: { ...CONFIG_JSON.tiers, trivial: { start: 'fantasma' } } }));
    const r = delegate(['run', '--tier', 'trivial', '--brief', BRIEF, '--no-check'], 'write', { ULTRON_DELEGATE_CONFIG: cfg });
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /tiers\.trivial\.start = "fantasma" no esta en chain/);
  });

  await run('sin config del usuario se lee delegation.default.json (no una copia en codigo)', () => {
    const def = join(ROOT, 'default.json');
    writeFileSync(def, JSON.stringify({ ...CONFIG_JSON, chain: ['oc'] }));
    const env = { ULTRON_DELEGATE_CONFIG: join(ROOT, 'no-existe.json'), ULTRON_DELEGATE_DEFAULT_CONFIG: def };
    const j = JSON.parse(delegate(['status', '--json'], 'write', env).out);
    assert.deepEqual([j.configSource, j.chain], ['default', ['oc']]);
    writeFileSync(def, '{ roto');
    const broken = delegate(['status', '--json'], 'write', env);
    assert.equal(broken.code, 3, broken.out);
    assert.match(broken.out, /configuracion por defecto no sirve/);
  });

  await run('delegation.default.json del repo: forma valida, modelos en la lista blanca y starts en chain', () => {
    const cfg = JSON.parse(readFileSync(join(ULTRON_HOME, 'cockpit', 'ai-router', 'delegation.default.json'), 'utf8'));
    assert.ok(Array.isArray(cfg.chain) && cfg.chain.length > 0);
    for (const [id, e] of Object.entries(cfg.engines)) {
      for (const m of [e.model, ...Object.values(e.tierModels || {})]) assert.match(m, SAFE_MODEL, `${id}: ${m}`);
    }
    for (const [tier, t] of Object.entries(cfg.tiers)) assert.ok(cfg.chain.includes(t.start), `${tier}: ${t.start}`);
  });
}
