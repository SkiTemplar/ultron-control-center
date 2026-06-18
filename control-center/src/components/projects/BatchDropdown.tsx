// ULTRON Control Center - BatchDropdown
//
// Boton "Run batch" para el header del tab Projects. Lista los .bat / .cmd /
// .ps1 que la AI (o el usuario) deja en `~/.ultron/batches/` cuando hay un
// comando que el sandbox no puede ejecutar (instalaciones interactivas,
// elevacion, etc.). Un click en un item invoca `execute_batch` en el backend
// y muestra el stdout/stderr resultante como toast inline.
//
// Backend: src-tauri/src/commands/batches.rs
//   list_batches()              -> Vec<BatchEntry>
//   execute_batch(name)         -> BatchRunResult
//   clear_all_batches()         -> BatchCleanupReport
//   batches_enqueue_manual(...) -> BatchQueueEntry   (para la IA)

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
    rootRef,
    refresh,
    requeue,
    dismissQueue,
    run,
    runFromQueue,
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
          error={error}
          runningName={runningName}
          pendingDeleteName={pendingDeleteName}
          setPendingDeleteName={setPendingDeleteName}
          confirmingClearAll={confirmingClearAll}
          setConfirmingClearAll={setConfirmingClearAll}
          queue={queue}
          queueBusyId={queueBusyId}
          onRefresh={() => void refresh()}
          onClearAll={() => void clearAll()}
          onRun={(name) => void run(name)}
          onDeleteSingle={(name) => void deleteSingle(name)}
          onRunFromQueue={(entry) => void runFromQueue(entry)}
          onRequeue={(entry) => void requeue(entry)}
          onDismissQueue={(entry) => void dismissQueue(entry)}
        />
      )}
    </div>
  );
}
