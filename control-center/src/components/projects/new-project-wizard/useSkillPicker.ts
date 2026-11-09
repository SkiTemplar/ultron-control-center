// Selección de skills de la pool de terceros para el asistente "Nuevo
// proyecto" (plan 2026-10-18-skill-pool, F3). Lee la pool con
// `project-create.mjs skills --template <id>` cada vez que cambia la
// plantilla y preselecciona las sugeridas que ya tienen revisión de
// seguridad. Lo elegido viaja a `create` como `--skills` explícito (o
// `--skills none`), así que el CLI nunca enlaza algo que el usuario no vio.

import { useEffect, useRef, useState } from "react";
import { cliSkills, type CliError, type CliSkill } from "../../../lib/project-create-cli";

export interface SkillPickerState {
  /** null mientras no hay respuesta; [] = pool vacía (la sección no se pinta). */
  skills: CliSkill[] | null;
  error: CliError | null;
  loading: boolean;
  selected: string[];
  toggle: (name: string) => void;
  reload: () => void;
}

/** Preselección: sugeridas por la plantilla y con revisión vigente. */
export function defaultSelection(skills: CliSkill[]): string[] {
  return skills.filter((s) => s.suggested && s.reviewed).map((s) => s.name);
}

export function useSkillPicker(open: boolean, templateId: string | null): SkillPickerState {
  const [skills, setSkills] = useState<CliSkill[] | null>(null);
  const [error, setError] = useState<CliError | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  // Si se cambia de plantilla con una carga en vuelo, gana la última petición.
  const requestRef = useRef(0);

  async function load(template: string) {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError(null);
    const r = await cliSkills(template);
    if (requestRef.current !== requestId) return;
    setLoading(false);
    if (r.ok) {
      setSkills(r.skills);
      setSelected(defaultSelection(r.skills));
    } else {
      setSkills(null);
      setSelected([]);
      setError(r.error);
    }
  }

  useEffect(() => {
    if (!open || !templateId) {
      requestRef.current += 1;
      setSkills(null);
      setError(null);
      setLoading(false);
      setSelected([]);
      return;
    }
    void load(templateId);
  }, [open, templateId]);

  function toggle(name: string) {
    const skill = skills?.find((s) => s.name === name);
    if (!skill?.reviewed) return;
    setSelected((cur) => (cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]));
  }

  function reload() {
    if (templateId) void load(templateId);
  }

  return { skills, error, loading, selected, toggle, reload };
}
