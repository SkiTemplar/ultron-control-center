// Estado y orquestacion del asistente "Nuevo proyecto": envuelve el CLI
// `~/.ultron/scripts/project-create.mjs` (via el comando Tauri
// `project_create_cli`, ver src/lib/project-create-cli.ts) para el stepper
// de 6 pasos descrito en ../NewProjectWizard.tsx.
//
// El componente raiz solo consume este hook y renderiza; toda mutacion de
// estado vive aqui.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  cliCreate,
  cliList,
  cliMkdir,
  cliRoots,
  cliSubjectNew,
  cliTemplates,
  relPathFromRoot,
  type CliEntry,
  type CliError,
  type CliRoot,
  type CliTemplate,
  type RootKind,
} from "../../../lib/project-create-cli";
import { validateProjectName } from "../../../lib/project-name";
import type { CreateResult, NewProjectWizardProps, StepId } from "./types";
import type { UseNewProjectWizardResult } from "./useNewProjectWizard.types";

export function useNewProjectWizard({
  open,
  onClose,
  onCreated,
}: NewProjectWizardProps): UseNewProjectWizardResult {
  // -- Paso 1: raíz (asignatura/personal) --------------------------------
  const [roots, setRoots] = useState<CliRoot[] | null>(null);
  const [rootsError, setRootsError] = useState<CliError | null>(null);
  const [loadingRoots, setLoadingRoots] = useState(false);
  const [rootId, setRootId] = useState<string | null>(null);

  // -- Paso 2: asignatura (solo kind === "asignatura") --------------------
  const [subjects, setSubjects] = useState<CliEntry[] | null>(null);
  const [subjectsError, setSubjectsError] = useState<CliError | null>(null);
  const [subjectRelPath, setSubjectRelPath] = useState<string | null>(null);
  const [showNewSubject, setShowNewSubject] = useState(false);
  const [subjectCode, setSubjectCode] = useState("");
  const [subjectName, setSubjectName] = useState("");
  const [subjectBusy, setSubjectBusy] = useState(false);
  const [subjectCreateError, setSubjectCreateError] = useState<string | null>(null);

  // -- Paso 3: navegador de subcarpetas ------------------------------------
  const [currentSub, setCurrentSub] = useState("");
  const [entries, setEntries] = useState<CliEntry[] | null>(null);
  const [folderError, setFolderError] = useState<CliError | null>(null);
  const [loadingFolder, setLoadingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [folderBusy, setFolderBusy] = useState(false);
  const [confirmedSub, setConfirmedSub] = useState<string | null>(null);

  // -- Paso 4: nombre del proyecto -----------------------------------------
  const [name, setName] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  // -- Paso 5: plantilla -----------------------------------------------------
  const [templates, setTemplates] = useState<CliTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState<CliError | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState("");

  // -- Paso 6: opciones -------------------------------------------------------
  const [gitInit, setGitInit] = useState(true);
  const [claudeMd, setClaudeMd] = useState(true);
  const [openIde, setOpenIde] = useState("");

  // -- Navegación del stepper -------------------------------------------------
  const [stepIndex, setStepIndex] = useState(0);

  // -- Creación / resultado -----------------------------------------------------
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<CreateResult | null>(null);

  const selectedRoot = useMemo(
    () => roots?.find((r) => r.id === rootId) ?? null,
    [roots, rootId],
  );
  const kind: RootKind | null = selectedRoot?.kind ?? null;

  const steps: StepId[] = useMemo(
    () =>
      kind === "asignatura"
        ? ["tipo", "asignatura", "carpeta", "nombre", "plantilla", "opciones"]
        : ["tipo", "carpeta", "nombre", "plantilla", "opciones"],
    [kind],
  );
  const currentStep = steps[stepIndex] ?? steps[0];

  // ---------------------------------------------------------------------
  // Reset + carga inicial
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    setStepIndex(0);
    setRootId(null);
    setSubjects(null);
    setSubjectRelPath(null);
    setShowNewSubject(false);
    setSubjectCode("");
    setSubjectName("");
    setSubjectCreateError(null);
    setCurrentSub("");
    setEntries(null);
    setConfirmedSub(null);
    setName("");
    setTemplates(null);
    setTemplateId(null);
    setDueDate("");
    setGitInit(true);
    setClaudeMd(true);
    setOpenIde("");
    setResult(null);
    void loadRoots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function loadRoots() {
    setLoadingRoots(true);
    setRootsError(null);
    const r = await cliRoots();
    if (r.ok) {
      setRoots(r.roots);
    } else {
      setRoots(null);
      setRootsError(r.error);
    }
    setLoadingRoots(false);
  }

  // Paso 2: cargar asignaturas del root elegido.
  useEffect(() => {
    if (!open || kind !== "asignatura" || !selectedRoot) return;
    void loadSubjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, selectedRoot?.id]);

  async function loadSubjects() {
    if (!selectedRoot) return;
    setSubjectsError(null);
    const r = await cliList(selectedRoot.id);
    if (r.ok) {
      setSubjects(r.entries.filter((e) => e.isSubject));
    } else {
      setSubjects(null);
      setSubjectsError(r.error);
    }
  }

  async function createSubject() {
    if (!selectedRoot) return;
    const code = subjectCode.trim();
    const nameErr = validateProjectName(subjectName);
    if (!code) {
      setSubjectCreateError("El código no puede estar vacío (p.ej. ASIG).");
      return;
    }
    if (nameErr) {
      setSubjectCreateError(nameErr);
      return;
    }
    setSubjectBusy(true);
    setSubjectCreateError(null);
    const r = await cliSubjectNew(selectedRoot.id, code, subjectName.trim());
    setSubjectBusy(false);
    if (!r.ok) {
      setSubjectCreateError(r.error.message);
      return;
    }
    const rel = relPathFromRoot(selectedRoot, r.subjectPath);
    setSubjectRelPath(rel);
    setShowNewSubject(false);
    setSubjectCode("");
    setSubjectName("");
    await loadSubjects();
  }

  // Paso 3: cargar el contenido de la carpeta actual cada vez que cambia.
  useEffect(() => {
    if (!open || currentStep !== "carpeta" || !selectedRoot) return;
    void loadFolder(currentSub);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentStep, selectedRoot?.id, currentSub]);

  // Al entrar en el paso "carpeta", arrancar la navegación en la asignatura
  // elegida (o en la raíz del root, para personal).
  useEffect(() => {
    if (currentStep !== "carpeta") return;
    setCurrentSub(kind === "asignatura" ? subjectRelPath ?? "" : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep]);

  async function loadFolder(sub: string) {
    if (!selectedRoot) return;
    setLoadingFolder(true);
    setFolderError(null);
    const r = await cliList(selectedRoot.id, sub || undefined);
    setLoadingFolder(false);
    if (r.ok) {
      setEntries(r.entries);
    } else {
      setEntries(null);
      setFolderError(r.error);
    }
  }

  function enterFolder(entry: CliEntry) {
    if (entry.isProject) {
      const ok = window.confirm(
        `"${entry.name}" ya es un proyecto. ¿Crear el nuevo proyecto DENTRO de él de todos modos?`,
      );
      if (!ok) return;
    }
    setCurrentSub((cur) => (cur ? `${cur}/${entry.name}` : entry.name));
  }

  const baseSub = kind === "asignatura" ? subjectRelPath ?? "" : "";
  const crumbSegments = currentSub
    .slice(baseSub.length)
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);

  function goToCrumb(depth: number) {
    const rel = crumbSegments.slice(0, depth).join("/");
    setCurrentSub(rel ? (baseSub ? `${baseSub}/${rel}` : rel) : baseSub);
  }

  async function createFolder() {
    if (!selectedRoot) return;
    const nameErr = validateProjectName(newFolderName);
    if (nameErr) {
      setFolderError({ code: "INVALID_NAME", message: nameErr });
      return;
    }
    setFolderBusy(true);
    const r = await cliMkdir(selectedRoot.id, currentSub, newFolderName.trim());
    setFolderBusy(false);
    if (!r.ok) {
      setFolderError(r.error);
      return;
    }
    const created = newFolderName.trim();
    setNewFolderName("");
    setShowNewFolder(false);
    setCurrentSub((cur) => (cur ? `${cur}/${created}` : created));
  }

  // Paso 5: cargar plantillas filtradas por kind.
  useEffect(() => {
    if (!open || currentStep !== "plantilla" || !kind || templates) return;
    void loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentStep, kind]);

  async function loadTemplates() {
    if (!kind) return;
    setTemplatesError(null);
    const r = await cliTemplates(kind);
    if (r.ok) {
      setTemplates(r.templates);
    } else {
      setTemplates(null);
      setTemplatesError(r.error);
    }
  }

  // Autofocus del nombre al llegar a ese paso.
  useEffect(() => {
    if (currentStep !== "nombre") return;
    const id = window.setTimeout(() => nameInputRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [currentStep]);

  // Escape cierra, salvo mientras hay una creación en curso.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !creating) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, creating, onClose]);

  const nameError = currentStep === "nombre" ? validateProjectName(name) : null;
  const selectedTemplate = templates?.find((t) => t.id === templateId) ?? null;

  function canAdvance(): boolean {
    switch (currentStep) {
      case "tipo":
        return !!selectedRoot;
      case "asignatura":
        return !!subjectRelPath;
      case "carpeta":
        return confirmedSub !== null;
      case "nombre":
        return validateProjectName(name) === null;
      case "plantilla":
        return !!selectedTemplate && selectedTemplate.available;
      case "opciones":
        return true;
      default:
        return false;
    }
  }

  function next() {
    if (currentStep === "carpeta") setConfirmedSub(currentSub);
    setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  }
  function back() {
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  const finalSub = confirmedSub ?? currentSub;
  const previewPath =
    selectedRoot && finalSub
      ? `${selectedRoot.path.replace(/[\\/]+$/, "")}\\${finalSub.replace(/\//g, "\\")}\\${name.trim() || "…"}`
      : selectedRoot
        ? `${selectedRoot.path.replace(/[\\/]+$/, "")}\\${name.trim() || "…"}`
        : null;

  async function submitCreate() {
    if (!selectedRoot || !templateId) return;
    setCreating(true);
    const r = await cliCreate({
      root: selectedRoot.id,
      sub: finalSub,
      name: name.trim(),
      template: templateId,
      git: gitInit,
      claudeMd,
      due: selectedTemplate?.id === "trabajo-entrega" && dueDate ? dueDate : undefined,
    });
    setCreating(false);
    if (r.ok) {
      setResult({ ok: true, data: r });
      if (openIde) {
        void invoke("open_project_in_ide", { path: r.projectPath, preferredIde: openIde }).catch(
          () => {
            /* no bloquea el resultado — el botón manual sigue disponible */
          },
        );
      }
    } else {
      setResult({ ok: false, error: r.error, steps: r.steps });
    }
  }

  function finishAndClose() {
    if (result?.ok) onCreated?.(result.data.projectPath);
    onClose();
  }

  return {
    roots, rootsError, loadingRoots, rootId, setRootId, loadRoots, selectedRoot, kind,
    subjects, subjectsError, subjectRelPath, setSubjectRelPath, showNewSubject, setShowNewSubject,
    subjectCode, setSubjectCode, subjectName, setSubjectName, subjectBusy, subjectCreateError, createSubject,
    currentSub, setCurrentSub, entries, folderError, loadingFolder, newFolderName, setNewFolderName,
    showNewFolder, setShowNewFolder, folderBusy, baseSub, crumbSegments, enterFolder, goToCrumb, createFolder,
    name, setName, nameInputRef, nameError,
    templates, templatesError, templateId, setTemplateId, dueDate, setDueDate, selectedTemplate,
    gitInit, setGitInit, claudeMd, setClaudeMd, openIde, setOpenIde,
    steps, stepIndex, currentStep, canAdvance, next, back,
    creating, result, setResult, previewPath, submitCreate, finishAndClose,
  };
}
