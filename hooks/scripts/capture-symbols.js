#!/usr/bin/env node
// hooks/scripts/capture-symbols.js — PostToolUse hook (Edit|Write|MultiEdit).
//
// Captura DONDE viven los simbolos (archivo:simbolo:linea) y decisiones de
// arquitectura/config como CANDIDATOS gobernados. Dos ramas:
//   CODE  (fuentes): regex top-level sobre lineas anadidas -> codebase_fact 0.95.
//   ARCH  (Cargo.toml/package.json/migrations/docker-compose/settings/docs ADR):
//         resumen del cambio -> decision 0.7.
//
// CORRECCIONES VERIFICADAS CONTRA EL BINARIO REAL (2026-06-05):
//   * NO existe MemoryType `code_location` (se cae a Fact silenciosamente).
//     MemoryType validos: preference|fact|decision|constraint|task|
//     workflow_state|codebase_fact|skill|agent_note|session_summary|
//     error_resolution|architecture|tool_usage|user_profile. -> uso
//     `codebase_fact` para simbolos y dejo `code_location` como TAG filtrable.
//   * `recall` devuelve { entries: [...] } (NO `items`). lookupSymbol lee entries.
//   * el subcomando `candidate` lee {type,scope,summary,title,content,project,
//     tags,importance,session_id}. Las claves symbol/file_path/line/signature/
//     source/confidence/recommended_action se DOBLAN en summary+tags (sobreviven
//     hoy) y se emiten ademas como claves JSON de primera clase, IGNORADAS por el
//     binario actual (forward-compatible para cuando la migracion Rust las anada).
//
// PIPELINE (barato->caro, corta pronto):
//   1. whitelist extensiones + blacklist paths (descarta ~90% gratis)
//   2. lineas cambiadas del tool_input; skip si vacio/whitespace/comentario
//   3. regex simbolos solo sobre lineas cambiadas (no reparsea el archivo)
//   4. debounce seen.json (300s code / 1h arch)
//   5. dedup via `recall` (mismo simbolo@linea ya activo -> skip; linea distinta
//      -> update)
//   6. emit via `candidate` (escritor unico; redaccion+dedup+auto_approve en Rust)
//
// FAIL-SAFE: cualquier error -> additionalContext vacio, exit 0.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCli, logMs } = require('./lib/ultron-memory-cli');

const HOME = os.homedir();
const SEEN_PATH = path.join(HOME, '.ultron', '.tmp', 'symbol-capture-seen.json');
const SEEN_MAX = 5000;
const DEBOUNCE_CODE_MS = 300 * 1000;
const DEBOUNCE_ARCH_MS = 60 * 60 * 1000;
const SESSION_CODE_CAP = 200;
const CANDIDATE_TIMEOUT_MS = 6000;
const RECALL_TIMEOUT_MS = 4000;

