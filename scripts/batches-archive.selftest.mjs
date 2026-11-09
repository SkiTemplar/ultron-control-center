// Selftest de scripts/batches-archive.mjs: mueve, no borra, y solo deja en la
// cola lo que la regla de batch-capture sigue cubriendo. Hermetico (temp dir).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { plan, apply } from './batches-archive.mjs';

let fallos = 0;
function comprueba(nombre, real, esperado) {
  if (real === esperado) console.log(`ok     ${nombre}`);
  else {
    fallos++;
    console.error(`FALLO  ${nombre}\n       esperado=${esperado} real=${real}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batches-archive-'));
try {
  const s = (n) => `queued-${String(n).repeat(12).slice(0, 12)}.ps1`;
  fs.writeFileSync(path.join(dir, s(1)), 'x');
  fs.writeFileSync(path.join(dir, s(2)), 'x');
  fs.writeFileSync(path.join(dir, 'mio.ps1'), 'script del usuario');
  const lineas = [
    { name: s(1), reason: 'rejected' },
    { name: s(2), reason: 'failed' },
    { name: s(3), reason: 'rejected' }, // su .ps1 ya no existe
  ].map((o) => JSON.stringify(o));
  fs.writeFileSync(path.join(dir, 'queue-pending.jsonl'), lineas.join('\n') + '\nno-json\n');

  const p = plan(dir);
  comprueba('se queda el rechazado con script', p.keep.length, 1);
  comprueba('al archivo el failed, el huerfano y la linea rota', p.archive.length, 3);
  comprueba('solo el .ps1 del failed va al archivo', p.scripts.join(','), s(2));

  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'batches-archive.mjs');
  const dry = spawnSync(process.execPath, [cli, '--dir', dir, '--dry-run'], { encoding: 'utf8' });
  comprueba('dry-run sale con 0', dry.status, 0);
  comprueba('dry-run no mueve nada', fs.existsSync(path.join(dir, s(2))), true);

  const dest = apply(dir, p, 'sello');
  comprueba('el failed se mueve al archivo', fs.existsSync(path.join(dest, s(2))), true);
  comprueba('el rechazado se queda', fs.existsSync(path.join(dir, s(1))), true);
  comprueba('los scripts del usuario no se tocan', fs.existsSync(path.join(dir, 'mio.ps1')), true);
  const resto = fs.readFileSync(path.join(dir, 'queue-pending.jsonl'), 'utf8').trim().split('\n');
  comprueba('la cola queda con una linea', resto.length, 1);
  const archivadas = fs.readFileSync(path.join(dest, 'queue-pending.jsonl'), 'utf8').trim().split('\n');
  comprueba('nada se pierde: 1 + 3 = 4 lineas', resto.length + archivadas.length, 4);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo verde');
process.exit(fallos ? 1 : 0);
