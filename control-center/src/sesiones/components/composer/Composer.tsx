// Composer: textarea autoajustable (Enter envía, Mayús+Enter salta), adjuntos
// por pegar o arrastrar, paleta `/` con el catálogo completo, `@` ficheros,
// historial ↑/↓ y Ctrl+R, destino Claude/Codex/Gemini, la línea de estado única
// encima y el HUD debajo. Con la sesión ocupada o esperando, Enter encola en el
// backend (nunca escribe en un diálogo); la cola la drena el backend. Forzar
// (§3.4): Ctrl+Enter «Enviar ya», Ctrl+Mayús+Enter «Interrumpir y enviar»,
// Ctrl+B «Segundo plano» y Ctrl+Mayús+D alterna «Subagente» (force.ts).

import { reportError } from "../../bootstrap";
import { ENGINE_LABEL, engineOfTarget } from "../../engines";
import type { SessionId } from "../../types";
import { ChatStatus } from "../chat/ChatStatus";
import { StatusLine } from "../hud/StatusLine";
import { AttachmentChips, ComposerBar, ExitConfirm } from "./ComposerParts";
import { ARGS_ID, ArgAutocomplete, CommandPalette, FILES_ID, FileAutocomplete, HistorySearch, PALETTE_ID } from "./ComposerPopups";
import { QueuePanel } from "./QueuePanel";
import { RelayBanner } from "./RelayBanner";
import { changeTarget, closeSearch, onKeyDown, onSearchKey, openPalette, pick, recover, submit, updateText, type ComposerCtx } from "./composer-handlers";
import { useComposerPopups } from "./useComposerPopups";
import { useComposerState } from "./useComposerState";

/**
 * Un composer por sesión: el `key` lo remonta al cambiar la sesión del panel, así
 * que borrador, adjuntos, dictado, paleta y confirmaciones no pasan de una sesión a
 * otra; lo escrito se guarda en `drafts.ts` y vuelve al regresar a la sesión.
 */
export function Composer({ sessionId }: { sessionId: SessionId }) {
  return <SessionComposer key={sessionId} sessionId={sessionId} />;
}

/** Texto de ayuda de la caja según destino y estado de la sesión. */
function placeholderFor({ improving, info, target, busy }: ComposerCtx): string {
  if (improving) return "Mejorando el prompt…";
  if (info?.status === "exited") return "La sesión terminó: reiníciala para seguir.";
  if (info?.engine) return busy ? `Escribe; se encola hasta que ${ENGINE_LABEL[info.engine]} termine el turno…` : `Escribe a ${ENGINE_LABEL[info.engine]}…`;
  if (target !== "claude") return `Qué tiene que hacer ${ENGINE_LABEL[engineOfTarget(target) ?? "codex"]} (recibe el contexto del hilo)…`;
  return busy || info?.status === "starting" ? "Escribe; se encola hasta que Claude quede libre…" : "Escribe a Claude…";
}

/** Cableado del composer: estado, menús y manejadores (`composer-handlers.ts`) sobre el JSX. */
function SessionComposer({ sessionId }: { sessionId: SessionId }) {
  const state = useComposerState(sessionId);
  const c: ComposerCtx = { ...state, ...useComposerPopups(state) };
  const { api, info, target, trigger, active, search, text, att, dictation, dictationError, delegate, relay } = c;
  const isEngine = target !== "claude";
  const popupId = trigger?.kind === "slash" ? PALETTE_ID : trigger?.kind === "arg" ? ARGS_ID : FILES_ID;
  const activeId = trigger && c.popupCount > 0 ? `${popupId}-${active}` : undefined;

  return (
    <div className="composer" data-target={target}>
      <QueuePanel sessionId={sessionId} />
      {relay && <RelayBanner relay={relay}
        onReturn={() => void api.relayReturn(sessionId).catch(reportError)}
        onGemini={() => void api.relaySwitchGemini(sessionId).catch(reportError)} />}
      {info && !isEngine && <ChatStatus info={info} />}
      {c.confirmExit && (
        <ExitConfirm onCancel={() => c.setConfirmExit(false)} onConfirm={() => {
          c.setConfirmExit(false);
          void api.runCommand({ id: sessionId, command: "exit", args: "", clientId: crypto.randomUUID() }).catch(reportError);
        }} />
      )}
      {dictationError && (
        <div className="cnotice err" role="alert" data-testid="dictation-error">
          <span>{dictationError}</span>
          <button className="btn sm ghost" onClick={() => c.setDictationError(null)}>Cerrar</button>
        </div>
      )}
      <div
        className={`cbox${c.drag ? " drag" : ""}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            c.setDrag(true);
          }
        }}
        onDragLeave={() => c.setDrag(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          c.setDrag(false);
          void att.add([...e.dataTransfer.files]);
        }}
      >
        {trigger?.kind === "slash" && <CommandPalette sections={c.sections} active={active} onPick={(it) => pick(c, c.flat.indexOf(it))} note={c.catalog.error} />}
        {trigger?.kind === "at" && <FileAutocomplete files={c.fileItems} active={active} onPick={(i) => pick(c, i)} note={c.files.error} />}
        {trigger?.kind === "arg" && <ArgAutocomplete command={trigger.command} choices={c.argItems} active={active} onPick={(i) => pick(c, i)} note={c.argModels.error} />}
        {search && (
          <HistorySearch query={search.query} results={c.results} active={search.active} onKey={(e) => onSearchKey(c, e)}
            onQuery={(q) => c.setSearch({ query: q, active: 0 })} onPick={(i) => closeSearch(c, c.results[i])} />
        )}
        <AttachmentChips items={att.items} onRemove={att.remove} />
        <div className="cline">
          <span className={`mk prompt ${isEngine ? target.replace(/Local|Cloud/, "").toLowerCase() : "claude"}`} aria-hidden="true">❯</span>
          <label htmlFor={`prompt-${sessionId}`} className="sr-only">Mensaje</label>
          <textarea
            id={`prompt-${sessionId}`}
            ref={c.ta}
            readOnly={c.improving}
            aria-busy={c.improving || undefined}
            rows={1}
            value={text}
            placeholder={placeholderFor(c)}
            aria-autocomplete="list"
            aria-controls={trigger ? popupId : undefined}
            aria-activedescendant={activeId}
            onChange={(e) => updateText(c, e.target.value, e.target.selectionStart)}
            onKeyDown={(e) => onKeyDown(c, e)}
            onBlur={() => window.setTimeout(() => c.setTrigger(null), 120)}
            onPaste={(e) => {
              const pasted = [...e.clipboardData.files];
              if (pasted.length) {
                e.preventDefault();
                void att.add(pasted);
              }
            }}
          />
        </div>
        <ComposerBar sessionId={sessionId} info={info} target={target} onTarget={(t) => changeTarget(c, t)} delegate={delegate} onDelegate={() => c.setDelegate((d) => !d)}
          dictation={dictation} attBusy={att.busy} canSend={Boolean(text.trim() || att.items.length > 0) && !att.busy}
          onAttach={(files) => void att.add(files)} onSlash={() => openPalette(c)}
          onSubmit={() => void submit(c)} onSubmitNow={() => void submit(c, "now")} onInterruptSend={() => void submit(c, "interrupt")} onRecover={(a) => recover(c, a)} />
      </div>
      {att.error && <p className="hint err-text" role="alert">{att.error}</p>}
      {c.history.error && <p className="hint warn-text">{c.history.error}</p>}
      {info && <StatusLine info={info} pending={att.items} git={c.git} />}
    </div>
  );
}