const CODE_EXT = new Set(['.rs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.cs', '.go']);
const ARCH_FILES = new Set(['cargo.toml', 'package.json', 'docker-compose.yml', 'docker-compose.yaml', 'settings.json', 'settings.local.json', 'pyproject.toml', 'go.mod']);
const ARCH_GLOBS = [/\.config\.(js|ts|json)$/i, /migrations[\\/].+\.sql$/i, /(^|[\\/])adr[\\/].+\.md$/i, /(^|[\\/])docs[\\/].+\.md$/i];
const BLACKLIST = /(^|[\\/])(node_modules|target|dist|build|\.git|vendor|\.next|coverage)[\\/]/i;
const LANG_BY_EXT = { '.rs': 'rust', '.ts': 'ts', '.tsx': 'ts', '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.py': 'python', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.go': 'go' };

const SYMBOL_RES = {
  rust: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_]\w*)/],
  ts: [/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/],
  js: [/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/],
  python: [/^\s*def\s+([A-Za-z_]\w*)/, /^\s*class\s+([A-Za-z_]\w*)/],
  cpp: [/^\s*(?:[\w:<>,&*\s]+?\s+)?([A-Za-z_]\w*)\s*\([^;{]*\)\s*(?:const)?\s*\{?\s*$/, /^\s*(?:class|struct)\s+([A-Za-z_]\w*)/],
  csharp: [/^\s*(?:public|private|protected|internal|static|\s)+[\w<>,\[\]]+\s+([A-Za-z_]\w*)\s*\(/, /^\s*(?:public|private|protected|internal|\s)*(?:class|struct|interface|enum|record)\s+([A-Za-z_]\w*)/],
  go: [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/],
};
const COMMENT_PREFIX = /^\s*(\/\/|#|\*|\/\*|--)/;

function emit(c) { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: c || '' } })); }
function projectSlugFromPath(filePath, cwd) { try { const base = path.basename(cwd || process.cwd()); return base.replace(/^\.+/, '') || null; } catch { return null; } }
function relPath(filePath, cwd) { try { const rel = path.relative(cwd || process.cwd(), filePath); return rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : filePath.replace(/\\/g, '/'); } catch { return filePath; } }
function loadSeen() { try { const j = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
function saveSeen(seen) { try { let keys = Object.keys(seen); if (keys.length > SEEN_MAX) { keys = keys.sort((a, b) => (seen[a].ts || 0) - (seen[b].ts || 0)).slice(keys.length - SEEN_MAX); const t = {}; for (const k of keys) t[k] = seen[k]; seen = t; } fs.mkdirSync(path.dirname(SEEN_PATH), { recursive: true }); fs.writeFileSync(SEEN_PATH, JSON.stringify(seen)); } catch { /* ignore */ } }
function sessionCountAndBump(seen, n) { const now = Date.now(); const s = seen.__session && now - (seen.__session.start || 0) < 6 * 3600 * 1000 ? seen.__session : { start: now, count: 0 }; s.count += n; seen.__session = s; return s.count; }
function changedLines(toolName, toolInput) { const lines = []; if (!toolInput) return lines; const pushBlock = (txt) => { if (typeof txt === 'string') for (const l of txt.split(/\r?\n/)) lines.push(l); }; if (typeof toolInput.content === 'string') pushBlock(toolInput.content); if (typeof toolInput.new_string === 'string') pushBlock(toolInput.new_string); if (Array.isArray(toolInput.edits)) { for (const e of toolInput.edits) if (e && typeof e.new_string === 'string') pushBlock(e.new_string); } return lines; }
function isMeaningful(lines) { return lines.some((l) => l.trim() && !COMMENT_PREFIX.test(l)); }
function extractSymbols(lines, lang) { const res = SYMBOL_RES[lang]; if (!res) return []; const out = []; for (const line of lines) { if (!line.trim() || COMMENT_PREFIX.test(line)) continue; for (const re of res) { const m = re.exec(line); if (m && m[1]) { out.push({ name: m[1], signature: line.trim().slice(0, 200) }); break; } } } const seen = new Set(); return out.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true))); }
function locateLine(absFile, name, lang) { try { const text = fs.readFileSync(absFile, 'utf8'); const fileLines = text.split(/\r?\n/); const res = SYMBOL_RES[lang] || []; for (let i = 0; i < fileLines.length; i++) { const l = fileLines[i]; if (COMMENT_PREFIX.test(l)) continue; for (const re of res) { const m = re.exec(l); if (m && m[1] === name) return i + 1; } } } catch { /* unreadable */ } return null; }
// recall devuelve { entries: [...] } (verificado). Antes leia r.items (bug).
function lookupSymbol(symbolKey) { const r = runCli(['recall', symbolKey], { timeoutMs: RECALL_TIMEOUT_MS }); if (!r) return { exists: false }; const items = Array.isArray(r.entries) ? r.entries : Array.isArray(r.items) ? r.items : Array.isArray(r) ? r : []; for (const it of items) { const sum = (it.summary || '').toString(); if (sum.includes(symbolKey)) { const m = /:(\d+)\b/.exec(sum.split(symbolKey)[1] || ''); return { exists: true, line: m ? Number(m[1]) : null, id: it.canonical_id || it.id }; } } return { exists: false }; }
function emitCandidate(payload) { const r = runCli(['candidate'], { stdin: JSON.stringify(payload), timeoutMs: CANDIDATE_TIMEOUT_MS }); return r && r.candidate_id ? r.candidate_id : null; }
function isArchFile(absFile) { const base = path.basename(absFile).toLowerCase(); if (ARCH_FILES.has(base)) return true; return ARCH_GLOBS.some((re) => re.test(absFile.replace(/\\/g, '/'))); }
function summariseArch(absFile, lines) { const base = path.basename(absFile).toLowerCase(); const added = lines.filter((l) => l.trim() && !COMMENT_PREFIX.test(l)).slice(0, 4); let what = 'cambio de configuracion'; let tags = ['arch']; if (base === 'cargo.toml' || base === 'package.json' || base === 'go.mod') { what = 'cambio de dependencias'; tags = ['arch', 'dependency']; } else if (/\.sql$/i.test(absFile)) { what = 'cambio de esquema (migracion)'; tags = ['arch', 'schema']; } else if (/docker-compose/.test(base)) { what = 'cambio de servicios (infra)'; tags = ['arch', 'infra']; } else if (/settings\.json/.test(base)) { what = 'cambio de configuracion de hooks/settings'; tags = ['arch', 'config']; } const snippet = added.join(' | ').slice(0, 200); return { what, tags, snippet }; }

