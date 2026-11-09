type ArchiveDoneModalProps = {
  archiveName: string;
  setArchiveName: (v: string) => void;
  archiveBusy: boolean;
  setArchiveModalOpen: (v: boolean) => void;
  setArchiveName_reset: () => void;
  archiveDone: (name: string) => void;
};

export function ArchiveDoneModal({
  archiveName,
  setArchiveName,
  archiveBusy,
  setArchiveModalOpen,
  setArchiveName_reset,
  archiveDone,
}: ArchiveDoneModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      onClick={() => {
        if (!archiveBusy) {
          setArchiveModalOpen(false);
          setArchiveName_reset();
        }
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-md bg-[var(--color-surface-1)] p-4 shadow-lg"
        style={{ border: "1px solid var(--color-border-strong)" }}
      >
        <h3 className="text-[14px] font-semibold text-[var(--color-text)]">
          Archivar las tarjetas de Done
        </h3>
        <p className="mt-1 text-[11.5px] text-[var(--color-text-tertiary)]">
          Mueve todas las tarjetas de las columnas Done a un archivo con
          nombre. Desaparecen del tablero, pero siguen disponibles en «Ver
          archivados».
        </p>
        <label className="mt-3 block text-[10.5px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
          Nombre del archivo
        </label>
        <input
          autoFocus
          value={archiveName}
          onChange={(e) => setArchiveName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && archiveName.trim() && !archiveBusy) {
              void archiveDone(archiveName);
            }
          }}
          placeholder={`p. ej. ${new Date().toISOString().slice(0, 10)}-sprint`}
          className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px] outline-none"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
        />
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={archiveBusy}
            onClick={() => {
              setArchiveModalOpen(false);
              setArchiveName_reset();
            }}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={archiveBusy || !archiveName.trim()}
            onClick={() => void archiveDone(archiveName)}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {archiveBusy ? "Archivando…" : "Archivar"}
          </button>
        </div>
      </div>
    </div>
  );
}
