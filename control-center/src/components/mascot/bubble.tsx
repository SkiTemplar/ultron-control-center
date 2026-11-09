// Mascota — piezas del bocadillo: texto con enlaces clicables y tarjeta de
// confirmación: el freno (approve.rs / approve_tool_use del MCP), los
// permisos de Claude Code en terminal (permission.rs) y los de Sessions
// (sessionAsks.ts).

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type ApprovalDecision = "allow" | "allowAlways" | "deny";

export interface Approval {
  id: string;
  tool: string;
  reason: string;
  summary: string;
  /** Quién pide (Claude Code · carpeta, Sessions · sesión); vacío en el freno. */
  origin?: string;
  /** Lo último que dijo Claude antes de pedir (terminal). */
  context?: string;
  source?: "pupus" | "terminal" | "sessions";
  /** Sesión de ULTRON Sessions: el contexto se pide al desplegar. */
  sessionId?: string;
  /** La pregunta admite «Permitir siempre» (Sessions). */
  canAlways?: boolean;
}

// Lista blanca de ficheros locales que se pueden abrir con la aplicación predeterminada.
// Debe coincidir con MEDIA_EXTENSIONS de mascot/open.rs, que es quien decide de verdad;
// aquí solo evita subrayar lo que Rust rechazaría.
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  // imagen
  ...["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "tif", "tiff", "ico"],
  // vídeo
  ...["mp4", "mkv", "mov", "avi", "webm", "wmv", "m4v"],
  // audio
  ...["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"],
  // documentos
  ...["pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "ods", "odp", "epub"],
]);

// Alternativas, por orden: URL web; ruta local entre comillas rectas o backticks (admite
// espacios); ruta local entre comillas tipográficas; ruta local suelta (acaba en el primer
// espacio). Las rutas aceptan el prefijo file:/// y los dos separadores de Windows.
const DRIVE_PATH = String.raw`(?:file:\/\/\/)?[A-Za-z]:[\\/]`;
const LINK = new RegExp(
  [
    String.raw`(?<web>https?:\/\/[^\s<>"'\x60]+|mailto:[^\s<>"'\x60]+)`,
    String.raw`(?<q>["'\x60])(?<quoted>${DRIVE_PATH}[^"'\x60<>\r\n]*)\k<q>`,
    String.raw`“(?<curly>${DRIVE_PATH}[^“”<>\r\n]*)”`,
    String.raw`(?<![\w/])(?<bare>${DRIVE_PATH}[^\s<>"'\x60|]+)`,
  ].join("|"),
  "g",
);
// Puntuación que suele pegarse al final de una URL en una frase.
const TRAILING = /[.,;:!?)\]»]+$/;

export type LinkKind = "web" | "file";

export interface TextPart {
  text: string;
  href?: string;
  /** "file" en las rutas locales; ausente en los enlaces web (misma forma que antes). */
  kind?: LinkKind;
}

/** true si la ruta (o URL file:///) termina en una extensión de la lista blanca. */
export function isMediaPath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && MEDIA_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function stripTrailing(raw: string): string {
  const tail = raw.match(TRAILING)?.[0] ?? "";
  return tail ? raw.slice(0, -tail.length) : raw;
}

interface LinkHit {
  start: number;
  href: string;
  kind: LinkKind;
}

/** Traduce un match de LINK al enlace que representa, o null si no es enlazable. */
function toLink(m: RegExpMatchArray): LinkHit | null {
  const g = m.groups ?? {};
  const at = m.index ?? 0;
  if (g.web) return { start: at, href: stripTrailing(g.web), kind: "web" };
  const quoted = g.quoted ?? g.curly;
  if (quoted !== undefined) {
    // Se enlaza la ruta sin las comillas, que quedan como texto normal.
    return isMediaPath(quoted) ? { start: at + 1, href: quoted, kind: "file" } : null;
  }
  const path = stripTrailing(g.bare ?? "");
  return isMediaPath(path) ? { start: at, href: path, kind: "file" } : null;
}

/** Separa texto, enlaces web y rutas locales de medios y documentos. Pura, para los tests. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    const link = toLink(m);
    if (!link) continue;
    if (link.start > last) parts.push({ text: text.slice(last, link.start) });
    const { href, kind } = link;
    parts.push(kind === "file" ? { text: href, href, kind } : { text: href, href });
    last = link.start + href.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

function openLink(p: TextPart): Promise<unknown> {
  return p.kind === "file" ? invoke("mascot_open_file", { path: p.href }) : invoke("mascot_open_url", { url: p.href });
}

/**
 * `linksEnabled = false`: los enlaces salen como texto. Se usa en las
 * conversaciones sobre un fichero adjunto, cuyo contenido podría haber
 * colado un enlace que saque datos al clicarlo.
 */
