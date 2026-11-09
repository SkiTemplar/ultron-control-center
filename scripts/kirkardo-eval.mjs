#!/usr/bin/env node
/**
 * kirkardo-eval.mjs — Harness de evaluacion Kirkardo (comandos fijos, sin agentes)
 *
 * Evalua los criterios Kirkardo AUTOMATIZABLES por comando fijo.
 * Salida: nota por cat, por area (ponderada, kirkardo/areas.mjs) y global;
 * escribe logs/kirkardo-eval.json.
 *
 * Sin agentes ni LLM de juicio, pero NO determinista: varios checks dependen de
 * la hora (ventanas moviles), de la red (gh, codex) y del estado vivo de la
 * maquina (transcripts, logs, daemons). El JSON lo declara en
 * nondeterministic_inputs.
 * Los criterios que requieren juicio o verificacion visual se marcan 'manual'
 * y NO se cuentan en el denominador; los 'skip' (no medibles aqui o sin
 * elementos que juzgar) tampoco, pero salen listados en el informe. Un check
 * automatico que no se puede ejecutar por el entorno (sin toolchain de Rust,
 * compilacion rota, un proceso que no arranca) tambien sale 'manual', con la
 * causa. Un timeout o un crash del producto son rojos, no 'manual'.
 *
 * El CODIGO medido es el del repo que contiene este script (checkout principal
 * o worktree, kirkardo/core.mjs: REPO); el estado vivo (bin/, logs/, brain.db,
 * cockpit de produccion) es siempre el de ~/.ultron. El JSON se escribe en el
 * logs/ del repo medido.
 *
 * Los hooks que ejecuta el harness corren con un HOME aislado
 * (kirkardo/sandbox.mjs): no escriben en los logs, la bitacora ni el estado de
 * produccion que otros checks miden.
 *
 * Los checks retirados por una decision con fecha (campo retiredBy, tabla
 * DECISIONS) tampoco cuentan, pero SOLO mientras la decision siga en vigor,
 * verificado en ejecucion; salen listados en el informe y en el JSON.
 *
 * Uso: node scripts/kirkardo-eval.mjs [--json] [--cat=N] [--no-gate]
 *   --json     solo imprime el JSON final
 *   --cat=N    evalua solo la categoria N (1-24)
 *   --no-gate  informe sin gate (exit 0 aunque haya laggards)
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// El orden de import es el orden de registro (y de informe) de las categorias.
import "./kirkardo/cats-01.mjs";
import "./kirkardo/cats-02-03.mjs";
import "./kirkardo/cats-04.mjs";
import "./kirkardo/cats-05-07.mjs";
import "./kirkardo/cats-08-10.mjs";
import "./kirkardo/cats-11-14.mjs";
import "./kirkardo/cats-15-18.mjs";
import "./kirkardo/cats-19-20.mjs";
import "./kirkardo/cats-21-22.mjs";
// Ronda 2 (2026-10-23): anaden checks a categorias ya registradas (extendCat).
import "./kirkardo/cats-r2-a.mjs";
import "./kirkardo/cats-r2-b.mjs";
// Ronda 3 (2026-10-28, auditoria del criterio): cat 22 reconvertida, Sessions
// (23), Pupus (24) y checks de comportamiento en categorias existentes.
import "./kirkardo/cats-22-delegacion.mjs";
import "./kirkardo/cats-23-sesiones.mjs";
import "./kirkardo/cats-24-pupus.mjs";
import "./kirkardo/cats-r3.mjs";
import { FLAG_GATE, cleanupHookSandbox } from "./kirkardo/core.mjs";
import { evaluate, sweepKirkardoTestItems } from "./kirkardo/runner.mjs";
export { denseOffStatus, orchestrateLightStatus, dispatcherOffStatus } from "./kirkardo/decisions.mjs";

// Solo corre como script: el selftest importa las funciones puras de vigencia
// (denseOffStatus, orchestrateLightStatus, dispatcherOffStatus) sin lanzar la eval.
const IS_MAIN =
  !!process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (IS_MAIN) runMain();

function runMain() {
  sweepKirkardoTestItems("start");
  evaluate()
    .then((out) => {
      sweepKirkardoTestItems("exit");
      cleanupHookSandbox();
      // Gate POR DEFECTO: exit 2 si alguna categoria corrida esta por debajo del
      // umbral o sin checks medidos. --no-gate da exit 0 (informe puro) aunque el
      // VERDICT sea FAIL. Un scoped que pasa su cat no gatea (all_cats_pass se
      // fuerza false por honestidad, pero sus laggards son solo los de esa cat).
      // Desde 2026-10-28 el gate de un run completo es el de las areas con peso
      // (area_laggards); un scoped sigue gateando por su categoria.
      const failing = out.scoped ? out.laggards : out.area_laggards;
      if (FLAG_GATE && failing.length > 0) process.exit(2);
    })
    .catch((e) => {
      sweepKirkardoTestItems("exit-error");
      cleanupHookSandbox();
      console.error("Error en kirkardo-eval:", e);
      process.exit(1);
    });
}
