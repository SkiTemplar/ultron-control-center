#!/usr/bin/env node
// scripts/ai-text-scan.js — CLI del detector de texto IA.
//
// El matcher (hooks/scripts/lib/ai-text-detector.js) solo lo consumia el hook
// PostToolUse, que avisa DESPUES de escribir. La skill de analizar/reescribir
// necesita poder preguntarle ANTES de entregar, y necesita hacerlo de forma
// verificable — de ahi el exit code, que es lo que convierte el veredicto en
// un gate de verdad y no en una promesa.
//
// Uso:
//   node scripts/ai-text-scan.js <fichero>
//   echo "texto" | node scripts/ai-text-scan.js -
//   node scripts/ai-text-scan.js <fichero> --json
//
// Exit: 0 = sin_indicios · 1 = probable_ia · 2 = no_concluyente
//       (pocas palabras o densidad en la banda de duda) · 3 = error de uso.
//
// El veredicto es por DENSIDAD (señales/100 palabras, sin contar las de rol
// "aviso" como tricolon), no por "≥1 señal" — decidido por el usuario
// 2026-09-11. Ver el comentario de `computeVerdict` en ai-text-detector.js
// para el umbral, la banda de duda y de donde salen esos valores.
//
// Fuente unica: los patrones salen del catalogo (docs/research/patrones-texto-ia.json),
// los mismos que ejecutan el hook y la pestaña Lab. Este CLI no define ninguno.

'use strict';

const fs = require('fs');
const path = require('path');
const { scan, MARKDOWN_NATIVE_PATTERNS } = require('../hooks/scripts/lib/ai-text-detector');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function printUsage() {
  process.stderr.write(
    'Uso:\n' +
      '  node scripts/ai-text-scan.js <fichero> [--json]\n' +
      '  echo "texto" | node scripts/ai-text-scan.js - [--json] [--as <.md|.tex|.txt>]\n\n' +
      'Exit: 0 = sin_indicios · 1 = probable_ia · 2 = no_concluyente ' +
      '(pocas palabras o densidad en la banda de duda) · 3 = error de uso.\n',
  );
}

function usage(msg) {
  process.stderr.write(`${msg}\n\n`);
  printUsage();
  process.exit(3);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }
  const asJson = args.includes('--json');
  const asIdx = args.indexOf('--as');
  const target = args.find((a) => !a.startsWith('--') && a !== (asIdx >= 0 ? args[asIdx + 1] : null));
  if (!target) usage('Falta el fichero (o "-" para leer de stdin).');

  let text;
  let ext;
  if (target === '-') {
    text = readStdin();
    ext = (asIdx >= 0 ? String(args[asIdx + 1] || '') : '.md').toLowerCase();
  } else {
    if (!fs.existsSync(target)) usage(`No existe: ${target}`);
    text = fs.readFileSync(target, 'utf8');
    ext = path.extname(target).toLowerCase();
  }

  if (!text.trim()) usage('Texto vacio.');

  // Mismo criterio de ambito que el hook: en destino .md la negrita y el guion
  // largo son sintaxis del formato, no artefactos de haber pegado un chatbot.
  const report = scan(text, null, {
    skipPatterns: ext === '.md' ? MARKDOWN_NATIVE_PATTERNS : [],
  });

  const EXIT_POR_VEREDICTO = { sin_indicios: 0, probable_ia: 1, no_concluyente: 2 };
  const exitCode = EXIT_POR_VEREDICTO[report.veredicto] ?? 2;

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(exitCode);
  }

  const avisos = report.matches.filter((m) => m.rol === 'aviso');
  const senales = report.matches.filter((m) => m.rol !== 'aviso');
  const avisoLine = avisos.length
    ? ` (+${report.avisos_total} aviso(s) de estilo aparte, no cuentan para el veredicto)`
    : '';

  if (report.veredicto === 'sin_indicios') {
    process.stdout.write(
      `SIN INDICIOS — densidad ${report.density_per_100w.toFixed(2)}/100 palabras sobre ${report.words} palabras ` +
        `(${report.total_patterns_scanned} patrones aplicados${ext === '.md' ? ', markup/guion largo omitidos por ser .md' : ''})` +
        `${avisoLine}.\n`,
    );
    process.exit(0);
  }

  if (report.veredicto === 'no_concluyente') {
    const motivo =
      report.motivo_no_concluyente === 'pocas_palabras'
        ? `menos de 400 palabras (${report.words}): no hay margen suficiente para fiarse de la densidad`
        : `densidad ${report.density_per_100w.toFixed(2)}/100 palabras, dentro de la banda de duda del umbral`;
    process.stdout.write(
      `NO CONCLUYENTE — motivo: ${motivo}. ` +
        `${report.senales_total} señal(es) de ${report.total_patterns_scanned} patrones aplicados${avisoLine}.\n`,
    );
    if (senales.length) {
      process.stdout.write('\nSeñales encontradas (no bastan para el veredicto, pero conviene revisarlas):\n');
      for (const m of senales) {
        process.stdout.write(`  [${m.pattern}] ${m.rule} · "…${m.evidence}…"\n`);
      }
    }
    process.exit(2);
  }

  // probable_ia
  const lines = [
    `PROBABLE IA — densidad ${report.density_per_100w.toFixed(2)}/100 palabras (${report.senales_total} señal(es) ` +
      `en ${report.patterns_hit} patrón(es), ${report.words} palabras)${avisoLine}.`,
    '',
  ];
  for (const m of senales) {
    lines.push(`[${m.pattern}]`);
    lines.push(`  regla    : ${m.rule}`);
    lines.push(`  evidencia: …${m.evidence}…`);
    if (m.correction) lines.push(`  correccion: ${m.correction}`);
    lines.push('');
  }
  if (avisos.length) {
    lines.push('--- Avisos de estilo (no cuentan para el veredicto) ---');
    for (const m of avisos) {
      lines.push(`[${m.pattern}] ${m.rule} · "…${m.evidence}…"`);
    }
    lines.push('');
  }
  process.stdout.write(lines.join('\n'));
  process.exit(1);
}

main();
