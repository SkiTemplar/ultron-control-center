import type { MascotSettings } from "../mascot/settings";
import { MascotCalendarField } from "./MascotCalendarField";
import { SettingsSwitch } from "./SettingsSwitch";

// Settings > Pupus > Grabaciones, llamadas y avisos. Todo local y sin
// tokens: afinidad de ventana (capture.rs), micrófono en uso (calls.rs),
// transcripts de Claude Code y hook de tests (alerts.rs) y el ICS de la uni
// (calendar.rs).

const card: React.CSSProperties = {
  background: "var(--color-surface-2)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: "14px 16px",
};

interface Props {
  s: MascotSettings;
  update: (patch: Partial<MascotSettings>, debounce?: boolean) => void;
}

function Check({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-1.5">
      <SettingsSwitch className="mt-0.5" checked={checked} onChange={onChange} label={label} />
      <span>
        <span className="text-[12.5px]" style={{ color: "var(--color-text)" }}>
          {label}
        </span>
        <span className="block text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          {hint}
        </span>
      </span>
    </label>
  );
}

export function MascotDeskSection({ s, update }: Props) {
  return (
    <section style={card}>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
        Grabaciones, llamadas y avisos
      </h3>
      <Check
        label="Sale en grabaciones de pantalla"
        hint="Las capturas del MCP de escritorio siguen sin él; en cada una desaparece un instante de la grabación."
        checked={s.capturable}
        onChange={(v) => update({ capturable: v })}
      />
      <Check
        label="Se esconde en llamadas"
        hint="Micrófono en uso por cualquier aplicación; un dictado también cuenta."
        checked={s.hide_in_calls}
        onChange={(v) => update({ hide_in_calls: v })}
      />
      <Check
        label="Avisa de builds y tests en rojo"
        hint="Lee los transcripts de Claude Code (Sessions y la CLI) y el resultado del hook de tests; va con un «!» a Sessions o al editor. No cubre Codex."
        checked={s.build_alerts}
        onChange={(v) => update({ build_alerts: v })}
      />
      <Check
        label="Avisa de entregas del calendario"
        hint="Calendario de la uni (ICS), descargado como mucho cada 3 horas. El día antes y el mismo día lleva un calendario en la mano. Solo avisa."
        checked={s.calendar}
        onChange={(v) => update({ calendar: v })}
      />
      <MascotCalendarField disabled={!s.calendar} />
    </section>
  );
}
