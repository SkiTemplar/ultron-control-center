/**
 * Selftest de la guarda de origen local de tools/home-reorg/server.mjs.
 *
 * El servidor borra y mueve ficheros del home. Sin guarda, cualquier web abierta
 * mientras está encendido podía mandar un POST text/plain (sin preflight) con
 * `decision: delete` y, con DNS rebinding, leer el manifiesto.
 *
 * Hermético: copia server.mjs e index.html a un directorio temporal (el servidor
 * resuelve manifiesto y log respecto a su propio fichero) y apunta el home a ese
 * directorio, así que ningún caso puede tocar el manifiesto ni el home reales.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SOURCE_DIR = path.resolve(import.meta.dirname, '..', 'tools', 'home-reorg');
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 100;

let failures = 0;
function check(name, isOk, detail = '') {
  if (isOk) {
    console.log(`ok     ${name}`);
    return;
  }
  failures++;
  console.error(`FALLO  ${name}${detail ? `\n       ${detail}` : ''}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Petición con cabeceras exactas: `setHost: false` permite falsificar Host. */
function send(port, { method = 'GET', url = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers, setHost: false, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-reorg-guard-'));
  const appDir = path.join(root, 'app');
  const home = path.join(root, 'home');
  fs.mkdirSync(appDir);
  fs.mkdirSync(home);
  for (const name of ['server.mjs', 'index.html']) {
    fs.copyFileSync(path.join(SOURCE_DIR, name), path.join(appDir, name));
  }
  const victims = ['victima.txt', 'legit.txt', 'ask.txt', 'safe.txt', 'suelto.txt'];
  for (const name of victims) fs.writeFileSync(path.join(home, name), 'contenido', 'utf8');
  const manifest = {
    classify: [
      { id: 'victima', path: 'victima.txt', status: 'pending' },
      { id: 'legit', path: 'legit.txt', status: 'pending' },
    ],
    classifyGroups: [],
    ask: [{ id: 'ask1', paths: ['ask.txt'], status: 'pending' }],
    safeDelete: [{ id: 'safe1', paths: ['safe.txt'], status: 'pending' }],
  };
  const manifestPath = path.join(appDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { root, home, manifestPath, victims };
}

async function startServer(fixture, port) {
  const child = spawn(process.execPath, [path.join(fixture.root, 'app', 'server.mjs')], {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      USERPROFILE: fixture.home,
      HOME: fixture.home,
      HOME_REORG_PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await send(port, { url: '/api/log', headers: { Host: `127.0.0.1:${port}` } });
      return child;
    } catch (e) {
      if (e.code !== 'ECONNREFUSED') throw e;
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  }
  child.kill();
  throw new Error(`el servidor no respondió en ${READY_TIMEOUT_MS} ms`);
}

/** Todos llevan un cuerpo que, sin guarda, borra o lee algo del home temporal. */
function maliciousCases(port) {
  const host = { Host: `127.0.0.1:${port}` };
  const json = { ...host, 'Content-Type': 'application/json' };
  const deleteVictim = JSON.stringify({ id: 'victima', decision: 'delete' });
  const post = (url, body, headers) => ({ method: 'POST', url, body, headers });
  return [
    ['POST text/plain sin preflight', 415, post('/api/classify', deleteVictim, { ...host, 'Content-Type': 'text/plain' })],
    ['POST sin Content-Type', 415, post('/api/classify', deleteVictim, host)],
    ['POST de formulario', 415, post('/api/classify', deleteVictim, { ...host, 'Content-Type': 'application/x-www-form-urlencoded' })],
    ['POST application/jsonp', 415, post('/api/classify', deleteVictim, { ...host, 'Content-Type': 'application/jsonp' })],
    ['POST text/plain con json como parámetro', 415, post('/api/classify', deleteVictim, { ...host, 'Content-Type': 'text/plain; x=application/json' })],
    ['safe-delete text/plain', 415, post('/api/safe-delete', '{"ids":["safe1"]}', { ...host, 'Content-Type': 'text/plain' })],
    ['old-files/delete text/plain', 415, post('/api/old-files/delete', '{"paths":["suelto.txt"]}', { ...host, 'Content-Type': 'text/plain' })],
    ['Origin ajeno', 403, post('/api/classify', deleteVictim, { ...json, Origin: 'https://evil.example' })],
    ['Origin null (iframe aislado o file://)', 403, post('/api/classify', deleteVictim, { ...json, Origin: 'null' })],
    ['Origin de otro puerto local', 403, post('/api/classify', deleteVictim, { ...json, Origin: `http://127.0.0.1:${port + 1}` })],
    ['Origin con prefijo propio', 403, post('/api/classify', deleteVictim, { ...json, Origin: `http://localhost:${port}.evil.example` })],
    ['Sec-Fetch-Site cross-site', 403, post('/api/classify', deleteVictim, { ...json, 'Sec-Fetch-Site': 'cross-site' })],
    ['Sec-Fetch-Site same-site (otro puerto de localhost)', 403, post('/api/classify', deleteVictim, { ...json, 'Sec-Fetch-Site': 'same-site' })],
    ['Host de DNS rebinding', 403, post('/api/classify', deleteVictim, { Host: `evil.example:${port}`, 'Content-Type': 'application/json' })],
    ['Host loopback con otro puerto', 403, post('/api/classify', deleteVictim, { Host: `127.0.0.1:${port + 1}`, 'Content-Type': 'application/json' })],
    ['Host con prefijo loopback', 403, post('/api/classify', deleteVictim, { Host: `localhost.evil.example:${port}`, 'Content-Type': 'application/json' })],
    ['Host loopback sin puerto', 403, post('/api/classify', deleteVictim, { Host: 'localhost', 'Content-Type': 'application/json' })],
    ['GET del manifiesto con DNS rebinding', 403, { url: '/api/manifest', headers: { Host: `evil.example:${port}` } }],
    ['GET del manifiesto cross-site', 403, { url: '/api/manifest', headers: { ...host, 'Sec-Fetch-Site': 'cross-site' } }],
    ['GET de la portada con DNS rebinding', 403, { url: '/', headers: { Host: `evil.example:${port}` } }],
    ['GET del log con DNS rebinding', 403, { url: '/api/log', headers: { Host: `evil.example:${port}` } }],
  ];
}

async function runMalicious(fixture, port) {
  const before = fs.readFileSync(fixture.manifestPath, 'utf8');
  for (const [name, expected, request] of maliciousCases(port)) {
    const res = await send(port, request);
    check(`rechaza: ${name} -> ${expected}`, res.status === expected, `status=${res.status}`);
    check(`no filtra el manifiesto: ${name}`, !res.text.includes('victima.txt'));
  }
  check('el manifiesto sigue intacto tras los rechazos', fs.readFileSync(fixture.manifestPath, 'utf8') === before);
  for (const name of fixture.victims) {
    check(`sigue en el home: ${name}`, fs.existsSync(path.join(fixture.home, name)));
  }
}

function itemStatus(fixture, section, id) {
  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
  return manifest[section].find((i) => i.id === id).status;
}

async function runLegitimate(fixture, port) {
  const own = `127.0.0.1:${port}`;
  const local = `localhost:${port}`;
  const page = await send(port, { url: '/', headers: { Host: local, 'Sec-Fetch-Site': 'none' } });
  check('navegación tecleada a la portada -> 200', page.status === 200 && page.text.includes('<html'), `status=${page.status}`);

  const read = await send(port, { url: '/api/manifest', headers: { Host: local, 'Sec-Fetch-Site': 'same-origin' } });
  check('fetch del mismo origen lee el manifiesto', read.status === 200 && read.text.includes('victima.txt'), `status=${read.status}`);

  const browserPost = await send(port, {
    method: 'POST',
    url: '/api/classify',
    body: JSON.stringify({ id: 'legit', decision: 'skip' }),
    headers: { Host: local, Origin: `http://${local}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
  });
  check('POST de la propia página -> 200', browserPost.status === 200, `status=${browserPost.status} ${browserPost.text}`);
  check('el POST de la propia página se aplica', itemStatus(fixture, 'classify', 'legit') === 'skipped');

  const toolPost = await send(port, {
    method: 'POST',
    url: '/api/ask',
    body: JSON.stringify({ id: 'ask1', decision: 'keep' }),
    headers: { Host: own, 'Content-Type': 'Application/JSON; charset=UTF-8' },
  });
  check('POST de CLI sin Origin y con charset -> 200', toolPost.status === 200, `status=${toolPost.status} ${toolPost.text}`);
  check('el POST de CLI se aplica', itemStatus(fixture, 'ask', 'ask1') === 'kept');

  const ipv6 = await send(port, { url: '/api/log', headers: { Host: `[::1]:${port}`, Origin: `http://[::1]:${port}` } });
  check('Host y Origin [::1] con su puerto -> 200', ipv6.status === 200, `status=${ipv6.status}`);
}

/** El cliente real: cada POST de index.html debe declarar el Content-Type. */
function checkIndexClient() {
  const html = fs.readFileSync(path.join(SOURCE_DIR, 'index.html'), 'utf8');
  const posts = html.match(/method:\s*'POST'/g) || [];
  const jsonPosts = html.match(/method:\s*'POST',\s*headers:\s*\{\s*'Content-Type':\s*'application\/json'/g) || [];
  check(`index.html: sus ${posts.length} POST declaran application/json`, posts.length > 0 && posts.length === jsonPosts.length, `json=${jsonPosts.length}`);
}

async function main() {
  checkIndexClient();
  const fixture = createFixture();
  const port = await freePort();
  const child = await startServer(fixture, port);
  try {
    await runMalicious(fixture, port);
    await runLegitimate(fixture, port);
  } finally {
    child.kill();
    fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

try {
  await main();
} catch (e) {
  failures++;
  console.error(`FALLO  error inesperado: ${e.stack || e}`);
}
if (failures > 0) {
  console.error(`\n${failures} fallo(s)`);
  process.exit(1);
}
console.log('\nhome-reorg-guard: todo ok');
