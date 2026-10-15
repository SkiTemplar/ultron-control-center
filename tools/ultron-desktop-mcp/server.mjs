#!/usr/bin/env node
// ULTRON · MCP de escritorio (stdio, sin dependencias).
//
// Da a Claude Code en terminal control del escritorio de Windows: capturas,
// ratón, rueda, teclado y lista de ventanas. Este proceso NO toca Windows:
// reenvía cada herramienta al puente HTTP local de ULTRON Control Center
// (src-tauri/src/mascot/bridge.rs), que ejecuta la acción y hace que la
// mascota lleve el cursor hasta el punto.
//
// Registro (o el botón de Settings → Mascota):
//   claude mcp add --scope user ultron-desktop -- node "<ruta>/server.mjs"
//
// Puerto y token: ~/.ultron/cockpit/mascot-bridge.json (los escribe la app
// al arrancar; se relee en cada llamada, así que reiniciar ULTRON no obliga
// a reiniciar Claude Code). Sin ULTRON abierto, cada herramienta devuelve un
// error que lo dice; nunca un «ok» falso.

import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const SERVER = { name: "ultron-desktop", version: "1.0.0" };
const PROTOCOL = "2025-06-18";

export function bridgeFile(home = homedir()) {
  return join(home, ".ultron", "cockpit", "mascot-bridge.json");
}

const xy = {
  x: { type: "number", description: "X en píxeles de la ÚLTIMA captura (screenshot)." },
  y: { type: "number", description: "Y en píxeles de la ÚLTIMA captura (screenshot)." },
};
const after = {
  screenshot_after: {
    type: "boolean",
    description: "Devolver una captura nueva ~0,5 s después de la acción (ahorra una llamada).",
  },
};

export const TOOLS = [
  {
    name: "screenshot",
    description:
      "Captura el monitor principal. Las coordenadas del resto de herramientas son las de esta imagen (reducida a 1280 px de ancho como mucho).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mouse_move",
    description: "Mueve el cursor a (x, y). La mascota de ULTRON lo lleva volando.",
    inputSchema: { type: "object", properties: { ...xy }, required: ["x", "y"] },
  },
  {
    name: "click",
    description: "Clic en (x, y), o donde esté el cursor si no se dan coordenadas.",
    inputSchema: {
      type: "object",
      properties: {
        ...xy,
        button: { type: "string", enum: ["left", "right", "middle"], description: "Por defecto left." },
        count: { type: "integer", minimum: 1, maximum: 3, description: "2 = doble clic." },
        ...after,
      },
    },
  },
  {
    name: "drag",
    description: "Arrastra con el botón pulsado de (x, y) a (to_x, to_y).",
    inputSchema: {
      type: "object",
      properties: {
        ...xy,
        to_x: { type: "number" },
        to_y: { type: "number" },
        button: { type: "string", enum: ["left", "right", "middle"] },
        ...after,
      },
      required: ["x", "y", "to_x", "to_y"],
    },
  },
  {
    name: "scroll",
    description: "Rueda del ratón en «muescas». dy > 0 sube el contenido, dy < 0 lo baja; dx horizontal.",
    inputSchema: {
      type: "object",
      properties: { ...xy, dy: { type: "integer" }, dx: { type: "integer" }, ...after },
    },
  },
  {
    name: "type_text",
    description: "Escribe texto (Unicode, saltos de línea = Enter) en la ventana con el foco.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, ...after },
      required: ["text"],
    },
  },
  {
    name: "press_keys",
    description: "Pulsa una combinación: «enter», «ctrl+c», «alt+tab», «win+r», «ctrl+shift+esc», «f5»…",
    inputSchema: {
      type: "object",
      properties: { combo: { type: "string" }, ...after },
      required: ["combo"],
    },
  },
  {
    name: "cursor_position",
    description: "Posición actual del cursor (coordenadas de captura).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_windows",
    description: "Ventanas visibles de arriba abajo en orden Z, con título y rectángulo (coordenadas de captura).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wait",
    description: "Espera unos segundos (máx. 30) a que la interfaz reaccione.",
    inputSchema: {
      type: "object",
      properties: { seconds: { type: "number", minimum: 0, maximum: 30 } },
      required: ["seconds"],
    },
  },
];

