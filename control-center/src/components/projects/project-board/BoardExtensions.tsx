// Punto de extensión del tablero por proyecto. Un tablero normal no lo usa y
// se pinta como siempre; la sección Portfolio lo usa para añadir la acción
// «Abrir» de cada tarjeta, un «+ Añadir» visible al pie de cada columna y el
// selector de proyecto vinculado del editor.

import { createContext, useContext, type ReactNode } from "react";
import type { Card } from "../../../types";

export type LinkableProject = { id: string; name: string };

export type BoardExtensions = {
  /** Acciones extra al pie de cada tarjeta (deben parar la propagación del clic). */
  renderCardActions?: (card: Card) => ReactNode;
  /** Botón «+ Añadir» siempre visible al final de cada columna. */
  showColumnFooterAdd?: boolean;
  /** Con valor, el editor de tarjetas enseña «Proyecto vinculado». */
  linkableProjects?: LinkableProject[];
};

const NO_EXTENSIONS: BoardExtensions = {};

export const BoardExtensionsContext = createContext<BoardExtensions>(NO_EXTENSIONS);

export function useBoardExtensions(): BoardExtensions {
  return useContext(BoardExtensionsContext);
}

type LinkedProjectFieldProps = {
  projects: LinkableProject[];
  value: string;
  onChange: (id: string) => void;
};

/** Selector «Proyecto vinculado» del editor de tarjetas (solo en Portfolio). */
export function LinkedProjectField({ projects, value, onChange }: LinkedProjectFieldProps) {
  // Un vínculo a un id que ya no está registrado se conserva como opción
  // visible: guardar la tarjeta no debe borrarlo sin que se vea.
  const isUnknown = value !== "" && !projects.some((p) => p.id === value);
  return (
    <div className="col-span-2">
      <label htmlFor="card-linked-project" className="mb-1 block text-[var(--color-text-muted)]">
        Proyecto vinculado
      </label>
      <select
        id="card-linked-project"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
      >
        <option value="">(sin vincular: idea o proyecto sin registrar)</option>
        {isUnknown && <option value={value}>{value} (no registrado)</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
