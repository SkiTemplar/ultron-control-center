#!/usr/bin/env node
// Copia y borra el índice temporal de ultron-checkpoint. El entorno de los mods
// no puede borrar ficheros ni copiar binarios, así que lo hace este proceso.
//   node indice.cjs copy <origen> <destino>   copia el índice real (si no existe, no hace nada)
//   node indice.cjs remove <ruta>...          borra el índice temporal y su .lock (los que no existan se ignoran)
'use strict'

const fs = require('node:fs')

const [op, ...paths] = process.argv.slice(2)
const [a, b] = paths

try {
  if (op === 'copy' && a && b) {
    if (fs.existsSync(a)) fs.copyFileSync(a, b)
  } else if (op === 'remove' && a) {
    for (const p of paths) fs.rmSync(p, { force: true })
  } else {
    process.stderr.write('uso: indice.cjs copy <origen> <destino> | remove <ruta>\n')
    process.exit(2)
  }
} catch (err) {
  process.stderr.write(`${err && err.message ? err.message : String(err)}\n`)
  process.exit(1)
}
