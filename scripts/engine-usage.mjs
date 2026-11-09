#!/usr/bin/env node
/**
 * engine-usage.mjs — uso de las suscripciones de Codex y agy (Gemini).
 *
 * Uso:
 *   node scripts/engine-usage.mjs            texto legible
 *   node scripts/engine-usage.mjs --json     JSON para la pestaña Uso (sesiones_engines_usage)
 *   node scripts/engine-usage.mjs --force    salta la caché de agy /usage
 *
 * La lógica vive en hooks/scripts/lib/engine-usage.js.
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readEngines, describeEngine } = require(path.join(import.meta.dirname, '..', 'hooks', 'scripts', 'lib', 'engine-usage.js'));

const args = new Set(process.argv.slice(2));
const result = readEngines({ force: args.has('--force') });
if (args.has('--json')) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  for (const e of result.engines) console.log(describeEngine(e, result.generatedAtMs).join('\n'));
}
