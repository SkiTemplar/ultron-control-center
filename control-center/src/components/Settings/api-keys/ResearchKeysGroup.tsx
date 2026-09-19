// Settings/api-keys/ResearchKeysGroup.tsx — grupo "Investigación (buscador
// de papers)": dos claves de servicio + dos emails de contacto (nunca
// enmascarados, ver EnvKeyStatus.is_secret).

import { KeyFieldRow } from "./KeyFieldRow";
import { RESEARCH_KEYS } from "./key-catalog";
import type { EnvKeyStatus, FieldState, ProviderKeyDef } from "./types";

interface ResearchKeysGroupProps {
  fields: Record<string, FieldState>;
  statuses: Record<string, EnvKeyStatus>;
  onChange: (envVar: string, value: string) => void;
  onToggleVisible: (envVar: string) => void;
  onDelete: (def: ProviderKeyDef) => void;
  borrando: string | null;
}

export function ResearchKeysGroup({
  fields,
  statuses,
  onChange,
  onToggleVisible,
  onDelete,
  borrando,
}: ResearchKeysGroupProps) {
  return (
    <>
      <div className="mb-3 mt-6 border-t pt-5" style={{ borderColor: "var(--color-border)" }}>
        <h3 className="mb-1 text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
          Investigación (buscador de papers)
        </h3>
        <p
          className="mb-3 text-[12px] leading-relaxed"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Claves y emails de contacto que usa el buscador de papers del TFG (
          <code style={{ fontFamily: "var(--font-mono)" }}>hooks/scripts/lib/research/</code>
          ). Los dos emails no son secretos: se guardan y se muestran completos.
        </p>
      </div>
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
            onDelete={onDelete}
            borrando={borrando === def.envVar}
          />
        ))}
      </ul>
    </>
  );
}
