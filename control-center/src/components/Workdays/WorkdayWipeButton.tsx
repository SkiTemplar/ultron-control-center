// WorkdayWipeButton — botón "Reset workdays" con confirm modal (H29).
//
// Tauri command: workday_wipe_all() -> WipeReport
// El modal muestra un warning rojo y requiere confirmación explícita.
// Tras el wipe llama a onWiped() para que el padre recargue su estado.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { WipeReport } from "./types";

interface WorkdayWipeButtonProps {
  onWiped: () => void;
}

type ModalState = "closed" | "confirm" | "success" | "error";

export function WorkdayWipeButton({ onWiped }: WorkdayWipeButtonProps) {
  const [modal, setModal] = useState<ModalState>("closed");
  const [report, setReport] = useState<WipeReport | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    setBusy(true);
    setErrMsg(null);
    try {
      const r = await invoke<WipeReport>("workday_wipe_all");
      setReport(r);
      setModal("success");
      onWiped();
    } catch (e: unknown) {
      setErrMsg(String(e));
      setModal("error");
    } finally {
      setBusy(false);
    }
  }

  function handleClose() {
    setModal("closed");
    setReport(null);
    setErrMsg(null);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setModal("confirm")}
        className="rounded px-3 py-1.5 text-[12px] font-medium"
        style={{
          background: "transparent",
          color: "var(--color-danger, #ef4444)",
          border: "1px solid var(--color-danger, #ef4444)",
        }}
      >
        Reset workdays
      </button>

      {modal !== "closed" && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={(e) => {
            if (e.target === e.currentTarget) handleClose();
          }}
        >
          <div
            className="flex w-[420px] flex-col gap-4 rounded-lg p-6 shadow-xl"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {modal === "confirm" && (
              <>
                <div className="flex items-start gap-3">
                  <span
                    className="text-[22px] leading-none"
                    style={{ color: "var(--color-danger, #ef4444)" }}
                  >
                    ⚠
                  </span>
                  <div className="flex flex-col gap-1">
                    <h3
                      className="text-[15px] font-semibold"
                      style={{ color: "var(--color-text)" }}
                    >
                      Resetear todos los workdays
                    </h3>
                    <p
                      className="text-[12px]"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      Esto archivará y borrará todos los workdays actuales.
                      Se creará un ZIP de respaldo antes de eliminar cualquier
                      archivo.
                    </p>
                    <p
                      className="mt-1 text-[11px]"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      Las work-sessions de proyecto no se tocan.
                    </p>
                  </div>
                </div>

                <div
                  className="rounded p-3 text-[12px]"
                  style={{
                    background: "rgba(239,68,68,0.1)",
                    border: "1px solid rgba(239,68,68,0.3)",
                    color: "var(--color-danger, #ef4444)",
                  }}
                >
                  Esta acción no se puede deshacer desde la UI. El archivo ZIP
                  quedará en <code>~/.ultron/cockpit/workdays/</code>.
                </div>

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    disabled={busy}
                    className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
                    style={{
                      background: "transparent",
                      color: "var(--color-text-secondary)",
                      border: "1px solid var(--color-border-strong)",
                    }}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleConfirm()}
                    disabled={busy}
                    className="rounded px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
                    style={{
                      background: "var(--color-danger, #ef4444)",
                      color: "#fff",
                      border: "none",
                    }}
                  >
                    {busy ? "Archivando…" : "Sí, resetear"}
                  </button>
                </div>
              </>
            )}

            {modal === "success" && report && (
              <>
                <div className="flex items-start gap-3">
                  <span
                    className="text-[22px] leading-none"
                    style={{ color: "var(--color-accent, #22c55e)" }}
                  >
                    ✓
                  </span>
                  <div className="flex flex-col gap-1">
                    <h3
                      className="text-[15px] font-semibold"
                      style={{ color: "var(--color-text)" }}
                    >
                      Workdays reseteados
                    </h3>
                    <p
                      className="text-[12px]"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      {report.deleted_count} archivo
                      {report.deleted_count !== 1 ? "s" : ""} eliminado
                      {report.deleted_count !== 1 ? "s" : ""}.
                    </p>
                    {report.archived_path && (
                      <p
                        className="mt-1 break-all text-[10px] font-mono"
                        style={{ color: "var(--color-text-tertiary)" }}
                      >
                        Backup: {report.archived_path}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="rounded px-3 py-1.5 text-[12px] font-medium"
                    style={{
                      background: "var(--color-surface-3)",
                      color: "var(--color-text)",
                      border: "1px solid var(--color-border)",
                    }}
                  >
                    Cerrar
                  </button>
                </div>
              </>
            )}

            {modal === "error" && (
              <>
                <div className="flex items-start gap-3">
                  <span
                    className="text-[22px] leading-none"
                    style={{ color: "var(--color-danger, #ef4444)" }}
                  >
                    ✕
                  </span>
                  <div className="flex flex-col gap-1">
                    <h3
                      className="text-[15px] font-semibold"
                      style={{ color: "var(--color-text)" }}
                    >
                      Error durante el reset
                    </h3>
                    <p
                      className="text-[12px]"
                      style={{ color: "var(--color-danger, #ef4444)" }}
                    >
                      {errMsg}
                    </p>
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="rounded px-3 py-1.5 text-[12px] font-medium"
                    style={{
                      background: "var(--color-surface-3)",
                      color: "var(--color-text)",
                      border: "1px solid var(--color-border)",
                    }}
                  >
                    Cerrar
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
