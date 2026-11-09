// Settings/api-keys/ProviderKeysGroup.tsx — lista de claves de providers de
// IA de un grupo (de pago o gratuitas). Cada fila lleva el botón «Probar»
// (ai_router_discover_models) y el aviso de secuestro de ANTHROPIC_API_KEY
// cuelga de esa fila concreta.

import { AnthropicHijackWarning } from "./AnthropicHijackWarning";
import { KeyFieldRow } from "./KeyFieldRow";
import { ProbeButton } from "./ProbeButton";
import type { EnvKeyStatus, FieldState, ProviderKeyDef } from "./types";
import type { ProbeState } from "./useModelProbe";

interface ProviderKeysGroupProps {
  defs: ProviderKeyDef[];
  fields: Record<string, FieldState>;
  statuses: Record<string, EnvKeyStatus>;
  probes: Record<string, ProbeState>;
  onChange: (envVar: string, value: string) => void;
  onToggleVisible: (envVar: string) => void;
  onRemove: (envVar: string) => void;
  onProbe: (envVar: string, keyConfigured: boolean | undefined) => void;
}

export function ProviderKeysGroup({
  defs,
  fields,
  statuses,
  probes,
  onChange,
  onToggleVisible,
  onRemove,
  onProbe,
}: ProviderKeysGroupProps) {
  return (
    <ul className="flex flex-col gap-3">
      {defs.map((def) => (
        <KeyFieldRow
          key={def.envVar}
          def={def}
          state={fields[def.envVar]}
          status={statuses[def.envVar]}
          onChange={onChange}
          onToggleVisible={onToggleVisible}
          onRemove={onRemove}
          extra={
            <>
              <ProbeButton
                state={probes[def.envVar]}
                onProbe={() => onProbe(def.envVar, statuses[def.envVar]?.configured)}
              />
              {def.envVar === "ANTHROPIC_API_KEY" && (
                <AnthropicHijackWarning
                  expanded={
                    statuses[def.envVar]?.configured === true ||
                    (fields[def.envVar]?.value ?? "") !== ""
                  }
                />
              )}
            </>
          }
        />
      ))}
    </ul>
  );
}
