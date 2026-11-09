// Settings/SettingsJsonBackups.tsx — copias que deja cada guardado de
// ~/.claude/settings.json (pestaña settings.json). Es otro concepto que la
// copia espejo semanal de BackupsPanel, así que va en su propia tarjeta: la
// carpeta una sola vez en la cabecera y, por fila, solo el nombre del fichero.
// No hay comando de restaurar en el backend: la única acción es abrir la
// carpeta.

import { useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function SettingsJsonBackups({ dir, files }: { dir: string; files: string[] }) {
  const [error, setError] = useState<string | null>(null);

  async function openDir() {
    setError(null);
    try {
      await openPath(dir);
    } catch (e) {
      setError(`No se pudo abrir la carpeta: ${String(e)}`);
    }
  }

  return (
    <section
      className="mt-4 rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold">Copias de settings.json</h3>
          <p
            className="mt-1 text-[11.5px] leading-relaxed"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Cada guardado de la pestaña settings.json deja aquí una copia del fichero anterior.
          </p>
          <div
            className="mt-1 truncate text-[11.5px]"
            style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}
            title={dir}
          >
            {dir}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void openDir()}
          disabled={!dir}
          className="shrink-0 rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          Abrir carpeta
        </button>
      </div>

      {error && (
        <div className="mt-2 text-[11.5px]" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {files.length === 0 ? (
        <div
          className="mt-3 rounded p-4 text-center text-[12px]"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          Todavía no hay copias. El primer guardado creará una.
        </div>
      ) : (
        <ul
          className="mt-3 rounded"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border)",
          }}
        >
          {files.map((f, i) => (
            <li
              key={f}
              className="truncate border-t px-3 py-1.5 text-[12px]"
              style={{
                borderColor: i === 0 ? "transparent" : "var(--color-border)",
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-secondary)",
              }}
              title={f}
            >
              {baseName(f)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
