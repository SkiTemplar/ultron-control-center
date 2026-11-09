// Popups del composer que se manejan desde el textarea (el foco no sale de él):
// paleta de comandos `/` (E6), autocompletado de ficheros `@` y búsqueda en el
// historial con Ctrl+R (E5). Las listas usan aria-activedescendant.

import { useEffect, useRef } from "react";
import { KIND_LABEL, SOURCE_LABEL, type PaletteItem, type PaletteSection } from "./palette";
import type { ArgChoice } from "./session-commands";

function useScrollActive(ref: React.RefObject<HTMLElement | null>, active: number) {
  useEffect(() => {
    ref.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [ref, active]);
}

export const PALETTE_ID = "composer-palette";

export function CommandPalette({ sections, active, onPick, note }: { sections: PaletteSection[]; active: number; onPick: (item: PaletteItem) => void; note: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollActive(ref, active);
  let index = -1;
  return (
    <div className="ac palette" role="listbox" aria-label="Comandos" id={PALETTE_ID} ref={ref}>
      {sections.length === 0 && <p className="ac-empty">Ningún comando coincide.</p>}
      {sections.map((sec) => (
        <div key={sec.title} role="group" aria-label={sec.title}>
          <div className="ac-sect" role="presentation">{sec.title}</div>
          {sec.items.map((it) => {
            index += 1;
            const i = index;
            return (
              <div key={it.key} id={`${PALETTE_ID}-${i}`} data-index={i} role="option" aria-selected={i === active}
                className={`ac-item${it.source === "recomendado" ? " reco" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(it);
                }}>
                <span className="ak">/{it.name}{it.argHint && <span className="arg"> {it.argHint}</span>}</span>
                {/* «prompt» es el caso normal: solo se rotulan los demás tipos. Un
                    recomendado lleva «recomendado» y el motivo en la descripción. */}
                {it.kind !== "prompt" && <span className={`kind k-${it.kind}`} data-kind={it.kind}>{KIND_LABEL[it.kind]}</span>}
                <span className="src">{it.source === "recomendado" ? SOURCE_LABEL.recomendado : it.origin ?? SOURCE_LABEL[it.source]}</span>
                <small>{it.description}</small>
              </div>
            );
          })}
        </div>
      ))}
      {note && (
        <div className="ac-foot" role="presentation">
          <span className="warn-text">{note}</span>
        </div>
      )}
    </div>
  );
}

export const ARGS_ID = "composer-args";

/** Menú en línea con los argumentos de un comando de Sessions (`/exportar`, `/perfil`…). */
export function ArgAutocomplete({ command, choices, active, onPick, note }: { command: string; choices: ArgChoice[]; active: number; onPick: (i: number) => void; note?: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollActive(ref, active);
  return (
    <div className="ac" role="listbox" aria-label={`Argumentos de /${command}`} id={ARGS_ID} ref={ref}>
      {choices.length === 0 && <p className="ac-empty">Ninguna opción coincide.</p>}
      {choices.map((c, i) => (
        <div key={c.value} id={`${ARGS_ID}-${i}`} data-index={i} role="option" aria-selected={i === active} className="ac-item"
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(i);
          }}>
          <span className="ak">/{command} {c.label}</span>
          {c.description && <small>{c.description}</small>}
        </div>
      ))}
      <div className="ac-foot" role="presentation">
        {note ? <span className="warn-text">{note}</span> : <span><kbd>Enter</kbd> ejecuta · <kbd>Tab</kbd> completa · <kbd>Esc</kbd> cierra</span>}
      </div>
    </div>
  );
}

export const FILES_ID = "composer-files";

interface FileProps {
  files: string[];
  active: number;
  onPick: (i: number) => void;
  /** Aviso si no se pudo listar el proyecto (`sesiones_files`). */
  note?: string | null;
}

export function FileAutocomplete({ files, active, onPick, note }: FileProps) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollActive(ref, active);
  if (files.length === 0 && !note) return null;
  return (
    <div className="ac" role="listbox" aria-label="Ficheros" id={FILES_ID} ref={ref}>
      {files.map((f, i) => (
        <div key={f} id={`${FILES_ID}-${i}`} data-index={i} role="option" aria-selected={i === active} className="ac-item"
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(i);
          }}>
          <span className="ak">@{f.split("/").pop()}</span>
          <small>{f}</small>
        </div>
      ))}
      {note && (
        <div className="ac-foot" role="presentation" data-testid="files-note">
          <span className="warn-text">{note}</span>
        </div>
      )}
    </div>
  );
}

interface SearchProps {
  query: string;
  results: string[];
  active: number;
  onQuery: (q: string) => void;
  onKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onPick: (i: number) => void;
}

export function HistorySearch({ query, results, active, onQuery, onKey, onPick }: SearchProps) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollActive(ref, active);
  return (
    <div className="ac hsearch" role="dialog" aria-label="Buscar en el historial">
      <div className="hs-field">
        <span className="mk" aria-hidden="true">⌕</span>
        <input autoFocus value={query} placeholder="Buscar en prompts anteriores…" aria-label="Buscar en el historial"
          aria-controls="composer-hsearch" aria-activedescendant={results.length ? `composer-hsearch-${active}` : undefined}
          onChange={(e) => onQuery(e.target.value)} onKeyDown={onKey} />
        <span className="faint num">{results.length}</span>
      </div>
      <div role="listbox" id="composer-hsearch" aria-label="Prompts anteriores" ref={ref} className="hs-list">
        {results.length === 0 && <p className="ac-empty">Sin coincidencias en el historial.</p>}
        {results.map((r, i) => (
          <div key={r} id={`composer-hsearch-${i}`} data-index={i} role="option" aria-selected={i === active} className="ac-item hs-item"
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(i);
            }}>
            <span className="mk" aria-hidden="true">❯</span>
            <span className="hs-text">{r}</span>
          </div>
        ))}
      </div>
      <div className="ac-foot" role="presentation">
        <span><kbd>Enter</kbd> usar · <kbd>Ctrl</kbd>+<kbd>R</kbd> siguiente · <kbd>Esc</kbd> cancelar</span>
      </div>
    </div>
  );
}
