// Botón de copiar al portapapeles con confirmación breve.

import { useState } from "react";
import { IconCheck, IconCopy } from "../icons";

export function CopyButton({ text, label = "Copiar" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      aria-label={done ? "Copiado" : label}
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1400);
          })
          .catch(() => setDone(false));
      }}
    >
      {done ? <IconCheck /> : <IconCopy />}
      {done ? "Copiado" : label}
    </button>
  );
}
