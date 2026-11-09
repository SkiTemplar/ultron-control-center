import { type SystemSubTab, CONTEXT_HINTS } from "./types";

export function SystemHeader({
  subTab,
  setSubTab,
}: {
  subTab: SystemSubTab;
  setSubTab: (t: SystemSubTab) => void;
}) {
  const TABS: { id: SystemSubTab; label: string }[] = [
    { id: "diagnostics", label: "Diagnóstico y arreglos" },
    { id: "apps", label: "Aplicaciones" },
    { id: "tasks", label: "Tareas" },
    { id: "turn_off", label: "Apagar" },
  ];
  return (
    <header className="mb-5 flex flex-wrap items-baseline justify-between gap-4 px-10 pt-8">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-tight">Sistema</h1>
        <p
          className="mt-1 text-[13.5px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Diagnóstico del PC bajo demanda con arreglos en un clic · aplicaciones instaladas por uso · tareas programadas de ULTRON · apagado programado.
        </p>
        <div
          className="mt-3 inline-flex rounded p-0.5"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              className="rounded px-3.5 py-1.5 text-[13px] font-medium transition-colors"
              style={{
                background: subTab === t.id ? "var(--color-surface-3)" : "transparent",
                color: subTab === t.id ? "var(--color-text)" : "var(--color-text-tertiary)",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p
          className="mt-2 text-[12px] leading-snug"
          style={{ color: "var(--color-text-faint, var(--color-text-tertiary))" }}
        >
          {CONTEXT_HINTS[subTab]}
        </p>
      </div>
    </header>
  );
}
