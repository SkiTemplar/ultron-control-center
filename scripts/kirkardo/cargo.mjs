// kirkardo/cargo.mjs — `cargo test` con filtro para los checks de la ronda 2.
//
// Regla del medidor (2026-10-23): un check que ejecuta cargo test usa
// `--features finance --lib` (o `--bin ultron-memory` para los tests del
// sidecar), un filtro concreto y un timeout amplio. Sin toolchain, sin el
// modulo finance o con la compilacion rota, el veredicto es manual con la
// causa (cargoFilterVerdict), nunca verde. Memoizado por comando: varios
// checks comparten la compilacion del binario de tests.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CC, CC_TAURI, run } from "./core.mjs";
import { financeSourcePresent } from "./predicates.mjs";
import { cargoFilterVerdict } from "./predicates-r2.mjs";

// Primera compilacion de los tests en un worktree limpio: ~5 min medidos el
// 2026-10-23; 30 min de tope para una maquina cargada.
const CARGO_TIMEOUT_MS = 1_800_000;

let _toolchain;
function hasToolchain() {
  if (_toolchain === undefined) _toolchain = run("cargo --version", { timeout: 30000 }).ok;
  return _toolchain;
}

const _cache = new Map();

/**
 * Ejecuta `cargo test --features finance <--lib|--bin X> <filter> -- --test-threads=1`.
 * opts: { bin, ignored, env }. Devuelve { code, output, toolchain, finance }.
 */
export function cargoTest(filter, { bin = null, ignored = false, env = {} } = {}) {
  const target = bin ? `--bin ${bin}` : "--lib";
  const cmd = `cargo test --features finance ${target} ${filter} -- --test-threads=1${ignored ? " --ignored" : ""} 2>&1`;
  const key = `${cmd}|${JSON.stringify(env)}`;
  if (_cache.has(key)) return _cache.get(key);
  let res;
  if (!hasToolchain()) res = { code: null, output: "", toolchain: false, finance: true };
  else if (!financeSourcePresent(existsSync, join, CC_TAURI)) res = { code: null, output: "", toolchain: true, finance: false };
  else {
    const r = run(cmd, { cwd: join(CC, "src-tauri"), timeout: CARGO_TIMEOUT_MS, env });
    res = { code: r.code, output: r.stdout + r.stderr, toolchain: true, finance: true };
  }
  _cache.set(key, res);
  return res;
}

/** Atajo: ejecuta y juzga con cargoFilterVerdict; el detalle lleva el filtro. */
export function cargoTestCheck(filter, { minPassed = 1, ...opts } = {}) {
  const v = cargoFilterVerdict(cargoTest(filter, opts), { minPassed });
  return { ...v, detail: `[${opts.bin ? `--bin ${opts.bin}` : "--lib"} ${filter}${opts.ignored ? " --ignored" : ""}] ${v.detail}` };
}
