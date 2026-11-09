// ULTRON Control Center - BatchDropdown
//
// Botón «Ejecutar .bat» para el header del tab Projects. Lista los .bat / .cmd /
// .ps1 que la AI (o el usuario) deja en `~/.ultron/batches/` cuando hay un
// comando que el sandbox no puede ejecutar (instalaciones interactivas,
// elevacion, etc.). Un click en un item enseña el script (`batch_read_script`);
// solo al confirmar con él a la vista se invoca `execute_batch`, y el
// stdout/stderr resultante sale como toast inline.
//
// La cola de .bat está viva. No confundir con el despacho de tarjetas por PTY
// del kanban, que se retiró el 2026-10-17: aquí no se lanza ningún Claude.
//
// Backend: src-tauri/src/commands/batches_sub/batches.rs
//   list_batches()              -> Vec<BatchEntry>
//   batch_read_script(name)     -> BatchScriptPreview
//   execute_batch(name, reviewed) -> BatchRunResult (rechaza lo no revisado)
//   delete_batch_single(name)   -> ()
//   clear_all_batches()         -> BatchCleanupReport
//   batches_list_queue()        -> BatchQueueListing (cola de batch-capture.js;
//                                  se drena y se cuenta al montar)
//   batches_requeue(id) / batches_dismiss_queue(id)

export type { BatchToast } from "./batch-dropdown/types";
import type { BatchDropdownProps } from "./batch-dropdown/types";
import { useBatchDropdown } from "./batch-dropdown/useBatchDropdown";
import { TriggerButton } from "./batch-dropdown/TriggerButton";
import { DropdownPanel } from "./batch-dropdown/DropdownPanel";

export default function BatchDropdown({
  onResult,
  headerStyle = false,
  cardStyle = false,
}: BatchDropdownProps) {
  const {
    open,
    setOpen,
    batches,
    loading,
    error,
    runningName,
    pendingDeleteName,
    setPendingDeleteName,
    confirmingClearAll,
    setConfirmingClearAll,
    queue,
    queueBusyId,
    queueError,
    rootRef,
    refresh,
    requeue,
    dismissQueue,
    review,
    requestRun,
    confirmRun,
    cancelRun,
    deleteSingle,
    clearAll,
  } = useBatchDropdown(onResult);

  const count = batches?.length ?? 0;
  const queueCount = queue?.length ?? 0;

  return (
    <div
      ref={rootRef}
      className={cardStyle ? "relative flex-1" : "relative"}
      style={cardStyle ? { minWidth: 140 } : undefined}
    >
      <TriggerButton
        open={open}
        onToggle={() => setOpen((v) => !v)}
        runningName={runningName}
        count={count}
        queueCount={queueCount}
        headerStyle={headerStyle}
        cardStyle={cardStyle}
      />

      {open && (
        <DropdownPanel
          batches={batches}
          loading={loading}
          error={[error, queueError].filter(Boolean).join(" · ") || null}
          runningName={runningName}
          pendingDeleteName={pendingDeleteName}
          setPendingDeleteName={setPendingDeleteName}
          confirmingClearAll={confirmingClearAll}
          setConfirmingClearAll={setConfirmingClearAll}
          queue={queue}
          queueBusyId={queueBusyId}
          onRefresh={() => void refresh()}
          onClearAll={() => void clearAll()}
          review={review}
          onRequestRun={(name, entry) => void requestRun(name, entry)}
          onConfirmRun={() => void confirmRun()}
          onCancelRun={cancelRun}
          onDeleteSingle={(name) => void deleteSingle(name)}
          onRequeue={(entry) => void requeue(entry)}
          onDismissQueue={(entry) => void dismissQueue(entry)}
        />
      )}
    </div>
  );
}
