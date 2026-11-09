#!/usr/bin/env node
// batches-archive.mjs — archiva la cola de batch-capture acumulada (hooks-6,
// auditoria 2026-10-23).
//
// Hasta el 2026-10-23 batch-capture.js encolaba tambien los comandos que
// simplemente fallaban, y el desplegable "Ejecutar .bat" solo drenaba la cola
// al abrirse: queue-pending.jsonl acumulo 729 lineas desde julio (716
// 'failed') y ~300 queued-*.ps1. Este script MUEVE (no borra) esa cola a
// ~/.ultron/batches/archive/<sello>/ y deja en queue-pending.jsonl solo las
// lineas que la regla del hook sigue cubriendo (rejected, ai_cannot_execute)
// y cuyo .ps1 existe; esos .ps1 se quedan en su sitio.
//
// Uso:
//   node scripts/batches-archive.mjs --dry-run     cuenta lo que haria
//   node scripts/batches-archive.mjs               archiva
//   --dir <ruta>   carpeta de batches (por defecto ~/.ultron/batches)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEEP_REASONS = new Set(['rejected', 'ai_cannot_execute']);
const SCRIPT_RE = /^queued-[0-9a-f]{12}\.ps1$/i;

/** Lineas del pendiente separadas en las que se quedan y las que se archivan. */
export function splitPending(text, dir) {
  const keep = [];
  const archive = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let o = null;
    try {
      o = JSON.parse(line);
    } catch (_) {
      archive.push(line);
      continue;
    }
    const script = o && typeof o.name === 'string' ? path.join(dir, o.name) : '';
    if (KEEP_REASONS.has(o && o.reason) && script && fs.existsSync(script)) keep.push({ line, name: o.name });
    else archive.push(line);
  }
  return { keep, archive };
}

/** Plan de archivado (sin tocar disco). */
export function plan(dir) {
  const pendingPath = path.join(dir, 'queue-pending.jsonl');
  const text = fs.existsSync(pendingPath) ? fs.readFileSync(pendingPath, 'utf8') : '';
  const { keep, archive } = splitPending(text, dir);
  const kept = new Set(keep.map((k) => k.name.toLowerCase()));
  const scripts = fs.readdirSync(dir).filter((n) => SCRIPT_RE.test(n) && !kept.has(n.toLowerCase()));
  return { pendingPath, keep, archive, scripts };
}

/** Ejecuta el plan: mueve a archive/<sello>/ y reescribe el pendiente. */
export function apply(dir, p, stamp) {
  const dest = path.join(dir, 'archive', stamp);
  fs.mkdirSync(dest, { recursive: true });
  if (p.archive.length) fs.writeFileSync(path.join(dest, 'queue-pending.jsonl'), p.archive.join('\n') + '\n');
  for (const name of p.scripts) fs.renameSync(path.join(dir, name), path.join(dest, name));
  const rest = p.keep.map((k) => k.line);
  const tmp = p.pendingPath + '.tmp';
  fs.writeFileSync(tmp, rest.length ? rest.join('\n') + '\n' : '');
  fs.renameSync(tmp, p.pendingPath);
  return dest;
}

function main(argv) {
  const i = argv.indexOf('--dir');
  const dir = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(os.homedir(), '.ultron', 'batches');
  if (!fs.existsSync(dir)) {
    console.error(`No existe ${dir}`);
    return 1;
  }
  const p = plan(dir);
  console.log(`queue-pending: ${p.keep.length} se quedan, ${p.archive.length} al archivo; .ps1 al archivo: ${p.scripts.length}`);
  if (argv.includes('--dry-run')) return 0;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  console.log(`Archivado en ${apply(dir, p, stamp)}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(main(process.argv.slice(2)));
}
