// Tests del MCP de escritorio: `node --test tools/ultron-desktop-mcp/server.test.mjs`.
// Levantan un puente FALSO (HTTP con el mismo contrato que mascot/bridge.rs)
// en un HOME temporal y hablan con el servidor real por stdio.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bridgeFile, handle } from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function fakeHome() {
  return mkdtempSync(join(tmpdir(), "ultron-mcp-"));
}

async function fakeBridge(home, token = "t0k") {
  const calls = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.headers["x-ultron-token"] !== token) {
        res.writeHead(401).end(JSON.stringify({ ok: false, error: "token inválido" }));
        return;
      }
      const v = JSON.parse(body);
      calls.push(v);
      let out = { ok: true };
      if (v.action === "screenshot")
        out = { ok: true, image_png_base64: "iVBORw0KGgo=", width: 1280, height: 720, screen_width: 2560, screen_height: 1440, scale: 2 };
      if (v.action === "cursor") out = { ok: true, x: 10, y: 20 };
      if (v.action === "windows") out = { ok: true, windows: [{ title: "Bloc de notas", left: 1, top: 2, right: 3, bottom: 4 }] };
      if (v.action === "key" && v.combo === "hyper+x") out = { ok: false, error: "tecla desconocida: «hyper»" };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const file = bridgeFile(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ port: srv.address().port, token }));
  return { calls, close: () => new Promise((r) => srv.close(r)) };
}

test("lista las herramientas y responde a initialize", async () => {
  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.ok(init.result.capabilities.tools);
  const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = list.result.tools.map((t) => t.name);
  for (const n of ["screenshot", "click", "type_text", "press_keys", "drag", "scroll", "mouse_move", "list_windows"]) {
    assert.ok(names.includes(n), n);
  }
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const unknown = await handle({ jsonrpc: "2.0", id: 3, method: "nope" });
  assert.equal(unknown.error.code, -32601);
});

test("reenvía al puente con el token y traduce las respuestas", async () => {
  const home = fakeHome();
  const b = await fakeBridge(home);
  try {
    const opts = { home };
    const click = await handle(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "click", arguments: { x: 5, y: 6, count: 2 } } },
      opts,
    );
    assert.equal(click.result.isError, undefined);
    assert.deepEqual(b.calls.at(-1), { action: "click", x: 5, y: 6, count: 2 });

    const shot = await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "screenshot" } }, opts);
    assert.equal(shot.result.content[0].type, "image");
    assert.match(shot.result.content[1].text, /1280×720/);

    const typed = await handle(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "type_text", arguments: { text: "hola", screenshot_after: true } },
      },
      opts,
    );
    assert.deepEqual(b.calls.at(-2), { action: "type", text: "hola" }, "screenshot_after no viaja al puente");
    assert.equal(typed.result.content.at(-2).type, "image");

    const wins = await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_windows" } }, opts);
    assert.match(wins.result.content[0].text, /Bloc de notas/);

    // Caso negativo: el puente rechaza la combinación → isError, no «ok».
    const bad = await handle(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "press_keys", arguments: { combo: "hyper+x" } } },
      opts,
    );
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /hyper/);
  } finally {
    await b.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("sin ULTRON abierto devuelve un error explícito", async () => {
  const home = fakeHome();
  try {
    const r = await handle(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "click", arguments: {} } },
      { home },
    );
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /no está abierto/);

    // Fichero del puente presente pero nadie escuchando.
    mkdirSync(dirname(bridgeFile(home)), { recursive: true });
    writeFileSync(bridgeFile(home), JSON.stringify({ port: 1, token: "x" }));
    const r2 = await handle(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "click", arguments: {} } },
      { home },
    );
    assert.equal(r2.result.isError, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("funciona como proceso stdio real", async () => {
  const child = spawn(process.execPath, [join(here, "server.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = [];
  child.stdout.setEncoding("utf8");
  let buf = "";
  const got = new Promise((resolve) => {
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        if (lines.length === 2) resolve();
      }
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  await got;
  child.stdin.end();
  assert.equal(lines[0].id, 1);
  assert.equal(lines[1].id, 2);
  assert.ok(lines[1].result.tools.length >= 9);
});
