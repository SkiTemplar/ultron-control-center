// Barrel del asistente "Nuevo proyecto": un solo punto de import para el
// componente raiz (../NewProjectWizard.tsx) y para los tests.

export { useNewProjectWizard } from "./useNewProjectWizard";
export type { UseNewProjectWizardResult } from "./useNewProjectWizard.types";
export { TipoStep, type TipoStepProps } from "./TipoStep";
export { AsignaturaStep, type AsignaturaStepProps } from "./AsignaturaStep";
export { CarpetaStep, type CarpetaStepProps } from "./CarpetaStep";
export { NombreStep, type NombreStepProps } from "./NombreStep";
export { PlantillaStep, type PlantillaStepProps } from "./PlantillaStep";
export { OpcionesStep, type OpcionesStepProps } from "./OpcionesStep";
export { ResultView, type ResultViewProps } from "./ResultView";
export { ErrorBox, type ErrorBoxProps } from "./ErrorBox";
export type { CreateResult, IdeOption, NewProjectWizardProps, StepId } from "./types";
export { IDE_OPTIONS, inputStyle, labelStyle } from "./types";
