// Settings/api-keys/ResearchKeysGroup.tsx — filas del grupo «Investigación»
// (buscador de papers): dos claves de servicio + dos emails de contacto
// (nunca enmascarados, ver EnvKeyStatus.is_secret). El título y la
// descripción los pone KeyGroupSection.

import { KeyFieldRow } from "./KeyFieldRow";
import { RESEARCH_KEYS } from "./key-catalog";
import type { EnvKeyStatus, FieldState } from "./types";

interface ResearchKeysGroupProps {
  fields: Record<string, FieldState>;
  statuses: Record<string, EnvKeyStatus>;
  onChange: (envVar: string, value: string) => void;
  onToggleVisible: (envVar: string) => void;
  onRemove: (envVar: string) => void;
}

export function ResearchKeysGroup({
  fields,
  statuses,
  onChange,
  onToggleVisible,
  onRemove,
}: ResearchKeysGroupProps) {
  return (
    <ul className="flex flex-col gap-3">
      {RESEARCH_KEYS.map((def) => (
        <KeyFieldRow
          key={def.envVar}
          def={def}
          state={fields[def.envVar]}
          status={statuses[def.envVar]}
          isEmail={def.isEmail}
          onChange={onChange}
          onToggleVisible={onToggleVisible}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}