export function Linkified({ text, linksEnabled = true }: { text: string; linksEnabled?: boolean }) {
  const [openError, setOpenError] = useState<string | null>(null);
  return (
    <>
      {splitLinks(text).map((p, i) =>
        p.href && linksEnabled ? (
          <a
            key={i}
            className="mascot-a"
            href={p.href}
            title={p.kind === "file" ? `Abrir ${p.href}` : p.href}
            onClick={(e) => {
              e.preventDefault();
              setOpenError(null);
              openLink(p).catch((err: unknown) => setOpenError(`No se pudo abrir: ${String(err)}`));
            }}
          >
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
      {openError && <div className="mascot-error">{openError}</div>}
    </>
  );
}

type ChatPeek = { state: "closed" } | { state: "loading" } | { state: "open"; text: string };

/** Lo que dijo Claude antes de pedir: el de la tarjeta o, en Sessions, el del transcript. */
async function loadContext(a: Approval): Promise<string> {
  if (a.context) return a.context;
  if (!a.sessionId) return "";
  return (await invoke<string | null>("mascot_session_context", { sessionId: a.sessionId })) ?? "";
}

export function ApprovalCard({ a, onAnswer }: { a: Approval; onAnswer: (decision: ApprovalDecision) => void }) {
  const [peek, setPeek] = useState<ChatPeek>({ state: "closed" });
  const canPeek = !!a.context || !!a.sessionId;
  const togglePeek = () => {
    if (peek.state !== "closed") return setPeek({ state: "closed" });
    setPeek({ state: "loading" });
    loadContext(a)
      .then((text) => setPeek({ state: "open", text: text || "Claude no ha dicho nada todavía en este turno." }))
      .catch((e: unknown) => setPeek({ state: "open", text: `No se pudo leer el chat: ${String(e)}` }));
  };
  return (
    <div className="mascot-approval">
      <div className="mascot-approval-title">¿Le dejo? · {a.reason}</div>
      {a.origin && <div className="mascot-approval-origin">{a.origin}</div>}
      <code className="mascot-approval-cmd">{a.summary || a.tool}</code>
      {peek.state === "loading" && <div className="mascot-approval-chat">…</div>}
      {peek.state === "open" && <div className="mascot-approval-chat">{peek.text}</div>}
      <div className="mascot-approval-actions">
        {canPeek && (
          <button type="button" className="mascot-approve-peek" aria-expanded={peek.state !== "closed"} onClick={togglePeek}>
            {peek.state === "closed" ? "Ver chat ▾" : "Ocultar chat ▴"}
          </button>
        )}
        <button type="button" className="mascot-approve-no" onClick={() => onAnswer("deny")}>
          No
        </button>
        {a.canAlways && (
          <button type="button" className="mascot-approve-no" title="Permitir y guardar la regla" onClick={() => onAnswer("allowAlways")}>
            Siempre
          </button>
        )}
        <button type="button" className="mascot-approve-yes" onClick={() => onAnswer("allow")}>
          Sí, hazlo
        </button>
      </div>
    </div>
  );
}

export function ThinkingDots() {
  return (
    <span className="mascot-bubble-dots" aria-label="pensando">
      <i />
      <i />
      <i />
    </span>
  );
}

/** Nombre del fichero de una ruta (para enseñarlo sin la carpeta). */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Ficheros que lleva Pupus para la siguiente pregunta. */
export function AttachmentChips({ files, onRemove }: { files: string[]; onRemove: (path: string) => void }) {
  if (!files.length) return null;
  return (
    <div className="mascot-chips">
      {files.map((f) => (
        <span key={f} className="mascot-chip">
          📄 {baseName(f)}
          <button type="button" className="mascot-chip-x" onClick={() => onRemove(f)} aria-label="quitar">
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

export type MenuAction = "lastReply" | "agenda" | "settings" | "hide" | "close";

/**
 * Menú del clic derecho sobre Pupus. `note`: línea informativa (capturas de
 * pesca). `canReplay`: hay una respuesta anterior que volver a enseñar (el
 * bocadillo se cierra solo y sin esto se perdía).
 */
export function PetMenu({ onPick, note, canReplay = false }: { onPick: (action: MenuAction) => void; note?: string | null; canReplay?: boolean }) {
  return (
    <div className="mascot-menu" role="menu">
      {note && <div className="mascot-menu-note">{note}</div>}
      {canReplay && (
        <button type="button" role="menuitem" onClick={() => onPick("lastReply")}>
          Ver la última respuesta
        </button>
      )}
      <button type="button" role="menuitem" onClick={() => onPick("agenda")}>
        ¿Qué tengo pendiente?
      </button>
      <button type="button" role="menuitem" onClick={() => onPick("settings")}>
        Ajustes
      </button>
      <button type="button" role="menuitem" onClick={() => onPick("hide")}>
        Esconder <span className="mascot-menu-key">Ctrl+Alt+P</span>
      </button>
      <button type="button" role="menuitem" onClick={() => onPick("close")}>
        Cerrar Pupus
      </button>
    </div>
  );
}
