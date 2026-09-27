'use strict';

/**
 * lib/secondary-llm.js — LLM SECUNDARIA para hooks: Groq y Gemini por su API
 * compatible con OpenAI, NUNCA Claude (no gasta cuota del plan).
 *
 * Misma cadena y mismas claves que el juez de skills del sidecar
 * (control-center/src-tauri/src/orchestrator/skill_llm.rs): la cuota de Groq
 * es POR MODELO, asi que se relevan dos modelos de Groq antes de Gemini.
 * Claves: GROQ_API_KEY / GEMINI_API_KEY del entorno (Settings -> API Keys las
 * guarda con setx) y, si faltan, ~/.ultron/.env. Nunca se imprimen ni se
 * registran: los errores solo llevan proveedor, modelo y status HTTP.
 *
 * Seams de test: SECONDARY_LLM_ENDPOINT fuerza un endpoint unico (servidor
 * local falso) para toda la cadena; SECONDARY_LLM_ENV_FILE redirige el .env.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const DEFAULT_CHAIN = [
  { provider: 'groq', model: 'openai/gpt-oss-20b', endpoint: GROQ, keyVar: 'GROQ_API_KEY' },
  { provider: 'groq', model: 'openai/gpt-oss-120b', endpoint: GROQ, keyVar: 'GROQ_API_KEY' },
  { provider: 'gemini', model: 'gemini-3.6-flash', endpoint: GEMINI, keyVar: 'GEMINI_API_KEY' },
];

function envFileKeys() {
  const file = process.env.SECONDARY_LLM_ENV_FILE || path.join(os.homedir(), '.ultron', '.env');
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* sin .env: solo entorno */
  }
  return out;
}

function resolveKey(keyVar, fileKeys) {
  const v = process.env[keyVar];
  if (v && v.trim()) return v.trim();
  const f = fileKeys[keyVar];
  return f && f.trim() ? f.trim() : null;
}

/** Primer objeto JSON del texto (los modelos a veces lo envuelven en ```json). */
function extractJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

/**
 * POST JSON con node:https/http y SIN keep-alive (`agent: false`). No se usa
 * fetch: el socket keep-alive de undici sigue cerrandose cuando el hook llama
 * a process.exit y en Windows Node aborta con
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (visto en runtime
 * 2026-09-27), con lo que Claude Code recibiria un exit code de fallo.
 * @returns {Promise<{status:number, body:string}>}
 */
function postJson(url, headers, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? require('http') : require('https');
    const data = Buffer.from(JSON.stringify(payload));
    const req = mod.request(
      u,
      { method: 'POST', agent: false, headers: { ...headers, 'content-type': 'application/json', 'content-length': data.length } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      }
    );
    // Plazo TOTAL (req.setTimeout solo mide inactividad del socket).
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs);
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end(data);
  });
}

/**
 * Pide una respuesta JSON a la cadena Groq -> Gemini con un plazo TOTAL.
 * @returns {Promise<{ok:true, json:object, provider:string, model:string, ms:number}
 *                  |{ok:false, error:string, attempts:string[], ms:number}>}
 */
async function askJson({ system, user, deadlineMs = 9000, maxTokens = 400, chain = DEFAULT_CHAIN }) {
  const t0 = Date.now();
  const fileKeys = envFileKeys();
  const attempts = [];
  for (const p of chain) {
    const left = deadlineMs - (Date.now() - t0);
    if (left < 500) {
      attempts.push(`${p.provider}/${p.model}: sin tiempo`);
      break;
    }
    const key = resolveKey(p.keyVar, fileKeys);
    if (!key) {
      attempts.push(`${p.provider}/${p.model}: sin ${p.keyVar}`);
      continue;
    }
    const body = {
      model: p.model,
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (p.provider === 'groq') body.reasoning_effort = 'low';
    try {
      const res = await postJson(process.env.SECONDARY_LLM_ENDPOINT || p.endpoint, { authorization: `Bearer ${key}` }, body, left);
      if (res.status < 200 || res.status >= 300) {
        attempts.push(`${p.provider}/${p.model}: HTTP ${res.status}`);
        continue;
      }
      const data = JSON.parse(res.body);
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      const json = extractJson(content);
      if (!json) {
        attempts.push(`${p.provider}/${p.model}: respuesta no JSON`);
        continue;
      }
      return { ok: true, json, provider: p.provider, model: p.model, ms: Date.now() - t0 };
    } catch (e) {
      const name = (e && e.name) || 'Error';
      attempts.push(`${p.provider}/${p.model}: ${name === 'TimeoutError' ? 'timeout' : name === 'SyntaxError' ? 'respuesta ilegible' : 'red'}`);
    }
  }
  return { ok: false, error: attempts.join('; ') || 'cadena vacia', attempts, ms: Date.now() - t0 };
}

module.exports = { askJson, extractJson, DEFAULT_CHAIN };
