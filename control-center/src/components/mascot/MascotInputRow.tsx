// Mascota — fila de escritura del chat (fase «input»): cuadro de texto, botón
// de dictado por voz y botón de enviar.
//
// El dictado es el mismo que el del composer de Sessions (`useDictationCore`:
// trozos cortados en las pausas, parar/seguir, autoapagado y errores de micro
// concretos) contra el mismo backend (`sesiones_transcribe`, Whisper). El texto
// dictado se añade al borrador y nunca se envía solo.
//
// La fila solo existe mientras el chat está en «input»: cerrar el chat
// (Esc, ×), enviar o desmontar la ventana la desmonta y el núcleo apaga el
// micro (pistas del MediaStream paradas). El trozo en curso se transcribe
// igualmente y cae en el borrador, que sobrevive al cierre.

import { useCallback, useState, type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { joinDictated } from "../../sesiones/components/composer/dictation";
import {
  useDictationCore,
  type DictationStatus,
  type TranscribeFn,
} from "../../sesiones/components/composer/useDictationCore";
import "./mascotDictation.css";

/** Mismo comando que usa Sessions (src/sesiones/api-tauri.ts). */
export const transcribeViaTauri: TranscribeFn = (audioB64, mime) =>
  invoke<string>("sesiones_transcribe", { audioB64, mime });

interface Props {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  placeholder: string;
  canSend: boolean;
  onSend: () => void;
  /** Teclas del cuadro (Enter envía, Esc cierra); Ctrl+Espacio lo atiende la fila. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Inyectable para los tests; por defecto, el backend de Tauri. */
  transcribe?: TranscribeFn;
}

const MIC_TITLE: Record<DictationStatus, string> = {
  off: "Voz: dictar al cuadro de texto (Ctrl+Espacio); vuelve a pulsar para pausar",
  starting: "Abriendo el micrófono… (pulsa para cancelar)",
  listening: "Escuchando: pulsa para pausar el dictado (Ctrl+Espacio)",
};

function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2.5" strokeLinecap="round" />
    </svg>
  );
}

export function MascotInputRow(p: Props) {
  const [note, setNote] = useState<string | null>(null);
  const { setDraft } = p;
  const onText = useCallback((piece: string) => setDraft((d) => joinDictated(d, piece)), [setDraft]);
  const dictation = useDictationCore(p.transcribe ?? transcribeViaTauri, onText, setNote);

  const toggleMic = () => {
    if (dictation.status === "off") setNote(null);
    dictation.toggle();
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.code === "Space") {
      e.preventDefault();
      toggleMic();
      return;
    }
    p.onKeyDown(e);
  };

  const transcribing = dictation.pending > 0;
  return (
    <>
      <div className="mascot-input-row">
        <textarea
          ref={p.inputRef}
          className="mascot-input"
          rows={2}
          value={p.draft}
          placeholder={p.placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={keyDown}
        />
        <button
          type="button"
          className="mascot-mic"
          data-state={dictation.status}
          aria-label="Voz"
          aria-pressed={dictation.status !== "off"}
          title={MIC_TITLE[dictation.status]}
          onClick={toggleMic}
        >
          <MicIcon />
        </button>
        <button type="button" className="mascot-send" aria-label="Enviar" disabled={!p.canSend} onClick={p.onSend}>
          ➤
        </button>
      </div>
      {(note || transcribing) && (
        <div className={note ? "mascot-dictation-note mascot-dictation-note--error" : "mascot-dictation-note"} role={note ? "alert" : "status"}>
          {note ?? "transcribiendo…"}
        </div>
      )}
    </>
  );
}
