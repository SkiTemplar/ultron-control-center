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
    name: "approve_tool_use",
    description:
      "Puerta de permisos para el chat de Pupus (--permission-prompt-tool). No la llames tú: Claude Code la usa para preguntar si una herramienta puede ejecutarse.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        input: { type: "object" },
        tool_use_id: { type: "string" },
      },
      required: ["tool_name"],
    },
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

// ---------------------------------------------------------------------------
// Freno: qué necesita un clic del usuario antes de ejecutarse
// ---------------------------------------------------------------------------

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

// Borrar, publicar, tocar el registro, matar procesos o apagar el equipo.
// Inicio de palabra de comando: principio, separadores de shell o comillas
// (`cmd /c "del x"` también cuenta).
const CMD = String.raw`(^|[\s;&|("'\x60])`;

const RISKY_COMMANDS = [
  [new RegExp(CMD + String.raw`(rm|rmdir|rd|del|erase|unlink|shred|ri)(\s|$)`, "i"), "borrar ficheros"],
  [/\b(Remove-Item|Clear-Content|Clear-RecycleBin)\b/i, "borrar ficheros"],
  // Borrados desde un intérprete: node -e, python -c, .NET…
  // `.Delete(` de una instancia y `::Delete(` de [IO.File] / [IO.Directory].
  [/\b(rmSync|rmdirSync|unlinkSync|rimraf|rmtree|os\.remove|os\.unlink|os\.rmdir)|(\.|::)Delete\(/i, "borrar ficheros"],
  // `git push`, también con opciones delante (`git -C repo push`).
  [/\bgit\b[^\n;&|]*\spush\b/i, "git push"],
  [/\bgit\b[^\n;&|]*\s(reset\s+--hard|clean\b|branch\s+-D|checkout\s+--\s|restore\b|stash\s+(drop|clear))/i, "descartar cambios de git"],
  [new RegExp(CMD + String.raw`reg(\.exe)?\s+(add|delete|import|load|unload|restore|copy)\b`, "i"), "tocar el registro"],
  [/\b(Set|New|Remove|Rename)-ItemProperty\b|\bHK(LM|CU|CR|U|CC):/i, "tocar el registro"],
  [new RegExp(String.raw`\b(taskkill|tskill|pkill|killall)\b|\bStop-Process\b|` + CMD + String.raw`kill(\s|$)`, "i"), "matar procesos"],
  [/\b(shutdown|Restart-Computer|Stop-Computer|diskpart|bcdedit)\b|\bformat(\.com)?\s+[a-z]:|\bcipher\s+\/w/i, "apagar o tocar el disco"],
  [/\brobocopy\b[^\n]*\s\/(mir|purge|move|mov)\b|\bMove-Item\b[^\n]*\$null/i, "borrar ficheros"],
  // Lo que no se puede leer no se puede juzgar: comandos ofuscados o
  // construidos en tiempo de ejecución siempre preguntan.
  [/\s-(e|en|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}|\b(iex|Invoke-Expression|Invoke-Command|FromBase64String)\b|\bbase64\s+(-d|--decode)\b|\beval\b/i, "comando ofuscado"],
];

// Mismos criterios que chat_gate/patterns.rs (freno del chat de Pupus).
const BRIDGE = "contactar con el puente local o leer su token";
const OVERWRITE = "sobrescribir o mover ficheros";
// El puente (cualquier loopback, su API o su cabecera), los ficheros de su
// token, comodines que los alcanzan y las carpetas que los contienen
// nombradas enteras (`grep -r` sobre ~/.ultron, cockpit o la carpeta temporal).
const BRIDGE_RE =
  /(^|[^0-9a-z.])(127(\.\d{1,3}){1,3}|0\.0\.0\.0|0x7f[0-9a-f.]*|2130706433)([^0-9a-z]|$)|\blocalhost\b|\[(0{0,4}:){1,7}:?0{0,3}1\]|::ffff:7f|\/v1\/(action|pretool|approve)\b|x-ultron-token|mascot-bridge|ultron-pupus|chat-settings|cockpit\/\S*[*?[]|mascot[^\s/]*[*?]|ultron-[^\s/]*[*?]|\.ultron(\/cockpit)?\/?(["'\s]|$)|(%temp%|\$env:te?mp|\$tmpdir|\/appdata\/local\/temp)\/?(["'\s]|$)/i;
const CMD_POS = String.raw`(^|[;&|(\n\x60{])\s*([&.]\s+)?["']?`;
const OVERWRITES = [
  /\bSet-Content\b/i,
  new RegExp(CMD_POS + String.raw`(mv|move|move-item)(\.exe)?(\s|$)`, "i"),
  new RegExp(CMD_POS + String.raw`(cp|copy|copy-item|cpi|xcopy)(\.exe)?(\s[^\n;&|]*)?\s(-[a-z]*f[a-z]*(\s|$)|--force\b|\/y\b)`, "i"),
  /\bNew-Item\b[^\n;&|]*\s-Force\b/i,
  /\bdd\b[^\n;&|]*\bof=|\btruncate\s/i,
];
const SINKS = new Set(["", "$null", "nul", "nul:", "/dev/null", "\\\\.\\nul"]);

/** Lo que el shell junta: sin comillas, acentos graves ni `^`, en minúsculas. */
function shellJoined(text, stripBackslash) {
  const s = text.replace(/["'\x60^]/g, "");
  return (stripBackslash ? s.replace(/\\/g, "") : s.replace(/\\/g, "/")).toLowerCase();
}

const anyForm = (text, re) => re.test(text) || re.test(shellJoined(text, false)) || re.test(shellJoined(text, true));

/** Hay una redirección `>` fuera de comillas que sobrescribe un fichero. */
function redirectsOverFile(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if (c !== ">" || /[>\-=^]/.test(text[i - 1] ?? "") || /[>&=]/.test(text[i + 1] ?? "")) continue;
    const target = (text.slice(i + 1).trimStart().match(/^[^\s;|&)]*/)?.[0] ?? "").replace(/["']/g, "");
    if (!SINKS.has(target.toLowerCase())) return true;
  }
  return false;
}

function overwrites(text) {
  if (OVERWRITES.some((re) => re.test(text)) || redirectsOverFile(text)) return true;
  return text.split(/[\n;|&]/).some((seg) => /\b(Out-File|Tee-Object)\b/i.test(seg) && !/\s-a(ppend)?\b/i.test(seg));
}

// Credenciales: misma clasificación que chat_gate/secrets.rs. `deny-secrets`
// responde `ask` para estas rutas y, con `--permission-prompt-tool`, ese `ask`
// acaba en esta puerta: aprobarlo como una lectura normal anula la guardia.
const SECRET = "leer o tocar un secreto o una credencial";
const NET_SEND_REASON = "enviar datos a la red";
const KEY_EXTS = new Set(["pem", "pfx", "p12", "key", "keystore", "jks"]);
const SSH_KEY_PREFIXES = ["id_rsa", "id_ed25519", "id_dsa", "id_ecdsa"];
const SECRET_NAMES = new Set([
  "secrets.json", "credentials.json", ".secrets.json", ".credentials.json",
  ".git-credentials", ".netrc", "_netrc", ".npmrc", ".pypirc",
]);
const GLOB_TARGETS = [".env", ".claude.json", ".git-credentials", ".netrc", ".npmrc"];
const CLI_TOKENS = new Set([".codex/auth.json", ".gemini/oauth_creds.json", ".aws/credentials", "gh/hosts.yml", "github cli/hosts.yml"]);
const SECRET_VAR = "[a-z0-9_]*(?:key|token|secret|password|passwd|credential)[a-z0-9_]*";
const ENV_DUMP = [
  new RegExp(String.raw`(?:^|[;&|(\n]\s*)(?:\S*[\\/])?printenv(?:\s+-\S+)*\s*(?:$|[;&|\n)])|printenv\s+` + SECRET_VAR, "i"),
  // Sin argumentos vuelcan el entorno; con una asignación (`export FOO=1`) no.
  /(?:^|[;&|({\n]\s*)(?:(?:then|do|else|if|sudo|command|builtin)\s+)*(?:env|set|(?:export|declare|typeset)(?:\s+-[px]+)?)\s*(?:$|[;&|\n)>])/i,
  new RegExp(String.raw`(?:^|[;&|({\n]\s*)set\s+${SECRET_VAR}\s*(?:$|[;&|\n)>])|\b(?:declare|typeset)\s+-[a-z]*p[a-z]*\s+${SECRET_VAR}`, "i"),
  /\b(?:gci|dir|ls|get-childitem|get-item)\s+(?:-path\s+)?env:/i,
  /\/proc\/[^/\s]+\/environ\b|getenvironmentvariables\b|\bwin32_environment\b|\bwmic(?:\.exe)?\s+environment\b/i,
  // Con la barra doblada de Git Bash (`HKCU\\Environment`), y también `export`/`save` de `reg`.
  /\bhk(?:cu|lm|ey_current_user|ey_local_machine):?[\\/]+(?:system[\\/]+currentcontrolset[\\/]+control[\\/]+session manager[\\/]+)?environment\b/i,
  /\breg(?:\.exe)?\s+(?:query|export|save)\s+hk(?:cu|ey_current_user)[\\/]*(?:\s|$)/i,
  new RegExp(String.raw`\$(?:env:)?\{?` + SECRET_VAR + "|%" + SECRET_VAR + "%", "i"),
  /(?:node|python\S*)\b[^\n;&|]*\s-[ecp]\w*\s[^\n]*(?:process\.env|os\.environ)/i,
];
const READS_FILE = new RegExp(
  CMD_POS + String.raw`(?:[^\s;&|"']*[\\/])?(?:cat|type|gc|get-content|less|more|head|tail|tac|nl|bat|sed|awk|xxd|od|strings|base64|grep|egrep|fgrep|rg|findstr|select-string|sls)(?:\.exe)?\s`,
  "i",
);
// Sin pasar a minúsculas: `-F` y `-T` de curl no son `-f` y `-t`.
const NET_SEND = [
  /(?:^|[^a-zA-Z0-9_.-])[cC][uU][rR][lL](?:\.exe)?(?:\s[^\n;|]*)?\s(?:-[a-zA-Z]*[dFT]\S*|--(?:data|data-[a-z]+|form|form-string|upload-file|json|url-query)(?:[\s=]|$)|-X\s*(?:POST|PUT|PATCH|post|put|patch))/,
  /(?:^|[^a-z0-9_.-])(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)(?:\.exe)?\s[^\n;|]*\$(?:\(|\{|env:)/i,
  /\bwget\b[^\n;|]*\s--(?:post-data|post-file|body-data|body-file|method)\b/i,
  /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n;|]*\s-(?:body|infile|form|method\s+(?:post|put|patch|delete))\b/i,
  /\bupload(?:file|string|data|values)(?:async)?\b|\.(?:post|put)async\b|start-bitstransfer[^\n;|]*\s-transfertype\s+upload\b|bitsadmin[^\n;|]*\s\/upload\b|\bsend-mailmessage\b/i,
  /(?:^|[;&|(\n]\s*)(?:scp|sftp|rsync|ftp|nc|ncat|netcat|socat)(?:\.exe)?\s/i,
];

function sendsNetwork(text) {
  const unquoted = text.replace(/["'\x60^]/g, "");
  return NET_SEND.some((re) => re.test(text) || re.test(unquoted));
}

function isSafeEnv(base) {
  const stem = base.replace(/[.\-_]env$/, "");
  return ["example", "sample", "template", "dist"].includes(stem.split(/[.\-_]/).pop());
}

function isDotenv(base, loose) {
  const named = base === ".env" || base === ".envrc" || /^\.env[.\-_*?]/.test(base) || /^\*+\.env$/.test(base);
  const code = base === "process.env" || base === "import.meta.env";
  return (named || (!loose && !code && base.endsWith(".env"))) && !isSafeEnv(base);
}

function globReachesSecret(base) {
  if (!base.startsWith(".") || !/[*?]/.test(base)) return false;
  const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return GLOB_TARGETS.some((t) => re.test(t));
}

function secretSegments(segs, loose) {
  if (!segs.length) return false;
  const base = segs[segs.length - 1].split(":")[0];
  const dirs = segs.slice(0, -1);
  const ext = base.includes(".") ? base.split(".").pop() : "";
  return (
    isDotenv(base, loose) ||
    (!loose && KEY_EXTS.has(ext)) ||
    SSH_KEY_PREFIXES.some((p) => base.startsWith(p)) ||
    base === ".ssh" ||
    dirs.includes(".ssh") ||
    SECRET_NAMES.has(base) ||
    (base.startsWith("service-account") && base.endsWith(".json")) ||
    CLI_TOKENS.has(`${dirs[dirs.length - 1] ?? ""}/${base}`) ||
    base === ".claude.json" ||
    base.startsWith(".claude.json.") ||
    globReachesSecret(base)
  );
}

const splitPath = (p) => p.replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean);

/** Segmentos sin `.` y con cada `..` resuelto: `.codex/./auth.json` es `.codex/auth.json`. */
function resolveDots(segs) {
  const out = [];
  for (const s of segs) {
    if (s === ".") continue;
    if (s === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(s);
  }
  return out;
}

/** La forma literal y la resuelta: `.ssh/../x` nombra el directorio aunque no se quede en él. */
const secretInAnyForm = (segs, loose) => secretSegments(segs, loose) || secretSegments(resolveDots(segs), loose);

/** Un campo que nombra una ruta entera (`file_path`, `path`, `glob`…). */
export function isSecretPath(path) {
  return secretInAnyForm(splitPath(String(path)), false);
}

// `cd ~/.codex && cat auth.json`, también tras lo que abre un bloque
// (`(cd d && …)`, `{ cd d; … }`, `if cd d; then …`) o con `&`. Solo se resuelve contra
// directorios con secretos, como lib/secret-cwd.js del hook.
const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".codex", ".gemini", "gh", "github cli"]);
const CD_SEGMENT = /^(?:[\s({!]|(?:\w+=)?\$|(?:if|then|elif|else|do|while|until|time|command|builtin)\s)*(?:cd|chdir|pushd|set-location|sl|push-location)(?:\s+(?:-\w+|\/d))*(?:\s+(.+))?$/;
const MAX_DIR_CHARS = 1024;

function nextDir(dir, args) {
  const to = String(args ?? "").replace(/\s*\d*[<>].*$/, "").replace(/[)}\s]+$/, "").trim();
  if (to === "") return "~";
  if (to === "-") return "";
  const joined = /^(?:\/|~|\$|%|[a-z]:)/.test(to) || !dir ? to : `${dir}/${to}`;
  const next = resolveDots(splitPath(joined)).join("/");
  return next.length > MAX_DIR_CHARS ? "" : next;
}

/** `joined` es la línea de `shellJoined`: sin comillas, en minúsculas y con `/`. */
function readsSecretAfterCd(joined) {
  let dir = "";
  for (const raw of joined.split(/[\n;&|]+/)) {
    const seg = raw.trim();
    const cd = seg.match(CD_SEGMENT);
    if (cd) {
      dir = nextDir(dir, cd[1]);
      continue;
    }
    if (!dir || !splitPath(dir).some((s) => SENSITIVE_DIRS.has(s))) continue;
    // `< f cat`: la primera palabra es el fichero redirigido, no el verbo.
    const words = seg.split(/[\s<>=,(){}]+/).filter(Boolean).slice(seg.startsWith("<") ? 0 : 1);
    if (words.some((w) => !w.startsWith("-") && isSecretPath(`${dir}/${w}`))) return true;
  }
  return false;
}

/** Un comando que nombra una credencial o vuelca el entorno. */
function touchesSecret(command) {
  const joined = shellJoined(command, false);
  if (ENV_DUMP.some((re) => re.test(command) || re.test(joined))) return true;
  if (readsSecretAfterCd(joined)) return true;
  const reader = READS_FILE.test(command) || READS_FILE.test(joined);
  return joined.split(/[\s;|&<>=,(){}]/).some((w) => {
    if (w.includes("://")) return false;
    const segs = splitPath(w);
    return secretInAnyForm(segs, segs.length < 2 && !reader);
  });
}

function riskyReason(command) {
  const joined = shellJoined(command, true);
  const hit = RISKY_COMMANDS.find(([re]) => re.test(command) || re.test(joined));
  if (hit) return hit[1];
  if (anyForm(command, BRIDGE_RE)) return BRIDGE;
  if (touchesSecret(command)) return SECRET;
  if (sendsNetwork(command)) return NET_SEND_REASON;
  return overwrites(command) ? OVERWRITE : "";
}

// Campos que nombran rutas, por herramienta (`pattern` de Grep es texto).
function pathFields(name, input) {
  const keys = name === "Glob" ? ["pattern", "path"] : ["file_path", "notebook_path", "path", "glob"];
  return keys.map((k) => input?.[k]).filter((v) => typeof v === "string" && v);
}

// Lo que se enseña en la tarjeta de confirmación: el comando ENTERO (con
// tope de seguridad), para que no quede nada escondido tras un recorte.
const MAX_SUMMARY = 8000;

// Herramientas que no frenan: leen, miran la pantalla o escriben ficheros
// fuera de las rutas del freno del chat (chat_gate.rs revisa Write, Edit y
// el teclado antes que esta puerta).
const SAFE_TOOL = /^(Read|Glob|Grep|LS|WebFetch|WebSearch|TodoWrite|Write|Edit|MultiEdit|NotebookRead|mcp__ultron-desktop__.*)$/;

function clip(s) {
  return s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY)}… [+${s.length - MAX_SUMMARY} caracteres sin mostrar]` : s;
}

/** Decide si una herramienta necesita confirmación. Pura, para los tests. */
export function classifyToolUse(toolName, input = {}) {
  const name = String(toolName || "");
  if (SHELL_TOOLS.has(name)) {
    const command = String(input?.command ?? "");
    const reason = riskyReason(command);
    return { risky: reason !== "", reason, summary: clip(command) };
  }
  if (SAFE_TOOL.test(name)) {
    // Los campos de texto tal cual (sin el escapado de JSON de las rutas).
    const fields = Object.values(input ?? {}).filter((v) => typeof v === "string").join(" ");
    // Leer el token del puente da teclado y ratón sin pasar por el freno.
    if (!name.startsWith("mcp__") && anyForm(fields, BRIDGE_RE)) {
      return { risky: true, reason: BRIDGE, summary: `${name} ${clip(JSON.stringify(input ?? {}))}` };
    }
    if (!name.startsWith("mcp__") && pathFields(name, input).some(isSecretPath)) {
      return { risky: true, reason: SECRET, summary: `${name} ${clip(JSON.stringify(input ?? {}))}` };
    }
    return { risky: false, reason: "", summary: name };
  }
  // Cualquier otra herramienta (MCP de terceros: GitHub, memoria…) pregunta.
  return { risky: true, reason: "herramienta externa", summary: `${name} ${clip(JSON.stringify(input ?? {}))}` };
}

/** Respuesta en el formato que espera --permission-prompt-tool. */
export async function approveToolUse(args = {}, opts = {}) {
  const input = args.input ?? {};
  const verdict = classifyToolUse(args.tool_name, input);
  let allow = !verdict.risky;
  let message = "";
  if (verdict.risky) {
    try {
      const r = await callBridge(
        { tool: args.tool_name, reason: verdict.reason, summary: verdict.summary },
        { ...opts, path: "/v1/approve", timeoutMs: 150_000 },
      );
      allow = r.allow === true;
      message = allow ? "" : r.message || "El usuario no lo ha permitido.";
    } catch (e) {
      allow = false;
      message = `Sin confirmación del usuario (${e.message}).`;
    }
  }
  const decision = allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message };
  return { content: [{ type: "text", text: JSON.stringify(decision) }] };
}

export function callBridge(body, { home = homedir(), timeoutMs = 60_000, path = "/v1/action" } = {}) {
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
        path,
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
  if (name === "approve_tool_use") return approveToolUse(args, opts);
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
