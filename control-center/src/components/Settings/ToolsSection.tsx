import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Settings > Herramientas — informe SOLO LECTURA de las CLIs standalone que
// ULTRON integra (markitdown, rumdl, mmdc, glow, agy, codex): instaladas o
// no, version real, para que sirven, y el comando de instalacion si faltan.
// Nunca instala nada por si sola.

interface ToolInfo {
  id: string;
  label: string;
  description: string;
  installed: boolean;
  version: string;
  version_error: string;
  install_hint: string;
}

interface ToolsReport {
  tools: ToolInfo[];
}

function StatusBadge({ tool }: { tool: ToolInfo }) {
  const color = tool.installed ? "var(--color-success)" : "var(--color-danger)";
  const label = tool.installed ? "Instalada" : "No instalada";
  return (
    <span
      className="rounded px-1.5 py-px text-[10px] font-medium"
      style={{
        background: "var(--color-surface-1)",
        border: `1px solid ${color}`,
        color,
      }}
    >
      {label}
    </span>
  );
}

export function ToolsSection() {
  const [report, setReport] = useState<ToolsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const r = await invoke<ToolsReport>("tools_status");
      setReport(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  return (
    <div className="max-w-[720px]">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">Herramientas</h2>
          <p
            className="mt-1 text-[12.5px] leading-relaxed"
            style={{ color: "var(--color-text-secondary)" }}
          >
            CLIs standalone que ULTRON integra (conversion y lint de Markdown,
            diagramas Mermaid…). Solo lectura: no instala ni actualiza nada.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing || loading}
          className="shrink-0 rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {refreshing ? "Comprobando…" : "Volver a comprobar"}
        </button>
      </div>

      {error && (
        <div
          className="mb-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {loading && !report ? (
        <div
          className="rounded p-5 text-center text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          Comprobando herramientas…
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {report?.tools.map((t) => (
            <li
              key={t.id}
              className="rounded p-4"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold">{t.label}</span>
                <StatusBadge tool={t} />
                {t.installed && t.version && (
                  <span
                    className="rounded px-1.5 py-px text-[10.5px]"
                    style={{
                      background: "var(--color-surface-1)",
                      border: "1px solid var(--color-border)",
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {t.version}
                  </span>
                )}
              </div>

              <p className="mt-2 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
                {t.description}
              </p>

              {t.installed && t.version_error && (
                <p className="mt-1 text-[11px]" style={{ color: "var(--color-warning, #d29922)" }}>
                  ⚠ instalada, pero {t.version_error}
                </p>
              )}

              {!t.installed && (
                <p className="mt-2 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
                  Instalar:{" "}
                  <span
                    className="rounded px-1 py-px"
                    style={{
                      background: "var(--color-surface-1)",
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text)",
                    }}
                  >
                    {t.install_hint}
                  </span>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
