import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.USERPROFILE || os.homedir();
const MANIFEST_PATH = path.join(__dirname, 'manifest.json');
const LOG_PATH = path.join(__dirname, 'reorg-log.jsonl');
const INDEX_PATH = path.join(__dirname, 'index.html');
const PORT = 4750;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.expo', 'coverage', 'Library', 'obj', 'bin', 'Logs', 'target', '.venv', '.codegraph', '.playwright-mcp', '.vercel']);
const TEXT_EXT = new Set(['.json', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.md', '.env', '.yml', '.yaml', '.toml', '.cfg', '.ini', '.ps1', '.sh', '.txt', '.cs', '.uproject', '.uplugin', '.config', '.xml', '.html', '.css']);

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}
function saveManifest(m) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2), 'utf8');
}

// Serializa toda mutacion load->await->save del manifiesto: sin esto, dos
// peticiones concurrentes (p.ej. un "Borrar" esperando a PowerShell mientras
// llegan varios "mover") pueden pisarse la escritura una a la otra (lost update).
let mutationQueue = Promise.resolve();
function withManifestLock(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.then(() => {}, () => {});
  return run;
}
function appendLog(entry) {
  fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
}

const MAX_SEGMENT_LEN = 60;

function slugifyOLD(s) {
  const out = s
    .slice(0, MAX_SEGMENT_LEN)
    .replace(/º/g, 'o').replace(/ª/g, 'a')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'item';
}

// Convencion de nombres (2026-08-19): PascalCase, sin espacios ni tildes,
// pero SI mayusculas (no forzar minusculas). "Football Stats" -> "FootballStats".
function slugify(s) {
  const words = s
    .slice(0, MAX_SEGMENT_LEN)
    .replace(/º/g, 'o').replace(/ª/g, 'a')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[\s_\-—–.]+/)
    .filter(Boolean)
    .map((w) => w.replace(/[^a-zA-Z0-9]+/g, ''))
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join('') || 'Item';
}

function slugifyRelPath(rel) {
  return rel.split('/').map(slugify).join('/');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function moveWhole(srcAbs, destAbs) {
  if (fs.existsSync(destAbs)) {
    const err = new Error('El destino ya existe: ' + destAbs);
    err.code = 'DEST_EXISTS';
    throw err;
  }
  ensureDir(path.dirname(destAbs));
  fs.renameSync(srcAbs, destAbs);
}

function moveContentsExcluding(srcAbs, destAbs, excludeNames) {
  if (fs.existsSync(destAbs)) {
    const err = new Error('El destino ya existe: ' + destAbs);
    err.code = 'DEST_EXISTS';
    throw err;
  }
  ensureDir(destAbs);
  const entries = fs.readdirSync(srcAbs);
  for (const name of entries) {
    if (excludeNames.includes(name)) continue;
    fs.renameSync(path.join(srcAbs, name), path.join(destAbs, name));
  }
  try { fs.rmdirSync(srcAbs); } catch { /* left with excluded content, fine */ }
}

function patchAbsolutePaths(dirAbs, oldAbs, newAbs) {
  const variants = [
    [oldAbs, newAbs],
    [oldAbs.replace(/\\/g, '/'), newAbs.replace(/\\/g, '/')],
    [oldAbs.replace(/\\/g, '\\\\'), newAbs.replace(/\\/g, '\\\\')],
  ];
  let patched = 0;
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (!TEXT_EXT.has(ext)) continue;
        const fp = path.join(dir, e.name);
        let content;
        try { content = fs.readFileSync(fp, 'utf8'); } catch { continue; }
        let changed = false;
        for (const [from, to] of variants) {
          if (content.includes(from)) {
            content = content.split(from).join(to);
            changed = true;
          }
        }
        if (changed) {
          fs.writeFileSync(fp, content, 'utf8');
          patched++;
        }
      }
    }
  }
  walk(dirAbs);
  return patched;
}

