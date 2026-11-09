#!/usr/bin/env node
// kirkardo/registry-lock.mjs — congelado de lo que permite subir la nota sin
// tocar el producto (auditoria 2026-11-01): ids de checks y su area, retiradas,
// pesos, superficies sin cubrir y suelos. kirkardo-eval.selftest.mjs compara el
// registro vivo con registry.lock.json: un cambio obliga a regenerar este fichero
// aparte, que queda visible en el diff de la revision.
//
// Alcance real: no impide el cambio, lo hace visible. Quien cambia el medidor
// puede regenerar el lock; el control es que alguien lea ese diff.
//
// Regenerar tras un cambio deliberado: node scripts/kirkardo/registry-lock.mjs --write

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LOCK_FILE = join(HERE, "registry.lock.json");
const FLOOR_RE = /\b(min(?:Passed|Tests|Total|Ok|Pass)|[A-Z_]+_FLOOR)\s*[:=]\s*(\d+)/g;

/** Suelos literales de un fuente, como lista ordenada de "nombre=valor". */
export function floorsIn(source) {
  return [...String(source ?? "").matchAll(FLOOR_RE)].map((m) => `${m[1]}=${m[2]}`).sort();
}

/** PURA. Fotografia comparable del registro. */
export function registrySnapshot({ cats, areas, areaOf, superseded, uncovered, floors }) {
  const checks = {};
  for (const c of [...cats].sort((a, b) => a.num - b.num)) {
    for (const k of c.checks) {
      checks[k.id] = {
        area: areaOf(k, c.num),
        ...(k.retiredBy ? { retiredBy: k.retiredBy } : {}),
        ...(k.onlyWhile ? { onlyWhile: k.onlyWhile } : {}),
        ...(k.auto && k.check ? {} : { manualByDesign: true }),
      };
    }
  }
  return {
    areas: Object.fromEntries(areas.map((a) => [a.id, a.weight])),
    superseded,
    uncovered_surfaces: uncovered.map((u) => u.surface).sort(),
    floors,
    checks,
  };
}

/** PURA. Diferencias entre el lock y el registro vivo, por ruta. */
export function snapshotDiff(locked, live, path = "") {
  if (JSON.stringify(locked) === JSON.stringify(live)) return [];
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(locked) || !isObj(live)) return [`${path}: ${JSON.stringify(locked)} -> ${JSON.stringify(live)}`];
  const keys = [...new Set([...Object.keys(locked), ...Object.keys(live)])];
  return keys.flatMap((k) => snapshotDiff(locked[k], live[k], path ? `${path}.${k}` : k));
}

/** Registro vivo: importa el harness (no ejecuta checks) y lee los suelos del disco. */
export async function liveSnapshot() {
  const imp = (rel) => import(pathToFileURL(join(HERE, rel)).href);
  await import(pathToFileURL(join(HERE, "..", "kirkardo-eval.mjs")).href);
  const { CATS } = await imp("core.mjs");
  const { AREAS, UNCOVERED_SURFACES, areaOf } = await imp("areas.mjs");
  const { SUPERSEDED } = await imp("decisions.mjs");
  const floors = Object.fromEntries(
    readdirSync(HERE)
      .filter((n) => /^cats-.*\.mjs$/.test(n))
      .sort()
      .map((n) => [n, floorsIn(readFileSync(join(HERE, n), "utf8"))])
      .filter(([, list]) => list.length > 0),
  );
  return registrySnapshot({ cats: CATS, areas: AREAS, areaOf, superseded: SUPERSEDED, uncovered: UNCOVERED_SURFACES, floors });
}

const IS_MAIN = !!process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (IS_MAIN) {
  if (!process.argv.includes("--write")) {
    process.stderr.write("uso: node scripts/kirkardo/registry-lock.mjs --write\n");
    process.exit(2);
  }
  writeFileSync(LOCK_FILE, `${JSON.stringify(await liveSnapshot(), null, 1)}\n`, "utf8");
  process.stdout.write(`escrito ${LOCK_FILE}\n`);
}
