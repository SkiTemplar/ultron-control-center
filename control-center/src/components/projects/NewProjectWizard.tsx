// mar.ia — asistente "Nuevo proyecto" (Projects tab).
//
// Envuelve el CLI `~/.maria/scripts/project-create.mjs` (via el comando
// Tauri `project_create_cli`, ver src/lib/project-create-cli.ts) en un
// stepper de 6 pasos: Tipo -> Asignatura (solo asignaturas) -> Subcarpeta ->
// Nombre -> Plantilla -> Opciones -> (Crear) -> Resultado. El objetivo es
// que el usuario NUNCA tenga que abrir el Explorador de Windows: todo el
// árbol de carpetas se navega dentro del propio asistente.
//
// Estado y orquestacion viven en useNewProjectWizard (mismo directorio
// new-project-wizard/); este componente solo pinta el layout del dialog y
// delega cada paso en su subcomponente.

import {
  AsignaturaStep,
  CarpetaStep,
  NombreStep,
  OpcionesStep,
  PlantillaStep,
  ResultView,
  TipoStep,
  useNewProjectWizard,
  type NewProjectWizardProps,
} from "./new-project-wizard";

export function NewProjectWizard({ open, onClose, onCreated }: NewProjectWizardProps) {
  const wizard = useNewProjectWizard({ open, onClose, onCreated });

  if (!open) return null;

  const {
    roots, rootsError, loadingRoots, rootId, setRootId, loadRoots, selectedRoot, kind,
    subjects, subjectsError, subjectRelPath, setSubjectRelPath, showNewSubject, setShowNewSubject,
    subjectCode, setSubjectCode, subjectName, setSubjectName, subjectBusy, subjectCreateError, createSubject,
    baseSub, crumbSegments, entries, folderError, loadingFolder, enterFolder, goToCrumb,
    showNewFolder, setShowNewFolder, newFolderName, setNewFolderName, folderBusy, createFolder,
    name, setName, nameInputRef, nameError,
    templates, templatesError, templateId, setTemplateId, dueDate, setDueDate, selectedTemplate,
    gitInit, setGitInit, claudeMd, setClaudeMd, openIde, setOpenIde,
    steps, stepIndex, currentStep, canAdvance, next, back,
    creating, result, setResult, previewPath, submitCreate, finishAndClose,
  } = wizard;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => {
        if (!creating) onClose();
      }}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-lg shadow-xl"
        style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border)" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="new-project-wizard-title"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b p-4" style={{ borderColor: "var(--color-border)" }}>
          <div>
            <h2 id="new-project-wizard-title" className="text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
              Nuevo proyecto
            </h2>
            <p className="mt-1 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              Sin abrir el Explorador: elige carpeta, plantilla y listo.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={creating}
            className="rounded px-2 py-0.5 text-[12px] transition-colors disabled:opacity-40"
            style={{ background: "transparent", color: "var(--color-text-tertiary)", border: "1px solid var(--color-border)" }}
            title="Cerrar (Esc)"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>

        {result ? (
          <ResultView result={result} onClose={finishAndClose} onRetry={() => setResult(null)} />
        ) : (
          <>
            {/* Stepper header */}
            <div className="flex items-center gap-1 border-b px-4 py-2" style={{ borderColor: "var(--color-border)" }}>
              {steps.map((s, i) => (
                <div
                  key={s}
                  className="flex items-center gap-1 text-[10.5px]"
                  style={{ color: i === stepIndex ? "var(--color-text)" : "var(--color-text-faint)" }}
                >
                  <span
                    className="flex h-4 w-4 items-center justify-center rounded-full text-[9.5px]"
                    style={{
                      background: i <= stepIndex ? "var(--color-accent)" : "var(--color-surface-3)",
                      color: i <= stepIndex ? "var(--color-accent-text)" : "var(--color-text-tertiary)",
                    }}
                  >
                    {i + 1}
                  </span>
                  {i < steps.length - 1 && <span style={{ color: "var(--color-border-strong)" }}>—</span>}
                </div>
              ))}
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-4">
              {currentStep === "tipo" && (
                <TipoStep
                  loading={loadingRoots}
                  roots={roots}
                  error={rootsError}
                  rootId={rootId}
                  onSelect={setRootId}
                  onRetry={loadRoots}
                />
              )}
              {currentStep === "asignatura" && selectedRoot && (
                <AsignaturaStep
                  subjects={subjects}
                  error={subjectsError}
                  selectedRelPath={subjectRelPath}
                  onSelect={setSubjectRelPath}
                  showNew={showNewSubject}
                  onToggleNew={() => setShowNewSubject((v) => !v)}
                  code={subjectCode}
                  onCodeChange={setSubjectCode}
                  name={subjectName}
                  onNameChange={setSubjectName}
                  busy={subjectBusy}
                  createError={subjectCreateError}
                  onCreate={() => void createSubject()}
                />
              )}
              {currentStep === "carpeta" && selectedRoot && (
                <CarpetaStep
                  rootLabel={selectedRoot.label}
                  baseSub={baseSub}
                  crumbs={crumbSegments}
                  onCrumb={goToCrumb}
                  entries={entries}
                  loading={loadingFolder}
                  error={folderError}
                  onEnter={enterFolder}
                  showNew={showNewFolder}
                  onToggleNew={() => setShowNewFolder((v) => !v)}
                  newName={newFolderName}
                  onNewNameChange={setNewFolderName}
                  busy={folderBusy}
                  onCreateFolder={() => void createFolder()}
                />
              )}
              {currentStep === "nombre" && (
                <NombreStep inputRef={nameInputRef} name={name} onChange={setName} error={nameError} />
              )}
              {currentStep === "plantilla" && kind && (
                <PlantillaStep
                  templates={templates}
                  error={templatesError}
                  templateId={templateId}
                  onSelect={setTemplateId}
                  dueDate={dueDate}
                  onDueDateChange={setDueDate}
                  showDueDate={selectedTemplate?.id === "trabajo-entrega"}
                />
              )}
              {currentStep === "opciones" && (
                <OpcionesStep
                  gitInit={gitInit}
                  onGitInitChange={setGitInit}
                  claudeMd={claudeMd}
                  onClaudeMdChange={setClaudeMd}
                  openIde={openIde}
                  onOpenIdeChange={setOpenIde}
                />
              )}
            </div>

            {/* Vista previa de la ruta final */}
            {previewPath && (
              <div
                className="border-t px-4 py-2 text-[11px]"
                style={{ borderColor: "var(--color-border)", color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)" }}
              >
                {previewPath}
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between gap-2 border-t p-3" style={{ borderColor: "var(--color-border)" }}>
              <button
                type="button"
                onClick={back}
                disabled={stepIndex === 0 || creating}
                className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-40"
                style={{ background: "transparent", color: "var(--color-text-secondary)", border: "1px solid var(--color-border-strong)" }}
              >
                Atrás
              </button>
              {currentStep === "opciones" ? (
                <button
                  type="button"
                  onClick={() => void submitCreate()}
                  disabled={creating || !canAdvance()}
                  className="rounded px-4 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
                  style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
                >
                  {creating ? "Creando…" : "Crear proyecto"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={next}
                  disabled={!canAdvance()}
                  className="rounded px-4 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
                  style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
                >
                  Siguiente
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
