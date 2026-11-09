// Tarjetas de estado de la sesión en el chat: confianza del arranque (§4.6) y el
// bloque de menú (cambio de diseño del 2026-10-08): cuando la TUI abre un menú,
// selector o diálogo, el chat muestra esa pantalla en su sitio y le pasa el
// teclado por `sesiones_terminal_input`. «Salir del menú» y Esc salen siempre. Las
// opciones de `waiting.options` (solo en menús) se pueden elegir con un clic: el
// backend las rellena desde la pantalla y reemite la sesión cuando cambian; con
// ellas, la pantalla de la TUI queda plegada tras «Ver pantalla».

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { reportError } from "../../bootstrap";
import { useApi } from "../../context";
import type { SessionInfo } from "../../types";
import { clearMenuRequest, useUi } from "../../ui";
import {
  bindMenuKeys, hostGeometry, linkMenuTerminal, MENU_FONT, MENU_FONT_SIZE, hasMenuIntent, menuClipHeight, shouldFocusMenu, usedRows,
} from "./menu-terminal";

function useAction(fn: () => Promise<unknown>): [boolean, () => void] {
  const [busy, setBusy] = useState(false);
  return [busy, () => {
    setBusy(true);
    fn().catch(reportError).finally(() => setBusy(false));
  }];
}

export function TrustCard({ info }: { info: SessionInfo }) {
  const api = useApi();
  const [busyYes, yes] = useAction(() => api.trustAnswer({ id: info.id, accept: true }));
  const [busyNo, no] = useAction(() => api.trustAnswer({ id: info.id, accept: false }));
  return (
    <div className="msg">
      <div className="ask" role="group" aria-label="Confianza en la carpeta" data-testid="trust-card">
        <div className="q"><b>¿Confías en esta carpeta?</b> · Claude Code pide permiso para trabajar en <span className="mono">{info.cwd}</span>. Lo que envíes espera en la cola hasta que respondas.</div>
        <div className="acts">
          <button className="btn pri" disabled={busyYes || busyNo} onClick={yes}>Confiar en esta carpeta</button>
          <button className="btn ghost" disabled={busyYes || busyNo} onClick={no}>Salir</button>
        </div>
      </div>
    </div>
  );
}

const MENU_REQUEST_MS = 5000;

/**
 * Pantalla del PTY en una región del chat con el teclado conectado al menú.
 * Mientras está abierta, el PTY tiene el tamaño de esta vista y la TUI se
 * repinta entera en él; al cerrarla vuelve al tamaño de lanzamiento. Toma el
 * foco solo si el usuario pidió el menú o no está escribiendo en otro campo.
 * La envoltura recorta las filas vacías de debajo de lo pintado; plegada, la
 * terminal sigue montada (y con el teclado) pero no se ve.
 */
