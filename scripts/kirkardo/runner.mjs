// kirkardo/runner.mjs — evaluacion, gate, informe y barrido de residuos.
// Extraido de scripts/kirkardo-eval.mjs (2026-10-23) sin cambios de logica.

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as P from "./predicates.mjs";
import * as R3 from "./predicates-r3.mjs";
import { CATS, FLAG_CAT, FLAG_JSON, LAGGARD_THRESHOLD, REPO, ULTRON_MEM, beginInfraLog, fwd, run, takeFaultLog, takeInfraLog } from "./core.mjs";
import { AREAS, MIN_AREA_CHECKS, UNCOVERED_SURFACES, areaOf, areaWeight } from "./areas.mjs";
import { DECISIONS, _decisionCache, decisionStatus, refreshAllDecisions } from "./decisions.mjs";
import { sql20 } from "./hook-io.mjs";
import { appendHistoryRow, collectProvenance, lastHistoryRow, retiredEffect, scoreWatch } from "./provenance.mjs";

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
const MANUAL_DEFAULT = "requiere verificacion visual o juicio humano";

/**
 * Control del medidor (auditoria 2026-11-01): a que codigo corresponde la nota,
 * cuanto puede estar comprando cada retirada y si la nota sube con el producto
 * intacto. Un run acotado no entra en el historial ni se compara: su overall no
 * es la nota del sistema.
 */
function meterControl({ checks, overall, overallFlat, retiredCount, isScoped, logsDir, generatedAt }) {
  const provenance = collectProvenance(REPO);
  const effect = retiredEffect(checks, AREAS);
  if (isScoped) return { provenance, retired_effect: effect, score_watch: { status: "acotado", detail: "un run --cat no se compara ni entra en el historial" } };
  const row = { generated_at: generatedAt, overall, overall_flat: overallFlat, retired: retiredCount, ...provenance };
  const watch = scoreWatch(lastHistoryRow(logsDir), row);
  appendHistoryRow(logsDir, row);
  return { provenance, retired_effect: effect, score_watch: watch };
}

