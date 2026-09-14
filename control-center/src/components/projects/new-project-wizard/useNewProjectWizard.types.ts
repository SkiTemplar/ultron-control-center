// Shape del hook useNewProjectWizard.ts — separado del hook para mantener
// ese fichero por debajo del limite de 400 lineas del proyecto.

import type { RefObject } from "react";
import type {
  CliEntry,
  CliError,
  CliRoot,
  CliTemplate,
  RootKind,
} from "../../../lib/project-create-cli";
import type { CreateResult, StepId } from "./types";

export interface UseNewProjectWizardResult {
  // Paso 1: raiz
  roots: CliRoot[] | null;
  rootsError: CliError | null;
  loadingRoots: boolean;
  rootId: string | null;
  setRootId: (id: string) => void;
  loadRoots: () => void;
  selectedRoot: CliRoot | null;
  kind: RootKind | null;

  // Paso 2: asignatura
  subjects: CliEntry[] | null;
  subjectsError: CliError | null;
  subjectRelPath: string | null;
  setSubjectRelPath: (relPath: string) => void;
  showNewSubject: boolean;
  setShowNewSubject: (updater: (v: boolean) => boolean) => void;
  subjectCode: string;
  setSubjectCode: (v: string) => void;
  subjectName: string;
  setSubjectName: (v: string) => void;
  subjectBusy: boolean;
  subjectCreateError: string | null;
  createSubject: () => Promise<void>;

  // Paso 3: subcarpeta
  currentSub: string;
  setCurrentSub: (v: string) => void;
  entries: CliEntry[] | null;
  folderError: CliError | null;
  loadingFolder: boolean;
  newFolderName: string;
  setNewFolderName: (v: string) => void;
  showNewFolder: boolean;
  setShowNewFolder: (updater: (v: boolean) => boolean) => void;
  folderBusy: boolean;
  baseSub: string;
  crumbSegments: string[];
  enterFolder: (entry: CliEntry) => void;
  goToCrumb: (depth: number) => void;
  createFolder: () => Promise<void>;

  // Paso 4: nombre
  name: string;
  setName: (v: string) => void;
  nameInputRef: RefObject<HTMLInputElement | null>;
  nameError: string | null;

  // Paso 5: plantilla
  templates: CliTemplate[] | null;
  templatesError: CliError | null;
  templateId: string | null;
  setTemplateId: (id: string) => void;
  dueDate: string;
  setDueDate: (v: string) => void;
  selectedTemplate: CliTemplate | null;

  // Paso 6: opciones
  gitInit: boolean;
  setGitInit: (v: boolean) => void;
  claudeMd: boolean;
  setClaudeMd: (v: boolean) => void;
  openIde: string;
  setOpenIde: (v: string) => void;

  // Navegacion del stepper
  steps: StepId[];
  stepIndex: number;
  currentStep: StepId;
  canAdvance: () => boolean;
  next: () => void;
  back: () => void;

  // Creacion / resultado
  creating: boolean;
  result: CreateResult | null;
  setResult: (r: CreateResult | null) => void;
  previewPath: string | null;
  submitCreate: () => Promise<void>;
  finishAndClose: () => void;
}