function MenuScreen({ info, command, folded }: { info: SessionInfo; command: string | null; folded: boolean }) {
  const api = useApi();
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [clip, setClip] = useState<number | null>(null);
  // Se teclea una sola vez: el cambio de petición a menú abierto no reabre la terminal.
  const pendingCommand = useRef(command);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({ fontFamily: MENU_FONT, fontSize: MENU_FONT_SIZE, ...hostGeometry(el), cursorBlink: false, convertEol: false });
    term.open(el);
    let disposed = false;
    const write = (data: string) => api.terminalInput({ id: info.id, data }).catch((e: unknown) => setError(String(e)));
    // Tras desmontar, los errores del cierre (restaurar, soltar) van al aviso global.
    const onError = (e: unknown) => (disposed ? reportError(e) : setError(`No se pudo mostrar el menú: ${String(e)}`));
    const { link, ready } = linkMenuTerminal(api, info.id, term, { cols: term.cols, rows: term.rows }, onError);
    void ready.then(async () => {
      // Una vista ya desmontada (doble montaje de StrictMode) no consume el comando.
      if (disposed) return;
      const typed = pendingCommand.current;
      pendingCommand.current = null;
      if (typed) await write(`/${typed}\r`);
    });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => link.resize(hostGeometry(el)));
    observer?.observe(el);
    const input = term.onData((data) => void write(data));
    const fit = () => {
      const css = getComputedStyle(el);
      const padY = (parseFloat(css.paddingTop) || 0) + (parseFloat(css.paddingBottom) || 0);
      const screen = el.querySelector(".xterm-screen")?.getBoundingClientRect().height ?? 0;
      const cell = (screen > 0 ? screen : el.clientHeight - padY) / term.rows;
      if (cell > 0) setClip(menuClipHeight(usedRows(term), term.rows, cell, padY));
    };
    const parsed = term.onWriteParsed(fit);
    const unbindKeys = bindMenuKeys(el, term, {
      copy: (text) => void navigator.clipboard.writeText(text).catch((e: unknown) => setError(`No se pudo copiar: ${String(e)}`)),
      closeMenu: () => void api.recover({ id: info.id, action: "exitMenu" })
        .then((out) => { if (!out.ok) setError(`El menú no se cerró (${out.steps.join(" → ") || "sin detalle"}).`); })
        .catch(reportError),
    });
    const requested = pendingCommand.current !== null || hasMenuIntent(info.id);
    if (shouldFocusMenu(requested, document.activeElement)) term.focus();
    return () => {
      disposed = true;
      observer?.disconnect();
      unbindKeys();
      input.dispose();
      parsed.dispose();
      link.close();
      term.dispose();
    };
  }, [api, info.id]);

  return (
    <>
      <div className={`menu-term-wrap${folded ? " folded" : ""}`} style={clip !== null && !folded ? { maxHeight: clip } : undefined}>
        <div className="menu-term" ref={host} data-testid="menu-screen" />
      </div>
      {error && <p className="err-text" role="alert">{error}</p>}
    </>
  );
}

export function MenuBlock({ info }: { info: SessionInfo }) {
  const api = useApi();
  const request = useUi((s) => (s.menuRequest?.sessionId === info.id ? s.menuRequest : null));
  const open = info.waiting?.kind === "menu";
  const [showScreen, setShowScreen] = useState(false);
  const [busy, close] = useAction(async () => {
    const out = await api.recover({ id: info.id, action: "exitMenu" });
    if (!out.ok) throw new Error(`El menú no se cerró (${out.steps.join(" → ") || "sin detalle"}): reinicia la sesión.`);
  });
  // La petición del cable antiguo vive hasta que la TUI abre el menú o pasan 5 s.
  useEffect(() => {
    if (!request) return;
    if (open) return clearMenuRequest(info.id);
    const t = window.setTimeout(() => clearMenuRequest(info.id), MENU_REQUEST_MS);
    return () => window.clearTimeout(t);
  }, [request, open, info.id]);
  if (!open && !request) return null;
  const options = info.waiting?.options ?? [];
  return (
    <div className="msg">
      <div className="ask menu-block" role="group" aria-label="Menú de Claude Code" data-testid="menu-block">
        <div className="q"><b>{info.waiting?.label || (request ? `/${request.command}` : "Menú de Claude Code")}</b></div>
        {options.length > 0 && (
          <div className="menu-options" role="group" aria-label="Opciones del menú">
            {options.map((o) => (
              <button key={o.index} className={`btn${o.selected ? " pri" : ""}`} disabled={busy}
                onClick={() => void api.dialogAnswer({ id: info.id, index: o.index }).catch(reportError)}>{o.label}</button>
            ))}
          </div>
        )}
        <MenuScreen info={info} command={!open && request ? request.command : null} folded={options.length > 0 && !showScreen} />
        <div className="acts">
          <span className="faint" title="Flechas, Enter y Esc van a la TUI; los mensajes esperan en la cola">↑↓ Enter · Esc sale</span>
          {options.length > 0 && (
            <button className="btn ghost" aria-expanded={showScreen} onClick={() => setShowScreen((v) => !v)} data-testid="menu-toggle-screen">
              {showScreen ? "Ocultar pantalla" : "Ver pantalla"}
            </button>
          )}
          <button className="btn" disabled={busy} onClick={close} data-testid="menu-close">{busy ? "Saliendo…" : "Salir del menú"}</button>
        </div>
      </div>
    </div>
  );
}
