#!/usr/bin/env node
// project-usage.mjs — uso de Claude Code de un proyecto (coste nocional, modelos,
// sesion principal frente a subagentes, contexto medio por llamada).
//
// Lo consumen la tarjeta "Uso" del Control Center (comando Tauri project_usage)
// y la terminal. Logica en scripts/lib/usage-transcripts.mjs.
//
// Uso:
//   node scripts/project-usage.mjs <projectId> [--days 30] [--json]
//   node scripts/project-usage.mjs --all [--days 30] [--json]    (ranking de proyectos)

import { projectUsage, loadProjects } from './lib/usage-transcripts.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const all = args.includes('--all');
const dIdx = args.indexOf('--days');
const days = dIdx >= 0 ? Number(args[dIdx + 1]) : 30;
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--days');

const fail = (code, message) => {
  if (json) console.log(JSON.stringify({ ok: false, error: { code, message } }));
  else console.error(`[project-usage] ERROR (${code}): ${message}`);
  process.exit(1);
};

if (!Number.isInteger(days) || days < 1 || days > 366) fail('BAD_ARGS', '--days debe ser un entero entre 1 y 366');

const usd = (n) => `${n.toFixed(n >= 100 ? 0 : 2).replace('.', ',')} $`;
const kt = (n) => `${Math.round(n / 1000)}K`;

if (all) {
  const rows = loadProjects()
    .map((p) => projectUsage(p.id, { days }))
    .filter((r) => r.ok && r.totals.messages > 0)
    .sort((a, b) => b.totals.costUsd - a.totals.costUsd);
  if (json) {
    console.log(JSON.stringify({ ok: true, days, projects: rows.map((r) => ({ projectId: r.projectId, projectName: r.projectName, totals: r.totals, bySource: r.bySource })) }));
  } else {
    console.log(`Uso de Claude Code por proyecto (ultimos ${days} dias, coste nocional):`);
    for (const r of rows) {
      console.log(`  ${r.projectId.padEnd(28)} ${usd(r.totals.costUsd).padStart(9)}  ${String(r.totals.sessions).padStart(3)} sesiones  subagentes ${usd(r.bySource.sub.costUsd)}`);
    }
  }
  process.exit(0);
}

if (positional.length !== 1) fail('BAD_ARGS', 'uso: project-usage.mjs <projectId> [--days N] [--json]  |  --all');
const r = projectUsage(positional[0], { days });
if (!r.ok) fail(r.error.code, r.error.message);

if (json) {
  console.log(JSON.stringify(r));
} else {
  console.log(`${r.projectName} — ultimos ${r.days} dias (${r.window.from} a ${r.window.to})`);
  console.log(`  ${usd(r.totals.costUsd)} nocionales · ${r.totals.sessions} sesiones · ${r.totals.messages} llamadas`);
  console.log(`  principal ${usd(r.bySource.main.costUsd)} (contexto medio ${kt(r.bySource.main.avgContextTokens)}) · subagentes ${usd(r.bySource.sub.costUsd)} (contexto medio ${kt(r.bySource.sub.avgContextTokens)})`);
  for (const m of r.byModel) console.log(`  ${m.model.padEnd(20)} ${usd(m.costUsd).padStart(9)}  ${m.sharePct.toFixed(0).padStart(3)} %${m.priced ? '' : '  (sin precio)'}`);
  for (const n of r.notes) console.log(`  · ${n}`);
}
