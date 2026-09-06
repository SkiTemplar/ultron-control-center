/**
 * score.mjs — agrega los votos ciegos y los cruza con la identidad del brazo.
 *
 * REGLA DE PUNTUACION
 *   voto a una propuesta -> acierto para TODOS los brazos que la propusieron
 *                           y fallo para los que propusieron otra cosa;
 *   voto "ninguna sirve" -> acierto para el brazo que se callo (abstenerse es
 *                           la respuesta correcta cuando no hay skill util) y
 *                           fallo para el que sugirio algo.
 *
 * Se reporta precision (de lo que propuso, cuanto acerto), cobertura (en
 * cuantos casos propuso) y utilidad (aciertos sobre el total de casos), que es
 * la unica que castiga por igual sugerir ruido y callarse cuando habia algo.
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = import.meta.dirname;
const { filas } = JSON.parse(fs.readFileSync(path.join(DIR, 'arms.json'), 'utf8'));
const votos = JSON.parse(fs.readFileSync(path.join(DIR, 'votes.json'), 'utf8'));
const BRAZOS = ['det', 'denso', 'juez'];
const NOMBRE = { det: 'determinista v2', denso: 'denso E5', juez: 'juez LLM' };

const m = Object.fromEntries(BRAZOS.map((b) => [b, { acierto: 0, fallo: 0, propuso: 0, callado_ok: 0, votados: 0 }]));
let silencioUnanime = 0, sinVoto = 0, ninguna = 0;

for (const f of filas) {
  if (!f.opciones.length) { silencioUnanime++; continue; }
  const voto = votos[f.id];
  if (!voto) { sinVoto++; continue; }
  if (voto === 'ninguna') ninguna++;
  const ganadora = f.opciones.find((o) => o.key === voto);
  for (const b of BRAZOS) {
    const propuso = f.brazos[b].skills.length > 0;
    m[b].votados++;
    if (propuso) m[b].propuso++;
    if (voto === 'ninguna') {
      if (propuso) m[b].fallo++; else { m[b].acierto++; m[b].callado_ok++; }
    } else if (ganadora && ganadora.brazos.includes(b)) {
      m[b].acierto++;
    } else {
      m[b].fallo++;
    }
  }
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1).padStart(5) + '%' : '    —');
const lat = (b) => { const a = filas.map((f) => f.brazos[b].ms).sort((x, y) => x - y); return `${a[Math.floor(a.length / 2)]}/${a[Math.floor(a.length * 0.95)]}`; };

console.log(`casos=${filas.length}  votados=${m.det.votados}  sin voto=${sinVoto}  silencio unanime=${silencioUnanime}  "ninguna sirve"=${ninguna}\n`);
console.log('brazo             utilidad   precision  cobertura  abstuvo-bien  p50/p95 ms');
for (const b of BRAZOS) {
  const x = m[b];
  console.log(
    NOMBRE[b].padEnd(16) +
    pct(x.acierto, x.votados) + '     ' +
    pct(x.acierto - x.callado_ok, x.propuso) + '     ' +
    pct(x.propuso, x.votados) + '      ' +
    String(x.callado_ok).padStart(3) + '           ' + lat(b),
  );
}