export async function evaluate() {
  const results = [];
  const retired = [];
  let totalPass = 0;
  let totalDenominator = 0;

  const catsToRun = FLAG_CAT ? CATS.filter((c) => c.num === parseInt(FLAG_CAT, 10)) : CATS;

  for (const catDef of catsToRun) {
    const catResult = {
      cat: catDef.num,
      name: catDef.name,
      // tier (2026-10-28): core = la categoria puntua en un area con peso.
      tier: areaWeight(areaOf({}, catDef.num)) > 0 ? "core" : "supplementary",
      checks: [],
      pass: 0,
      total: 0,
      retired: 0,
      nota: 0,
    };

    for (const check of catDef.checks) {
      const area = areaOf(check, catDef.num);
      if (!check.auto || !check.check) {
        catResult.checks.push({
          id: check.id,
          desc: check.desc,
          status: "manual",
          pass: null,
          detail: MANUAL_DEFAULT,
          area,
        });
        continue; // no cuenta en denominador
      }

      // Retirado por decision: fuera del denominador solo si la decision sigue en
      // vigor AHORA. Si no, se mide como cualquier otro y el detalle lo dice.
      // Sustituto onlyWhile (p. ej. 22.7 mide el modo ligero): fuera de vigor
      // vuelven los originales y este sale del denominador, listado igual.
      const cls = P.classifyByDecision(check, decisionStatus);
      if (cls.kind !== "measure") {
        const d = DECISIONS[cls.decision];
        const retiredKind = cls.kind === "retired";
        const info = {
          cat: catDef.num,
          tier: catResult.tier,
          id: check.id,
          decision: retiredKind ? cls.decision : `sin ${cls.decision}`,
          date: d?.date ?? null,
          reason: retiredKind
            ? d?.reason
            : `sustituto de los checks que retira ${cls.decision}; con la decision fuera de vigor se miden los originales`,
          evidence: cls.status.evidence,
          reactivate: retiredKind ? d?.reactivate : `volver a poner en vigor ${cls.decision}`,
        };
        retired.push(info);
        catResult.retired++;
        catResult.checks.push({
          id: check.id,
          desc: check.desc,
          status: "retired",
          pass: null,
          detail: retiredKind
            ? `retirado por ${cls.decision} (${d?.date}); vigencia: ${cls.status.evidence}`
            : `inactivo: ${cls.decision} fuera de vigor (${cls.status.evidence})`,
          retired: info,
          area,
        });
        continue;
      }
      const decisionNote = cls.note;

      let result;
      beginInfraLog();
      try {
        result = await check.check();
      } catch (e) {
        result = { pass: false, detail: `exception: ${e.message}` };
      }
      // P1 (2026-10-28, acotado el 2026-11-01): un rojo cuyo ultimo proceso no
      // arranco (0xC0000142, spawn fallido) es infraestructura: manual con la
      // causa, fuera del denominador y nunca verde. Un timeout o un crash siguen
      // rojos, con el fallo en el detalle.
      result = R3.applyInfra(result, takeInfraLog(), takeFaultLog());
      if (decisionNote) result = { ...result, detail: `${result.detail ?? ""}${decisionNote}` };

      // skip: la medicion no es fiable en este entorno (p.ej. E5 degradado por
      // cold-load). NO es un fallo de calidad -> no cuenta en el denominador,
      // igual que 'manual'. Evita que un fallo de infra se disfrace de fallo real.
      // manual (2026-10-23, ronda 2): el check no se pudo ejecutar aqui por una
      // causa de entorno que alguien tiene que mirar (sin toolchain de Rust,
      // la compilacion falla, un proceso que no arranco). Fuera del denominador
      // como los auto:false, pero con la causa en el detalle; nunca verde. Un
      // timeout o un crash no llegan aqui: son rojos del producto (2026-11-01).
      if (result.manual) {
        catResult.checks.push({
          id: check.id,
          desc: check.desc,
          status: "manual",
          pass: null,
          detail: result.detail ?? "no ejecutable en este entorno (manual)",
          area,
          ...(result.infra ? { infra: true } : {}),
        });
        continue;
      }

      if (result.skip) {
        catResult.checks.push({
          id: check.id,
          desc: check.desc,
          status: "skip",
          pass: null,
          detail: result.detail ?? "medicion no fiable (skip)",
          area,
        });
        continue;
      }

      catResult.checks.push({
        id: check.id,
        desc: check.desc,
        status: result.pass ? "pass" : "fail",
        pass: result.pass,
        detail: result.detail ?? "",
        area,
      });

      catResult.total++;
      if (result.pass) catResult.pass++;
    }

    catResult.nota = catResult.total > 0 ? (catResult.pass / catResult.total) * 10 : 0;
    totalPass += catResult.pass;
    totalDenominator += catResult.total;
    results.push(catResult);
  }

  // Nota plana historica (todos los checks pesan igual): se conserva como
  // overall_flat para comparar con corridas anteriores al 2026-10-28.
  const overallFlat = totalDenominator > 0 ? (totalPass / totalDenominator) * 10 : 0;

  // -------------------------------------------------------------------------
  // Gate de laggard + overall core: el medidor deja de mentir por promedio.
  // worst_cat = la categoria mas baja; all_cats_pass = el GOAL (9.5 en TODAS)
  // se cumple solo si NINGUNA cat esta por debajo del umbral. Una categoria sin
  // checks medidos cuenta como laggard (unmeasured), no sale del gate en
  // silencio (2026-10-23, medidor-11).
  // -------------------------------------------------------------------------
  const { rated, unrated, worst, laggards, allCatsPass } = P.gateSummary(results, LAGGARD_THRESHOLD);

  // P3 (2026-10-28): nota ponderada por areas (scripts/kirkardo/areas.mjs).
  // overall = media ponderada de las areas con peso; overall_core = media
  // simple de esas areas; un area con < MIN_AREA_CHECKS medidos es "sin
  // medir" (0 y laggard). El gate es el de las areas con peso.
  const areaRes = R3.areaSummary(results.flatMap((c) => c.checks), AREAS, { threshold: LAGGARD_THRESHOLD, minChecks: MIN_AREA_CHECKS });
  const overall = areaRes.overall;
  const overallCore = areaRes.overall_core;
  // Vigencia de todas las decisiones (tambien las que no retiran checks: DEC1).
  refreshAllDecisions();

  // Retirados por decision: fuera del denominador, pero contados y con evidencia.
  // decisions = vigencia de TODAS las decisiones consultadas en esta corrida
  // (tambien las que estan fuera de vigor y por eso devolvieron sus checks).
  const retiredCore = retired.filter((r) => r.tier === "core").length;
  const decisions = Object.fromEntries(
    [..._decisionCache.entries()].map(([id, st]) => [
      id,
      { date: DECISIONS[id]?.date ?? null, in_force: st.inForce, evidence: st.evidence, reactivate: DECISIONS[id]?.reactivate ?? null },
    ]),
  );

  // 0.4: un run scoped (--cat=N) NO refleja la salud del sistema entero. No debe
  // pisar el JSON canonico que lee el resume, ni afirmar all_cats_pass (el "10" del
  // 06-25 era un run cat19 sobre el canonico: overall=10, core=0, all_cats_pass=true).
  const isScoped = catsToRun.length < CATS.length;

  const logsDir = join(REPO, "logs");
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const control = meterControl({
    checks: results.flatMap((c) => c.checks),
    overall: parseFloat(overall.toFixed(2)),
    overallFlat: parseFloat(overallFlat.toFixed(2)),
    retiredCount: retired.length,
    isScoped,
    logsDir,
    generatedAt,
  });

  const output = {
    generated_at: generatedAt,
    ...control,
    // No determinista (medidor-14): misma maquina y mismo HEAD pueden dar otra
    // nota segun la hora, la red y el estado vivo.
    deterministic: false,
    nondeterministic_inputs: [
      "hora (ventanas moviles de 3.4, 15.1, 15.3, 16.5; 12.6 frente a HEAD)",
      "red (gh en 12.5/12.6)",
      "transcripts de Claude Code (2.6) y logs vivos (1.5, 15.1, 16.5)",
      "daemons y procesos (2.4, 2.5, 9.4, 9.5)",
    ],
    scoped: isScoped,
    cats_run: catsToRun.map((c) => c.num),
    overall: parseFloat(overall.toFixed(2)),
    overall_core: parseFloat(overallCore.toFixed(2)),
    overall_flat: parseFloat(overallFlat.toFixed(2)),
    scoring: "areas ponderadas (2026-10-28); overall_flat = pass/total de todos los checks",
    areas: areaRes.areas,
    area_laggards: areaRes.gate,
    area_informative_laggards: areaRes.informative,
    min_area_checks: MIN_AREA_CHECKS,
    uncovered_surfaces: UNCOVERED_SURFACES,
    infra_manual: results.flatMap((c) => c.checks).filter((c) => c.infra).map((c) => c.id),
    // Checks retirados por decision en vigor (no cuentan en overall/overall_core).
    overall_retired: retired.length,
    overall_core_retired: retiredCore,
    // all_cats_pass solo es afirmable en un run COMPLETO; un scoped no puede.
    // Desde 2026-10-28 es el gate por areas con peso (nombre conservado: lo lee
    // memory-session-resume.js). cats_gate_pass = el gate antiguo por categoria.
    all_cats_pass: isScoped ? false : areaRes.gate.length === 0,
    cats_gate_pass: isScoped ? false : allCatsPass,
    laggard_threshold: LAGGARD_THRESHOLD,
    worst_cat: worst ? { cat: worst.cat, name: worst.name, nota: parseFloat(worst.nota.toFixed(1)) } : null,
    laggards,
    unmeasured_cats: unrated.map((c) => c.cat),
    total_pass: totalPass,
    total_checks: totalDenominator,
    retired_checks: retired,
    decisions,
    cats: results,
  };

  // Escribe JSON. scoped -> fichero aparte (no contamina el canonico que lee el resume).
  // Un worktree escribe su JSON en su propio logs/: no pisa el canonico que lee el resume.
  const outName = P.reportFileName(isScoped);
  writeFileSync(join(logsDir, outName), JSON.stringify(output, null, 2), "utf8");

  // Imprime resumen
  if (!FLAG_JSON) {
    console.log("\n=== KIRKARDO EVAL — Harness Determinista ===");
    console.log(`Generated: ${output.generated_at}`);
    console.log("");

    for (const cat of results) {
      const manualCount = cat.checks.filter((c) => c.status === "manual").length;
      const skipCount = cat.checks.filter((c) => c.status === "skip").length;
      const nota = cat.nota.toFixed(1);
      // [OK] solo si la categoria pasa el gate (antes una 8,0 salia [OK]).
      const icon = P.reportIcon(cat, LAGGARD_THRESHOLD);
      const retiredTxt = cat.retired ? `, ${cat.retired} retirado(s)` : "";
      const skipTxt = skipCount ? `, ${skipCount} skip` : "";
      const unmeasured = cat.total > 0 ? "" : "  SIN CHECKS MEDIDOS (cuenta como laggard)";
      console.log(`[${icon}] cat${cat.cat.toString().padStart(2, "0")} ${cat.name.padEnd(30)} ${cat.pass}/${cat.total} auto  nota=${nota}  (${manualCount} manual${skipTxt}${retiredTxt})${unmeasured}`);

      // Muestra fails, skips y los manual con causa de entorno (no puntuan,
      // pero no se esconden).
      for (const c of cat.checks) {
        const envManual = c.status === "manual" && c.detail !== MANUAL_DEFAULT;
        if (c.status === "fail" || c.status === "skip" || envManual) {
          console.log(`     ${c.status === "fail" ? "FAIL" : envManual ? "MANU" : "SKIP"} ${c.id}: ${c.desc}`);
          if (c.detail) console.log(`          -> ${c.detail.slice(0, 160)}`);
        }
      }
    }

    console.log("");
    if (retired.length) {
      const eff = output.retired_effect;
      console.log(`RETIRADOS POR DECISION (${retired.length}; fuera del denominador mientras la decision siga en vigor). Efecto: overall bajaria hasta ${eff.overall_drop_if_all_fail} si contaran en rojo (cota; no se ejecutan):`);
      const dropOf = new Map(eff.checks.map((c) => [c.id, c]));
      for (const r of retired) {
        const d = dropOf.get(r.id);
        console.log(`     ${r.id.padEnd(5)} ${(d?.area ?? "?").padEnd(16)} -${(d?.overall_drop_if_fail ?? 0).toFixed(3)} ${r.decision} (${r.date}) -> vigencia: ${r.evidence.slice(0, 90)}`);
      }
    }
    for (const [id, d] of Object.entries(decisions)) {
      if (!d.in_force) console.log(`DECISION FUERA DE VIGOR: ${id} (${d.date}) -> ${d.evidence.slice(0, 140)}; sus checks se miden`);
    }
    console.log("");
    console.log("AREAS (nota ponderada; minimo " + MIN_AREA_CHECKS + " checks medidos por area):");
    // Un run acotado solo ensena las areas que toca: el resto no se ha medido aqui.
    const shownAreas = isScoped ? areaRes.areas.filter((ar) => ar.total + ar.manual > 0) : areaRes.areas;
    for (const ar of shownAreas) {
      const state = !ar.measured ? "SIN MEDIR" : ar.nota >= LAGGARD_THRESHOLD ? "OK" : "LAGGARD";
      console.log(`     ${ar.id.padEnd(17)} peso=${String(ar.weight).padStart(2)}  ${ar.pass}/${ar.total}  nota=${ar.nota.toFixed(2)}  (${ar.manual} manual)  ${state}${ar.weight === 0 ? " (informativo)" : ""}`);
    }
    const infraIds = output.infra_manual;
    if (infraIds.length) console.log(`INFRAESTRUCTURA (manual, no puntuan): ${infraIds.join(", ")}`);
    console.log("");
    if (!isScoped) console.log(`OVERALL: ${overall.toFixed(2)}/10  (ponderada por areas; plana ${overallFlat.toFixed(2)} = ${totalPass}/${totalDenominator} checks; ${retired.length} retirados por decision)`);
    if (!isScoped) console.log(`CORE (media simple de las areas con peso): ${overallCore.toFixed(2)}/10  (${retiredCore} retirados por decision)`);
    if (isScoped) {
      const lg = laggards.map((l) => `cat${l.cat}=${l.unmeasured ? "sin medir" : l.nota}`).join(", ");
      console.log(laggards.length ? `VERDICT (scoped, por categoria): FAIL — ${lg}` : `VERDICT (scoped, por categoria): PASS — cat${FLAG_CAT} >= ${LAGGARD_THRESHOLD}`);
    } else if (output.all_cats_pass) {
      console.log(`VERDICT: PASS — todas las areas con peso >= ${LAGGARD_THRESHOLD} y con >= ${MIN_AREA_CHECKS} checks medidos`);
    } else {
      const lg = areaRes.gate.map((l) => `${l.area}=${l.unmeasured ? "sin medir" : l.nota}`).join(", ");
      console.log(`VERDICT: FAIL — ${areaRes.gate.length} area(s) laggard < ${LAGGARD_THRESHOLD}: ${lg}`);
    }
    if (!isScoped && laggards.length) {
      const lc = laggards.map((l) => `cat${l.cat}=${l.unmeasured ? "sin medir" : l.nota}`).join(", ");
      console.log(`         categorias bajo ${LAGGARD_THRESHOLD} (informativo): ${lc}`);
      if (worst) console.log(`         worst_cat: cat${worst.cat} ${worst.name} = ${worst.nota.toFixed(1)}`);
    }
    if (isScoped) {
      console.log(`SCOPED RUN (cat=${FLAG_CAT}) — NO actualiza la nota de sistema (escrito en ${outName}). La nota canonica solo cambia con un run COMPLETO.`);
    }
    const prov = output.provenance;
    console.log(`CODIGO MEDIDO: ${prov.error ? `no determinado (${prov.error})` : `${prov.git_sha} dirty=${prov.dirty} producto=${prov.product_fingerprint} medidor=${prov.harness_hash}`}`);
    console.log(`CONTROL DE LA NOTA: ${output.score_watch.status} -> ${output.score_watch.detail}`);
    console.log(`JSON: ${join(logsDir, outName)}`);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }

  return output;
}