function main() {
  let inp = {};
  try { inp = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { emit(''); return; }
  const cwd = inp.cwd || process.cwd();
  const toolName = inp.tool_name || '';
  const toolInput = inp.tool_input || {};
  const absFile = toolInput.file_path || toolInput.filePath || '';
  if (!absFile || BLACKLIST.test(absFile.replace(/\\/g, '/'))) { emit(''); return; }
  const ext = path.extname(absFile).toLowerCase();
  const arch = isArchFile(absFile);
  if (!arch && !CODE_EXT.has(ext)) { emit(''); return; }
  const lines = changedLines(toolName, toolInput);
  if (!isMeaningful(lines)) { emit(''); return; }
  const project = projectSlugFromPath(absFile, cwd);
  const rel = relPath(absFile, cwd);
  const started = Date.now();
  const seen = loadSeen();

  if (arch) {
    const key = `arch:${rel}`;
    const prev = seen[key];
    if (prev && Date.now() - (prev.ts || 0) < DEBOUNCE_ARCH_MS) { emit(''); return; }
    const { what, tags, snippet } = summariseArch(absFile, lines);
    const summary = `Decision tecnica: ${what} en ${rel}${snippet ? ` — ${snippet}` : ''}`;
    const payload = { type: 'decision', scope: project ? 'project' : 'global', summary, project, importance: 0.6, tags, source: 'posttooluse_arch', confidence: 0.7, file_path: rel };
    const id = emitCandidate(payload);
    seen[key] = { ts: Date.now() };
    saveSeen(seen);
    logMs({ cmd: 'capture-symbols/arch', file: rel, created: !!id, ms: Date.now() - started });
    emit(''); return;
  }

  const lang = LANG_BY_EXT[ext];
  const symbols = extractSymbols(lines, lang);
  if (!symbols.length) { emit(''); return; }
  let created = 0, skipped = 0;
  for (const sym of symbols) {
    const line = locateLine(absFile, sym.name, lang);
    if (!line) { skipped++; continue; }
    const symbolKey = `${rel}:${sym.name}`;
    const ledgerKey = `${symbolKey}@${line}`;
    const prev = seen[ledgerKey];
    if (prev && Date.now() - (prev.ts || 0) < DEBOUNCE_CODE_MS) { skipped++; continue; }
    const known = lookupSymbol(symbolKey);
    if (known.exists && known.line === line) { seen[ledgerKey] = { ts: Date.now() }; skipped++; continue; }
    const action = known.exists ? 'update' : 'create';
    const overCap = sessionCountAndBump(seen, 1) > SESSION_CODE_CAP;
    const summary = `\`${sym.name}\` definido en ${symbolKey}:${line} — ${sym.signature}`;
    // type=codebase_fact: MemoryType canonico que SI parsea (no existe
    // code_location -> caeria a Fact). code_location queda como TAG filtrable.
    const payload = { type: 'codebase_fact', scope: project ? 'project' : 'global', summary, project, importance: 0.4, tags: ['code_location', lang, action === 'update' ? 'moved' : 'new'], source: 'posttooluse_symbol', confidence: overCap ? 0.6 : 0.95, symbol: symbolKey, file_path: rel, line, signature: sym.signature, recommended_action: action };
    const id = emitCandidate(payload);
    if (id) created++; else skipped++;
    seen[ledgerKey] = { ts: Date.now() };
  }
  saveSeen(seen);
  logMs({ cmd: 'capture-symbols/code', file: rel, lang, symbols: symbols.length, created, skipped, ms: Date.now() - started });
  emit('');
}

try { main(); } catch { try { emit(''); } catch { /* ignore */ } }
process.exitCode = 0;

