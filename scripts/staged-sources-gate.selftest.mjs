#!/usr/bin/env node
// staged-sources-gate.selftest.mjs: el gate de pre-commit detecta fuente necesaria sin
// seguimiento y no da falsos positivos con lo ignorado a proposito.
// Hermetico: cada caso monta un repositorio git temporal; nunca lee el indice real.
// Uso: node scripts/staged-sources-gate.selftest.mjs   (exit 0 = verde)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cargoPathRefs, findGaps } from '../git-hooks/lib/staged-sources-gate.mjs';

let fail = 0;
const A = (cond, name, detail) => {
  if (cond) console.log(`  [PASS] ${name}`);
  else { fail++; console.log(`  [FAIL] ${name}\n         -> ${JSON.stringify(detail)}`); }
};

function repo(files, staged) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-gate-'));
  const run = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  run('init', '-q');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  if (staged.length) run('add', '--', ...staged);
  return root;
}

function gapsOf(files, staged, options) {
  const root = repo(files, staged);
  try {
    return findGaps(root, options);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const SES = 'control-center/src-tauri/src/sesiones';

// `mod x;`, el caso que rompia CI con `git add -u`.
const modGaps = gapsOf({ [`${SES}/mod.rs`]: 'pub mod relevo;\n', [`${SES}/relevo.rs`]: '' }, [`${SES}/mod.rs`]);
A(modGaps.length === 1 && modGaps[0].startsWith(`${SES}/relevo.rs`), 'mod declarado con el fuente sin seguimiento -> hueco', modGaps);
A(gapsOf({ [`${SES}/mod.rs`]: 'pub mod relevo;\n', [`${SES}/relevo.rs`]: '' }, [`${SES}/mod.rs`, `${SES}/relevo.rs`]).length === 0,
  'mod con su fuente en el indice -> verde', 'hueco inesperado');
A(gapsOf({ [`${SES}/mod.rs`]: 'mod x;\n', [`${SES}/x/mod.rs`]: '' }, [`${SES}/mod.rs`, `${SES}/x/mod.rs`]).length === 0,
  'mod resuelto por x/mod.rs -> verde', 'alternativa no reconocida');

// Modulo local a proposito: Finance esta en .gitignore.
const ignored = { '.gitignore': 'finance.rs\n', 'src/lib.rs': '#[cfg(feature = "finance")]\nmod finance;\n', 'src/finance.rs': '' };
A(gapsOf(ignored, ['.gitignore', 'src/lib.rs']).length === 0, 'mod ignorado por .gitignore -> verde', 'falso positivo');

// El gate mira el indice: una linea sin preparar no cuenta en el commit.
const partial = repo({ 'src/lib.rs': '' }, ['src/lib.rs']);
try {
  fs.writeFileSync(path.join(partial, 'src/lib.rs'), 'mod nuevo;\n');
  fs.writeFileSync(path.join(partial, 'src/nuevo.rs'), '');
  A(findGaps(partial).length === 0, 'cambio sin preparar -> el indice sigue verde', 'miro el disco');
  A(findGaps(partial, { worktree: true }).length === 1, '--worktree lo lista como pendiente de anadir', 'sin detectar');
} finally {
  fs.rmSync(partial, { recursive: true, force: true });
}

// Imports y require.
A(gapsOf({ 'scripts/a.mjs': "import { b } from './b.mjs';\n", 'scripts/b.mjs': '' }, ['scripts/a.mjs']).length === 1,
  'import relativo sin seguimiento -> hueco', 'sin detectar');
A(gapsOf({ 'hooks/a.js': "const b = require('./lib/b');\n", 'hooks/lib/b.js': '' }, ['hooks/a.js']).length === 1,
  'require sin extension sin seguimiento -> hueco', 'sin detectar');
A(gapsOf({ 'src/a.tsx': "import C from './c';\n", 'src/c.tsx': '' }, ['src/a.tsx']).length === 1,
  'import TSX sin extension sin seguimiento -> hueco', 'sin detectar');
A(gapsOf({ 'src/a.ts': "import type { T } from './t';\n", 'src/t.ts': '' }, ['src/a.ts']).length === 0,
  'import de tipo puro -> no cuenta (mismo criterio que el check 10.7)', 'falso positivo');
A(gapsOf({ 'src/a.ts': "import x from 'paquete';\n" }, ['src/a.ts']).length === 0, 'import de paquete -> no cuenta', 'falso positivo');

// [patch] a vendor/: el caso de tao.
const patch = '[patch.crates-io]\ntao = { path = "vendor/tao" }\n';
const crate = 'control-center/src-tauri';
const vendorFiles = { [`${crate}/Cargo.toml`]: patch, [`${crate}/vendor/tao/Cargo.toml`]: '' };
const patchGaps = gapsOf(vendorFiles, [`${crate}/Cargo.toml`]);
A(patchGaps.length === 1 && patchGaps[0].includes('vendor/tao/Cargo.toml'), '[patch] a vendor/ sin seguimiento -> hueco', patchGaps);
A(gapsOf(vendorFiles, [`${crate}/Cargo.toml`, `${crate}/vendor/tao/Cargo.toml`]).length === 0, '[patch] con vendor/ en el indice -> verde', 'falso positivo');
A(JSON.stringify(cargoPathRefs('a/Cargo.toml', '[[bin]]\nname = "x"\npath = "src/x.rs"\n[dependencies]\ny = { version = "1", path = "../y" }\n# path = "no"\n'))
  === JSON.stringify(['a/src/x.rs', 'y/Cargo.toml']), '[[bin]] apunta a fichero y una dependencia a carpeta; los comentarios no cuentan', 'parser de Cargo.toml');

// Manifiesto de selftests contra el indice.
const manifest = (tests) => JSON.stringify({ tests });
const man = 'scripts/selftests.manifest.json';
const stale = gapsOf({ [man]: manifest({ 'scripts/a.selftest.mjs': { ci: true } }), 'scripts/a.selftest.mjs': '' }, [man]);
A(stale.length === 1 && stale[0].includes('cita scripts/a.selftest.mjs'), 'manifiesto cita un selftest fuera del indice -> hueco', stale);
const loose = gapsOf({ [man]: manifest({}), 'scripts/a.selftest.mjs': '' }, [man, 'scripts/a.selftest.mjs']);
A(loose.length === 1 && loose[0].includes('sin clasificar'), 'selftest en el indice sin clasificar -> hueco', loose);
A(gapsOf({ [man]: manifest({ 'scripts/a.selftest.mjs': { ci: true } }), 'scripts/a.selftest.mjs': '' }, [man, 'scripts/a.selftest.mjs']).length === 0,
  'manifiesto y selftest en el indice -> verde', 'falso positivo');

console.log(fail === 0 ? '\nSELFTEST staged-sources-gate: VERDE' : `\nSELFTEST staged-sources-gate: ROJO (${fail})`);
process.exit(fail === 0 ? 0 : 1);
