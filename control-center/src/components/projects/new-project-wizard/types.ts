// Tipos y constantes compartidas entre los pasos del asistente "Nuevo
// proyecto" (ver ../NewProjectWizard.tsx). Sin logica: solo shapes y
// valores estaticos reutilizados por mas de un paso.

import type { CliError, CliStep, CreateData } from "../../../lib/project-create-cli";

export type StepId = "tipo" | "asignatura" | "carpeta" | "nombre" | "plantilla" | "opciones";

export type CreateResult =
  | { ok: true; data: CreateData }
  | { ok: false; error: CliError; steps?: CliStep[] };

export interface NewProjectWizardProps {
  open: boolean;
  onClose: () => void;
  /** Se dispara tras un `create` con exito, con la ruta absoluta del
   *  proyecto. El padre (Projects.tsx) la usa para refrescar la lista. */
  onCreated?: (projectPath: string) => void;
}

export interface IdeOption {
  value: string;
  label: string;
}

// Mismo catalogo que ProjectWizardModal.tsx, para que "abrir en IDE al
// terminar" ofrezca exactamente los IDEs que la app ya sabe lanzar.
export const IDE_OPTIONS: IdeOption[] = [
  { value: "", label: "No abrir automáticamente" },
  { value: "vscode", label: "VS Code" },
  { value: "cursor", label: "Cursor" },
  { value: "code-insiders", label: "VS Code Insiders" },
  { value: "zed", label: "Zed" },
  { value: "intellij", label: "IntelliJ IDEA" },
  { value: "rider", label: "Rider" },
  { value: "webstorm", label: "WebStorm" },
  { value: "pycharm", label: "PyCharm" },
  { value: "clion", label: "CLion" },
  { value: "androidstudio", label: "Android Studio" },
  { value: "fleet", label: "JetBrains Fleet" },
  { value: "nvim", label: "Neovim" },
  { value: "sublime", label: "Sublime Text" },
];

export const labelStyle = { color: "var(--color-text-tertiary)" } as const;

export const inputStyle = {
  background: "var(--color-surface-0)",
  color: "var(--color-text)",
  border: "1px solid var(--color-border-strong)",
  outline: "none",
} as const;
