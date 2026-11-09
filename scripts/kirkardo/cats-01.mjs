// kirkardo/cats-01.mjs — categoria 1 (memoria).
// Extraido de scripts/kirkardo-eval.mjs (2026-10-23) sin cambios de logica.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COCKPIT, GOLDEN_LABELS, REPO, RESUME_PROJECT, ULTRON, cat, doctorCheck, fileExists, fwd, readJSON, run, runDoctor, runGoldenEval } from "./core.mjs";
import { runResumeHook, sql20 } from "./hook-io.mjs";

// ---------------------------------------------------------------------------
// CAT 1 — Memoria (FTS5 + resume y bitacora)
// ---------------------------------------------------------------------------
// Desde el 2026-09-28 el recall es solo FTS5 y la memoria entra por el resume de
// arranque y la bitacora: 1.1/1.2/1.6 (denso) y 1.7 (recall por prompt) quedan
// retirados mientras esas decisiones sigan en vigor; 1.8-1.10 miden lo que hay.
cat(1, "Memoria (FTS5 + resume y bitacora)", [
  {
    id: "1.1",
    desc: "recall@8 >= 0.90 via ORACULO golden (no el eval sintetico circular)",
    auto: true,
    retiredBy: "dense-off",
    check() {
      // El `eval` sin --golden es CIRCULAR: deriva expect_any_of de los mismos
      // terminos de la query -> recall=1.0 por construccion. El oraculo golden
      // (ids hand-labeled) mide recall real.
      // GOAL 0.90 (no 0.95): los labels apuntan a UN id concreto entre memorias
      // gemelas (near-duplicates), asi que recuperar la gemela "equivocada" cuenta
      // como miss. Techo practico ~0.92 medido 2026-07-22 con sweep de RERANK_TOP_N;
      // 0.90 es exigente y alcanzable, 0.95 queda aritmeticamente fuera del techo.
      if (!existsSync(GOLDEN_LABELS)) {
        return { pass: false, detail: "golden_labels.json ausente (no medible sin oraculo)" };
      }
      const j = runGoldenEval();
      if (!j) return { pass: false, detail: "eval --golden no devolvio JSON parseable" };
      if (j.degraded === true) {
        return { skip: true, detail: "E5 degradado (cold-load) tras 3 intentos — recall no medible aqui, no puntuado (evita falso ~0.18 por embeddings hash)" };
      }
      const recall = j.aggregate?.recall_at_k ?? null;
      if (recall === null) return { pass: false, detail: "sin recall_at_k en aggregate" };
      return {
        pass: recall >= 0.90,
        detail: `recall@8(golden)=${recall.toFixed(3)} vs GOAL 0.90 — oraculo no-circular sobre ${j.total_queries ?? "?"} queries`,
      };
    },
  },
  {
    id: "1.2",
    desc: "drift brain.db/Qdrant = 0 (doctor reconcile in_sync)",
    auto: true,
    retiredBy: "dense-off",
    check() {
      // Mide el drift y nada mas: el max_severity global lo ponia en rojo un check
      // ajeno (p. ej. evals). Solo bloquean el propio reconcile y el sondeo de
      // Qdrant, que es quien hace fiable la medicion de drift.
      const doc = runDoctor();
      if (!doc.json) return { pass: false, detail: `doctor sin JSON: ${doc.raw.slice(0, 120)}` };
      const qd = doctorCheck("qdrant");
      const reconcile = doctorCheck("reconcile");
      if (!reconcile) {
        return { pass: false, detail: `doctor sin check reconcile con el denso activo (qdrant: ${qd?.detail ?? "?"})` };
      }
      const inSync = reconcile.data?.in_sync === true;
      const missing = reconcile.data?.missing ?? 0;
      const orphan = reconcile.data?.orphan ?? 0;
      const qdOk = qd?.severity !== "error";
      return {
        pass: qdOk && inSync && missing === 0 && orphan === 0,
        detail: `in_sync=${inSync}, missing=${missing}, orphan=${orphan}, qdrant=${qd?.severity ?? "?"}`,
      };
    },
  },
  {
    id: "1.3",
    desc: "memory_candidates pending > 7 dias = 0 (check inbox del doctor + edad en brain.db)",
    auto: true,
    check() {
      // Antes miraba max_severity del doctor como proxy: un error de evals lo
      // ponia en rojo con el inbox vacio. Ahora lee el check inbox y, si hay
      // pendientes, cuenta en brain.db (solo lectura) los de mas de 7 dias.
      const doc = runDoctor();
      if (!doc.json) return { pass: false, detail: `doctor sin JSON: ${doc.raw.slice(0, 120)}` };
      const inbox = doctorCheck("inbox");
      if (!inbox) return { pass: false, detail: "no medible: el doctor no trae el check inbox" };
      if (inbox.data?.checked === false) return { pass: false, detail: `no medible: ${inbox.detail}` };
      const pending = inbox.data?.pending;
      if (typeof pending !== "number") return { pass: false, detail: "no medible: inbox sin conteo pending" };
      if (pending === 0) return { pass: true, detail: `inbox: 0 pendientes (${inbox.detail})` };
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      const q = sql20(`SELECT COUNT(*) AS n FROM memory_candidates WHERE status='pending' AND created_at < ${cutoff}`);
      if (!q.rows) return { pass: false, detail: `inbox pending=${pending}; edad no medible (${q.err ?? "sin brain.db"})` };
      const old = Number(q.rows[0]?.n ?? 0);
      return {
        pass: old === 0,
        detail: `inbox pending=${pending}, de ellos >7 dias=${old} (oldest_unjudged_days=${inbox.data?.oldest_unjudged_days ?? "null"})`,
      };
    },
  },
  {
    id: "1.4",
    retiredBy: "dense-off", // 2026-10-28: sin denso no hay Qdrant: pasaba siempre por ausencia
    desc: "ultron_sessions ausente o write-dead en doctor",
    auto: true,
    check() {
      const txt = runDoctor().raw;
      try {
        const j = JSON.parse(txt.trim());
        const checks = j.checks ?? [];
        const sessCheck = checks.find((c) => c.name === "qdrant_ultron_sessions");
        if (!sessCheck) {
          return { pass: true, detail: "ultron_sessions ausente en doctor (OK)" };
        }
        const writeDead = sessCheck.data?.write_dead === true;
        return { pass: writeDead, detail: `write_dead=${writeDead}, pts=${sessCheck.data?.points}` };
      } catch {}
      const mentionsSessions = /ultron_sessions/i.test(txt);
      const writeDead = /write.?dead.*true/i.test(txt);
      return {
        pass: writeDead || !mentionsSessions,
        detail: !mentionsSessions ? "ausente en doctor" : `write_dead=${writeDead}`,
      };
    },
  },
  {
    id: "1.5",
    desc: "memory-session-resume < 3000ms (hook-timing.jsonl)",
    auto: true,
    check() {
      const timingFile = join(ULTRON, "logs", "hook-timing.jsonl");
      if (!fileExists(timingFile)) return { pass: false, detail: "hook-timing.jsonl ausente" };
      const lines = readFileSync(timingFile, "utf8").trim().split("\n").filter(Boolean);
      // Formato actual: {"ts":"...", "hook":"memory-session-resume", "elapsed_ms":104, "exit_code":0}
      const resumeEntries = lines
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        // Solo el resume, como dice el desc. Mezclar memory-orchestrate (que en modo
        // ligero tarda ~12 ms y que 22.7 ejecuta 17 veces al final de cada corrida)
        // dejaba las ultimas 5 entradas en verde por construccion.
        .filter((e) => e && e.hook === "memory-session-resume")
        .map((e) => e.elapsed_ms ?? e.duration_ms ?? e.ms ?? 9999);
      if (resumeEntries.length === 0) return { pass: false, detail: "sin entradas memory-session-resume en timing" };
      const last5 = resumeEntries.slice(-5);
      const maxMs = Math.max(...last5);
      return { pass: maxMs < 3000, detail: `max_last5_resume=${maxMs}ms` };
    },
  },
  {
    id: "1.6",
    desc: "precision@3 >= 0.6 y context_waste <= 0.64 (el pack es relevante, no ruido) — oraculo golden",
    auto: true,
    retiredBy: "dense-off",
    check() {
      // La memoria CONTIENE el dato != lo inyectado es RELEVANTE. precision@3 mide
      // que el top del pack sea señal; context_waste <= 0.64 acota el ruido del pack
      // completo.
      // GOAL waste 0.64 (decidido por el usuario 2026-08-17; antes 0.62): waste@8 =
      // 1 - precision@8 con denominador fijo k=8. Con media n_relevant~3.2 por query,
      // waste 0.62 exigia recall >= 0.947 — por encima del techo practico (~0.92,
      // labels con gemelos near-dup) y MAS duro que el 0.90 del check 1.1: un
      // umbral que 1.1 no pide no puede exigirlo 1.6 de rebote. 0.64 equivale a
      // recall ~0.90: coherente con 1.1 y alcanzable. No se usa waste@3 porque
      // seria 1 - p@3: tautologico con la condicion p@3 >= 0.6 que ya exige.
      if (!existsSync(GOLDEN_LABELS)) {
        return { pass: false, detail: "golden_labels.json ausente (no medible)" };
      }
      const j = runGoldenEval();
      if (!j) return { pass: false, detail: "eval --golden no devolvio JSON parseable" };
      if (j.degraded === true) {
        return { skip: true, detail: "E5 degradado (cold-load) tras 3 intentos — precision no medible aqui, no puntuado" };
      }
      const p3 = j.aggregate_precision_at_3 ?? j.aggregate?.precision_at_3 ?? null;
      const waste = j.aggregate?.context_waste ?? null;
      if (p3 === null || waste === null) {
        return { pass: false, detail: "sin precision@3/context_waste en el aggregate" };
      }
      return {
        pass: p3 >= 0.6 && waste <= 0.64,
        detail: `precision@3=${p3.toFixed(3)} (>=0.6) context_waste=${waste.toFixed(3)} (<=0.64)`,
      };
    },
  },
  {
    id: "1.7",
    desc: "sobre TRAFICO REAL: <=20% de prompts sin memoria (traffic-recall-audit --replay)",
    auto: true,
    // Mide la memoria que llega POR PROMPT, que el modo ligero no inyecta.
    retiredBy: "orchestrate-light",
    check() {
      // (2026-08-16) Los checks 1.1 y 1.6 miden el oraculo golden: 29 queries
      // escritas a mano, limpias, sin una errata ni un 'venga'. Ese dia se
      // descubrio que NO representan el trafico real y que por eso dos fallos
      // graves vivieron semanas sin que ningun medidor los viera:
      //   - el trust gate vaciaba 443 de 670 packs reales (66%), y el golden no
      //     movio una decima porque ninguna de sus queries lleva las palabras
      //     que lo disparaban.
      //   - el floor de confianza silenciaba 21 de cada 120 prompts de trabajo;
      //     en el golden costaba 0.017 de recall, un ruido despreciable.
      // Este check cierra ese hueco: coge prompts REALES del log y mide cuantos
      // se quedan sin una sola memoria. No puntua relevancia (eso exige
      // etiquetas humanas): mide si la memoria CONTESTA. Un pack irrelevante se
      // nota; un pack vacio es invisible.
      //
      // Usa --replay (no el modo lectura) a proposito: mide el BINARIO ACTUAL,
      // no lo que hacia el binario que corria cuando se escribio el log. Coste
      // ~30-60s con el daemon caliente; muestra de 40 para no inflar el harness.
      //
      // Umbral 20%: medido 6.7% tras retirar el floor, y los silencios que
      // quedan son saludos y charla. 20% deja margen de variacion del trafico y
      // sigue disparando muy por debajo del 24-66% que llego a haber.
      const script = join(REPO, "scripts", "traffic-recall-audit.mjs");
      if (!existsSync(script)) {
        return { pass: false, detail: "traffic-recall-audit.mjs ausente" };
      }
      const out = run(`node "${fwd(script)}" --replay 40 --json`, { timeout: 300000 });
      let j = null;
      try {
        j = JSON.parse(String(out.stdout || "").trim());
      } catch {
        return { pass: false, detail: `audit no devolvio JSON: ${String(out.stdout || out.stderr || "").slice(0, 120)}` };
      }
      if (j.ok === false && j.error) {
        return { skip: true, detail: `no medible: ${j.error}` };
      }
      // Sin daemon vivo el replay marca todo como 'infra': eso mide la
      // infraestructura del momento, no la calidad del recall -> no puntua.
      const infra = j.por_causa?.infra ?? 0;
      if (infra > j.total / 2) {
        return { skip: true, detail: `daemon sin responder (${infra}/${j.total} turnos) — no medible aqui` };
      }
      const causas = Object.entries(j.por_causa || {})
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      return {
        pass: j.silenced_pct <= 20,
        detail: `${j.silenced}/${j.total} prompts reales sin memoria (${j.silenced_pct}%, <=20%)${causas ? ` · ${causas}` : ""}`,
      };
    },
  },
  {
    id: "1.8",
    desc: "el resume de arranque inyecta la bitacora (estado.json): project-state con >=1 pendiente y >=1 decision, items = los de estado.json, bitacora <= 7 dias",
    auto: true,
    check() {
      // Sustituye a 1.7 mientras el orchestrate vaya en ligero: la memoria de
      // proyecto llega en el SessionStart, asi que se mide lo que el hook real
      // inyecta y se cruza con la bitacora de la que sale. 7 dias: la bitacora se
      // regenera al cerrar cada sesion (medido < 1 dia el 2026-10-23).
      const estadoPath = join(COCKPIT, "projects", RESUME_PROJECT, "estado.json");
      const est = readJSON(estadoPath);
      if (!est) return { pass: false, detail: "no medible: estado.json ausente o ilegible (clon limpio/CI)" };
      const h = runResumeHook(ULTRON);
      const ac = h.ac ?? "";
      const m = ac.match(/<project-state[^>]*>([\s\S]*?)<\/project-state>/);
      if (!m) return { pass: false, detail: `el resume no trae <project-state> (${(h.raw ?? "").slice(0, 80)})` };
      const sections = { Pendientes: [], "Decisiones vigentes": [] };
      let cur = null;
      for (const line of m[1].split("\n")) {
        const head = line.match(/^(Pendientes|Decisiones vigentes|Gotchas):\s*$/);
        if (head) { cur = head[1]; continue; }
        const item = line.match(/^\s{2}-\s(.*)$/);
        if (item && cur && sections[cur]) sections[cur].push(item[1].trim());
      }
      const pend = sections.Pendientes;
      const dec = sections["Decisiones vigentes"];
      const known = new Set([...(est.pendientes ?? []), ...(est.decisiones ?? [])].map((s) => String(s).trim()));
      const foreign = [...pend, ...dec].filter((s) => !known.has(s));
      const ageDays = (Date.now() - Date.parse(est.updated_at ?? "")) / 86400000;
      const fresh = Number.isFinite(ageDays) && ageDays <= 7;
      return {
        pass: pend.length >= 1 && dec.length >= 1 && foreign.length === 0 && fresh,
        detail: `pendientes=${pend.length} decisiones=${dec.length} ajenos_a_estado.json=${foreign.length} edad_bitacora=${Number.isFinite(ageDays) ? ageDays.toFixed(1) : "?"}d (<=7)`,
      };
    },
  },
  {
    id: "1.9",
    desc: "recall FTS5 sin regresion (evals del doctor): smoke >= 0.90, golden sparse >= 0.10, leaks secret/stale = 0",
    auto: true,
    check() {
      // Lineas base sparse medidas el 2026-10-23 (las mismas del doctor): smoke
      // 11/12 = 0,917 y golden v1 sparse 0,131 sobre 27 queries (una query vale
      // ~0,037). Los suelos caen ~1 query por debajo: miden regresion, no la
      // calidad del hibrido (eso es 1.1, retirado con el denso).
      const ev = doctorCheck("evals");
      if (!ev) return { pass: false, detail: `no medible: doctor sin check evals (${runDoctor().raw.slice(0, 80)})` };
      const d = ev.data ?? {};
      if (d.golden_degraded === true) return { pass: false, detail: `golden degradado: ${ev.detail}` };
      const smoke = d.recall_at_8_smoke;
      const golden = d.recall_at_8_golden;
      const leaks = (d.secret_leak ?? 0) + (d.stale_leak ?? 0);
      if (typeof smoke !== "number" || typeof golden !== "number") {
        return { pass: false, detail: "no medible: evals sin recall_at_8_smoke/golden" };
      }
      return {
        pass: smoke >= 0.9 && golden >= 0.1 && leaks === 0,
        detail: `smoke=${smoke.toFixed(3)} (>=0.90) golden_sparse=${golden.toFixed(3)} (>=0.10) secret_leak=${d.secret_leak ?? "?"} stale_leak=${d.stale_leak ?? "?"}`,
      };
    },
  },
  {
    id: "1.10",
    desc: "indice FTS5 sincronizado con brain.db (doctor fts: integridad ok y fts_rows == item_rows)",
    auto: true,
    check() {
      // Sustituye a 1.2 con el denso apagado: el unico indice derivado vivo es
      // memory_items_fts, que puede divergir en silencio de memory_items.
      const fts = doctorCheck("fts");
      if (!fts) return { pass: false, detail: `no medible: doctor sin check fts (${runDoctor().raw.slice(0, 80)})` };
      const d = fts.data ?? {};
      const inSync = d.integrity_ok === true && typeof d.fts_rows === "number" && d.fts_rows === d.item_rows;
      return {
        pass: inSync && fts.severity !== "error",
        detail: `integrity_ok=${d.integrity_ok} fts_rows=${d.fts_rows} item_rows=${d.item_rows} severity=${fts.severity}`,
      };
    },
  },
]);
