#!/usr/bin/env node
'use strict';

/**
 * research-mcp.js — el nucleo de investigacion (hooks/scripts/lib/research/)
 * expuesto como servidor MCP stdio. Mismo patron zero-dep que
 * scripts/mcp-memory-server.mjs (no hay @modelcontextprotocol/sdk instalado
 * en el repo): protocolo MCP minimo a mano (JSON-RPC 2.0 por stdio, un JSON
 * por linea) -> llamadas directas al nucleo, en el mismo proceso (a
 * diferencia de la memoria, aqui no hay un binario nativo al que delegar).
 *
 * La IA busca y verifica fuentes; NO resume el paper por el usuario.
 *
 * Registro:  claude mcp add --scope user research -- cmd /c node <este fichero>
 * Prueba:    node hooks/scripts/research-mcp.selftest.mjs
 */

const readline = require('node:readline');
const path = require('node:path');
const research = require(path.join(__dirname, 'lib', 'research', 'index.js'));
const { normalizeOpenAlexWork, normalizeS2Paper } = require(path.join(__dirname, 'lib', 'research', 'normalize.js'));
const openalex = require(path.join(__dirname, 'lib', 'research', 'openalex.js'));
const semanticScholar = require(path.join(__dirname, 'lib', 'research', 'semantic-scholar.js'));
const { NotFoundError } = require(path.join(__dirname, 'lib', 'research', 'errors.js'));

const SERVER_INFO = { name: 'research', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'research_search',
    description: 'Busca papers en OpenAlex + Semantic Scholar (fusionados, deduplicados por DOI, ordenados con explicacion). No resume: devuelve metadatos y enlaces para que el usuario verifique la fuente original.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Consulta en lenguaje natural' },
        yearFrom: { type: 'number' },
        yearTo: { type: 'number' },
        type: { type: 'string', enum: ['article', 'preprint', 'review', 'other'] },
        minCitations: { type: 'number' },
        limit: { type: 'number', description: 'Maximo de resultados (default 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'research_access',
    description: 'Resuelve el DOI y la mejor URL de PDF de acceso abierto (nunca salta un muro de pago; si no hay OA, lo dice explicitamente).',
    inputSchema: {
      type: 'object',
      properties: { doi: { type: 'string' } },
      required: ['doi'],
    },
  },
  {
    name: 'research_add',
    description: 'Anade un DOI a una sesion de investigacion (papers.json), resolviendo sus metadatos en OpenAlex/Semantic Scholar.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, doi: { type: 'string' } },
      required: ['sessionId', 'doi'],
    },
  },
  {
    name: 'research_bib',
    description: 'Genera refs.bib de una sesion a partir del BibTeX oficial (Crossref/doi.org) de cada DOI guardado.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
    },
  },
  {
    name: 'research_session_new',
    description: 'Crea una sesion de investigacion nueva (carpeta en ~/.ultron/research/).',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
    },
  },
  {
    name: 'research_session_list',
    description: 'Lista las sesiones de investigacion existentes.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function fetchPaperByDoi(doi) {
  try {
    return normalizeOpenAlexWork(await openalex.getWorkByDoi(doi));
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }
  return normalizeS2Paper(await semanticScholar.getPaperByDoi(doi));
}

async function callTool(name, args) {
  switch (name) {
    case 'research_search': {
      const query = String(args?.query ?? '').trim();
      if (!query) throw new Error('query vacia');
      return research.search(query, {
        yearFrom: args?.yearFrom,
        yearTo: args?.yearTo,
        type: args?.type,
        minCitations: args?.minCitations,
        limit: args?.limit ?? 20,
      });
    }
    case 'research_access': {
      const doi = String(args?.doi ?? '').trim();
      if (!doi) throw new Error('doi vacio');
      return research.resolveAccess(doi);
    }
    case 'research_add': {
      const sessionId = String(args?.sessionId ?? '').trim();
      const doi = String(args?.doi ?? '').trim();
      if (!sessionId || !doi) throw new Error('sessionId y doi son obligatorios');
      const paper = await fetchPaperByDoi(doi);
      const paperCount = research.addPaper(sessionId, paper);
      return { session: sessionId, paperCount, added: paper.title };
    }
    case 'research_bib': {
      const sessionId = String(args?.sessionId ?? '').trim();
      if (!sessionId) throw new Error('sessionId vacio');
      return research.writeBib(sessionId);
    }
    case 'research_session_new': {
      const topic = String(args?.topic ?? '').trim();
      if (!topic) throw new Error('topic vacio');
      return research.newSession(topic);
    }
    case 'research_session_list':
      return research.listSessions();
    default:
      throw new Error(`tool desconocida: ${name}`);
  }
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // linea no-JSON: el transporte ndjson no re-sincroniza
  }
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    } else if (method === 'notifications/initialized') {
      // notificacion: sin respuesta
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const result = await callTool(params?.name, params?.arguments ?? {});
      reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } else if (method === 'ping') {
      reply(id, {});
    } else if (id !== undefined) {
      replyError(id, -32601, `metodo no soportado: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) {
      if (method === 'tools/call') {
        reply(id, { content: [{ type: 'text', text: `error: ${String(e?.message ?? e)}` }], isError: true });
      } else {
        replyError(id, -32603, String(e?.message ?? e));
      }
    }
  }
});
rl.on('close', () => process.exit(0));
