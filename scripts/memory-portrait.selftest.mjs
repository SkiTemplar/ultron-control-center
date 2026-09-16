/**
 * memory-portrait.selftest.mjs — fusión del retrato y parseo de la salida del
 * modelo (partes puras de memory-portrait.mjs; no llama a claude ni a brain.db).
 *
 * Uso: node scripts/memory-portrait.selftest.mjs   (exit 0 = verde)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergePortrait, parseModelJson, claimId, buildPrompt, isFresh, readMemoryFiles, BLOCKS } from './memory-portrait.mjs';

let fail = 0;
const A = (c, n, d) => {
  if (c) console.log(`  [PASS] ${n}`);
  else {
    fail++;
    console.log(`  [FAIL] ${n}\n         -> ${d}`);
  }
};
const meta = { generatedAt: '2026-09-16T00:00:00.000Z', model: 'sonnet', stats: {} };

// parseModelJson tolera vallas de código y texto alrededor; falla sin JSON.
A(parseModelJson('```json\n{"resumen":"x"}\n```').resumen === 'x', 'parse: JSON con vallas', '');
let lanzo = false;
try {
  parseModelJson('sin json');
} catch {
  lanzo = true;
}
A(lanzo, 'parse NEGATIVO: sin objeto JSON lanza error', '');

// Fusión: ids estables, duplicados fuera, todos los bloques presentes.
const raw = {
  resumen: 'Estudiante',
  bloques: [{ id: 'quien_es', afirmaciones: [{ texto: 'Estudia informática', fuentes: ['mem:1'] }, { texto: 'estudia informática ', fuentes: [] }] }],
  opinion: 'o',
  trato: 't',
};
const p1 = mergePortrait(raw, null, meta);
A(p1.bloques.length === BLOCKS.length, 'merge: devuelve todos los bloques aunque el modelo omita alguno', `${p1.bloques.length}`);
const quien = p1.bloques.find((b) => b.id === 'quien_es');
A(quien.afirmaciones.length === 1 && quien.afirmaciones[0].id === claimId('Estudia informática'), 'merge: deduplica por texto normalizado con id estable', JSON.stringify(quien));

// Marcas: confirmada que el modelo omite se conserva; descartada no vuelve.
const previous = {
  bloques: [
    { id: 'quien_es', afirmaciones: [
      { id: claimId('Estudia informática'), texto: 'Estudia informática', fuentes: [], estado: 'discarded' },
      { id: claimId('Hace el TFG'), texto: 'Hace el TFG', fuentes: ['mem:2'], estado: 'confirmed' },
    ] },
  ],
};
const p2 = mergePortrait(raw, previous, meta);
const q2 = p2.bloques.find((b) => b.id === 'quien_es').afirmaciones;
A(!q2.some((a) => a.texto === 'Estudia informática'), 'merge: una afirmación descartada no reaparece', JSON.stringify(q2));
A(q2.some((a) => a.texto === 'Hace el TFG' && a.estado === 'confirmed'), 'merge: una confirmada se conserva aunque el modelo la omita', JSON.stringify(q2));

// El prompt lleva las marcas y las fuentes.
const prompt = buildPrompt({ memories: [{ id: 'abc', type: 'preference', title: 'T', summary: 'S' }], files: [], previous });
A(prompt.includes('[mem:abc]') && prompt.includes('DESCARTADA') && prompt.includes('CONFIRMADA'), 'prompt: incluye fuentes y marcas del usuario', '');

// Frescura por mtime y lectura de ficheros solo user/feedback.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portrait-test-'));
const f = path.join(tmp, 'p.json');
A(!isFresh(f, 7), 'isFresh NEGATIVO: fichero inexistente no está fresco', '');
fs.writeFileSync(f, '{}');
A(isFresh(f, 7), 'isFresh: fichero recién escrito está fresco', '');
const memDir = path.join(tmp, 'proj', 'memory');
fs.mkdirSync(memDir, { recursive: true });
fs.writeFileSync(path.join(memDir, 'a.md'), '---\nname: a\nmetadata:\n  type: feedback\n---\nCuerpo A');
fs.writeFileSync(path.join(memDir, 'b.md'), '---\nname: b\nmetadata:\n  type: project\n---\nCuerpo B');
fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- índice');
const files = readMemoryFiles(tmp);
A(files.length === 1 && files[0].text === 'Cuerpo A', 'readMemoryFiles: solo user/feedback, sin índice', JSON.stringify(files));
fs.rmSync(tmp, { recursive: true, force: true });

console.log(fail ? `\nSELFTEST memory-portrait: ROJO (${fail})` : '\nSELFTEST memory-portrait: VERDE');
process.exit(fail ? 1 : 0);
