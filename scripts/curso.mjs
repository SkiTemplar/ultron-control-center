#!/usr/bin/env node
// curso.mjs — CLI del índice del curso académico (cockpit/curso.json).
// Uso: node scripts/curso.mjs [CODIGO]
// Imprime JSON con asignaturas por prioridad, proyectos enlazados y última actividad.

import { cursoStatus } from "./lib/curso.mjs";

try {
  const codigo = process.argv[2];
  process.stdout.write(JSON.stringify(cursoStatus({ codigo }), null, 2) + "\n");
} catch (e) {
  process.stderr.write(`[curso] ${e.message}\n`);
  process.exit(1);
}