const ACTION = {
  mouse_move: "move",
  click: "click",
  drag: "drag",
  scroll: "scroll",
  type_text: "type",
  press_keys: "key",
  cursor_position: "cursor",
  list_windows: "windows",
};

export function callBridge(body, { home = homedir(), timeoutMs = 60_000 } = {}) {
  let info;
  try {
    info = JSON.parse(readFileSync(bridgeFile(home), "utf8"));
  } catch {
    return Promise.reject(
      new Error("ULTRON Control Center no está abierto (no encuentro ~/.ultron/cockpit/mascot-bridge.json)."),
    );
  }
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: info.port,
        path: "/v1/action",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          "X-Ultron-Token": info.token,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (v.ok === false) reject(new Error(v.error || `error del puente (HTTP ${res.statusCode})`));
            else resolve(v);
          } catch (e) {
            reject(new Error(`respuesta inválida del puente: ${e.message}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("el puente de ULTRON no respondió a tiempo")));
    req.on("error", (e) =>
      reject(
        e.code === "ECONNREFUSED"
          ? new Error("ULTRON Control Center no está abierto (el puente no responde).")
          : e,
      ),
    );
    req.end(payload);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function screenshotContent(opts) {
  const s = await callBridge({ action: "screenshot" }, opts);
  return [
    { type: "image", data: s.image_png_base64, mimeType: "image/png" },
    {
      type: "text",
      text: `Captura ${s.width}×${s.height} (pantalla real ${s.screen_width}×${s.screen_height}). Usa coordenadas de esta imagen.`,
    },
  ];
}

export async function callTool(name, args = {}, opts = {}) {
  if (name === "screenshot") return { content: await screenshotContent(opts) };
  if (name === "wait") {
    const s = Math.min(Math.max(Number(args.seconds) || 0, 0), 30);
    await sleep(s * 1000);
    return { content: [{ type: "text", text: `Esperados ${s} s.` }] };
  }
  const action = ACTION[name];
  if (!action) throw new Error(`herramienta desconocida: ${name}`);
  const { screenshot_after, ...rest } = args;
  const r = await callBridge({ action, ...rest }, opts);
  let text = "ok";
  if (name === "cursor_position") text = `Cursor en (${r.x}, ${r.y}).`;
  if (name === "list_windows") {
    text = r.windows.length
      ? r.windows
          .map((w, i) => `${i + 1}. «${w.title}» [${w.left}, ${w.top}] → [${w.right}, ${w.bottom}]`)
          .join("\n")
      : "No hay ventanas visibles.";
  }
  const content = [{ type: "text", text }];
  if (screenshot_after) {
    await sleep(500);
    content.push(...(await screenshotContent(opts)));
  }
  return { content };
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 sobre stdio (un mensaje por línea)
// ---------------------------------------------------------------------------

export async function handle(msg, opts = {}) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: params?.protocolVersion || PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER,
          instructions:
            "Control del escritorio de Windows a través de ULTRON Control Center (debe estar abierto). " +
            "Empieza con screenshot y usa siempre coordenadas de la última captura.",
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call":
        try {
          result = await callTool(params?.name, params?.arguments ?? {}, opts);
        } catch (e) {
          result = { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
        break;
      default:
        if (!isRequest) return null; // notificaciones (initialized, cancelled…)
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `método desconocido: ${method}` } };
    }
    return isRequest ? { jsonrpc: "2.0", id, result } : null;
  } catch (e) {
    return isRequest ? { jsonrpc: "2.0", id, error: { code: -32603, message: e.message } } : null;
  }
}

function main() {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } }) + "\n",
      );
      return;
    }
    const out = await handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  });
  rl.on("close", () => process.exit(0));
}

// Ejecutado directamente (no importado por los tests).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
