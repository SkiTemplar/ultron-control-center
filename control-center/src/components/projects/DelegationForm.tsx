// DelegationForm — textarea inline para delegar una tarea a un agente (A2).
//
// El borrador vive en estado LOCAL de este componente: al cambiar el
// formulario abierto de un agente a otro, el anterior se desmonta y el nuevo
// arranca vacío — imposible delegar el texto de A bajo el nombre de B.

import { useState } from "react";

export interface DelegationFormProps {
  agentName: string;
  launching: boolean;
  onLaunch: (task: string) => void;
}

export function DelegationForm({ agentName, launching, onLaunch }: DelegationFormProps) {
  const [task, setTask] = useState("");

  return (
    <div className="mt-2">
      <textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        rows={3}
        placeholder={`Tarea para ${agentName}…`}
        className="w-full rounded px-2 py-1.5 text-[11.5px]"
        style={{
          background: "var(--color-surface-1)",
          color: "var(--color-text)",
          border: "1px solid var(--color-border-strong)",
          outline: "none",
          resize: "vertical",
        }}
      />
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          onClick={() => onLaunch(task.trim())}
          disabled={!task.trim() || launching}
          className="rounded px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {launching ? "Lanzando…" : "Delegar"}
        </button>
      </div>
    </div>
  );
}
