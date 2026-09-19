// Settings/api-keys/ProviderKeysGroup.tsx — lista de claves de providers de
// IA (AI Router). El aviso de secuestro de ANTHROPIC_API_KEY cuelga de esa
// fila concreta via `extra`.

import { AnthropicHijackWarning } from "./AnthropicHijackWarning";
import { KeyFieldRow } from "./KeyFieldRow";
import { PROVIDER_KEYS } from "./key-catalog";
import type { EnvKeyStatus, FieldState, ProviderKeyDef } from "./types";

interface ProviderKeysGroupProps {
  fields: Record<string, FieldState>;
  statuses: Record<string, EnvKeyStatus>;
  onChange: (envVar: string, value: string) => void;
  onToggleVisible: (envVar: string) => void;
  onDelete: (def: ProviderKeyDef) => void;
  borrando: string | null;
}

export function ProviderKeysGroup({
  fields,
  statuses,
  onChange,
  onToggleVisible,
  onDelete,
  borrando,
}: ProviderKeysGroupProps) {
  return (
    <ul className="flex flex-col gap-3">
      {PROVIDER_KEYS.map((def) => (
        <KeyFieldRow
          key={def.envVar}
          def={def}
          state={fields[def.envVar]}
          status={statuses[def.envVar]}
          onChange={onChange}
          onToggleVisible={onToggleVisible}
          onDelete={onDelete}
          borrando={borrando === def.envVar}
          extra={
            def.envVar === "ANTHROPIC_API_KEY" ? <AnthropicHijackWarning /> : undefined
          }
        />
      ))}
    </ul>
  );
}
