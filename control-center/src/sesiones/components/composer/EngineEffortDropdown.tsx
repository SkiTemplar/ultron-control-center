// Effort de Codex (`model_reasoning_effort`) en Ajustes → Motores. Lo guarda el
// backend (`sesiones_engine_effort_set`, cockpit/sesiones/motores-ajustes.json) y
// se aplica al lanzar Codex si el modelo elegido lo admite; los niveles salen de
// la lista de la CLI para ese modelo (`sesiones_engine_effort_get`).

import { useEffect, useState } from "react";
import { reportError } from "../../bootstrap";
import { useApi } from "../../context";
import { usePrefs } from "../../prefs";
import type { EngineEffort } from "../../types";
import { Dropdown, type DropdownOption } from "../Dropdown";
import { IconChevronDown } from "../icons";

const DEFAULT_VALUE = "";

export function EngineEffortDropdown({ triggerClass = "tbtn" }: { triggerClass?: string }) {
  const api = useApi();
  const model = usePrefs().engineModels.codex;
  const [state, setState] = useState<EngineEffort | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    api.engineEffortGet({ engine: "codex", model: model ?? undefined }).then(
      (e) => alive && setState(e),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [api, model]);

  async function select(value: string) {
    try {
      const effort = await api.engineEffortSet({ engine: "codex", effort: value || null });
      setState((s) => ({ effort, levels: s?.levels ?? [] }));
    } catch (e) {
      reportError(e);
    }
  }

  const levels = state?.levels ?? [];
  const value = state?.effort ?? DEFAULT_VALUE;
  const options: DropdownOption[] = [
    { value: DEFAULT_VALUE, label: "Predeterminado", description: "El de ~/.codex/config.toml" },
    ...levels.map((l) => ({ value: l, label: l })),
  ];
  const footer = error
    ? <p className="hint err-text">No se pudo leer el effort: {error}</p>
    : state === null ? <p className="hint">Leyendo niveles…</p>
    : levels.length === 0 ? <p className="hint">Codex no informó de niveles para este modelo.</p> : undefined;

  return (
    <Dropdown label="Effort de Codex" value={value} options={options} onSelect={(v) => void select(v)}
      footer={footer} placement="down" align="end" width={260} triggerClass={triggerClass}
      triggerTitle="Razonamiento con el que se lanza Codex (si el modelo lo admite)"
      testId="engine-effort-codex" trigger={<>Effort: {value || "predeterminado"} <IconChevronDown /></>} />
  );
}