// (2026-07-13) Barrido de residuo __kirkardo_test__ en la DB de PRODUCCION.
// Los e2e de approve/supersede promueven probes a ITEMS activos via el binario
// real; el "reject garantizado" del candidato no borra el item ya promovido —
// asi se acumularon 33 items de test en brain.db (purga 2026-07-13). Barre al
// ARRANCAR (residuo de runs anteriores o crasheados) y al SALIR (exit y error).
// Un fallo del barrido nunca rompe la eval, pero se dice (antes: catch mudo y un
// contador que comprobaba r.status, campo que run() no devuelve, asi que nunca
// subia; medidor-14).
export function sweepKirkardoTestItems(label) {
  try {
    const q = sql20(`SELECT id FROM memory_items WHERE project_id='__kirkardo_test__'`);
    if (q.err) {
      process.stderr.write(`[sweep] no se pudo consultar brain.db (${label}): ${q.err}\n`);
      return;
    }
    if (q.nodata || !q.rows?.length) return;
    let n = 0;
    for (const row of q.rows) {
      const r = run(
        `"${fwd(ULTRON_MEM)}" forget --id ${row.id} --reason "kirkardo-eval sweep (${label}): probe residual de test"`,
        { timeout: 15000 },
      );
      if (r.ok) n++;
    }
    const msg = `[sweep] ${n}/${q.rows.length} item(s) __kirkardo_test__ purgados de brain.db (${label})`;
    if (FLAG_JSON) process.stderr.write(`${msg}\n`);
    else console.log(msg);
  } catch (e) {
    process.stderr.write(`[sweep] fallo del barrido (${label}): ${e.message}\n`);
  }
}
