#!/usr/bin/env node
// scripts/ai-text-scan.js — CLI del detector de texto IA.
//
// El matcher (hooks/scripts/lib/ai-text-detector.js) solo lo consumia el hook
// PostToolUse, que avisa DESPUES de escribir. La skill de analizar/reescribir
// necesita poder preguntarle ANTES de entregar, y necesita hacerlo de forma
// verificable — de ahi el exit code, que es lo que convierte "0 señales" en un
// gate de verdad y no en una promesa.
//
// Uso:
//   node scripts/ai-text-scan.js <fichero>
//   echo "texto" | node scripts/ai-text-scan.js -
//   node scripts/ai-text-scan.js <fichero> --json
//
// Exit: 0 = limpio · 1 = hay señales · 2 = error de uso.
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

function usage(msg) {
  process.stderr.write(
    `${msg}\n\nUso:\n` +
      `  node scripts/ai-text-scan.js <fichero> [--json]\n` +
      `  echo "texto" | node scripts/ai-text-scan.js - [--json] [--as <.md|.tex|.txt>]\n`
  );
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
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

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(report.matches.length ? 1 : 0);
  }

  if (!report.matches.length) {
    process.stdout.write(
      `LIMPIO — 0 señales sobre ${report.words} palabras ` +
        `(${report.total_patterns_scanned} patrones aplicados${ext === '.md' ? ', markup/guion largo omitidos por ser .md' : ''}).\n`
    );
    process.exit(0);
  }

  const lines = [
    `${report.matches.length} señal(es) en ${report.patterns_hit} patrón(es) — ` +
      `densidad ${report.density_per_100w.toFixed(1)}/100 palabras (${report.words} palabras).`,
    '',
  ];
  for (const m of report.matches) {
    lines.push(`[${m.pattern}]`);
    lines.push(`  regla    : ${m.rule}`);
    lines.push(`  evidencia: …${m.evidence}…`);
    if (m.correction) lines.push(`  correccion: ${m.correction}`);
    lines.push('');
  }
  process.stdout.write(lines.join('\n'));
  process.exit(1);
}

main();
