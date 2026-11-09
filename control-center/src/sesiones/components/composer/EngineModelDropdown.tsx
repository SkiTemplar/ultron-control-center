// Selector del modelo de Codex, Gemini u OpenCode (composer, pestaña Motores y
// Ajustes). Los de OpenCode van agrupados por proveedor.
// La lista sale de la CLI del motor (`sesiones_engine_models`, cacheada en
// engines.ts) y la elección se guarda en las preferencias. Un modelo guardado
// que ya no está en la lista se marca como retirado y no se envía.

import { useEffect, useState } from "react";
import { reportError } from "../../bootstrap";
import { useApi } from "../../context";
import { ENGINE_LABEL, cachedEngineModels, loadEngineModels, modelProvider } from "../../engines";
import { setPrefs, usePrefs } from "../../prefs";
import type { EngineId, EngineModel } from "../../types";
import { Dropdown, type DropdownOption } from "../Dropdown";
import { IconChevronDown } from "../icons";

const DEFAULT_VALUE = "";

function useEngineModels(engine: EngineId): { models: EngineModel[] | null; error: string | null } {
  const api = useApi();
  const [models, setModels] = useState<EngineModel[] | null>(() => cachedEngineModels(engine));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setModels(cachedEngineModels(engine));
    setError(null);
    loadEngineModels(api, engine).then(
      (list) => alive && setModels(list),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [api, engine]);
  return { models, error };
}

interface Props {
  engine: EngineId;
  placement?: "up" | "down";
  triggerClass?: string;
  align?: "start" | "end";
}

export function EngineModelDropdown({ engine, placement = "up", triggerClass = "chipbtn", align }: Props) {
  const prefs = usePrefs();
  const { models, error } = useEngineModels(engine);
  const value = prefs.engineModels[engine] ?? DEFAULT_VALUE;
  const list = models ?? [];
  const retired = Boolean(value) && models !== null && !list.some((m) => m.id === value);
  const options: DropdownOption[] = [
    { value: DEFAULT_VALUE, label: "Predeterminado", description: `El que tenga configurado la CLI de ${ENGINE_LABEL[engine]}` },
    ...list.map((m) => ({ value: m.id, label: m.label, hint: m.id, group: modelProvider(engine, m.id) ?? undefined })),
  ];
  const known = list.find((m) => m.id === value)?.label;
  const current = !value ? "Predeterminado" : retired ? `Predeterminado (${value} ya no está)` : known ?? value;

  function select(id: string) {
    setPrefs({ engineModels: { ...prefs.engineModels, [engine]: id || null } });
  }

  const footer = error
    ? <p className="hint err-text">No se pudo leer la lista: {error}</p>
    : models === null ? <p className="hint">Leyendo modelos…</p> : undefined;

  return (
    <Dropdown label={`Modelo de ${ENGINE_LABEL[engine]}`} value={value} options={options} onSelect={select}
      onOpen={() => error && reportError(`${ENGINE_LABEL[engine]}: ${error}`)}
      footer={footer} placement={placement} align={align} width={300} triggerClass={triggerClass}
      triggerTitle={`Modelo con el que se lanza ${ENGINE_LABEL[engine]}`}
      testId={`engine-model-${engine}`} trigger={<>Modelo: {current} <IconChevronDown /></>} />
  );
}