function recycleBinDelete(absPath) {
  return new Promise((resolve, reject) => {
    const cmd = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
$p = $env:TARGET_PATH
if (-not (Test-Path -LiteralPath $p)) { Write-Output 'NOTFOUND'; exit 0 }
if (Test-Path -LiteralPath $p -PathType Container) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
} else {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
}
Write-Output 'OK'
`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      env: { ...process.env, TARGET_PATH: absPath },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || ('powershell exit ' + code)));
    });
  });
}

async function deletePaths(relPaths) {
  const results = [];
  for (const rel of relPaths) {
    const abs = path.join(HOME, rel);
    try {
      const r = await recycleBinDelete(abs);
      results.push({ path: rel, ok: true, note: r });
      appendLog({ action: 'delete', path: rel, result: r });
    } catch (e) {
      results.push({ path: rel, ok: false, error: e.message });
      appendLog({ action: 'delete', path: rel, error: e.message });
    }
  }
  return results;
}

function findEmptyDirs(baseRel) {
  const baseAbs = path.join(HOME, baseRel);
  const empties = [];
  function isEmpty(dirAbs) {
    let entries;
    try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return false; }
    if (entries.length === 0) return true;
    let allSubEmpty = true;
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!isEmpty(path.join(dirAbs, e.name))) allSubEmpty = false;
      } else {
        allSubEmpty = false;
      }
    }
    return allSubEmpty && entries.every((e) => e.isDirectory());
  }
  let topEntries;
  try { topEntries = fs.readdirSync(baseAbs, { withFileTypes: true }); } catch { return []; }
  for (const e of topEntries) {
    if (!e.isDirectory()) continue;
    const abs = path.join(baseAbs, e.name);
    if (isEmpty(abs)) empties.push(path.join(baseRel, e.name).replace(/\\/g, '/'));
  }
  return empties;
}

function findOldFiles(baseRel, days) {
  const baseAbs = path.join(HOME, baseRel);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const old = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(abs);
      } else {
        let st;
        try { st = fs.statSync(abs); } catch { continue; }
        if (st.mtimeMs < cutoff) {
          old.push({ path: path.relative(HOME, abs).replace(/\\/g, '/'), size: st.size, mtime: st.mtime.toISOString().slice(0, 10) });
        }
      }
    }
  }
  walk(baseAbs);
  return old;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function resolveTarget(bucket, decision, targetName, customPath, category) {
  const cat = category ? slugify(category) + '/' : '';
  if (decision === 'personal') {
    return 'PERSONAL/ProyectosPersonales/' + cat + slugify(targetName);
  }
  if (decision === 'carrera') {
    return 'CARRERA/CURSOS_ANTERIORES/' + cat + slugify(targetName);
  }
  if (decision === 'profesional') {
    return 'PROFESIONAL/' + cat + slugify(targetName);
  }
  if (decision === 'custom') {
    return slugifyRelPath(customPath.replace(/\\/g, '/').replace(/^\/+/, ''));
  }
  throw new Error('decision inválida: ' + decision);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(INDEX_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/manifest') {
      sendJson(res, 200, loadManifest());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/log') {
      let lines = [];
      if (fs.existsSync(LOG_PATH)) {
        lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean).slice(-200).reverse().map((l) => {
          try { return JSON.parse(l); } catch { return { raw: l }; }
        });
      }
      sendJson(res, 200, { lines });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/classify') {
      const body = await readBody(req);
      const out = await withManifestLock(async () => {
        const m = loadManifest();
        const item = m.classify.find((i) => i.id === body.id);
        if (!item) return { code: 404, body: { error: 'item no encontrado' } };

        if (body.decision === 'skip') {
          item.status = 'skipped';
          saveManifest(m);
          return { code: 200, body: { ok: true, item } };
        }
        if (body.decision === 'delete') {
          const r = await deletePaths([item.path]);
          item.status = 'deleted';
          saveManifest(m);
          return { code: 200, body: { ok: true, item, result: r } };
        }

        const targetName = body.targetName || path.basename(item.path);
        const destRel = resolveTarget('classify', body.decision, targetName, body.customPath, body.category || item.category);
        const srcAbs = path.join(HOME, item.path);
        const destAbs = path.join(HOME, destRel);
        try {
          if (item.excludeSubpath) {
            moveContentsExcluding(srcAbs, destAbs, [item.excludeSubpath]);
          } else {
            moveWhole(srcAbs, destAbs);
          }
        } catch (e) {
          return { code: 409, body: { error: e.message, code: e.code || null } };
        }
        let patched = 0;
        if (item.absPaths && item.absPaths > 0) {
          patched = patchAbsolutePaths(destAbs, srcAbs, destAbs);
        }
        item.status = 'moved';
        item.movedTo = destRel;
        saveManifest(m);
        appendLog({ action: 'move', from: item.path, to: destRel, patchedFiles: patched });
        return { code: 200, body: { ok: true, item, patched } };
      });
      return sendJson(res, out.code, out.body);
    }

    if (req.method === 'POST' && url.pathname === '/api/classify-group') {
      const body = await readBody(req);
      const out = await withManifestLock(async () => {
        const m = loadManifest();
        const item = m.classifyGroups.find((i) => i.id === body.id);
        if (!item) return { code: 404, body: { error: 'grupo no encontrado' } };

        if (body.decision === 'skip') {
          item.status = 'skipped';
          saveManifest(m);
          return { code: 200, body: { ok: true, item } };
        }
        if (body.decision === 'delete') {
          const rels = item.files.map((f) => item.dir + '/' + f);
          const r = await deletePaths(rels);
          item.status = 'deleted';
          saveManifest(m);
          return { code: 200, body: { ok: true, item, result: r } };
        }

        const targetName = body.targetName || item.id;
        const destRel = resolveTarget('classifyGroups', body.decision, targetName, body.customPath, body.category || item.category);
        const destAbs = path.join(HOME, destRel);
        ensureDir(destAbs);
        const moved = [];
        for (const f of item.files) {
          const srcAbs = path.join(HOME, item.dir, f);
          const dAbs = path.join(destAbs, f);
          if (!fs.existsSync(srcAbs)) continue;
          if (fs.existsSync(dAbs)) continue;
          fs.renameSync(srcAbs, dAbs);
          moved.push(f);
        }
        item.status = 'moved';
        item.movedTo = destRel;
        saveManifest(m);
        appendLog({ action: 'move-group', from: item.dir, files: moved, to: destRel });
        return { code: 200, body: { ok: true, item, moved } };
      });
      return sendJson(res, out.code, out.body);
    }

    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const body = await readBody(req);
      const out = await withManifestLock(async () => {
        const m = loadManifest();
        const item = m.ask.find((i) => i.id === body.id);
        if (!item) return { code: 404, body: { error: 'item no encontrado' } };
        if (body.decision === 'delete') {
          await deletePaths(item.paths);
          item.status = 'deleted';
        } else if (body.decision === 'keep') {
          item.status = 'kept';
          appendLog({ action: 'keep', paths: item.paths });
        } else if (body.decision === 'later') {
          item.status = 'later';
        }
        saveManifest(m);
        return { code: 200, body: { ok: true, item } };
      });
      return sendJson(res, out.code, out.body);
    }

    if (req.method === 'POST' && url.pathname === '/api/safe-delete') {
      const body = await readBody(req);
      const out = await withManifestLock(async () => {
        const m = loadManifest();
        const ids = new Set(body.ids || []);
        const results = [];
        for (const item of m.safeDelete) {
          if (!ids.has(item.id) || item.status === 'deleted') continue;
          const r = await deletePaths(item.paths);
          item.status = 'deleted';
          results.push({ id: item.id, result: r });
        }
        saveManifest(m);
        return { code: 200, body: { ok: true, results } };
      });
      return sendJson(res, out.code, out.body);
    }

    if (req.method === 'GET' && url.pathname === '/api/empty-dirs') {
      const base = url.searchParams.get('base') || 'Downloads';
      const dirs = findEmptyDirs(base);
      return sendJson(res, 200, { base, dirs });
    }

    if (req.method === 'POST' && url.pathname === '/api/empty-dirs/delete') {
      const body = await readBody(req);
      const r = await withManifestLock(() => deletePaths(body.paths || []));
      return sendJson(res, 200, { ok: true, result: r });
    }

    if (req.method === 'GET' && url.pathname === '/api/old-files') {
      const base = url.searchParams.get('dir') || 'Pictures/Screenshots';
      const days = parseInt(url.searchParams.get('days') || '90', 10);
      const files = findOldFiles(base, days);
      return sendJson(res, 200, { base, days, files });
    }

    if (req.method === 'POST' && url.pathname === '/api/old-files/delete') {
      const body = await readBody(req);
      const r = await withManifestLock(() => deletePaths(body.paths || []));
      return sendJson(res, 200, { ok: true, result: r });
    }

    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    sendJson(res, 500, { error: e.message, stack: e.stack });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ULTRON home-reorg escuchando en http://localhost:${PORT}`);
});
