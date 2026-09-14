#!/usr/bin/env node
// mcp-memory-server.mjs — la memoria de ULTRON expuesta como MCP server.
//
// Igual que codegraph expone el grafo de codigo, esto expone brain.db+Qdrant
// (recall hibrido del sidecar) a CUALQUIER cliente MCP: Claude Code, Codex,
// Gemini CLI... El server es un traductor fino: protocolo MCP (JSON-RPC 2.0
// por stdio, un JSON por linea) -> subprocesos del binario ultron-memory.exe,
// que resuelve contra el daemon si esta vivo (sub-segundo) o en one-shot.
// Zero-dep a proposito (mismo criterio que los hooks): sin SDK, el protocolo
// minimo son 3 metodos (initialize / tools/list / tools/call).
//
// Registro:  claude mcp add --scope user ultron-memory -- cmd /c node <este fichero>
// Prueba:    node scripts/mcp-memory-server.selftest.mjs

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const BIN = path.join(homedir(), ".ultron", "bin",
  process.platform === "win32" ? "ultron-memory.exe" : "ultron-memory");

const SERVER_INFO = { name: "ultron-memory", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "memory_recall",
    description:
      "Busca en la memoria personal de ULTRON (recall hibrido BM25+E5 sobre brain.db/Qdrant). " +
      "Devuelve las memorias mas relevantes para la consulta: decisiones, arquitectura, gotchas, contexto de proyectos.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Consulta en lenguaje natural" },
        project: { type: "string", description: "Slug del proyecto para acotar (opcional)" },
        cross_project: { type: "boolean", description: "true = buscar en TODO el cerebro, no solo el proyecto" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_stats",
    description: "Salud y tamano de la memoria: items activos, deprecados, candidatos pendientes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_provenance",
    description: "Origen verificable de una memoria concreta (sesion de captura, canal, hash, transcript).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Id o prefijo (>=6 chars) del item" } },
      required: ["id"],
    },
  },
];

function runSidecar(args, timeoutMs = 70_000) {
  const out = execFileSync(BIN, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return out.trim();
}

function callTool(name, args) {
  switch (name) {
    case "memory_recall": {
      const q = String(args?.query ?? "").trim();
      if (!q) throw new Error("query vacia");
      const cli = ["recall", q];
      if (args?.project) cli.push("--project", String(args.project));
      if (args?.cross_project) cli.push("--cross");
      return runSidecar(cli);
    }
    case "memory_stats":
      return runSidecar(["stats"], 30_000);
    case "memory_provenance": {
      const id = String(args?.id ?? "").trim();
      if (!id) throw new Error("id vacio");
      return runSidecar(["provenance", "--id", id], 30_000);
    }
    default:
      throw new Error(`tool desconocida: ${name}`);
  }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n",
  );
}

if (!existsSync(BIN)) {
  // Sin sidecar no hay memoria: mejor morir claro al arrancar que responder
  // errores crypticos a cada tool call (mandamiento 11).
  process.stderr.write(`[ultron-memory-mcp] sidecar ausente: ${BIN}\n`);
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // linea no-JSON: se ignora (el transporte ndjson no re-sincroniza)
  }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    } else if (method === "notifications/initialized") {
      // notificacion: sin respuesta
    } else if (method === "tools/list") {
      reply(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      const text = callTool(params?.name, params?.arguments ?? {});
      reply(id, { content: [{ type: "text", text }] });
    } else if (method === "ping") {
      reply(id, {});
    } else if (id !== undefined) {
      replyError(id, -32601, `metodo no soportado: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) {
      // Error de la tool -> resultado isError (el cliente lo muestra al modelo).
      if (method === "tools/call") {
        reply(id, {
          content: [{ type: "text", text: `error: ${String(e?.message ?? e)}` }],
          isError: true,
        });
      } else {
        replyError(id, -32603, String(e?.message ?? e));
      }
    }
  }
});
rl.on("close", () => process.exit(0));
